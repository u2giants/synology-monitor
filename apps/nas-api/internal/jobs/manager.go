package jobs

import (
	"context"
	"errors"
	"fmt"
	"log"
	"runtime"
	"sync"
	"time"
)

// ErrNotFound is returned when a job id does not exist (HTTP 404).
var ErrNotFound = errors.New("job not found")

// schedulerInterval is how often due scheduled jobs are promoted to queued.
const schedulerInterval = 30 * time.Second

// Manager owns the single-inventory-job-per-NAS lifecycle.
type Manager struct {
	store   *Store
	nasName string

	// rootFor maps a share name to its absolute filesystem root. Production
	// resolves to /volume1/<share> (the read-only compose mounts); tests inject
	// a temp tree.
	rootFor func(share string) string

	// moveRootFor maps a share to its WRITABLE root for archive moves. Production
	// resolves to /btrfs/volume1/<share> (the rw mount); tests inject a temp tree.
	moveRootFor func(share string) string

	// fs performs Btrfs subvolume + snapshot operations; tests inject a stub.
	fs fsOps

	mu       sync.Mutex
	activeID string             // id of the queued/running heavyweight job, "" when idle
	cancel   context.CancelFunc // cancels the active scan/move
}

// New constructs a Manager. Call RecoverOnStart then StartScheduler after.
func New(store *Store, nasName string) *Manager {
	return &Manager{
		store:       store,
		nasName:     nasName,
		rootFor:     func(share string) string { return "/volume1/" + share },
		moveRootFor: func(share string) string { return "/btrfs/volume1/" + share },
		fs:          btrfsCLI{},
	}
}

// NASName returns the resolved logical NAS name (used to rebuild canonical op
// strings for approval verification).
func (m *Manager) NASName() string { return m.nasName }

// Ready reports whether the durable job store is usable.
func (m *Manager) Ready() bool { return m.store.Ready() }

// Start validates and launches an inventory job immediately.
func (m *Manager) Start(req StartRequest) (*Job, error) {
	req.Normalize()
	if err := validateShares(req.Shares); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if m.activeID != "" {
		m.mu.Unlock()
		return nil, ErrBusy
	}
	job := m.buildJob(req, StatusQueued)
	if err := m.store.SaveJob(job); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	m.startWorkerLocked(job)
	m.mu.Unlock()
	return job, nil
}

// Schedule validates and persists a future one-shot inventory job.
func (m *Manager) Schedule(req StartRequest) (*Job, error) {
	req.Normalize()
	if err := validateShares(req.Shares); err != nil {
		return nil, err
	}
	t, err := time.Parse(time.RFC3339, req.ScheduledFor)
	if err != nil {
		return nil, fmt.Errorf("scheduled_for must be an RFC3339 UTC timestamp: %w", err)
	}
	if !t.After(time.Now()) {
		return nil, errors.New("scheduled_for must be in the future")
	}
	job := m.buildJob(req, StatusScheduled)
	job.ScheduledFor = t.UTC().Format(time.RFC3339)
	if err := m.store.SaveJob(job); err != nil {
		return nil, err
	}
	return job, nil
}

// Get returns one job's current state.
func (m *Manager) Get(id string) (*Job, error) {
	j, err := m.store.LoadJob(id)
	if err != nil {
		return nil, ErrNotFound
	}
	return j, nil
}

// List returns all jobs, newest first.
func (m *Manager) List() ([]*Job, error) { return m.store.ListJobs() }

// Cancel stops the running job, or marks a scheduled/queued job cancelled.
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	if m.activeID == id && m.cancel != nil {
		m.cancel()
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()

	j, err := m.store.LoadJob(id)
	if err != nil {
		return ErrNotFound
	}
	switch j.Status {
	case StatusScheduled, StatusQueued:
		j.Status = StatusCancelled
		j.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return m.store.SaveJob(j)
	default:
		return fmt.Errorf("job %s is %s and cannot be cancelled", id, j.Status)
	}
}

