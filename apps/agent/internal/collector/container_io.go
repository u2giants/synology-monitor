package collector

// ContainerIOCollector reads cgroup blkio/io stats for each Docker container
// and emits per-container read/write BPS and IOPS into smon_container_io.
//
// Tries host-mounted cgroups first (/host/sys/fs/cgroup/...),
// then falls back to the container's own /sys view.

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/synology-monitor/agent/internal/dsm"
	"github.com/synology-monitor/agent/internal/sender"
)

type containerIOPrev struct {
	readBytes  int64
	writeBytes int64
	readOps    int64
	writeOps   int64
	ts         time.Time
}

// ContainerIOCollector collects per-container I/O metrics via cgroups.
type ContainerIOCollector struct {
	dsmClient *dsm.Client
	sender    *sender.Sender
	nasID     string
	interval  time.Duration

	mu   sync.Mutex
	prev map[string]*containerIOPrev
}

// NewContainerIOCollector creates a ContainerIOCollector.
func NewContainerIOCollector(dsmClient *dsm.Client, s *sender.Sender, nasID string, interval time.Duration) *ContainerIOCollector {
	return &ContainerIOCollector{
		dsmClient: dsmClient,
		sender:    s,
		nasID:     nasID,
		interval:  interval,
		prev:      make(map[string]*containerIOPrev),
	}
}

// Run starts the collection loop.
func (c *ContainerIOCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[container-io] collector started (interval: %s)", c.interval)

	// Baseline sample (no emit)
	c.collect(false)

	for {
		select {
		case <-ticker.C:
			c.collect(true)
		case <-stop:
			log.Println("[container-io] collector stopped")
			return
		}
	}
}

func (c *ContainerIOCollector) collect(emit bool) {
	containers, err := c.dsmClient.GetDockerContainers()
	if err != nil {
		// non-fatal
		return
	}

	now := time.Now().UTC()
	emitted := 0

	c.mu.Lock()
	defer c.mu.Unlock()

	for _, ct := range containers {
		if ct.ID == "" {
			continue
		}

		readBytes, writeBytes, readOps, writeOps, ok := readCgroupIO(ct.ID)
		if !ok {
			continue
		}

		prev, hasPrev := c.prev[ct.ID]
		c.prev[ct.ID] = &containerIOPrev{
			readBytes:  readBytes,
			writeBytes: writeBytes,
			readOps:    readOps,
			writeOps:   writeOps,
			ts:         now,
		}

		if !emit || !hasPrev {
			continue
		}

		elapsed := now.Sub(prev.ts).Seconds()
		if elapsed <= 0 {
			continue
		}

		deltaRead := readBytes - prev.readBytes
		deltaWrite := writeBytes - prev.writeBytes
		deltaROps := readOps - prev.readOps
		deltaWOps := writeOps - prev.writeOps

		// clamp negatives (counter reset)
		if deltaRead < 0 {
			deltaRead = 0
		}
		if deltaWrite < 0 {
			deltaWrite = 0
		}
		if deltaROps < 0 {
			deltaROps = 0
		}
		if deltaWOps < 0 {
			deltaWOps = 0
		}

		c.sender.QueueContainerIO(sender.ContainerIOPayload{
			NasID:         c.nasID,
			CapturedAt:    now,
			ContainerID:   ct.ID,
			ContainerName: ct.Name,
			ReadBPS:       int64(float64(deltaRead) / elapsed),
			WriteBPS:      int64(float64(deltaWrite) / elapsed),
			ReadOPS:       int64(float64(deltaROps) / elapsed),
			WriteOPS:      int64(float64(deltaWOps) / elapsed),
		})
		emitted++
	}

	if emit {
		log.Printf("[container-io] collected %d containers", emitted)
	}
}

// readCgroupIO tries cgroup v1 then v2 for the given container ID.
// Returns cumulative read/write bytes and ops, plus ok=true on success.
func readCgroupIO(containerID string) (readBytes, writeBytes, readOps, writeOps int64, ok bool) {
	for _, root := range []string{"/host/sys", "/sys"} {
		// --- cgroup v1 ---
		v1Dir := fmt.Sprintf("%s/fs/cgroup/blkio/docker/%s", root, containerID)
		v1Path := fmt.Sprintf("%s/blkio.throttle.io_service_bytes", v1Dir)
		if rb, wb, rok, wok := parseCgroupV1Bytes(v1Path); rok || wok {
			opsPath := fmt.Sprintf("%s/blkio.throttle.io_serviced", v1Dir)
			ro, wo, _, _ := parseCgroupV1Bytes(opsPath)
			return rb, wb, ro, wo, true
		}
		if rb, wb, ro, wo, err := parseProcIOFromTasks(v1Dir + "/tasks"); err == nil {
			return rb, wb, ro, wo, true
		}

		// --- cgroup v2 ---
		v2Path := fmt.Sprintf("%s/fs/cgroup/system.slice/docker-%s.scope/io.stat", root, containerID)
		rb, wb, ro, wo, err := parseCgroupV2(v2Path)
		if err == nil {
			return rb, wb, ro, wo, true
		}
	}

	return 0, 0, 0, 0, false
}

