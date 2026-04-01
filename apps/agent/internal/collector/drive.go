package collector

import (
	"log"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
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
