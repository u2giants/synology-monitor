package sender

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// --- helpers ---------------------------------------------------------------

func newTestSender(t *testing.T, url string, opts ...Option) *Sender {
	t.Helper()
	// 100 batch size, 30s flush interval, 100MB WAL cap — production defaults.
	s, err := New(url, "test-key", t.TempDir(), 100, 30*time.Second, 100*1024*1024, opts...)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { s.Close() })
	// Tests use sub-second budgets; the 5s production floor would make every
	// request look unaffordable.
	s.minReqWindow = time.Millisecond
	return s
}

func seed(t *testing.T, s *Sender, table string, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		s.queue(table, map[string]interface{}{"nas_id": "test", "i": i})
	}
}

// seedWithAttempts inserts rows with a preset attempts value.
func seedWithAttempts(t *testing.T, s *Sender, table string, n, attempts int) {
	t.Helper()
	for i := 0; i < n; i++ {
		if _, err := s.db.Exec(
			"INSERT INTO wal_entries (table_name, payload, attempts) VALUES (?, ?, ?)",
			table, `{"i":1}`, attempts,
		); err != nil {
			t.Fatalf("seedWithAttempts: %v", err)
		}
	}
}

func countRows(t *testing.T, s *Sender, where string, args ...interface{}) int64 {
	t.Helper()
	var n int64
	q := "SELECT COUNT(*) FROM wal_entries"
	if where != "" {
		q += " WHERE " + where
	}
	if err := s.db.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatalf("countRows: %v", err)
	}
	return n
}

// rowsIn returns the number of JSON objects in a request body.
func rowsIn(t *testing.T, r *http.Request) int {
	t.Helper()
	body, _ := io.ReadAll(r.Body)
	var arr []map[string]interface{}
	if err := json.Unmarshal(body, &arr); err != nil {
		t.Fatalf("bad request body %q: %v", body, err)
	}
	return len(arr)
}

// tableOf extracts the target table from a PostgREST request path.
func tableOf(r *http.Request) string {
	p := strings.TrimPrefix(r.URL.Path, "/rest/v1/")
	return p
}

// recorder is an accepting PostgREST stand-in that records traffic.
type recorder struct {
	mu       sync.Mutex
	rows     int
	requests int
	order    []string
	delay    time.Duration
}

func (rec *recorder) handler(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		n := rowsIn(t, r)
		rec.mu.Lock()
		rec.rows += n
		rec.requests++
		rec.order = append(rec.order, tableOf(r))
		d := rec.delay
		rec.mu.Unlock()
		if d > 0 {
			time.Sleep(d)
		}
		w.WriteHeader(http.StatusCreated)
	}
}

func (rec *recorder) snapshot() (rows, requests int, order []string) {
	rec.mu.Lock()
	defer rec.mu.Unlock()
	return rec.rows, rec.requests, append([]string(nil), rec.order...)
}

// --- item 3: bounded, fair drain scheduling --------------------------------

// A backlog larger than one batch must drain across multiple rounds in a single
// cycle. This is the arithmetic bug: one batch per table per 30s tick (200
// rows/min) could not keep up with ~240 rows/min of process_snapshots.
func TestFlushDrainsBacklogAcrossRounds(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL)
	seed(t, s, "process_snapshots", 350)

	s.flush()

	rows, requests, _ := rec.snapshot()
	if rows != 350 {
		t.Errorf("delivered %d rows, want 350", rows)
	}
	if requests != 4 {
		t.Errorf("made %d requests, want 4 (100+100+100+50)", requests)
	}
	if n := countRows(t, s, ""); n != 0 {
		t.Errorf("%d entries left in WAL, want 0", n)
	}
}

// The per-table ceiling must stop a single table monopolising a cycle.
func TestFlushStopsAtMaxBatchesPerFlush(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL, WithMaxBatchesPerFlush(3))
	seed(t, s, "process_snapshots", 500)

	s.flush()

	rows, requests, _ := rec.snapshot()
	if rows != 300 || requests != 3 {
		t.Errorf("delivered %d rows in %d requests, want 300 in 3", rows, requests)
	}
	if n := countRows(t, s, ""); n != 200 {
		t.Errorf("%d entries left in WAL, want 200", n)
	}
}