// RecoverOnStart marks jobs abandoned by a container restart as interrupted.
// Past-due scheduled jobs are left for the scheduler ticker to promote.
func (m *Manager) RecoverOnStart() {
	jobs, err := m.store.ListJobs()
	if err != nil {
		return
	}
	for _, j := range jobs {
		if j.Status == StatusRunning || j.Status == StatusQueued {
			j.Status = StatusInterrupted
			j.Error = "interrupted by NAS API restart (resume not supported)"
			j.FinishedAt = time.Now().UTC().Format(time.RFC3339)
			if err := m.store.SaveJob(j); err != nil {
				log.Printf("inventory: recover %s: %v", j.ID, err)
			}
		}
	}

	// Move jobs caught mid-stage become interrupted. An interrupted execute is
	// resumable (per-file status lives in the manifest) or can be rolled back.
	moves, err := m.store.ListMoveJobs()
	if err != nil {
		return
	}
	for _, j := range moves {
		switch j.Status {
		case MovePlanning, MovePreflight, MoveSnapshotting, MoveExecuting, MoveVerifying:
			j.Status = MoveInterrupted
			j.Error = "interrupted by NAS API restart; resume execute or roll back"
			j.FinishedAt = time.Now().UTC().Format(time.RFC3339)
			if err := m.store.SaveMoveJob(j); err != nil {
				log.Printf("archive-move: recover %s: %v", j.ID, err)
			}
		}
	}
}

// StartScheduler launches the background ticker that promotes due scheduled jobs.
func (m *Manager) StartScheduler() {
	go func() {
		t := time.NewTicker(schedulerInterval)
		defer t.Stop()
		for range t.C {
			m.promoteDue()
		}
	}()
}

// promoteDue launches the earliest past-due scheduled job if the NAS is idle.
func (m *Manager) promoteDue() {
	m.mu.Lock()
	busy := m.activeID != ""
	m.mu.Unlock()
	if busy {
		return
	}
	jobs, err := m.store.ListJobs()
	if err != nil {
		return
	}
	now := time.Now()
	var due *Job
	for _, j := range jobs {
		if j.Status != StatusScheduled {
			continue
		}
		t, err := time.Parse(time.RFC3339, j.ScheduledFor)
		if err != nil || t.After(now) {
			continue
		}
		if due == nil || j.ScheduledFor < due.ScheduledFor {
			due = j
		}
	}
	if due == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.activeID != "" {
		return // someone else started meanwhile; leave it scheduled
	}
	due.Status = StatusQueued
	if err := m.store.SaveJob(due); err != nil {
		log.Printf("inventory: promote %s: %v", due.ID, err)
		return
	}
	m.startWorkerLocked(due)
}

// startWorkerLocked reserves the active slot and launches the scan goroutine.
// The caller must hold m.mu.
func (m *Manager) startWorkerLocked(job *Job) {
	ctx, cancel := context.WithCancel(context.Background())
	m.activeID = job.ID
	m.cancel = cancel
	go m.runJob(ctx, job)
}

// runJob executes the scan and persists the terminal state.
func (m *Manager) runJob(ctx context.Context, job *Job) {
	defer func() {
		m.mu.Lock()
		if m.activeID == job.ID {
			m.activeID = ""
			m.cancel = nil
		}
		m.mu.Unlock()
	}()

	start := time.Now()
	job.Status = StatusRunning
	job.StartedAt = start.UTC().Format(time.RFC3339)
	_ = m.store.SaveJob(job)

	err := m.scan(ctx, job, start)

	job.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	job.ElapsedSecond = int64(time.Since(start).Seconds())
	switch {
	case ctx.Err() != nil || errors.Is(err, context.Canceled):
		job.Status = StatusCancelled
	case err != nil:
		job.Status = StatusFailed
		job.Error = err.Error()
	default:
		job.Status = StatusComplete
		job.ResultReady = true
	}
	if serr := m.store.SaveJob(job); serr != nil {
		log.Printf("inventory: save terminal state %s: %v", job.ID, serr)
	}
}

