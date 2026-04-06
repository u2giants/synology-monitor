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
	sender             *sender.Sender
	nasID              string
	logDir             string
	interval           time.Duration
	offsets            map[string]int64
	logFiles           []LogFile
	bootstrapDriveTail int
}

// LogFile defines a DSM log file to watch
type LogFile struct {
	Path   string
	Source string
}

var defaultLogFiles = []LogFile{
	{Path: "messages", Source: "system"},
	{Path: "synobackup.log", Source: "system"},
	{Path: "synologydrive.log", Source: "drive_server"},
	{Path: "synolog/synosecurity.log", Source: "security"},
	{Path: "synolog/synoconnection.log", Source: "connection"},
	{Path: "synolog/synopkg.log", Source: "package"},
	{Path: "samba/log.smbd", Source: "smb"},
	{Path: "samba/log.nmbd", Source: "smb"},
	// --- Logs critical for diagnosing share/sync issues ---
	{Path: "synolog/synowebapi.log", Source: "webapi"},        // "Failed to SYNOShareGet" errors live HERE
	{Path: "synolog/synostorage.log", Source: "storage"},      // Share/volume management operations
	{Path: "synolog/synoshare.log", Source: "share"},          // Share database ops (create/delete/get errors)
	{Path: "kern.log", Source: "kernel"},                      // I/O stalls, SCSI errors, disk faults
	{Path: "synolog/synoinfo.log", Source: "system_info"},     // System config changes
	{Path: "synolog/synoservice.log", Source: "service"},      // Service start/stop/crash events
}

func New(s *sender.Sender, nasID, logDir string, watchPaths, extraLogFiles []string, interval time.Duration) *LogWatcher {
	logFiles := make([]LogFile, 0, len(defaultLogFiles)+len(watchPaths)+len(extraLogFiles))
	logFiles = append(logFiles, defaultLogFiles...)
	logFiles = append(logFiles, inferDriveLogFiles(watchPaths)...)
	logFiles = append(logFiles, parseExtraLogFiles(extraLogFiles)...)

	return &LogWatcher{
		sender:             s,
		nasID:              nasID,
		logDir:             logDir,
		interval:           interval,
		offsets:            make(map[string]int64),
		logFiles:           dedupeLogFiles(logFiles),
		bootstrapDriveTail: 200,
	}
}