// The whole-cycle deadline is the primary bound and must end the cycle even
// with per-table allowance to spare.
func TestFlushStopsAtDeadline(t *testing.T) {
	rec := &recorder{delay: 40 * time.Millisecond}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL, WithMaxFlushDuration(120*time.Millisecond))
	seed(t, s, "process_snapshots", 1000) // 10 batches = full allowance

	start := time.Now()
	s.flush()
	elapsed := time.Since(start)

	rows, requests, _ := rec.snapshot()
	if rows == 0 {
		t.Fatal("deadline cut the cycle before any progress")
	}
	if rows == 1000 {
		t.Fatal("cycle ignored its deadline and drained everything")
	}
	if requests >= 10 {
		t.Errorf("made %d requests, expected the deadline to stop well short of the 10-batch allowance", requests)
	}
	// Budget + one in-flight request; generous margin for CI scheduling.
	if elapsed > time.Second {
		t.Errorf("cycle took %s, far beyond its 120ms budget", elapsed)
	}
	if n := countRows(t, s, ""); n == 0 {
		t.Error("WAL fully drained despite the deadline firing")
	}
}

// Round-robin: one batch per table per round, so no table is starved.
func TestFlushRoundRobinFairness(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL, WithMaxBatchesPerFlush(2))
	for _, table := range []string{"alpha", "bravo", "charlie"} {
		seed(t, s, table, 500)
	}

	s.flush()

	_, _, order := rec.snapshot()
	if len(order) != 6 {
		t.Fatalf("made %d requests, want 6 (3 tables x 2 batches)", len(order))
	}
	// Each round must serve every table exactly once before any table repeats.
	for _, round := range [][]string{order[:3], order[3:]} {
		seen := map[string]bool{}
		for _, tbl := range round {
			if seen[tbl] {
				t.Errorf("table %q served twice within one round: %v", tbl, order)
			}
			seen[tbl] = true
		}
		if len(seen) != 3 {
			t.Errorf("round served %d distinct tables, want 3: %v", len(seen), order)
		}
	}
}

// Under a deadline, a stable alphabetical order is systematic priority, not
// fairness — the starting table must rotate each cycle.
func TestFlushRotatesStartingTable(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL, WithMaxBatchesPerFlush(1))
	for _, table := range []string{"alpha", "bravo", "charlie"} {
		seed(t, s, table, 500) // enough to stay backlogged across 3 cycles
	}

	var firsts []string
	for i := 0; i < 3; i++ {
		rec.mu.Lock()
		rec.order = nil
		rec.mu.Unlock()

		s.flush()

		_, _, order := rec.snapshot()
		if len(order) == 0 {
			t.Fatalf("cycle %d sent nothing", i)
		}
		firsts = append(firsts, order[0])
	}

	want := []string{"alpha", "bravo", "charlie"}
	for i := range want {
		if firsts[i] != want[i] {
			t.Fatalf("starting tables %v, want %v (rotation not applied)", firsts, want)
		}
	}
}

// --- item 2: enforceWALLimit ordering (the data-loss regression) -----------

// THE regression test. Exhausted rows must be deleted BEFORE the cap is
// counted. Otherwise they inflate COUNT(*), healthy telemetry is evicted to
// make room the WAL never actually needed, and the exhausted rows are deleted
// immediately afterwards anyway.
func TestEnforceWALLimitDeletesExhaustedBeforeCapCount(t *testing.T) {
	s := newTestSender(t, "http://127.0.0.1:1")
	// Cap = 15 entries (15 * 500 bytes).
	s.maxWALSize = 15 * walEntryBytes

	// 10 healthy rows first, so they are the OLDEST — exactly the rows the old
	// evict-first ordering destroyed.
	seed(t, s, "metrics", 10)
	seedWithAttempts(t, s, "nas_logs", 10, maxAttempts)

	s.mu.Lock()
	exhausted, evicted := s.enforceWALLimit()
	s.mu.Unlock()

	if exhausted != 10 {
		t.Errorf("deleted %d exhausted entries, want 10", exhausted)
	}
	if evicted != 0 {
		t.Errorf("evicted %d healthy entries; want 0 — removing the exhausted rows brought the WAL under cap", evicted)
	}
	if n := countRows(t, s, "table_name = 'metrics'"); n != 10 {
		t.Errorf("%d healthy metrics rows survived, want 10 (healthy data was destroyed unnecessarily)", n)
	}
	if n := countRows(t, s, "table_name = 'nas_logs'"); n != 0 {
		t.Errorf("%d exhausted rows survived, want 0", n)
	}
}

