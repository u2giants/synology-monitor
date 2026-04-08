package collector

// ShareHealthCollector periodically fetches share configuration, installed
// packages, and structured system logs via the DSM API.
//
// This data is critical for diagnosing share database errors ("Failed to
// SYNOShareGet"), broken package registrations, and service-level issues
// that only appear in DSM's Log Center, not in text log files.

import (
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

type ShareHealthCollector struct {
	dsmClient    *dsm.Client
	sender       *sender.Sender
	nasID        string
	interval     time.Duration
	logWatermark time.Time
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
			"recycle_bin": share.RecycleBinEnabled,
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

	c.collectShareQuotas(shares, now)
}

// collectShareQuotas inspects each share's quota fields and emits usage metrics
// and log entries when usage is high.
func (c *ShareHealthCollector) collectShareQuotas(shares []dsm.ShareInfo, now time.Time) {
	for _, share := range shares {
		if len(share.Additional) == 0 {
			continue
		}

		// Extract quota_value (total) and quota_used from the Additional map.
		quotaBytes := toInt64(share.Additional["quota_value"])
		if quotaBytes == 0 {
			quotaBytes = toInt64(share.Additional["quota"])
		}
		usedBytes := toInt64(share.Additional["quota_used"])

		if quotaBytes <= 0 {
			continue
		}

		pct := float64(usedBytes) / float64(quotaBytes) * 100.0
		if pct < 0 {
			pct = 0
		}

		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID,
			Type:  "share_quota_usage",
			Value: pct,
			Unit:  "percent",
			Metadata: map[string]interface{}{
				"share_name":  share.Name,
				"quota_bytes": quotaBytes,
				"used_bytes":  usedBytes,
			},
			RecordedAt: now,
		})

		if pct < 85 {
			continue
		}

		severity := "warning"
		if pct >= 95 {
			severity = "error"
		}

		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "share_quota",
			Severity: severity,
			Message:  fmt.Sprintf("Share %q quota at %.1f%% (%d / %d bytes)", share.Name, pct, usedBytes, quotaBytes),
			Metadata: map[string]interface{}{
				"share_name":  share.Name,
				"quota_bytes": quotaBytes,
				"used_bytes":  usedBytes,
				"pct":         pct,
			},
			LoggedAt: now,
		})
	}
}

// toInt64 converts a map value to int64, supporting float64 and string.
func toInt64(v interface{}) int64 {
	if v == nil {
		return 0
	}
	switch val := v.(type) {
	case float64:
		return int64(val)
	case int64:
		return val
	case int:
		return int64(val)
	case string:
		var n int64
		fmt.Sscanf(val, "%d", &n)
		return n
	}
	return 0
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

// logTimeFormats are the formats we attempt when parsing the DSM log entry
// time string (DSM versions vary).
var logTimeFormats = []string{
	"2006/01/02 15:04:05",
	"2006-01-02 15:04:05",
	time.RFC3339,
}

func (c *ShareHealthCollector) collectSystemLogs(now time.Time) {
	logs, err := c.dsmClient.GetRecentSystemLogs(200)
	if err != nil {
		log.Printf("[share-health] system logs API failed: %v", err)
		return
	}

	var newest time.Time

	for _, entry := range logs {
		// Parse the entry timestamp
		var entryTime time.Time
		for _, fmt2 := range logTimeFormats {
			if t, err2 := time.Parse(fmt2, entry.Time); err2 == nil {
				entryTime = t
				break
			}
		}

		// Skip entries we have already processed
		if !entryTime.IsZero() && !entryTime.After(c.logWatermark) {
			continue
		}

		// Track the newest timestamp seen this cycle
		if entryTime.After(newest) {
			newest = entryTime
		}

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

		loggedAt := now
		if !entryTime.IsZero() {
			loggedAt = entryTime
		}

		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "dsm_system_log",
			Severity: severity,
			Message:  msg,
			Metadata: meta,
			LoggedAt: loggedAt,
		})
	}

	// Advance watermark to avoid reprocessing the same entries
	if newest.After(c.logWatermark) {
		c.logWatermark = newest
	}
}
