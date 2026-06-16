package jobs

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// stubFS is a unit-test fsOps: it claims a single subvolume and makes snapshot
// operations no-ops, so the rename/stat identity logic is exercised for real on
// the temp filesystem without requiring Btrfs or CAP_SYS_ADMIN.
type stubFS struct{}

func (stubFS) subvolID(string) (uint64, error)              { return 256, nil }
func (stubFS) createROSnapshot(_, _ string) (uint64, error) { return 999, nil }
func (stubFS) deleteSnapshot(string) error                  { return nil }
func (stubFS) snapshotSupported(string) error               { return nil }

func newMoveManager(t *testing.T, shareRoot string) *Manager {
	t.Helper()
	m := New(NewStore(t.TempDir()), "edgesynology1")
	if !m.store.Ready() {
		t.Fatal("store not ready")
	}
	m.moveRootFor = func(string) string { return shareRoot }
	m.fs = stubFS{}
	return m
}

func setMtimeYear(t *testing.T, path string, year int) {
	t.Helper()
	tm := time.Date(year, 6, 1, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, tm, tm); err != nil {
		t.Fatal(err)
	}
}

func setMtime(t *testing.T, path string, tm time.Time) {
	t.Helper()
	if err := os.Chtimes(path, tm, tm); err != nil {
		t.Fatal(err)
	}
}

// shareDir returns a nested share root inside a temp dir, so the move's snapshot
// parent (a sibling of the share root) is cleaned up with the temp dir.
func shareDir(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "share")
	mkdir(t, root)
	return root
}

// buildShareTree creates files across years and returns the share root.
func buildShareTree(t *testing.T) string {
	t.Helper()
	root := shareDir(t)
	touch(t, filepath.Join(root, "old", "a.txt"))
	touch(t, filepath.Join(root, "old", "b.txt"))
	touch(t, filepath.Join(root, "mixed", "old.txt"))
	touch(t, filepath.Join(root, "mixed", "new.txt"))
	touch(t, filepath.Join(root, "fresh", "c.txt"))
	setMtimeYear(t, filepath.Join(root, "old", "a.txt"), 2020)
	setMtimeYear(t, filepath.Join(root, "old", "b.txt"), 2020)
	setMtimeYear(t, filepath.Join(root, "mixed", "old.txt"), 2020)
	setMtimeYear(t, filepath.Join(root, "mixed", "new.txt"), 2024)
	setMtimeYear(t, filepath.Join(root, "fresh", "c.txt"), 2024)
	return root
}

func waitMove(t *testing.T, m *Manager, id string, ok func(*MoveJob) bool) *MoveJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		j, err := m.MoveGet(id)
		if err == nil && ok(j) {
			return j
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("move %s never reached the expected state", id)
	return nil
}

func planAndWait(t *testing.T, m *Manager, req MovePlanRequest) *MoveJob {
	t.Helper()
	job, err := m.PlanMove(req)
	if err != nil {
		t.Fatalf("PlanMove: %v", err)
	}
	return waitMove(t, m, job.ID, func(j *MoveJob) bool {
		return j.Status == MovePlanned || MoveStatusTerminal(j.Status)
	})
}

func executeAndWait(t *testing.T, m *Manager, id string) *MoveJob {
	t.Helper()
	// runPlan releases the active slot just after flipping to "planned"; retry on
	// the brief ErrBusy window.
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, err := m.ExecuteMove(id)
		if err == nil {
			break
		}
		if errors.Is(err, ErrBusy) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		t.Fatalf("ExecuteMove: %v", err)
	}
	return waitMove(t, m, id, func(j *MoveJob) bool { return MoveStatusTerminal(j.Status) })
}

func moveReq(share string) MovePlanRequest {
	return MovePlanRequest{Share: share, Mode: ModeMove, CutoffYears: []int{2022}}
}

