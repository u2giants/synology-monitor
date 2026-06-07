package jobs

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// yearStat accumulates file count and bytes for one (share, year).
type yearStat struct {
	count int64
	bytes int64
}

func (y *yearStat) add(bytes int64) {
	y.count++
	y.bytes += bytes
}

// shareAgg holds per-share aggregation state built during the walk.
type shareAgg struct {
	share string

	byYear          map[int]*yearStat // all regular files
	protectedByYear map[int]*yearStat // subset whose newest timestamp >= protect date

	// dirChildCount registers every descended directory (key) and counts its
	// non-excluded child entries (value). total_dirs = len; empty_dirs = #(value==0).
	dirChildCount map[string]int

	filesScanned  int64
	bytesScanned  int64
	btimeFallback bool // true if any file fell back to max(mtime,ctime) for protection
}

func newShareAgg(share string) *shareAgg {
	return &shareAgg{
		share:           share,
		byYear:          map[int]*yearStat{},
		protectedByYear: map[int]*yearStat{},
		dirChildCount:   map[string]int{},
	}
}

func (a *shareAgg) totalDirs() int64 { return int64(len(a.dirChildCount)) }

func (a *shareAgg) emptyDirs() int64 {
	var n int64
	for _, c := range a.dirChildCount {
		if c == 0 {
			n++
		}
	}
	return n
}

// scanOptions are the resolved (defaulted) scan parameters.
type scanOptions struct {
	protectNewerThan time.Time
	protectSet       bool
	sleepEveryFiles  int
	sleepMs          int
	maxFilesPerSec   int // 0 = unlimited
}

// walkShare walks a single share root read-only, filling agg. onProgress is
// invoked every sleepEveryFiles files (after a cancellation check) so the caller
// can persist progress and apply throttling. It returns ctx.Err() if cancelled.
//
// Symlinks are never followed or stat-ed (avoids @eaDir / snapshot link traps).
// Unreadable entries are skipped rather than aborting the whole walk.
func walkShare(ctx context.Context, root string, opts scanOptions, agg *shareAgg, onProgress func()) error {
	start := time.Now()
	walkErr := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Unreadable dir/file: skip it (and its subtree if a dir) but keep going.
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if d.IsDir() {
			if path != root && ExcludedDirNames[d.Name()] {
				return filepath.SkipDir // excluded dirs never count toward emptiness
			}
			agg.registerDir(path)
			return nil
		}

		// Non-directory entry. Symlinks and irregular files (devices, sockets,
		// pipes) count toward a directory being non-empty but are not stat-ed.
		agg.bumpParent(path)
		if d.Type()&fs.ModeSymlink != 0 || !d.Type().IsRegular() {
			return nil
		}

		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		year := info.ModTime().Year()
		size := info.Size()
		stat(agg.byYear, year).add(size)
		agg.filesScanned++
		agg.bytesScanned += size

		if opts.protectSet && isProtected(info, path, opts.protectNewerThan, agg) {
			stat(agg.protectedByYear, year).add(size)
		}

		if opts.sleepEveryFiles > 0 && agg.filesScanned%int64(opts.sleepEveryFiles) == 0 {
			if cerr := ctx.Err(); cerr != nil {
				return cerr
			}
			if onProgress != nil {
				onProgress()
			}
			throttle(start, agg.filesScanned, opts)
		}
		return nil
	})
	return walkErr
}

// registerDir records dir as descended (for total_dirs) and bumps its parent.
func (a *shareAgg) registerDir(dir string) {
	if _, ok := a.dirChildCount[dir]; !ok {
		a.dirChildCount[dir] = 0
	}
	a.bumpParent(dir)
}

// bumpParent increments the registered parent directory's non-excluded child
// count. The parent of the share root is not registered, so it is ignored.
func (a *shareAgg) bumpParent(path string) {
	parent := filepath.Dir(path)
	if parent == path {
		return
	}
	if _, ok := a.dirChildCount[parent]; ok {
		a.dirChildCount[parent]++
	}
}

func stat(m map[int]*yearStat, year int) *yearStat {
	y := m[year]
	if y == nil {
		y = &yearStat{}
		m[year] = y
	}
	return y
}

