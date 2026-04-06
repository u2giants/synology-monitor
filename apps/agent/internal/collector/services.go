package collector

// ServiceHealthCollector tracks the running status of key DSM services and
// packages. This data helps the resolution agent determine whether a service
// crash/restart pattern is contributing to observed issues.

import (
	"log"
	"os/exec"
	"strings"
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
	sender   *sender.Sender
	nasID    string
	interval time.Duration
}

func NewServiceHealthCollector(s *sender.Sender, nasID string, interval time.Duration) *ServiceHealthCollector {
	return &ServiceHealthCollector{sender: s, nasID: nasID, interval: interval}
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

	for _, svc := range monitoredServices {
		status := c.checkService(svc)
		c.sender.QueueServiceHealth(sender.ServiceHealthPayload{
			NasID:       c.nasID,
			ServiceName: svc,
			Status:      status,
			CapturedAt:  now,
		})
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
