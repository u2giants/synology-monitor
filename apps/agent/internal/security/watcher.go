package security

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/synology-monitor/agent/internal/sender"
)

// Watcher monitors file system for security threats
type Watcher struct {
	sender     *sender.Sender
	nasID      string
	watchPaths []string
	maxDirs    int
	db         *sql.DB

	// Ransomware detection state
	mu             sync.Mutex
	recentEvents   []fileEvent
	eventWindowSec int
	massThreshold  int

	// Worker pool for entropy checks to prevent unbounded goroutine spawning
	entropySemaphore chan struct{}
}

type fileEvent struct {
	path      string
	op        string
	timestamp time.Time
}

func NewWatcher(s *sender.Sender, nasID string, watchPaths []string, maxDirs int, dataDir string) (*Watcher, error) {
	dbPath := filepath.Join(dataDir, "checksums.db")
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS file_checksums (
			path TEXT PRIMARY KEY,
			checksum TEXT NOT NULL,
			size INTEGER,
			mtime INTEGER,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err == nil {
		// Add mtime column to existing DBs that pre-date this schema change
		_, _ = db.Exec(`ALTER TABLE file_checksums ADD COLUMN mtime INTEGER`)
	}
	if err != nil {
		return nil, err
	}

	return &Watcher{
		sender:           s,
		nasID:            nasID,
		watchPaths:       watchPaths,
		maxDirs:          maxDirs,
		db:               db,
		eventWindowSec:   60,
		massThreshold:    50,
		entropySemaphore: make(chan struct{}, 50), // Limit concurrent entropy checks to prevent OOM
	}, nil
}

func (w *Watcher) Close() error {
	return w.db.Close()
}

// Run starts both inotify watching and periodic checksum scanning
func (w *Watcher) Run(stop <-chan struct{}) {
	log.Println("[security] watcher started")

	// Start inotify watcher in goroutine
	go w.watchFiles(stop)

	// Run periodic checksum scan — hourly is sufficient because inotify covers
	// real-time writes; scanning every 15 min caused GB/s of unnecessary read I/O.
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			w.runChecksumScan()
		case <-stop:
			log.Println("[security] watcher stopped")
			return
		}
	}
}

func (w *Watcher) watchFiles(stop <-chan struct{}) {
	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("[security] error creating fsnotify watcher: %v", err)
		return
	}
	defer watcher.Close()

	// Add directories to watch (limited by maxDirs)
	dirCount := 0
	for _, root := range w.watchPaths {
		filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || !info.IsDir() {
				return nil
			}
			if dirCount >= w.maxDirs {
				return filepath.SkipDir
			}
			// Skip hidden/system directories
			base := filepath.Base(path)
			if strings.HasPrefix(base, ".") || strings.HasPrefix(base, "@") {
				return filepath.SkipDir
			}
			watcher.Add(path)
			dirCount++
			return nil
		})
	}

	log.Printf("[security] watching %d directories", dirCount)

	for {
		select {
		case event, ok := <-watcher.Events:
			if !ok {
				return
			}
			w.handleFileEvent(event)
		case err, ok := <-watcher.Errors:
			if !ok {
				return
			}
			log.Printf("[security] watcher error: %v", err)
		case <-stop:
			return
		}
	}
}

func (w *Watcher) handleFileEvent(event fsnotify.Event) {
	now := time.Now()

	// Track event for mass-change detection
	w.mu.Lock()
	w.recentEvents = append(w.recentEvents, fileEvent{
		path:      event.Name,
		op:        event.Op.String(),
		timestamp: now,
	})

	// Clean old events outside window
	cutoff := now.Add(-time.Duration(w.eventWindowSec) * time.Second)
	filtered := w.recentEvents[:0]
	for _, e := range w.recentEvents {
		if e.timestamp.After(cutoff) {
			filtered = append(filtered, e)
		}
	}
	w.recentEvents = filtered
	eventCount := len(w.recentEvents)
	w.mu.Unlock()

	// Check for mass rename/modify (ransomware indicator)
	if eventCount >= w.massThreshold {
		if event.Op&(fsnotify.Rename|fsnotify.Create) != 0 {
			w.sender.QueueSecurityEvent(sender.SecurityEventPayload{
				NasID:       w.nasID,
				Type:        "mass_file_rename",
				Severity:    "critical",
				Title:       "Mass file rename detected — possible ransomware",
				Description: "More than 50 file rename/create events detected within 60 seconds",
				Details: map[string]interface{}{
					"event_count": eventCount,
					"window_sec":  w.eventWindowSec,
					"latest_file": event.Name,
					"operation":   event.Op.String(),
				},
				FilePath:   event.Name,
				DetectedAt: now,
			})

			w.sender.QueueAlert(sender.AlertPayload{
				NasID:    w.nasID,
				Severity: "critical",
				Source:   "security",
				Title:    "RANSOMWARE ALERT: Mass file rename detected",
				Message:  fmt.Sprintf("%d file events in %d seconds. Latest: %s", eventCount, w.eventWindowSec, event.Name),
			})
		}
	}

	// Check entropy on modified files - use semaphore to limit concurrent goroutines
	if event.Op&fsnotify.Write != 0 {
		go func(path string, t time.Time) {
			w.entropySemaphore <- struct{}{}        // Acquire semaphore
			defer func() { <-w.entropySemaphore }() // Release semaphore
			w.checkFileEntropy(path, t)
		}(event.Name, now)
	}
}