func TestMovePlanManifestAndCollision(t *testing.T) {
	root := buildShareTree(t)
	// Pre-create a collision for old/a.txt.
	touch(t, filepath.Join(root, "Archive", "old", "a.txt"))

	m := newMoveManager(t, root)
	job := planAndWait(t, m, moveReq("files"))
	if job.Status != MovePlanned {
		t.Fatalf("status = %s, want planned", job.Status)
	}
	// Candidates older than 2022: old/a (collision→skipped), old/b, mixed/old = 2 planned + 1 skipped.
	if job.Planned != 2 || job.Skipped != 1 {
		t.Errorf("planned=%d skipped=%d, want 2/1", job.Planned, job.Skipped)
	}
	entries, err := readManifest(job.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var sawCollision, sawDestMap bool
	for _, e := range entries {
		if e.RelPath == filepath.Join("old", "a.txt") && e.Status == MStatusSkipped && e.Detail == "collision" {
			sawCollision = true
		}
		if e.RelPath == filepath.Join("old", "b.txt") {
			wantDest := filepath.Join(root, "Archive", "old", "b.txt")
			if e.DestAbs != wantDest {
				t.Errorf("dest = %s, want %s", e.DestAbs, wantDest)
			}
			if e.Mtime == "" || e.Inode == 0 {
				t.Error("manifest must capture mtime and inode")
			}
			sawDestMap = true
		}
	}
	if !sawCollision || !sawDestMap {
		t.Errorf("missing collision row (%v) or dest mapping (%v)", sawCollision, sawDestMap)
	}
}

func TestMovePlanIncludesNestedArchiveNamedSourceDir(t *testing.T) {
	root := shareDir(t)
	nested := filepath.Join(root, "Projects", "ClientA", "Archive")
	touch(t, filepath.Join(nested, "old.ai"))
	setMtimeYear(t, filepath.Join(nested, "old.ai"), 2020)
	touch(t, filepath.Join(root, "Archive", "already-moved.ai"))
	setMtimeYear(t, filepath.Join(root, "Archive", "already-moved.ai"), 2020)

	m := newMoveManager(t, root)
	job := planAndWait(t, m, moveReq("files"))
	if job.Status != MovePlanned {
		t.Fatalf("status = %s, want planned", job.Status)
	}
	if job.Planned != 1 {
		t.Fatalf("planned=%d, want 1", job.Planned)
	}
	entries, err := readManifest(job.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("manifest entries=%d, want 1", len(entries))
	}
	wantRel := filepath.Join("Projects", "ClientA", "Archive", "old.ai")
	if entries[0].RelPath != wantRel || entries[0].Status != MStatusPlanned {
		t.Fatalf("entry = %#v, want planned %s", entries[0], wantRel)
	}
	wantDest := filepath.Join(root, "Archive", "Projects", "ClientA", "Archive", "old.ai")
	if entries[0].DestAbs != wantDest {
		t.Fatalf("dest = %s, want %s", entries[0].DestAbs, wantDest)
	}
}

func TestMoveExecuteVerifyAndPrune(t *testing.T) {
	root := buildShareTree(t)
	m := newMoveManager(t, root)

	plan := planAndWait(t, m, moveReq("files"))
	if plan.Planned != 3 { // old/a, old/b, mixed/old
		t.Fatalf("planned = %d, want 3", plan.Planned)
	}
	// capture an inode to confirm identity preservation across the move
	srcInode, _ := identityOf(filepath.Join(root, "old", "a.txt"))

	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("status = %s (err=%s), want complete", done.Status, done.Error)
	}
	if done.Moved != 3 || done.Verified != 3 {
		t.Errorf("moved=%d verified=%d, want 3/3", done.Moved, done.Verified)
	}
	// Files relocated under Archive, identity preserved.
	dstA := filepath.Join(root, "Archive", "old", "a.txt")
	gotA, err := identityOf(dstA)
	if err != nil {
		t.Fatalf("moved file missing: %v", err)
	}
	if gotA.inode != srcInode.inode {
		t.Errorf("inode not preserved: %d != %d", gotA.inode, srcInode.inode)
	}
	if _, err := os.Stat(filepath.Join(root, "old", "a.txt")); !os.IsNotExist(err) {
		t.Error("source path should be gone after move")
	}
	// "old" emptied by the move → pruned; "mixed" still holds new.txt → kept.
	if _, err := os.Stat(filepath.Join(root, "old")); !os.IsNotExist(err) {
		t.Error("emptied 'old' dir should be pruned")
	}
	if _, err := os.Stat(filepath.Join(root, "mixed", "new.txt")); err != nil {
		t.Error("mixed dir with a remaining file must be left intact")
	}
	if done.DirsPruned < 1 {
		t.Errorf("dirs_pruned=%d, want >=1", done.DirsPruned)
	}
}

