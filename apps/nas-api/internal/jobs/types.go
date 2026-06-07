// Package jobs implements the NAS-side file-inventory job system: a single-job-
// per-NAS manager that walks mounted shared folders read-only, aggregates file
// counts/bytes by modified year, applies date-based protection and an optional
// Synology Drive / ShareSync activity overlay, and persists compact CSV results
// to a durable host-mounted job directory.
//
// The package is stdlib-only. The one exception is overlay.go, which shells out
// to the `sqlite3` binary already present in the runtime image.
package jobs

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// Status is the lifecycle state of an inventory job.
type Status string

const (
	StatusQueued      Status = "queued"
	StatusScheduled   Status = "scheduled"
	StatusRunning     Status = "running"
	StatusComplete    Status = "complete"
	StatusFailed      Status = "failed"
	StatusCancelled   Status = "cancelled"
	StatusInterrupted Status = "interrupted"
)

// JobType is always "file_inventory" in Phase 1.
const JobType = "file_inventory"

// ErrBusy is returned when a start/schedule is attempted while another inventory
// job is already queued or running on this NAS. Mapped to HTTP 409.
var ErrBusy = errors.New("an inventory job is already queued or running on this NAS")

// AllowedShares is the canonical allowlist of top-level shared folders the
// scanner may walk. It MUST mirror the read-only share mounts in
// deploy/synology/docker-compose.agent.yml and the ARCHIVE_SHARES constant in
// packages/shared/src/archive.ts (Go cannot import the TS list; keep both in
// sync — see Appendix C of docs/synology-archive-implementation.md).
var AllowedShares = []string{
	"files", "styleguides", "users", "homes", "Coldlion",
	"Photography", "freelancers", "mgmt", "mac", "oldStyleguides",
}

// ExcludedDirNames are directory names skipped wholesale while walking. These are
// Synology system/snapshot artifacts plus the archive root itself (so already-
// archived data is never re-inventoried).
var ExcludedDirNames = map[string]bool{
	"#snapshot":                true,
	"@eaDir":                   true,
	"@tmp":                     true,
	".SynologyWorkingDirectory": true,
	"Archive":                  true,
}

// IsAllowedShare reports whether name is in the allowlist.
func IsAllowedShare(name string) bool {
	for _, s := range AllowedShares {
		if s == name {
			return true
		}
	}
	return false
}

// Job is the persisted metadata for one inventory run. JSON tags are part of the
// contract with the web app and MCP server — do not rename without updating both.
type Job struct {
	ID           string   `json:"id"`             // inv_<utc14>_<nas>_<rand4>
	Type         string   `json:"type"`           // always "file_inventory"
	NAS          string   `json:"nas"`            // resolved NAS_API_NAME
	Status       Status   `json:"status"`
	TargetShares []string `json:"target_shares"`
	CutoffYears  []int    `json:"cutoff_years"`
	Overlay      bool     `json:"overlay"` // effective value (request nil → true)

	// Scanner tuning / protection (echoed back so the UI can confirm what ran).
	ProtectNewerThan string `json:"protect_newer_than"`     // RFC3339 UTC or ""
	MaxFilesPerSec   int    `json:"max_files_per_second"`   // 0 = unlimited
	UseIdleIO        bool   `json:"use_idle_io_priority"`
	SleepEveryFiles  int    `json:"sleep_every_files"`
	SleepMs          int    `json:"sleep_ms"`

	ScheduledFor string `json:"scheduled_for"` // RFC3339 UTC or ""
	StartedAt    string `json:"started_at"`    // RFC3339 or ""
	FinishedAt   string `json:"finished_at"`   // RFC3339 or ""

	CurrentShare  string `json:"current_share"`
	FilesScanned  int64  `json:"files_scanned"`
	BytesScanned  int64  `json:"bytes_scanned"`
	ElapsedSecond int64  `json:"elapsed_seconds"`
	ResultReady   bool   `json:"result_available"`
	Error         string `json:"error"`
	OverlayNote   string `json:"overlay_note"` // why the overlay was skipped, if any
}

