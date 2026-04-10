package collector

// SysExtrasCollector gathers data the resolution agent consistently needs
// but the base system collector doesn't cover: memory pressure details,
// filesystem inode usage, thermal/power state, CPU I/O wait, NFS throughput,
// VM pressure, and Btrfs error counters.

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

type cpuStatRaw struct {
	user, nice, system, idle, iowait, irq, softirq, steal uint64
}

type SysExtrasCollector struct {
	sender   *sender.Sender
	nasID    string
	interval time.Duration

	// iowait tracking
	prevCPUStat *cpuStatRaw
	prevCPUTime time.Time

	// NFS tracking
	prevNFSRead  uint64
	prevNFSWrite uint64
	prevNFSCalls uint64
	prevNFSTime  time.Time

	// vmstat tracking
	prevVMStat map[string]uint64
	prevVMTime time.Time
}

func NewSysExtrasCollector(s *sender.Sender, nasID string, interval time.Duration) *SysExtrasCollector {
	return &SysExtrasCollector{
		sender:     s,
		nasID:      nasID,
		interval:   interval,
		prevVMStat: make(map[string]uint64),
	}
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
	c.collectIOWait(now)
	c.collectNFSStats(now)
	c.collectVMPressure(now)
	c.collectBtrfsErrors(now)
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
				"filesystem":   fields[0],
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

// collectIOWait reads /proc/stat and computes CPU I/O wait percentage.
func (c *SysExtrasCollector) collectIOWait(now time.Time) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		f, err = os.Open("/host/proc/stat")
		if err != nil {
			return
		}
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	var cur *cpuStatRaw
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "cpu ") {
			continue
		}
		fields := strings.Fields(line)
		// cpu user nice system idle iowait irq softirq steal ...
		if len(fields) < 9 {
			continue
		}
		cur = &cpuStatRaw{}
		vals := []uint64{0, 0, 0, 0, 0, 0, 0, 0}
		for i := 0; i < 8 && i+1 < len(fields); i++ {
			v, _ := strconv.ParseUint(fields[i+1], 10, 64)
			vals[i] = v
		}
		cur.user = vals[0]
		cur.nice = vals[1]
		cur.system = vals[2]
		cur.idle = vals[3]
		cur.iowait = vals[4]
		cur.irq = vals[5]
		cur.softirq = vals[6]
		cur.steal = vals[7]
		break
	}

	if cur == nil {
		return
	}

	prev := c.prevCPUStat
	c.prevCPUStat = cur
	c.prevCPUTime = now

	if prev == nil {
		return
	}

	totalPrev := prev.user + prev.nice + prev.system + prev.idle +
		prev.iowait + prev.irq + prev.softirq + prev.steal
	totalCur := cur.user + cur.nice + cur.system + cur.idle +
		cur.iowait + cur.irq + cur.softirq + cur.steal

	deltaTot := totalCur - totalPrev
	if deltaTot == 0 {
		return
	}

	deltaIOW := cur.iowait - prev.iowait
	iowaitPct := float64(deltaIOW) / float64(deltaTot) * 100.0

	c.sender.QueueMetric(sender.MetricPayload{
		NasID:      c.nasID,
		Type:       "cpu_iowait_pct",
		Value:      roundFloat(iowaitPct, 2),
		Unit:       "%",
		RecordedAt: now,
	})
}

// collectNFSStats reads /proc/net/rpc/nfsd and emits per-second NFS rates.
func (c *SysExtrasCollector) collectNFSStats(now time.Time) {
	f, err := os.Open("/proc/net/rpc/nfsd")
	if err != nil {
		f, err = os.Open("/host/proc/net/rpc/nfsd")
		if err != nil {
			// nfsd not running — skip silently
			return
		}
	}
	defer f.Close()

	var curRead, curWrite, curCalls uint64
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "io":
			// io <bytes_read> <bytes_written>
			if len(fields) >= 3 {
				curRead, _ = strconv.ParseUint(fields[1], 10, 64)
				curWrite, _ = strconv.ParseUint(fields[2], 10, 64)
			}
		case "rpc":
			// rpc <total_calls> <badcalls> ...
			if len(fields) >= 2 {
				curCalls, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		}
	}

	prevRead := c.prevNFSRead
	prevWrite := c.prevNFSWrite
	prevCalls := c.prevNFSCalls
	prevTime := c.prevNFSTime

	c.prevNFSRead = curRead
	c.prevNFSWrite = curWrite
	c.prevNFSCalls = curCalls
	c.prevNFSTime = now

	if prevTime.IsZero() {
		return
	}

	elapsed := now.Sub(prevTime).Seconds()
	if elapsed <= 0 {
		return
	}

	var deltaRead, deltaWrite, deltaCalls uint64
	if curRead >= prevRead {
		deltaRead = curRead - prevRead
	}
	if curWrite >= prevWrite {
		deltaWrite = curWrite - prevWrite
	}
	if curCalls >= prevCalls {
		deltaCalls = curCalls - prevCalls
	}

	c.sender.QueueMetric(sender.MetricPayload{
		NasID:      c.nasID,
		Type:       "nfs_read_bps",
		Value:      float64(deltaRead) / elapsed,
		Unit:       "B/s",
		RecordedAt: now,
	})
	c.sender.QueueMetric(sender.MetricPayload{
		NasID:      c.nasID,
		Type:       "nfs_write_bps",
		Value:      float64(deltaWrite) / elapsed,
		Unit:       "B/s",
		RecordedAt: now,
	})
	c.sender.QueueMetric(sender.MetricPayload{
		NasID:      c.nasID,
		Type:       "nfs_calls_ps",
		Value:      float64(deltaCalls) / elapsed,
		Unit:       "calls/s",
		RecordedAt: now,
	})
}

