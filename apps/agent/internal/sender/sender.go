package sender

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// Sender buffers data in a local SQLite WAL and sends to Supabase
type Sender struct {
	supabaseURL string
	serviceKey  string
	httpClient  *http.Client
	db          *sql.DB
	mu          sync.Mutex
	batchSize   int
	flushEvery  time.Duration
	maxWALSize  int64
}

func New(supabaseURL, serviceKey, dataDir string, batchSize int, flushEvery time.Duration, maxWALSize int64) (*Sender, error) {
	dbPath := fmt.Sprintf("%s/wal.db", dataDir)
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, fmt.Errorf("opening WAL database: %w", err)
	}

	// Create WAL table
	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS wal_entries (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			table_name TEXT NOT NULL,
			payload TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			attempts INTEGER DEFAULT 0,
			last_error TEXT
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("creating WAL table: %w", err)
	}

	_, err = db.Exec(`
		CREATE TABLE IF NOT EXISTS checkpoints (
			name TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`)
	if err != nil {
		return nil, fmt.Errorf("creating checkpoints table: %w", err)
	}

	return &Sender{
		supabaseURL: supabaseURL,
		serviceKey:  serviceKey,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
		db:         db,
		batchSize:  batchSize,
		flushEvery: flushEvery,
		maxWALSize: maxWALSize,
	}, nil
}

func (s *Sender) Close() error {
	return s.db.Close()
}

// Queue methods write to local SQLite WAL

func (s *Sender) QueueMetric(m MetricPayload) {
	s.queue("metrics", m)
}

func (s *Sender) QueueStorageSnapshot(p StoragePayload) {
	s.queue("storage_snapshots", p)
}

func (s *Sender) QueueContainerStatus(p ContainerPayload) {
	s.queue("container_status", p)
}

func (s *Sender) QueueLog(p LogPayload) {
	s.queue("nas_logs", p)
}

func (s *Sender) QueueSecurityEvent(p SecurityEventPayload) {
	s.queue("security_events", p)
}

func (s *Sender) QueueAlert(p AlertPayload) {
	p.Severity = normalizeSeverity(p.Severity)
	s.queue("alerts", p)
}

// normalizeSeverity coerces an alert severity to the values permitted by the
// alerts CHECK constraint (info|warning|critical). Collectors emit "error" for
// serious faults (btrfs/storage/hyperbackup), which maps to critical; anything
// unrecognized falls back to warning so the alert is never rejected outright.
func normalizeSeverity(sev string) string {
	switch s := strings.ToLower(strings.TrimSpace(sev)); s {
	case "info", "warning", "critical":
		return s
	case "error", "err", "fatal", "crit":
		return "critical"
	case "warn":
		return "warning"
	case "debug", "notice", "trace":
		return "info"
	default:
		return "warning"
	}
}

func (s *Sender) QueueDriveTeamFolder(p DriveTeamFolderPayload) {
	s.queue("drive_team_folders", p)
}

func (s *Sender) QueueDriveActivity(p DriveActivityPayload) {
	s.queue("drive_activities", p)
}

func (s *Sender) QueueProcessSnapshot(p ProcessSnapshotPayload) {
	s.queue("process_snapshots", p)
}

func (s *Sender) QueueDiskIOStat(p DiskIOStatPayload) {
	s.queue("disk_io_stats", p)
}

func (s *Sender) QueueSyncTaskSnapshot(p SyncTaskSnapshotPayload) {
	s.queue("sync_task_snapshots", p)
}

func (s *Sender) QueueNetConnection(p NetConnectionPayload) {
	s.queue("net_connections", p)
}

func (s *Sender) QueueServiceHealth(p ServiceHealthPayload) {
	s.queue("service_health", p)
}

func (s *Sender) QueueCustomMetricData(p CustomMetricDataPayload) {
	s.queue("custom_metric_data", p)
}

func (s *Sender) QueueScheduledTask(p ScheduledTaskPayload) {
	s.queue("scheduled_tasks", p)
}