func TestMoveRestoresArchiveDirectoryMtimes(t *testing.T) {
	root := shareDir(t)
	projectDir := filepath.Join(root, "Projects")
	clientDir := filepath.Join(projectDir, "ClientA")
	touch(t, filepath.Join(clientDir, "old.txt"))
	setMtimeYear(t, filepath.Join(clientDir, "old.txt"), 2020)
	projectMtime := time.Date(2017, 3, 4, 5, 6, 7, 0, time.UTC)
	clientMtime := time.Date(2018, 4, 5, 6, 7, 8, 0, time.UTC)
	setMtime(t, clientDir, clientMtime)
	setMtime(t, projectDir, projectMtime)

	m := newMoveManager(t, root)
	plan := planAndWait(t, m, moveReq("files"))
	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("status = %s (err=%s), want complete", done.Status, done.Error)
	}

	gotProject, err := os.Stat(filepath.Join(root, "Archive", "Projects"))
	if err != nil {
		t.Fatal(err)
	}
	gotClient, err := os.Stat(filepath.Join(root, "Archive", "Projects", "ClientA"))
	if err != nil {
		t.Fatal(err)
	}
	if !gotProject.ModTime().Equal(projectMtime) {
		t.Fatalf("Archive/Projects mtime = %s, want %s", gotProject.ModTime(), projectMtime)
	}
	if !gotClient.ModTime().Equal(clientMtime) {
		t.Fatalf("Archive/Projects/ClientA mtime = %s, want %s", gotClient.ModTime(), clientMtime)
	}
}

func TestMoveRestoresRemainingSourceDirectoryMtimes(t *testing.T) {
	root := shareDir(t)
	projectDir := filepath.Join(root, "Projects")
	clientDir := filepath.Join(projectDir, "ClientA")
	touch(t, filepath.Join(clientDir, "old.txt"))
	touch(t, filepath.Join(clientDir, "new.txt"))
	setMtimeYear(t, filepath.Join(clientDir, "old.txt"), 2020)
	setMtimeYear(t, filepath.Join(clientDir, "new.txt"), 2024)
	projectMtime := time.Date(2017, 3, 4, 5, 6, 7, 0, time.UTC)
	clientMtime := time.Date(2018, 4, 5, 6, 7, 8, 0, time.UTC)
	setMtime(t, clientDir, clientMtime)
	setMtime(t, projectDir, projectMtime)

	m := newMoveManager(t, root)
	plan := planAndWait(t, m, moveReq("files"))
	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("status = %s (err=%s), want complete", done.Status, done.Error)
	}

	if _, err := os.Stat(filepath.Join(clientDir, "new.txt")); err != nil {
		t.Fatal(err)
	}
	gotProject, err := os.Stat(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	gotClient, err := os.Stat(clientDir)
	if err != nil {
		t.Fatal(err)
	}
	if !gotProject.ModTime().Equal(projectMtime) {
		t.Fatalf("Projects mtime = %s, want %s", gotProject.ModTime(), projectMtime)
	}
	if !gotClient.ModTime().Equal(clientMtime) {
		t.Fatalf("Projects/ClientA mtime = %s, want %s", gotClient.ModTime(), clientMtime)
	}
}

func TestRepairDirMtimesFromSnapshot(t *testing.T) {
	root := shareDir(t)
	clientDir := filepath.Join(root, "Projects", "ClientA")
	touch(t, filepath.Join(clientDir, "old.txt"))
	setMtimeYear(t, filepath.Join(clientDir, "old.txt"), 2020)
	snapshotMtime := time.Date(2016, 2, 3, 4, 5, 6, 0, time.UTC)

	m := newMoveManager(t, root)
	plan := planAndWait(t, m, moveReq("files"))
	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("status = %s (err=%s), want complete", done.Status, done.Error)
	}

	snapshotDir := filepath.Join(done.SnapshotPath, "Projects", "ClientA")
	mkdir(t, snapshotDir)
	setMtime(t, snapshotDir, snapshotMtime)
	archiveDir := filepath.Join(root, "Archive", "Projects", "ClientA")
	dirtyMtime := time.Date(2026, 6, 15, 1, 2, 3, 0, time.UTC)
	setMtime(t, archiveDir, dirtyMtime)

	_, report, err := m.RepairDirMtimesFromSnapshot(plan.ID)
	if err != nil {
		t.Fatalf("RepairDirMtimesFromSnapshot: %v", err)
	}
	if !strings.Contains(string(report), "restored") {
		t.Fatalf("repair report missing restored row:\n%s", report)
	}
	got, err := os.Stat(archiveDir)
	if err != nil {
		t.Fatal(err)
	}
	if !got.ModTime().Equal(snapshotMtime) {
		t.Fatalf("archive dir mtime = %s, want %s", got.ModTime(), snapshotMtime)
	}
}

