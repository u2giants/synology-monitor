package collector

import (
	"bufio"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
	_ "github.com/mattn/go-sqlite3"
)

// shareSyncLogRoot is the container-side mount of @SynologyDriveShareSync.
// This is mounted read-only as /host/shares/@SynologyDriveShareSync.
const shareSyncLogRoot = "/host/shares/@SynologyDriveShareSync"

// driveDBDir is the container-side path for Synology Drive SQLite databases.
const driveDBDir = "/host/shares/@synologydrive/@sync"

// driveEventRec holds a single parsed Drive sync-log event.
type driveEventRec struct {
	kind string // Remove | Rename | Upload | Move | Create
	src  string // normalized basename of the primary path
	dst  string // normalized basename of the rename target (Rename/Move only)
}

// driveLogDir is where the Drive server sync logs live inside the container.
const driveLogDir = "/host/shares/@synologydrive/log"

// Regexps for log-based ShareSync heuristics.
var (
	reCurrentFile   = regexp.MustCompile(`(?i)syncing[:\s]+(.+)$`)
	reRetry         = regexp.MustCompile(`(?i)retry[:\s#]+(\d+)`)
	reError         = regexp.MustCompile(`(?i)(error|fail)[:\s]+(.{0,200})`)
	reBacklog       = regexp.MustCompile(`(?i)remaining[:\s]+(\d+)`)
)

// Regexps for Drive attribution and event parsing.
var (
	// reConflictDevice matches device names in conflict-style filenames like
	// "_DESKTOP-R78HRI5", "_LAPTOP-461OGMB5", "_MacBookPro.local".
	reConflictDevice = regexp.MustCompile(`(?i)[_ ](DESKTOP-[A-Z0-9]+|LAPTOP-[A-Z0-9]+|ZAR-[A-Z0-9-]+|[A-Za-z0-9-]+\.local)(?:[_ .]|$)`)

	// reTaskID matches "NativeSyncTask #N" IDs in sync logs.
	reTaskID = regexp.MustCompile(`NativeSyncTask\s+#(\d+)`)

	// reNativeEvent matches the event type in sync log lines.
	reNativeEvent = regexp.MustCompile(`Native(Rename|Remove|Upload|Move|Create)\b`)

	// reSingleQuotedPath matches paths in single quotes.
	reSingleQuotedPath = regexp.MustCompile(`'(/[^']+)'`)

	// reDoubleQuotedPath matches paths in double quotes.
	reDoubleQuotedPath = regexp.MustCompile(`"(/[^"]+)"`)

	// reBarePath matches bare absolute paths (no quotes).
	reBarePath = regexp.MustCompile(`(?:^|\s)(/volume\d+/[^\s>]+)`)

	// reArrowTarget matches "-> /path" patterns in rename lines.
	reArrowTarget = regexp.MustCompile(`->\s*(?:'(/[^']+)'|"(/[^"]+)"|(/volume\d+/[^\s>]+))`)

	// reConflictSuffix strips common conflict suffixes for name normalisation.
	reConflictSuffix = regexp.MustCompile(`(?i)(_Conflict|_UploadNameConflict|_CaseConflict|_DESKTOP-[A-Z0-9]+|_LAPTOP-[A-Z0-9]+|_ZAR-[A-Z0-9-]+|_DiskStation[^_]*|_Copy|\s+\(\d+\))`)
)

// DriveCollector collects Drive team folders and user activity via DSM API
type DriveCollector struct {
	client           *dsm.Client
	sender           *sender.Sender
	nasID            string
	interval         time.Duration
	// attributionCycle counts collect() calls so attribution runs every 10th cycle
	// to avoid repeated heavy SQLite opens. At a 5-minute interval that is every ~50 min.
	attributionCycle int
	// shareSyncAPIUnavailableUntil is set when all known ShareSync API endpoints
	// return 102 (no such API). We skip the API calls until this time to avoid
	// flooding the Drive server log with "WebAPI not valid" errors.
	shareSyncAPIUnavailableUntil time.Time
}

