package jobs

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	errNotEmpty      = errors.New("directory is not prunable-empty")
	ErrMoveBusy      = errors.New("a heavyweight job is already running on this NAS")
	ErrMoveState     = errors.New("move job is not in a state that allows this operation")
	movePersistEvery = 200 // files between manifest/job persists
)

const suspiciousHashMaxBytes int64 = 512 * 1024 * 1024

var xmpDateRe = regexp.MustCompile(`<xmp:(CreateDate|ModifyDate|MetadataDate)>([^<]+)</xmp:[^>]+>`)

// ── Read operations ────────────────────────────────────────────────────────────

func (m *Manager) MoveGet(id string) (*MoveJob, error) {
	j, err := m.store.LoadMoveJob(id)
	if err != nil {
		return nil, ErrNotFound
	}
	return j, nil
}

func (m *Manager) MoveList() ([]*MoveJob, error) { return m.store.ListMoveJobs() }

// MoveManifestPage returns bounded JSONL lines from a job's manifest.
func (m *Manager) MoveManifestPage(id string, cursor, limit int) (lines []string, total, next int, err error) {
	path, ok := m.store.MoveResultPath(id, "manifest")
	if !ok {
		return nil, 0, -1, errors.New("manifest path")
	}
	return readManifestPaged(path, cursor, limit)
}

// MoveResult reads one of a move job's result files.
func (m *Manager) MoveResult(id, kind string) ([]byte, error) {
	path, ok := m.store.MoveResultPath(id, kind)
	if !ok {
		return nil, errors.New("unknown result kind")
	}
	return os.ReadFile(path)
}

// ── Plan (tier 2) ──────────────────────────────────────────────────────────────

func (m *Manager) PlanMove(req MovePlanRequest) (*MoveJob, error) {
	req.Normalize()
	if err := validateMoveRequest(req); err != nil {
		return nil, err
	}
	m.mu.Lock()
	if m.activeID != "" {
		m.mu.Unlock()
		return nil, ErrBusy
	}
	job := m.buildMoveJob(req)
	job.Status = MovePlanning
	if err := m.store.SaveMoveJob(job); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.activeID = job.ID
	m.cancel = cancel
	go m.runPlan(ctx, job)
	m.mu.Unlock()
	return job, nil
}

func (m *Manager) runPlan(ctx context.Context, job *MoveJob) {
	defer m.releaseActive(job.ID)
	manifestPath, _ := m.store.MoveResultPath(job.ID, "manifest")
	_ = os.Remove(manifestPath) // fresh manifest; plan is safe to re-run

	shareRoot := m.moveRootFor(job.Share)
	scopeRoots := m.scopeRoots(job)

	var err error
	if job.Mode == ModeCleanEmptyDirs {
		err = m.planCleanDirs(ctx, job, scopeRoots, manifestPath)
	} else {
		err = m.planMoveFiles(ctx, job, shareRoot, scopeRoots, manifestPath)
	}

	if ctx.Err() != nil {
		m.finishMove(job, MoveCancelled, "")
		return
	}
	if err != nil {
		m.finishMove(job, MoveFailed, err.Error())
		return
	}
	job.ManifestPath = manifestPath
	m.finishMove(job, MovePlanned, "")
}

