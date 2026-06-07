package jobs

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// MoveStatus is the lifecycle state of an archive-move job. The flow is strictly
// staged and operator-advanced across every destructive boundary:
// planning → planned → (preflight → snapshotting → executing → verifying →
// complete), with cancelled / failed / preflight_failed / rolled_back /
// interrupted as terminal or recoverable side states.
type MoveStatus string

const (
	MovePlanning        MoveStatus = "planning"
	MovePlanned         MoveStatus = "planned"
	MovePreflight       MoveStatus = "preflight"
	MovePreflightFailed MoveStatus = "preflight_failed"
	MoveSnapshotting    MoveStatus = "snapshotting"
	MoveExecuting       MoveStatus = "executing"
	MoveVerifying       MoveStatus = "verifying"
	MoveComplete        MoveStatus = "complete"
	MoveFailed          MoveStatus = "failed"
	MoveCancelled       MoveStatus = "cancelled"
	MoveRolledBack      MoveStatus = "rolled_back"
	MoveInterrupted     MoveStatus = "interrupted"
)

// MoveJobType identifies archive-move jobs.
const MoveJobType = "archive_move"

// Move modes.
const (
	ModeMove           = "move"             // relocate candidate files into <share>/Archive
	ModeCleanEmptyDirs = "clean_empty_dirs" // remove empty dirs only, move zero files
)

// ArchiveDirName is the per-share archive root (also a Phase 1 excluded dir, so
// relocated data stays out of future inventory scans and re-plans).
const ArchiveDirName = "Archive"

// MoveJob is the persisted metadata for one archive-move run. JSON tags are part
// of the contract with the web app and MCP server.
type MoveJob struct {
	ID     string     `json:"id"`   // mv_<utc14>_<nas>_<rand4>
	Type   string     `json:"type"` // always "archive_move"
	NAS    string     `json:"nas"`
	Status MoveStatus `json:"status"`

	Share        string   `json:"share"`
	Roots        []string `json:"roots"`         // sub-folder roots within the share ("" / empty = whole share)
	IncludeGlobs []string `json:"include_globs"` // rel-path globs to include
	ExcludeGlobs []string `json:"exclude_globs"` // rel-path globs to exclude
	Mode         string   `json:"mode"`          // move | clean_empty_dirs

	// Applied classification rules (recorded for audit; same semantics as Phase 1).
	CutoffYears      []int  `json:"cutoff_years"`
	ProtectNewerThan string `json:"protect_newer_than"`
	Overlay          bool   `json:"overlay"`

	// Directory handling.
	PruneEmptiedSourceDirs     bool `json:"prune_emptied_source_dirs"`     // default true
	RemovePreexistingEmptyDirs bool `json:"remove_preexisting_empty_dirs"` // default false

	// Btrfs snapshot safety net.
	SnapshotID   string `json:"snapshot_id"`
	SnapshotPath string `json:"snapshot_path"`

	ManifestPath string `json:"manifest_path"`

	// Counters (updated through the stages).
	Planned    int64 `json:"planned"`
	Moved      int64 `json:"moved"`
	Verified   int64 `json:"verified"`
	Skipped    int64 `json:"skipped"`
	Failed     int64 `json:"failed"`
	DirsPruned int64 `json:"dirs_pruned"`
	BytesMoved int64 `json:"bytes_moved"`

	StartedAt   string `json:"started_at"`
	FinishedAt  string `json:"finished_at"`
	CurrentPath string `json:"current_path"`

	Error             string `json:"error"`
	PreflightNote     string `json:"preflight_note"`
	SyncExclusionNote string `json:"sync_exclusion_note"`
}

