package activity

import (
	"context"
	"fmt"
	"log"
	"time"
)

// DSM's SMB transfer log is capped at a fixed number of rows (hard-coded in
// synologrotated) and about 60% of those rows are reads, so it only covers
// about a week. The archive keeps just the save-like rows "saved by" needs,
// in a small table with no secondary indexes, for KeepDays.
const (
	ArchiveDir      = "/volume1/docker/synology-monitor-agent/file-activity"
	ArchiveDB       = ArchiveDir + "/smb-saves.sqlite"
	KeepDays        = 400
	ArchiveInterval = 10 * time.Minute
)

// ArchiveSQL copies new save rows from the live SMB log (opened read-only)
// and drops rows older than KeepDays. Built from integers and constants only.
func ArchiveSQL(now int64) string {
	return fmt.Sprintf(`PRAGMA busy_timeout=15000;
ATTACH 'file:%s?mode=ro' AS src;
CREATE TABLE IF NOT EXISTS smb_saves(
  time INTEGER NOT NULL, username TEXT NOT NULL, cmd TEXT NOT NULL,
  filesize INTEGER NOT NULL, filename TEXT NOT NULL,
  PRIMARY KEY(time, filename, username, cmd)) WITHOUT ROWID;
INSERT OR IGNORE INTO smb_saves
  SELECT time, username, cmd, coalesce(filesize,0), coalesce(filename,'') FROM src.logs
  WHERE time >= (SELECT coalesce(max(time),0) - 3600 FROM main.smb_saves)
    AND time IS NOT NULL AND cmd IN (`+SaveCmds+`) AND isdir = 0
    AND coalesce(username,'') <> '';
DELETE FROM smb_saves WHERE time < %d;`, SMBDB, now-KeepDays*86400)
}

// ArchiveQuery reads the archive in the same shape as SMBQuery.
func ArchiveQuery(r Request) string {
	q := fmt.Sprintf("select 'smb' as source, time, username, cmd as action, filesize as size, filename as path "+
		"from smb_saves where time between %d and %d", r.Since, r.Until)
	if r.Size > 0 {
		q += fmt.Sprintf(" and filesize = %d", r.Size)
	}
	return q + fmt.Sprintf(" order by time limit %d", MaxRows)
}

// ArchiveOnce runs one copy pass on the host.
func ArchiveOnce(ctx context.Context, now time.Time, run Runner) error {
	if run == nil {
		run = hostRunner
	}
	if _, err := run(ctx, "nsenter", "-t", "1", "-m", "--", "mkdir", "-p", ArchiveDir); err != nil {
		return fmt.Errorf("mkdir archive dir: %w", err)
	}
	if _, err := run(ctx, "nsenter", "-t", "1", "-m", "--", "sqlite3", "-bail", ArchiveDB, ArchiveSQL(now.Unix())); err != nil {
		return fmt.Errorf("archive pass: %w", err)
	}
	return nil
}

// RunArchiver copies save rows every ArchiveInterval until ctx ends.
// A NAS without an SMB log just logs the error and keeps trying.
func RunArchiver(ctx context.Context) {
	tick := time.NewTicker(ArchiveInterval)
	defer tick.Stop()
	for {
		c, cancel := context.WithTimeout(ctx, 5*time.Minute)
		if err := ArchiveOnce(c, time.Now(), nil); err != nil {
			log.Printf("file-activity archive: %v", err)
		}
		cancel()
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}