// Eviction still has to happen when the WAL is genuinely over cap after the
// exhausted rows are gone — and it must take the OLDEST rows.
func TestEnforceWALLimitEvictsOldestWhenStillOverCap(t *testing.T) {
	s := newTestSender(t, "http://127.0.0.1:1")
	s.maxWALSize = 15 * walEntryBytes

	seed(t, s, "metrics", 20)

	s.mu.Lock()
	exhausted, evicted := s.enforceWALLimit()
	s.mu.Unlock()

	if exhausted != 0 {
		t.Errorf("deleted %d exhausted entries, want 0", exhausted)
	}
	if evicted != 5 {
		t.Errorf("evicted %d entries, want 5 (20 - cap 15)", evicted)
	}
	if n := countRows(t, s, ""); n != 15 {
		t.Errorf("%d entries remain, want 15", n)
	}
	// The 5 oldest (lowest ids) must be the ones gone.
	var minID int64
	if err := s.db.QueryRow("SELECT MIN(id) FROM wal_entries").Scan(&minID); err != nil {
		t.Fatalf("MIN(id): %v", err)
	}
	if minID != 6 {
		t.Errorf("oldest surviving id is %d, want 6 — eviction did not take the oldest first", minID)
	}
}

// Both mechanisms together: exhausted rows go first, and eviction then trims
// only the real overage.
func TestEnforceWALLimitEvictsOnlyRealOverage(t *testing.T) {
	s := newTestSender(t, "http://127.0.0.1:1")
	s.maxWALSize = 5 * walEntryBytes

	seed(t, s, "metrics", 10)
	seedWithAttempts(t, s, "nas_logs", 10, maxAttempts)

	s.mu.Lock()
	exhausted, evicted := s.enforceWALLimit()
	s.mu.Unlock()

	if exhausted != 10 {
		t.Errorf("deleted %d exhausted entries, want 10", exhausted)
	}
	// 10 healthy remain vs a cap of 5 => evict 5, NOT 15.
	if evicted != 5 {
		t.Errorf("evicted %d entries, want 5", evicted)
	}
	if n := countRows(t, s, ""); n != 5 {
		t.Errorf("%d entries remain, want 5", n)
	}
}

// --- item 1: the lock is never held across the network ---------------------

// The critical invariant. queue() and flush() share s.mu; if flush holds it
// across the POST, every collector blocks on network I/O for up to the 30s
// client timeout. A drain loop without this fix would make that near-continuous.
func TestQueueNotBlockedByInFlightPost(t *testing.T) {
	inFlight := make(chan struct{})
	release := make(chan struct{})
	var once, releaseOnce sync.Once
	unpark := func() { releaseOnce.Do(func() { close(release) }) }
	// Unpark the handler on EVERY exit path. Without this, a failure would
	// leave the handler blocked, srv.Close() would wait on it forever, and a
	// real regression would hang for the 10m test timeout instead of failing.
	defer unpark()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		once.Do(func() { close(inFlight) })
		select {
		case <-release:
		case <-time.After(10 * time.Second):
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	s := newTestSender(t, srv.URL)
	seed(t, s, "process_snapshots", 100)

	done := make(chan struct{})
	go func() {
		defer close(done)
		s.flush()
	}()

	select {
	case <-inFlight:
	case <-time.After(5 * time.Second):
		t.Fatal("POST never started")
	}
	//nolint:staticcheck // queue() runs on its own goroutine below.

	// The POST is now parked in the handler. A collector write must not wait.
	queued := make(chan time.Duration, 1)
	go func() {
		start := time.Now()
		s.queue("metrics", map[string]interface{}{"nas_id": "test"})
		queued <- time.Since(start)
	}()

	select {
	case d := <-queued:
		if d > time.Second {
			t.Errorf("queue() took %s while a POST was in flight — the mutex is held across the network", d)
		}
	case <-time.After(2 * time.Second):
		t.Error("queue() blocked on an in-flight POST — s.mu is held across the HTTP call")
	}

	unpark()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("flush did not finish after the POST was released")
	}
}

// --- item 4: flushTable result transitions ---------------------------------

