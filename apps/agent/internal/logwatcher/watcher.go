package logwatcher

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
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
	logFiles []LogFile
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

func New(s *sender.Sender, nasID, logDir string, watchPaths, extraLogFiles []string, interval time.Duration) *LogWatcher {
	logFiles := make([]LogFile, 0, len(defaultLogFiles)+len(watchPaths)+len(extraLogFiles))
	logFiles = append(logFiles, defaultLogFiles...)
	logFiles = append(logFiles, inferDriveLogFiles(watchPaths)...)
	logFiles = append(logFiles, parseExtraLogFiles(extraLogFiles)...)

	return &LogWatcher{
		sender:   s,
		nasID:    nasID,
		logDir:   logDir,
		interval: interval,
		offsets:  make(map[string]int64),
		logFiles: dedupeLogFiles(logFiles),
	}
}

func (w *LogWatcher) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	log.Printf("[logwatcher] started (interval: %s, dir: %s)", w.interval, w.logDir)

	// Initialize offsets to end of file (don't replay history on first start)
	for _, lf := range w.logFiles {
		for _, fullPath := range w.expandLogFile(lf) {
			if info, err := os.Stat(fullPath); err == nil {
				w.offsets[fullPath] = info.Size()
			}
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
	for _, lf := range w.logFiles {
		for _, fullPath := range w.expandLogFile(lf) {
			w.tailFile(fullPath, lf.Source)
		}
	}
}

func (w *LogWatcher) expandLogFile(lf LogFile) []string {
	path := lf.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(w.logDir, path)
	}

	if strings.ContainsAny(path, "*?[") {
		matches, err := filepath.Glob(path)
		if err != nil || len(matches) == 0 {
			return nil
		}
		return matches
	}

	return []string{path}
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

	if strings.HasPrefix(source, "drive") {
		entry.metadata = mergeMetadata(entry.metadata, parseDriveLog(line))

		if strings.Contains(lower, "conflict") {
			entry.severity = "warning"
		}
		if strings.Contains(lower, "error") || strings.Contains(lower, "fail") {
			entry.severity = "error"
		}
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

var (
	quotedPathPattern = regexp.MustCompile(`"([^"\n]*?/[^"\n]+)"`)
	plainPathPattern  = regexp.MustCompile(`(/[^,\s]+)`)
	driveUserPattern  = regexp.MustCompile(`(?i)\b(?:user|username|account)\b[:= ]+["']?([A-Za-z0-9._@-]+)`)
	driveByPattern    = regexp.MustCompile(`(?i)\bby\b\s+([A-Za-z0-9._@-]+)`)
)

func parseDriveLog(line string) map[string]interface{} {
	meta := make(map[string]interface{})
	lower := strings.ToLower(line)

	if user := firstCapture(driveUserPattern, line); user != "" {
		meta["user"] = user
	} else if user := firstCapture(driveByPattern, line); user != "" {
		meta["user"] = user
	}

	if path := extractPath(line); path != "" {
		meta["path"] = path
	}

	switch {
	case strings.Contains(lower, "sharesync"):
		meta["component"] = "sharesync"
	case strings.Contains(lower, "admin"):
		meta["component"] = "admin_console"
	default:
		meta["component"] = "drive"
	}

	switch {
	case strings.Contains(lower, "rename") || strings.Contains(lower, "renamed"):
		meta["action"] = "rename"
	case strings.Contains(lower, "move") || strings.Contains(lower, "moved"):
		meta["action"] = "move"
	case strings.Contains(lower, "delete") || strings.Contains(lower, "deleted") || strings.Contains(lower, "remove"):
		meta["action"] = "delete"
	case strings.Contains(lower, "conflict"):
		meta["action"] = "sync_conflict"
	case strings.Contains(lower, "fail") || strings.Contains(lower, "error"):
		meta["action"] = "sync_failure"
	}

	return meta
}

func firstCapture(pattern *regexp.Regexp, line string) string {
	match := pattern.FindStringSubmatch(line)
	if len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	return ""
}

func extractPath(line string) string {
	if match := quotedPathPattern.FindStringSubmatch(line); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	if match := plainPathPattern.FindStringSubmatch(line); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	return ""
}

func mergeMetadata(base, extra map[string]interface{}) map[string]interface{} {
	if len(extra) == 0 {
		return base
	}
	if base == nil {
		base = make(map[string]interface{}, len(extra))
	}
	for k, v := range extra {
		base[k] = v
	}
	return base
}

func inferDriveLogFiles(watchPaths []string) []LogFile {
	var files []LogFile
	for _, watchPath := range watchPaths {
		files = append(files,
			LogFile{Path: filepath.Join(watchPath, "@synologydrive/log/*.log"), Source: "drive"},
			LogFile{Path: filepath.Join(watchPath, "@synologydrive/log/syncfolder.log"), Source: "drive_sharesync"},
		)
	}
	return files
}

func parseExtraLogFiles(specs []string) []LogFile {
	var files []LogFile
	for _, spec := range specs {
		parts := strings.SplitN(spec, "|", 2)
		path := strings.TrimSpace(parts[0])
		if path == "" {
			continue
		}

		source := "custom"
		if len(parts) == 2 && strings.TrimSpace(parts[1]) != "" {
			source = strings.TrimSpace(parts[1])
		}

		files = append(files, LogFile{Path: path, Source: source})
	}
	return files
}

func dedupeLogFiles(logFiles []LogFile) []LogFile {
	seen := make(map[string]struct{}, len(logFiles))
	result := make([]LogFile, 0, len(logFiles))

	for _, lf := range logFiles {
		key := lf.Source + "\x00" + lf.Path
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, lf)
	}

	return result
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