func TestMoveWholeRunRollback(t *testing.T) {
	root := buildShareTree(t)
	m := newMoveManager(t, root)
	plan := planAndWait(t, m, moveReq("files"))
	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("execute status = %s", done.Status)
	}

	if _, err := m.RollbackMove(plan.ID); err != nil {
		t.Fatalf("RollbackMove: %v", err)
	}
	rb := waitMove(t, m, plan.ID, func(j *MoveJob) bool { return j.Status == MoveRolledBack })
	if rb.Status != MoveRolledBack {
		t.Fatalf("status = %s, want rolled_back", rb.Status)
	}
	// Every file back at its original path; the recreated 'old' dir exists; the
	// Archive tree is emptied/removed.
	for _, p := range []string{"old/a.txt", "old/b.txt", "mixed/old.txt"} {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(p))); err != nil {
			t.Errorf("rollback did not restore %s: %v", p, err)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "Archive", "old", "a.txt")); !os.IsNotExist(err) {
		t.Error("file should no longer be under Archive after rollback")
	}
}

func TestMoveCleanEmptyDirs(t *testing.T) {
	root := shareDir(t)
	mkdir(t, filepath.Join(root, "empty1"))
	mkdir(t, filepath.Join(root, "nest", "deep")) // both empty
	touch(t, filepath.Join(root, "keep", "f.txt"))
	m := newMoveManager(t, root)

	plan := planAndWait(t, m, MovePlanRequest{Share: "files", Mode: ModeCleanEmptyDirs})
	if plan.Planned < 3 { // empty1, nest, nest/deep
		t.Fatalf("planned dirs = %d, want >=3", plan.Planned)
	}
	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("status = %s (err %s)", done.Status, done.Error)
	}
	if done.Moved != 0 {
		t.Errorf("clean_empty_dirs must move zero files, moved=%d", done.Moved)
	}
	if _, err := os.Stat(filepath.Join(root, "empty1")); !os.IsNotExist(err) {
		t.Error("empty1 should be removed")
	}
	if _, err := os.Stat(filepath.Join(root, "keep", "f.txt")); err != nil {
		t.Error("keep/ must be untouched")
	}
}

func TestMovePlanIncludesPreexistingEmptyDirs(t *testing.T) {
	root := shareDir(t)
	mkdir(t, filepath.Join(root, "Decor", "Generic Decor", "Polygon Animals", "Sarbani"))
	keep := filepath.Join(root, "Decor", "Generic Decor", "Keep", "file.txt")
	touch(t, keep)
	removePreexisting := true
	m := newMoveManager(t, root)

	plan := planAndWait(t, m, MovePlanRequest{
		Share:                      "files",
		Mode:                       ModeMove,
		Roots:                      []string{"Decor/Generic Decor/Polygon Animals"},
		CutoffYears:                []int{2021},
		RemovePreexistingEmptyDirs: &removePreexisting,
	})
	if plan.Status != MovePlanned {
		t.Fatalf("status = %s, want planned", plan.Status)
	}
	if plan.Planned != 2 {
		t.Fatalf("planned = %d, want 2 empty dirs", plan.Planned)
	}
	if plan.PlannedDirs != 2 {
		t.Fatalf("planned_dirs = %d, want 2", plan.PlannedDirs)
	}
	if plan.PlannedArtifactFiles != 0 || plan.PlannedArtifactDirs != 0 {
		t.Fatalf("planned artifacts = files:%d dirs:%d, want 0/0", plan.PlannedArtifactFiles, plan.PlannedArtifactDirs)
	}
	entries, err := readManifest(plan.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Kind != KindDir || e.RemovedReason != ReasonPreexistingEmpty {
			t.Fatalf("entry = %#v, want preexisting empty dir row", e)
		}
	}

	done := executeAndWait(t, m, plan.ID)
	if done.Status != MoveComplete {
		t.Fatalf("status = %s (err %s), want complete", done.Status, done.Error)
	}
	if done.DirsPruned != 2 {
		t.Fatalf("dirs_pruned = %d, want 2", done.DirsPruned)
	}
	if _, err := os.Stat(filepath.Join(root, "Decor", "Generic Decor", "Polygon Animals")); !os.IsNotExist(err) {
		t.Error("empty selected scope should be removed")
	}
	if _, err := os.Stat(keep); err != nil {
		t.Error("non-empty sibling must be untouched")
	}
}