func (m *Manager) planMoveFiles(ctx context.Context, job *MoveJob, shareRoot string, scopeRoots []string, manifestPath string) error {
	cutoff := maxInt(job.CutoffYears)
	protect, protectSet := parseProtect(job.ProtectNewerThan)
	plannedReason := reasonForCutoff(cutoff)
	if job.ForceArchive {
		plannedReason = ReasonForceArchive
	}
	count := 0
	for _, root := range scopeRoots {
		werr := walkFiles(ctx, root, func(path string, d fs.DirEntry) error {
			rel, err := filepath.Rel(shareRoot, path)
			if err != nil {
				return nil
			}
			if !matchScope(rel, job.IncludeGlobs, job.ExcludeGlobs) {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			id, err := identityOf(path)
			if err != nil {
				return nil
			}
			if !job.ForceArchive && info.ModTime().Year() >= cutoff {
				if detail := suspiciousFreshDateEvidence(path, shareRoot, rel, id, cutoff); detail != "" {
					dest := filepath.Join(shareRoot, ArchiveDirName, rel)
					entry := manifestEntryForFile(rel, path, dest, id, ReasonSuspiciousFreshDate)
					entry.Status = MStatusSkipped
					entry.Detail = detail
					job.Skipped++
					count++
					if count%movePersistEvery == 0 {
						_ = m.store.SaveMoveJob(job)
					}
					return appendManifest(manifestPath, entry)
				}
				return nil // newer than the cutoff boundary
			}
			if protectSet && protectedByNewest(id.mtime, id.ctime, id.btime, id.hasBt, protect) {
				return nil // held back by the protect date
			}
			captureDirMtimes(job, shareRoot, filepath.Dir(path))
			dest := filepath.Join(shareRoot, ArchiveDirName, rel)
			entry := manifestEntryForFile(rel, path, dest, id, plannedReason)
			if sid, serr := m.fs.subvolID(path); serr == nil {
				entry.SubvolID = sid
			}
			if _, lerr := os.Lstat(dest); lerr == nil {
				entry.Status = MStatusSkipped
				entry.Detail = "collision"
				job.Skipped++
			} else {
				job.Planned++
			}
			count++
			if count%movePersistEvery == 0 {
				_ = m.store.SaveMoveJob(job)
			}
			return appendManifest(manifestPath, entry)
		})
		if werr != nil {
			return werr
		}
	}
	if job.RemovePreexistingEmptyDirs {
		return m.planPreexistingEmptyDirs(ctx, job, scopeRoots, manifestPath)
	}
	return nil
}

func (m *Manager) planCleanDirs(ctx context.Context, job *MoveJob, scopeRoots []string, manifestPath string) error {
	return m.planDirs(ctx, job, scopeRoots, manifestPath, ReasonPreexistingEmpty)
}

func (m *Manager) planPreexistingEmptyDirs(ctx context.Context, job *MoveJob, scopeRoots []string, manifestPath string) error {
	return m.planDirs(ctx, job, scopeRoots, manifestPath, ReasonPreexistingEmpty)
}

func (m *Manager) planDirs(ctx context.Context, job *MoveJob, scopeRoots []string, manifestPath, reason string) error {
	for _, root := range scopeRoots {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		dirs, err := listPrunableEmptyDirs(root)
		if err != nil {
			return err
		}
		for _, dir := range dirs {
			row, err := dirRowFor(dir, reason)
			if err != nil {
				continue
			}
			job.addPlannedDir(row)
			if err := appendManifest(manifestPath, row); err != nil {
				return err
			}
		}
	}
	return nil
}

// ── Execute (tier 3) ─────────────────────────────────────────────────────────

func (m *Manager) ExecuteMove(id string) (*MoveJob, error) {
	job, err := m.store.LoadMoveJob(id)
	if err != nil {
		return nil, ErrNotFound
	}
	// planned → first run; interrupted/cancelled → resume (the manifest's per-file
	// status means already-moved files are skipped, completing only the rest).
	switch job.Status {
	case MovePlanned, MoveInterrupted, MoveCancelled:
	default:
		return nil, fmt.Errorf("%w: status is %s (need planned, interrupted, or cancelled to resume)", ErrMoveState, job.Status)
	}
	m.mu.Lock()
	if m.activeID != "" {
		m.mu.Unlock()
		return nil, ErrBusy
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.activeID = job.ID
	m.cancel = cancel
	job.StartedAt = time.Now().UTC().Format(time.RFC3339)
	// Flip to a non-terminal status synchronously so a caller that polls right
	// after this returns never observes a stale prior terminal state (e.g. a
	// cancelled job being resumed).
	job.Status = MovePreflight
	job.Error = ""
	_ = m.store.SaveMoveJob(job)
	go m.runExecute(ctx, job)
	m.mu.Unlock()
	return job, nil
}

func (m *Manager) runExecute(ctx context.Context, job *MoveJob) {
	defer m.releaseActive(job.ID)

	manifestPath := job.ManifestPath
	entries, err := readManifest(manifestPath)
	if err != nil {
		m.finishMove(job, MoveFailed, "read manifest: "+err.Error())
		return
	}

	shareRoot := m.moveRootFor(job.Share)
	archiveRoot := filepath.Join(shareRoot, ArchiveDirName)

	// Preflight.
	job.Status = MovePreflight
	_ = m.store.SaveMoveJob(job)
	if perr := m.preflight(job, shareRoot, archiveRoot, entries); perr != nil {
		job.PreflightNote = perr.Error()
		m.finishMove(job, MovePreflightFailed, "preflight failed")
		return
	}

	// Snapshot (skipped only when there is nothing to protect — but we always
	// snapshot before any destructive op for the whole-run safety net).
	job.Status = MoveSnapshotting
	_ = m.store.SaveMoveJob(job)
	if serr := m.takeSnapshot(job, shareRoot); serr != nil {
		m.finishMove(job, MoveFailed, "snapshot: "+serr.Error())
		return
	}

	// Idle I/O priority for the destructive loop.
	runtime.LockOSThread()
	if err := lowerSelf(); err != nil {
		log.Printf("archive-move: idle I/O best-effort failed: %v", err)
	}

	job.Status = MoveExecuting
	_ = m.store.SaveMoveJob(job)

	if job.Mode == ModeCleanEmptyDirs {
		err = m.executeCleanDirs(ctx, job, entries, manifestPath)
	} else {
		err = m.executeRenames(ctx, job, archiveRoot, entries, manifestPath)
	}
	if ctx.Err() != nil {
		_ = writeManifest(manifestPath, entries)
		m.finishMove(job, MoveCancelled, "")
		return
	}
	if err != nil {
		_ = writeManifest(manifestPath, entries)
		m.finishMove(job, MoveFailed, err.Error())
		return
	}

	// Verify & finalize.
	job.Status = MoveVerifying
	_ = m.store.SaveMoveJob(job)
	m.verifyAndFinalize(job, shareRoot, archiveRoot, entries, manifestPath)
	_ = writeManifest(manifestPath, entries)
	m.writeMoveReports(job, entries)
	m.finishMove(job, MoveComplete, "")
}

// executeRenames performs the atomic rename-and-verify loop.
func (m *Manager) executeRenames(ctx context.Context, job *MoveJob, archiveRoot string, entries []ManifestEntry, manifestPath string) error {
	processed := 0
	for i := range entries {
		e := &entries[i]
		if e.Kind != KindFile || e.Status == MStatusSkipped {
			continue
		}
		if e.Status == MStatusMoved || e.Status == MStatusVerified {
			continue // resume: already done
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		job.CurrentPath = e.RelPath

		if err := ensureDestParent(e.SourceAbs, e.DestAbs); err != nil {
			e.Status = MStatusFailed
			e.Detail = "mkdir dest parent: " + err.Error()
			job.Failed++
			return fmt.Errorf("mkdir dest parent for %s: %w", e.RelPath, err)
		}
		if err := os.Rename(e.SourceAbs, e.DestAbs); err != nil {
			e.Status = MStatusFailed
			e.Detail = "rename: " + err.Error()
			job.Failed++
			return fmt.Errorf("rename %s: %w", e.RelPath, err)
		}
		got, err := identityOf(e.DestAbs)
		if err != nil {
			_ = os.Rename(e.DestAbs, e.SourceAbs) // best-effort rollback of this file
			e.Status = MStatusFailed
			e.Detail = "re-stat dest: " + err.Error()
			job.Failed++
			return fmt.Errorf("re-stat %s: %w", e.RelPath, err)
		}
		if ok, detail := identityMatches(e, got); !ok {
			_ = os.Rename(e.DestAbs, e.SourceAbs) // per-file rollback
			e.Status = MStatusFailed
			e.Detail = "identity mismatch after rename: " + detail
			job.Failed++
			return fmt.Errorf("identity mismatch for %s: %s", e.RelPath, detail)
		}
		e.Status = MStatusMoved
		job.Moved++
		job.BytesMoved += e.Size

		processed++
		if processed%movePersistEvery == 0 {
			_ = writeManifest(manifestPath, entries)
			_ = m.store.SaveMoveJob(job)
		}
	}
	return nil
}

// executeCleanDirs removes the planned empty directories bottom-up (deepest
// first, which the manifest order already guarantees from listPrunableEmptyDirs).
func (m *Manager) executeCleanDirs(ctx context.Context, job *MoveJob, entries []ManifestEntry, manifestPath string) error {
	processed := 0
	for i := range entries {
		e := &entries[i]
		if e.Kind != KindDir || e.Status != MStatusPlanned {
			continue
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		job.CurrentPath = e.Path
		if err := pruneEmptyDir(e.Path); err != nil {
			if errors.Is(err, errNotEmpty) {
				e.Status = MStatusSkipped
				e.Detail = "no longer empty"
				job.Skipped++
				continue
			}
			e.Status = MStatusFailed
			e.Detail = err.Error()
			job.Failed++
			return err
		}
		e.Status = MStatusRemoved
		job.DirsPruned++
		processed++
		if processed%movePersistEvery == 0 {
			_ = writeManifest(manifestPath, entries)
			_ = m.store.SaveMoveJob(job)
		}
	}
	return nil
}

// ── Preflight ──────────────────────────────────────────────────────────────────

func (m *Manager) preflight(job *MoveJob, shareRoot, archiveRoot string, entries []ManifestEntry) error {
	gates := map[string]string{}
	pass := func(name string) { gates[name] = "pass" }
	fail := func(name string, err error) error {
		gates[name] = "fail: " + err.Error()
		m.writePreflight(job, gates)
		return err
	}

	if _, err := os.Stat(shareRoot); err != nil {
		return fail("share_exists", err)
	}
	pass("share_exists")

	// Snapshot readiness.
	if err := m.fs.snapshotSupported(shareRoot); err != nil {
		return fail("snapshot_ready", err)
	}
	pass("snapshot_ready")

	if job.Mode == ModeCleanEmptyDirs {
		m.writePreflight(job, gates)
		return nil // no rename gates needed when moving zero files
	}

	// Same-device (same Btrfs subvolume) test-rename round-trip.
	if err := os.MkdirAll(archiveRoot, 0o755); err != nil {
		return fail("archive_root", err)
	}
	pass("archive_root")
	if err := testRename(shareRoot, archiveRoot); err != nil {
		return fail("test_rename_same_subvol", err)
	}
	pass("test_rename_same_subvol")

	// Fresh collision rescan + symlink recheck on planned files.
	for i := range entries {
		e := &entries[i]
		if e.Kind != KindFile || e.Status != MStatusPlanned {
			continue
		}
		if fi, err := os.Lstat(e.SourceAbs); err == nil && fi.Mode()&os.ModeSymlink != 0 {
			return fail("no_symlinks", fmt.Errorf("%s is a symlink", e.RelPath))
		}
		if _, err := os.Lstat(e.DestAbs); err == nil {
			return fail("collision_rescan", fmt.Errorf("destination already exists: %s", e.DestAbs))
		}
	}
	pass("collision_rescan")
	pass("no_symlinks")

	m.writePreflight(job, gates)
	return nil
}

// testRename creates a throwaway file under shareRoot, renames it into
// archiveRoot, verifies identity is preserved and the device is unchanged, then
// renames it back and deletes it. Catches any cross-subvolume boundary.
func testRename(shareRoot, archiveRoot string) error {
	probe := filepath.Join(shareRoot, ".archive_move_probe_"+randHex4())
	if err := os.WriteFile(probe, []byte("probe"), 0o600); err != nil {
		return err
	}
	defer os.Remove(probe)
	before, err := identityOf(probe)
	if err != nil {
		return err
	}
	dest := filepath.Join(archiveRoot, ".archive_move_probe_"+randHex4())
	if err := os.Rename(probe, dest); err != nil {
		return err
	}
	after, err := identityOf(dest)
	if err != nil {
		_ = os.Remove(dest)
		return err
	}
	if after.dev != before.dev || after.inode != before.inode {
		_ = os.Remove(dest)
		return fmt.Errorf("rename crossed a device/subvolume boundary (dev %d→%d, inode %d→%d) — copy-and-delete is forbidden", before.dev, after.dev, before.inode, after.inode)
	}
	return os.Rename(dest, probe) // move it back; defer removes it
}

// ── Snapshot ───────────────────────────────────────────────────────────────────

func (m *Manager) takeSnapshot(job *MoveJob, shareRoot string) error {
	parent := filepath.Join(filepath.Dir(shareRoot), "@archive_move_snapshots")
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return err
	}
	snapPath := filepath.Join(parent, job.ID)
	id, err := m.fs.createROSnapshot(shareRoot, snapPath)
	if err != nil {
		return err
	}
	job.SnapshotID = strconv.FormatUint(id, 10)
	job.SnapshotPath = snapPath
	_ = m.store.SaveMoveJob(job)
	return nil
}

// ── Verify & finalize ──────────────────────────────────────────────────────────

func (m *Manager) verifyAndFinalize(job *MoveJob, shareRoot, archiveRoot string, entries []ManifestEntry, manifestPath string) {
	touched := map[string]bool{}
	plannedDirs := map[string]int{}
	for i := range entries {
		e := &entries[i]
		if e.Kind == KindDir && e.Status == MStatusPlanned {
			plannedDirs[e.Path] = i
			continue
		}
		if e.Kind != KindFile || e.Status != MStatusMoved {
			continue
		}
		// Confirm dest exists with matching inode and source is gone.
		got, err := identityOf(e.DestAbs)
		if err != nil {
			e.Detail = "verify: dest missing: " + err.Error()
			continue
		}
		if got.inode != e.Inode {
			e.Detail = "verify: inode changed"
			continue
		}
		if _, err := os.Lstat(e.SourceAbs); err == nil {
			e.Detail = "verify: source still present"
			continue
		}
		e.Status = MStatusVerified
		job.Verified++
		for _, anc := range ancestorsWithin(e.SourceAbs, shareRoot) {
			touched[anc] = true
		}
	}

	// Prune source directories (emptied-by-move and, if enabled, pre-existing).
	for _, root := range m.scopeRoots(job) {
		dirs, err := listPrunableEmptyDirs(root)
		if err != nil {
			continue
		}
		for _, dir := range dirs {
			if dir == archiveRoot || strings.HasPrefix(dir, archiveRoot+string(os.PathSeparator)) {
				continue // never prune the Archive tree itself
			}
			reason := ReasonPreexistingEmpty
			if touched[dir] {
				reason = ReasonEmptiedByMove
			}
			doPrune := (reason == ReasonEmptiedByMove && job.PruneEmptiedSourceDirs) ||
				(reason == ReasonPreexistingEmpty && job.RemovePreexistingEmptyDirs)
			if !doPrune {
				continue
			}
			row, err := dirRowFor(dir, reason)
			if err != nil {
				continue
			}
			if err := pruneEmptyDir(dir); err != nil {
				continue
			}
			row.Status = MStatusRemoved
			if _, ok := plannedDirs[dir]; !ok {
				job.addPlannedDir(row)
			}
			if idx, ok := plannedDirs[dir]; ok {
				entries[idx] = row
			} else {
				entries = append(entries, row)
			}
			job.DirsPruned++
		}
	}
	_ = writeManifest(manifestPath, entries)

	// Apply the Archive/ sync exclusion (best-effort + operator guidance).
	restoreArchiveDirMtimes(job, archiveRoot)
	job.SyncExclusionNote = applySyncExclusion(shareRoot)
}

// applySyncExclusion adds <share>/Archive to Resilio's .sync/IgnoreList when one
// exists, and always returns operator guidance for the exclusion that could not
// be automated.
func applySyncExclusion(shareRoot string) string {
	var notes []string
	ignore := filepath.Join(shareRoot, ".sync", "IgnoreList")
	if data, err := os.ReadFile(ignore); err == nil {
		if !strings.Contains(string(data), ArchiveDirName) {
			f, oerr := os.OpenFile(ignore, os.O_APPEND|os.O_WRONLY, 0o644)
			if oerr == nil {
				_, _ = f.WriteString("\n" + ArchiveDirName + "\n")
				f.Close()
				notes = append(notes, "Resilio: appended '"+ArchiveDirName+"' to .sync/IgnoreList")
			}
		} else {
			notes = append(notes, "Resilio: '"+ArchiveDirName+"' already in .sync/IgnoreList")
		}
	} else {
		notes = append(notes, "Resilio: no .sync/IgnoreList found — add '"+ArchiveDirName+"' to the job's IgnoreList manually if Resilio syncs this share")
	}
	notes = append(notes, "Synology Drive ShareSync: exclude '"+ArchiveDirName+"' via selective sync in the Drive Admin Console for this team folder")
	return strings.Join(notes, "; ")
}

// ── Cancel (tier 2) ─────────────────────────────────────────────────────────────

func (m *Manager) CancelMove(id string) error {
	m.mu.Lock()
	if m.activeID == id && m.cancel != nil {
		m.cancel()
		m.mu.Unlock()
		return nil
	}
	m.mu.Unlock()
	j, err := m.store.LoadMoveJob(id)
	if err != nil {
		return ErrNotFound
	}
	if j.Status == MovePlanned || j.Status == MoveInterrupted {
		j.Status = MoveCancelled
		j.FinishedAt = time.Now().UTC().Format(time.RFC3339)
		return m.store.SaveMoveJob(j)
	}
	return fmt.Errorf("%w: status is %s", ErrMoveState, j.Status)
}

// ── Rollback (tier 3) ────────────────────────────────────────────────────────

func (m *Manager) RollbackMove(id string) (*MoveJob, error) {
	job, err := m.store.LoadMoveJob(id)
	if err != nil {
		return nil, ErrNotFound
	}
	switch job.Status {
	case MoveComplete, MoveFailed, MoveCancelled, MoveInterrupted:
		// reversible
	default:
		return nil, fmt.Errorf("%w: cannot roll back from status %s", ErrMoveState, job.Status)
	}
	m.mu.Lock()
	if m.activeID != "" {
		m.mu.Unlock()
		return nil, ErrBusy
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.activeID = job.ID
	m.cancel = cancel
	go m.runRollback(ctx, job)
	m.mu.Unlock()
	return job, nil
}

func (m *Manager) runRollback(ctx context.Context, job *MoveJob) {
	defer m.releaseActive(job.ID)
	manifestPath := job.ManifestPath
	entries, err := readManifest(manifestPath)
	if err != nil {
		m.finishMove(job, MoveFailed, "rollback read manifest: "+err.Error())
		return
	}

	// 1. Recreate removed/pruned directories first (so files have a parent).
	for i := range entries {
		e := &entries[i]
		if e.Kind == KindDir && (e.Status == MStatusRemoved) {
			if err := recreateDir(*e); err == nil {
				e.Status = MStatusRecreated
			}
		}
	}
	// 2. Rename dest → source for moved/verified files; verify identity.
	for i := range entries {
		e := &entries[i]
		if e.Kind != KindFile || (e.Status != MStatusMoved && e.Status != MStatusVerified) {
			continue
		}
		if ctx.Err() != nil {
			break
		}
		if err := ensureDestParent(e.DestAbs, e.SourceAbs); err != nil {
			e.Detail = "rollback mkdir: " + err.Error()
			continue
		}
		if err := os.Rename(e.DestAbs, e.SourceAbs); err != nil {
			e.Detail = "rollback rename: " + err.Error()
			continue
		}
		e.Status = MStatusRolledBack
	}
	_ = writeManifest(manifestPath, entries)

	// 3. Remove any now-empty Archive directories left by the rollback.
	shareRoot := m.moveRootFor(job.Share)
	if dirs, derr := listPrunableEmptyDirs(filepath.Join(shareRoot, ArchiveDirName)); derr == nil {
		for _, d := range dirs {
			_ = pruneEmptyDir(d)
		}
	}
	m.finishMove(job, MoveRolledBack, "")
}

// ReVerifyMove re-checks a move against the current filesystem (read-only) and
// regenerates the verify report. It never changes file state.
func (m *Manager) ReVerifyMove(id string) (*MoveJob, []byte, error) {
	job, err := m.store.LoadMoveJob(id)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	entries, err := readManifest(job.ManifestPath)
	if err != nil {
		return nil, nil, err
	}
	var verified, missing, mismatch int64
	for i := range entries {
		e := &entries[i]
		if e.Kind != KindFile || (e.Status != MStatusMoved && e.Status != MStatusVerified) {
			continue
		}
		got, gerr := identityOf(e.DestAbs)
		if gerr != nil {
			missing++
			continue
		}
		if got.inode != e.Inode {
			mismatch++
			continue
		}
		verified++
	}
	var vr strings.Builder
	vr.WriteString("nas,share,verified,missing,identity_mismatch\n")
	fmt.Fprintf(&vr, "%s,%s,%d,%d,%d\n", job.NAS, job.Share, verified, missing, mismatch)
	report := []byte(vr.String())
	_ = m.store.WriteMoveResult(id, "verify-report", report)
	return job, report, nil
}

// RepairDirMtimesFromSnapshot restores Archive directory mtimes for an already-
// executed move by mapping Archive/<rel-dir> back to the read-only snapshot's
// <rel-dir>. It only changes directory access/modified timestamps, never file
// contents or locations.
//
// Cross-NAS timestamp evidence must stay outside this native job path. When
// edgesynology2 is used as an authority for edgesynology1 repairs, callers should
// write only to edgesynology1 unless an operator explicitly requests both sides;
// writing both NASes can create competing ShareSync metadata events and inode
// churn on edgesynology1.
func (m *Manager) RepairDirMtimesFromSnapshot(id string) (*MoveJob, []byte, error) {
	job, err := m.store.LoadMoveJob(id)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	if job.SnapshotPath == "" {
		return nil, nil, fmt.Errorf("%w: job has no snapshot_path", ErrMoveState)
	}
	switch job.Status {
	case MoveComplete, MoveFailed, MoveCancelled, MoveInterrupted:
	default:
		return nil, nil, fmt.Errorf("%w: cannot repair directory mtimes from status %s", ErrMoveState, job.Status)
	}
	entries, err := readManifest(job.ManifestPath)
	if err != nil {
		return nil, nil, err
	}
	archiveRoot := filepath.Join(m.moveRootFor(job.Share), ArchiveDirName)
	type repairRow struct {
		rel    string
		dest   string
		source string
		mtime  time.Time
		status string
		detail string
	}
	rowsByRel := map[string]repairRow{}
	for i := range entries {
		e := entries[i]
		if e.Kind != KindFile || (e.Status != MStatusMoved && e.Status != MStatusVerified) {
			continue
		}
		for _, rel := range relDirAncestors(e.RelPath) {
			if _, seen := rowsByRel[rel]; seen {
				continue
			}
			src := filepath.Join(job.SnapshotPath, filepath.FromSlash(rel))
			dst := filepath.Join(archiveRoot, filepath.FromSlash(rel))
			info, serr := os.Stat(src)
			if serr != nil {
				rowsByRel[rel] = repairRow{rel: rel, dest: dst, source: src, status: "skipped", detail: "snapshot dir missing: " + serr.Error()}
				continue
			}
			rowsByRel[rel] = repairRow{rel: rel, dest: dst, source: src, mtime: info.ModTime(), status: "planned"}
		}
	}
	rels := make([]string, 0, len(rowsByRel))
	for rel := range rowsByRel {
		rels = append(rels, rel)
	}
	sort.Slice(rels, func(i, j int) bool { return len(rels[i]) > len(rels[j]) })
	for _, rel := range rels {
		row := rowsByRel[rel]
		if row.status != "planned" {
			rowsByRel[rel] = row
			continue
		}
		if err := os.Chtimes(row.dest, row.mtime, row.mtime); err != nil {
			row.status = "failed"
			row.detail = err.Error()
		} else {
			row.status = "restored"
		}
		rowsByRel[rel] = row
	}

	var report strings.Builder
	report.WriteString("nas,share,rel_dir,archive_dir,snapshot_dir,snapshot_mtime,status,detail\n")
	for _, rel := range rels {
		row := rowsByRel[rel]
		mtime := ""
		if !row.mtime.IsZero() {
			mtime = row.mtime.UTC().Format(time.RFC3339Nano)
		}
		fmt.Fprintf(&report, "%s,%s,%q,%q,%q,%s,%s,%q\n",
			job.NAS, job.Share, rel, row.dest, row.source, mtime, row.status, row.detail)
	}
	out := []byte(report.String())
	_ = m.store.WriteMoveResult(id, "dir-mtime-repair", out)
	return job, out, nil
}

// ── Helpers ──────────────────────────────────────────────────────────────────

func (m *Manager) buildMoveJob(req MovePlanRequest) *MoveJob {
	return &MoveJob{
		ID:                         NewMoveJobID(m.nasName, time.Now()),
		Type:                       MoveJobType,
		NAS:                        m.nasName,
		Share:                      req.Share,
		Roots:                      req.Roots,
		IncludeGlobs:               req.IncludeGlobs,
		ExcludeGlobs:               req.ExcludeGlobs,
		Mode:                       req.Mode,
		CutoffYears:                req.CutoffYears,
		ProtectNewerThan:           req.ProtectNewerThan,
		ForceArchive:               req.ForceArchive,
		Overlay:                    req.overlayEffective(),
		PruneEmptiedSourceDirs:     req.pruneEffective(),
		RemovePreexistingEmptyDirs: req.removePreexisting(),
		DirMtimes:                  map[string]string{},
	}
}

func (m *Manager) scopeRoots(job *MoveJob) []string {
	shareRoot := m.moveRootFor(job.Share)
	if len(job.Roots) == 0 {
		return []string{shareRoot}
	}
	out := make([]string, 0, len(job.Roots))
	for _, r := range job.Roots {
		out = append(out, filepath.Join(shareRoot, r))
	}
	return out
}

func (job *MoveJob) addPlannedDir(row ManifestEntry) {
	job.Planned++
	job.PlannedDirs++
	job.PlannedArtifactFiles += row.ArtifactFiles
	job.PlannedArtifactDirs += row.ArtifactDirs
}

func (m *Manager) releaseActive(id string) {
	m.mu.Lock()
	if m.activeID == id {
		m.activeID = ""
		m.cancel = nil
	}
	m.mu.Unlock()
}

func (m *Manager) finishMove(job *MoveJob, status MoveStatus, errMsg string) {
	job.Status = status
	if errMsg != "" {
		job.Error = errMsg
	}
	if MoveStatusTerminal(status) || status == MoveRolledBack {
		job.FinishedAt = time.Now().UTC().Format(time.RFC3339)
	}
	job.CurrentPath = ""
	if err := m.store.SaveMoveJob(job); err != nil {
		log.Printf("archive-move: save %s: %v", job.ID, err)
	}
}

func (m *Manager) writePreflight(job *MoveJob, gates map[string]string) {
	var b strings.Builder
	b.WriteString("{\n")
	first := true
	for k, v := range gates {
		if !first {
			b.WriteString(",\n")
		}
		first = false
		fmt.Fprintf(&b, "  %q: %q", k, v)
	}
	b.WriteString("\n}\n")
	_ = m.store.WriteMoveResult(job.ID, "preflight", []byte(b.String()))
}

func (m *Manager) writeMoveReports(job *MoveJob, entries []ManifestEntry) {
	var mv strings.Builder
	mv.WriteString("nas,share,planned,moved,verified,skipped,failed,bytes_moved,dirs_pruned\n")
	fmt.Fprintf(&mv, "%s,%s,%d,%d,%d,%d,%d,%d,%d\n",
		job.NAS, job.Share, job.Planned, job.Moved, job.Verified, job.Skipped, job.Failed, job.BytesMoved, job.DirsPruned)
	_ = m.store.WriteMoveResult(job.ID, "move-report", []byte(mv.String()))

	var verified, missing, mismatch int64
	for i := range entries {
		e := &entries[i]
		if e.Kind != KindFile {
			continue
		}
		switch {
		case e.Status == MStatusVerified:
			verified++
		case e.Status == MStatusMoved && strings.Contains(e.Detail, "inode"):
			mismatch++
		case e.Status == MStatusMoved && strings.Contains(e.Detail, "missing"):
			missing++
		}
	}
	var vr strings.Builder
	vr.WriteString("nas,share,verified,missing,identity_mismatch\n")
	fmt.Fprintf(&vr, "%s,%s,%d,%d,%d\n", job.NAS, job.Share, verified, missing, mismatch)
	_ = m.store.WriteMoveResult(job.ID, "verify-report", []byte(vr.String()))
}

func manifestEntryForFile(rel, src, dest string, id fileIdentity, reason string) ManifestEntry {
	entry := ManifestEntry{
		Kind:          KindFile,
		RelPath:       rel,
		SourceAbs:     src,
		DestAbs:       dest,
		Size:          id.size,
		Inode:         id.inode,
		DevID:         id.dev,
		Mtime:         id.mtime.UTC().Format(time.RFC3339Nano),
		Ctime:         id.ctime.UTC().Format(time.RFC3339Nano),
		PlannedReason: reason,
		Status:        MStatusPlanned,
	}
	if id.hasBt {
		entry.Btime = id.btime.UTC().Format(time.RFC3339Nano)
	}
	return entry
}

// identityMatches compares a post-rename file to its planned manifest identity.
// inode, size, mtime, and btime must match; ctime is expected to change.
func identityMatches(planned *ManifestEntry, got fileIdentity) (bool, string) {
	if got.inode != planned.Inode {
		return false, fmt.Sprintf("inode %d≠%d", got.inode, planned.Inode)
	}
	if got.size != planned.Size {
		return false, fmt.Sprintf("size %d≠%d", got.size, planned.Size)
	}
	if pm, err := time.Parse(time.RFC3339Nano, planned.Mtime); err == nil {
		if !got.mtime.UTC().Equal(pm.UTC()) {
			return false, "mtime changed"
		}
	}
	if planned.Btime != "" && got.hasBt {
		if pb, err := time.Parse(time.RFC3339Nano, planned.Btime); err == nil {
			if !got.btime.UTC().Equal(pb.UTC()) {
				return false, "btime changed"
			}
		}
	}
	return true, ""
}

// ensureDestParent creates the destination's parent directory chain, matching the
// source file's directory ownership/permissions on the immediate parent.
func ensureDestParent(srcFile, destFile string) error {
	destDir := filepath.Dir(destFile)
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return err
	}
	if uid, gid, mode, err := ownerMode(filepath.Dir(srcFile)); err == nil {
		_ = os.Chmod(destDir, mode)
		_ = os.Chown(destDir, int(uid), int(gid))
	}
	return nil
}

// captureDirMtimes records the original mtimes for the source file's containing
// directory and each ancestor inside the share. File renames update directory
// mtimes, so these plan-time values are the only reliable source for restoring
// Archive folder dates after execution.
func captureDirMtimes(job *MoveJob, shareRoot, dir string) {
	if job.DirMtimes == nil {
		job.DirMtimes = map[string]string{}
	}
	for pathWithin(dir, shareRoot) {
		rel, err := filepath.Rel(shareRoot, dir)
		if err != nil {
			return
		}
		key := filepath.ToSlash(rel)
		if key == "." {
			key = ""
		}
		if _, seen := job.DirMtimes[key]; !seen {
			if info, err := os.Lstat(dir); err == nil {
				job.DirMtimes[key] = info.ModTime().UTC().Format(time.RFC3339Nano)
			}
		}
		if dir == shareRoot {
			return
		}
		next := filepath.Dir(dir)
		if next == dir {
			return
		}
		dir = next
	}
}

// restoreArchiveDirMtimes applies captured source-directory mtimes to their
// corresponding Archive directories. Deepest-first is intentional: setting a
// child directory mtime must not be followed by file moves or child creation.
func restoreArchiveDirMtimes(job *MoveJob, archiveRoot string) {
	if len(job.DirMtimes) == 0 {
		return
	}
	dirs := make([]string, 0, len(job.DirMtimes))
	for rel := range job.DirMtimes {
		dirs = append(dirs, rel)
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	for _, rel := range dirs {
		raw := job.DirMtimes[rel]
		t, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			continue
		}
		dest := archiveRoot
		if rel != "" {
			dest = filepath.Join(archiveRoot, filepath.FromSlash(rel))
		}
		_ = os.Chtimes(dest, t, t)
	}
}

func relDirAncestors(relFile string) []string {
	rel := filepath.ToSlash(filepath.Dir(filepath.FromSlash(relFile)))
	if rel == "." || rel == "" {
		return nil
	}
	var out []string
	for rel != "." && rel != "" {
		out = append(out, rel)
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(rel)))
		if parent == rel {
			break
		}
		rel = parent
	}
	return out
}

func suspiciousFreshDateEvidence(path, shareRoot, rel string, id fileIdentity, cutoff int) string {
	var evidence []string
	if xmp := oldEmbeddedXMPDate(path, cutoff); xmp != "" {
		evidence = append(evidence, xmp)
	}
	if snap := oldSnapshotEvidence(path, shareRoot, rel, id, cutoff); snap != "" {
		evidence = append(evidence, snap)
	}
	return strings.Join(evidence, "; ")
}

func oldEmbeddedXMPDate(path string, cutoff int) string {
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".psd" && ext != ".psb" && ext != ".ai" && ext != ".pdf" {
		return ""
	}
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 3*1024*1024))
	if err != nil {
		return ""
	}
	matches := xmpDateRe.FindAllSubmatch(data, -1)
	if len(matches) == 0 {
		return ""
	}
	dates := map[string]string{}
	oldest := ""
	newest := time.Time{}
	for _, m := range matches {
		key := string(m[1])
		value := strings.TrimSpace(string(m[2]))
		if _, seen := dates[key]; !seen {
			dates[key] = value
		}
		t, ok := parseXMPTime(value)
		if !ok {
			continue
		}
		if oldest == "" || t.Before(mustParseXMP(oldest)) {
			oldest = value
		}
		if t.After(newest) {
			newest = t
		}
	}
	if newest.IsZero() || newest.Year() >= cutoff {
		return ""
	}
	parts := make([]string, 0, len(dates))
	for _, key := range []string{"ModifyDate", "MetadataDate", "CreateDate"} {
		if v := dates[key]; v != "" {
			parts = append(parts, key+"="+v)
		}
	}
	return "embedded_xmp_old(" + strings.Join(parts, ",") + ")"
}

