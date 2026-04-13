package collector

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

type netDevCounters struct {
	rxBytes uint64
	rxErrs  uint64
	rxDrops uint64
	txBytes uint64
	txErrs  uint64
	txDrops uint64
}

type hyperBackupFallbackState struct {
	lastResult string
	errorCode  int
}

type InfraCollector struct {
	sender     *sender.Sender
	nasID      string
	watchPaths []string
	interval   time.Duration

	prevNetCounters map[string]netDevCounters
	prevNetTime     time.Time
	prevLinkState   map[string]string
	prevShareUsed   map[string]uint64
	prevHBState     map[string]hyperBackupFallbackState
}

func NewInfraCollector(s *sender.Sender, nasID string, watchPaths []string, interval time.Duration) *InfraCollector {
	return &InfraCollector{
		sender:          s,
		nasID:           nasID,
		watchPaths:      watchPaths,
		interval:        interval,
		prevNetCounters: make(map[string]netDevCounters),
		prevLinkState:   make(map[string]string),
		prevShareUsed:   make(map[string]uint64),
		prevHBState:     make(map[string]hyperBackupFallbackState),
	}
}

func (c *InfraCollector) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.collect()
	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			return
		}
	}
}

func (c *InfraCollector) collect() {
	now := time.Now().UTC()
	c.collectInterfaceStats(now)
	c.collectShareUsage(now)
	c.collectHyperBackupFallback(now)
}

func (c *InfraCollector) collectInterfaceStats(now time.Time) {
	f, err := os.Open("/host/proc/net/dev")
	if err != nil {
		return
	}
	defer f.Close()

	current := make(map[string]netDevCounters)
	scanner := bufio.NewScanner(f)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		if lineNo <= 2 {
			continue
		}
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if len(fields) < 16 || iface == "lo" {
			continue
		}
		current[iface] = netDevCounters{
			rxBytes: mustUint(fields[0]),
			rxErrs:  mustUint(fields[2]),
			rxDrops: mustUint(fields[3]),
			txBytes: mustUint(fields[8]),
			txErrs:  mustUint(fields[10]),
			txDrops: mustUint(fields[11]),
		}
	}

	elapsed := now.Sub(c.prevNetTime).Seconds()
	for iface, cur := range current {
		linkState := strings.TrimSpace(readSmallFile(filepath.Join("/host/sys/class/net", iface, "operstate")))
		if linkState == "" {
			linkState = "unknown"
		}
		carrier := strings.TrimSpace(readSmallFile(filepath.Join("/host/sys/class/net", iface, "carrier")))
		speed := strings.TrimSpace(readSmallFile(filepath.Join("/host/sys/class/net", iface, "speed")))
		linkUp := 0.0
		if linkState == "up" || carrier == "1" {
			linkUp = 1
		}
		c.sender.QueueMetric(sender.MetricPayload{
			NasID:      c.nasID,
			Type:       "net_link_up",
			Value:      linkUp,
			Unit:       "bool",
			RecordedAt: now,
			Metadata:   map[string]interface{}{"interface": iface},
		})
		if speed != "" {
			if mbps, err := strconv.ParseFloat(speed, 64); err == nil && mbps >= 0 {
				c.sender.QueueMetric(sender.MetricPayload{
					NasID:      c.nasID,
					Type:       "net_link_speed_mbps",
					Value:      mbps,
					Unit:       "Mbps",
					RecordedAt: now,
					Metadata:   map[string]interface{}{"interface": iface},
				})
			}
		}

		if prev := c.prevLinkState[iface]; prev != "" && prev != linkState {
			severity := "info"
			if linkState != "up" {
				severity = "warning"
			}
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "network_path",
				Severity: severity,
				Message:  fmt.Sprintf("Interface %s state changed: %s -> %s", iface, prev, linkState),
				Metadata: map[string]interface{}{"interface": iface, "previous_state": prev, "state": linkState},
				LoggedAt: now,
			})
		}
		c.prevLinkState[iface] = linkState

		prev, ok := c.prevNetCounters[iface]
		if !ok || elapsed <= 0 {
			continue
		}

		emitDeltaMetric(c.sender, c.nasID, now, "net_rx_bps", "bytes/s", iface, cur.rxBytes, prev.rxBytes, elapsed)
		emitDeltaMetric(c.sender, c.nasID, now, "net_tx_bps", "bytes/s", iface, cur.txBytes, prev.txBytes, elapsed)
		emitDeltaMetric(c.sender, c.nasID, now, "net_rx_errors_ps", "errors/s", iface, cur.rxErrs, prev.rxErrs, elapsed)
		emitDeltaMetric(c.sender, c.nasID, now, "net_tx_errors_ps", "errors/s", iface, cur.txErrs, prev.txErrs, elapsed)
		emitDeltaMetric(c.sender, c.nasID, now, "net_rx_drops_ps", "drops/s", iface, cur.rxDrops, prev.rxDrops, elapsed)
		emitDeltaMetric(c.sender, c.nasID, now, "net_tx_drops_ps", "drops/s", iface, cur.txDrops, prev.txDrops, elapsed)
	}

	c.prevNetCounters = current
	c.prevNetTime = now
}

