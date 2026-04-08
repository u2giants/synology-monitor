package collector

// ServiceHealthCollector tracks the running status of key DSM services and
// packages. This data helps the resolution agent determine whether a service
// crash/restart pattern is contributing to observed issues.

import (
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

// Key DSM services to monitor — these are the ones most relevant to Drive,
// file sharing, and overall NAS health.
var monitoredServices = []string{
	"SynologyDrive",
	"SynologyDriveShareSync",
	"smbd",
	"nmbd",
	"nginx",
	"sshd",
	"nfsd",
	"pgsql",
	"synoscgi",
	"synoindexd",
	"synologydrive-server",
	"syslog-ng",
}

type ServiceHealthCollector struct {
	sender       *sender.Sender
	nasID        string
	interval     time.Duration
	mu           sync.Mutex
	prevStatus   map[string]string
	restartCount map[string]int
}

func NewServiceHealthCollector(s *sender.Sender, nasID string, interval time.Duration) *ServiceHealthCollector {
	return &ServiceHealthCollector{
		sender:       s,
		nasID:        nasID,
		interval:     interval,
		prevStatus:   make(map[string]string),
		restartCount: make(map[string]int),
	}
}

func (c *ServiceHealthCollector) Run(stop <-chan struct{}) {
	log.Printf("[service-health] started (every %s)", c.interval)
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.collect()
	for {
		select {
		case <-ticker.C:
			c.collect()
		case <-stop:
			log.Println("[service-health] stopped")
			return
		}
	}
}

func (c *ServiceHealthCollector) collect() {
	now := time.Now().UTC()

	c.mu.Lock()
	defer c.mu.Unlock()

	for _, svc := range monitoredServices {
		status := c.checkService(svc)
		prev := c.prevStatus[svc]

		// Detect transitions
		if prev != "" && prev != status {
			if prev == "running" && status == "stopped" {
				c.restartCount[svc]++
				c.sender.QueueLog(sender.LogPayload{
					NasID:    c.nasID,
					Source:   "service_restart",
					Severity: "warning",
					Message:  svc + " stopped",
					Metadata: map[string]interface{}{
						"service":       svc,
						"event":         "stopped",
						"restart_count": c.restartCount[svc],
					},
					LoggedAt: now,
				})
			} else if prev == "stopped" && status == "running" {
				c.sender.QueueLog(sender.LogPayload{
					NasID:    c.nasID,
					Source:   "service_restart",
					Severity: "info",
					Message:  svc + " restarted",
					Metadata: map[string]interface{}{
						"service":       svc,
						"event":         "restarted",
						"restart_count": c.restartCount[svc],
					},
					LoggedAt: now,
				})
			}
		}

		c.sender.QueueServiceHealth(sender.ServiceHealthPayload{
			NasID:       c.nasID,
			ServiceName: svc,
			Status:      status,
			CapturedAt:  now,
		})

		// Emit uptime as a companion metric
		if uptime := c.getServiceUptime(svc); uptime > 0 {
			c.sender.QueueMetric(sender.MetricPayload{
				NasID: c.nasID,
				Type:  "service_uptime",
				Value: float64(uptime),
				Unit:  "seconds",
				Metadata: map[string]interface{}{
					"service": svc,
				},
				RecordedAt: now,
			})
		}

		c.prevStatus[svc] = status
	}

	// Also check for any recently restarted services via uptime
	c.checkRecentRestarts(now)
}

func (c *ServiceHealthCollector) checkService(name string) string {
	// Try synoservicectl first (Synology-specific)
	out, err := exec.Command("synoservicectl", "--status", name).CombinedOutput()
	if err == nil {
		s := strings.ToLower(string(out))
		if strings.Contains(s, "running") {
			return "running"
		}
		if strings.Contains(s, "stop") {
			return "stopped"
		}
		return strings.TrimSpace(string(out))
	}

	// Fallback: try synopkg for package-based services
	out, err = exec.Command("synopkg", "status", name).CombinedOutput()
	if err == nil {
		s := strings.ToLower(string(out))
		if strings.Contains(s, "running") || strings.Contains(s, "started") {
			return "running"
		}
		if strings.Contains(s, "stop") {
			return "stopped"
		}
		return strings.TrimSpace(string(out))
	}

	// Fallback: check if process exists
	out, _ = exec.Command("pgrep", "-f", name).CombinedOutput()
	if len(strings.TrimSpace(string(out))) > 0 {
		return "running"
	}
	return "not_found"
}

// getServiceUptime returns the uptime in seconds of the oldest matching process,
// or 0 if the process is not found or the command fails.
func (c *ServiceHealthCollector) getServiceUptime(name string) int64 {
	out, err := exec.Command("sh", "-c",
		"ps -o etimes= -p $(pgrep -n -f '"+name+"' 2>/dev/null) 2>/dev/null | head -1").Output()
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(out))
	if s == "" {
		return 0
	}
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func (c *ServiceHealthCollector) checkRecentRestarts(now time.Time) {
	// Look for OOM kills or service crashes in dmesg
	out, err := exec.Command("sh", "-c",
		`dmesg --time-format iso 2>/dev/null | tail -200 | grep -iE "oom|kill|segfault|panic" || true`).CombinedOutput()
	if err != nil {
		return
	}

	msg := strings.TrimSpace(string(out))
	if msg == "" {
		return
	}

	// Log as a metric so the AI can see kernel-level issues
	c.sender.QueueLog(sender.LogPayload{
		NasID:    c.nasID,
		Source:   "kernel_health",
		Severity: "warning",
		Message:  msg,
		LoggedAt: now,
	})
}