func (w *LogWatcher) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	log.Printf("[logwatcher] started (interval: %s, dir: %s)", w.interval, w.logDir)

	// Bootstrap recent Drive history once on startup, then tail from EOF.
	for _, lf := range w.logFiles {
		for _, fullPath := range w.expandLogFile(lf) {
			if info, err := os.Stat(fullPath); err == nil {
				if strings.HasPrefix(lf.Source, "drive") {
					w.bootstrapFile(fullPath, lf.Source, w.bootstrapDriveTail)
				}
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

func (w *LogWatcher) bootstrapFile(path, source string, maxLines int) {
	lines, err := readLastLines(path, maxLines)
	if err != nil || len(lines) == 0 {
		return
	}

	count := 0
	for _, line := range lines {
		line = strings.TrimSpace(line)
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

	if count > 0 {
		log.Printf("[logwatcher] %s: bootstrapped %d recent %s lines", filepath.Base(path), count, source)
	}
}

func readLastLines(path string, maxLines int) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	// Seek to end of file to calculate size
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}

	fileSize := info.Size()
	if fileSize == 0 {
		return nil, nil
	}

	// Use a ring buffer approach - read from end, count lines
	// Start from a reasonable chunk size estimate (avg 200 bytes per line)
	chunkSize := int64(maxLines * 200)
	if chunkSize < 4096 {
		chunkSize = 4096
	}
	if chunkSize > fileSize {
		chunkSize = fileSize
	}

	lines := make([]string, 0, maxLines)
	offset := fileSize - chunkSize

	for offset >= 0 && len(lines) < maxLines {
		_, err := f.Seek(offset, io.SeekStart)
		if err != nil {
			return nil, err
		}

		// Read a chunk
		data := make([]byte, chunkSize)
		n, err := f.Read(data)
		if err != nil && err != io.EOF {
			return nil, err
		}
		if n == 0 {
			break
		}
		data = data[:n]

		// Count newlines
		count := 0
		for _, b := range data {
			if b == '\n' {
				count++
			}
		}

		// If we have enough lines, extract them
		if len(lines)+count >= maxLines {
			// Split and keep only what we need
			allLines := strings.Split(string(data), "\n")
			keep := maxLines - len(lines)
			if keep > 0 && keep <= len(allLines) {
				lines = append(lines, allLines[len(allLines)-keep:]...)
			}
			break
		}

		// Otherwise, add all lines and move back
		allLines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
		lines = append(allLines, lines...)
		offset -= chunkSize
	}

	// Trim to maxLines
	if len(lines) > maxLines {
		lines = lines[len(lines)-maxLines:]
	}

	return lines, nil
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

	if match := isoTimePattern.FindStringSubmatch(line); len(match) == 3 {
		if ts, err := time.Parse(time.RFC3339, match[1]); err == nil {
			entry.timestamp = ts
			entry.message = strings.TrimSpace(match[2])
		}
	} else if len(line) > 15 {
		// Try to parse syslog-style timestamp (e.g. "Mar 30 12:34:56")
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
	case strings.Contains(lower, "crit") || strings.Contains(lower, "emerg") || strings.Contains(lower, "panic"):
		entry.severity = "critical"
	case strings.Contains(lower, "error") || strings.Contains(lower, "[error]") || strings.Contains(lower, "fail"):
		entry.severity = "error"
	case strings.Contains(lower, "warn"):
		entry.severity = "warning"
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

	// SMB-specific parsing
	if source == "smb" {
		entry.metadata = parseSMBLog(line)
		// Filter out low-value/noise messages
		if shouldFilterSMBLine(entry.message) {
			entry.severity = "filter"
		}
		// Upgrade SMB errors
		if entry.severity == "info" && strings.Contains(lower, "error") {
			entry.severity = "error"
		}
	}

	if strings.HasPrefix(source, "drive") {
		entry.metadata = mergeMetadata(entry.metadata, parseDriveLog(entry.message))

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
	singleQuotedPath  = regexp.MustCompile(`'([^'\n]*?/[^'\n]+)'`)
	plainPathPattern  = regexp.MustCompile(`(/[^,\s]+)`)
	driveUserPattern  = regexp.MustCompile(`(?i)\b(?:user|username|account)\b[:= ]+["']?([^"',\s]+)`)
	driveByPattern    = regexp.MustCompile(`(?i)\bby\b\s+'?([^'(\s]+)`)
	driveUserQuoted   = regexp.MustCompile(`(?i)\buser\b\s+'([^']+)'`)
	drivePathField    = regexp.MustCompile(`(?i)\bpath\b\s*[:=]\s*'([^']+)'`)
	driveSharePath    = regexp.MustCompile(`(?i)\bshare_path\b\s*=\s*'([^']+)'`)
	driveNewSharePath = regexp.MustCompile(`(?i)\bnew_share_path\b\s*=\s*'([^']+)'`)
	driveShareName    = regexp.MustCompile(`(?i)\bshare_name\b\s*=\s*'([^']+)'`)
	driveNewShareName = regexp.MustCompile(`(?i)\bnew_share_name\b\s*=\s*'([^']+)'`)
	driveActionField  = regexp.MustCompile(`(?i)\baction\b\s*[:=]\s*'([A-Z_]+)'`)
	isoTimePattern    = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[+-]\d{2}:\d{2}|Z))\s+(.*)$`)
)

func parseDriveLog(line string) map[string]interface{} {
	meta := make(map[string]interface{})
	lower := strings.ToLower(line)

	if user := firstCapture(driveUserQuoted, line); user != "" {
		meta["user"] = normalizeDriveUser(user)
	} else if user := firstCapture(driveUserPattern, line); user != "" {
		meta["user"] = normalizeDriveUser(user)
	} else if user := firstCapture(driveByPattern, line); user != "" {
		meta["user"] = normalizeDriveUser(user)
	}

	if shareName := firstCapture(driveShareName, line); shareName != "" {
		meta["share_name"] = strings.TrimSpace(shareName)
	}
	if newShareName := firstCapture(driveNewShareName, line); newShareName != "" {
		meta["new_share_name"] = strings.TrimSpace(newShareName)
	}

	if path := extractDrivePath(line); path != "" {
		meta["path"] = path
	}

	switch {
	case strings.Contains(lower, "cloudstation::share"):
		meta["component"] = "sharesync"
	case strings.Contains(lower, "synoscgi_syno.synologydrive"):
		meta["component"] = "admin_console"
	case strings.Contains(lower, "clean-recycle-control"):
		meta["component"] = "admin_console"
	case strings.Contains(lower, "recycle"):
		meta["component"] = "admin_console"
	case strings.Contains(lower, "sharesnapshotnotify"):
		meta["component"] = "sharesync"
	case strings.Contains(lower, "sharepre") || strings.Contains(lower, "sharepost"):
		meta["component"] = "sharesync"
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
	case strings.Contains(lower, "<nativeremove>") || strings.Contains(lower, "removed successfully"):
		meta["action"] = "delete"
	case strings.Contains(lower, "delete") || strings.Contains(lower, "deleted") || strings.Contains(lower, "remove"):
		meta["action"] = "delete"
	case strings.Contains(lower, "create") || strings.Contains(lower, "created"):
		meta["action"] = "create"
	case strings.Contains(lower, "upload"):
		meta["action"] = "upload"
	case strings.Contains(lower, "download"):
		meta["action"] = "download"
	case strings.Contains(lower, "conflict"):
		meta["action"] = "sync_conflict"
	case strings.Contains(lower, "fail") || strings.Contains(lower, "error"):
		meta["action"] = "sync_failure"
	}

	if action := firstCapture(driveActionField, line); action != "" {
		switch strings.ToLower(strings.TrimSpace(action)) {
		case "create":
			meta["action"] = "create"
		case "delete":
			meta["action"] = "delete"
		case "rename":
			meta["action"] = "rename"
		case "move":
			meta["action"] = "move"
		}
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

func normalizeDriveUser(user string) string {
	user = strings.Trim(user, "[]()\"'")
	if idx := strings.LastIndex(user, `\`); idx >= 0 && idx+1 < len(user) {
		return user[idx+1:]
	}
	return user
}

func extractDrivePath(line string) string {
	if path := firstCapture(drivePathField, line); path != "" {
		return cleanDrivePath(path)
	}
	if path := firstCapture(driveSharePath, line); path != "" {
		return cleanDrivePath(path)
	}
	if path := firstCapture(driveNewSharePath, line); path != "" {
		return cleanDrivePath(path)
	}
	if path := extractPath(line); path != "" {
		return cleanDrivePath(path)
	}
	return ""
}

func extractPath(line string) string {
	if match := quotedPathPattern.FindStringSubmatch(line); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	if matches := singleQuotedPath.FindAllStringSubmatch(line, -1); len(matches) > 0 {
		best := ""
		for _, match := range matches {
			if len(match) < 2 {
				continue
			}
			candidate := strings.TrimSpace(match[1])
			if strings.Count(candidate, "/") >= strings.Count(best, "/") && len(candidate) > len(best) {
				best = candidate
			}
		}
		if best != "" {
			return best
		}
	}
	if match := plainPathPattern.FindStringSubmatch(line); len(match) > 1 {
		return strings.TrimSpace(match[1])
	}
	return ""
}

func cleanDrivePath(path string) string {
	path = strings.TrimSpace(path)
	path = strings.Trim(path, "[]()\"'")
	for _, delimiter := range []string{
		"' @",
		"' -",
		"' ->",
		"' |",
		"][",
		"](",
		"],",
	} {
		if idx := strings.Index(path, delimiter); idx >= 0 {
			path = path[:idx]
		}
	}
	path = strings.TrimRight(path, "],\"'")
	path = strings.TrimSpace(path)
	return path
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

// SMB log parsing

var (
	// Patterns for SMB log extraction
	smbPathPattern    = regexp.MustCompile(`smb_fname\(([^)]+)\)`)
	smbUserPattern    = regexp.MustCompile(`(?i)(?:user|authenticated|login|connect)[:\s]+'?([^'\s,]+)`)
	smbIPPattern      = regexp.MustCompile(`(?:ip|address)[:\s=]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})`)
	smbSessionPattern = regexp.MustCompile(`(?:session|connect).*(?:to|with) (\S+)`)

	// Noise patterns to filter out (high-volume low-value messages)
	smbNoisePatterns = []string{
		"Cannot get valid session",
		"ReloadConnPerProc",
		"is_symlink_path",
		"Failed to lstat",
		"NT_STATUS_USER_SESSION_DELETED",
		"SYNOSmbReloadConnPerProc",
		"is_symlink",
		"oplock",
	}

	// Enhanced user attribution patterns for Drive logs
	// These patterns handle various Synology log formats
	userPatterns = []*regexp.Regexp{
		regexp.MustCompile(`(?i)\buser\b\s*[:=]\s*'?([^'"\s,]+)`),
		regexp.MustCompile(`(?i)\busername\b\s*[:=]\s*'?([^'"\s,]+)`),
		regexp.MustCompile(`(?i)\baccount\b\s*[:=]\s*'?([^'"\s,]+)`),
		regexp.MustCompile(`(?i)\bby\s+'([^']+)'`),
		regexp.MustCompile(`(?i)\bby\s+(\S+@\S+)`),
		regexp.MustCompile(`(?i)\bowner\b\s*[:=]\s*'?([^'"\s,]+)`),
		regexp.MustCompile(`(?i)\binitiated\s+by\b\s*[:=]?\s*'?([^'"\s,]+)`),
		regexp.MustCompile(`(?i)\bfrom\s+user\b\s*[:=]?\s*'?([^'"\s,]+)`),
		regexp.MustCompile(`(?i)\bclient\b.*?user\b[:\s]+'?([^'"\s,]+)`),
	}
)

