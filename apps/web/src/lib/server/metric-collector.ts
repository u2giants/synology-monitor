/**
 * Metric collector — reads custom metric data collected by the NAS monitoring agent.
 *
 * Collection is done BY THE AGENT (apps/agent/internal/collector/custom.go), which
 * polls smon_custom_metric_schedules and runs shell commands natively inside the
 * container. This file only provides the read side: feeding collected data back
 * into AI analysis prompts.
 */

import type { SupabaseClient } from "./issue-store";

/** Fetch recent custom metric data for a resolution, formatted for an AI prompt. */
export async function getCustomMetricContext(
  supabase: SupabaseClient,
  resolutionId: string
): Promise<string> {
  const { data: schedules } = await supabase
    .from("smon_custom_metric_schedules")
    .select("id, name, nas_id, description, referenced_count")
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

  if (!dataPoints?.length) {
    return "\nCUSTOM METRICS: Collection schedules are active — data will appear within 60 seconds as the NAS agent picks them up.";
  }

  // Track that these metrics were referenced in analysis (for promotion decisions).
  // When referenced_count >= 3, this metric is consistently useful and should
  // be considered for permanent addition to the Go agent's built-in collectors.
  const referencedIds = schedules
    .filter((s) => dataPoints.some((d) => d.schedule_id === s.id))
    .map((s) => s.id);

  if (referencedIds.length) {
    await supabase.rpc("increment_metric_references", { schedule_ids: referencedIds }).throwOnError();
  }

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

  return `\nCUSTOM METRICS COLLECTED FOR THIS RESOLUTION (time-series data from NAS agent):\n${sections}`;
}
