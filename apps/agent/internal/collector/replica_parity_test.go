package collector

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestExcludedName(t *testing.T) {
	for _, n := range []string{"@eaDir", "#recycle", "~ai-1_.tmp", "a.png~RF92f84088.TMP", "x.lnk", "._x", ".DS_Store", "~$doc.docx", "a.tmp$$"} {
		if !ExcludedName(n) {
			t.Errorf("%q should be excluded", n)
		}
	}
	for _, n := range []string{"Box Lunch Watch Wall Clock", "art.psd", "tmpfolder", "a.ai"} {
		if ExcludedName(n) {
			t.Errorf("%q should not be excluded", n)
		}
	}
}

func TestScanAndFindMissing(t *testing.T) {
	src := t.TempDir()
	dst := t.TempDir()
	mk := func(base, rel string, dir bool) {
		p := filepath.Join(base, rel)
		if dir {
			os.MkdirAll(p, 0o755)
		} else {
			os.MkdirAll(filepath.Dir(p), 0o755)
			os.WriteFile(p, []byte("x"), 0o644)
		}
	}
	// present on both
	mk(src, "mac/Decor/a.psd", false)
	mk(dst, "mac/Decor/a.psd", false)
	// missing folder with children on replica
	mk(src, "mac/Decor/2027/Watch Clock/_working files/m.psd", false)
	mk(dst, "mac/Decor/2027", true)
	// excluded temp file only on source
	mk(src, "mac/Decor/~ai-1_.tmp", false)
	mk(src, "mac/@eaDir/x/SYNOINDEX", false)

	entries, trunc, err := ScanRecent([]string{filepath.Join(src, "mac")}, time.Now().Add(-time.Hour), 1000)
	if err != nil || trunc {
		t.Fatalf("scan err=%v trunc=%v", err, trunc)
	}
	for _, e := range entries {
		if hasExcludedSegment(e.Path) {
			t.Fatalf("excluded path in manifest: %s", e.Path)
		}
	}
	// Nothing is older than a future cut-off → everything judged.
	miss := FindMissing(entries, dst, time.Now().Add(time.Minute))
	if len(miss) != 1 || miss[0] != filepath.Join("mac", "Decor", "2027", "Watch Clock") {
		t.Fatalf("unexpected missing: %v", miss)
	}
	// Grace: items newer than the cut-off are not judged.
	if got := FindMissing(entries, dst, time.Now().Add(-time.Hour)); len(got) != 0 {
		t.Fatalf("grace not applied: %v", got)
	}
}

func TestManifestEntryJSON(t *testing.T) {
	e := manifestEntry{Path: "mac/a b", Ctime: 42}
	b, _ := e.MarshalJSON()
	var back manifestEntry
	if err := back.UnmarshalJSON(b); err != nil || back != e {
		t.Fatalf("roundtrip %s -> %+v %v", b, back, err)
	}
}