func (c *InfraCollector) collectShareUsage(now time.Time) {
	for _, path := range c.watchPaths {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(path, &stat); err != nil {
			continue
		}
		total := stat.Blocks * uint64(stat.Bsize)
		free := stat.Bavail * uint64(stat.Bsize)
		used := total - free
		usedPct := 0.0
		if total > 0 {
			usedPct = float64(used) / float64(total) * 100
		}

		label := shareLabel(path)
		meta := map[string]interface{}{"path": path, "share": label}
		c.sender.QueueMetric(sender.MetricPayload{NasID: c.nasID, Type: "share_used_bytes", Value: float64(used), Unit: "bytes", Metadata: meta, RecordedAt: now})
		c.sender.QueueMetric(sender.MetricPayload{NasID: c.nasID, Type: "share_free_bytes", Value: float64(free), Unit: "bytes", Metadata: meta, RecordedAt: now})
		c.sender.QueueMetric(sender.MetricPayload{NasID: c.nasID, Type: "share_used_pct", Value: usedPct, Unit: "percent", Metadata: meta, RecordedAt: now})

		if prev := c.prevShareUsed[path]; prev > 0 && used > prev {
			delta := used - prev
			c.sender.QueueMetric(sender.MetricPayload{
				NasID:      c.nasID,
				Type:       "share_growth_bytes",
				Value:      float64(delta),
				Unit:       "bytes",
				Metadata:   meta,
				RecordedAt: now,
			})
		}
		c.prevShareUsed[path] = used
	}
}

func (c *InfraCollector) collectHyperBackupFallback(now time.Time) {
	statePath := "/host/appdata/HyperBackup/config/task_state.conf"
	resultPath := "/host/appdata/HyperBackup/last_result/backup.last"

	taskStates := parseIniSections(readSmallFile(statePath))
	taskResults := parseIniSections(readSmallFile(resultPath))
	if len(taskResults) == 0 {
		return
	}

	for section, fields := range taskResults {
		if !strings.HasPrefix(section, "task_") {
			continue
		}
		taskID := strings.TrimPrefix(section, "task_")
		result := fields["result"]
		errorCode := mustInt(fields["error_code"])
		status := ""
		if stateFields, ok := taskStates[section]; ok {
			status = firstNonEmpty(stateFields["state"], stateFields["last_state"])
		}
		lastRun := unixToRFC3339(fields["end_time"])
		lastSuccess := unixToRFC3339(fields["last_backup_success_time"])

		if lastSuccess != "" {
			if ts, err := time.Parse(time.RFC3339, lastSuccess); err == nil {
				c.sender.QueueMetric(sender.MetricPayload{
					NasID:      c.nasID,
					Type:       "hyperbackup_last_success_age_seconds",
					Value:      now.Sub(ts).Seconds(),
					Unit:       "seconds",
					RecordedAt: now,
					Metadata:   map[string]interface{}{"task_id": taskID},
				})
			}
		}
		c.sender.QueueMetric(sender.MetricPayload{
			NasID:      c.nasID,
			Type:       "hyperbackup_error_code",
			Value:      float64(errorCode),
			Unit:       "code",
			RecordedAt: now,
			Metadata:   map[string]interface{}{"task_id": taskID, "status": status},
		})

		prev := c.prevHBState[taskID]
		if prev.lastResult != "" && (prev.lastResult != result || prev.errorCode != errorCode) {
			severity := "info"
			if errorCode != 0 || (result != "" && result != "done") {
				severity = "warning"
			}
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "hyperbackup_fallback",
				Severity: severity,
				Message:  fmt.Sprintf("Hyper Backup task %s result changed: %s/%d -> %s/%d", taskID, prev.lastResult, prev.errorCode, result, errorCode),
				Metadata: map[string]interface{}{"task_id": taskID, "status": status, "last_run_time": lastRun, "last_success_time": lastSuccess},
				LoggedAt: now,
			})
		}
		if errorCode != 0 || (result != "" && result != "done") {
			c.sender.QueueLog(sender.LogPayload{
				NasID:    c.nasID,
				Source:   "hyperbackup_fallback",
				Severity: "warning",
				Message:  fmt.Sprintf("Hyper Backup task %s result=%s error_code=%d status=%s", taskID, result, errorCode, status),
				Metadata: map[string]interface{}{"task_id": taskID, "last_run_time": lastRun, "last_success_time": lastSuccess},
				LoggedAt: now,
			})
		}
		c.prevHBState[taskID] = hyperBackupFallbackState{lastResult: result, errorCode: errorCode}
	}
}

func emitDeltaMetric(s *sender.Sender, nasID string, now time.Time, metricType, unit, iface string, cur, prev uint64, elapsed float64) {
	if cur < prev || elapsed <= 0 {
		return
	}
	s.QueueMetric(sender.MetricPayload{
		NasID:      nasID,
		Type:       metricType,
		Value:      float64(cur-prev) / elapsed,
		Unit:       unit,
		RecordedAt: now,
		Metadata:   map[string]interface{}{"interface": iface},
	})
}

func readSmallFile(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(data)
}

func parseIniSections(raw string) map[string]map[string]string {
	result := make(map[string]map[string]string)
	section := ""
	scanner := bufio.NewScanner(strings.NewReader(raw))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.TrimSuffix(strings.TrimPrefix(line, "["), "]")
			if _, ok := result[section]; !ok {
				result[section] = make(map[string]string)
			}
			continue
		}
		if section == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		result[section][strings.TrimSpace(key)] = strings.Trim(strings.TrimSpace(value), `"`)
	}
	return result
}

func unixToRFC3339(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" || raw == "0" {
		return ""
	}
	secs, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || secs <= 0 {
		return ""
	}
	return time.Unix(secs, 0).UTC().Format(time.RFC3339)
}

func mustUint(raw string) uint64 {
	v, _ := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	return v
}

func mustInt(raw string) int {
	v, _ := strconv.Atoi(strings.TrimSpace(raw))
	return v
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func shareLabel(path string) string {
	clean := filepath.Clean(path)
	base := filepath.Base(clean)
	if base == "." || base == "/" {
		return clean
	}
	return base
}