func parseSMBLog(line string) map[string]interface{} {
	meta := make(map[string]interface{})
	lower := strings.ToLower(line)

	// Extract file paths
	if matches := smbPathPattern.FindAllStringSubmatch(line, -1); len(matches) > 0 {
		paths := make([]string, 0, len(matches))
		for _, m := range matches {
			if len(m) > 1 {
				path := strings.TrimSpace(m[1])
				// Skip temp files, symlinks
				if !strings.HasPrefix(path, "~") && !strings.Contains(path, "No such file") {
					paths = append(paths, path)
				}
			}
		}
		if len(paths) > 0 {
			meta["file_paths"] = paths
			// Set primary path for easier querying
			if paths[0] != "" {
				meta["path"] = paths[0]
			}
		}
	}

	// Extract username
	if user := firstCapture(smbUserPattern, line); user != "" {
		meta["user"] = normalizeDriveUser(user)
	}

	// Extract IP address
	if ip := firstCapture(smbIPPattern, line); ip != "" {
		meta["ip"] = ip
	}

	// Detect SMB operation type
	switch {
	case strings.Contains(lower, "create") && !strings.Contains(lower, "created"):
		meta["operation"] = "create_pending"
	case strings.Contains(lower, "open") || strings.Contains(lower, "opened"):
		meta["operation"] = "open"
	case strings.Contains(lower, "close") || strings.Contains(lower, "closed"):
		meta["operation"] = "close"
	case strings.Contains(lower, "write") || strings.Contains(lower, "written"):
		meta["operation"] = "write"
	case strings.Contains(lower, "read"):
		meta["operation"] = "read"
	case strings.Contains(lower, "delete") || strings.Contains(lower, "unlink"):
		meta["operation"] = "delete"
	case strings.Contains(lower, "rename"):
		meta["operation"] = "rename"
	case strings.Contains(lower, "mkdir"):
		meta["operation"] = "mkdir"
	case strings.Contains(lower, "session") && (strings.Contains(lower, "connect") || strings.Contains(lower, "establish")):
		meta["operation"] = "session_connect"
	case strings.Contains(lower, "session") && strings.Contains(lower, "closed"):
		meta["operation"] = "session_close"
	case strings.Contains(lower, "connection"):
		meta["operation"] = "connection"
	}

	return meta
}

// shouldFilterSMBLine returns true if the SMB log line is noise/low-value
func shouldFilterSMBLine(line string) bool {
	// Filter by pattern
	for _, pattern := range smbNoisePatterns {
		if strings.Contains(line, pattern) {
			return true
		}
	}

	// Filter very short lines (usually noise)
	if len(line) < 50 {
		return true
	}

	// Filter lines that are only about symlinks/missing files
	lower := strings.ToLower(line)
	if strings.Contains(lower, "no such file") ||
		strings.Contains(lower, "cannot find") ||
		strings.Contains(lower, "does not exist") {
		// Keep some - might indicate deleted files
		if strings.Contains(lower, "smb_fname") && strings.Count(line, "smb_fname") < 2 {
			return true
		}
	}

	return false
}

// fmt import used by the package
var _ = fmt.Sprintf
