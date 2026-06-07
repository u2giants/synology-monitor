package jobs

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// fsOps abstracts the Btrfs subvolume + snapshot operations so the move state
// machine is unit-testable on a plain temp filesystem. Production uses the
// btrfs(8) CLI (present in the runtime image, with CAP_SYS_ADMIN); tests inject a
// stub. The rename/stat operations themselves are real syscalls and work on any
// filesystem, so identity-preservation is exercised for real in unit tests.
type fsOps interface {
	// subvolID returns the Btrfs subvolume id containing path. Best-effort: a
	// non-Btrfs path may return (0, error), which callers treat as "unknown".
	subvolID(path string) (uint64, error)
	// createROSnapshot takes a read-only snapshot of subvol at dest and returns
	// the snapshot's subvolume id.
	createROSnapshot(subvol, dest string) (uint64, error)
	// deleteSnapshot removes a snapshot subvolume.
	deleteSnapshot(path string) error
	// snapshotSupported reports whether a read-only snapshot of subvol can be
	// created (preflight gate) without actually creating one.
	snapshotSupported(subvol string) error
}

// btrfsCLI is the production fsOps backed by the btrfs(8) binary.
type btrfsCLI struct{}

func (btrfsCLI) subvolID(path string) (uint64, error) {
	out, err := exec.Command("btrfs", "subvolume", "show", path).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("btrfs subvolume show %s: %v: %s", path, err, strings.TrimSpace(string(out)))
	}
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Subvolume ID:") {
			idStr := strings.TrimSpace(strings.TrimPrefix(line, "Subvolume ID:"))
			return strconv.ParseUint(idStr, 10, 64)
		}
	}
	return 0, fmt.Errorf("btrfs subvolume show %s: no Subvolume ID in output", path)
}

func (btrfsCLI) createROSnapshot(subvol, dest string) (uint64, error) {
	out, err := exec.Command("btrfs", "subvolume", "snapshot", "-r", subvol, dest).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("btrfs subvolume snapshot -r %s %s: %v: %s", subvol, dest, err, strings.TrimSpace(string(out)))
	}
	id, _ := btrfsCLI{}.subvolID(dest)
	return id, nil
}

func (btrfsCLI) deleteSnapshot(path string) error {
	out, err := exec.Command("btrfs", "subvolume", "delete", path).CombinedOutput()
	if err != nil {
		return fmt.Errorf("btrfs subvolume delete %s: %v: %s", path, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (btrfsCLI) snapshotSupported(subvol string) error {
	// `btrfs subvolume show` succeeding on the subvol root is a strong signal the
	// path is a Btrfs subvolume that can be snapshotted.
	if _, err := (btrfsCLI{}).subvolID(subvol); err != nil {
		return err
	}
	return nil
}

// ── Stat helpers (pure syscalls; filesystem-agnostic) ──────────────────────────

// fileIdentity captures the identity fields the move verifier compares.
type fileIdentity struct {
	dev   uint64
	inode uint64
	size  int64
	mtime time.Time
	ctime time.Time
	btime time.Time
	hasBt bool
}

// identityOf reads a path's identity without following symlinks.
func identityOf(path string) (fileIdentity, error) {
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		return fileIdentity{}, err
	}
	id := fileIdentity{
		dev:   uint64(st.Dev),
		inode: st.Ino,
		size:  st.Size,
		mtime: time.Unix(st.Mtim.Sec, st.Mtim.Nsec),
		ctime: time.Unix(st.Ctim.Sec, st.Ctim.Nsec),
	}
	if bt, ok := statxBtimeOf(path); ok {
		id.btime, id.hasBt = bt, true
	}
	return id, nil
}

// sameDevice reports whether two existing paths sit on the same st_dev. On Btrfs
// each subvolume has a distinct st_dev, so this is a cheap same-subvolume proxy
// that needs no btrfs CLI and works in unit tests.
func sameDevice(a, b string) (bool, error) {
	var sa, sb syscall.Stat_t
	if err := syscall.Stat(a, &sa); err != nil {
		return false, err
	}
	if err := syscall.Stat(b, &sb); err != nil {
		return false, err
	}
	return sa.Dev == sb.Dev, nil
}

// ownerMode returns the uid, gid, and permission bits of a path (for recreating
// pruned directories on rollback and matching source ownership on dest dirs).
func ownerMode(path string) (uid, gid uint32, mode os.FileMode, err error) {
	var st syscall.Stat_t
	if err := syscall.Lstat(path, &st); err != nil {
		return 0, 0, 0, err
	}
	return st.Uid, st.Gid, os.FileMode(st.Mode).Perm(), nil
}
