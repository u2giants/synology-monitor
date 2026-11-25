// Package activity answers "who saved this file" from the NAS's own logs:
// the SMB transfer log (Log Center) and the Synology Drive activity log.
//
// Read-only by construction: fixed SQL with integer parameters only, run with
// the host's sqlite3 in -readonly mode inside the host mount namespace (both
// databases are WAL files that cannot be opened through /proc/1/root).
// Used by PopDAM's "Older copies" (u2giants/popdam3#1342).
package activity

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	SMBDB   = "/volume1/@database/synolog/.SMBXFERDB"
	DriveDB = "/volume1/@synologydrive/@sync/log-db.sqlite"

	MaxWindow = 6 * time.Hour
	MaxRows   = 2000
)

// Request: a time window (Unix seconds) and optionally an exact file size and
// a path fragment. The fragment is never put into SQL; it filters rows in Go.
type Request struct {
	Since    int64  `json:"since"`
	Until    int64  `json:"until"`
	Size     int64  `json:"size,omitempty"`
	Contains string `json:"contains,omitempty"`
}

// Event is one save-like action by a named person.
type Event struct {
	Source   string `json:"source"` // "smb" or "drive"
	Time     int64  `json:"time"`
	Username string `json:"username"`
	Action   string `json:"action"`
	Size     int64  `json:"size,omitempty"`
	Path     string `json:"path"`
	Share    string `json:"share,omitempty"`
	Client   int64  `json:"client_type,omitempty"`
}

type Response struct {
	Events []Event           `json:"events"`
	Errors map[string]string `json:"errors,omitempty"`
}

// Runner runs a command and returns stdout; injectable for tests.
type Runner func(ctx context.Context, name string, args ...string) ([]byte, error)

func hostRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).Output()
}

func Validate(r Request) error {
	if r.Since <= 0 || r.Until <= 0 || r.Until < r.Since {
		return fmt.Errorf("since/until must be positive Unix seconds with until >= since")
	}
	if time.Duration(r.Until-r.Since)*time.Second > MaxWindow {
		return fmt.Errorf("window larger than %s", MaxWindow)
	}
	if r.Size < 0 {
		return fmt.Errorf("size must be >= 0")
	}
	if len(r.Contains) > 512 {
		return fmt.Errorf("contains too long")
	}
	return nil
}

// SMBQuery and DriveQuery are built from integers only.
func SMBQuery(r Request) string {
	q := fmt.Sprintf("select 'smb' as source, time, coalesce(username,'') as username, cmd as action, coalesce(filesize,0) as size, coalesce(filename,'') as path "+
		"from logs where time between %d and %d and cmd in ('write','rename','create') and isdir = 0 and coalesce(username,'') <> ''", r.Since, r.Until)
	if r.Size > 0 {
		q += fmt.Sprintf(" and filesize = %d", r.Size)
	}
	return q + fmt.Sprintf(" order by time limit %d", MaxRows)
}

func DriveQuery(r Request) string {
	return fmt.Sprintf("select 'drive' as source, time, username, cast(type as text) as action, coalesce(s1,'') as path, coalesce(share_name,'') as share, client_type "+
		"from log_table where time between %d and %d and coalesce(username,'') <> '' and client_type in (1, 256) order by time limit %d", r.Since, r.Until, MaxRows)
}

func Lookup(ctx context.Context, r Request, run Runner) Response {
	if run == nil {
		run = hostRunner
	}
	out := Response{Events: []Event{}}
	seen := map[string]bool{} // the live SMB log and its archive overlap
	for _, src := range []struct{ name, db, sql string }{
		{"smb", SMBDB, SMBQuery(r)},
		{"smb-archive", ArchiveDB, ArchiveQuery(r)},
		{"drive", DriveDB, DriveQuery(r)},
	} {
		raw, err := run(ctx, "nsenter", "-t", "1", "-m", "--", "sqlite3", "-readonly", "-json", src.db, src.sql)
		if err != nil {
			if out.Errors == nil {
				out.Errors = map[string]string{}
			}
			out.Errors[src.name] = err.Error()
			continue
		}
		var rows []Event
		if s := strings.TrimSpace(string(raw)); s != "" {
			if err := json.Unmarshal([]byte(s), &rows); err != nil {
				if out.Errors == nil {
					out.Errors = map[string]string{}
				}
				out.Errors[src.name] = "parse: " + err.Error()
				continue
			}
		}
		for _, e := range rows {
			k := fmt.Sprintf("%s|%d|%s|%s|%s", e.Source, e.Time, e.Username, e.Action, e.Path)
			if seen[k] {
				continue
			}
			seen[k] = true
			if r.Contains != "" && !strings.Contains(strings.ToLower(e.Path), strings.ToLower(r.Contains)) {
				continue
			}
			out.Events = append(out.Events, e)
		}
	}
	return out
}
