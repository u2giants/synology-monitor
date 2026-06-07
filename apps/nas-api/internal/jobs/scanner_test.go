package jobs

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeFileWithMtime creates a file with the given size and modified year.
func writeFileWithMtime(t *testing.T, path string, size int, year int) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, size), 0o644); err != nil {
		t.Fatal(err)
	}
	mt := time.Date(year, 6, 1, 12, 0, 0, 0, time.UTC)
	if err := os.Chtimes(path, mt, mt); err != nil {
		t.Fatal(err)
	}
}

func scanTree(t *testing.T, root string, opts scanOptions) *shareAgg {
	t.Helper()
	agg := newShareAgg("files")
	if err := walkShare(context.Background(), root, opts, agg, nil); err != nil {
		t.Fatalf("walkShare: %v", err)
	}
	return agg
}

func TestScannerYearAggregation(t *testing.T) {
	root := t.TempDir()
	writeFileWithMtime(t, filepath.Join(root, "a.txt"), 100, 2020)
	writeFileWithMtime(t, filepath.Join(root, "b.txt"), 200, 2020)
	writeFileWithMtime(t, filepath.Join(root, "sub", "c.txt"), 50, 2022)

	agg := scanTree(t, root, scanOptions{})
	if agg.byYear[2020].count != 2 || agg.byYear[2020].bytes != 300 {
		t.Errorf("2020: got count=%d bytes=%d, want 2/300", agg.byYear[2020].count, agg.byYear[2020].bytes)
	}
	if agg.byYear[2022].count != 1 || agg.byYear[2022].bytes != 50 {
		t.Errorf("2022: got count=%d bytes=%d, want 1/50", agg.byYear[2022].count, agg.byYear[2022].bytes)
	}
	if agg.filesScanned != 3 || agg.bytesScanned != 350 {
		t.Errorf("totals: got files=%d bytes=%d, want 3/350", agg.filesScanned, agg.bytesScanned)
	}
}

func TestScannerExcludesSystemDirs(t *testing.T) {
	root := t.TempDir()
	writeFileWithMtime(t, filepath.Join(root, "keep.txt"), 10, 2021)
	for _, ex := range []string{"@eaDir", "#snapshot", "@tmp", "Archive", ".SynologyWorkingDirectory"} {
		writeFileWithMtime(t, filepath.Join(root, ex, "ignored.txt"), 999, 2021)
	}
	agg := scanTree(t, root, scanOptions{})
	if agg.filesScanned != 1 {
		t.Errorf("got %d files scanned, want 1 (only keep.txt)", agg.filesScanned)
	}
	if agg.bytesScanned != 10 {
		t.Errorf("got %d bytes, want 10 (excluded dirs must not be counted)", agg.bytesScanned)
	}
}

func TestScannerSkipsSymlinks(t *testing.T) {
	root := t.TempDir()
	writeFileWithMtime(t, filepath.Join(root, "real.txt"), 10, 2021)
	// A symlink that points back at the root would cause an infinite walk if
	// followed; assert it is neither followed nor stat-ed as a file.
	if err := os.Symlink(root, filepath.Join(root, "loop")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	if err := os.Symlink(filepath.Join(root, "real.txt"), filepath.Join(root, "alias.txt")); err != nil {
		t.Skipf("symlink unsupported: %v", err)
	}
	agg := scanTree(t, root, scanOptions{})
	if agg.filesScanned != 1 {
		t.Errorf("got %d files, want 1 (symlinks must not be counted/followed)", agg.filesScanned)
	}
}

func TestScannerEmptyDirCounting(t *testing.T) {
	root := t.TempDir()
	// root/ (has subdirs) ; root/full (has a file) ; root/empty (truly empty) ;
	// root/onlysys (only @eaDir, which is excluded → counts as empty)
	writeFileWithMtime(t, filepath.Join(root, "full", "f.txt"), 1, 2021)
	if err := os.MkdirAll(filepath.Join(root, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFileWithMtime(t, filepath.Join(root, "onlysys", "@eaDir", "x"), 1, 2021)

	agg := scanTree(t, root, scanOptions{})
	// Registered dirs: root, full, empty, onlysys (NOT @eaDir — excluded).
	if got := agg.totalDirs(); got != 4 {
		t.Errorf("total_dirs = %d, want 4", got)
	}
	// Empty: "empty" (nothing) and "onlysys" (only an excluded child).
	if got := agg.emptyDirs(); got != 2 {
		t.Errorf("empty_dirs = %d, want 2 (empty + onlysys)", got)
	}
}

func TestScannerCancellation(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 50; i++ {
		writeFileWithMtime(t, filepath.Join(root, "f", string(rune('a'+i%26))+strings.Repeat("x", i)), 1, 2021)
	}
	ctx, cancel := context.WithCancel(context.Background())
	agg := newShareAgg("files")
	// Cancel after the first progress checkpoint fires.
	opts := scanOptions{sleepEveryFiles: 1}
	err := walkShare(ctx, root, opts, agg, func() { cancel() })
	if err == nil {
		t.Fatal("expected a cancellation error, got nil")
	}
	if ctx.Err() == nil {
		t.Fatal("context should be cancelled")
	}
}

func TestProtectedByNewest(t *testing.T) {
	protect := time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	old := time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)
	recent := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	cases := []struct {
		name                  string
		mtime, ctime, btime   time.Time
		hasBtime              bool
		want                  bool
	}{
		{"all old → candidate", old, old, old, true, false},
		{"mtime recent triggers", recent, old, old, true, true},
		{"ctime recent triggers", old, recent, old, true, true},
		{"btime recent triggers", old, old, recent, true, true},
		{"btime recent but unavailable → not counted", old, old, recent, false, false},
		{"exactly on the boundary protects", protect, old, old, true, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := protectedByNewest(c.mtime, c.ctime, c.btime, c.hasBtime, protect); got != c.want {
				t.Errorf("protectedByNewest = %v, want %v", got, c.want)
			}
		})
	}
}

func TestCutoffCSVCandidatesVsProtected(t *testing.T) {
	// Two files in 2020 (older than 2021 cutoff); mark one protected.
	a := newShareAgg("files")
	stat(a.byYear, 2020).add(100)
	stat(a.byYear, 2020).add(200) // total 2 files / 300 bytes
	stat(a.protectedByYear, 2020).add(200)
	stat(a.byYear, 2023).add(500) // newer than cutoff → never a candidate

	csv := string(buildCutoffCSV("edgesynology1", []*shareAgg{a}, []int{2021}))
	want := "edgesynology1,files,older_than_2021,1,100,0.00,1,200"
	if !strings.Contains(csv, want) {
		t.Errorf("cutoff csv missing %q\ngot:\n%s", want, csv)
	}
}

func TestYearlyCSVSchema(t *testing.T) {
	a := newShareAgg("files")
	stat(a.byYear, 2020).add(1073741824) // exactly 1 GiB
	csv := string(buildYearlyCSV("edgesynology1", []*shareAgg{a}))
	if !strings.HasPrefix(csv, "nas,share,year,file_count,total_bytes,total_gib\n") {
		t.Errorf("bad header: %q", strings.SplitN(csv, "\n", 2)[0])
	}
	if !strings.Contains(csv, "edgesynology1,files,2020,1,1073741824,1.00") {
		t.Errorf("bad yearly row:\n%s", csv)
	}
}
