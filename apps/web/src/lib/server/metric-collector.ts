/**
 * Metric collector — runs due custom metric collection schedules.
 * The resolution agent can create schedules; this module executes them
 * on a recurring basis and stores results in smon_custom_metric_data.
 */

import { runNasScript, getNasConfigs } from "./nas";
import type { SupabaseClient } from "./resolution-store";

const MAX_CONCURRENT = 4; // run at most N schedules per invocation

export async function collectDueMetrics(supabase: SupabaseClient): Promise<number> {
  const now = new Date().toISOString();

  const { data: dueTasks, error } = await supabase
    .from("smon_custom_metric_schedules")
    .select("id, name, nas_id, collection_command, interval_minutes")
    .eq("is_active", true)
    .lte("next_run_at", now)
    .order("next_run_at", { ascending: true })
    .limit(MAX_CONCURRENT);

  if (error || !dueTasks?.length) return 0;

  // Claim tasks by updating next_run_at immediately to prevent double-runs
  // (optimistic lock: only succeed if still due)
  const claimed: typeof dueTasks = [];
  for (const task of dueTasks) {
    const nextRun = new Date(Date.now() + task.interval_minutes * 60 * 1000).toISOString();
    const { data: updated } = await supabase
      .from("smon_custom_metric_schedules")
      .update({ last_run_at: now, next_run_at: nextRun })
      .eq("id", task.id)
      .lte("next_run_at", now) // only update if still due (prevents race)
      .select("id");

    if (updated?.length) claimed.push(task);
  }

  if (!claimed.length) return 0;

  // Run claimed tasks in parallel
  await Promise.all(
    claimed.map(async (task) => {
      const config = getNasConfigs().find((c) => c.name === task.nas_id);
      if (!config) {
        await supabase.from("smon_custom_metric_data").insert({
          schedule_id: task.id,
          nas_id: task.nas_id,
          raw_output: null,
          error: `Unknown NAS target: ${task.nas_id}`,
        });
        return;
      }

      try {
        const result = await runNasScript(config, task.collection_command, 30_000);
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").slice(0, 50_000);
        await supabase.from("smon_custom_metric_data").insert({
          schedule_id: task.id,
          nas_id: task.nas_id,
          raw_output: output || null,
          error: result.exitCode !== 0 ? `exit ${result.exitCode}` : null,
        });
      } catch (err) {
        await supabase.from("smon_custom_metric_data").insert({
          schedule_id: task.id,
          nas_id: task.nas_id,
          raw_output: null,
          error: err instanceof Error ? err.message : "SSH error",
        });
      }
    })
  );

  return claimed.length;
}

/** Fetch recent custom metric data for a resolution, formatted for an AI prompt. */
export async function getCustomMetricContext(
  supabase: SupabaseClient,
  resolutionId: string
): Promise<string> {
  const { data: schedules } = await supabase
    .from("smon_custom_metric_schedules")
    .select("id, name, nas_id, description")
    .eq("resolution_id", resolutionId)
    .eq("is_active", true);

  if (!schedules?.length) return "";

  const scheduleIds = schedules.map((s) => s.id);

  const { data: dataPoints } = await supabase
    .from("smon_custom_metric_data")
    .select("schedule_id, captured_at, raw_output, error")
    .in("schedule_id", scheduleIds)
    .order("captured_at", { ascending: false })
    .limit(100);

  if (!dataPoints?.length) return "\nCUSTOM METRICS: Schedules are active but no data collected yet. Check back after a few minutes.";

  const sections = schedules
    .map((s) => {
      const points = dataPoints.filter((d) => d.schedule_id === s.id);
      if (!points.length) return `### ${s.name} (${s.nas_id})\nNo data yet.`;
      const rows = points
        .slice(0, 20)
        .map((p) => `[${p.captured_at}] ${p.error ? `ERROR: ${p.error}` : (p.raw_output ?? "").slice(0, 800)}`)
        .join("\n");
      return `### ${s.name} (${s.nas_id}) — ${points.length} samples\n${s.description}\n${rows}`;
    })
    .join("\n\n");

  return `\nCUSTOM METRICS COLLECTED FOR THIS RESOLUTION (time-series data):\n${sections}`;
}
