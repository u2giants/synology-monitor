package collector

// ShareSyncCollector scans dscc.log and dscc_monitor.log for hidden failure
// patterns that the Synology DSM UI does not surface:
//   - repeated-path queue jams (same path in RedoEvent/PullEvent, no DoneEvent)
//   - basis-file corruption (PrepareDownloadFile with empty-file hash, or repeated without DoneEvent)
//   - transport flaps (error code 26, daemon socket failures, reconnect loops)
//
// Each detector emits a QueueAlert (so the issue agent picks it up) plus a
// QueueLog with full structured evidence for the AI to query.

import (
	"fmt"
	"io"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

const (
	// shareSyncRoot is the container-side mount of @SynologyDriveShareSync.
	shareSyncRoot = "/host/shares/@SynologyDriveShareSync"
	dsccLog       = shareSyncRoot + "/log/dscc.log"
	dsccLogOld    = shareSyncRoot + "/log/dscc.log.1"
	dsccMonLog    = shareSyncRoot + "/log/dscc_monitor.log"
	dsccMonOld    = shareSyncRoot + "/log/dscc_monitor.log.1"

	emptyFileMD5 = "31d6cfe0d16ae931b73c59d7e0c089c0"

	// jamThreshold is the minimum number of RedoEvent/PullEvent repeats on the
	// same path without a DoneEvent before we raise an alert.
	jamThreshold = 5
	// flapThreshold is the minimum number of transport error events in a single
	// scan batch before we raise an alert.
	flapThreshold = 3
)

// path-extraction patterns, tried in order of specificity.
var (
	rePathKeyword   = regexp.MustCompile(`(?:path|file)\s*[:=]\s*['"]?(/[^\s'">,\n]+)`)
	reCheckBasis    = regexp.MustCompile(`Check basis file\s+['"]?(/[^\s'">,\n]+)`)
	reVolumePath    = regexp.MustCompile(`(?:^|\s)(/volume\d+/[^\s'">,\n]+)`)
)

// dscc.log event matchers.
var (
	reRedoPull    = regexp.MustCompile(`(?i)RedoEvent|PullEvent|download it`)
	reDone        = regexp.MustCompile(`(?i)DoneEvent`)
	rePrepare     = regexp.MustCompile(`(?i)PrepareDownloadFile`)
	reFileHash    = regexp.MustCompile(`file_hash\s*=\s*([a-f0-9]{32})`)
)

// dscc_monitor.log transport flap patterns with human-readable labels.
var flapPatterns = []struct {
	label string
	re    *regexp.Regexp
}{
	{"error_code_26", regexp.MustCompile(`(?i)handling error code 26`)},
	{"daemon_status_fail", regexp.MustCompile(`(?i)failed to get daemon status`)},
	{"socket_fail", regexp.MustCompile(`(?i)open domain socket fail`)},
	{"switch_connection", regexp.MustCompile(`(?i)Switch connection`)},
	{"disconnected", regexp.MustCompile(`(?i)disconnected status`)},
	{"recovered", regexp.MustCompile(`(?i)recovered to connected status`)},
}

var reFlapConnID = regexp.MustCompile(`(?i)connection[_\s#]*(\d+)`)

// ShareSyncCollector reads ShareSync daemon logs and emits alerts for hidden
// failure patterns.
type ShareSyncCollector struct {
	sender   *sender.Sender
	nasID    string
	interval time.Duration
	dsccOff  int64
	monOff   int64
}

// NewShareSyncCollector creates the collector and restores saved log offsets.
func NewShareSyncCollector(s *sender.Sender, nasID string, interval time.Duration) *ShareSyncCollector {
	c := &ShareSyncCollector{
		sender:   s,
		nasID:    nasID,
		interval: interval,
	}
	if v, err := s.LoadCheckpoint("sharesync_dscc_offset:" + nasID); err == nil && v != "" {
		c.dsccOff, _ = strconv.ParseInt(v, 10, 64)
	}
	if v, err := s.LoadCheckpoint("sharesync_mon_offset:" + nasID); err == nil && v != "" {
		c.monOff, _ = strconv.ParseInt(v, 10, 64)
	}
	return c
}

// Run starts the collector loop.
func (c *ShareSyncCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()
	log.Printf("[sharesync] collector started (interval: %s)", c.interval)
	c.scan()
	for {
		select {
		case <-ticker.C:
			c.scan()
		case <-stop:
			log.Println("[sharesync] collector stopped")
			return
		}
	}
}

func (c *ShareSyncCollector) scan() {
	now := time.Now().UTC()

	dsccLines, newDsccOff := readNewLogLines(dsccLog, dsccLogOld, c.dsccOff)
	if newDsccOff != c.dsccOff {
		c.dsccOff = newDsccOff
		if err := c.sender.SaveCheckpoint("sharesync_dscc_offset:"+c.nasID, strconv.FormatInt(newDsccOff, 10)); err != nil {
			log.Printf("[sharesync] could not save dscc offset: %v", err)
		}
	}

	if len(dsccLines) > 0 {
		c.detectQueueJam(dsccLines, now)
		c.detectBasisCorruption(dsccLines, now)
	}

	monLines, newMonOff := readNewLogLines(dsccMonLog, dsccMonOld, c.monOff)
	if newMonOff != c.monOff {
		c.monOff = newMonOff
		if err := c.sender.SaveCheckpoint("sharesync_mon_offset:"+c.nasID, strconv.FormatInt(newMonOff, 10)); err != nil {
			log.Printf("[sharesync] could not save monitor offset: %v", err)
		}
	}

	if len(monLines) > 0 {
		c.detectTransportFlap(monLines, now)
	}
}

// readNewLogLines reads lines added to path since offset. On rotation (file
// smaller than offset) it resets to 0. Only complete lines are returned; a
// partial trailing line is left for the next scan.
func readNewLogLines(path, rotatedPath string, offset int64) (lines []string, newOffset int64) {
	f, err := os.Open(path)
	if err != nil {
		return nil, offset
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil {
		return nil, offset
	}

	if info.Size() < offset {
		log.Printf("[sharesync] %s rotated (size=%d < offset=%d), resetting", path, info.Size(), offset)
		offset = 0
	}

	if info.Size() == offset {
		return nil, offset
	}

	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, offset
	}

	data, err := io.ReadAll(f)
	if err != nil || len(data) == 0 {
		return nil, offset
	}

	// Advance offset only through complete lines so a partial final line is
	// re-read next cycle once it gains a newline terminator.
	lastNL := strings.LastIndex(string(data), "\n")
	if lastNL < 0 {
		return nil, offset
	}

	complete := string(data[:lastNL+1])
	newOffset = offset + int64(lastNL+1)

	for _, line := range strings.Split(complete, "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	return lines, newOffset
}

// extractPath returns the first absolute path found in a dscc.log line.
func extractPath(line string) string {
	if m := rePathKeyword.FindStringSubmatch(line); len(m) > 1 {
		return strings.TrimRight(m[1], ".,;")
	}
	if m := reCheckBasis.FindStringSubmatch(line); len(m) > 1 {
		return strings.TrimRight(m[1], ".,;")
	}
	if m := reVolumePath.FindStringSubmatch(line); len(m) > 1 {
		return strings.TrimRight(m[1], ".,;")
	}
	return ""
}

// detectQueueJam scans for paths that appear repeatedly in RedoEvent/PullEvent
// lines without a matching DoneEvent in the same batch.
func (c *ShareSyncCollector) detectQueueJam(lines []string, now time.Time) {
	type pathState struct {
		count     int
		firstLine string
		lastLine  string
	}
	paths := make(map[string]*pathState)
	done := make(map[string]bool)

	for _, line := range lines {
		if reDone.MatchString(line) {
			if p := extractPath(line); p != "" {
				done[p] = true
			}
			continue
		}
		if reRedoPull.MatchString(line) {
			p := extractPath(line)
			if p == "" {
				continue
			}
			st := paths[p]
			if st == nil {
				st = &pathState{firstLine: line}
				paths[p] = st
			}
			st.count++
			st.lastLine = line
		}
	}

	for path, st := range paths {
		if done[path] || st.count < jamThreshold {
			continue
		}
		msg := fmt.Sprintf("ShareSync queue jam: %q repeated %d times with no DoneEvent", path, st.count)
		c.sender.QueueAlert(sender.AlertPayload{
			NasID:    c.nasID,
			Severity: "critical",
			Source:   "sharesync_jam",
			Title:    "ShareSync queue jam",
			Message:  msg,
		})
		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "sharesync_jam",
			Severity: "critical",
			Message:  msg,
			Metadata: map[string]interface{}{
				"stuck_path":          path,
				"repeat_count":        st.count,
				"first_evidence_line": st.firstLine,
				"last_evidence_line":  st.lastLine,
				"recommended_action":  "Destination-side ShareSync queue is stuck. Inspect history.sqlite for this path and consider a narrow delete of the stuck queue entry.",
			},
			LoggedAt: now,
		})
		log.Printf("[sharesync] queue jam: %s (%d repeats)", path, st.count)
	}
}

