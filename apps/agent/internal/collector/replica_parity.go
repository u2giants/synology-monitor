package collector

// ReplicaParityCollector detects items that exist on the ShareSync source NAS
// (edgesynology1) but never arrived on the replica (edgesynology2).
//
// Why: on 2026-10-01 edge2 was found missing 1,646 items written on edge1 since
// 2026-09-17. ShareSync itself was healthy — edge1's Drive server simply never
// registered those items (root-owned writes from the seaf-cli container), so no
// log-based detector could see the gap. Only a filesystem comparison can.
//
// Both NAS agents run this collector; the role comes from the NAS id:
//   - source  : walks the replicated shares, publishes every path whose ctime is
//               inside the window to public.replica_manifests (one row, replaced).
//   - replica : polls that row; for each new scan it stats every published path
//               locally (same /host/shares/<share> mount layout) and raises a
//               "replica_parity" alert listing what is missing.
// Items younger than the grace period are skipped so in-flight sync is not
// reported, and ShareSync's own excluded names (temp files, shortcuts, Synology
// metadata) are ignored on both sides.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/synology-monitor/agent/internal/sender"
)

// ReplicaParityConfig holds the tunables. Defaults match production so no NAS
// .env change is needed (Watchtower only swaps images, never env).
type ReplicaParityConfig struct {
	SourceNasID  string
	ReplicaNasID string
	Roots        []string // container paths, identical on both NASes
	Window       time.Duration
	Grace        time.Duration
	ScanEvery    time.Duration
	PollEvery    time.Duration
	StartDelay   time.Duration
	MaxEntries   int
}

func DefaultReplicaParityConfig() ReplicaParityConfig {
	return ReplicaParityConfig{
		SourceNasID:  envOr("REPLICA_SOURCE_NAS_ID", "4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001"),
		ReplicaNasID: envOr("REPLICA_TARGET_NAS_ID", "9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002"),
		Roots: splitList(envOr("REPLICA_ROOTS",
			"/host/shares/mac,/host/shares/files,/host/shares/styleguides,/host/shares/users")),
		Window:     envDur("REPLICA_WINDOW", 50*time.Hour),
		Grace:      envDur("REPLICA_GRACE", time.Hour),
		ScanEvery:  envDur("REPLICA_SCAN_EVERY", 24*time.Hour),
		PollEvery:  envDur("REPLICA_POLL_EVERY", 10*time.Minute),
		StartDelay: envDur("REPLICA_START_DELAY", 5*time.Minute),
		MaxEntries: 200000,
	}
}

type ReplicaParityCollector struct {
	sender     *sender.Sender
	nasID      string
	cfg        ReplicaParityConfig
	baseURL    string
	serviceKey string
	http       *http.Client
}

func NewReplicaParityCollector(s *sender.Sender, nasID, supabaseURL, serviceKey string, cfg ReplicaParityConfig) *ReplicaParityCollector {
	return &ReplicaParityCollector{
		sender: s, nasID: nasID, cfg: cfg,
		baseURL: strings.TrimRight(supabaseURL, "/"), serviceKey: serviceKey,
		http: &http.Client{Timeout: 120 * time.Second},
	}
}

// manifestEntry is [relative path, ctime unix seconds].
type manifestEntry struct {
	Path  string
	Ctime int64
}

func (e manifestEntry) MarshalJSON() ([]byte, error) {
	return json.Marshal([]interface{}{e.Path, e.Ctime})
}
func (e *manifestEntry) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil || len(raw) != 2 {
		return fmt.Errorf("bad manifest entry")
	}
	if err := json.Unmarshal(raw[0], &e.Path); err != nil {
		return err
	}
	return json.Unmarshal(raw[1], &e.Ctime)
}

type replicaManifest struct {
	SourceNasID string          `json:"source_nas_id"`
	ScanID      string          `json:"scan_id"`
	ScannedAt   time.Time       `json:"scanned_at"`
	WindowHours int             `json:"window_hours"`
	Roots       []string        `json:"roots"`
	EntryCount  int             `json:"entry_count"`
	Truncated   bool            `json:"truncated"`
	Entries     []manifestEntry `json:"entries"`
}

func (c *ReplicaParityCollector) Run(stop <-chan struct{}) {
	switch c.nasID {
	case c.cfg.SourceNasID:
		c.loop(stop, c.cfg.ScanEvery, c.runSource)
	case c.cfg.ReplicaNasID:
		c.loop(stop, c.cfg.PollEvery, c.runReplica)
	default:
		log.Printf("[replica-parity] NAS %s is neither source nor replica; idle", c.nasID)
	}
}

func (c *ReplicaParityCollector) loop(stop <-chan struct{}, every time.Duration, fn func()) {
	select {
	case <-stop:
		return
	case <-time.After(c.cfg.StartDelay):
	}
	fn()
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			fn()
		}
	}
}

