package collector

import (
	"bufio"
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
)

// shareSyncLogRoot is the container-side mount of @SynologyDriveShareSync.
// This is mounted read-only as /host/shares/@SynologyDriveShareSync.
const shareSyncLogRoot = "/host/shares/@SynologyDriveShareSync"

// Regexps for log-based ShareSync heuristics.
var (
	reCurrentFile   = regexp.MustCompile(`(?i)syncing[:\s]+(.+)$`)
	reRetry         = regexp.MustCompile(`(?i)retry[:\s#]+(\d+)`)
	reError         = regexp.MustCompile(`(?i)(error|fail)[:\s]+(.{0,200})`)
	reBacklog       = regexp.MustCompile(`(?i)remaining[:\s]+(\d+)`)
)

// DriveCollector collects Drive team folders and user activity via DSM API
type DriveCollector struct {
	client   *dsm.Client
	sender   *sender.Sender
	nasID    string
	interval time.Duration
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
	// Collect team folders
	c.collectTeamFolders()

	// Collect user activity
	c.collectUserActivity()

	// Collect Drive stats
	c.collectStats()

	// Collect ShareSync task snapshots (API-first, log-based fallback)
	c.collectShareSyncTasks()

	// Low-impact anomaly scan over recent Drive sync logs.
	c.collectDriveLogSignals()
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

	tasks, err := c.client.GetShareSyncTasks()
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
	logDir := "/host/shares/@synologydrive/log"
	entries, err := os.ReadDir(logDir)
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
			path: filepath.Join(logDir, name),
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
	for _, file := range candidates {
		lines, err := tailLines(file.path, 300)
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
				"log_dir":         logDir,
			},
			LoggedAt: now,
		})
	}
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
