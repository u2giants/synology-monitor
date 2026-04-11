package collector

// ProcessCollector reads /host/proc to collect per-process CPU, memory, and
// disk I/O. It emits the top-N processes ranked by each dimension into
// process_snapshots, grouping each collection pass under a shared
// snapshot_grp UUID so the copilot can query a coherent point-in-time view.
//
// Requires /proc:/host/proc:ro in the container volume mounts.

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

	"github.com/synology-monitor/agent/internal/sender"
)

const (
	hostProcDir    = "/host/proc"
	topN           = 20   // top processes per dimension
	clockTicksPerS = 100  // USER_HZ on Linux (SC_CLK_TCK)
)

// knownServices maps process names to human-readable Synology service labels.
var knownServices = map[string]string{
	"synodriveclient": "SynologyDrive Client",
	"synodriveserver": "SynologyDrive Server",
	"synodrive":       "SynologyDrive",
	"synoindex":       "Synology Indexing",
	"synoindexd":      "Synology Indexing",
	"synothumbd":      "Thumbnail Service",
	"smbd":            "Samba (SMB)",
	"nmbd":            "Samba NetBIOS",
	"nfsd":            "NFS Server",
	"php-fpm":         "PHP-FPM / DSM Web",
	"synopkgd":        "Package Manager",
	"synobackup":      "Synology Backup",
	"scemd":           "Storage & Cache Engine",
	"synoscgi":        "Synology SCGI",
	"docker":          "Docker Engine",
	"dockerd":         "Docker Engine",
	"containerd":      "Container Runtime",
	"avahi-daemon":    "Avahi mDNS",
	"synosystemd":     "Synology System Service",
	"sshd":            "SSH Server",
}

// prevStat holds the previous-sample values needed to compute deltas.
type prevStat struct {
	utime      uint64
	stime      uint64
	readBytes  uint64
	writeBytes uint64
	wallTime   time.Time
}

// ProcessCollector collects per-process CPU, memory, and disk I/O stats.
type ProcessCollector struct {
	sender   *sender.Sender
	nasID    string
	interval time.Duration

	mu       sync.Mutex
	prev     map[int]*prevStat // keyed by PID
	uidCache map[uint32]string  // UID → username
}

// NewProcessCollector creates a ProcessCollector.
func NewProcessCollector(s *sender.Sender, nasID string, interval time.Duration) *ProcessCollector {
	return &ProcessCollector{
		sender:   s,
		nasID:    nasID,
		interval: interval,
		prev:     make(map[int]*prevStat),
		uidCache: make(map[uint32]string),
	}
}

// Run starts the collection loop.
func (c *ProcessCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	log.Printf("[process] collector started (interval: %s)", c.interval)

	// First pass builds prev-stat baseline; no output yet.
	c.collect(false)

	for {
		select {
		case <-ticker.C:
			c.collect(true)
		case <-stop:
			log.Println("[process] collector stopped")
			return
		}
	}
}

// procInfo holds parsed data for a single process.
type procInfo struct {
	pid     int
	name    string
	cmdline string
	state   string
	uid     uint32
	utime   uint64
	stime   uint64
	rssKB   int64
	rBytes  uint64
	wBytes  uint64

	// calculated after delta
	cpuPct   float64
	readBPS  int64
	writeBPS int64
}

