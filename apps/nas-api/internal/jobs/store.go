package jobs

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// Store persists inventory jobs to disk under a durable host-mounted directory.
// Each job lives in its own subdirectory holding status.json plus result CSVs.
//
// The base directory must survive a Watchtower container recreate, so it is the
// bind-mounted /app/data/jobs (see docker-compose.agent.yml). If the mount is
// missing, Ready() reports false and the HTTP layer returns 503.
type Store struct {
	base  string // e.g. /app/data/jobs
	ready bool
}

// resultKinds are the CSV result files a completed job may produce.
var resultKinds = map[string]bool{
	"yearly":  true,
	"cutoff":  true,
	"dirs":    true,
	"overlay": true,
}

// NewStore creates a store rooted at base/file-inventory and probes writability.
// A write probe (mkdir + temp file) determines Ready(); construction never fails
// so the server can still boot and report 503 from job handlers when the mount is
// absent.
func NewStore(base string) *Store {
	root := filepath.Join(base, "file-inventory")
	s := &Store{base: root}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return s
	}
	probe := filepath.Join(root, ".write-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o644); err != nil {
		return s
	}
	_ = os.Remove(probe)
	s.ready = true
	return s
}

// Ready reports whether the durable job directory is writable.
func (s *Store) Ready() bool { return s.ready }

// JobDir returns the per-job directory path.
func (s *Store) JobDir(id string) string { return filepath.Join(s.base, id) }

// ResultPath maps a result kind to its CSV file path within the job dir.
func (s *Store) ResultPath(id, kind string) (string, bool) {
	if !resultKinds[kind] {
		return "", false
	}
	return filepath.Join(s.JobDir(id), kind+".csv"), true
}

// NewJobID returns a sortable, collision-resistant id: inv_<utc14>_<nas>_<rand4>.
func NewJobID(nas string, now time.Time) string {
	var b [2]byte
	_, _ = rand.Read(b[:])
	return fmt.Sprintf("inv_%s_%s_%s", now.UTC().Format("20060102150405"), nas, hex.EncodeToString(b[:]))
}

// SaveJob writes status.json atomically (write temp + rename, atomic on the same
// filesystem) so a status poll or crash recovery never observes a partial file.
func (s *Store) SaveJob(j *Job) error {
	dir := s.JobDir(j.ID)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(dir, "status.json.tmp")
	final := filepath.Join(dir, "status.json")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, final)
}

// LoadJob reads a single job's status.json.
func (s *Store) LoadJob(id string) (*Job, error) {
	data, err := os.ReadFile(filepath.Join(s.JobDir(id), "status.json"))
	if err != nil {
		return nil, err
	}
	var j Job
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, err
	}
	return &j, nil
}

// ListJobs returns every persisted job, newest id first (ids are time-sortable).
func (s *Store) ListJobs() ([]*Job, error) {
	entries, err := os.ReadDir(s.base)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var jobs []*Job
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		j, err := s.LoadJob(e.Name())
		if err != nil {
			continue // skip unreadable/partial dirs rather than fail the whole list
		}
		jobs = append(jobs, j)
	}
	sort.Slice(jobs, func(i, k int) bool { return jobs[i].ID > jobs[k].ID })
	return jobs, nil
}

// WriteResult writes a result CSV for the job atomically.
func (s *Store) WriteResult(id, kind string, content []byte) error {
	path, ok := s.ResultPath(id, kind)
	if !ok {
		return fmt.Errorf("unknown result kind %q", kind)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, content, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