func parseXMPTime(s string) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339, "2006:01:02 15:04:05", "2006-01-02T15:04:05-07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

func mustParseXMP(s string) time.Time {
	t, _ := parseXMPTime(s)
	return t
}

func oldSnapshotEvidence(path, shareRoot, rel string, id fileIdentity, cutoff int) string {
	for _, root := range snapshotRootsForShare(shareRoot) {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		checked := 0
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			checked++
			if checked > 300 {
				break
			}
			snapPath := filepath.Join(root, entry.Name(), filepath.FromSlash(rel))
			sid, err := identityOf(snapPath)
			if err != nil || sid.size != id.size || sid.mtime.Year() >= cutoff {
				continue
			}
			if sid.inode == id.inode && sid.dev == id.dev {
				return fmt.Sprintf("snapshot_old_same_inode(snapshot=%s,mtime=%s)", entry.Name(), sid.mtime.UTC().Format(time.RFC3339Nano))
			}
			if id.size <= suspiciousHashMaxBytes && sameSHA256(path, snapPath) {
				return fmt.Sprintf("snapshot_old_hash_match(snapshot=%s,mtime=%s)", entry.Name(), sid.mtime.UTC().Format(time.RFC3339Nano))
			}
		}
	}
	return ""
}

func snapshotRootsForShare(shareRoot string) []string {
	roots := []string{filepath.Join(shareRoot, "#snapshot")}
	share := filepath.Base(shareRoot)
	if share != "" && share != "." && share != string(os.PathSeparator) {
		roots = append(roots, filepath.Join("/volume1", share, "#snapshot"))
	}
	seen := map[string]bool{}
	out := roots[:0]
	for _, root := range roots {
		if !seen[root] {
			seen[root] = true
			out = append(out, root)
		}
	}
	return out
}