func TestFlushTableResultTransitions(t *testing.T) {
	tests := []struct {
		name      string
		seedRows  int
		status    int
		deadPast  bool
		noServer  bool
		wantSent  int
		wantDrain bool
		wantRetry bool
		wantErr   bool
		wantCycle bool
	}{
		{name: "empty table drains", seedRows: 0, status: 201, wantDrain: true},
		{name: "partial batch drains", seedRows: 50, status: 201, wantSent: 50, wantDrain: true},
		{name: "full batch continues", seedRows: 100, status: 201, wantSent: 100},
		{name: "5xx stops table retryably", seedRows: 100, status: 503, wantRetry: true, wantErr: true},
		{name: "single-row 4xx is not retryable", seedRows: 1, status: 400, wantErr: true},
		{name: "transport failure is retryable", seedRows: 100, noServer: true, wantRetry: true, wantErr: true},
		{name: "expired deadline ends cycle", seedRows: 100, status: 201, deadPast: true, wantErr: true, wantCycle: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			url := "http://127.0.0.1:1" // closed port => transport failure
			if !tc.noServer {
				srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.WriteHeader(tc.status)
					io.WriteString(w, "boom")
				}))
				defer srv.Close()
				url = srv.URL
			}

			s := newTestSender(t, url)
			seed(t, s, "metrics", tc.seedRows)

			deadline := time.Now().Add(10 * time.Second)
			if tc.deadPast {
				deadline = time.Now().Add(-time.Second)
			}

			res := s.flushTable("metrics", deadline)

			if res.rowsSent != tc.wantSent {
				t.Errorf("rowsSent = %d, want %d", res.rowsSent, tc.wantSent)
			}
			if res.drained != tc.wantDrain {
				t.Errorf("drained = %v, want %v", res.drained, tc.wantDrain)
			}
			if res.retryable != tc.wantRetry {
				t.Errorf("retryable = %v, want %v", res.retryable, tc.wantRetry)
			}
			if (res.err != nil) != tc.wantErr {
				t.Errorf("err = %v, want error: %v", res.err, tc.wantErr)
			}
			if got := errors.Is(res.err, errCycleBudget); got != tc.wantCycle {
				t.Errorf("errCycleBudget = %v, want %v (err=%v)", got, tc.wantCycle, res.err)
			}
		})
	}
}

// A cycle-budget result must abandon the batch untouched, not burn an attempt
// on rows that were never submitted.
func TestFlushTableDeadlineLeavesRowsUntouched(t *testing.T) {
	s := newTestSender(t, "http://127.0.0.1:1")
	seed(t, s, "metrics", 10)

	res := s.flushTable("metrics", time.Now().Add(-time.Second))
	if !errors.Is(res.err, errCycleBudget) {
		t.Fatalf("err = %v, want errCycleBudget", res.err)
	}
	if n := countRows(t, s, "attempts = 0"); n != 10 {
		t.Errorf("%d rows still at attempts=0, want 10 — an unsent batch was penalised", n)
	}
}

// --- item 6: bounded 4xx row isolation -------------------------------------

// One rejected 100-row batch could fire 100 serial single-row POSTs. Isolation
// is bounded, and rows never submitted must keep attempts=0.
func TestIsolateBatchIsBoundedAndLeavesUnattemptedRows(t *testing.T) {
	var mu sync.Mutex
	singles := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := rowsIn(t, r)
		if n > 1 {
			// PostgREST rejects the whole batch for one bad row.
			w.WriteHeader(http.StatusBadRequest)
			io.WriteString(w, `{"message":"bad row"}`)
			return
		}
		mu.Lock()
		singles++
		mu.Unlock()
		w.WriteHeader(http.StatusCreated)
	}))
	defer srv.Close()

	s := newTestSender(t, srv.URL)
	seed(t, s, "metrics", 30)

	res := s.flushTable("metrics", time.Now().Add(10*time.Second))

	mu.Lock()
	got := singles
	mu.Unlock()

	if got != maxIsolationRows {
		t.Errorf("fired %d single-row POSTs, want the bound of %d", got, maxIsolationRows)
	}
	if res.rowsSent != maxIsolationRows {
		t.Errorf("rowsSent = %d, want %d", res.rowsSent, maxIsolationRows)
	}
	if res.err == nil {
		t.Error("isolation should stop the table for the cycle")
	}
	if n := countRows(t, s, ""); n != 10 {
		t.Errorf("%d rows remain, want 10 (30 - %d isolated)", n, maxIsolationRows)
	}
	// The 10 rows we never submitted have not failed — they must be untouched.
	if n := countRows(t, s, "attempts = 0"); n != 10 {
		t.Errorf("%d remaining rows at attempts=0, want 10 — unsubmitted rows were penalised", n)
	}
}

// --- item 7: observability --------------------------------------------------

