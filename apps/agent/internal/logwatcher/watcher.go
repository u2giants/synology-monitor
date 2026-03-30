package logwatcher

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

// LogWatcher tails DSM log files and sends parsed entries to Supabase
type LogWatcher struct {
	sender   *sender.Sender
	nasID    string
	logDir   string
	interval time.Duration
	offsets  map[string]int64
}

// LogFile defines a DSM log file to watch
type LogFile struct {
	Path   string
	Source string
}

var defaultLogFiles = []LogFile{
	{Path: "messages", Source: "system"},
	{Path: "synobackup.log", Source: "system"},
	{Path: "synolog/synosecurity.log", Source: "security"},
	{Path: "synolog/synoconnection.log", Source: "connection"},
	{Path: "synolog/synopkg.log", Source: "package"},
}

func New(s *sender.Sender, nasID, logDir string, interval time.Duration) *LogWatcher {
	return &LogWatcher{
		sender:   s,
		nasID:    nasID,
		logDir:   logDir,
		interval: interval,
		offsets:  make(map[string]int64),
	}
}

func (w *LogWatcher) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	log.Printf("[logwatcher] started (interval: %s, dir: %s)", w.interval, w.logDir)

	// Initialize offsets to end of file (don't replay history on first start)
	for _, lf := range defaultLogFiles {
		fullPath := filepath.Join(w.logDir, lf.Path)
		if info, err := os.Stat(fullPath); err == nil {
			w.offsets[fullPath] = info.Size()
		}
	}

	for {
		select {
		case <-ticker.C:
			w.scan()
		case <-stop:
			log.Println("[logwatcher] stopped")
			return
		}
	}
}

func (w *LogWatcher) scan() {
	for _, lf := range defaultLogFiles {
		fullPath := filepath.Join(w.logDir, lf.Path)
		w.tailFile(fullPath, lf.Source)
	}
}

func (w *LogWatcher) tailFile(path, source string) {
	f, err := os.Open(path)
	if err != nil {
		return // File may not exist on this NAS
	}
	defer f.Close()

	// Get current size
	info, err := f.Stat()
	if err != nil {
		return
	}

	prevOffset := w.offsets[path]

	// Handle log rotation (file shrunk)
	if info.Size() < prevOffset {
		prevOffset = 0
	}

	// No new data
	if info.Size() == prevOffset {
		return
	}

	// Seek to last known position
	f.Seek(prevOffset, io.SeekStart)

	scanner := bufio.NewScanner(f)
	count := 0
	maxLines := 1000 // Cap per scan to avoid huge batches

	for scanner.Scan() && count < maxLines {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		entry := parseLine(line, source)
		w.sender.QueueLog(sender.LogPayload{
			NasID:    w.nasID,
			Source:   source,
			Severity: entry.severity,
			Message:  entry.message,
			Metadata: entry.metadata,
			LoggedAt: entry.timestamp,
		})
		count++
	}

	// Update offset
	newOffset, _ := f.Seek(0, io.SeekCurrent)
	w.offsets[path] = newOffset

	if count > 0 {
		log.Printf("[logwatcher] %s: ingested %d new lines", filepath.Base(path), count)
	}
}

type parsedEntry struct {
	timestamp time.Time
	severity  string
	message   string
	metadata  map[string]interface{}
}

func parseLine(line, source string) parsedEntry {
	entry := parsedEntry{
		timestamp: time.Now(),
		severity:  "info",
		message:   line,
	}

	// Try to parse syslog-style timestamp (e.g., "Mar 30 12:34:56")
	if len(line) > 15 {
		ts, err := time.Parse("Jan  2 15:04:05", line[:15])
		if err == nil {
			ts = ts.AddDate(time.Now().Year(), 0, 0)
			entry.timestamp = ts
			entry.message = strings.TrimSpace(line[15:])
		}
	}

	// Detect severity from content
	lower := strings.ToLower(line)
	switch {
	case strings.Contains(lower, "error") || strings.Contains(lower, "fail"):
		entry.severity = "error"
	case strings.Contains(lower, "warn"):
		entry.severity = "warning"
	case strings.Contains(lower, "crit") || strings.Contains(lower, "emerg") || strings.Contains(lower, "panic"):
		entry.severity = "critical"
	}

	// Security-specific parsing
	if source == "security" {
		entry.metadata = parseSecurityLog(line)
		if strings.Contains(lower, "failed") && strings.Contains(lower, "login") {
			entry.severity = "warning"
		}
		if strings.Contains(lower, "blocked") || strings.Contains(lower, "banned") {
			entry.severity = "error"
		}
	}

	// Connection log parsing
	if source == "connection" {
		entry.metadata = parseConnectionLog(line)
	}

	return entry
}

func parseSecurityLog(line string) map[string]interface{} {
	meta := make(map[string]interface{})

	// Extract IP addresses (simple pattern)
	parts := strings.Fields(line)
	for _, p := range parts {
		if looksLikeIP(p) {
			meta["ip"] = p
			break
		}
	}

	// Extract username if present
	for i, p := range parts {
		if (p == "user" || p == "User" || p == "account") && i+1 < len(parts) {
			meta["user"] = strings.Trim(parts[i+1], "[]()\"'")
			break
		}
	}

	return meta
}

func parseConnectionLog(line string) map[string]interface{} {
	meta := make(map[string]interface{})

	parts := strings.Fields(line)
	for _, p := range parts {
		if looksLikeIP(p) {
			meta["ip"] = p
			break
		}
	}

	// Detect service
	lower := strings.ToLower(line)
	for _, svc := range []string{"smb", "afp", "ftp", "ssh", "webdav", "rsync"} {
		if strings.Contains(lower, svc) {
			meta["service"] = svc
			break
		}
	}

	return meta
}

func looksLikeIP(s string) bool {
	s = strings.Trim(s, "[]()\"'")
	dots := 0
	for _, c := range s {
		if c == '.' {
			dots++
		} else if c < '0' || c > '9' {
			return false
		}
	}
	return dots == 3 && len(s) >= 7
}

// fmt import used by the package
var _ = fmt.Sprintf