// detectBasisCorruption scans for PrepareDownloadFile events:
//   - critical if file_hash matches the empty-file MD5 (31d6...)
//   - warning if the same path repeats PrepareDownloadFile without a DoneEvent
func (c *ShareSyncCollector) detectBasisCorruption(lines []string, now time.Time) {
	type prepState struct {
		count      int
		emptyCount int
		lastHash   string
		lastLine   string
	}
	preps := make(map[string]*prepState)
	done := make(map[string]bool)

	var pendingPath string

	for _, line := range lines {
		lower := strings.ToLower(line)
		_ = lower

		if reDone.MatchString(line) {
			if p := extractPath(line); p != "" {
				done[p] = true
				pendingPath = ""
			}
			continue
		}

		if rePrepare.MatchString(line) {
			pendingPath = extractPath(line)
			if pendingPath != "" {
				st := preps[pendingPath]
				if st == nil {
					st = &prepState{}
					preps[pendingPath] = st
				}
				st.count++
				st.lastLine = line
			}
			continue
		}

		if m := reFileHash.FindStringSubmatch(line); len(m) > 1 && pendingPath != "" {
			hash := m[1]
			if st, ok := preps[pendingPath]; ok {
				st.lastHash = hash
				if hash == emptyFileMD5 {
					st.emptyCount++
				}
			}
			pendingPath = ""
			continue
		}

		// Non-blank line that isn't PrepareDownloadFile or file_hash clears context.
		if strings.TrimSpace(line) != "" {
			pendingPath = ""
		}
	}

	for path, st := range preps {
		if done[path] {
			continue
		}
		if st.count < 2 {
			continue
		}

		if st.emptyCount > 0 {
			msg := fmt.Sprintf("ShareSync basis corruption: empty-file hash on %q (%d PrepareDownloadFile, %d empty-hash hits)", path, st.count, st.emptyCount)
			c.sender.QueueAlert(sender.AlertPayload{
				NasID:    c.nasID,
				Severity: "critical",
				Source:   "sharesync_corruption",
				Title:    "ShareSync basis-file corruption",
				Message:  msg,
			})
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "sharesync_corruption",
				Severity: "critical",
				Message:  msg,
				Metadata: map[string]interface{}{
					"path":                path,
					"prepare_count":       st.count,
					"empty_hash_count":    st.emptyCount,
					"observed_hash":       st.lastHash,
					"empty_file_md5":      emptyFileMD5,
					"last_evidence_line":  st.lastLine,
					"recommended_action":  "Destination-side basis file is stored as empty. This causes indefinite retry. Inspect history.sqlite for this path and consider a narrow basis-file reset.",
				},
				LoggedAt: now,
			})
		} else {
			msg := fmt.Sprintf("ShareSync basis retry: %q repeated PrepareDownloadFile %d times without DoneEvent (hash=%s)", path, st.count, st.lastHash)
			c.sender.QueueAlert(sender.AlertPayload{
				NasID:    c.nasID,
				Severity: "warning",
				Source:   "sharesync_corruption",
				Title:    "ShareSync repeated basis-file retry",
				Message:  msg,
			})
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "sharesync_corruption",
				Severity: "warning",
				Message:  msg,
				Metadata: map[string]interface{}{
					"path":               path,
					"prepare_count":      st.count,
					"last_hash":          st.lastHash,
					"last_evidence_line": st.lastLine,
					"recommended_action": "Destination-side ShareSync queue state may be corrupt. Monitor for resolution; if it persists inspect history.sqlite.",
				},
				LoggedAt: now,
			})
		}
		log.Printf("[sharesync] basis corruption: %s (count=%d, empty_hash=%d)", path, st.count, st.emptyCount)
	}
}

