package jobs

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// overlaySource describes where to look for one class of recent-activity DBs.
type overlaySource struct {
	label string   // "drive_log" | "sharesync_history"
	dirs  []string // directories searched (shallow) for *.sqlite / *.db files
}

// overlaySources are the read-only Synology Drive / ShareSync stores mounted into
// the NAS API container. Discovery is intentionally shallow (named subdirs only)
// to avoid heavy directory walks over Synology's internal data.
var overlaySources = []overlaySource{
	{
		label: "drive_log",
		dirs: []string{
			"/volume1/@synologydrive/@sync",
			"/volume1/@synologydrive",
		},
	},
	{
		label: "sharesync_history",
		dirs: []string{
			"/volume1/@SynologyDriveShareSync",
		},
	},
}

// overlayWindowDays bounds how far back an event is considered "recent".
const overlayWindowDays = 35

// overlayMaxRows caps how many rows are pulled from any single database, so a
// huge table can never blow up memory or model context.
const overlayMaxRows = 200000

// overlayRow is one aggregated activity row: nas,share,source,first_seen,last_seen,event_count
type overlayRow struct {
	share     string
	source    string
	firstSeen string
	lastSeen  string
	count     int64
}

// runOverlay produces overlay.csv on a best-effort basis. It NEVER fails the
// inventory job: every error path returns a human-readable note (joined into the
// job's overlay_note) and the job still completes. Databases are copied to a
// scratch dir and opened read-only so live Drive/ShareSync sync is never locked.
func runOverlay(ctx context.Context, jobDir, nas string) (csv []byte, note string) {
	if _, err := exec.LookPath("sqlite3"); err != nil {
		return overlayCSV(nas, nil), "overlay skipped: sqlite3 binary not found in runtime image"
	}

	tmp := filepath.Join(jobDir, "_overlay_tmp")
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return overlayCSV(nas, nil), "overlay skipped: cannot create scratch dir: " + err.Error()
	}
	defer os.RemoveAll(tmp)

	var rows []overlayRow
	var notes []string
	var dbsFound int

	for _, src := range overlaySources {
		for _, db := range findDatabases(src.dirs) {
			dbsFound++
			copied, err := copyDBTriad(db, tmp)
			if err != nil {
				notes = append(notes, fmt.Sprintf("%s: copy %s failed: %v", src.label, filepath.Base(db), err))
				continue
			}
			r, qnote := aggregateDB(ctx, copied, src.label)
			if qnote != "" {
				notes = append(notes, src.label+": "+qnote)
			}
			rows = append(rows, r...)
			if ctx.Err() != nil {
				notes = append(notes, "overlay cancelled")
				return overlayCSV(nas, rows), strings.Join(notes, "; ")
			}
		}
	}

	if dbsFound == 0 {
		return overlayCSV(nas, nil), "overlay: no Drive/ShareSync databases found at the mounted paths"
	}
	if len(rows) == 0 && len(notes) == 0 {
		notes = append(notes, "overlay: databases found but no recognizable activity table/columns")
	}
	return overlayCSV(nas, rows), strings.Join(notes, "; ")
}

// findDatabases returns *.sqlite / *.db files directly inside the given dirs
// (non-recursive). Missing dirs are silently skipped.
func findDatabases(dirs []string) []string {
	var out []string
	seen := map[string]bool{}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() {
				continue
			}
			name := strings.ToLower(e.Name())
			if !strings.HasSuffix(name, ".sqlite") && !strings.HasSuffix(name, ".db") {
				continue
			}
			full := filepath.Join(dir, e.Name())
			if !seen[full] {
				seen[full] = true
				out = append(out, full)
			}
		}
	}
	return out
}

// copyDBTriad copies the main DB plus any adjacent -wal/-shm files into dst and
// returns the path of the copied main DB, so queries run against a stable copy
// rather than the live, possibly-WAL-active database.
func copyDBTriad(db, dst string) (string, error) {
	base := filepath.Base(db)
	target := filepath.Join(dst, base)
	if err := copyFile(db, target); err != nil {
		return "", err
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(db + suffix); err == nil {
			_ = copyFile(db+suffix, target+suffix) // best-effort; absence is fine
		}
	}
	return target, nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}

// aggregateDB introspects a copied database and, for the first table exposing a
// path-like and a time-like column, aggregates recent activity by the path's
// top-level segment. Heuristic and schema-tolerant by design — on the live NAS
// the chosen table/columns should be confirmed; any failure degrades to a note.
func aggregateDB(ctx context.Context, db, source string) ([]overlayRow, string) {
	tables, err := sqliteList(ctx, db, ".tables")
	if err != nil {
		return nil, fmt.Sprintf("%s: cannot read tables: %v", filepath.Base(db), err)
	}
	for _, table := range tables {
		pathCol, timeCol, ok := pickColumns(ctx, db, table)
		if !ok {
			continue
		}
		query := fmt.Sprintf(
			"SELECT %s, %s FROM %s WHERE %s IS NOT NULL LIMIT %d",
			pathCol, timeCol, table, pathCol, overlayMaxRows)
		out, err := sqliteQuery(ctx, db, query)
		if err != nil {
			return nil, fmt.Sprintf("%s.%s: query failed: %v", filepath.Base(db), table, err)
		}
		rows := foldByShare(out, source)
		if len(rows) > 0 {
			return rows, ""
		}
	}
	return nil, fmt.Sprintf("%s: no usable (path,time) table found", filepath.Base(db))
}