// NewDriveCollector creates a new Drive collector
func NewDriveCollector(client *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *DriveCollector {
	return &DriveCollector{
		client:   client,
		sender:   s,
		nasID:    nasID,
		interval: interval,
	}
}

// Run starts the Drive collection loop
func (c *DriveCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[drive] collector started (interval: %s)", c.interval)
	c.collect()

	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[drive] collector stopped")
			return
		}
	}
}

func (c *DriveCollector) collect() {
	c.attributionCycle++

	// Collect team folders
	c.collectTeamFolders()

	// Collect user activity
	c.collectUserActivity()

	// Collect Drive stats
	c.collectStats()

	// Collect ShareSync task snapshots (API-first, log-based fallback)
	c.collectShareSyncTasks()

	// Low-impact anomaly scan over recent Drive sync logs including
	// delete/rename event matching and churn classification.
	c.collectDriveLogSignals()

	// Drive client attribution — reads SQLite DBs and conflict filenames.
	// Runs every 10th cycle to limit SQLite open frequency.
	if c.attributionCycle%10 == 1 {
		c.collectDriveAttribution()
	}
}

func (c *DriveCollector) collectTeamFolders() {
	folders, err := c.client.DriveAdminTeamFolders()
	if err != nil {
		log.Printf("[drive] error getting team folders: %v", err)
		return
	}

	now := time.Now().UTC()

	for _, folder := range folders {
		// Calculate usage percentage
		usagePct := float64(0)
		if folder.QuotaLimit > 0 {
			usagePct = float64(folder.QuotaUsed) / float64(folder.QuotaLimit) * 100.0
		}

		c.sender.QueueDriveTeamFolder(sender.DriveTeamFolderPayload{
			NasID:        c.nasID,
			FolderID:     folder.ID,
			FolderName:   folder.Name,
			FolderPath:   folder.Path,
			QuotaBytes:   folder.QuotaLimit,
			UsedBytes:    folder.QuotaUsed,
			UsagePercent: usagePct,
			MemberCount:  folder.MemberCount,
			SyncCount:    folder.SyncCount,
			IsExternal:   folder.IsExternal,
			Priority:     folder.Priority,
			Status:       folder.Status,
			RecordedAt:   now,
		})
	}

	if len(folders) > 0 {
		log.Printf("[drive] collected %d team folders", len(folders))
	}
}

func (c *DriveCollector) collectUserActivity() {
	// Get last 50 activities
	activities, err := c.client.DriveAdminUserActivity(50)
	if err != nil {
		log.Printf("[drive] error getting user activity: %v", err)
		return
	}

	now := time.Now().UTC()

	for _, activity := range activities {
		c.sender.QueueDriveActivity(sender.DriveActivityPayload{
			NasID:      c.nasID,
			User:       activity.User,
			LoginTime:  activity.LoginTime,
			IP:         activity.IP,
			Device:     activity.Device,
			Action:     activity.Action,
			FilePath:   activity.FilePath,
			Timestamp:  activity.Timestamp,
			RecordedAt: now,
		})
	}

	if len(activities) > 0 {
		log.Printf("[drive] collected %d user activities", len(activities))
	}
}

func (c *DriveCollector) collectStats() {
	stats, err := c.client.DriveAdminStats()
	if err != nil {
		log.Printf("[drive] error getting stats: %v", err)
		return
	}

	now := time.Now().UTC()

	// Queue Drive stats as a log event with structured metadata
	c.sender.QueueLog(sender.LogPayload{
		NasID:    c.nasID,
		Source:   "drive_admin_stats",
		Severity: "info",
		Message:  "Drive statistics snapshot",
		Metadata: stats,
		LoggedAt: now,
	})

	log.Printf("[drive] collected stats")
}

