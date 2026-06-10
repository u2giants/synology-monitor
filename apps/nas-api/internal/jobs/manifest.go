package jobs

import (
	"bufio"
	"encoding/json"
	"os"
)

// Manifest entry kinds.
const (
	KindFile = "file"
	KindDir  = "dir"
)

// Per-file manifest statuses.
const (
	MStatusPlanned    = "planned"
	MStatusMoved      = "moved"
	MStatusVerified   = "verified"
	MStatusSkipped    = "skipped"
	MStatusFailed     = "failed"
	MStatusRolledBack = "rolled_back"
	MStatusRemoved    = "removed"   // dir rows
	MStatusRecreated  = "recreated" // dir rows
)

// Directory removal reasons.
const (
	ReasonEmptiedByMove    = "emptied_by_move"
	ReasonPreexistingEmpty = "preexisting_empty"
)

// ManifestEntry is one JSONL row — a file move or a directory removal. The Kind
// field discriminates; fields not relevant to the kind are omitted.
type ManifestEntry struct {
	Kind string `json:"kind"` // "file" | "dir"

	// File rows.
	RelPath       string `json:"rel_path,omitempty"`
	SourceAbs     string `json:"source_abs,omitempty"`
	DestAbs       string `json:"dest_abs,omitempty"`
	Size          int64  `json:"size,omitempty"`
	Inode         uint64 `json:"inode,omitempty"`
	DevID         uint64 `json:"dev_id,omitempty"`
	SubvolID      uint64 `json:"subvol_id,omitempty"`
	Mtime         string `json:"mtime,omitempty"` // RFC3339Nano — must be preserved
	Ctime         string `json:"ctime,omitempty"` // recorded; expected to change on rename
	Btime         string `json:"btime,omitempty"` // must be preserved (or "" if unavailable)
	PlannedReason string `json:"planned_reason,omitempty"`

	// Dir rows.
	Path          string `json:"path,omitempty"`
	Mode          string `json:"mode,omitempty"`  // octal permission bits
	Owner         string `json:"owner,omitempty"` // uid
	Group         string `json:"group,omitempty"` // gid
	RemovedReason string `json:"removed_reason,omitempty"`
	ArtifactFiles int64  `json:"artifact_files,omitempty"`
	ArtifactDirs  int64  `json:"artifact_dirs,omitempty"`

	// Shared.
	Status string `json:"status"`
	Detail string `json:"detail,omitempty"`
}

// appendManifest appends one entry as a JSONL line (used during Plan).
func appendManifest(path string, e ManifestEntry) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	data, err := json.Marshal(e)
	if err != nil {
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	return nil
}

// readManifest parses every entry. Used by Execute / Verify / Rollback, which
// load the whole manifest, mutate statuses in memory, then rewrite it.
func readManifest(path string) ([]ManifestEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var entries []ManifestEntry
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024) // tolerate long path lines
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var e ManifestEntry
		if err := json.Unmarshal(line, &e); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, sc.Err()
}

// writeManifest rewrites the whole manifest atomically (temp + rename).
func writeManifest(path string, entries []ManifestEntry) error {
	tmp := path + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	w := bufio.NewWriter(f)
	enc := json.NewEncoder(w)
	for i := range entries {
		if err := enc.Encode(&entries[i]); err != nil {
			f.Close()
			return err
		}
	}
	if err := w.Flush(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// readManifestPaged returns a bounded slice of raw JSONL lines plus the total
// count and the next cursor (-1 when exhausted). Used by the MCP/web manifest
// fetch so an oversized manifest never floods the model context.
func readManifestPaged(path string, cursor, limit int) (lines []string, total, next int, err error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, 0, -1, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	idx := 0
	for sc.Scan() {
		if sc.Text() == "" {
			continue
		}
		if idx >= cursor && len(lines) < limit {
			lines = append(lines, sc.Text())
		}
		idx++
	}
	if err := sc.Err(); err != nil {
		return nil, 0, -1, err
	}
	total = idx
	next = cursor + len(lines)
	if next >= total {
		next = -1
	}
	return lines, total, next, nil
}