func TestMovePlanForceArchiveIgnoresFileModifiedYear(t *testing.T) {
	root := shareDir(t)
	f := filepath.Join(root, "Decor", "Generic Decor", "Polygon Animals", "new-date.txt")
	touch(t, f)
	setMtimeYear(t, f, 2026)
	m := newMoveManager(t, root)

	ordinary := planAndWait(t, m, MovePlanRequest{
		Share:       "files",
		Mode:        ModeMove,
		Roots:       []string{"Decor/Generic Decor/Polygon Animals"},
		CutoffYears: []int{2022},
	})
	if ordinary.Planned != 0 {
		t.Fatalf("ordinary planned = %d, want 0", ordinary.Planned)
	}

	forced := planAndWait(t, m, MovePlanRequest{
		Share:        "files",
		Mode:         ModeMove,
		Roots:        []string{"Decor/Generic Decor/Polygon Animals"},
		CutoffYears:  []int{2022},
		ForceArchive: true,
	})
	if forced.Status != MovePlanned {
		t.Fatalf("status = %s, want planned", forced.Status)
	}
	if forced.Planned != 1 {
		t.Fatalf("forced planned = %d, want 1", forced.Planned)
	}
	entries, err := readManifest(forced.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].PlannedReason != ReasonForceArchive {
		t.Fatalf("manifest = %#v, want one force_archive row", entries)
	}
}

func TestMovePlanFlagsSuspiciousFreshDateFromEmbeddedXMP(t *testing.T) {
	root := shareDir(t)
	f := filepath.Join(root, "Art", "false-fresh.psd")
	xmp := `8BPS
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF>
    <rdf:Description>
      <xmp:CreateDate>2020-04-08T12:48:39-04:00</xmp:CreateDate>
      <xmp:MetadataDate>2020-04-08T15:29:05-04:00</xmp:MetadataDate>
      <xmp:ModifyDate>2020-04-08T15:29:05-04:00</xmp:ModifyDate>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>`
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f, []byte(xmp), 0o644); err != nil {
		t.Fatal(err)
	}
	setMtimeYear(t, f, 2026)
	m := newMoveManager(t, root)

	plan := planAndWait(t, m, moveReq("files"))
	entries, err := readManifest(plan.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Planned != 0 || plan.Skipped != 1 {
		t.Fatalf("planned=%d skipped=%d, want 0/1", plan.Planned, plan.Skipped)
	}
	if len(entries) != 1 || entries[0].PlannedReason != ReasonSuspiciousFreshDate || !strings.Contains(entries[0].Detail, "embedded_xmp_old") {
		t.Fatalf("manifest = %#v, want suspicious embedded XMP row", entries)
	}
}