// collectShareSyncTasks gathers ShareSync task details.
// It first tries the DSM API; if that returns nothing it falls back to
// parsing the mounted ShareSync log files.
func (c *DriveCollector) collectShareSyncTasks() {
	now := time.Now().UTC()

	// Skip API calls while backed off — all known endpoints returned 102 last time.
	if now.Before(c.shareSyncAPIUnavailableUntil) {
		c.collectShareSyncFromLogs(now)
		return
	}

	tasks, err := c.client.GetShareSyncTasks()
	if errors.Is(err, dsm.ErrAPINotFound) {
		// All ShareSync API endpoints are absent on this Drive version.
		// Back off for 1 hour to stop flooding the Drive server log.
		c.shareSyncAPIUnavailableUntil = now.Add(1 * time.Hour)
		log.Printf("[drive] ShareSync API not available on this Drive version — backing off for 1h, using log fallback")
		c.collectShareSyncFromLogs(now)
		return
	}
	if err != nil {
		log.Printf("[drive] ShareSync API error: %v", err)
	}

	if len(tasks) > 0 {
		for _, t := range tasks {
			taskType := "sharesync"
			if t.ID == "" {
				t.ID = t.Name
			}
			c.sender.QueueSyncTaskSnapshot(sender.SyncTaskSnapshotPayload{
				NasID:            c.nasID,
				CapturedAt:       now,
				TaskID:           t.ID,
				TaskName:         t.Name,
				TaskType:         taskType,
				Status:           t.Status,
				BacklogCount:     t.BacklogCount,
				BacklogBytes:     t.BacklogBytes,
				CurrentFile:      t.CurrentFile,
				CurrentFolder:    t.CurrentFolder,
				RetryCount:       t.RetryCount,
				LastError:        t.LastError,
				TransferredFiles: t.TransferredFiles,
				TransferredBytes: t.TransferredBytes,
				SpeedBPS:         t.SpeedBPS,
				IndexingQueue:    t.IndexingQueue,
			})

			// Send root-cause detail as structured log for AI querying
			if t.RemoteHost != "" || t.LocalShareName != "" || t.Direction != "" {
				severity := "info"
				if t.Status == "error" || strings.Contains(strings.ToLower(t.LastError), "fail") {
					severity = "error"
				} else if t.RetryCount > 3 {
					severity = "warning"
				}
				c.sender.QueueLog(sender.LogPayload{
					NasID:    c.nasID,
					Source:   "sharesync_detail",
					Severity: severity,
					Message:  "ShareSync task=" + t.Name + " status=" + t.Status,
					Metadata: map[string]interface{}{
						"task_id":      t.ID,
						"task_name":    t.Name,
						"remote_host":  t.RemoteHost,
						"direction":    t.Direction,
						"local_share":  t.LocalShareName,
						"remote_share": t.RemoteShareName,
						"task_uuid":    t.TaskUUID,
						"enabled":      t.Enabled,
						"status":       t.Status,
						"retry_count":  t.RetryCount,
						"last_error":   t.LastError,
					},
					LoggedAt: now,
				})
			}
		}
		log.Printf("[drive] collected %d ShareSync tasks via API", len(tasks))
		return
	}

	// Fallback: parse mounted ShareSync log files for task health indicators.
	c.collectShareSyncFromLogs(now)
}

// collectShareSyncFromLogs scans the last N lines of each syncfolder.log
// under the mounted @SynologyDriveShareSync directory. It extracts:
// current file being synced, retry counts, recent errors, and backlog hints.
func (c *DriveCollector) collectShareSyncFromLogs(now time.Time) {
	// Look for syncfolder.log under @SynologyDriveShareSync/<share>/log/
	pattern := filepath.Join(shareSyncLogRoot, "*", "log", "syncfolder.log")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) == 0 {
		// Also try the @synologydrive path used by older DSM versions
		pattern2 := "/host/shares/@synologydrive/*/log/syncfolder.log"
		matches, _ = filepath.Glob(pattern2)
	}

	for _, logPath := range matches {
		// Derive a task name from the directory structure
		parts := strings.Split(logPath, string(os.PathSeparator))
		taskName := "sharesync"
		if len(parts) >= 4 {
			// e.g. /host/shares/@SynologyDriveShareSync/<share>/log/syncfolder.log
			taskName = parts[len(parts)-3]
		}

		snap := parseShareSyncLog(logPath)
		snap.NasID      = c.nasID
		snap.CapturedAt = now
		snap.TaskID     = taskName
		snap.TaskName   = taskName
		snap.TaskType   = "sharesync"

		c.sender.QueueSyncTaskSnapshot(snap)
	}

	if len(matches) > 0 {
		log.Printf("[drive] collected %d ShareSync tasks via log fallback", len(matches))
	}
}

