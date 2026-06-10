package jobs

import (
	"os"
	"path/filepath"
	"testing"
)

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o755); err != nil {
		t.Fatal(err)
	}
}

func touch(t *testing.T, path string) {
	t.Helper()
	mkdir(t, filepath.Dir(path))
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestIsPrunableEmpty(t *testing.T) {
	root := t.TempDir()

	mkdir(t, filepath.Join(root, "truly_empty"))

	mkdir(t, filepath.Join(root, "artifacts_only", "@eaDir"))
	touch(t, filepath.Join(root, "artifacts_only", ".DS_Store"))

	touch(t, filepath.Join(root, "has_file", "real.txt"))

	mkdir(t, filepath.Join(root, "has_empty_subdir", "sub"))

	touch(t, filepath.Join(root, "has_full_subdir", "sub", "real.txt"))

	cases := map[string]bool{
		"truly_empty":      true,
		"artifacts_only":   true,  // only Synology artifacts → counts as empty
		"has_file":         false, // a real file keeps it alive
		"has_empty_subdir": true,  // an empty subdir does not keep it alive
		"has_full_subdir":  false, // a non-empty subdir keeps it alive
	}
	for name, want := range cases {
		got, err := isPrunableEmpty(filepath.Join(root, name))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != want {
			t.Errorf("isPrunableEmpty(%s) = %v, want %v", name, got, want)
		}
	}
}

func TestListPrunableEmptyDirsBottomUp(t *testing.T) {
	root := t.TempDir()
	mkdir(t, filepath.Join(root, "a", "b", "c")) // nested empties
	touch(t, filepath.Join(root, "keep", "f.txt"))

	dirs, err := listPrunableEmptyDirs(root)
	if err != nil {
		t.Fatal(err)
	}
	// Deepest-first ordering: a/b/c must come before a/b before a.
	idx := map[string]int{}
	for i, d := range dirs {
		idx[d] = i
	}
	abc := filepath.Join(root, "a", "b", "c")
	ab := filepath.Join(root, "a", "b")
	if idx[abc] > idx[ab] {
		t.Errorf("expected %s before %s (bottom-up)", abc, ab)
	}
	if _, ok := idx[filepath.Join(root, "keep")]; ok {
		t.Error("keep/ has a file and must not be listed as prunable-empty")
	}
}

func TestDirRowForCountsImmediateArtifacts(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "empty")
	mkdir(t, filepath.Join(dir, "@eaDir", "nested"))
	touch(t, filepath.Join(dir, "@eaDir", "thumb.jpg"))
	touch(t, filepath.Join(dir, "@eaDir", "nested", "thumb2.jpg"))
	touch(t, filepath.Join(dir, ".DS_Store"))
	touch(t, filepath.Join(dir, "Thumbs.db"))
	mkdir(t, filepath.Join(dir, "child"))
	touch(t, filepath.Join(dir, "child", ".DS_Store"))

	row, err := dirRowFor(dir, ReasonPreexistingEmpty)
	if err != nil {
		t.Fatal(err)
	}
	if row.ArtifactDirs != 1 {
		t.Fatalf("artifact_dirs = %d, want 1", row.ArtifactDirs)
	}
	if row.ArtifactFiles != 4 {
		t.Fatalf("artifact_files = %d, want 4", row.ArtifactFiles)
	}
}

func TestPruneAndRecreateDir(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "gone")
	mkdir(t, filepath.Join(dir, "@eaDir")) // artifact-only → prunable

	row, err := dirRowFor(dir, ReasonEmptiedByMove)
	if err != nil {
		t.Fatal(err)
	}
	if err := pruneEmptyDir(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("dir should be gone after prune")
	}
	if err := recreateDir(row); err != nil {
		t.Fatal(err)
	}
	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		t.Fatal("dir should be recreated by rollback")
	}
}
