package collector

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
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