// parseShareSyncLog reads the tail of a syncfolder.log and extracts
// task state signals using simple regexp heuristics.
func parseShareSyncLog(logPath string) sender.SyncTaskSnapshotPayload {
	snap := sender.SyncTaskSnapshotPayload{Status: "unknown"}

	f, err := os.Open(logPath)
	if err != nil {
		return snap
	}
	defer f.Close()

	// Read last 200 lines efficiently by scanning and keeping a rolling window
	const maxLines = 200
	lines := make([]string, 0, maxLines)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > maxLines {
			lines = lines[1:]
		}
	}

	var lastError string
	var currentFile string
	var retryCount int
	hasActivity := false

	for _, line := range lines {
		lower := strings.ToLower(line)

		if strings.Contains(lower, "syncing") || strings.Contains(lower, "uploading") || strings.Contains(lower, "downloading") {
			hasActivity = true
			if m := reCurrentFile.FindStringSubmatch(line); len(m) > 1 {
				currentFile = strings.TrimSpace(m[1])
			}
		}

		if m := reRetry.FindStringSubmatch(line); len(m) > 1 {
			n := 0
			fmt.Sscanf(m[1], "%d", &n)
			if n > retryCount {
				retryCount = n
			}
		}

		if strings.Contains(lower, "error") || strings.Contains(lower, "fail") {
			if m := reError.FindStringSubmatch(line); len(m) > 2 {
				lastError = strings.TrimSpace(m[2])
			}
		}
	}

	if hasActivity {
		snap.Status = "running"
	} else if lastError != "" {
		snap.Status = "error"
	} else {
		snap.Status = "idle"
	}

	snap.CurrentFile = currentFile
	snap.RetryCount  = retryCount
	snap.LastError   = lastError

	return snap
}

func (c *DriveCollector) collectDriveLogSignals() {
	entries, err := os.ReadDir(driveLogDir)
	if err != nil {
		return
	}

	type candidate struct {
		path string
		mod  time.Time
	}
	var candidates []candidate
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "syncfolder.log") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		candidates = append(candidates, candidate{
			path: filepath.Join(driveLogDir, name),
			mod:  info.ModTime(),
		})
	}
	if len(candidates) == 0 {
		return
	}

	sort.Slice(candidates, func(i, j int) bool { return candidates[i].mod.After(candidates[j].mod) })
	if len(candidates) > 3 {
		candidates = candidates[:3]
	}

	var renameHits, deleteHits, moveHits, conflictHits, connectHits, disconnectHits, macHits int

	// Event-level data for the delete/rename matcher.
	var events []driveEventRec

	for _, file := range candidates {
		lines, err := tailLines(file.path, 500)
		if err != nil {
			continue
		}
		for _, line := range lines {
			lower := strings.ToLower(line)
			if strings.Contains(lower, "rename") {
				renameHits++
			}
			if strings.Contains(lower, "delete") || strings.Contains(lower, "removed") {
				deleteHits++
			}
			if strings.Contains(lower, "move") || strings.Contains(lower, "moved") {
				moveHits++
			}
			if strings.Contains(lower, "conflict") {
				conflictHits++
			}
			if strings.Contains(lower, "connect") {
				connectHits++
			}
			if strings.Contains(lower, "disconnect") {
				disconnectHits++
			}
			if strings.Contains(lower, "/mac/") {
				macHits++
			}

			// Parse event lines for the rename/delete matcher.
			// Cap at 400 events to keep memory bounded.
			if len(events) < 400 {
				if ev := parseDriveEventLine(line); ev != nil {
					events = append(events, *ev)
				}
			}
		}
	}

	now := time.Now().UTC()
	metrics := map[string]float64{
		"drive_log_rename_hits":     float64(renameHits),
		"drive_log_delete_hits":     float64(deleteHits),
		"drive_log_move_hits":       float64(moveHits),
		"drive_log_conflict_hits":   float64(conflictHits),
		"drive_log_connect_hits":    float64(connectHits),
		"drive_log_disconnect_hits": float64(disconnectHits),
		"drive_log_mac_hits":        float64(macHits),
	}
	for metric, value := range metrics {
		c.sender.QueueMetric(sender.MetricPayload{
			NasID:      c.nasID,
			Type:       metric,
			Value:      value,
			Unit:       "count",
			RecordedAt: now,
		})
	}

	if renameHits+deleteHits+moveHits >= 100 || conflictHits >= 25 || macHits >= 25 {
		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "drive_churn_signal",
			Severity: "warning",
			Message:  fmt.Sprintf("Drive churn signal: rename=%d delete=%d move=%d conflict=%d mac_hits=%d", renameHits, deleteHits, moveHits, conflictHits, macHits),
			Metadata: map[string]interface{}{
				"rename_hits":     renameHits,
				"delete_hits":     deleteHits,
				"move_hits":       moveHits,
				"conflict_hits":   conflictHits,
				"connect_hits":    connectHits,
				"disconnect_hits": disconnectHits,
				"mac_hits":        macHits,
				"log_dir":         driveLogDir,
			},
			LoggedAt: now,
		})
	}

	// Run the delete/rename matcher if we have any events.
	if len(events) > 0 {
		c.emitDriveEventSummary(events, now)
	}
}

