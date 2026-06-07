package jobs

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func boolPtr(b bool) *bool { return &b }

func isTerminal(s Status) bool {
	switch s {
	case StatusComplete, StatusFailed, StatusCancelled, StatusInterrupted:
		return true
	}
	return false
}

func newTestManager(t *testing.T, tree string) *Manager {
	t.Helper()
	store := NewStore(t.TempDir())
	if !store.Ready() {
		t.Fatal("store should be ready on a fresh temp dir")
	}
	m := New(store, "edgesynology1")
	m.rootFor = func(string) string { return tree }
	return m
}

func waitTerminal(t *testing.T, m *Manager, id string) *Job {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if j, err := m.Get(id); err == nil && isTerminal(j.Status) {
			return j
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s never reached a terminal state", id)
	return nil
}

func quietReq(shares ...string) StartRequest {
	return StartRequest{Shares: shares, Overlay: boolPtr(false), UseIdleIO: boolPtr(false)}
}

func TestCanonicalOpString(t *testing.T) {
	start := CanonicalOpString(OpStart, "edgesynology1", "", &StartRequest{
		Shares:      []string{"files", "Coldlion"},
		CutoffYears: []int{2022, 2021},
	})
	if want := "inventory.start|nas=edgesynology1|shares=Coldlion,files|cutoff=2021,2022|overlay=true|protect="; start != want {
		t.Errorf("start canonical:\n got %q\nwant %q", start, want)
	}

	off := CanonicalOpString(OpStart, "edgesynology1", "", &StartRequest{
		Shares:           []string{"mac"},
		Overlay:          boolPtr(false),
		ProtectNewerThan: "2025-01-01T00:00:00Z",
	})
	if want := "inventory.start|nas=edgesynology1|shares=mac|cutoff=|overlay=false|protect=2025-01-01T00:00:00Z"; off != want {
		t.Errorf("start canonical (overlay off):\n got %q\nwant %q", off, want)
	}

	sched := CanonicalOpString(OpSchedule, "edgesynology2", "", &StartRequest{
		Shares:       []string{"files"},
		ScheduledFor: "2026-06-08T02:00:00Z",
	})
	if want := "inventory.schedule|nas=edgesynology2|shares=files|cutoff=|overlay=true|protect=|scheduled_for=2026-06-08T02:00:00Z"; sched != want {
		t.Errorf("schedule canonical:\n got %q\nwant %q", sched, want)
	}

	cancel := CanonicalOpString(OpCancel, "edgesynology1", "inv_x", nil)
	if want := "inventory.cancel|nas=edgesynology1|job_id=inv_x"; cancel != want {
		t.Errorf("cancel canonical:\n got %q\nwant %q", cancel, want)
	}
}

func TestStoreAtomicWriteRoundTrip(t *testing.T) {
	store := NewStore(t.TempDir())
	j := &Job{ID: NewJobID("edgesynology1", time.Now()), Type: JobType, Status: StatusQueued, TargetShares: []string{"files"}}
	if err := store.SaveJob(j); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(store.JobDir(j.ID), "status.json.tmp")); !os.IsNotExist(err) {
		t.Error("temp file should not remain after an atomic save")
	}
	got, err := store.LoadJob(j.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != j.ID || got.Status != StatusQueued {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestSingleJobInvariant(t *testing.T) {
	tree := t.TempDir()
	for i := 0; i < 40; i++ {
		writeFileWithMtime(t, filepath.Join(tree, "f", "file"+string(rune('A'+i))), 1, 2021)
	}
	m := newTestManager(t, tree)

	req := quietReq("files")
	req.SleepEveryFiles = 1
	req.SleepMs = 25 // ~1s of work — wide window for the second Start

	j1, err := m.Start(req)
	if err != nil {
		t.Fatalf("first Start: %v", err)
	}
	if _, err := m.Start(quietReq("files")); !errors.Is(err, ErrBusy) {
		t.Errorf("second Start should be ErrBusy, got %v", err)
	}
	if err := m.Cancel(j1.ID); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	final := waitTerminal(t, m, j1.ID)
	if final.Status != StatusCancelled {
		t.Errorf("job status = %s, want cancelled", final.Status)
	}
}

func TestStartupRecovery(t *testing.T) {
	base := t.TempDir()
	store := NewStore(base)
	running := &Job{ID: NewJobID("edgesynology1", time.Now()), Type: JobType, Status: StatusRunning}
	queued := &Job{ID: NewJobID("edgesynology1", time.Now().Add(time.Second)), Type: JobType, Status: StatusQueued}
	done := &Job{ID: NewJobID("edgesynology1", time.Now().Add(2 * time.Second)), Type: JobType, Status: StatusComplete}
	for _, j := range []*Job{running, queued, done} {
		if err := store.SaveJob(j); err != nil {
			t.Fatal(err)
		}
	}

	m := New(store, "edgesynology1")
	m.RecoverOnStart()

	for _, tc := range []struct {
		id   string
		want Status
	}{
		{running.ID, StatusInterrupted},
		{queued.ID, StatusInterrupted},
		{done.ID, StatusComplete}, // terminal jobs are untouched
	} {
		j, err := m.Get(tc.id)
		if err != nil {
			t.Fatal(err)
		}
		if j.Status != tc.want {
			t.Errorf("job %s status = %s, want %s", tc.id, j.Status, tc.want)
		}
	}
}

func TestScheduledDuePromotion(t *testing.T) {
	tree := t.TempDir()
	writeFileWithMtime(t, filepath.Join(tree, "a.txt"), 1, 2021)
	m := newTestManager(t, tree)

	// Persist a scheduled job whose time has already passed (bypassing the
	// future-time validation in Schedule, which is what a restart would see).
	due := m.buildJob(quietReq("files"), StatusScheduled)
	due.ScheduledFor = time.Now().Add(-time.Minute).UTC().Format(time.RFC3339)
	if err := m.store.SaveJob(due); err != nil {
		t.Fatal(err)
	}

	m.promoteDue()
	final := waitTerminal(t, m, due.ID)
	if final.Status != StatusComplete {
		t.Errorf("promoted job status = %s, want complete", final.Status)
	}
	if !final.ResultReady {
		t.Error("promoted job should have results ready")
	}
}

func TestScheduleRejectsPastAndBadShares(t *testing.T) {
	m := newTestManager(t, t.TempDir())
	past := quietReq("files")
	past.ScheduledFor = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	if _, err := m.Schedule(past); err == nil {
		t.Error("Schedule should reject a past time")
	}
	bad := quietReq("not_a_real_share")
	bad.ScheduledFor = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	if _, err := m.Schedule(bad); err == nil {
		t.Error("Schedule should reject a non-allowlisted share")
	}
}

func TestStartRejectsEmptyShares(t *testing.T) {
	m := newTestManager(t, t.TempDir())
	if _, err := m.Start(quietReq()); err == nil {
		t.Error("Start should reject an empty share list")
	}
}
