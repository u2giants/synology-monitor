package sender

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const (
	// maxAttempts is the number of delivery attempts after which an entry is
	// considered exhausted and dropped by enforceWALLimit.
	maxAttempts = 5

	// walEntryBytes is the rough per-entry size estimate used to translate the
	// MAX_WAL_SIZE_MB byte budget into an entry-count cap. It is deliberately
	// approximate — real SQLite file accounting is out of scope.
	walEntryBytes = 500

	// defaultMaxBatchesPerFlush caps how many batches a single table may send
	// per flush cycle, so one backlogged table cannot monopolise the cycle.
	defaultMaxBatchesPerFlush = 10

	// minRequestWindow is the smallest residual cycle budget worth starting a
	// request with. Below this we end the cycle rather than fire a POST that
	// will almost certainly be cancelled mid-flight (a cancelled POST is
	// ambiguous — the server may have committed it — so they are not free).
	minRequestWindow = 5 * time.Second

	// maxIsolationRows bounds the row-by-row retry after a 4xx batch rejection.
	// Without it, one rejected 100-row batch fires up to 100 serial POSTs.
	maxIsolationRows = 20

	// shutdownBudgetFactor multiplies the normal cycle budget for the final
	// flush on shutdown: larger, but still finite — the agent must never hang
	// forever against an unhealthy Supabase.
	shutdownBudgetFactor = 3

	// walReportInterval is the maximum quiet period between WAL state reports.
	// Reports are otherwise emitted only on threshold transitions.
	walReportInterval = 5 * time.Minute

	// walStaleThreshold is the oldest-pending-entry age at which a table's
	// backlog is considered stale enough to report.
	walStaleThreshold = 10 * time.Minute
)

// errCycleBudget signals that the whole flush cycle's deadline is exhausted.
// It ends the cycle, not just the current table.
var errCycleBudget = errors.New("flush cycle budget exhausted")

// Option customises a Sender at construction time.
type Option func(*Sender)

// WithMaxFlushDuration sets the absolute wall-clock budget for one flush cycle.
func WithMaxFlushDuration(d time.Duration) Option {
	return func(s *Sender) { s.maxFlushDuration = d }
}

// WithMaxBatchesPerFlush sets the per-table batch ceiling for one flush cycle.
func WithMaxBatchesPerFlush(n int) Option {
	return func(s *Sender) { s.maxBatches = n }
}

// Sender buffers data in a local SQLite WAL and sends to Supabase.
//
// Locking invariant: s.mu guards ONLY short SQLite work. It is never held
// across an HTTP request — collectors call queue() under the same mutex, so
// holding it across the network would block all collection for the duration of
// a POST (up to the 30s client timeout). Every flush batch runs as:
// lock → SELECT → unlock → POST → lock → delete/increment → unlock.
//
// This is safe without any further coordination because only Run() flushes and
// it does so serially: no second flush worker can select the same ids, and a
// concurrent queue() insert always gets a higher rowid so it cannot invalidate
// an already-selected batch. enforceWALLimit runs in that same goroutine.
type Sender struct {
	supabaseURL string
	serviceKey  string
	httpClient  *http.Client
	db          *sql.DB
	mu          sync.Mutex
	batchSize   int
	flushEvery  time.Duration
	maxWALSize  int64

	// Drain scheduling.
	maxFlushDuration time.Duration
	maxBatches       int
	minReqWindow     time.Duration // overridable in tests
	flushOffset      int           // rotates the round-robin starting table

	// Observability state (touched only from the Run goroutine).
	lastReportAt time.Time
	lastLevel    int
	lastStale    bool
	reported     bool
}