// ── source side ─────────────────────────────────────────────────────────────

func (c *ReplicaParityCollector) runSource() {
	start := time.Now()
	entries, truncated, err := ScanRecent(c.cfg.Roots, start.Add(-c.cfg.Window), c.cfg.MaxEntries)
	if err != nil {
		log.Printf("[replica-parity] scan failed: %v", err)
		return
	}
	m := replicaManifest{
		SourceNasID: c.nasID,
		ScanID:      start.UTC().Format("20060102T150405Z"),
		ScannedAt:   start.UTC(),
		WindowHours: int(c.cfg.Window / time.Hour),
		Roots:       c.cfg.Roots,
		EntryCount:  len(entries),
		Truncated:   truncated,
		Entries:     entries,
	}
	body, _ := json.Marshal(m)
	req, _ := http.NewRequest("POST", c.baseURL+"/rest/v1/replica_manifests?on_conflict=source_nas_id", bytes.NewReader(body))
	c.headers(req)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Prefer", "resolution=merge-duplicates,return=minimal")
	resp, err := c.http.Do(req)
	if err != nil {
		log.Printf("[replica-parity] publish failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		log.Printf("[replica-parity] publish HTTP %d: %s", resp.StatusCode, b)
		return
	}
	log.Printf("[replica-parity] published scan %s: %d entries (truncated=%v) in %s",
		m.ScanID, len(entries), truncated, time.Since(start).Round(time.Second))
}

// ScanRecent walks roots and returns every non-excluded entry whose ctime is
// after since, as paths relative to the roots' common parent (/host/shares).
func ScanRecent(roots []string, since time.Time, max int) ([]manifestEntry, bool, error) {
	var out []manifestEntry
	truncated := false
	cut := since.Unix()
	for _, root := range roots {
		parent := filepath.Dir(root)
		if _, err := os.Stat(root); err != nil {
			log.Printf("[replica-parity] root %s unavailable: %v", root, err)
			continue
		}
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil // unreadable subtree: skip, keep walking
			}
			name := d.Name()
			if p != root && ExcludedName(name) {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			st, ok := info.Sys().(*syscall.Stat_t)
			if !ok || st.Ctim.Sec < cut || p == root {
				return nil
			}
			if len(out) >= max {
				truncated = true
				return fs.SkipAll
			}
			rel, _ := filepath.Rel(parent, p)
			out = append(out, manifestEntry{Path: rel, Ctime: st.Ctim.Sec})
			return nil
		})
		if truncated {
			break
		}
	}
	return out, truncated, nil
}

var excludedPatterns = []*regexp.Regexp{
	regexp.MustCompile(`^@eaDir$`),
	regexp.MustCompile(`^#recycle$`),
	regexp.MustCompile(`^#snapshot$`),
	regexp.MustCompile(`^@tmp$`),
	regexp.MustCompile(`^\.SynologyWorkingDirectory$`),
	regexp.MustCompile(`^\._`),
	regexp.MustCompile(`^\.DS_Store$`),
	regexp.MustCompile(`(?i)^thumbs\.db$`),
	regexp.MustCompile(`(?i)^desktop\.ini$`),
	regexp.MustCompile(`(?i)\.tmp$`),
	regexp.MustCompile(`(?i)\.tmp\$\$$`),
	regexp.MustCompile(`(?i)\.lnk$`),
	regexp.MustCompile(`^~\$`),
	regexp.MustCompile(`^\.~lock\.`),
	regexp.MustCompile(`(?i)~RF[0-9a-f]+\.TMP$`),
	regexp.MustCompile(`(?i)\.part$`),
	regexp.MustCompile(`(?i)\.crdownload$`),
	regexp.MustCompile(`^\.seafile-sync-canary\.json$`),
}

// ExcludedName reports whether ShareSync/Drive never replicates this name
// (temp/lock files, shortcuts, Synology metadata), so its absence is expected.
func ExcludedName(name string) bool {
	for _, re := range excludedPatterns {
		if re.MatchString(name) {
			return true
		}
	}
	return false
}

// ── replica side ────────────────────────────────────────────────────────────