func TestMovePlanFlagsSuspiciousFreshDateFromSnapshot(t *testing.T) {
	root := shareDir(t)
	rel := filepath.Join("Art", "false-fresh.bin")
	f := filepath.Join(root, rel)
	touch(t, f)
	if err := os.WriteFile(f, []byte("same-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	setMtimeYear(t, f, 2026)
	snap := filepath.Join(root, "#snapshot", "GMT-05-2026.01.30-20.00.01", rel)
	if err := os.MkdirAll(filepath.Dir(snap), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(snap, []byte("same-content"), 0o644); err != nil {
		t.Fatal(err)
	}
	setMtimeYear(t, snap, 2020)
	m := newMoveManager(t, root)

	plan := planAndWait(t, m, moveReq("files"))
	entries, err := readManifest(plan.ManifestPath)
	if err != nil {
		t.Fatal(err)
	}
	if plan.Planned != 0 || plan.Skipped != 1 {
		t.Fatalf("planned=%d skipped=%d, want 0/1", plan.Planned, plan.Skipped)
	}
	if len(entries) != 1 || entries[0].PlannedReason != ReasonSuspiciousFreshDate || !strings.Contains(entries[0].Detail, "snapshot_old_hash_match") {
		t.Fatalf("manifest = %#v, want suspicious snapshot hash row", entries)
	}
}

func TestMovePlanForceArchiveRequiresScopedRoot(t *testing.T) {
	root := shareDir(t)
	touch(t, filepath.Join(root, "new-date.txt"))
	m := newMoveManager(t, root)

	_, err := m.PlanMove(MovePlanRequest{
		Share:        "files",
		Mode:         ModeMove,
		ForceArchive: true,
	})
	if err == nil {
		t.Fatal("PlanMove succeeded, want force_archive scope error")
	}
}

func TestMoveCancelMidRunResumable(t *testing.T) {
	// A large tree so cancel can land mid-run; cutoff makes all of them candidates.
	root := shareDir(t)
	for i := 0; i < 60; i++ {
		p := filepath.Join(root, "d", "f"+itoa(i)+".txt")
		touch(t, p)
		setMtimeYear(t, p, 2020)
	}
	m := newMoveManager(t, root)
	plan := planAndWait(t, m, moveReq("files"))

	job, err := m.ExecuteMove(plan.ID)
	for errors.Is(err, ErrBusy) {
		time.Sleep(10 * time.Millisecond)
		job, err = m.ExecuteMove(plan.ID)
	}
	if err != nil {
		t.Fatalf("ExecuteMove: %v", err)
	}
	// Cancel almost immediately.
	_ = m.CancelMove(job.ID)
	cancelled := waitMove(t, m, plan.ID, func(j *MoveJob) bool { return MoveStatusTerminal(j.Status) })
	if cancelled.Status != MoveCancelled && cancelled.Status != MoveComplete {
		t.Fatalf("status = %s, want cancelled or complete", cancelled.Status)
	}

	// Resume completes the rest (idempotent on already-moved files).
	if cancelled.Status == MoveCancelled {
		done := executeAndWait(t, m, plan.ID)
		if done.Status != MoveComplete {
			t.Fatalf("resume status = %s", done.Status)
		}
		// Every candidate now lives under Archive.
		entries, _ := readManifest(done.ManifestPath)
		for _, e := range entries {
			if e.Kind == KindFile && e.Status != MStatusVerified && e.Status != MStatusMoved {
				t.Errorf("file %s left in status %s after resume", e.RelPath, e.Status)
			}
		}
	}
}

func TestIdentityMatches(t *testing.T) {
	planned := &ManifestEntry{Inode: 42, Size: 100, Mtime: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)}
	good := fileIdentity{inode: 42, size: 100, mtime: time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)}
	if ok, d := identityMatches(planned, good); !ok {
		t.Errorf("expected match, got %s", d)
	}
	bad := fileIdentity{inode: 99, size: 100, mtime: good.mtime}
	if ok, _ := identityMatches(planned, bad); ok {
		t.Error("inode mismatch should fail")
	}
	badSize := fileIdentity{inode: 42, size: 7, mtime: good.mtime}
	if ok, _ := identityMatches(planned, badSize); ok {
		t.Error("size mismatch should fail")
	}
}

func TestMoveBusyLock(t *testing.T) {
	root := buildShareTree(t)
	m := newMoveManager(t, root)
	// Hold the slot with an inventory job by faking activeID.
	m.mu.Lock()
	m.activeID = "inv_dummy"
	m.mu.Unlock()
	if _, err := m.PlanMove(moveReq("files")); !errors.Is(err, ErrBusy) {
		t.Errorf("PlanMove while busy = %v, want ErrBusy", err)
	}
}

// itoa avoids importing strconv just for the test loop labels.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