func New(supabaseURL, serviceKey, dataDir string, batchSize int, flushEvery time.Duration, maxWALSize int64, opts ...Option) (*Sender, error) {
	dbPath := fmt.Sprintf("%s/wal.db", dataDir)
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("opening WAL database: %w", err)
	}

	// Create WAL table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS wal_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			table_name TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			attempts INTEGER DEFAULT 0,
			last_error TEXT
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("creating WAL table: %w", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS checkpoints (
			name TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("creating checkpoints table: %w", err)
	}

	s := &Sender{
		supabaseURL: supabaseURL,
		serviceKey:  serviceKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		db:           db,
		batchSize:    batchSize,
		flushEvery:   flushEvery,
		maxWALSize:   maxWALSize,
		maxBatches:   defaultMaxBatchesPerFlush,
		minReqWindow: minRequestWindow,
	}
	for _, opt := range opts {
		opt(s)
	}

	// Defensive normalisation. config.Load validates the operator-supplied
	// values and fails fast on bad ones; this covers callers that omit the
	// options entirely. A zero/negative budget must never mean "unbounded".
	if s.maxFlushDuration <= 0 || s.maxFlushDuration >= flushEvery {
		s.maxFlushDuration = flushEvery * 4 / 5
	}
	if s.maxBatches <= 0 {
		s.maxBatches = defaultMaxBatchesPerFlush
	}

	return s, nil
}

func (s *Sender) Close() error {
	return s.db.Close()
}

// Queue methods write to local SQLite WAL

func (s *Sender) QueueMetric(m MetricPayload) {
	s.queue("metrics", m)
}

func (s *Sender) QueueStorageSnapshot(p StoragePayload) {
	s.queue("storage_snapshots", p)
}

func (s *Sender) QueueContainerStatus(p ContainerPayload) {
	s.queue("container_status", p)
}

func (s *Sender) QueueLog(p LogPayload) {
	s.queue("nas_logs", p)
}

func (s *Sender) QueueSecurityEvent(p SecurityEventPayload) {
	s.queue("security_events", p)
}

func (s *Sender) QueueAlert(p AlertPayload) {
	p.Severity = normalizeSeverity(p.Severity)
	s.queue("alerts", p)
}

// normalizeSeverity coerces an alert severity to the values permitted by the
// alerts CHECK constraint (info|warning|critical). Collectors emit "error" for
// serious faults (btrfs/storage/hyperbackup), which maps to critical; anything
// unrecognized falls back to warning so the alert is never rejected outright.
func normalizeSeverity(sev string) string {
	switch s := strings.ToLower(strings.TrimSpace(sev)); s {
	case "info", "warning", "critical":
		return s
	case "error", "err", "fatal", "crit":
		return "critical"
	case "warn":
		return "warning"
	case "debug", "notice", "trace":
		return "info"
	default:
		return "warning"
	}
}

func (s *Sender) QueueDriveTeamFolder(p DriveTeamFolderPayload) {
	s.queue("drive_team_folders", p)
}

func (s *Sender) QueueDriveActivity(p DriveActivityPayload) {
	s.queue("drive_activities", p)
}

func (s *Sender) QueueProcessSnapshot(p ProcessSnapshotPayload) {
	s.queue("process_snapshots", p)
}

func (s *Sender) QueueDiskIOStat(p DiskIOStatPayload) {
	s.queue("disk_io_stats", p)
}

func (s *Sender) QueueSyncTaskSnapshot(p SyncTaskSnapshotPayload) {
	s.queue("sync_task_snapshots", p)
}

func (s *Sender) QueueNetConnection(p NetConnectionPayload) {
	s.queue("net_connections", p)
}

func (s *Sender) QueueServiceHealth(p ServiceHealthPayload) {
	s.queue("service_health", p)
}

func (s *Sender) QueueCustomMetricData(p CustomMetricDataPayload) {
	s.queue("custom_metric_data", p)
}

func (s *Sender) QueueScheduledTask(p ScheduledTaskPayload) {
	s.queue("scheduled_tasks", p)
}

func (s *Sender) QueueBackupTask(p BackupTaskPayload) {
	s.queue("backup_tasks", p)
}