func TestWALStatsReportsPendingExhaustedAndAge(t *testing.T) {
	s := newTestSender(t, "http://127.0.0.1:1")
	seed(t, s, "metrics", 3)
	seedWithAttempts(t, s, "metrics", 2, maxAttempts)
	seed(t, s, "nas_logs", 1)

	stats, err := s.walStats()
	if err != nil {
		t.Fatalf("walStats: %v", err)
	}
	if len(stats) != 2 {
		t.Fatalf("got %d tables, want 2", len(stats))
	}

	byTable := map[string]tableWALStats{}
	for _, st := range stats {
		byTable[st.table] = st
	}
	if m := byTable["metrics"]; m.pending != 3 || m.exhausted != 2 {
		t.Errorf("metrics: pending=%d exhausted=%d, want 3/2", m.pending, m.exhausted)
	}
	if l := byTable["nas_logs"]; l.pending != 1 || l.exhausted != 0 {
		t.Errorf("nas_logs: pending=%d exhausted=%d, want 1/0", l.pending, l.exhausted)
	}

	// Age is derived from created_at; a just-written row must not report a
	// wildly wrong age (row count alone hid an 80-minute staleness in prod).
	if age := byTable["metrics"].oldestPending; age > time.Minute {
		t.Errorf("oldest pending age = %s for a row just written", age)
	}
}

// Exhausted rows must not be counted as pending work to send.
func TestFlushIgnoresExhaustedRows(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL)
	seedWithAttempts(t, s, "metrics", 5, maxAttempts)

	s.flush()

	if rows, _, _ := rec.snapshot(); rows != 0 {
		t.Errorf("sent %d exhausted rows, want 0", rows)
	}
	// enforceWALLimit should have cleaned them up.
	if n := countRows(t, s, ""); n != 0 {
		t.Errorf("%d exhausted rows remain, want 0", n)
	}
}

// --- construction defaults --------------------------------------------------

// A zero or nonsensical budget must never mean "unbounded".
func TestNewNormalisesFlushBudget(t *testing.T) {
	tests := []struct {
		name string
		opts []Option
		want time.Duration
	}{
		{name: "unset defaults to 80% of interval", want: 24 * time.Second},
		{name: "zero is not unbounded", opts: []Option{WithMaxFlushDuration(0)}, want: 24 * time.Second},
		{name: "negative is not unbounded", opts: []Option{WithMaxFlushDuration(-5 * time.Second)}, want: 24 * time.Second},
		{name: "at or above the interval is clamped", opts: []Option{WithMaxFlushDuration(30 * time.Second)}, want: 24 * time.Second},
		{name: "valid value is kept", opts: []Option{WithMaxFlushDuration(10 * time.Second)}, want: 10 * time.Second},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newTestSender(t, "http://127.0.0.1:1", tc.opts...)
			if s.maxFlushDuration != tc.want {
				t.Errorf("maxFlushDuration = %s, want %s", s.maxFlushDuration, tc.want)
			}
		})
	}

	s := newTestSender(t, "http://127.0.0.1:1", WithMaxBatchesPerFlush(0))
	if s.maxBatches != defaultMaxBatchesPerFlush {
		t.Errorf("maxBatches = %d, want %d", s.maxBatches, defaultMaxBatchesPerFlush)
	}
	if s.batchSize != 100 {
		t.Errorf("batchSize = %d, want 100 (must stay at 100 for rollout)", s.batchSize)
	}
}

// --- item 1 / item 9: shutdown invariant ------------------------------------

// Records the invariant that makes the lock-free network path safe and Close()
// safe as-is: Run() is the only flusher, it flushes serially, and main.go's
// deferred s.Close() runs only after wg.Wait() observes Run returning.
func TestRunFlushesOnStopAndReturns(t *testing.T) {
	rec := &recorder{}
	srv := httptest.NewServer(rec.handler(t))
	defer srv.Close()

	s := newTestSender(t, srv.URL)
	seed(t, s, "metrics", 250)

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		s.Run(stop)
	}()

	close(stop)

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("Run did not return after stop — shutdown flush is unbounded")
	}

	if rows, _, _ := rec.snapshot(); rows != 250 {
		t.Errorf("final flush delivered %d rows, want 250", rows)
	}
	// Run has returned, so the deferred Close() in main.go cannot race a flush.
	if err := s.Close(); err != nil {
		t.Errorf("Close after Run: %v", err)
	}
}