func (c *ReplicaParityCollector) runReplica() {
	m, err := c.fetchManifest()
	if err != nil {
		log.Printf("[replica-parity] fetch manifest: %v", err)
		return
	}
	if m == nil {
		return
	}
	done, _ := c.sender.LoadCheckpoint("replica_parity_scan_id")
	if done == m.ScanID {
		return
	}
	// Only judge items older than the grace period at check time, so items
	// still in flight are not reported. Re-check the same scan on every poll
	// until every entry has aged past the grace period, then mark it done.
	cut := time.Now().Add(-c.cfg.Grace)
	missing := FindMissing(m.Entries, filepath.Dir(firstOr(m.Roots, "/host/shares/x")), cut)
	sig := fmt.Sprintf("%s:%d:%s", m.ScanID, len(missing), strings.Join(firstN(missing, 50), "|"))
	if prev, _ := c.sender.LoadCheckpoint("replica_parity_alert_sig"); prev != sig {
		c.report(m, missing)
		_ = c.sender.SaveCheckpoint("replica_parity_alert_sig", sig)
	}
	if allOlder(m.Entries, cut) {
		_ = c.sender.SaveCheckpoint("replica_parity_scan_id", m.ScanID)
	}
}

func firstN(s []string, n int) []string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

func allOlder(entries []manifestEntry, cut time.Time) bool {
	c := cut.Unix()
	for _, e := range entries {
		if e.Ctime > c {
			return false
		}
	}
	return true
}

func firstOr(s []string, d string) string {
	if len(s) > 0 {
		return s[0]
	}
	return d
}

// FindMissing returns the entries (older than olderThan) absent under base,
// collapsed so that a missing directory hides its own missing descendants.
func FindMissing(entries []manifestEntry, base string, olderThan time.Time) []string {
	cut := olderThan.Unix()
	var miss []string
	for _, e := range entries {
		if e.Ctime > cut {
			continue
		}
		if hasExcludedSegment(e.Path) {
			continue
		}
		if _, err := os.Lstat(filepath.Join(base, e.Path)); err != nil && os.IsNotExist(err) {
			miss = append(miss, e.Path)
		}
	}
	sort.Strings(miss)
	return collapse(miss)
}

func hasExcludedSegment(p string) bool {
	for _, seg := range strings.Split(p, string(filepath.Separator)) {
		if ExcludedName(seg) {
			return true
		}
	}
	return false
}

// collapse keeps the top-most missing paths; input must be sorted.
func collapse(sorted []string) []string {
	var out []string
	for _, p := range sorted {
		if n := len(out); n > 0 && strings.HasPrefix(p, out[n-1]+string(filepath.Separator)) {
			continue
		}
		out = append(out, p)
	}
	return out
}

func (c *ReplicaParityCollector) report(m *replicaManifest, missing []string) {
	log.Printf("[replica-parity] scan %s: %d entries checked, %d missing roots", m.ScanID, len(m.Entries), len(missing))
	if len(missing) == 0 {
		return
	}
	show := missing
	if len(show) > 25 {
		show = show[:25]
	}
	msg := fmt.Sprintf("%d item(s) that exist on edgesynology1 (changed in the last %dh, older than %s) are missing on this replica. ShareSync did not deliver them; the usual cause is that edge1's Drive server never registered the item. Missing (top-level, first %d):\n- %s",
		len(missing), m.WindowHours, c.cfg.Grace, len(show), strings.Join(show, "\n- "))
	c.sender.QueueAlert(sender.AlertPayload{
		NasID:    c.nasID,
		Severity: "critical",
		Source:   "replica_parity",
		Title:    fmt.Sprintf("ShareSync replica missing %d item(s) from edgesynology1", len(missing)),
		Message:  msg,
	})
	full := missing
	if len(full) > 2000 {
		full = full[:2000]
	}
	c.sender.QueueLog(sender.LogPayload{
		NasID:    c.nasID,
		Source:   "replica_parity",
		Severity: "error",
		Message:  fmt.Sprintf("replica parity scan %s: %d missing", m.ScanID, len(missing)),
		Metadata: map[string]interface{}{"scan_id": m.ScanID, "missing": full, "missing_count": len(missing), "entries_checked": len(m.Entries), "truncated": m.Truncated},
		LoggedAt: time.Now().UTC(),
	})
}

func (c *ReplicaParityCollector) fetchManifest() (*replicaManifest, error) {
	q := url.Values{}
	q.Set("source_nas_id", "eq."+c.cfg.SourceNasID)
	q.Set("select", "*")
	req, _ := http.NewRequest("GET", c.baseURL+"/rest/v1/replica_manifests?"+q.Encode(), nil)
	c.headers(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 500))
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, b)
	}
	var rows []replicaManifest
	if err := json.NewDecoder(resp.Body).Decode(&rows); err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	return &rows[0], nil
}

func (c *ReplicaParityCollector) headers(req *http.Request) {
	req.Header.Set("apikey", c.serviceKey)
	req.Header.Set("Authorization", "Bearer "+c.serviceKey)
}

// ── small env helpers (local to this collector) ─────────────────────────────

func envOr(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func envDur(k string, d time.Duration) time.Duration {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		if x, err := time.ParseDuration(v); err == nil && x > 0 {
			return x
		}
	}
	return d
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