// parseDriveEventLine extracts a drive event from a single log line.
// Returns nil if the line does not contain a recognized Native* event.
func parseDriveEventLine(line string) *driveEventRec {
	m := reNativeEvent.FindStringSubmatch(line)
	if len(m) < 2 {
		return nil
	}
	kind := m[1] // Rename, Remove, Upload, Move, Create

	// Extract paths.
	src, dst := extractPathsFromLine(line)
	if src == "" {
		return nil
	}

	return &driveEventRec{kind: kind, src: normalizeName(filepath.Base(src)), dst: normalizeName(filepath.Base(dst))}
}

// extractPathsFromLine extracts the primary and optional secondary (rename target)
// paths from a Drive log line.
func extractPathsFromLine(line string) (src, dst string) {
	// Try single-quoted paths first (most common in Synology Drive logs).
	singles := reSingleQuotedPath.FindAllStringSubmatch(line, 2)
	if len(singles) >= 1 {
		src = singles[0][1]
		if len(singles) >= 2 {
			dst = singles[1][1]
		} else if m := reArrowTarget.FindStringSubmatch(line); len(m) > 1 {
			// Arrow target in same line: -> '/path' or -> /path
			for _, g := range m[1:] {
				if g != "" {
					dst = g
					break
				}
			}
		}
		return
	}
	// Try double-quoted.
	doubles := reDoubleQuotedPath.FindAllStringSubmatch(line, 2)
	if len(doubles) >= 1 {
		src = doubles[0][1]
		if len(doubles) >= 2 {
			dst = doubles[1][1]
		}
		return
	}
	// Try bare /volume* paths.
	bares := reBarePath.FindAllStringSubmatch(line, 2)
	if len(bares) >= 1 {
		src = bares[0][1]
		if len(bares) >= 2 {
			dst = bares[1][1]
		}
		return
	}
	return
}

// normalizeName strips conflict suffixes and lowercases a filename for matching.
func normalizeName(name string) string {
	// Strip extension for matching purposes.
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	// Remove conflict/device suffixes.
	base = reConflictSuffix.ReplaceAllString(base, "")
	// Collapse whitespace, dashes, underscores.
	base = strings.ToLower(strings.TrimSpace(base))
	base = regexp.MustCompile(`[\s_-]+`).ReplaceAllString(base, " ")
	return strings.TrimSpace(base) + strings.ToLower(ext)
}

