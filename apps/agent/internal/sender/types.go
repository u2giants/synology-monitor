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
