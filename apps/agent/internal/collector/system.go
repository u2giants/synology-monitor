package collector

import (
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

// SystemCollector collects CPU, memory, network metrics
type SystemCollector struct {
	client   *dsm.Client
	sender   *sender.Sender
	nasID    string
	interval time.Duration
}

func NewSystemCollector(client *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *SystemCollector {
	return &SystemCollector{
		client:   client,
		sender:   s,
		nasID:    nasID,
		interval: interval,
	}
}

func (c *SystemCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[system] collector started (interval: %s)", c.interval)

	// Collect immediately on start
	c.collect()

	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[system] collector stopped")
			return
		}
	}
}

func (c *SystemCollector) collect() {
	util, err := c.client.GetSystemUtilization()
	if err != nil {
		log.Printf("[system] error getting utilization: %v", err)
		return
	}

	now := time.Now().UTC()

	// CPU metrics
	cpuTotal := float64(util.CPU.SystemLoad + util.CPU.UserLoad)
	c.sender.QueueMetric(sender.MetricPayload{
		NasID:      c.nasID,
		Type:       "cpu_usage",
		Value:      cpuTotal,
		Unit:       "percent",
		RecordedAt: now,
	})

	// Load averages
	c.sender.QueueMetric(sender.MetricPayload{
		NasID: c.nasID, Type: "system_load_1",
		Value: float64(util.CPU.OneMinLoad) / 100.0, Unit: "load", RecordedAt: now,
	})
	c.sender.QueueMetric(sender.MetricPayload{
		NasID: c.nasID, Type: "system_load_5",
		Value: float64(util.CPU.FiveMinLoad) / 100.0, Unit: "load", RecordedAt: now,
	})
	c.sender.QueueMetric(sender.MetricPayload{
		NasID: c.nasID, Type: "system_load_15",
		Value: float64(util.CPU.FifteenMinLoad) / 100.0, Unit: "load", RecordedAt: now,
	})

	// Memory metrics
	if util.Memory.TotalReal > 0 {
		memUsedPct := float64(util.Memory.RealUsage)
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "memory_usage",
			Value: memUsedPct, Unit: "percent", RecordedAt: now,
		})
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "memory_total",
			Value: float64(util.Memory.TotalReal) * 1024, Unit: "bytes", RecordedAt: now,
		})
	}

	// Network metrics (aggregate all interfaces)
	var totalRX, totalTX int64
	for _, net := range util.Network {
		totalRX += net.RX
		totalTX += net.TX
	}
	c.sender.QueueMetric(sender.MetricPayload{
		NasID: c.nasID, Type: "network_rx",
		Value: float64(totalRX), Unit: "bytes/s", RecordedAt: now,
	})
	c.sender.QueueMetric(sender.MetricPayload{
		NasID: c.nasID, Type: "network_tx",
		Value: float64(totalTX), Unit: "bytes/s", RecordedAt: now,
	})

	log.Printf("[system] collected: cpu=%.1f%% mem=%d%% net_rx=%d net_tx=%d",
		cpuTotal, util.Memory.RealUsage, totalRX, totalTX)
}

// StorageCollector collects SMART, RAID, volume metrics
type StorageCollector struct {
	client           *dsm.Client
	sender           *sender.Sender
	nasID            string
	interval         time.Duration
	prevVolumeStatus map[string]string
	prevDiskHealth   map[string]string
}

func NewStorageCollector(client *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *StorageCollector {
	return &StorageCollector{
		client:           client,
		sender:           s,
		nasID:            nasID,
		interval:         interval,
		prevVolumeStatus: make(map[string]string),
		prevDiskHealth:   make(map[string]string),
	}
}

func (c *StorageCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[storage] collector started (interval: %s)", c.interval)
	c.collect()

	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[storage] collector stopped")
			return
		}
	}
}