func sameSHA256(a, b string) bool {
	ha, err := sha256File(a)
	if err != nil {
		return false
	}
	hb, err := sha256File(b)
	if err != nil {
		return false
	}
	return ha == hb
}

func sha256File(path string) ([32]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return [32]byte{}, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return [32]byte{}, err
	}
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out, nil
}

// walkFiles invokes fn for every regular file under root, skipping excluded dirs
// (including Archive) and symlinks. Cancellation is checked between entries.
func walkFiles(ctx context.Context, root string, fn func(path string, d fs.DirEntry) error) error {
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if d.IsDir() {
			if path != root && ExcludedDirNames[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type()&fs.ModeSymlink != 0 || !d.Type().IsRegular() {
			return nil
		}
		return fn(path, d)
	})
}

func validateMoveRequest(req MovePlanRequest) error {
	if !IsAllowedShare(req.Share) {
		return fmt.Errorf("share %q is not in the allowlist", req.Share)
	}
	if req.Mode != ModeMove && req.Mode != ModeCleanEmptyDirs {
		return fmt.Errorf("mode must be %q or %q", ModeMove, ModeCleanEmptyDirs)
	}
	if req.Mode == ModeMove && req.ForceArchive && len(req.Roots) == 0 {
		return errors.New("force_archive requires at least one sub-folder root")
	}
	if req.Mode == ModeMove && len(req.CutoffYears) == 0 && !req.ForceArchive {
		return errors.New("cutoff_years is required for a move (it defines the archive boundary)")
	}
	return nil
}

func parseProtect(s string) (time.Time, bool) {
	if s == "" {
		return time.Time{}, false
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func maxInt(xs []int) int {
	m := 0
	for _, x := range xs {
		if x > m {
			m = x
		}
	}
	return m
}

// matchScope applies include/exclude globs to a share-relative path.
func matchScope(rel string, include, exclude []string) bool {
	for _, g := range exclude {
		if globMatch(g, rel) {
			return false
		}
	}
	if len(include) == 0 {
		return true
	}
	for _, g := range include {
		if globMatch(g, rel) {
			return true
		}
	}
	return false
}

func globMatch(glob, rel string) bool {
	if ok, _ := filepath.Match(glob, rel); ok {
		return true
	}
	if ok, _ := filepath.Match(glob, filepath.Base(rel)); ok {
		return true
	}
	return strings.HasPrefix(rel, strings.TrimSuffix(glob, "/")+string(os.PathSeparator))
}
