package collector

// ShareHealthCollector periodically fetches share configuration, installed
// packages, and structured system logs via the DSM API.
//
// This data is critical for diagnosing share database errors ("Failed to
// SYNOShareGet"), broken package registrations, and service-level issues
// that only appear in DSM's Log Center, not in text log files.

import (
	"encoding/json"
	"log"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

type ShareHealthCollector struct {
	dsmClient *dsm.Client
	sender    *sender.Sender
	nasID     string
	interval  time.Duration
}

func NewShareHealthCollector(dsmClient *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *ShareHealthCollector {
	return &ShareHealthCollector{
		dsmClient: dsmClient,
		sender:    s,
		nasID:     nasID,
		interval:  interval,
	}
}

func (c *ShareHealthCollector) Run(stop <-chan struct{}) {
	log.Printf("[share-health] started (every %s)", c.interval)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.collect()
	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[share-health] stopped")
			return
		}
	}
}

func (c *ShareHealthCollector) collect() {
	now := time.Now().UTC()
	c.collectShares(now)
	c.collectPackages(now)
	c.collectSystemLogs(now)
}

func (c *ShareHealthCollector) collectShares(now time.Time) {
	shares, err := c.dsmClient.GetShares()
	if err != nil {
		log.Printf("[share-health] share list failed: %v", err)
		// Log the failure itself — it may indicate the share DB is corrupted
		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "share_health",
			Severity: "warning",
			Message:  "Failed to enumerate shares via DSM API: " + err.Error(),
			LoggedAt: now,
		})
		return
	}

	for _, share := range shares {
		meta := map[string]interface{}{
			"path":        share.Path,
			"description": share.Description,
			"encrypted":   share.Encryption > 0,
			"recycle_bin":  share.RecycleBinEnabled,
		}
		// Merge additional fields if present
		for k, v := range share.Additional {
			meta[k] = v
		}

		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "share_config",
			Severity: "info",
			Message:  "share=" + share.Name + " path=" + share.Path,
			Metadata: meta,
			LoggedAt: now,
		})
	}
}

func (c *ShareHealthCollector) collectPackages(now time.Time) {
	packages, err := c.dsmClient.GetInstalledPackages()
	if err != nil {
		log.Printf("[share-health] package list failed: %v", err)
		return
	}

	// Only log packages relevant to Drive/sync/file services
	relevant := map[string]bool{
		"SynologyDrive":          true,
		"SynologyDriveShareSync": true,
		"CloudSync":              true,
		"HyperBackup":            true,
		"MinimServer":            true,
		"Plex Media Server":      true,
		"Node.js":                true,
		"Docker":                 true,
		"ContainerManager":       true,
	}

	for _, pkg := range packages {
		if !relevant[pkg.ID] && !relevant[pkg.Name] {
			continue
		}
		severity := "info"
		if pkg.Status != "running" && pkg.Status != "" {
			severity = "warning"
		}

		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "package_health",
			Severity: severity,
			Message:  "package=" + pkg.Name + " version=" + pkg.Version + " status=" + pkg.Status,
			Metadata: map[string]interface{}{
				"id":      pkg.ID,
				"name":    pkg.Name,
				"version": pkg.Version,
				"status":  pkg.Status,
				"type":    pkg.Type,
			},
			LoggedAt: now,
		})
	}
}

func (c *ShareHealthCollector) collectSystemLogs(now time.Time) {
	logs, err := c.dsmClient.GetRecentSystemLogs(50)
	if err != nil {
		log.Printf("[share-health] system logs API failed: %v", err)
		return
	}

	for _, entry := range logs {
		severity := "info"
		if entry.Level >= 4 {
			severity = "error"
		} else if entry.Level >= 3 {
			severity = "warning"
		}

		meta := map[string]interface{}{}
		if entry.Who != "" {
			meta["user"] = entry.Who
		}
		if entry.LogName != "" {
			meta["log_name"] = entry.LogName
		}

		msg := entry.Descr
		if msg == "" {
			msg = entry.Message
		}
		if msg == "" {
			// Try to serialize the whole entry
			b, _ := json.Marshal(entry)
			msg = string(b)
		}

		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "dsm_system_log",
			Severity: severity,
			Message:  msg,
			Metadata: meta,
			LoggedAt: now,
		})
	}
}