func (c *StorageCollector) collect() {
	info, err := c.client.GetStorageInfo()
	if err != nil {
		log.Printf("[storage] error getting storage info: %v", err)
		return
	}

	now := time.Now().UTC()

	// Volume snapshots
	for _, vol := range info.Volumes {
		status := "normal"
		switch vol.Status {
		case "crashed":
			status = "crashed"
		case "degraded":
			status = "degraded"
		case "normal":
			status = "normal"
		default:
			status = "unknown"
		}

		c.sender.QueueStorageSnapshot(sender.StoragePayload{
			NasID:      c.nasID,
			VolumeID:   vol.ID,
			VolumePath: vol.VolPath,
			TotalBytes: vol.TotalSize,
			UsedBytes:  vol.UsedSize,
			Status:     status,
			RaidType:   vol.RaidType,
			Disks:      convertDisks(info.Disks),
			RecordedAt: now,
		})

		// Volume usage as metric
		if vol.TotalSize > 0 {
			usedPct := float64(vol.UsedSize) / float64(vol.TotalSize) * 100.0
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID, Type: fmt.Sprintf("volume_usage_%s", vol.ID),
				Value: usedPct, Unit: "percent", RecordedAt: now,
			})
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID, Type: "volume_used_bytes",
				Value: float64(vol.UsedSize), Unit: "bytes", RecordedAt: now,
				Metadata: map[string]interface{}{"volume_id": vol.ID, "volume_path": vol.VolPath},
			})
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID, Type: "volume_free_bytes",
				Value: float64(vol.TotalSize - vol.UsedSize), Unit: "bytes", RecordedAt: now,
				Metadata: map[string]interface{}{"volume_id": vol.ID, "volume_path": vol.VolPath},
			})
		}

		if prev := c.prevVolumeStatus[vol.ID]; prev != "" && prev != status {
			severity := "warning"
			if status == "crashed" || status == "degraded" {
				severity = "error"
			}
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "storage_health",
				Severity: severity,
				Message:  fmt.Sprintf("Volume %s status changed: %s -> %s", vol.VolPath, prev, status),
				Metadata: map[string]interface{}{"volume_id": vol.ID, "volume_path": vol.VolPath, "previous_status": prev, "status": status},
				LoggedAt: now,
			})
		}
		c.prevVolumeStatus[vol.ID] = status
	}

	// Disk temperatures
	for _, disk := range info.Disks {
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "temperature_disk",
			Value: float64(disk.Temp), Unit: "celsius",
			Metadata:   map[string]interface{}{"disk_id": disk.ID, "disk_name": disk.Name},
			RecordedAt: now,
		})

		smartHealthy := 1.0
		if normalized := strings.ToLower(strings.TrimSpace(disk.SmartStatus)); normalized != "" &&
			normalized != "normal" && normalized != "healthy" && normalized != "passed" {
			smartHealthy = 0
		}
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "disk_smart_healthy",
			Value: smartHealthy, Unit: "bool", RecordedAt: now,
			Metadata: map[string]interface{}{"disk_id": disk.ID, "disk_name": disk.Name, "smart_status": disk.SmartStatus},
		})

		if prev := c.prevDiskHealth[disk.ID]; prev != "" && prev != disk.SmartStatus {
			severity := "warning"
			if smartHealthy == 0 {
				severity = "error"
			}
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "disk_health",
				Severity: severity,
				Message:  fmt.Sprintf("Disk %s SMART status changed: %s -> %s", disk.Name, prev, disk.SmartStatus),
				Metadata: map[string]interface{}{"disk_id": disk.ID, "disk_name": disk.Name, "previous_status": prev, "smart_status": disk.SmartStatus},
				LoggedAt: now,
			})
		}
		c.prevDiskHealth[disk.ID] = disk.SmartStatus
	}

	log.Printf("[storage] collected: %d volumes, %d disks", len(info.Volumes), len(info.Disks))
}