// StartRequest is the JSON body for POST /jobs/inventory and …/schedule.
type StartRequest struct {
	Shares           []string `json:"shares"`               // required, non-empty, allowlisted
	CutoffYears      []int    `json:"cutoff_years"`         // optional
	Overlay          *bool    `json:"overlay"`              // optional; nil → default true
	ProtectNewerThan string   `json:"protect_newer_than"`   // optional RFC3339 UTC date
	MaxFilesPerSec   int      `json:"max_files_per_second"` // optional throttle; 0 = unlimited
	UseIdleIO        *bool    `json:"use_idle_io_priority"` // optional; nil → default true
	SleepEveryFiles  int      `json:"sleep_every_files"`    // optional; default 5000
	SleepMs          int      `json:"sleep_ms"`             // optional; default 25
	ScheduledFor     string   `json:"scheduled_for"`        // schedule only; RFC3339 UTC, future
}

// Default tuning values applied when a request omits a field.
const (
	DefaultSleepEveryFiles = 5000
	DefaultSleepMs         = 25
)

// OverlayEffective resolves the overlay flag with its default-on rule.
func (r StartRequest) OverlayEffective() bool { return r.Overlay == nil || *r.Overlay }

// UseIdleIOEffective resolves the idle-I/O flag with its default-on rule.
func (r StartRequest) UseIdleIOEffective() bool { return r.UseIdleIO == nil || *r.UseIdleIO }

// Normalize fills defaults for tuning fields and trims/validates simple inputs.
// It does not validate the share allowlist (the manager does that).
func (r *StartRequest) Normalize() {
	if r.SleepEveryFiles <= 0 {
		r.SleepEveryFiles = DefaultSleepEveryFiles
	}
	if r.SleepMs < 0 {
		r.SleepMs = DefaultSleepMs
	}
	if r.MaxFilesPerSec < 0 {
		r.MaxFilesPerSec = 0
	}
	r.ProtectNewerThan = strings.TrimSpace(r.ProtectNewerThan)
	r.ScheduledFor = strings.TrimSpace(r.ScheduledFor)
}

// Op identifies a state-changing inventory operation for approval-token binding.
type Op string

const (
	OpStart    Op = "inventory.start"
	OpSchedule Op = "inventory.schedule"
	OpCancel   Op = "inventory.cancel"
)

// CanonicalOpString builds the deterministic string an HMAC approval token signs.
// It MUST byte-match the implementations in nas-mcp (job-client.ts) and web
// (nas-api-client.ts) — see Appendix A of docs/synology-archive-implementation.md.
//
// The string binds every safety-relevant field (NAS, shares, cutoff, overlay,
// protect date, and — for schedule — the scheduled time). Tuning fields
// (max_files_per_second, sleep_*, use_idle_io_priority) are intentionally NOT
// bound: they cannot cause data loss, and binding them would only add brittleness.
//
// Rules: shares sorted ascending and comma-joined (no spaces); cutoff years sorted
// ascending and comma-joined; booleans lowercase; empty cutoff → "cutoff="; empty
// protect → "protect="; scheduled_for is the exact RFC3339 string sent.
//
// For OpCancel, req is ignored and jobID is bound instead.
func CanonicalOpString(op Op, nasName, jobID string, req *StartRequest) string {
	switch op {
	case OpCancel:
		return fmt.Sprintf("%s|nas=%s|job_id=%s", op, nasName, jobID)
	case OpStart:
		return fmt.Sprintf("%s|nas=%s|shares=%s|cutoff=%s|overlay=%s|protect=%s",
			op, nasName,
			canonShares(req.Shares),
			canonYears(req.CutoffYears),
			canonBool(req.OverlayEffective()),
			req.ProtectNewerThan,
		)
	case OpSchedule:
		return fmt.Sprintf("%s|nas=%s|shares=%s|cutoff=%s|overlay=%s|protect=%s|scheduled_for=%s",
			op, nasName,
			canonShares(req.Shares),
			canonYears(req.CutoffYears),
			canonBool(req.OverlayEffective()),
			req.ProtectNewerThan,
			req.ScheduledFor,
		)
	default:
		return string(op)
	}
}

func canonShares(shares []string) string {
	cp := append([]string(nil), shares...)
	sort.Strings(cp)
	return strings.Join(cp, ",")
}

func canonYears(years []int) string {
	cp := append([]int(nil), years...)
	sort.Ints(cp)
	parts := make([]string, len(cp))
	for i, y := range cp {
		parts[i] = strconv.Itoa(y)
	}
	return strings.Join(parts, ",")
}

func canonBool(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