// detectTransportFlap scans dscc_monitor.log for connection error patterns.
func (c *ShareSyncCollector) detectTransportFlap(lines []string, now time.Time) {
	type flapHit struct {
		label string
		line  string
	}
	var hits []flapHit
	patternCounts := make(map[string]int)
	connID := ""

	for _, line := range lines {
		for _, fp := range flapPatterns {
			if fp.re.MatchString(line) {
				hits = append(hits, flapHit{label: fp.label, line: line})
				patternCounts[fp.label]++
				if connID == "" {
					if m := reFlapConnID.FindStringSubmatch(line); len(m) > 1 {
						connID = m[1]
					}
				}
				break
			}
		}
	}

	if len(hits) < flapThreshold {
		return
	}

	// Collect one sample line per unique pattern for evidence.
	sampleLines := make([]interface{}, 0, len(flapPatterns))
	seenLabel := make(map[string]bool)
	for _, h := range hits {
		if !seenLabel[h.label] {
			sampleLines = append(sampleLines, h.line)
			seenLabel[h.label] = true
		}
	}

	msg := fmt.Sprintf("ShareSync transport instability: %d events in scan window", len(hits))
	if connID != "" {
		msg = fmt.Sprintf("ShareSync transport instability (connection %s): %d events", connID, len(hits))
	}

	c.sender.QueueAlert(sender.AlertPayload{
		NasID:    c.nasID,
		Severity: "warning",
		Source:   "sharesync_flap",
		Title:    "ShareSync transport instability",
		Message:  msg,
	})
	c.sender.QueueLog(sender.LogPayload{
		NasID:    c.nasID,
		Source:   "sharesync_flap",
		Severity: "warning",
		Message:  msg,
		Metadata: map[string]interface{}{
			"event_count":        len(hits),
			"connection_id":      connID,
			"pattern_counts":     patternCounts,
			"sample_lines":       sampleLines,
			"recommended_action": "Check ShareSync daemon runtime status. Repeated error-26 events often indicate connection instability from concurrent disk pressure (e.g. RAID rebuild). Restarting the ShareSync service may clear transient state.",
		},
		LoggedAt: now,
	})
	log.Printf("[sharesync] transport flap: %d events (connection=%s)", len(hits), connID)
}