func (w *Watcher) checkFileEntropy(path string, detectedAt time.Time) {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() || info.Size() < 1024 || info.Size() > 10*1024*1024 {
		return
	}

	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	// Read first 4KB for entropy check
	buf := make([]byte, 4096)
	n, err := f.Read(buf)
	if err != nil || n < 1024 {
		return
	}
	buf = buf[:n]

	entropy := shannonEntropy(buf)

	// Encrypted files typically have entropy > 7.9 (out of 8.0)
	if entropy > 7.9 {
		ext := strings.ToLower(filepath.Ext(path))
		// Skip files that naturally have high entropy (compressed, media, etc.)
		if isNaturallyHighEntropy(ext) {
			return
		}

		w.sender.QueueSecurityEvent(sender.SecurityEventPayload{
			NasID:       w.nasID,
			Type:        "high_entropy_file",
			Severity:    "warning",
			Title:       "Suspicious high-entropy file modification",
			Description: "File was modified and has unusually high entropy, possibly encrypted",
			Details: map[string]interface{}{
				"entropy":   entropy,
				"file_size": info.Size(),
				"extension": ext,
			},
			FilePath:   path,
			DetectedAt: detectedAt,
		})
	}
}

func shannonEntropy(data []byte) float64 {
	if len(data) == 0 {
		return 0
	}

	freq := make(map[byte]int)
	for _, b := range data {
		freq[b]++
	}

	entropy := 0.0
	dataLen := float64(len(data))
	for _, count := range freq {
		p := float64(count) / dataLen
		if p > 0 {
			entropy -= p * math.Log2(p)
		}
	}
	return entropy
}

func isNaturallyHighEntropy(ext string) bool {
	highEntropy := map[string]bool{
		".zip": true, ".gz": true, ".tar": true, ".7z": true, ".rar": true,
		".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
		".mp4": true, ".mkv": true, ".avi": true, ".mov": true,
		".mp3": true, ".flac": true, ".aac": true, ".ogg": true,
		".pdf": true, ".psd": true, ".ai": true,
		".exe": true, ".dll": true, ".so": true,
		".enc": true, ".gpg": true, ".aes": true,
	}
	return highEntropy[ext]
}

// runChecksumScan compares file checksums against baseline
func (w *Watcher) runChecksumScan() {
	log.Println("[security] starting checksum scan...")

	scanned := 0
	changed := 0

	for _, root := range w.watchPaths {
		filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			// Skip large files and system files
			if info.Size() > 100*1024*1024 || strings.HasPrefix(filepath.Base(path), ".") {
				return nil
			}

			scanned++
			currentMtime := info.ModTime().Unix()

			// Check stored mtime — if unchanged, skip reading the file entirely.
			// This avoids re-hashing every file on every scan (which caused GB/s of I/O).
			var storedChecksum string
			var storedMtime int64
			err = w.db.QueryRow("SELECT checksum, COALESCE(mtime, 0) FROM file_checksums WHERE path = ?", path).Scan(&storedChecksum, &storedMtime)
			if err == nil && storedMtime == currentMtime {
				// mtime unchanged — file content almost certainly the same, skip
				return nil
			}

			checksum := fileChecksum(path)
			if checksum == "" {
				return nil
			}

			if err == sql.ErrNoRows {
				// New file — store baseline
				w.db.Exec("INSERT INTO file_checksums (path, checksum, size, mtime) VALUES (?, ?, ?, ?)",
					path, checksum, info.Size(), currentMtime)
			} else if err == nil && storedChecksum != checksum {
				// mtime changed AND checksum changed — genuinely modified
				changed++
				w.db.Exec("UPDATE file_checksums SET checksum = ?, size = ?, mtime = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?",
					checksum, info.Size(), currentMtime, path)

				w.sender.QueueSecurityEvent(sender.SecurityEventPayload{
					NasID:       w.nasID,
					Type:        "suspicious_file_change",
					Severity:    "info",
					Title:       "File checksum changed",
					Description: "File content changed since last scan",
					Details: map[string]interface{}{
						"old_checksum": storedChecksum,
						"new_checksum": checksum,
						"file_size":    info.Size(),
					},
					FilePath:   path,
					DetectedAt: time.Now(),
				})
			} else if err == nil {
				// mtime changed but checksum matches — update stored mtime so we
				// don't re-read this file next scan (e.g. touch without content change)
				w.db.Exec("UPDATE file_checksums SET mtime = ?, updated_at = CURRENT_TIMESTAMP WHERE path = ?",
					currentMtime, path)
			}

			return nil
		})
	}

	log.Printf("[security] checksum scan complete: %d files scanned, %d changes detected", scanned, changed)
}

func fileChecksum(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return ""
	}
	return hex.EncodeToString(h.Sum(nil))
}