// scan walks every target share, writes the result CSVs, and updates progress.
func (m *Manager) scan(ctx context.Context, job *Job, start time.Time) error {
	if job.UseIdleIO {
		runtime.LockOSThread()
		if err := lowerSelf(); err != nil {
			log.Printf("inventory: idle I/O priority best-effort failed: %v", err)
		}
	}

	var protect time.Time
	protectSet := false
	if job.ProtectNewerThan != "" {
		if t, err := time.Parse(time.RFC3339, job.ProtectNewerThan); err == nil {
			protect, protectSet = t, true
		}
	}
	opts := scanOptions{
		protectNewerThan: protect,
		protectSet:       protectSet,
		sleepEveryFiles:  job.SleepEveryFiles,
		sleepMs:          job.SleepMs,
		maxFilesPerSec:   job.MaxFilesPerSec,
	}

	var aggs []*shareAgg
	var doneFiles, doneBytes int64
	for _, share := range job.TargetShares {
		if err := ctx.Err(); err != nil {
			return err
		}
		agg := newShareAgg(share)
		job.CurrentShare = share
		_ = m.store.SaveJob(job)

		onProgress := func() {
			job.FilesScanned = doneFiles + agg.filesScanned
			job.BytesScanned = doneBytes + agg.bytesScanned
			job.ElapsedSecond = int64(time.Since(start).Seconds())
			_ = m.store.SaveJob(job)
		}

		if err := walkShare(ctx, m.rootFor(share), opts, agg, onProgress); err != nil {
			return err // includes context.Canceled
		}
		aggs = append(aggs, agg)
		doneFiles += agg.filesScanned
		doneBytes += agg.bytesScanned
		job.FilesScanned = doneFiles
		job.BytesScanned = doneBytes
	}

	nas := m.nasName
	if err := m.store.WriteResult(job.ID, "yearly", buildYearlyCSV(nas, aggs)); err != nil {
		return err
	}
	if err := m.store.WriteResult(job.ID, "cutoff", buildCutoffCSV(nas, aggs, job.CutoffYears)); err != nil {
		return err
	}
	if err := m.store.WriteResult(job.ID, "dirs", buildDirsCSV(nas, aggs)); err != nil {
		return err
	}
	if job.Overlay {
		csv, note := runOverlay(ctx, m.store.JobDir(job.ID), nas)
		_ = m.store.WriteResult(job.ID, "overlay", csv)
		job.OverlayNote = note
	}
	if protectSet && anyBtimeFallback(aggs) {
		log.Printf("inventory %s: btime unavailable on some files; protection used max(mtime,ctime) fallback", job.ID)
	}
	return nil
}

func anyBtimeFallback(aggs []*shareAgg) bool {
	for _, a := range aggs {
		if a.btimeFallback {
			return true
		}
	}
	return false
}

// buildJob assembles a persisted Job from a normalized request.
func (m *Manager) buildJob(req StartRequest, status Status) *Job {
	now := time.Now()
	return &Job{
		ID:               NewJobID(m.nasName, now),
		Type:             JobType,
		NAS:              m.nasName,
		Status:           status,
		TargetShares:     req.Shares,
		CutoffYears:      req.CutoffYears,
		Overlay:          req.OverlayEffective(),
		ProtectNewerThan: req.ProtectNewerThan,
		MaxFilesPerSec:   req.MaxFilesPerSec,
		UseIdleIO:        req.UseIdleIOEffective(),
		SleepEveryFiles:  req.SleepEveryFiles,
		SleepMs:          req.SleepMs,
	}
}

// validateShares enforces a non-empty, fully-allowlisted share set.
func validateShares(shares []string) error {
	if len(shares) == 0 {
		return errors.New("shares is required and must be non-empty")
	}
	for _, s := range shares {
		if !IsAllowedShare(s) {
			return fmt.Errorf("share %q is not in the allowlist", s)
		}
	}
	return nil
}
