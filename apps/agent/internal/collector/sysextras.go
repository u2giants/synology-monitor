package collector

// SysExtrasCollector gathers data the resolution agent consistently needs
// but the base system collector doesn't cover: memory pressure details,
// filesystem inode usage, and thermal/power state.

import (
	"bufio"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

type SysExtrasCollector struct {
	sender   *sender.Sender
	nasID    string
	interval time.Duration
}

func NewSysExtrasCollector(s *sender.Sender, nasID string, interval time.Duration) *SysExtrasCollector {
	return &SysExtrasCollector{sender: s, nasID: nasID, interval: interval}
}

func (c *SysExtrasCollector) Run(stop <-chan struct{}) {
	log.Printf("[sys-extras] started (every %s)", c.interval)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.collect()
	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[sys-extras] stopped")
			return
		}
	}
}

func (c *SysExtrasCollector) collect() {
	now := time.Now().UTC()
	c.collectMemoryPressure(now)
	c.collectInodeUsage(now)
	c.collectThermal(now)
}

// collectMemoryPressure reads /proc/meminfo for fields that indicate memory stress.
func (c *SysExtrasCollector) collectMemoryPressure(now time.Time) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		// Try host-mounted /proc
		f, err = os.Open("/host/proc/meminfo")
		if err != nil {
			return
		}
	}
	defer f.Close()

	fields := map[string]float64{}
	scanner := bufio.NewScanner(f)
	want := map[string]bool{
		"MemTotal": true, "MemAvailable": true, "SwapTotal": true,
		"SwapFree": true, "Dirty": true, "Writeback": true,
		"Cached": true, "Buffers": true, "SReclaimable": true,
	}

	for scanner.Scan() {
		parts := strings.Fields(scanner.Text())
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		if !want[key] {
			continue
		}
		val, err := strconv.ParseFloat(parts[1], 64)
		if err == nil {
			fields[key] = val // kB
		}
	}

	if memTotal, ok := fields["MemTotal"]; ok && memTotal > 0 {
		memAvail := fields["MemAvailable"]
		swapTotal := fields["SwapTotal"]
		swapFree := fields["SwapFree"]

		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "mem_available_kb", Value: memAvail,
			Unit: "kB", RecordedAt: now,
		})
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "mem_available_pct",
			Value: (memAvail / memTotal) * 100, Unit: "%", RecordedAt: now,
		})

		if swapTotal > 0 {
			swapUsed := swapTotal - swapFree
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID, Type: "swap_used_kb", Value: swapUsed,
				Unit: "kB", RecordedAt: now,
			})
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID, Type: "swap_used_pct",
				Value: (swapUsed / swapTotal) * 100, Unit: "%", RecordedAt: now,
			})
		}

		dirty := fields["Dirty"]
		writeback := fields["Writeback"]
		if dirty+writeback > 0 {
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID, Type: "dirty_writeback_kb", Value: dirty + writeback,
				Unit: "kB", RecordedAt: now,
			})
		}
	}
}

// collectInodeUsage runs df -i on key volumes.
func (c *SysExtrasCollector) collectInodeUsage(now time.Time) {
	out, err := exec.Command("df", "-i", "/volume1").CombinedOutput()
	if err != nil {
		// Try host path
		out, err = exec.Command("df", "-i", "/host/volume1").CombinedOutput()
		if err != nil {
			return
		}
	}

	lines := strings.Split(string(out), "\n")
	for _, line := range lines[1:] { // skip header
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		usedPctStr := strings.TrimSuffix(fields[4], "%")
		usedPct, err := strconv.ParseFloat(usedPctStr, 64)
		if err != nil {
			continue
		}
		total, _ := strconv.ParseFloat(fields[1], 64)
		used, _ := strconv.ParseFloat(fields[2], 64)

		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "inode_used_pct", Value: usedPct,
			Unit: "%", RecordedAt: now,
			Metadata: map[string]interface{}{
				"filesystem":  fields[0],
				"inodes_total": total,
				"inodes_used":  used,
			},
		})
	}
}

// collectThermal checks for thermal throttling or CPU frequency warnings.
func (c *SysExtrasCollector) collectThermal(now time.Time) {
	// CPU temperature via thermal zone
	out, _ := exec.Command("sh", "-c",
		`cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null | head -1`).CombinedOutput()
	tempStr := strings.TrimSpace(string(out))
	if temp, err := strconv.ParseFloat(tempStr, 64); err == nil && temp > 0 {
		// Kernel reports in millidegrees
		c.sender.QueueMetric(sender.MetricPayload{
			NasID: c.nasID, Type: "cpu_temp_c", Value: temp / 1000.0,
			Unit: "°C", RecordedAt: now,
		})
	}
}