func (c *ProcessCollector) collect(emit bool) {
	now := time.Now().UTC()

	entries, err := os.ReadDir(hostProcDir)
	if err != nil {
		log.Printf("[process] cannot read %s: %v", hostProcDir, err)
		return
	}

	var infos []procInfo

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue // not a numeric PID directory
		}

		info, ok := c.readProc(pid)
		if !ok {
			continue
		}

		c.mu.Lock()
		if prev, exists := c.prev[pid]; exists && emit {
			wallDelta := now.Sub(prev.wallTime).Seconds()
			if wallDelta > 0 {
				cpuTicks := float64((info.utime+info.stime)-(prev.utime+prev.stime))
				info.cpuPct = cpuTicks / (wallDelta * clockTicksPerS) * 100.0
				if info.cpuPct < 0 {
					info.cpuPct = 0
				}

				if info.rBytes >= prev.readBytes {
					info.readBPS = int64(float64(info.rBytes-prev.readBytes) / wallDelta)
				}
				if info.wBytes >= prev.writeBytes {
					info.writeBPS = int64(float64(info.wBytes-prev.writeBytes) / wallDelta)
				}
			}
		}
		c.prev[pid] = &prevStat{
			utime:      info.utime,
			stime:      info.stime,
			readBytes:  info.rBytes,
			writeBytes: info.wBytes,
			wallTime:   now,
		}
		c.mu.Unlock()

		infos = append(infos, info)
	}

	// Prune stale PIDs from prev map
	c.mu.Lock()
	seen := make(map[int]struct{}, len(infos))
	for _, info := range infos {
		seen[info.pid] = struct{}{}
	}
	for pid := range c.prev {
		if _, ok := seen[pid]; !ok {
			delete(c.prev, pid)
		}
	}
	c.mu.Unlock()

	if !emit || len(infos) == 0 {
		return
	}

	// Total memory for mem%
	totalMemKB := c.readTotalMemKB()

	// Select top-N by each dimension; deduplicate by PID
	selected := selectTopProcesses(infos, topN)

	snapshotGrp := newUUID()
	count := 0
	for _, info := range selected {
		memPct := float64(0)
		if totalMemKB > 0 {
			memPct = float64(info.rssKB) / float64(totalMemKB) * 100.0
		}
		username := c.resolveUID(info.uid)
		service := resolveService(info.name)

		c.sender.QueueProcessSnapshot(sender.ProcessSnapshotPayload{
			NasID:         c.nasID,
			SnapshotGrp:   snapshotGrp,
			CapturedAt:    now,
			PID:           info.pid,
			Name:          info.name,
			Cmdline:       truncate(info.cmdline, 256),
			Username:      username,
			State:         info.state,
			CPUPct:        roundFloat(info.cpuPct, 2),
			MemRSSKB:      info.rssKB,
			MemPct:        roundFloat(memPct, 2),
			ReadBPS:       info.readBPS,
			WriteBPS:      info.writeBPS,
			ParentService: service,
		})
		count++
	}

	log.Printf("[process] collected %d processes (%d in top-N set)", len(infos), count)
}

// readProc reads /host/proc/{pid}/{stat,status,io,cmdline} for a single PID.
// Returns false if the process has already exited.
func (c *ProcessCollector) readProc(pid int) (procInfo, bool) {
	base := filepath.Join(hostProcDir, strconv.Itoa(pid))
	info := procInfo{pid: pid}

	// --- stat ---
	statBytes, err := os.ReadFile(filepath.Join(base, "stat"))
	if err != nil {
		return info, false // process gone
	}
	line := strings.TrimSpace(string(statBytes))

	// comm is in parens and may contain spaces / parens itself; find last ')'
	lastParen := strings.LastIndex(line, ")")
	if lastParen < 0 {
		return info, false
	}
	firstParen := strings.Index(line, "(")
	if firstParen < 0 || firstParen >= lastParen {
		return info, false
	}
	info.name = line[firstParen+1 : lastParen]

	fields := strings.Fields(line[lastParen+2:])
	// fields[0]=state, fields[11]=utime, fields[12]=stime
	if len(fields) < 13 {
		return info, false
	}
	info.state = fields[0]
	info.utime, _ = strconv.ParseUint(fields[11], 10, 64)
	info.stime, _ = strconv.ParseUint(fields[12], 10, 64)

	// --- status (for UID and VmRSS) ---
	statusBytes, err := os.ReadFile(filepath.Join(base, "status"))
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(statusBytes)))
		for scanner.Scan() {
			kv := scanner.Text()
			if strings.HasPrefix(kv, "VmRSS:") {
				parts := strings.Fields(kv)
				if len(parts) >= 2 {
					info.rssKB, _ = strconv.ParseInt(parts[1], 10, 64)
				}
			} else if strings.HasPrefix(kv, "Uid:") {
				parts := strings.Fields(kv)
				if len(parts) >= 2 {
					uid, _ := strconv.ParseUint(parts[1], 10, 32)
					info.uid = uint32(uid)
				}
			}
		}
	}

	// --- io (requires sufficient permissions; best-effort) ---
	ioBytes, err := os.ReadFile(filepath.Join(base, "io"))
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(ioBytes)))
		for scanner.Scan() {
			kv := scanner.Text()
			if strings.HasPrefix(kv, "read_bytes:") {
				parts := strings.Fields(kv)
				if len(parts) >= 2 {
					info.rBytes, _ = strconv.ParseUint(parts[1], 10, 64)
				}
			} else if strings.HasPrefix(kv, "write_bytes:") {
				parts := strings.Fields(kv)
				if len(parts) >= 2 {
					info.wBytes, _ = strconv.ParseUint(parts[1], 10, 64)
				}
			}
		}
	}

	// --- cmdline ---
	cmdBytes, err := os.ReadFile(filepath.Join(base, "cmdline"))
	if err == nil {
		// NUL-separated args
		info.cmdline = strings.ReplaceAll(strings.TrimRight(string(cmdBytes), "\x00"), "\x00", " ")
	}

	return info, true
}

