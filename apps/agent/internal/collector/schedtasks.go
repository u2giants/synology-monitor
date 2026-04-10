package collector

import (
	"fmt"
	"log"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

// ScheduledTaskCollector polls ALL DSM scheduled tasks every interval and
// records their status, last result, and next run time.
type ScheduledTaskCollector struct {
	dsmClient *dsm.Client
	sender    *sender.Sender
	nasID     string
	interval  time.Duration
}

// NewScheduledTaskCollector creates a new ScheduledTaskCollector.
func NewScheduledTaskCollector(dsmClient *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *ScheduledTaskCollector {
	return &ScheduledTaskCollector{
		dsmClient: dsmClient,
		sender:    s,
		nasID:     nasID,
		interval:  interval,
	}
}

// Run starts the polling loop.
func (c *ScheduledTaskCollector) Run(stop <-chan struct{}) {
	log.Printf("[schedtasks] started (every %s)", c.interval)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.collect()
	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[schedtasks] stopped")
			return
		}
	}
}

func (c *ScheduledTaskCollector) collect() {
	now := time.Now().UTC()

	tasks, err := c.dsmClient.GetAllScheduledTasks()
	if err != nil {
		log.Printf("[schedtasks] API error: %v", err)
		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "scheduled_task",
			Severity: "warning",
			Message:  "Scheduled task API unavailable: " + err.Error(),
			LoggedAt: now,
		})
		return
	}
	if len(tasks) == 0 {
		return
	}

	for _, t := range tasks {
		c.sender.QueueScheduledTask(sender.ScheduledTaskPayload{
			NasID:       c.nasID,
			TaskID:      t.ID,
			TaskName:    t.Name,
			TaskType:    t.Type,
			Owner:       t.Owner,
			Enabled:     t.Enable,
			Status:      t.Status,
			LastRunTime: t.LastRun,
			NextRunTime: t.NextTime,
			LastResult:  t.LastResult,
			CapturedAt:  now,
		})

		// Log any task with non-zero last_result as a warning
		if t.LastResult != 0 {
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "scheduled_task",
				Severity: "warning",
				Message:  fmt.Sprintf("Scheduled task %q exited with code %d", t.Name, t.LastResult),
				Metadata: map[string]interface{}{
					"task_id":     t.ID,
					"task_name":   t.Name,
					"task_type":   t.Type,
					"owner":       t.Owner,
					"last_result": t.LastResult,
					"last_run":    t.LastRun,
				},
				LoggedAt: now,
			})
		}
	}

	log.Printf("[schedtasks] collected %d scheduled tasks", len(tasks))
}