func (s *Sender) QueueBackupTask(p BackupTaskPayload) {
	s.queue("backup_tasks", p)
}

func (s *Sender) QueueSnapshotReplica(p SnapshotReplicaPayload) {
	s.queue("snapshot_replicas", p)
}

func (s *Sender) QueueContainerIO(p ContainerIOPayload) {
	s.queue("container_io", p)
}

func (s *Sender) QueuePackageStatus(p PackageStatusPayload) {
	s.queue("package_status", p)
}

func (s *Sender) QueueDSMError(p DSMErrorPayload) {
	s.queue("dsm_errors", p)
}

// upsertTables lists tables that should use Supabase's merge-duplicates
// resolution (INSERT … ON CONFLICT DO UPDATE).  The table must have a UNIQUE
// constraint on its natural key for this to take effect.
var upsertTables = map[string]bool{
	"package_status": true,
}

// upsertConflictTargets maps a table to the unique-constraint columns that
// merge-duplicates must target. PostgREST infers the primary key by default,
// which never matches our natural-key conflict (the agent omits the serial id),
// so without this the "upsert" raises a 409 on every existing row.
var upsertConflictTargets = map[string]string{
	"package_status": "nas_id,package_id",
}

// SaveCheckpoint persists a named cursor value (e.g. a log file byte offset)
// so it survives agent restarts.
func (s *Sender) SaveCheckpoint(name, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO checkpoints (name, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(name) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`,
		name, value,
	)
	return err
}

// LoadCheckpoint reads a previously saved checkpoint. Returns ("", nil) if not found.
func (s *Sender) LoadCheckpoint(name string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var value string
	err := s.db.QueryRow("SELECT value FROM checkpoints WHERE name = ?", name).Scan(&value)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return value, err
}

func (s *Sender) queue(table string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[sender] error marshaling payload for %s: %v", table, err)
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	_, err = s.db.Exec(
		"INSERT INTO wal_entries (table_name, payload) VALUES (?, ?)",
		table, string(data),
	)
	if err != nil {
		log.Printf("[sender] error writing to WAL: %v", err)
	}
}

// Run starts the sender loop that flushes WAL entries to Supabase
func (s *Sender) Run(stop <-chan struct{}) {
	ticker := time.NewTicker(s.flushEvery)
	defer ticker.Stop()

	log.Printf("[sender] started (flush every %s, batch size %d)", s.flushEvery, s.batchSize)

	for {
		select {
		case <-ticker.C:
			s.flush()
		case <-stop:
			log.Println("[sender] flushing remaining entries...")
			s.flush()
			log.Println("[sender] stopped")
			return
		}
	}
}

func (s *Sender) flush() {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Enforce WAL size limit
	s.enforceWALLimit()

	// Get distinct tables with pending entries
	rows, err := s.db.Query("SELECT DISTINCT table_name FROM wal_entries WHERE attempts < 5 ORDER BY table_name")
	if err != nil {
		log.Printf("[sender] error querying tables: %v", err)
		return
	}

	var tables []string
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			log.Printf("[sender] error scanning table name: %v", err)
			continue
		}
		tables = append(tables, t)
	}
	if err := rows.Err(); err != nil {
		log.Printf("[sender] error iterating tables: %v", err)
	}
	rows.Close()

	for _, table := range tables {
		s.flushTable(table)
	}
}

func (s *Sender) flushTable(table string) {
	// Get batch of entries
	rows, err := s.db.Query(
		"SELECT id, payload FROM wal_entries WHERE table_name = ? AND attempts < 5 ORDER BY id LIMIT ?",
		table, s.batchSize,
	)
	if err != nil {
		log.Printf("[sender] error querying %s entries: %v", table, err)
		return
	}

	var ids []int64
	var payloads []json.RawMessage

	for rows.Next() {
		var id int64
		var payload string
		if err := rows.Scan(&id, &payload); err != nil {
			log.Printf("[sender] error scanning row in %s: %v", table, err)
			continue
		}
		ids = append(ids, id)
		payloads = append(payloads, json.RawMessage(payload))
	}
	if err := rows.Err(); err != nil {
		log.Printf("[sender] error iterating rows in %s: %v", table, err)
	}
	rows.Close()

	if len(payloads) == 0 {
		return
	}

	status, errMsg, transportErr := s.postRows(table, payloads)
	if transportErr != nil {
		// Network/transport failure — transient. Retry the whole batch later.
		log.Printf("[sender] error sending to %s: %v", table, transportErr)
		s.incrementAttempts(ids, transportErr.Error())
		return
	}

	if status >= 200 && status < 300 {
		s.deleteEntries(ids)
		log.Printf("[sender] flushed %d entries to %s", len(ids), table)
		return
	}

	// A client error (4xx) on a multi-row batch means one or more individual
	// rows are bad (e.g. a value that violates a CHECK constraint). PostgREST
	// rejects the ENTIRE batch for one bad row, so retrying the batch forever
	// would let a single poison row block — and eventually drop — every other
	// row behind it. Isolate by re-sending each row alone: good rows get
	// through, only the genuinely bad rows accumulate attempts and are dropped.
	if status >= 400 && status < 500 && len(ids) > 1 {
		log.Printf("[sender] %s: batch rejected (HTTP %d) — isolating bad rows row-by-row", table, status)
		good := 0
		for i, id := range ids {
			st, em, te := s.postRows(table, []json.RawMessage{payloads[i]})
			switch {
			case te != nil:
				s.incrementAttempts([]int64{id}, te.Error())
			case st >= 200 && st < 300:
				s.deleteEntries([]int64{id})
				good++
			default:
				s.incrementAttempts([]int64{id}, fmt.Sprintf("HTTP %d: %s", st, em))
			}
		}
		log.Printf("[sender] %s: %d/%d rows accepted after isolation", table, good, len(ids))
		return
	}

	// 5xx, or a single-row 4xx: increment and retry later (5xx is transient;
	// a lone 4xx row will be dropped after maxAttempts with its error logged).
	log.Printf("[sender] error from Supabase for %s: HTTP %d: %s", table, status, errMsg)
	s.incrementAttempts(ids, fmt.Sprintf("HTTP %d: %s", status, errMsg))
}

// postRows POSTs one batch (1..N rows) to a table's REST endpoint and returns
// the HTTP status + response body, or a non-nil error for transport failures.
func (s *Sender) postRows(table string, payloads []json.RawMessage) (int, string, error) {
	body, err := normalizeBatchPayloads(payloads)
	if err != nil {
		return 0, "", fmt.Errorf("normalizing batch for %s: %w", table, err)
	}
	// Postgres text/jsonb cannot store NUL. Strip any JSON NUL escapes so rows
	// carrying NUL bytes (e.g. from /proc cmdlines or log content) aren't
	// rejected wholesale with SQLSTATE 22P05. The byte slice is the 6 ASCII
	// chars backslash-u-0-0-0-0 that json.Marshal emits for a NUL byte.
	body = bytes.ReplaceAll(body, []byte{0x5c, 0x75, 0x30, 0x30, 0x30, 0x30}, nil)

	url := fmt.Sprintf("%s/rest/v1/%s", s.supabaseURL, table)
	if cols := upsertConflictTargets[table]; cols != "" {
		url += "?on_conflict=" + cols
	}
	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		return 0, "", err
	}

	preferHeader := "return=minimal"
	if upsertTables[table] {
		preferHeader = "resolution=merge-duplicates,return=minimal"
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", s.serviceKey)
	req.Header.Set("Authorization", "Bearer "+s.serviceKey)
	req.Header.Set("Prefer", preferHeader)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return resp.StatusCode, "", nil
	}
	respBody, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(respBody), nil
}

func (s *Sender) deleteEntries(ids []int64) {
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[sender] error starting transaction for delete: %v", err)
		return
	}
	for _, id := range ids {
		if _, err := tx.Exec("DELETE FROM wal_entries WHERE id = ?", id); err != nil {
			log.Printf("[sender] error deleting entry %d: %v", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[sender] error committing delete transaction: %v", err)
	}
}

func (s *Sender) incrementAttempts(ids []int64, errMsg string) {
	tx, err := s.db.Begin()
	if err != nil {
		log.Printf("[sender] error starting transaction for increment: %v", err)
		return
	}
	for _, id := range ids {
		if _, err := tx.Exec("UPDATE wal_entries SET attempts = attempts + 1, last_error = ? WHERE id = ?", errMsg, id); err != nil {
			log.Printf("[sender] error incrementing attempts for %d: %v", id, err)
		}
	}
	if err := tx.Commit(); err != nil {
		log.Printf("[sender] error committing increment transaction: %v", err)
	}
}

func (s *Sender) enforceWALLimit() {
	// Check WAL size
	var count int64
	if err := s.db.QueryRow("SELECT COUNT(*) FROM wal_entries").Scan(&count); err != nil {
		log.Printf("[sender] error checking WAL size: %v", err)
		return
	}

	// Rough estimate: 500 bytes per entry
	estimatedSize := count * 500
	if estimatedSize > s.maxWALSize {
		// Delete oldest entries that exceed the limit
		excess := (estimatedSize - s.maxWALSize) / 500
		if _, err := s.db.Exec("DELETE FROM wal_entries WHERE id IN (SELECT id FROM wal_entries ORDER BY id LIMIT ?)", excess); err != nil {
			log.Printf("[sender] WAL limit enforcement failed: %v", err)
		} else {
			log.Printf("[sender] WAL limit enforced: deleted %d oldest entries", excess)
		}
	}

	// Also clean up entries with too many failed attempts
	if _, err := s.db.Exec("DELETE FROM wal_entries WHERE attempts >= 5"); err != nil {
		log.Printf("[sender] WAL failed-attempts cleanup failed: %v", err)
	}
}

func normalizeBatchPayloads(payloads []json.RawMessage) ([]byte, error) {
	normalized := make([]map[string]interface{}, 0, len(payloads))
	keySet := make(map[string]struct{})

	for _, payload := range payloads {
		var row map[string]interface{}
		if err := json.Unmarshal(payload, &row); err != nil {
			return nil, fmt.Errorf("unmarshal payload: %w", err)
		}
		for key := range row {
			keySet[key] = struct{}{}
		}
		normalized = append(normalized, row)
	}

	for _, row := range normalized {
		for key := range keySet {
			if _, ok := row[key]; !ok {
				row[key] = nil
			}
		}
	}

	body, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("marshal normalized payloads: %w", err)
	}

	return body, nil
}

// SendHeartbeat updates the NAS unit's last_seen timestamp and agent version.
func (s *Sender) SendHeartbeat(nasID, nasName, model, dsmVersion, agentVersion, agentBuiltAt string) {
	payload := map[string]interface{}{
		"id":             nasID,
		"name":           nasName,
		"model":          model,
		"dsm_version":    dsmVersion,
		"last_seen":      time.Now().UTC(),
		"status":         "online",
		"agent_version":  agentVersion,
		"agent_built_at": agentBuiltAt,
	}

	body, _ := json.Marshal(payload)
	url := fmt.Sprintf("%s/rest/v1/nas_units", s.supabaseURL)

	req, err := http.NewRequest("POST", url, bytes.NewReader(body))
	if err != nil {
		log.Printf("[sender] heartbeat error: %v", err)
		return
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("apikey", s.serviceKey)
	req.Header.Set("Authorization", "Bearer "+s.serviceKey)
	req.Header.Set("Prefer", "resolution=merge-duplicates,return=minimal")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		log.Printf("[sender] heartbeat send error: %v", err)
		return
	}
	resp.Body.Close()
}
