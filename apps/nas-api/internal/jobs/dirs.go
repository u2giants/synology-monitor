package jobs

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"time"
)

// dirArtifacts are Synology/OS metadata names that do NOT keep a directory
// "alive" for prune purposes. When a directory is pruned, these are removed with
// it. Anything else (a real file, a symlink, a non-empty subdir, an unknown
// hidden file) makes the directory non-empty and untouched.
var dirArtifacts = map[string]bool{
	"@eaDir":                    true,
	".DS_Store":                 true,
	"Thumbs.db":                 true,
	".SynologyWorkingDirectory": true,
}

// isPrunableEmpty reports whether dir, ignoring Synology artifacts, contains no
// regular files (or symlinks) and no non-empty subdirectories. Empty subdirs do
// not keep a parent alive; a real file or a non-empty subdir does.
func isPrunableEmpty(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	for _, e := range entries {
		name := e.Name()
		if dirArtifacts[name] {
			continue
		}
		if e.IsDir() {
			ok, err := isPrunableEmpty(filepath.Join(dir, name))
			if err != nil {
				return false, err
			}
			if !ok {
				return false, nil // a non-empty subdir keeps this dir alive
			}
			continue
		}
		return false, nil // a real file / symlink keeps this dir alive
	}
	return true, nil
}

// listPrunableEmptyDirs returns every prunable-empty directory under root
// (excluding root's own Archive subtree and default-excluded dirs), sorted
// deepest-first so pruning bottom-up is safe.
func listPrunableEmptyDirs(root string) ([]string, error) {
	var dirs []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if path != root && ExcludedDirNames[d.Name()] {
			return filepath.SkipDir
		}
		ok, perr := isPrunableEmpty(path)
		if perr == nil && ok {
			dirs = append(dirs, path)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(dirs, func(i, j int) bool { return len(dirs[i]) > len(dirs[j]) })
	return dirs, nil
}

// dirRowFor captures a directory's metadata into a manifest dir row before it is
// removed, so rollback can recreate it exactly.
func dirRowFor(path, reason string) (ManifestEntry, error) {
	var info os.FileInfo
	info, err := os.Lstat(path)
	if err != nil {
		return ManifestEntry{}, err
	}
	uid, gid, mode, err := ownerMode(path)
	if err != nil {
		return ManifestEntry{}, err
	}
	return ManifestEntry{
		Kind:          KindDir,
		Path:          path,
		Mode:          "0" + strconv.FormatUint(uint64(mode), 8),
		Owner:         strconv.FormatUint(uint64(uid), 10),
		Group:         strconv.FormatUint(uint64(gid), 10),
		Mtime:         info.ModTime().UTC().Format(time.RFC3339Nano),
		RemovedReason: reason,
		Status:        MStatusPlanned,
	}, nil
}

// pruneEmptyDir re-checks that dir is prunable-empty (guards against a race) and
// removes it together with any Synology artifacts it holds.
func pruneEmptyDir(dir string) error {
	ok, err := isPrunableEmpty(dir)
	if err != nil {
		return err
	}
	if !ok {
		return errNotEmpty
	}
	return os.RemoveAll(dir) // only artifacts + empty subdirs remain — safe
}

// recreateDir restores a removed directory from a manifest dir row (mode, owner,
// mtime). Artifacts are not restored; they regenerate on demand.
func recreateDir(e ManifestEntry) error {
	if err := os.MkdirAll(e.Path, 0o755); err != nil {
		return err
	}
	if mode, err := strconv.ParseUint(e.Mode, 8, 32); err == nil {
		_ = os.Chmod(e.Path, os.FileMode(mode))
	}
	uid, uerr := strconv.Atoi(e.Owner)
	gid, gerr := strconv.Atoi(e.Group)
	if uerr == nil && gerr == nil {
		_ = os.Chown(e.Path, uid, gid)
	}
	if t, err := time.Parse(time.RFC3339Nano, e.Mtime); err == nil {
		_ = os.Chtimes(e.Path, t, t)
	}
	return nil
}

// ancestorsWithin returns each ancestor directory of file that lies within root
// (inclusive of file's own directory, exclusive of root's parent). Used to mark
// which source directories a move "touched" so verify can label them
// emptied_by_move vs preexisting_empty.
func ancestorsWithin(file, root string) []string {
	var out []string
	dir := filepath.Dir(file)
	for {
		if len(dir) < len(root) || !pathWithin(dir, root) {
			break
		}
		out = append(out, dir)
		if dir == root {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return out
}

func pathWithin(path, root string) bool {
	if path == root {
		return true
	}
	rel, err := filepath.Rel(root, path)
	if err != nil {
		return false
	}
	return rel != ".." && !filepath.IsAbs(rel) && !startsWithDotDot(rel)
}

func startsWithDotDot(rel string) bool {
	return len(rel) >= 2 && rel[0] == '.' && rel[1] == '.'
}
