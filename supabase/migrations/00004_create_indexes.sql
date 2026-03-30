-- ============================================
-- Indexes for common query patterns
-- ============================================

-- Metrics: query by NAS + type + time range
create index smon_metrics_nas_type_time on smon_metrics (nas_id, type, recorded_at desc);

-- Logs: query by NAS + source + severity + time
create index smon_logs_nas_source_time on smon_logs (nas_id, source, ingested_at desc);
create index smon_logs_severity on smon_logs (severity, ingested_at desc);

-- Storage: latest snapshot per NAS + volume
create index smon_storage_nas_volume_time on smon_storage_snapshots (nas_id, volume_id, recorded_at desc);

-- Container status: latest per NAS + container
create index smon_container_nas_name_time on smon_container_status (nas_id, container_name, recorded_at desc);

-- Security events: unacknowledged events, by type
create index smon_security_unack on smon_security_events (acknowledged, detected_at desc) where not acknowledged;
create index smon_security_type on smon_security_events (type, detected_at desc);

-- Alerts: active alerts, by severity
create index smon_alerts_active on smon_alerts (status, severity, created_at desc) where status = 'active';
create index smon_alerts_nas on smon_alerts (nas_id, created_at desc);

-- AI analyses: latest by type
create index smon_ai_type_time on smon_ai_analyses (type, created_at desc);