// collectVMPressure reads /proc/vmstat and emits paging/swap rates per second.
func (c *SysExtrasCollector) collectVMPressure(now time.Time) {
	f, err := os.Open("/proc/vmstat")
	if err != nil {
		f, err = os.Open("/host/proc/vmstat")
		if err != nil {
			return
		}
	}
	defer f.Close()

	want := map[string]bool{
		"pgpgout": true,
		"pswpout": true,
		"pswpin":  true,
	}

	cur := make(map[string]uint64)
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}
		if !want[fields[0]] {
			continue
		}
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err == nil {
			cur[fields[0]] = v
		}
	}

	prev := c.prevVMStat
	prevTime := c.prevVMTime
	c.prevVMStat = cur
	c.prevVMTime = now

	if prevTime.IsZero() {
		return
	}

	elapsed := now.Sub(prevTime).Seconds()
	if elapsed <= 0 {
		return
	}

	deltaRate := func(key string) float64 {
		curVal := cur[key]
		prevVal := prev[key]
		if curVal < prevVal {
			return 0
		}
		return float64(curVal-prevVal) / elapsed
	}

	c.sender.QueueMetric(sender.MetricPayload{
		NasID:      c.nasID,
		Type:       "vm_pgpgout_ps",
		Value:      roundFloat(deltaRate("pgpgout"), 2),
		Unit:       "pages/s",
		RecordedAt: now,
	})

	swapOut := deltaRate("pswpout")
	swapIn := deltaRate("pswpin")

	if swapOut > 0 {
		c.sender.QueueMetric(sender.MetricPayload{
			NasID:      c.nasID,
			Type:       "vm_swap_out_ps",
			Value:      roundFloat(swapOut, 2),
			Unit:       "pages/s",
			RecordedAt: now,
		})
	}
	if swapIn > 0 {
		c.sender.QueueMetric(sender.MetricPayload{
			NasID:      c.nasID,
			Type:       "vm_swap_in_ps",
			Value:      roundFloat(swapIn, 2),
			Unit:       "pages/s",
			RecordedAt: now,
		})
	}
}

// collectBtrfsErrors walks /sys/fs/btrfs/ looking for error counter files.
func (c *SysExtrasCollector) collectBtrfsErrors(now time.Time) {
	btrfsRoot := "/sys/fs/btrfs"
	if _, err := os.Stat(btrfsRoot); err != nil {
		btrfsRoot = "/host/sys/fs/btrfs"
		if _, err := os.Stat(btrfsRoot); err != nil {
			return
		}
	}

	entries, err := os.ReadDir(btrfsRoot)
	if err != nil {
		return
	}

	errorFiles := []string{"corruption_errs", "generation_errs", "read_errs", "write_errs"}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		uuid := entry.Name()
		uuidDir := fmt.Sprintf("%s/%s", btrfsRoot, uuid)

		// Read label for human-readable name
		label := uuid
		if lb, err := os.ReadFile(fmt.Sprintf("%s/label", uuidDir)); err == nil {
			if s := strings.TrimSpace(string(lb)); s != "" {
				label = s
			}
		}

		for _, errFile := range errorFiles {
			path := fmt.Sprintf("%s/%s", uuidDir, errFile)
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			val, err := strconv.ParseInt(strings.TrimSpace(string(data)), 10, 64)
			if err != nil || val == 0 {
				continue
			}

			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "btrfs_error",
				Severity: "error",
				Message:  fmt.Sprintf("Btrfs %s on volume %q (uuid %s): %d", errFile, label, uuid, val),
				Metadata: map[string]interface{}{
					"uuid":    uuid,
					"label":   label,
					"counter": errFile,
					"value":   val,
				},
				LoggedAt: now,
			})
		}
	}
}
