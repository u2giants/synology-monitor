package sender

import "time"

type MetricPayload struct {
	NasID      string                 `json:"nas_id"`
	Type       string                 `json:"type"`
	Value      float64                `json:"value"`
	Unit       string                 `json:"unit"`
	Metadata   map[string]interface{} `json:"metadata,omitempty"`
	RecordedAt time.Time              `json:"recorded_at"`
}

type StoragePayload struct {
	NasID      string        `json:"nas_id"`
	VolumeID   string        `json:"volume_id"`
	VolumePath string        `json:"volume_path"`
	TotalBytes int64         `json:"total_bytes"`
	UsedBytes  int64         `json:"used_bytes"`
	Status     string        `json:"status"`
	RaidType   string        `json:"raid_type"`
	Disks      []DiskPayload `json:"disks"`
	RecordedAt time.Time     `json:"recorded_at"`
}

type DiskPayload struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Model       string `json:"model"`
	Serial      string `json:"serial"`
	SizeBytes   int64  `json:"size_bytes"`
	Temperature int    `json:"temperature_c"`
	SmartStatus string `json:"smart_status"`
}

type ContainerPayload struct {
	NasID         string    `json:"nas_id"`
	ContainerID   string    `json:"container_id"`
	ContainerName string    `json:"container_name"`
	Image         string    `json:"image"`
	Status        string    `json:"status"`
	CPUPercent    float64   `json:"cpu_percent"`
	MemoryBytes   int64     `json:"memory_bytes"`
	MemLimitBytes int64     `json:"memory_limit_bytes"`
	UptimeSeconds int64     `json:"uptime_seconds"`
	RecordedAt    time.Time `json:"recorded_at"`
}

type LogPayload struct {
	NasID    string                 `json:"nas_id"`
	Source   string                 `json:"source"`
	Severity string                 `json:"severity"`
	Message  string                 `json:"message"`
	Metadata map[string]interface{} `json:"metadata,omitempty"`
	LoggedAt time.Time              `json:"logged_at"`
}

type SecurityEventPayload struct {
	NasID       string                 `json:"nas_id"`
	Type        string                 `json:"type"`
	Severity    string                 `json:"severity"`
	Title       string                 `json:"title"`
	Description string                 `json:"description"`
	Details     map[string]interface{} `json:"details"`
	FilePath    string                 `json:"file_path,omitempty"`
	SourceIP    string                 `json:"source_ip,omitempty"`
	User        string                 `json:"user,omitempty"`
	DetectedAt  time.Time              `json:"detected_at"`
}

type AlertPayload struct {
	NasID    string `json:"nas_id,omitempty"`
	Severity string `json:"severity"`
	Source   string `json:"source"`
	Title    string `json:"title"`
	Message  string `json:"message"`
}

// DriveTeamFolderPayload represents a Synology Drive team folder snapshot
type DriveTeamFolderPayload struct {
	NasID        string    `json:"nas_id"`
	FolderID     string    `json:"folder_id"`
	FolderName   string    `json:"folder_name"`
	FolderPath   string    `json:"folder_path"`
	QuotaBytes   int64     `json:"quota_bytes"`
	UsedBytes    int64     `json:"used_bytes"`
	UsagePercent float64   `json:"usage_percent"`
	MemberCount  int       `json:"member_count"`
	SyncCount    int       `json:"sync_count"`
	IsExternal   bool      `json:"is_external"`
	Priority     string    `json:"priority"`
	Status       string    `json:"status"`
	RecordedAt   time.Time `json:"recorded_at"`
}

// DriveActivityPayload represents a Drive user activity event
type DriveActivityPayload struct {
	NasID      string    `json:"nas_id"`
	User       string    `json:"user"`
	LoginTime  string    `json:"login_time,omitempty"`
	IP         string    `json:"ip,omitempty"`
	Device     string    `json:"device,omitempty"`
	Action     string    `json:"action"`
	FilePath   string    `json:"file_path,omitempty"`
	Timestamp  string    `json:"timestamp,omitempty"`
	RecordedAt time.Time `json:"recorded_at"`
}

// ProcessSnapshotPayload is a single process row in smon_process_snapshots
type ProcessSnapshotPayload struct {
	NasID         string    `json:"nas_id"`
	SnapshotGrp   string    `json:"snapshot_grp"`
	CapturedAt    time.Time `json:"captured_at"`
	PID           int       `json:"pid"`
	Name          string    `json:"name"`
	Cmdline       string    `json:"cmdline,omitempty"`
	Username      string    `json:"username,omitempty"`
	State         string    `json:"state,omitempty"`
	CPUPct        float64   `json:"cpu_pct"`
	MemRSSKB      int64     `json:"mem_rss_kb"`
	MemPct        float64   `json:"mem_pct"`
	ReadBPS       int64     `json:"read_bps"`
	WriteBPS      int64     `json:"write_bps"`
	ParentService string    `json:"parent_service,omitempty"`
	Cgroup        string    `json:"cgroup,omitempty"`
}