// readTotalMemKB reads /host/proc/meminfo for MemTotal.
func (c *ProcessCollector) readTotalMemKB() int64 {
	data, err := os.ReadFile(filepath.Join(hostProcDir, "meminfo"))
	if err != nil {
		return 0
	}
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				val, _ := strconv.ParseInt(parts[1], 10, 64)
				return val
			}
		}
	}
	return 0
}

// resolveUID converts a numeric UID to a username using /host/etc/passwd.
// Results are cached for the lifetime of the collector.
func (c *ProcessCollector) resolveUID(uid uint32) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if name, ok := c.uidCache[uid]; ok {
		return name
	}
	name := fmt.Sprintf("%d", uid)
	data, err := os.ReadFile("/host/etc/passwd")
	if err == nil {
		scanner := bufio.NewScanner(strings.NewReader(string(data)))
		for scanner.Scan() {
			parts := strings.SplitN(scanner.Text(), ":", 4)
			if len(parts) >= 3 {
				if u, err := strconv.ParseUint(parts[2], 10, 32); err == nil && uint32(u) == uid {
					name = parts[0]
					break
				}
			}
		}
	}
	c.uidCache[uid] = name
	return name
}

// resolveService returns the human-readable service name for a process name.
func resolveService(name string) string {
	lower := strings.ToLower(name)
	for key, svc := range knownServices {
		if strings.Contains(lower, key) {
			return svc
		}
	}
	return ""
}

// selectTopProcesses returns at most 3×topN unique processes ranked by
// CPU, RSS, and write I/O respectively (de-duplicated by PID).
func selectTopProcesses(infos []procInfo, n int) []procInfo {
	type ranked struct {
		info  procInfo
		score float64
	}

	pickTop := func(score func(procInfo) float64) []procInfo {
		all := make([]ranked, len(infos))
		for i, info := range infos {
			all[i] = ranked{info, score(info)}
		}
		// simple selection sort for top-n (n is small)
		result := make([]procInfo, 0, n)
		taken := make(map[int]bool)
		for range min(n, len(all)) {
			best := -1
			for j, r := range all {
				if !taken[j] && (best < 0 || r.score > all[best].score) {
					best = j
				}
			}
			if best < 0 {
				break
			}
			taken[best] = true
			result = append(result, all[best].info)
		}
		return result
	}

	byCPU  := pickTop(func(p procInfo) float64 { return p.cpuPct })
	byMem  := pickTop(func(p procInfo) float64 { return float64(p.rssKB) })
	byIO   := pickTop(func(p procInfo) float64 { return float64(p.writeBPS + p.readBPS) })

	seen := make(map[int]bool)
	var result []procInfo
	for _, set := range [][]procInfo{byCPU, byMem, byIO} {
		for _, p := range set {
			if !seen[p.pid] {
				seen[p.pid] = true
				result = append(result, p)
			}
		}
	}
	return result
}

func roundFloat(f float64, places int) float64 {
	pow := 1.0
	for i := 0; i < places; i++ {
		pow *= 10
	}
	return float64(int(f*pow+0.5)) / pow
}

func truncate(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

// newUUID generates a random UUID v4 string without external dependencies.
func newUUID() string {
	f, err := os.Open("/dev/urandom")
	if err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	defer f.Close()
	b := make([]byte, 16)
	f.Read(b) //nolint:errcheck
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