// parseProcIOFromTasks falls back to per-process IO counters when Synology's
// blkio cgroup only exposes task membership without throttle files.
//
// Synology's kernel reports identical, process-level (TGID) stats for every
// thread task rather than per-thread stats.  Naively summing all tasks would
// multiply the real I/O by the number of goroutine threads (e.g. 19×), making
// a container appear to do 2+ GB/s when it's really ~100 MB/s.
//
// Fix: resolve each task PID to its TGID via /proc/{pid}/status and only read
// the io file once per unique TGID.  This is correct on both kernel behaviours:
//   - per-thread stats  → unique TGIDs are the main threads; sum them
//   - per-process stats → deduplicated to one entry per process; sum them
func parseProcIOFromTasks(tasksPath string) (readBytes, writeBytes, readOps, writeOps int64, err error) {
	f, err := os.Open(tasksPath)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer f.Close()

	// Collect all task PIDs first.
	var pids []string
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		pid := strings.TrimSpace(scanner.Text())
		if pid != "" {
			pids = append(pids, pid)
		}
	}
	if len(pids) == 0 {
		return 0, 0, 0, 0, fmt.Errorf("no task io stats in %s", filepath.Base(tasksPath))
	}

	// Resolve each task to its TGID (main thread / process leader).
	// On kernels that report per-process stats for all threads, every task has
	// the same TGID, so we accumulate only once per unique TGID.
	seen := make(map[string]struct{})
	found := false

	for _, pid := range pids {
		tgid := resolveTGID(pid)

		if _, already := seen[tgid]; already {
			continue
		}
		seen[tgid] = struct{}{}

		stats, readErr := os.ReadFile(fmt.Sprintf("/host/proc/%s/io", tgid))
		if readErr != nil {
			stats, readErr = os.ReadFile(fmt.Sprintf("/proc/%s/io", tgid))
			if readErr != nil {
				continue
			}
		}

		found = true
		for _, line := range strings.Split(string(stats), "\n") {
			fields := strings.Fields(line)
			if len(fields) != 2 {
				continue
			}
			key := strings.TrimSuffix(fields[0], ":")
			val, parseErr := strconv.ParseInt(fields[1], 10, 64)
			if parseErr != nil {
				continue
			}
			switch key {
			case "read_bytes":
				readBytes += val
			case "write_bytes":
				writeBytes += val
			case "syscr":
				readOps += val
			case "syscw":
				writeOps += val
			}
		}
	}

	if !found {
		return 0, 0, 0, 0, fmt.Errorf("no task io stats in %s", filepath.Base(tasksPath))
	}
	return readBytes, writeBytes, readOps, writeOps, nil
}

// resolveTGID returns the TGID (thread-group leader PID) for the given task
// PID by reading /proc/{pid}/status.  Falls back to pid itself on any error.
func resolveTGID(pid string) string {
	for _, root := range []string{"/host/proc", "/proc"} {
		data, err := os.ReadFile(fmt.Sprintf("%s/%s/status", root, pid))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "Tgid:") {
				fields := strings.Fields(line)
				if len(fields) == 2 {
					return fields[1]
				}
			}
		}
		break // found the file, just missing Tgid line (shouldn't happen)
	}
	return pid // fallback: treat as its own group
}

// parseCgroupV1Bytes parses blkio.throttle.io_service_bytes (or io_serviced).
// Lines look like:  8:0 Read 1234567
//
//	8:0 Write 7654321
//	Total 8888888
func parseCgroupV1Bytes(path string) (readVal, writeVal int64, hasRead, hasWrite bool) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) != 3 {
			continue
		}
		// fields[0] = "8:0", fields[1] = "Read"/"Write", fields[2] = value
		val, err := strconv.ParseInt(fields[2], 10, 64)
		if err != nil {
			continue
		}
		switch fields[1] {
		case "Read":
			readVal += val
			hasRead = true
		case "Write":
			writeVal += val
			hasWrite = true
		}
	}
	return
}

// parseCgroupV2 parses io.stat.
// Lines look like:  8:0 rbytes=1234567 wbytes=7654321 rios=123 wios=456 ...
func parseCgroupV2(path string) (readBytes, writeBytes, readOps, writeOps int64, err error) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	found := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		// first field is "major:minor", rest are key=value pairs
		for _, kv := range fields[1:] {
			parts := strings.SplitN(kv, "=", 2)
			if len(parts) != 2 {
				continue
			}
			val, parseErr := strconv.ParseInt(parts[1], 10, 64)
			if parseErr != nil {
				continue
			}
			switch parts[0] {
			case "rbytes":
				readBytes += val
				found = true
			case "wbytes":
				writeBytes += val
				found = true
			case "rios":
				readOps += val
			case "wios":
				writeOps += val
			}
		}
	}

	if !found {
		err = fmt.Errorf("no data in %s", filepath.Base(path))
	}
	return
}
