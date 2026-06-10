package jobs

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DirEntry is one child directory in a share-relative folder browser response.
type DirEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// DirList is the bounded, read-only directory listing returned to the web UI.
type DirList struct {
	Share string     `json:"share"`
	Path  string     `json:"path"`
	Dirs  []DirEntry `json:"dirs"`
}

// ListShareDirs lists immediate child directories under share/path. It is used
// by the archive-move UI for scope picking, so it intentionally exposes only
// directories and skips Synology/archive internals.
func ListShareDirs(share, rel string) (*DirList, error) {
	if !IsAllowedShare(share) {
		return nil, fmt.Errorf("share %q is not in the allowlist", share)
	}
	cleanRel, err := CleanShareRelPath(rel)
	if err != nil {
		return nil, err
	}

	shareRoot := filepath.Join("/volume1", share)
	return listShareDirsInRoot(share, cleanRel, shareRoot)
}

func listShareDirsInRoot(share, cleanRel, shareRoot string) (*DirList, error) {
	dir := filepath.Join(shareRoot, filepath.FromSlash(cleanRel))
	if cleanRel != "" && !strings.HasPrefix(dir, shareRoot+string(os.PathSeparator)) {
		return nil, fmt.Errorf("path %q escapes share %q", cleanRel, share)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	dirs := make([]DirEntry, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || ExcludedDirNames[entry.Name()] {
			continue
		}
		childPath := entry.Name()
		if cleanRel != "" {
			childPath = cleanRel + "/" + entry.Name()
		}
		dirs = append(dirs, DirEntry{Name: entry.Name(), Path: childPath})
	}
	sort.Slice(dirs, func(i, j int) bool {
		return strings.ToLower(dirs[i].Name) < strings.ToLower(dirs[j].Name)
	})
	return &DirList{Share: share, Path: cleanRel, Dirs: dirs}, nil
}

// CleanShareRelPath normalizes a user-supplied share-relative directory path.
func CleanShareRelPath(rel string) (string, error) {
	rel = strings.TrimSpace(strings.ReplaceAll(rel, "\\", "/"))
	rel = strings.Trim(rel, "/")
	if rel == "" || rel == "." {
		return "", nil
	}
	clean := filepath.Clean(filepath.FromSlash(rel))
	if clean == "." {
		return "", nil
	}
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path %q escapes the share", rel)
	}
	return filepath.ToSlash(clean), nil
}