// MovePlanRequest is the JSON body for POST /jobs/archive-move/plan.
type MovePlanRequest struct {
	Share                      string   `json:"share"`                          // required, allowlisted
	Roots                      []string `json:"roots"`                          // optional sub-folder scope
	IncludeGlobs               []string `json:"include_globs"`                  // optional
	ExcludeGlobs               []string `json:"exclude_globs"`                  // optional
	Mode                       string   `json:"mode"`                           // optional; default "move"
	CutoffYears                []int    `json:"cutoff_years"`                   // optional
	ProtectNewerThan           string   `json:"protect_newer_than"`             // optional RFC3339
	Overlay                    *bool    `json:"overlay"`                        // optional; nil → true
	PruneEmptiedSourceDirs     *bool    `json:"prune_emptied_source_dirs"`      // optional; nil → true
	RemovePreexistingEmptyDirs *bool    `json:"remove_preexisting_empty_dirs"`  // optional; nil → false
}

// Normalize fills defaults and trims simple inputs.
func (r *MovePlanRequest) Normalize() {
	r.Share = strings.TrimSpace(r.Share)
	r.ProtectNewerThan = strings.TrimSpace(r.ProtectNewerThan)
	if r.Mode == "" {
		r.Mode = ModeMove
	}
	cleaned := r.Roots[:0]
	for _, root := range r.Roots {
		root = strings.Trim(strings.TrimSpace(root), "/")
		if root != "" {
			cleaned = append(cleaned, root)
		}
	}
	r.Roots = cleaned
}

func (r MovePlanRequest) overlayEffective() bool   { return r.Overlay == nil || *r.Overlay }
func (r MovePlanRequest) pruneEffective() bool      { return r.PruneEmptiedSourceDirs == nil || *r.PruneEmptiedSourceDirs }
func (r MovePlanRequest) removePreexisting() bool   { return r.RemovePreexistingEmptyDirs != nil && *r.RemovePreexistingEmptyDirs }

// Move operation identifiers for approval-token binding.
const (
	OpMovePlan     Op = "move.plan"
	OpMoveExecute  Op = "move.execute"
	OpMoveCancel   Op = "move.cancel"
	OpMoveRollback Op = "move.rollback"
)

// MoveCanonicalOpString builds the deterministic string a move approval token
// signs. It MUST byte-match nas-mcp's job-client.ts and web's nas-api-client.ts.
//
// plan binds NAS + share + scope + mode + every applied rule (so a tampered
// request that weakened the rules fails verification). execute/cancel/rollback
// bind NAS + the planned job id (the manifest), so they can only act on the
// exact plan the operator reviewed.
func MoveCanonicalOpString(op Op, nasName, jobID string, req *MovePlanRequest) string {
	switch op {
	case OpMovePlan:
		return fmt.Sprintf(
			"move.plan|nas=%s|share=%s|mode=%s|roots=%s|include=%s|exclude=%s|cutoff=%s|protect=%s|prune=%s|rmpre=%s",
			nasName, req.Share, req.Mode,
			canonSorted(req.Roots), canonSorted(req.IncludeGlobs), canonSorted(req.ExcludeGlobs),
			canonYears(req.CutoffYears), req.ProtectNewerThan,
			canonBool(req.pruneEffective()), canonBool(req.removePreexisting()),
		)
	case OpMoveExecute, OpMoveCancel, OpMoveRollback:
		return fmt.Sprintf("%s|nas=%s|job_id=%s", op, nasName, jobID)
	default:
		return string(op)
	}
}

func canonSorted(items []string) string {
	cp := append([]string(nil), items...)
	sort.Strings(cp)
	return strings.Join(cp, ",")
}

// NewMoveJobID returns a sortable id: mv_<utc14>_<nas>_<rand4>.
func NewMoveJobID(nas string, now time.Time) string {
	return fmt.Sprintf("mv_%s_%s_%s", now.UTC().Format("20060102150405"), nas, randHex4())
}

// MoveStatusTerminal reports whether a move job is in a terminal state.
func MoveStatusTerminal(s MoveStatus) bool {
	switch s {
	case MoveComplete, MoveFailed, MoveCancelled, MoveRolledBack, MovePreflightFailed:
		return true
	}
	return false
}

// reasonForCutoff renders the planned_reason for a candidate at a cutoff year.
func reasonForCutoff(year int) string { return "older_than_" + strconv.Itoa(year) }