// emitDriveEventSummary runs the delete/rename matcher and emits a
// drive_event_summary log with the classification and key stats.
func (c *DriveCollector) emitDriveEventSummary(events []driveEventRec, now time.Time) {
	var removes, uploads, renames []string
	for _, ev := range events {
		switch ev.kind {
		case "Remove":
			if ev.src != "" {
				removes = append(removes, ev.src)
			}
		case "Upload", "Create":
			if ev.src != "" {
				uploads = append(uploads, ev.src)
			}
		case "Rename", "Move":
			if ev.dst != "" {
				renames = append(renames, ev.dst)
			}
		}
	}

	if len(removes) == 0 {
		return
	}

	// Build lookup sets.
	uploadSet := make(map[string]bool, len(uploads))
	for _, u := range uploads {
		uploadSet[u] = true
	}
	renameSet := make(map[string]bool, len(renames))
	for _, r := range renames {
		renameSet[r] = true
	}

	type samplePair struct {
		Removed   string `json:"removed"`
		MatchedBy string `json:"matched_by"`
		Match     string `json:"match"`
	}

	var (
		exactMatch        int
		sameBaseSameDir   int
		sameBaseNearDir   int
		renameIntoSubdir  int
		samplePairs       []samplePair
	)

	for _, rem := range removes {
		matched := false
		if uploadSet[rem] {
			exactMatch++
			if len(samplePairs) < 5 {
				samplePairs = append(samplePairs, samplePair{Removed: rem, MatchedBy: "upload", Match: rem})
			}
			matched = true
		} else if renameSet[rem] {
			renameIntoSubdir++
			if len(samplePairs) < 5 {
				samplePairs = append(samplePairs, samplePair{Removed: rem, MatchedBy: "rename_target", Match: rem})
			}
			matched = true
		} else {
			// Check base name (without extension) against uploads and renames.
			remBase := strings.TrimSuffix(rem, filepath.Ext(rem))
			for u := range uploadSet {
				if strings.TrimSuffix(u, filepath.Ext(u)) == remBase {
					sameBaseSameDir++
					if len(samplePairs) < 5 {
						samplePairs = append(samplePairs, samplePair{Removed: rem, MatchedBy: "same_base_upload", Match: u})
					}
					matched = true
					break
				}
			}
			if !matched {
				for r := range renameSet {
					if strings.TrimSuffix(r, filepath.Ext(r)) == remBase {
						sameBaseNearDir++
						if len(samplePairs) < 5 {
							samplePairs = append(samplePairs, samplePair{Removed: rem, MatchedBy: "same_base_rename", Match: r})
						}
						matched = true
						break
					}
				}
			}
		}
		_ = matched
	}

	totalMatched := exactMatch + sameBaseSameDir + sameBaseNearDir + renameIntoSubdir
	matchRate := float64(0)
	if len(removes) > 0 {
		matchRate = float64(totalMatched) / float64(len(removes))
	}

	classification := "mixed"
	if matchRate >= 0.75 {
		classification = "restructure_likely"
	} else if matchRate < 0.25 {
		classification = "destructive_delete_likely"
	}

	// Convert samplePairs to []interface{} for metadata.
	pairsIface := make([]interface{}, len(samplePairs))
	for i, p := range samplePairs {
		pairsIface[i] = map[string]interface{}{
			"removed":    p.Removed,
			"matched_by": p.MatchedBy,
			"match":      p.Match,
		}
	}

	c.sender.QueueLog(sender.LogPayload{
		NasID:    c.nasID,
		Source:   "drive_event_summary",
		Severity: "info",
		Message: fmt.Sprintf("Drive event summary: %d removes, %d uploads, %d renames → classification=%s (match_rate=%.0f%%)",
			len(removes), len(uploads), len(renames), classification, matchRate*100),
		Metadata: map[string]interface{}{
			"remove_count":            len(removes),
			"upload_count":            len(uploads),
			"rename_count":            len(renames),
			"exact_match_count":       exactMatch,
			"same_base_same_dir_count": sameBaseSameDir,
			"same_base_near_dir_count": sameBaseNearDir,
			"rename_into_subdir_count": renameIntoSubdir,
			"classification":          classification,
			"match_rate":              matchRate,
			"sample_pairs":            pairsIface,
		},
		LoggedAt: now,
	})
}

