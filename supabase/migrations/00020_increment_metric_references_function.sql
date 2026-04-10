CREATE OR REPLACE FUNCTION increment_metric_references(schedule_ids uuid[])
RETURNS void
LANGUAGE sql
AS $$
  UPDATE smon_custom_metric_schedules
  SET referenced_count = referenced_count + 1
  WHERE id = ANY(schedule_ids);
$$;