// pickColumns finds a path-like and time-like column in a table via PRAGMA.
func pickColumns(ctx context.Context, db, table string) (pathCol, timeCol string, ok bool) {
	cols, err := sqliteQuery(ctx, db, fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return "", "", false
	}
	for _, row := range cols {
		if len(row) < 2 {
			continue
		}
		name := row[1]
		lower := strings.ToLower(name)
		if pathCol == "" && matchesAny(lower, "path", "file", "name", "folder", "target") {
			pathCol = name
		}
		if timeCol == "" && matchesAny(lower, "time", "date", "mtime", "ts", "modified", "last") {
			timeCol = name
		}
	}
	return pathCol, timeCol, pathCol != "" && timeCol != ""
}

func matchesAny(s string, subs ...string) bool {
	for _, sub := range subs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}

// foldByShare aggregates (path, time) rows by the path's top-level segment,
// keeping the most recent overlayWindowDays of activity when the time column
// parses as an RFC3339 / date string or unix epoch.
func foldByShare(rows [][]string, source string) []overlayRow {
	type acc struct {
		first, last string
		count       int64
	}
	cutoff := time.Now().AddDate(0, 0, -overlayWindowDays)
	byShare := map[string]*acc{}
	for _, r := range rows {
		if len(r) < 2 {
			continue
		}
		seg := topSegment(r[0])
		if seg == "" {
			continue
		}
		ts := r[1]
		if t, ok := parseLooseTime(ts); ok && t.Before(cutoff) {
			continue // outside the recent window
		}
		a := byShare[seg]
		if a == nil {
			a = &acc{first: ts, last: ts}
			byShare[seg] = a
		}
		a.count++
		if ts < a.first {
			a.first = ts
		}
		if ts > a.last {
			a.last = ts
		}
	}
	out := make([]overlayRow, 0, len(byShare))
	for share, a := range byShare {
		out = append(out, overlayRow{share: share, source: source, firstSeen: a.first, lastSeen: a.last, count: a.count})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].share < out[j].share })
	return out
}

// topSegment returns the first non-empty path segment (the share/synced-folder).
func topSegment(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimLeft(p, "/")
	if p == "" {
		return ""
	}
	if i := strings.IndexByte(p, '/'); i >= 0 {
		return p[:i]
	}
	return p
}

// parseLooseTime best-effort-parses a timestamp that may be RFC3339, a date, or
// a unix epoch. ok=false means "unknown format" — callers then keep the row
// rather than dropping it (the window filter is advisory).
func parseLooseTime(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, true
		}
	}
	if epoch, ok := parseEpoch(s); ok {
		return epoch, true
	}
	return time.Time{}, false
}

func parseEpoch(s string) (time.Time, bool) {
	var n int64
	for _, c := range s {
		if c < '0' || c > '9' {
			return time.Time{}, false
		}
		n = n*10 + int64(c-'0')
	}
	if n <= 0 {
		return time.Time{}, false
	}
	if n > 1e12 { // milliseconds
		return time.Unix(0, n*int64(time.Millisecond)), true
	}
	return time.Unix(n, 0), true
}

// ── sqlite3 CLI helpers (read-only, short busy timeout) ────────────────────────

func sqliteList(ctx context.Context, db, dot string) ([]string, error) {
	out, err := sqliteRaw(ctx, db, dot)
	if err != nil {
		return nil, err
	}
	return strings.Fields(out), nil
}

func sqliteQuery(ctx context.Context, db, query string) ([][]string, error) {
	out, err := sqliteRaw(ctx, db, query)
	if err != nil {
		return nil, err
	}
	var rows [][]string
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		rows = append(rows, strings.Split(line, ","))
	}
	return rows, nil
}

func sqliteRaw(ctx context.Context, db, stmt string) (string, error) {
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(cctx, "sqlite3", "-readonly", "-csv", "-cmd", ".timeout 2000", db, stmt)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return string(out), nil
}

// overlayCSV renders rows to the pinned schema. A nil slice yields a header-only
// file so the result kind always exists.
func overlayCSV(nas string, rows []overlayRow) []byte {
	var b strings.Builder
	b.WriteString("nas,share,source,first_seen,last_seen,event_count\n")
	for _, r := range rows {
		fmt.Fprintf(&b, "%s,%s,%s,%s,%s,%d\n", nas, r.share, r.source, r.firstSeen, r.lastSeen, r.count)
	}
	return []byte(b.String())
}