// isProtected reads a file's mtime/ctime/btime and applies the protection rule.
// btime is read via statx; if unavailable the rule falls back to max(mtime,
// ctime) and records that on agg so the manager can note it.
func isProtected(info fs.FileInfo, path string, protect time.Time, agg *shareAgg) bool {
	mtime := info.ModTime()
	ctime := mtime
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		ctime = time.Unix(st.Ctim.Sec, st.Ctim.Nsec)
	}
	btime, hasBtime := statxBtimeOf(path)
	if !hasBtime {
		agg.btimeFallback = true
	}
	return protectedByNewest(mtime, ctime, btime, hasBtime, protect)
}

// protectedByNewest reports whether the newest of the supplied timestamps —
// max(mtime, ctime, btime) — is at or after the protect date. Any one timestamp
// at/after the date protects the file on its own (the safeguard against archiving
// data that is genuinely current but quiet).
func protectedByNewest(mtime, ctime, btime time.Time, hasBtime bool, protect time.Time) bool {
	newest := mtime
	if ctime.After(newest) {
		newest = ctime
	}
	if hasBtime && btime.After(newest) {
		newest = btime
	}
	return !newest.Before(protect) // newest >= protect
}

// throttle enforces the optional max_files_per_second ceiling on top of the
// fixed sleep_ms pause. Both are advisory and best-effort.
func throttle(start time.Time, filesScanned int64, opts scanOptions) {
	if opts.maxFilesPerSec > 0 {
		want := time.Duration(float64(filesScanned)/float64(opts.maxFilesPerSec)*float64(time.Second))
		if elapsed := time.Since(start); elapsed < want {
			time.Sleep(want - elapsed)
		}
	}
	if opts.sleepMs > 0 {
		time.Sleep(time.Duration(opts.sleepMs) * time.Millisecond)
	}
}

// ── CSV builders (schemas pinned in Appendix B of the implementation doc) ──────

func gib(bytes int64) string {
	return fmt.Sprintf("%.2f", float64(bytes)/(1024*1024*1024))
}

// buildYearlyCSV: nas,share,year,file_count,total_bytes,total_gib
func buildYearlyCSV(nas string, aggs []*shareAgg) []byte {
	var b strings.Builder
	b.WriteString("nas,share,year,file_count,total_bytes,total_gib\n")
	for _, a := range aggs {
		years := sortedYears(a.byYear)
		for _, y := range years {
			s := a.byYear[y]
			fmt.Fprintf(&b, "%s,%s,%d,%d,%d,%s\n", nas, a.share, y, s.count, s.bytes, gib(s.bytes))
		}
	}
	return []byte(b.String())
}

// buildCutoffCSV: nas,share,cutoff,candidate_count,candidate_bytes,candidate_gib,protected_count,protected_bytes
// candidate = older-than-cutoff AND not date-protected. protected_* = older-than
// AND held back by protect_newer_than. (The activity overlay is advisory at
// share level in Phase 1 and reported separately in overlay.csv; it does not
// subtract from these per-file candidate totals — see the design doc.)
func buildCutoffCSV(nas string, aggs []*shareAgg, cutoffs []int) []byte {
	var b strings.Builder
	b.WriteString("nas,share,cutoff,candidate_count,candidate_bytes,candidate_gib,protected_count,protected_bytes\n")
	sorted := append([]int(nil), cutoffs...)
	sort.Ints(sorted)
	for _, a := range aggs {
		for _, c := range sorted {
			var candCount, candBytes, protCount, protBytes int64
			for year, s := range a.byYear {
				if year >= c {
					continue // not older than the cutoff
				}
				p := a.protectedByYear[year]
				var pc, pb int64
				if p != nil {
					pc, pb = p.count, p.bytes
				}
				candCount += s.count - pc
				candBytes += s.bytes - pb
				protCount += pc
				protBytes += pb
			}
			fmt.Fprintf(&b, "%s,%s,older_than_%d,%d,%d,%s,%d,%d\n",
				nas, a.share, c, candCount, candBytes, gib(candBytes), protCount, protBytes)
		}
	}
	return []byte(b.String())
}

// buildDirsCSV: nas,share,total_dirs,empty_dirs
func buildDirsCSV(nas string, aggs []*shareAgg) []byte {
	var b strings.Builder
	b.WriteString("nas,share,total_dirs,empty_dirs\n")
	for _, a := range aggs {
		fmt.Fprintf(&b, "%s,%s,%d,%d\n", nas, a.share, a.totalDirs(), a.emptyDirs())
	}
	return []byte(b.String())
}

func sortedYears(m map[int]*yearStat) []int {
	ys := make([]int, 0, len(m))
	for y := range m {
		ys = append(ys, y)
	}
	sort.Ints(ys)
	return ys
}
