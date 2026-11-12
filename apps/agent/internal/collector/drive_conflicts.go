package collector

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

// Drive conflict-copy alerting.
//
// Live evidence (edgesynology1, 2026-10-29 and 2026-11-02): new *_Conflict
// copies are NOT case collisions. They form when a file is saved straight onto
// the share over SMB (Drive logs this as NativeUpload) while a Synology Drive
// client on a laptop is also syncing the same file. The client's upload then
// fails with "version conflict" and Drive stores the laptop's version as
// "<name>_<DEVICE>_<date>_Conflict". Nothing on the NAS can refuse that write
// without losing the laptop's edit, so we alert per copy instead: who, which
// device, which share and path, so the copy is reconciled while it is fresh.

var (
	// Server-detected conflict: a Drive client upload lost a version race.
	reConflictCreated = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}) .*Upload Done \[node (\d+)\]\[ver \d+\] >> '([^']*_Conflict[^'/]*)' \| view '([^']+)'\((\d+)\), by '([^']+)'\(\d+\) - ([A-Za-z]+\([^)]*\))`)
	// Client-made conflict copy arriving as a direct write on the share.
	reConflictNative = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}) .*<NativeUpload> \[(\d+)\] '([^']*_Conflict[^'/]*)' \(node (\d+)\) \(file\) has been updated, new version`)
	reViewName       = regexp.MustCompile(`view '([^']+)'\((\d+)\)`)
	// "<base>_<DEVICE>_<Mon>-<dd>-<hhmmss>-<yyyy>_Conflict" (month may be Spanish, e.g. "ago.").
	reConflictStamp = regexp.MustCompile(`_([^_/]+)_([A-Za-z]{3})\.?-(\d{2})-\d{6}-(\d{4})_(?:Case|UploadName)?Conflict`)
)

var conflictMonths = map[string]int{"jan": 1, "ene": 1, "feb": 2, "mar": 3, "apr": 4, "abr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "ago": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12, "dic": 12}

const conflictLogLayout = "2006-01-02T15:04:05"

type driveConflict struct {
	At     string
	Node   string
	Path   string
	Share  string
	User   string
	Client string
	Device string
}

// freshConflictName reports the device and whether the date stamped into a
// conflict name is within 3 days of the log line. Moving an old conflict copy
// also logs a NativeUpload; its stamp is old, so it is not a new conflict.
func freshConflictName(name, at string) (string, bool) {
	m := reConflictStamp.FindStringSubmatch(name)
	if m == nil {
		return "", false
	}
	mon, ok := conflictMonths[strings.ToLower(m[2])]
	if !ok {
		return m[1], false
	}
	stamp, err := time.Parse("2006-1-02", fmt.Sprintf("%s-%d-%s", m[4], mon, m[3]))
	line, err2 := time.Parse(conflictLogLayout, at)
	if err != nil || err2 != nil {
		return m[1], false
	}
	d := line.Sub(stamp)
	return m[1], d > -72*time.Hour && d < 72*time.Hour
}

// parseConflictCreations returns conflict copies created at or after cutoff
// (same naive clock as the log). Copies replicated onward to ShareSync are
// "Download" lines and are not matched.
func parseConflictCreations(lines []string, cutoff string) []driveConflict {
	views := map[string]string{}
	for _, line := range lines {
		if m := reViewName.FindStringSubmatch(line); m != nil {
			views[m[2]] = m[1]
		}
	}
	var out []driveConflict
	for _, line := range lines {
		if !strings.Contains(line, "_Conflict") || len(line) < 19 || line[:19] < cutoff {
			continue
		}
		if m := reConflictCreated.FindStringSubmatch(line); m != nil {
			dev, _ := freshConflictName(filepath.Base(m[3]), m[1])
			out = append(out, driveConflict{At: m[1], Node: m[2], Path: m[3], Share: m[4], User: m[6], Client: m[7], Device: dev})
			continue
		}
		if m := reConflictNative.FindStringSubmatch(line); m != nil {
			dev, fresh := freshConflictName(filepath.Base(m[3]), m[1])
			if !fresh {
				continue
			}
			share := views[m[2]]
			if share == "" {
				share = "view " + m[2]
			}
			out = append(out, driveConflict{At: m[1], Node: m[4], Path: m[3], Share: share, User: "(direct write on the share)", Client: "SMB/NAS-side", Device: dev})
		}
	}
	return out
}

// latestLogTime returns the newest leading timestamp in lines, or "".
func latestLogTime(lines []string) string {
	for i := len(lines) - 1; i >= 0; i-- {
		if len(lines[i]) >= 19 {
			if _, err := time.Parse(conflictLogLayout, lines[i][:19]); err == nil {
				return lines[i][:19]
			}
		}
	}
	return ""
}

// collectDriveConflicts scans the two newest syncfolder logs (~10 MB, several
// hours) and alerts once per new conflict copy seen in the last 24 hours.
func (c *DriveCollector) collectDriveConflicts() {
	files, _ := filepath.Glob(filepath.Join(driveLogDir, "syncfolder.log*"))
	sort.Slice(files, func(i, j int) bool {
		a, _ := os.Stat(files[i])
		b, _ := os.Stat(files[j])
		return a != nil && b != nil && a.ModTime().After(b.ModTime())
	})
	if len(files) > 2 {
		files = files[:2]
	}
	var lines []string
	for i := len(files) - 1; i >= 0; i-- {
		l, err := tailLines(files[i], 200000)
		if err == nil {
			lines = append(lines, l...)
		}
	}
	newest := latestLogTime(lines)
	if newest == "" {
		return
	}
	t, _ := time.Parse(conflictLogLayout, newest)
	cutoff := t.Add(-24 * time.Hour).Format(conflictLogLayout)
	if c.seenConflicts == nil {
		c.seenConflicts = map[string]bool{}
	}
	for _, k := range parseConflictCreations(lines, cutoff) {
		if c.seenConflicts[k.Node] {
			continue
		}
		c.seenConflicts[k.Node] = true
		c.sender.QueueAlert(sender.AlertPayload{
			NasID:    c.nasID,
			Severity: "warning",
			Source:   "drive_conflict",
			Title:    fmt.Sprintf("New Drive conflict copy in %s: %s", k.Share, filepath.Base(k.Path)),
			Message: fmt.Sprintf("Synology Drive created a conflict copy at %s (NAS time).\nShare: %s\nPath: %s\nUser: %s\nClient: %s\nDevice: %s\n"+
				"Cause: the same file was changed through Drive on that device while it was also saved directly on the share (or by another user). "+
				"Compare it with the live file and keep the right version; scripts/synology/resolve-drive-conflicts.sh handles identical/older copies.",
				k.At, k.Share, k.Path, k.User, k.Client, k.Device),
		})
	}
}