// collectDriveAttribution reads Drive SQLite databases and recent log files
// to extract client device names, users, and active task IDs, then emits a
// drive_client_attribution log entry.
func (c *DriveCollector) collectDriveAttribution() {
	now := time.Now().UTC()

	devices := make(map[string]bool)
	users := make(map[string]bool)
	taskIDs := make(map[string]bool)
	shareNames := make(map[string]bool)
	conflictDevices := make(map[string]bool)

	// 1. Read device/user info from SQLite DBs.
	dbFiles := []string{
		filepath.Join(driveDBDir, "client-udc-db.sqlite"),
		filepath.Join(driveDBDir, "user-db.sqlite"),
		filepath.Join(driveDBDir, "syncfolder-db.sqlite"),
		filepath.Join(driveDBDir, "job-db.sqlite"),
	}

	for _, dbPath := range dbFiles {
		if _, err := os.Stat(dbPath); err != nil {
			continue
		}
		queryDriveDB(dbPath, devices, users, taskIDs, shareNames)
	}

	// 2. Parse recent syncfolder.log lines for task IDs and conflict device names.
	logFiles, _ := filepath.Glob(filepath.Join(driveLogDir, "syncfolder.log*"))
	for _, lf := range logFiles {
		lines, err := tailLines(lf, 200)
		if err != nil {
			continue
		}
		for _, line := range lines {
			// Extract NativeSyncTask IDs.
			if m := reTaskID.FindStringSubmatch(line); len(m) > 1 {
				taskIDs["NativeSyncTask #"+m[1]] = true
			}
			// Extract device names from conflict-style filenames in log lines.
			for _, m := range reConflictDevice.FindAllStringSubmatch(line, -1) {
				if len(m) > 1 && m[1] != "" {
					conflictDevices[m[1]] = true
				}
			}
		}
	}

	allDevices := mapKeys(devices)
	allUsers := mapKeys(users)
	allTaskIDs := mapKeys(taskIDs)
	allShares := mapKeys(shareNames)
	allConflictDevices := mapKeys(conflictDevices)

	if len(allDevices)+len(allConflictDevices) == 0 && len(allTaskIDs) == 0 {
		// Nothing useful found — skip to avoid noise.
		return
	}

	// Determine confidence based on data sources.
	confidence := "low"
	if len(allDevices) > 0 {
		confidence = "medium"
		if len(allUsers) > 0 {
			confidence = "high"
		}
	} else if len(allConflictDevices) > 0 {
		confidence = "low"
	}

	notes := ""
	if len(allDevices) == 0 && len(allConflictDevices) > 0 {
		notes = "Device names inferred from conflict-style filenames only; Drive DB schema may differ."
	}

	// Merge all device sources for the summary message.
	allDevicesCombined := unique(append(allDevices, allConflictDevices...))

	msg := fmt.Sprintf("Drive client attribution: %d device(s), %d user(s), %d task(s)",
		len(allDevicesCombined), len(allUsers), len(allTaskIDs))

	c.sender.QueueLog(sender.LogPayload{
		NasID:    c.nasID,
		Source:   "drive_client_attribution",
		Severity: "info",
		Message:  msg,
		Metadata: map[string]interface{}{
			"devices":               allDevices,
			"users":                 allUsers,
			"task_ids":              allTaskIDs,
			"share_names":           allShares,
			"conflict_device_names": allConflictDevices,
			"confidence":            confidence,
			"notes":                 notes,
		},
		LoggedAt: now,
	})

	log.Printf("[drive] attribution: %s (confidence=%s)", msg, confidence)
}

