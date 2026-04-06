package collector

// CustomCollector polls smon_custom_metric_schedules from Supabase and executes
// read-only shell commands requested by the resolution agent at runtime.
//
// This allows the resolution agent to permanently expand what data the monitoring
// agent collects without any code changes or container rebuilds. The agent picks
// up new schedules within 60 seconds and starts collecting immediately.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

// CustomCollector polls and executes custom metric collection schedules.
type CustomCollector struct {
	sender       *sender.Sender
	nasName      string // matches smon_custom_metric_schedules.nas_id (e.g. "edgesynology1")
	supabaseURL  string
	serviceKey   string
	httpClient   *http.Client
	pollInterval time.Duration
}

type customSchedule struct {
	ID                string `json:"id"`
	Name              string `json:"name"`
	Description       string `json:"description"`
	CollectionCommand string `json:"collection_command"`
	IntervalMinutes   int    `json:"interval_minutes"`
}

func NewCustomCollector(s *sender.Sender, nasName, supabaseURL, serviceKey string) *CustomCollector {
	return &CustomCollector{
		sender:       s,
		nasName:      nasName,
		supabaseURL:  supabaseURL,
		serviceKey:   serviceKey,
		httpClient:   &http.Client{Timeout: 15 * time.Second},
		pollInterval: 60 * time.Second,
	}
}

func (c *CustomCollector) Run(stop <-chan struct{}) {
	log.Printf("[custom-collector] started for NAS %q (polls every %s)", c.nasName, c.pollInterval)
	ticker := time.NewTicker(c.pollInterval)
	defer ticker.Stop()

	// Run once on startup
	c.runDue()

	for {
		select {
		case <-ticker.C:
			c.runDue()
		case <-stop:
			log.Println("[custom-collector] stopped")
			return
		}
	}
}

func (c *CustomCollector) runDue() {
	now := time.Now().UTC().Format(time.RFC3339Nano)

	// Fetch due schedules for this NAS via Supabase REST API
	endpoint := fmt.Sprintf(
		"%s/rest/v1/smon_custom_metric_schedules?nas_id=eq.%s&is_active=eq.true&next_run_at=lte.%s&select=id,name,description,collection_command,interval_minutes",
		c.supabaseURL,
		url.QueryEscape(c.nasName),
		url.QueryEscape(now),
	)

	req, err := http.NewRequest("GET", endpoint, nil)
	if err != nil {
		log.Printf("[custom-collector] request build error: %v", err)
		return
	}
	c.addHeaders(req)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[custom-collector] fetch error: %v", err)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		log.Printf("[custom-collector] fetch HTTP %d: %s", resp.StatusCode, string(body))
		return
	}

	var schedules []customSchedule
	if err := json.Unmarshal(body, &schedules); err != nil {
		log.Printf("[custom-collector] decode error: %v", err)
		return
	}

	for _, sched := range schedules {
		if c.claim(sched) {
			c.execute(sched)
		}
	}
}

// claim updates last_run_at / next_run_at with an optimistic lock on next_run_at.
// Returns true only if this agent instance won the claim (prevents double-runs
// if two agents share a schedule, e.g. during a rolling restart).
func (c *CustomCollector) claim(sched customSchedule) bool {
	now := time.Now().UTC()
	interval := time.Duration(max(1, sched.IntervalMinutes)) * time.Minute
	nextRun := now.Add(interval)

	patch := map[string]string{
		"last_run_at": now.Format(time.RFC3339Nano),
		"next_run_at": nextRun.Format(time.RFC3339Nano),
	}
	patchBody, _ := json.Marshal(patch)

	// Filter: only update if still due (id match + next_run_at still in the past)
	endpoint := fmt.Sprintf(
		"%s/rest/v1/smon_custom_metric_schedules?id=eq.%s&next_run_at=lte.%s",
		c.supabaseURL,
		url.QueryEscape(sched.ID),
		url.QueryEscape(now.Format(time.RFC3339Nano)),
	)

	req, err := http.NewRequest("PATCH", endpoint, bytes.NewReader(patchBody))
	if err != nil {
		return false
	}
	c.addHeaders(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "return=representation")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[custom-collector] claim error for %q: %v", sched.Name, err)
		return false
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)
	var claimed []map[string]interface{}
	_ = json.Unmarshal(respBody, &claimed)
	return len(claimed) > 0
}

// execute runs the shell command and queues the output via the sender WAL.
func (c *CustomCollector) execute(sched customSchedule) {
	log.Printf("[custom-collector] running %q: %s", sched.Name, sched.CollectionCommand)

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", sched.CollectionCommand)
	var stdout, stderr strings.Builder
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	rawOutput := stdout.String()
	if s := stderr.String(); s != "" {
		rawOutput += "\nSTDERR:\n" + s
	}
	if len(rawOutput) > 50_000 {
		rawOutput = rawOutput[:50_000] + "\n[truncated]"
	}

	var errStr string
	if err != nil {
		errStr = err.Error()
	}

	c.sender.QueueCustomMetricData(sender.CustomMetricDataPayload{
		ScheduleID: sched.ID,
		NasID:      c.nasName,
		RawOutput:  rawOutput,
		Error:      errStr,
		CapturedAt: time.Now().UTC(),
	})
}

func (c *CustomCollector) addHeaders(req *http.Request) {
	req.Header.Set("apikey", c.serviceKey)
	req.Header.Set("Authorization", "Bearer "+c.serviceKey)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
