package collector

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

const mdstatPath = "/host/proc/mdstat"

var (
	// md0 : active raid5 sda[0] sdb[1] sdc[2]
	reMdDevice = regexp.MustCompile(`^(md\d+)\s*:\s*(\w+)\s+(\w+)`)
	// [UU_] or [UUU] degraded state
	reMdState = regexp.MustCompile(`\[([U_]+)\]`)
	// resync =  5.3% (nnn/nnn) finish=nn.nmin speed=nnK/sec
	reMdProgress = regexp.MustCompile(`(?:resync|recovery|check|reshape)\s*=\s*([\d.]+)%`)
	reMdAction   = regexp.MustCompile(`^\s+(resync|recovery|check|reshape)\s*=`)
)

// StoragePoolCollector has two responsibilities:
//  1. Every 60s: reads /host/proc/mdstat for RAID scrub/rebuild/check progress.
//  2. Every 5m:  calls GetSnapshotReplicationTasks and queues results.
type StoragePoolCollector struct {
	dsmClient    *dsm.Client
	sender       *sender.Sender
	nasID        string
	mdstatTick   time.Duration
	snapshotTick time.Duration
}

// NewStoragePoolCollector creates a StoragePoolCollector with sensible defaults.
func NewStoragePoolCollector(dsmClient *dsm.Client, s *sender.Sender, nasID string) *StoragePoolCollector {
	return &StoragePoolCollector{
		dsmClient:    dsmClient,
		sender:       s,
		nasID:        nasID,
		mdstatTick:   60 * time.Second,
		snapshotTick: 5 * time.Minute,
	}
}

// Run starts both polling loops using separate tickers.
func (c *StoragePoolCollector) Run(stop <-chan struct{}) {
	log.Printf("[storagepool] started (mdstat every %s, snapshots every %s)", c.mdstatTick, c.snapshotTick)

	mdTicker := time.NewTicker(c.mdstatTick)
	snapTicker := time.NewTicker(c.snapshotTick)
	defer mdTicker.Stop()
	defer snapTicker.Stop()

	// Run both immediately on startup
	c.collectMdstat()
	c.collectSnapshotReplicas()

	for {
		select {
		case <-mdTicker.C:
			c.collectMdstat()
		case <-snapTicker.C:
			c.collectSnapshotReplicas()
		case <-stop:
			log.Println("[storagepool] stopped")
			return
		}
	}
}

// collectMdstat reads /host/proc/mdstat and emits metrics/logs.
func (c *StoragePoolCollector) collectMdstat() {
	now := time.Now().UTC()

	f, err := os.Open(mdstatPath)
	if err != nil {
		// Not fatal — NAS may not expose /proc/mdstat via this path
		return
	}
	defer f.Close()

	type mdDevice struct {
		name     string
		raidType string
		state    string // e.g. "active", "degraded"
		health   string // e.g. "UUUU" or "UU_U"
		action   string // resync / recovery / check / reshape
		pct      float64
	}

	var devices []mdDevice
	var current *mdDevice

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()

		if m := reMdDevice.FindStringSubmatch(line); len(m) == 4 {
			dev := mdDevice{
				name:     m[1],
				state:    m[2],
				raidType: m[3],
			}
			// Check for degraded marker [U_U] on same line
			if ms := reMdState.FindStringSubmatch(line); len(ms) == 2 {
				dev.health = ms[1]
				if strings.Contains(ms[1], "_") {
					dev.state = "degraded"
				}
			}
			devices = append(devices, dev)
			current = &devices[len(devices)-1]
			continue
		}

		// Continuation lines for the current device
		if current == nil {
			continue
		}

		// Update health marker if on its own line
		if ms := reMdState.FindStringSubmatch(line); len(ms) == 2 && current.health == "" {
			current.health = ms[1]
			if strings.Contains(ms[1], "_") {
				current.state = "degraded"
			}
		}

		// Detect active operation and parse progress percentage
		if reMdAction.MatchString(line) {
			if ma := regexp.MustCompile(`(resync|recovery|check|reshape)`).FindString(line); ma != "" {
				current.action = ma
			}
		}
		if mp := reMdProgress.FindStringSubmatch(line); len(mp) == 2 {
			if pct, err2 := strconv.ParseFloat(mp[1], 64); err2 == nil {
				current.pct = pct
				if current.action == "" {
					current.action = "resync"
				}
			}
		}
	}

	for _, dev := range devices {
		// Emit progress metric whenever an operation is running
		if dev.action != "" {
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID,
				Type:  "raid_scrub_progress",
				Value: dev.pct,
				Unit:  "percent",
				Metadata: map[string]interface{}{
					"device":    dev.name,
					"raid_type": dev.raidType,
					"action":    dev.action,
					"health":    dev.health,
				},
				RecordedAt: now,
			})

			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "storage",
				Severity: "info",
				Message:  fmt.Sprintf("RAID %s %s in progress on %s (%.1f%%)", dev.raidType, dev.action, dev.name, dev.pct),
				Metadata: map[string]interface{}{
					"device":    dev.name,
					"raid_type": dev.raidType,
					"action":    dev.action,
					"pct":       dev.pct,
					"health":    dev.health,
				},
				LoggedAt: now,
			})
		}

		// Log degraded arrays regardless of active operation
		if dev.state == "degraded" {
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "storage",
				Severity: "error",
				Message:  fmt.Sprintf("RAID array %s is degraded (type=%s health=%s)", dev.name, dev.raidType, dev.health),
				Metadata: map[string]interface{}{
					"device":    dev.name,
					"raid_type": dev.raidType,
					"state":     dev.state,
					"health":    dev.health,
				},
				LoggedAt: now,
			})
		}
	}
}

// collectSnapshotReplicas queries DSM for snapshot replication tasks.
func (c *StoragePoolCollector) collectSnapshotReplicas() {
	now := time.Now().UTC()

	tasks, err := c.dsmClient.GetSnapshotReplicationTasks()
	if err != nil {
		log.Printf("[storagepool] snapshot replication API error: %v", err)
		c.sender.QueueLog(sender.LogPayload{
			NasID:    c.nasID,
			Source:   "storage",
			Severity: "warning",
			Message:  "Snapshot replication API unavailable: " + err.Error(),
			LoggedAt: now,
		})
		return
	}
	if len(tasks) == 0 {
		return
	}

	for _, t := range tasks {
		c.sender.QueueSnapshotReplica(sender.SnapshotReplicaPayload{
			NasID:       c.nasID,
			TaskID:      t.ID,
			TaskName:    t.Name,
			Status:      t.Status,
			SrcShare:    t.SrcShareName,
			DstShare:    t.DstShareName,
			DstHost:     t.DstHost,
			LastResult:  t.LastResult,
			LastRunTime: t.LastRunTime,
			NextRunTime: t.NextRunTime,
			CapturedAt:  now,
		})
	}

	log.Printf("[storagepool] collected %d snapshot replication tasks", len(tasks))
}