func (s *Sender) QueueSnapshotReplica(p SnapshotReplicaPayload) {
	s.queue("snapshot_replicas", p)
}

func (s *Sender) QueueContainerIO(p ContainerIOPayload) {
	s.queue("container_io", p)
}

func (s *Sender) QueuePackageStatus(p PackageStatusPayload) {
	s.queue("package_status", p)
}

func (s *Sender) QueueDSMError(p DSMErrorPayload) {
	s.queue("dsm_errors", p)
}

// upsertTables lists tables that should use Supabase's merge-duplicates
// resolution (INSERT … ON CONFLICT DO UPDATE).  The table must have a UNIQUE
// constraint on its natural key for this to take effect.
var upsertTables = map[string]bool{
	"package_status": true,
}

// upsertConflictTargets maps a table to the unique-constraint columns that
// merge-duplicates must target. PostgREST infers the primary key by default,
// which never matches our natural-key conflict (the agent omits the serial id),
// so without this the "upsert" raises a 409 on every existing row.
var upsertConflictTargets = map[string]string{
	"package_status": "nas_id,package_id",
}

// SaveCheckpoint persists a named cursor value (e.g. a log file byte offset)
// so it survives agent restarts.
func (s *Sender) SaveCheckpoint(name, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO checkpoints (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`,
		name, value,
	)
	return err
}

// LoadCheckpoint reads a previously saved checkpoint. Returns ("", nil) if not found.
func (s *Sender) LoadCheckpoint(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var value string
	err := s.db.QueryRow("SELECT value FROM checkpoints WHERE name = ?", name).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

func (s *Sender) queue(table string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[sender] error marshaling payload for %s: %v", table, err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	_, err = s.db.Exec(
		"INSERT INTO wal_entries (table_name, payload) VALUES (?, ?)",
		table, string(data),
	)
	if err != nil {
		log.Printf("[sender] error writing to WAL: %v", err)
	}
}

// Run starts the sender loop that flushes WAL entries to Supabase
func (s *Sender) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(s.flushEvery)
	defer ticker.Stop()

	log.Printf("[sender] started (flush every %s, batch size %d, cycle budget %s, max %d batches/table/cycle)",
		s.flushEvery, s.batchSize, s.maxFlushDuration, s.maxBatches)

	for {
		select {
		case <-ticker.C:
			s.flush()
		case <-stop:
			// Shutdown gets a larger — but still finite — budget. Anything
			// still pending stays in the local WAL and is retried next start.
			budget := s.maxFlushDuration * shutdownBudgetFactor
			log.Printf("[sender] attempting final bounded flush (budget %s)...", budget)
			s.flushWithBudget(budget)
			if pending, err := s.pendingCount(); err != nil {
				log.Printf("[sender] could not count pending entries at shutdown: %v", err)
			} else if pending > 0 {
				log.Printf("[sender] stopped: %d entries still pending in local WAL (will retry on next start)", pending)
			} else {
				log.Println("[sender] stopped: local WAL drained")
			}
			return
		}
	}
}

func (s *Sender) flush() {
	s.flushWithBudget(s.maxFlushDuration)
}

// flushWithBudget drains pending WAL entries within an absolute wall-clock
// budget. Tables are served round-robin — one batch per table per round — so a
// single backlogged table cannot starve the others, and the starting table
// rotates every cycle (a stable alphabetical order under a deadline is
// systematic priority, not fairness).
func (s *Sender) flushWithBudget(budget time.Duration) {
	start := time.Now()
	deadline := start.Add(budget)

	s.mu.Lock()
	exhausted, evicted := s.enforceWALLimit()
	s.mu.Unlock()

	stats, err := s.walStats()
	if err != nil {
		log.Printf("[sender] error querying WAL state: %v", err)
		return
	}

	var tables []string
	for _, st := range stats {
		if st.pending > 0 {
			tables = append(tables, st.table)
		}
	}

	rowsSent := 0
	deadlineHit := false

	if len(tables) > 0 {
		// Rotate the starting table so the same table is not always first.
		offset := s.flushOffset % len(tables)
		s.flushOffset++
		ordered := make([]string, 0, len(tables))
		ordered = append(ordered, tables[offset:]...)
		ordered = append(ordered, tables[:offset]...)

		allowance := make(map[string]int, len(ordered))
		for _, t := range ordered {
			allowance[t] = s.maxBatches
		}

		active := ordered
	rounds:
		for len(active) > 0 {
			var next []string
			for _, table := range active {
				res := s.flushTable(table, deadline)
				rowsSent += res.rowsSent
				allowance[table]--

				if errors.Is(res.err, errCycleBudget) {
					deadlineHit = true
					break rounds
				}
				// Any other error stops this table for the cycle: a transport
				// or 5xx failure will almost certainly repeat immediately, and
				// hammering it wastes budget the other tables can use.
				if res.err != nil || res.drained || allowance[table] <= 0 {
					continue
				}
				next = append(next, table)
			}
			active = next
		}
	}

	s.report(stats, rowsSent, time.Since(start), exhausted, evicted, deadlineHit)
}

// flushResult describes the outcome of one batch so the scheduler can decide
// whether to serve this table again, drop it for the cycle, or end the cycle.
type flushResult struct {
	rowsSent  int   // rows confirmed accepted by Supabase
	drained   bool  // no more eligible rows for this table right now
	retryable bool  // failure was transient (transport / 5xx)
	err       error // non-nil => stop this table; errCycleBudget => stop the cycle
}

// flushTable sends at most one batch for a table. The mutex is taken only for
// the SELECT and for the post-response bookkeeping — never across the POST.
func (s *Sender) flushTable(table string, deadline time.Time) flushResult {
	ctx, cancel, ok := s.requestContext(deadline)
	if !ok {
		return flushResult{err: errCycleBudget}
	}
	defer cancel()

	ids, payloads, err := s.selectBatch(table, s.batchSize)
	if err != nil {
		log.Printf("[sender] error querying %s entries: %v", table, err)
		return flushResult{err: err}
	}
	if len(payloads) == 0 {
		return flushResult{drained: true}
	}
	// A short batch means we have reached the tail of this table's backlog.
	drained := len(payloads) < s.batchSize

	status, errMsg, transportErr := s.postRows(ctx, table, payloads)
	if transportErr != nil {
		// Network/transport failure — transient. Retry the whole batch later.
		if isTimeout(transportErr) {
			// Ambiguous: the server may have committed the insert while the
			// client gave up, so the retry can duplicate these append-only
			// rows. This risk pre-exists; exactly-once is out of scope.
			log.Printf("[sender] %s: ambiguous timeout after %d rows — server may have committed; will retry (may duplicate): %v",
				table, len(ids), transportErr)
		} else {
			log.Printf("[sender] error sending to %s: %v", table, transportErr)
		}
		s.incrementAttempts(ids, transportErr.Error())
		return flushResult{retryable: true, err: transportErr}
	}

	if status >= 200 && status < 300 {
		s.deleteEntries(ids)
		return flushResult{rowsSent: len(ids), drained: drained}
	}

	// A client error (4xx) on a multi-row batch means one or more individual
	// rows are bad (e.g. a value that violates a CHECK constraint). PostgREST
	// rejects the ENTIRE batch for one bad row, so retrying the batch forever
	// would let a single bad row block — and eventually drop — every other
	// row behind it. Isolate by re-sending each row alone: good rows get
	// through, only the genuinely bad rows accumulate attempts and are dropped.
	if status >= 400 && status < 500 && len(ids) > 1 {
		return s.isolateBatch(table, status, ids, payloads, deadline)
	}

	// 5xx, or a single-row 4xx: increment and retry later (5xx is transient;
	// a lone 4xx row will be dropped after maxAttempts with its error logged).
	log.Printf("[sender] error from Supabase for %s: HTTP %d: %s", table, status, errMsg)
	s.incrementAttempts(ids, fmt.Sprintf("HTTP %d: %s", status, errMsg))
	return flushResult{retryable: status >= 500, err: fmt.Errorf("HTTP %d", status)}
}

// isolateBatch re-sends a rejected batch one row at a time to find the bad
// row(s). It is bounded by both maxIsolationRows and the cycle deadline —
// unbounded, a single rejected 100-row batch fires 100 serial POSTs. Rows we
// never submit are left completely untouched (no attempts increment): they
// were not tried, so they have not failed.
func (s *Sender) isolateBatch(table string, status int, ids []int64, payloads []json.RawMessage, deadline time.Time) flushResult {
	limit := len(ids)
	if limit > maxIsolationRows {
		limit = maxIsolationRows
	}
	log.Printf("[sender] %s: batch rejected (HTTP %d) — isolating up to %d of %d rows", table, status, limit, len(ids))

	good, tried := 0, 0
	budgetOut := false
	for i := 0; i < limit; i++ {
		ctx, cancel, ok := s.requestContext(deadline)
		if !ok {
			budgetOut = true
			break
		}
		st, em, te := s.postRows(ctx, table, []json.RawMessage{payloads[i]})
		cancel()
		tried++
		switch {
		case te != nil:
			s.incrementAttempts([]int64{ids[i]}, te.Error())
		case st >= 200 && st < 300:
			s.deleteEntries([]int64{ids[i]})
			good++
		default:
			s.incrementAttempts([]int64{ids[i]}, fmt.Sprintf("HTTP %d: %s", st, em))
		}
	}
	log.Printf("[sender] %s: %d/%d isolated rows accepted (%d of the batch left untouched for the next cycle)",
		table, good, tried, len(ids)-tried)

	if budgetOut {
		return flushResult{rowsSent: good, err: errCycleBudget}
	}
	// Stop this table for the cycle: isolation is expensive and the remainder
	// of the batch is picked up by the next cycle.
	return flushResult{rowsSent: good, err: fmt.Errorf("isolated batch after HTTP %d", status)}
}

// selectBatch reads the next eligible batch for a table. Lock held for the
// SELECT only.
func (s *Sender) selectBatch(table string, limit int) ([]int64, []json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(
		"SELECT id, payload FROM wal_entries WHERE table_name = ? AND attempts < ? ORDER BY id LIMIT ?",
		table, maxAttempts, limit,
	)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()

	var ids []int64
	var payloads []json.RawMessage
	for rows.Next() {
		var id int64
		var payload string
		if err := rows.Scan(&id, &payload); err != nil {
			log.Printf("[sender] error scanning row in %s: %v", table, err)
			continue
		}
		ids = append(ids, id)
		payloads = append(payloads, json.RawMessage(payload))
	}
	return ids, payloads, rows.Err()
}

// requestContext builds a per-request context whose deadline is the earlier of
// the HTTP client timeout and the remaining cycle budget. It reports false when
// too little budget remains to be worth starting a request.
func (s *Sender) requestContext(deadline time.Time) (context.Context, context.CancelFunc, bool) {
	remaining := time.Until(deadline)
	if remaining < s.minReqWindow {
		return nil, nil, false
	}
	if remaining > s.httpClient.Timeout {
		remaining = s.httpClient.Timeout
	}
	ctx, cancel := context.WithTimeout(context.Background(), remaining)
	return ctx, cancel, true
}

func isTimeout(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var ne net.Error
	if errors.As(err, &ne) {
		return ne.Timeout()
	}
	return false
}

// postRows POSTs one batch (1..N rows) to a table's REST endpoint and returns
// the HTTP status + response body, or a non-nil error for transport failures.
func (s *Sender) postRows(ctx context.Context, table string, payloads []json.RawMessage) (int, string, error) {
	body, err := normalizeBatchPayloads(payloads)
	if err != nil {
		return 0, "", fmt.Errorf("normalizing batch for %s: %w", table, err)
	}
	// Postgres text/jsonb cannot store NUL. Strip any JSON NUL escapes so rows
	// carrying NUL bytes (e.g. from /proc cmdlines or log content) aren't
	// rejected wholesale with SQLSTATE 22P05. The byte slice is the 6 ASCII
	// chars backslash-u-0-0-0-0 that json.Marshal emits for a NUL byte.
	body = bytes.ReplaceAll(body, []byte{0x5c, 0x75, 0x30, 0x30, 0x30, 0x30}, nil)

	url := fmt.Sprintf("%s/rest/v1/%s", s.supabaseURL, table)
	if cols := upsertConflictTargets[table]; cols != "" {
		url += "?on_conflict=" + cols
	}
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}

	preferHeader := "return=minimal"
	if upsertTables[table] {
		preferHeader = "resolution=merge-duplicates,return=minimal"
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", s.serviceKey)
	req.Header.Set("Authorization", "Bearer "+s.serviceKey)
	req.Header.Set("Prefer", preferHeader)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, "", nil
	}
	respBody, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(respBody), nil
}

func (s *Sender) deleteEntries(ids []int64) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[sender] error starting transaction for delete: %v", err)
		return
	}
	for _, id := range ids {
		if _, err := tx.Exec("DELETE FROM wal_entries WHERE id = ?", id); err != nil {
			log.Printf("[sender] error deleting entry %d: %v", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[sender] error committing delete transaction: %v", err)
	}
}

func (s *Sender) incrementAttempts(ids []int64, errMsg string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[sender] error starting transaction for increment: %v", err)
		return
	}
	for _, id := range ids {
		if _, err := tx.Exec("UPDATE wal_entries SET attempts = attempts + 1, last_error = ? WHERE id = ?", errMsg, id); err != nil {
			log.Printf("[sender] error incrementing attempts for %d: %v", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[sender] error committing increment transaction: %v", err)
	}
}

// enforceWALLimit keeps the local WAL under its entry cap. Order matters and is
// the fix for a data-loss bug: exhausted rows are deleted FIRST, then the cap is
// counted, then oldest-first eviction runs only if the WAL is STILL over cap.
// Previously eviction ran first, so rows that were about to be deleted anyway
// inflated COUNT(*) and caused healthy telemetry to be destroyed for capacity
// that was never actually needed.
//
// All three steps run in ONE transaction so the count cannot go stale between
// the delete and the eviction. The caller must hold s.mu.
//
// Returns the number of exhausted rows deleted and healthy rows evicted.
func (s *Sender) enforceWALLimit() (exhausted int64, evicted int64) {
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[sender] error starting WAL maintenance transaction: %v", err)
		return 0, 0
	}
	defer tx.Rollback()

	// 1. Drop exhausted entries (attempts >= maxAttempts).
	//
	// Called "exhausted"/"max-attempts", never "poison": transient 5xx and
	// transport failures also increment attempts, so some of these are healthy
	// rows abandoned after an outage rather than genuinely bad data.
	exhaustedByTable, err := tableCounts(tx,
		"SELECT table_name, COUNT(*) FROM wal_entries WHERE attempts >= ? GROUP BY table_name", maxAttempts)
	if err != nil {
		log.Printf("[sender] error counting exhausted entries: %v", err)
		return 0, 0
	}
	res, err := tx.Exec("DELETE FROM wal_entries WHERE attempts >= ?", maxAttempts)
	if err != nil {
		log.Printf("[sender] WAL failed-attempts cleanup failed: %v", err)
		return 0, 0
	}
	exhausted, _ = res.RowsAffected()

	// 2. Count what actually remains.
	var count int64
	if err := tx.QueryRow("SELECT COUNT(*) FROM wal_entries").Scan(&count); err != nil {
		log.Printf("[sender] error checking WAL size: %v", err)
		return 0, 0
	}

	// 3. Evict oldest first, but only if still over the cap.
	maxEntries := s.maxWALSize / walEntryBytes
	var evictedByTable map[string]int64
	if count > maxEntries {
		excess := count - maxEntries
		evictedByTable, err = tableCounts(tx,
			"SELECT table_name, COUNT(*) FROM (SELECT table_name FROM wal_entries ORDER BY id LIMIT ?) GROUP BY table_name", excess)
		if err != nil {
			log.Printf("[sender] error counting entries to evict: %v", err)
			return 0, 0
		}
		res, err := tx.Exec("DELETE FROM wal_entries WHERE id IN (SELECT id FROM wal_entries ORDER BY id LIMIT ?)", excess)
		if err != nil {
			log.Printf("[sender] WAL limit enforcement failed: %v", err)
			return 0, 0
		}
		evicted, _ = res.RowsAffected()
	}

	if err := tx.Commit(); err != nil {
		log.Printf("[sender] error committing WAL maintenance transaction: %v", err)
		return 0, 0
	}

	if exhausted > 0 {
		log.Printf("[sender] WAL: deleted %d exhausted entries (attempts >= %d) by table: %s",
			exhausted, maxAttempts, formatTableCounts(exhaustedByTable))
	}
	if evicted > 0 {
		// Eviction is oldest-first across ALL tables, so a noisy backlogged
		// table can destroy a quiet table's data. Name the victims.
		log.Printf("[sender] WAL OVER CAPACITY: evicted %d unsent entries (cap %d) — DATA LOST by table: %s",
			evicted, maxEntries, formatTableCounts(evictedByTable))
	}
	return exhausted, evicted
}

func tableCounts(tx *sql.Tx, query string, args ...interface{}) (map[string]int64, error) {
	rows, err := tx.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	counts := make(map[string]int64)
	for rows.Next() {
		var table string
		var n int64
		if err := rows.Scan(&table, &n); err != nil {
			return nil, err
		}
		counts[table] = n
	}
	return counts, rows.Err()
}

func formatTableCounts(counts map[string]int64) string {
	if len(counts) == 0 {
		return "none"
	}
	tables := make([]string, 0, len(counts))
	for t := range counts {
		tables = append(tables, t)
	}
	sort.Strings(tables)

	parts := make([]string, 0, len(tables))
	for _, t := range tables {
		parts = append(parts, fmt.Sprintf("%s=%d", t, counts[t]))
	}
	return strings.Join(parts, " ")
}

// tableWALStats is one table's backlog state for a single cycle.
type tableWALStats struct {
	table         string
	pending       int64
	exhausted     int64
	oldestPending time.Duration // age of the oldest eligible entry
}

// walStats reads the whole WAL backlog in ONE grouped query per cycle — never a
// COUNT per operation. Row count alone hides staleness (20k rows was 80 minutes
// behind), so the age of the oldest pending entry is reported per table.
func (s *Sender) walStats() ([]tableWALStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(`
		SELECT table_name,
		       COUNT(*) FILTER (WHERE attempts < ?),
		       COUNT(*) FILTER (WHERE attempts >= ?),
		       CAST((julianday('now') - julianday(MIN(created_at) FILTER (WHERE attempts < ?))) * 86400.0 AS REAL)
		FROM wal_entries
		GROUP BY table_name
		ORDER BY table_name`, maxAttempts, maxAttempts, maxAttempts)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var stats []tableWALStats
	for rows.Next() {
		var st tableWALStats
		var ageSecs sql.NullFloat64
		if err := rows.Scan(&st.table, &st.pending, &st.exhausted, &ageSecs); err != nil {
			return nil, err
		}
		if ageSecs.Valid && ageSecs.Float64 > 0 {
			st.oldestPending = time.Duration(ageSecs.Float64 * float64(time.Second))
		}
		stats = append(stats, st)
	}
	return stats, rows.Err()
}

func (s *Sender) pendingCount() (int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var n int64
	err := s.db.QueryRow("SELECT COUNT(*) FROM wal_entries WHERE attempts < ?", maxAttempts).Scan(&n)
	return n, err
}

// backlogLevel buckets the total backlog so the reporter can log on threshold
// transitions instead of every 30s.
func backlogLevel(pending int64) int {
	switch {
	case pending == 0:
		return 0
	case pending < 1000:
		return 1
	case pending < 10000:
		return 2
	case pending < 50000:
		return 3
	default:
		return 4
	}
}

// report logs the cycle's WAL state. This ran for weeks unnoticed because
// nothing reported it — but a line every 30s is noise nobody reads either, so
// it emits only on a backlog/staleness threshold transition, on a controlled
// interval, or when the cycle hit its deadline or lost data.
func (s *Sender) report(stats []tableWALStats, rowsSent int, cycle time.Duration, exhausted, evicted int64, deadlineHit bool) {
	var pending, exhaustedPending int64
	var oldest time.Duration
	oldestTable := ""
	for _, st := range stats {
		pending += st.pending
		exhaustedPending += st.exhausted
		if st.oldestPending > oldest {
			oldest, oldestTable = st.oldestPending, st.table
		}
	}

	level := backlogLevel(pending)
	stale := oldest >= walStaleThreshold

	force := deadlineHit || evicted > 0 || exhausted > 0
	changed := !s.reported || level != s.lastLevel || stale != s.lastStale
	due := time.Since(s.lastReportAt) >= walReportInterval
	if !force && !changed && !due {
		return
	}
	s.lastReportAt = time.Now()
	s.lastLevel = level
	s.lastStale = stale
	s.reported = true

	detail := ""
	if oldest > 0 {
		detail = fmt.Sprintf(", oldest pending %s (%s)", oldest.Round(time.Second), oldestTable)
	}
	if deadlineHit {
		detail += ", cycle budget exhausted"
	}
	log.Printf("[sender] WAL: sent %d rows in %s, %d pending, %d exhausted-awaiting-cleanup%s",
		rowsSent, cycle.Round(time.Millisecond), pending, exhaustedPending, detail)
}

func normalizeBatchPayloads(payloads []json.RawMessage) ([]byte, error) {
	normalized := make([]map[string]interface{}, 0, len(payloads))
	keySet := make(map[string]struct{})

	for _, payload := range payloads {
		var row map[string]interface{}
		if err := json.Unmarshal(payload, &row); err != nil {
			return nil, fmt.Errorf("unmarshal payload: %w", err)
		}
		for key := range row {
			keySet[key] = struct{}{}
		}
		normalized = append(normalized, row)
	}

	for _, row := range normalized {
		for key := range keySet {
			if _, ok := row[key]; !ok {
				row[key] = nil
			}
		}
	}

	body, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("marshal normalized payloads: %w", err)
	}

	return body, nil
}

// SendHeartbeat updates the NAS unit's last_seen timestamp and agent version.
func (s *Sender) SendHeartbeat(nasID, nasName, model, dsmVersion, agentVersion, agentBuiltAt string) {
	payload := map[string]interface{}{
		"id":             nasID,
		"name":           nasName,
		"model":          model,
		"dsm_version":    dsmVersion,
		"last_seen":      time.Now().UTC(),
		"status":         "online",
		"agent_version":  agentVersion,
		"agent_built_at": agentBuiltAt,
	}

	body, _ := json.Marshal(payload)
	url := fmt.Sprintf("%s/rest/v1/nas_units", s.supabaseURL)

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		log.Printf("[sender] heartbeat error: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", s.serviceKey)
	req.Header.Set("Authorization", "Bearer "+s.serviceKey)
	req.Header.Set("Prefer", "resolution=merge-duplicates,return=minimal")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		log.Printf("[sender] heartbeat send error: %v", err)
		return
	}
	resp.Body.Close()
}