func convertDisks(disks []dsm.DiskInfo) []sender.DiskPayload {
	result := make([]sender.DiskPayload, len(disks))
	for i, d := range disks {
		result[i] = sender.DiskPayload{
			ID:          d.ID,
			Name:        d.Name,
			Model:       d.Model,
			Serial:      d.Serial,
			SizeBytes:   d.SizeTotal,
			Temperature: d.Temp,
			SmartStatus: d.SmartStatus,
		}
	}
	return result
}

// DockerCollector collects Docker container status
type DockerCollector struct {
	client     *dsm.Client
	sender     *sender.Sender
	nasID      string
	interval   time.Duration
	prevStatus map[string]string
	prevUptime map[string]int64
	restarts   map[string]int
}

func NewDockerCollector(client *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *DockerCollector {
	return &DockerCollector{
		client:     client,
		sender:     s,
		nasID:      nasID,
		interval:   interval,
		prevStatus: make(map[string]string),
		prevUptime: make(map[string]int64),
		restarts:   make(map[string]int),
	}
}

func (c *DockerCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[docker] collector started (interval: %s)", c.interval)
	c.collect()

	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[docker] collector stopped")
			return
		}
	}
}

func (c *DockerCollector) collect() {
	containers, err := c.client.GetDockerContainers()
	if err != nil {
		log.Printf("[docker] error getting containers: %v", err)
		return
	}

	now := time.Now().UTC()

	for _, ct := range containers {
		status := "stopped"
		switch ct.Status {
		case "running":
			status = "running"
		case "paused":
			status = "paused"
		case "restarting":
			status = "restarting"
		case "exited":
			status = "exited"
		default:
			status = "stopped"
		}

		c.sender.QueueContainerStatus(sender.ContainerPayload{
			NasID:         c.nasID,
			ContainerID:   ct.ID,
			ContainerName: ct.Name,
			Image:         ct.Image,
			Status:        status,
			CPUPercent:    ct.CPUUsage,
			MemoryBytes:   ct.MemUsage,
			MemLimitBytes: ct.MemLimit,
			UptimeSeconds: ct.UpTime,
			RecordedAt:    now,
		})
		running := 0.0
		if status == "running" {
			running = 1
		}
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "container_running",
			Value: running, Unit: "bool", RecordedAt: now,
			Metadata: map[string]interface{}{"container_id": ct.ID, "container_name": ct.Name, "image": ct.Image},
		})

		prevStatus := c.prevStatus[ct.ID]
		prevUptime := c.prevUptime[ct.ID]
		if prevStatus != "" && prevStatus != status {
			severity := "info"
			if status == "restarting" || status == "exited" || status == "stopped" {
				severity = "warning"
			}
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "container_lifecycle",
				Severity: severity,
				Message:  fmt.Sprintf("Container %s status changed: %s -> %s", ct.Name, prevStatus, status),
				Metadata: map[string]interface{}{"container_id": ct.ID, "container_name": ct.Name, "previous_status": prevStatus, "status": status, "image": ct.Image},
				LoggedAt: now,
			})
		}
		if prevUptime > 0 && ct.UpTime > 0 && ct.UpTime < prevUptime && status == "running" {
			c.restarts[ct.ID]++
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "container_lifecycle",
				Severity: "warning",
				Message:  fmt.Sprintf("Container %s appears to have restarted", ct.Name),
				Metadata: map[string]interface{}{"container_id": ct.ID, "container_name": ct.Name, "restart_count": c.restarts[ct.ID], "image": ct.Image},
				LoggedAt: now,
			})
		}
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "container_restart_count",
			Value: float64(c.restarts[ct.ID]), Unit: "count", RecordedAt: now,
			Metadata: map[string]interface{}{"container_id": ct.ID, "container_name": ct.Name, "image": ct.Image},
		})
		c.prevStatus[ct.ID] = status
		c.prevUptime[ct.ID] = ct.UpTime
	}

	log.Printf("[docker] collected: %d containers", len(containers))
}
