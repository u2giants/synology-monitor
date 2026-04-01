// === NAS Units ===

export interface NasUnit {
  id: string;
  name: string;
  model: string;
  dsm_version: string;
  hostname: string;
  last_seen: string;
  status: "online" | "offline" | "degraded";
  created_at: string;
}

// === Metrics ===

export type MetricType =
  | "cpu_usage"
  | "memory_usage"
  | "memory_total"
  | "network_rx"
  | "network_tx"
  | "disk_io_read"
  | "disk_io_write"
  | "temperature_cpu"
  | "temperature_disk"
  | "system_load_1"
  | "system_load_5"
  | "system_load_15";

export interface Metric {
  id: string;
  nas_id: string;
  type: MetricType;
  value: number;
  unit: string;
  metadata: Record<string, unknown> | null;
  recorded_at: string;
}

export interface MetricBatch {
  nas_id: string;
  metrics: Omit<Metric, "id" | "nas_id">[];
}

// === Storage ===

export interface StorageSnapshot {
  id: string;
  nas_id: string;
  volume_id: string;
  volume_path: string;
  total_bytes: number;
  used_bytes: number;
  status: "normal" | "degraded" | "crashed" | "unknown";
  raid_type: string;
  disks: DiskInfo[];
  recorded_at: string;
}

export interface DiskInfo {
  id: string;
  name: string;
  model: string;
  serial: string;
  size_bytes: number;
  temperature_c: number;
  smart_status: "healthy" | "warning" | "failing" | "unknown";
  smart_attributes: SmartAttribute[];
}

export interface SmartAttribute {
  id: number;
  name: string;
  current: number;
  worst: number;
  threshold: number;
  raw_value: string;
}

// === Logs ===

export type LogSeverity = "info" | "warning" | "error" | "critical";
export type LogSource = "system" | "security" | "connection" | "package" | "docker" | "drive" | "drive_server" | "drive_sharesync" | "smb";

export interface LogEntry {
  id: string;
  nas_id: string;
  source: LogSource;
  severity: LogSeverity;
  message: string;
  metadata: Record<string, unknown> | null;
  logged_at: string;
  ingested_at: string;
}

export interface LogBatch {
  nas_id: string;
  entries: Omit<LogEntry, "id" | "nas_id" | "ingested_at">[];
}

// === Docker Containers ===

export interface ContainerStatus {
  id: string;
  nas_id: string;
  container_id: string;
  container_name: string;
  image: string;
  status: "running" | "stopped" | "restarting" | "paused" | "exited";
  cpu_percent: number;
  memory_bytes: number;
  memory_limit_bytes: number;
  uptime_seconds: number;
  recorded_at: string;
}

// === Security Events ===

export type SecurityEventType =
  | "unauthorized_access"
  | "suspicious_file_change"
  | "mass_file_rename"
  | "mass_file_modify"
  | "high_entropy_file"
  | "permission_change"
  | "brute_force_attempt"
  | "new_share_access"
  | "unusual_login_time"
  | "service_change";

export interface SecurityEvent {
  id: string;
  nas_id: string;
  type: SecurityEventType;
  severity: LogSeverity;
  title: string;
  description: string;
  details: Record<string, unknown>;
  file_path: string | null;
  source_ip: string | null;
  user: string | null;
  acknowledged: boolean;
  detected_at: string;
}

// === Alerts ===

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "active" | "acknowledged" | "resolved";
export type AlertSource = "metric" | "security" | "storage" | "ai" | "agent";

export interface Alert {
  id: string;
  nas_id: string | null;
  severity: AlertSeverity;
  status: AlertStatus;
  source: AlertSource;
  title: string;
  message: string;
  details: Record<string, unknown> | null;
  created_at: string;
  acknowledged_at: string | null;
  resolved_at: string | null;
}

// === AI Analysis ===

export type AnalysisType =
  | "anomaly_detection"
  | "daily_health"
  | "security_review"
  | "storage_prediction";

export interface AiAnalysis {
  id: string;
  nas_id: string | null;
  type: AnalysisType;
  summary: string;
  findings: AiFinding[];
  recommendations: string[];
  model: string;
  tokens_used: number;
  created_at: string;
}

export interface AiFinding {
  severity: AlertSeverity;
  category: string;
  description: string;
  metric_name: string | null;
  current_value: number | null;
  expected_range: string | null;
}

// === Push Subscriptions ===

export interface PushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  user_agent: string;
  created_at: string;
}

// === API Request/Response Types ===

export interface ApiResponse<T> {
  data: T;
  error: null;
}

export interface ApiError {
  data: null;
  error: {
    code: string;
    message: string;
  };
}

export interface MetricQuery {
  nas_id?: string;
  type?: MetricType;
  from: string;
  to: string;
  interval?: "1m" | "5m" | "15m" | "1h" | "6h" | "1d";
}

export interface DashboardOverview {
  nas_units: NasUnit[];
  active_alerts: number;
  critical_alerts: number;
  latest_analysis: AiAnalysis | null;
  storage_summary: {
    nas_id: string;
    total_bytes: number;
    used_bytes: number;
    volume_count: number;
  }[];
}
