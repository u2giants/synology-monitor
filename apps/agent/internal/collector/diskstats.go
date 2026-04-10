package collector

// DiskStatsCollector reads /host/proc/diskstats and emits per-device IOPS,
// throughput, avg latency, utilisation, and queue depth into smon_disk_io_stats.
//
// Requires /proc:/host/proc:ro in the container volume mounts.

import (
	"bufio"
	"log"
	"os"
	"strings"
	"strconv"
	"sync"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

const diskstatsPath = "/host/proc/diskstats"

// Sector size on Linux (512 bytes regardless of physical sector size)
const sectorBytes = 512

// diskSample is one reading of diskstats counters for a device.
type diskSample struct {
	readsCompleted  uint64
	readsMerged     uint64
	sectorsRead     uint64
	msReading       uint64
	writesCompleted uint64
	writesMerged    uint64
	sectorsWritten  uint64
	msWriting       uint64
	iosInProgress   uint64 // current queue depth (instantaneous)
	msDoingIO       uint64 // total ms device was busy
	msWeightedIO    uint64 // used for avgqu-sz calculation
	ts              time.Time
}

// volumeMap maps Linux device names to Synology volume paths.
// md* devices are Synology software RAID arrays.
var volumeMap = map[string]string{
	"md0": "/volume1",
	"md1": "/volume2",
	"md2": "/volume3",
	"md3": "/volume4",
}

// DiskStatsCollector collects per-disk I/O metrics.
type DiskStatsCollector struct {
	sender   *sender.Sender
	nasID    string
	interval time.Duration

	mu   sync.Mutex
	prev map[string]*diskSample
}

// NewDiskStatsCollector creates a DiskStatsCollector.
func NewDiskStatsCollector(s *sender.Sender, nasID string, interval time.Duration) *DiskStatsCollector {
	return &DiskStatsCollector{
		sender:   s,
		nasID:    nasID,
		interval: interval,
		prev:     make(map[string]*diskSample),
	}
}

// Run starts the collection loop.
func (c *DiskStatsCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[diskstats] collector started (interval: %s)", c.interval)

	// Baseline sample (no emit)
	c.collect(false)

	for {
		select {
		case <-ticker.C:
			c.collect(true)
		case <-stop:
			log.Println("[diskstats] collector stopped")
			return
		}
	}
}

func (c *DiskStatsCollector) collect(emit bool) {
	samples, err := readDiskstats()
	if err != nil {
		log.Printf("[diskstats] error reading diskstats: %v", err)
		return
	}

	now := time.Now().UTC()
	emitted := 0

	c.mu.Lock()
	defer c.mu.Unlock()

	for device, cur := range samples {
		cur.ts = now
		prev, hasPrev := c.prev[device]
		c.prev[device] = cur

		if !emit || !hasPrev {
			continue
		}

		wallSecs := cur.ts.Sub(prev.ts).Seconds()
		if wallSecs <= 0 {
			continue
		}

		deltaReads  := safeDelta(cur.readsCompleted,  prev.readsCompleted)
		deltaWrites := safeDelta(cur.writesCompleted, prev.writesCompleted)
		deltaSR     := safeDelta(cur.sectorsRead,     prev.sectorsRead)
		deltaSW     := safeDelta(cur.sectorsWritten,  prev.sectorsWritten)
		deltaMsR    := safeDelta(cur.msReading,       prev.msReading)
		deltaMsW    := safeDelta(cur.msWriting,        prev.msWriting)
		deltaMsIO   := safeDelta(cur.msDoingIO,       prev.msDoingIO)
		deltaMsWIO  := safeDelta(cur.msWeightedIO,    prev.msWeightedIO)

		readsPS  := float64(deltaReads)  / wallSecs
		writesPS := float64(deltaWrites) / wallSecs
		readBPS  := int64(float64(deltaSR*sectorBytes) / wallSecs)
		writeBPS := int64(float64(deltaSW*sectorBytes) / wallSecs)

		// Average I/O latency (await in ms)
		totalOps := deltaReads + deltaWrites
		awaitMS := float64(0)
		if totalOps > 0 {
			awaitMS = float64(deltaMsR+deltaMsW) / float64(totalOps)
		}

		// Utilisation: percentage of wall time the device was doing I/O
		wallMS  := wallSecs * 1000
		utilPct := float64(deltaMsIO) / wallMS * 100.0
		if utilPct > 100 {
			utilPct = 100
		}

		// Average queue depth (avgqu-sz): weighted I/O time / wall time
		queueDepth := float64(deltaMsWIO) / wallMS

		volPath := volumeMap[device]

		c.sender.QueueDiskIOStat(sender.DiskIOStatPayload{
			NasID:      c.nasID,
			CapturedAt: now,
			Device:     device,
			VolumePath: volPath,
			ReadPS:     roundFloat(readsPS, 1),
			WritePS:    roundFloat(writesPS, 1),
			ReadBPS:    readBPS,
			WriteBPS:   writeBPS,
			AwaitMS:    roundFloat(awaitMS, 2),
			UtilPct:    roundFloat(utilPct, 1),
			QueueDepth: roundFloat(queueDepth, 2),
		})
		emitted++
	}

	if emit {
		log.Printf("[diskstats] collected %d devices", emitted)
	}
}

// readDiskstats parses /host/proc/diskstats, returning only real block devices
// (sd*, hd*, nvme*, md*, xvd*). Partitions (sda1, sda2…) are excluded because
// their counters overlap with the parent device.
func readDiskstats() (map[string]*diskSample, error) {
	f, err := os.Open(diskstatsPath)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	result := make(map[string]*diskSample)
	scanner := bufio.NewScanner(f)

	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 14 {
			continue
		}

		device := fields[2]

		// Skip partitions (sda1, sdb2, nvme0n1p1, etc.)
		if isPartition(device) {
			continue
		}

		// Only care about physical disks and RAID arrays
		if !isInterestingDevice(device) {
			continue
		}

		s := &diskSample{}
		vals := make([]uint64, 11)
		for i := range vals {
			v, err := strconv.ParseUint(fields[3+i], 10, 64)
			if err == nil {
				vals[i] = v
			}
		}
		s.readsCompleted  = vals[0]
		s.readsMerged     = vals[1]
		s.sectorsRead     = vals[2]
		s.msReading       = vals[3]
		s.writesCompleted = vals[4]
		s.writesMerged    = vals[5]
		s.sectorsWritten  = vals[6]
		s.msWriting       = vals[7]
		s.iosInProgress   = vals[8]
		s.msDoingIO       = vals[9]
		s.msWeightedIO    = vals[10]

		result[device] = s
	}

	return result, scanner.Err()
}

// isPartition returns true if the device name ends with a digit (e.g. sda1).
func isPartition(name string) bool {
	if len(name) == 0 {
		return false
	}
	last := name[len(name)-1]
	return last >= '0' && last <= '9' && !strings.HasPrefix(name, "md")
}

// isInterestingDevice returns true for physical disks and RAID arrays.
func isInterestingDevice(name string) bool {
	prefixes := []string{"sd", "hd", "nvme", "md", "xvd", "vd"}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// safeDelta returns cur-prev, clamping at 0 to handle counter resets.
func safeDelta(cur, prev uint64) uint64 {
	if cur >= prev {
		return cur - prev
	}
	return 0
}