// queryDriveDB opens a single Drive SQLite database and extracts device names,
// usernames, task IDs, and share names using schema discovery.
func queryDriveDB(path string, devices, users, taskIDs, shareNames map[string]bool) {
	db, err := sql.Open("sqlite3", path+"?mode=ro&_timeout=3000")
	if err != nil {
		return
	}
	defer db.Close()
	db.SetMaxOpenConns(1)

	// Discover all tables.
	tables, err := discoverTables(db)
	if err != nil {
		return
	}

	for _, table := range tables {
		cols, err := discoverColumns(db, table)
		if err != nil {
			continue
		}
		colSet := make(map[string]bool, len(cols))
		for _, c := range cols {
			colSet[strings.ToLower(c)] = true
		}

		// Look for device/hostname/client name columns.
		deviceCols := filterCols(cols, []string{"device_name", "hostname", "host_name", "client_name", "machine_name", "name"})
		if len(deviceCols) > 0 {
			extractStrings(db, table, deviceCols[0], 50, devices)
		}

		// Look for user/account columns.
		userCols := filterCols(cols, []string{"username", "user_name", "account", "owner", "user"})
		if len(userCols) > 0 {
			extractStrings(db, table, userCols[0], 50, users)
		}

		// Look for task ID columns.
		taskCols := filterCols(cols, []string{"task_id", "taskid", "job_id", "sync_task_id"})
		if len(taskCols) > 0 {
			extractStrings(db, table, taskCols[0], 30, taskIDs)
		}

		// Look for share name columns.
		shareCols := filterCols(cols, []string{"share_name", "share", "folder_name", "folder", "volume_path"})
		if len(shareCols) > 0 {
			extractStrings(db, table, shareCols[0], 20, shareNames)
		}
	}
}

// discoverTables returns all user table names in a SQLite DB.
func discoverTables(db *sql.DB) ([]string, error) {
	rows, err := db.Query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err == nil {
			tables = append(tables, name)
		}
	}
	return tables, rows.Err()
}

// discoverColumns returns column names for a table.
func discoverColumns(db *sql.DB, table string) ([]string, error) {
	rows, err := db.Query(fmt.Sprintf("PRAGMA table_info(%q)", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var dflt interface{}
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err == nil {
			cols = append(cols, name)
		}
	}
	return cols, rows.Err()
}

// filterCols returns columns matching preferred names (in order of preference).
func filterCols(cols, preferred []string) []string {
	colLower := make([]string, len(cols))
	for i, c := range cols {
		colLower[i] = strings.ToLower(c)
	}
	var result []string
	for _, pref := range preferred {
		for i, low := range colLower {
			if low == pref {
				result = append(result, cols[i])
				break
			}
		}
	}
	return result
}

// extractStrings reads up to maxRows non-empty string values from a column.
func extractStrings(db *sql.DB, table, col string, maxRows int, out map[string]bool) {
	rows, err := db.Query(
		fmt.Sprintf("SELECT DISTINCT %q FROM %q WHERE %q IS NOT NULL AND %q != '' LIMIT %d",
			col, table, col, col, maxRows),
	)
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var val string
		if err := rows.Scan(&val); err == nil && val != "" {
			// Skip internal/system values.
			if !strings.HasPrefix(val, "syno") && !strings.HasPrefix(val, "/volume") {
				out[val] = true
			}
		}
	}
}

// mapKeys returns the keys of a string set as a sorted slice.
func mapKeys(m map[string]bool) []string {
	result := make([]string, 0, len(m))
	for k := range m {
		result = append(result, k)
	}
	sort.Strings(result)
	return result
}

// unique returns a deduplicated slice of strings.
func unique(ss []string) []string {
	seen := make(map[string]bool, len(ss))
	result := make([]string, 0, len(ss))
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			result = append(result, s)
		}
	}
	return result
}

func tailLines(path string, maxLines int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	lines := make([]string, 0, maxLines)
	scanner := bufio.NewScanner(f)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
		if len(lines) > maxLines {
			lines = lines[1:]
		}
	}
	return lines, scanner.Err()
}
