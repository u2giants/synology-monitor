"use client";

import { useState } from "react";
import { useNasUnits } from "@/hooks/use-nas-units";
import { useMetrics } from "@/hooks/use-metrics";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { cn } from "@/lib/utils";

const ranges = ["1h", "6h", "24h", "7d", "30d"] as const;

const metricGroups = [
  {
    title: "CPU & Load",
    metrics: ["cpu_usage", "system_load_1", "system_load_5"],
    colors: ["#3b82f6", "#8b5cf6", "#a855f7"],
  },
  {
    title: "Memory",
    metrics: ["memory_usage"],
    colors: ["#22c55e"],
  },
  {
    title: "Network",
    metrics: ["network_rx", "network_tx"],
    colors: ["#06b6d4", "#f59e0b"],
  },
];

export default function MetricsPage() {
  const { units } = useNasUnits();
  const [selectedNas, setSelectedNas] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof ranges)[number]>("24h");

  const nasId = selectedNas ?? units[0]?.id ?? null;
  const allMetrics = metricGroups.flatMap((g) => g.metrics);
  const { series, loading } = useMetrics(nasId, allMetrics, range);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Metrics</h1>

        <div className="flex items-center gap-4">
          {/* NAS selector */}
          {units.length > 1 && (
            <select
              className="rounded-md border border-border bg-card px-3 py-1.5 text-sm"
              value={nasId ?? ""}
              onChange={(e) => setSelectedNas(e.target.value)}
            >
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}

          {/* Range selector */}
          <div className="flex rounded-md border border-border">
            {ranges.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={cn(
                  "px-3 py-1.5 text-sm font-medium transition-colors",
                  r === range
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading metrics...</div>
      ) : (
        <div className="space-y-6">
          {metricGroups.map((group) => {
            const groupSeries = series.filter((s) =>
              group.metrics.includes(s.type)
            );

            if (groupSeries.length === 0) return null;

            // Merge data points by timestamp
            const merged = mergeSeriesData(groupSeries);

            return (
              <section key={group.title}>
                <h2 className="mb-3 text-lg font-semibold">{group.title}</h2>
                <div className="rounded-lg border border-border bg-card p-4">
                  <ResponsiveContainer width="100%" height={250}>
                    <LineChart data={merged}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 11, fill: "#737373" }}
                        tickFormatter={formatTime}
                      />
                      <YAxis tick={{ fontSize: 11, fill: "#737373" }} />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#141414",
                          border: "1px solid #262626",
                          borderRadius: "6px",
                          fontSize: 12,
                        }}
                      />
                      {groupSeries.map((s, i) => (
                        <Line
                          key={s.type}
                          type="monotone"
                          dataKey={s.type}
                          stroke={group.colors[i]}
                          strokeWidth={2}
                          dot={false}
                          name={s.type.replace(/_/g, " ")}
                        />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function mergeSeriesData(
  seriesList: { type: string; data: { recorded_at: string; value: number }[] }[]
) {
  const timeMap = new Map<string, Record<string, number>>();

  for (const s of seriesList) {
    for (const point of s.data) {
      const existing = timeMap.get(point.recorded_at) || {};
      existing[s.type] = point.value;
      existing.time = new Date(point.recorded_at).getTime() as any;
      timeMap.set(point.recorded_at, existing);
    }
  }

  return Array.from(timeMap.values()).sort(
    (a, b) => (a.time as number) - (b.time as number)
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}