// DiskIOStatPayload is a single device row in smon_disk_io_stats
type DiskIOStatPayload struct {
	NasID      string    `json:"nas_id"`
	CapturedAt time.Time `json:"captured_at"`
	Device     string    `json:"device"`
	VolumePath string    `json:"volume_path,omitempty"`
	ReadPS     float64   `json:"reads_ps"`
	WritePS    float64   `json:"writes_ps"`
	ReadBPS    int64     `json:"read_bps"`
	WriteBPS   int64     `json:"write_bps"`
	AwaitMS    float64   `json:"await_ms"`
	UtilPct    float64   `json:"util_pct"`
	QueueDepth float64   `json:"queue_depth"`
}

// SyncTaskSnapshotPayload is a row in smon_sync_task_snapshots
type SyncTaskSnapshotPayload struct {
	NasID            string    `json:"nas_id"`
	CapturedAt       time.Time `json:"captured_at"`
	TaskID           string    `json:"task_id"`
	TaskName         string    `json:"task_name,omitempty"`
	TaskType         string    `json:"task_type,omitempty"`
	Status           string    `json:"status,omitempty"`
	BacklogCount     int       `json:"backlog_count,omitempty"`
	BacklogBytes     int64     `json:"backlog_bytes,omitempty"`
	CurrentFile      string    `json:"current_file,omitempty"`
	CurrentFolder    string    `json:"current_folder,omitempty"`
	RetryCount       int       `json:"retry_count,omitempty"`
	LastError        string    `json:"last_error,omitempty"`
	TransferredFiles int       `json:"transferred_files,omitempty"`
	TransferredBytes int64     `json:"transferred_bytes,omitempty"`
	SpeedBPS         int64     `json:"speed_bps,omitempty"`
	IndexingQueue    int       `json:"indexing_queue,omitempty"`
}

// ServiceHealthPayload is a row in smon_service_health
type ServiceHealthPayload struct {
	NasID       string    `json:"nas_id"`
	ServiceName string    `json:"service_name"`
	Status      string    `json:"status"` // running, stopped, not_found
	CapturedAt  time.Time `json:"captured_at"`
}

// CustomMetricDataPayload is a row in smon_custom_metric_data
type CustomMetricDataPayload struct {
	ScheduleID string    `json:"schedule_id"`
	NasID      string    `json:"nas_id"`
	RawOutput  string    `json:"raw_output,omitempty"`
	Error      string    `json:"error,omitempty"`
	CapturedAt time.Time `json:"captured_at"`
}

// NetConnectionPayload is a row in smon_net_connections
type NetConnectionPayload struct {
	NasID      string    `json:"nas_id"`
	CapturedAt time.Time `json:"captured_at"`
	RemoteIP   string    `json:"remote_ip"`
	RemoteHost string    `json:"remote_host,omitempty"`
	LocalPort  int       `json:"local_port,omitempty"`
	Protocol   string    `json:"protocol,omitempty"`
	ConnCount  int       `json:"conn_count"`
	Username   string    `json:"username,omitempty"`
}

// ScheduledTaskPayload is a row in smon_scheduled_tasks
type ScheduledTaskPayload struct {
	NasID       string    `json:"nas_id"`
	TaskID      int       `json:"task_id"`
	TaskName    string    `json:"task_name"`
	TaskType    string    `json:"task_type,omitempty"`
	Owner       string    `json:"owner,omitempty"`
	Enabled     bool      `json:"enabled"`
	Status      string    `json:"status,omitempty"`
	LastRunTime string    `json:"last_run_time,omitempty"`
	NextRunTime string    `json:"next_run_time,omitempty"`
	LastResult  int       `json:"last_result"`
	CapturedAt  time.Time `json:"captured_at"`
}

// BackupTaskPayload is a row in smon_backup_tasks
type BackupTaskPayload struct {
	NasID            string    `json:"nas_id"`
	TaskID           string    `json:"task_id"`
	TaskName         string    `json:"task_name"`
	Enabled          bool      `json:"enabled"`
	Status           string    `json:"status,omitempty"`
	LastResult       string    `json:"last_result,omitempty"`
	LastRunTime      string    `json:"last_run_time,omitempty"`
	NextRunTime      string    `json:"next_run_time,omitempty"`
	DestType         string    `json:"dest_type,omitempty"`
	DestName         string    `json:"dest_name,omitempty"`
	TotalBytes       int64     `json:"total_bytes,omitempty"`
	TransferredBytes int64     `json:"transferred_bytes,omitempty"`
	SpeedBPS         int64     `json:"speed_bps,omitempty"`
	CapturedAt       time.Time `json:"captured_at"`
}

// SnapshotReplicaPayload is a row in smon_snapshot_replicas
type SnapshotReplicaPayload struct {
	NasID       string    `json:"nas_id"`
	TaskID      string    `json:"task_id"`
	TaskName    string    `json:"task_name,omitempty"`
	Status      string    `json:"status,omitempty"`
	SrcShare    string    `json:"src_share,omitempty"`
	DstShare    string    `json:"dst_share,omitempty"`
	DstHost     string    `json:"dst_host,omitempty"`
	LastResult  string    `json:"last_result,omitempty"`
	LastRunTime string    `json:"last_run_time,omitempty"`
	NextRunTime string    `json:"next_run_time,omitempty"`
	CapturedAt  time.Time `json:"captured_at"`
}
