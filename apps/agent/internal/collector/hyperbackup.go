package collector

import (
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

// HyperBackupCollector polls Hyper Backup task state every interval.
type HyperBackupCollector struct {
	dsmClient *dsm.Client
	sender    *sender.Sender
	nasID     string
	interval  time.Duration
}

// NewHyperBackupCollector creates a new HyperBackupCollector.
func NewHyperBackupCollector(dsmClient *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *HyperBackupCollector {
	return &HyperBackupCollector{
		dsmClient: dsmClient,
		sender:    s,
		nasID:     nasID,
		interval:  interval,
	}
}

// Run starts the polling loop.
func (c *HyperBackupCollector) Run(stop <-chan struct{}) {
	log.Printf("[hyperbackup] started (every %s)", c.interval)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.collect()
	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[hyperbackup] stopped")
			return
		}
	}
}

func (c *HyperBackupCollector) collect() {
	now := time.Now().UTC()

	tasks, err := c.dsmClient.GetHyperBackupTasks()
	if err != nil {
		log.Printf("[hyperbackup] API error: %v", err)
		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "hyperbackup",
			Severity: "warning",
			Message:  "Hyper Backup API unavailable: " + err.Error(),
			LoggedAt: now,
		})
		tasks = collectHyperBackupFallbackTasks()
	}
	if len(tasks) == 0 {
		tasks = collectHyperBackupFallbackTasks()
	}
	if len(tasks) == 0 {
		return
	}

	for _, t := range tasks {
		c.sender.QueueBackupTask(sender.BackupTaskPayload{
			NasID:            c.nasID,
			TaskID:           t.ID,
			TaskName:         t.Name,
			Enabled:          t.Enabled,
			Status:           t.Status,
			LastResult:       t.LastResult,
			LastRunTime:      t.LastRunTime,
			NextRunTime:      t.NextRunTime,
			DestType:         t.DestType,
			DestName:         t.DestName,
			TotalBytes:       t.TotalBytes,
			TransferredBytes: t.TransferredBytes,
			SpeedBPS:         t.SpeedBPS,
			CapturedAt:       now,
		})

		// Log failed tasks as error severity
		if isFailed(t.LastResult, t.Status) {
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "hyperbackup",
				Severity: "error",
				Message:  fmt.Sprintf("Hyper Backup task %q failed: result=%s status=%s", t.Name, t.LastResult, t.Status),
				Metadata: map[string]interface{}{
					"task_id":     t.ID,
					"task_name":   t.Name,
					"last_result": t.LastResult,
					"status":      t.Status,
					"dest_type":   t.DestType,
					"dest_name":   t.DestName,
				},
				LoggedAt: now,
			})
		}
	}

	log.Printf("[hyperbackup] collected %d backup tasks", len(tasks))
}

func collectHyperBackupFallbackTasks() []dsm.BackupTask {
	statePath := "/host/appdata/HyperBackup/config/task_state.conf"
	resultPath := "/host/appdata/HyperBackup/last_result/backup.last"

	taskStates := parseIniSections(readSmallFile(statePath))
	taskResults := parseIniSections(readSmallFile(resultPath))
	if len(taskResults) == 0 {
		return nil
	}

	var tasks []dsm.BackupTask
	for section, fields := range taskResults {
		if !strings.HasPrefix(section, "task_") {
			continue
		}
		taskID := strings.TrimPrefix(section, "task_")
		stateFields := taskStates[section]
		status := firstNonEmpty(stateFields["state"], stateFields["last_state"])
		tasks = append(tasks, dsm.BackupTask{
			ID:          taskID,
			Name:        firstNonEmpty(fields["task_name"], section),
			Status:      status,
			LastResult:  fields["result"],
			LastRunTime: unixToRFC3339(fields["end_time"]),
			DestName:    fields["dest_name"],
			DestType:    fields["dest_type"],
			TotalBytes:  parseInt64(fields["target_size"]),
		})
	}
	return tasks
}

func parseInt64(raw string) int64 {
	value, _ := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	return value
}

// isFailed returns true when the result or status indicates a failure.
func isFailed(lastResult, status string) bool {
	lr := strings.ToLower(lastResult)
	st := strings.ToLower(status)
	if n, err := strconv.Atoi(strings.TrimSpace(lastResult)); err == nil {
		return n != 0
	}
	return strings.Contains(lr, "fail") ||
		strings.Contains(lr, "error") ||
		strings.Contains(lr, "warn") ||
		strings.Contains(st, "fail") ||
		strings.Contains(st, "error") ||
		strings.Contains(st, "warn")
}
