"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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
import { cn, formatBytes } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";

const ranges = ["1h", "6h", "24h", "7d", "30d"] as const;

const metricGroups = [
  {
    title: "CPU & Load",
    metrics: ["cpu_usage", "cpu_iowait_pct", "system_load_1", "system_load_5"],
    colors: ["#3b82f6", "#ef4444", "#8b5cf6", "#a855f7"],
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

interface DiskIOPoint {
  time: number;
  read_bps: number;
  write_bps: number;
}

interface DiskIODevice {
  device: string;
  volume_path: string | null;
  points: DiskIOPoint[];
}

interface TopProcess {
  pid: number;
  name: string;
  username: string | null;
  read_bps: number;
  write_bps: number;
  cpu_pct: number;
  mem_rss_kb: number;
}

function useDiskIO(nasId: string | null, range: (typeof ranges)[number]) {
  const [devices, setDevices] = useState<DiskIODevice[]>([]);
  const [topProcesses, setTopProcesses] = useState<TopProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataAge, setDataAge] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!nasId) return;
    setLoading(true);

    const supabase = createClient();
    const from = new Date(Date.now() - parseRange(range)).toISOString();

    // Fetch disk I/O stats
    const { data: ioRows } = await supabase
      .from("smon_disk_io_stats")
      .select("captured_at, device, volume_path, read_bps, write_bps")
      .eq("nas_id", nasId)
      .gte("captured_at", from)
      .order("captured_at", { ascending: true })
      .limit(2000);

    // Group by device
    const deviceMap = new Map<string, DiskIODevice>();
    for (const row of ioRows ?? []) {
      if (!deviceMap.has(row.device)) {
        deviceMap.set(row.device, {
          device: row.device,
          volume_path: row.volume_path,
          points: [],
        });
      }
      deviceMap.get(row.device)!.points.push({
        time: new Date(row.captured_at).getTime(),
        read_bps: row.read_bps ?? 0,
        write_bps: row.write_bps ?? 0,
      });
    }
    setDevices(Array.from(deviceMap.values()));

    // Fetch top processes from the most recent snapshot
    // First get the latest snapshot_grp
    const { data: latestSnap } = await supabase
      .from("smon_process_snapshots")
      .select("snapshot_grp, captured_at")
      .eq("nas_id", nasId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .single();

    if (latestSnap) {
      setDataAge(latestSnap.captured_at);

      const { data: procRows } = await supabase
        .from("smon_process_snapshots")
        .select("pid, name, username, read_bps, write_bps, cpu_pct, mem_rss_kb")
        .eq("nas_id", nasId)
        .eq("snapshot_grp", latestSnap.snapshot_grp)
        .order("read_bps", { ascending: false })
        .limit(100);

      // Sort by total I/O and take top 10
      const sorted = (procRows ?? [])
        .filter((p) => p.read_bps > 0 || p.write_bps > 0)
        .sort((a, b) => (b.read_bps + b.write_bps) - (a.read_bps + a.write_bps))
        .slice(0, 10);

      setTopProcesses(sorted);
    } else {
      setTopProcesses([]);
    }

    setLoading(false);
  }, [nasId, range]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30000);
    return () => clearInterval(id);
  }, [fetch]);

  return { devices, topProcesses, loading, dataAge };
}

// Aggregate per-device points into a single merged time series for the chart.
// Points at the same (or near) timestamp are summed across all devices.
function aggregateDevicePoints(devices: DiskIODevice[]): DiskIOPoint[] {
  const byTime = new Map<number, DiskIOPoint>();

  for (const dev of devices) {
    for (const pt of dev.points) {
      // Round to nearest 15s bucket to align across devices
      const bucket = Math.round(pt.time / 15000) * 15000;
      const existing = byTime.get(bucket);
      if (existing) {
        existing.read_bps += pt.read_bps;
        existing.write_bps += pt.write_bps;
      } else {
        byTime.set(bucket, { time: bucket, read_bps: pt.read_bps, write_bps: pt.write_bps });
      }
    }
  }

  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

export default function MetricsPage() {
  const { units } = useNasUnits();
  const [selectedNas, setSelectedNas] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof ranges)[number]>("24h");

  const nasId = selectedNas ?? units[0]?.id ?? null;
  const allMetrics = metricGroups.flatMap((g) => g.metrics);
  const { series, loading } = useMetrics(nasId, allMetrics, range);
  const { devices, topProcesses, loading: diskLoading, dataAge } = useDiskIO(nasId, range);
  const latestIowait = useMemo(() => {
    const ioSeries = series.find((item) => item.type === "cpu_iowait_pct");
    const last = ioSeries?.data.at(-1);
    return last ? { value: last.value, recordedAt: last.recorded_at } : null;
  }, [series]);

  const diskChartData = aggregateDevicePoints(devices);

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
          <section className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-critical/20 bg-critical/5 p-4">
              <div className="text-sm font-semibold text-critical">Current CPU iowait</div>
              <div className="mt-2 text-2xl font-bold">
                {latestIowait ? `${latestIowait.value.toFixed(2)}%` : "—"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {latestIowait ? `Last sample ${formatTime(new Date(latestIowait.recordedAt).getTime())}` : "No cpu_iowait_pct samples yet"}
              </div>
            </div>
          </section>

          {metricGroups.map((group) => {
            const groupSeries = series.filter((s) =>
              group.metrics.includes(s.type)
            );

            if (groupSeries.length === 0) return null;

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

          {/* Disk I/O section */}
          <section>
            <h2 className="mb-3 text-lg font-semibold">Disk I/O</h2>

            {diskLoading ? (
              <div className="text-sm text-muted-foreground">Loading disk I/O...</div>
            ) : (
              <div className="space-y-4">
                {/* Throughput chart */}
                {diskChartData.length > 0 ? (
                  <div className="rounded-lg border border-border bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-3">
                      Total throughput across all devices
                      {devices.length > 0 && (
                        <span className="ml-1">
                          ({devices.map((d) => d.volume_path ? `${d.device} (${d.volume_path})` : d.device).join(", ")})
                        </span>
                      )}
                    </p>
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={diskChartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 11, fill: "#737373" }}
                          tickFormatter={formatTime}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: "#737373" }}
                          tickFormatter={(v) => formatBytes(v) + "/s"}
                          width={70}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#141414",
                            border: "1px solid #262626",
                            borderRadius: "6px",
                            fontSize: 12,
                          }}
                          formatter={(value: number, name: string) => [
                            formatBytes(value) + "/s",
                            name === "read_bps" ? "Read" : "Write",
                          ]}
                          labelFormatter={(ts) => new Date(ts).toLocaleTimeString()}
                        />
                        <Line
                          type="monotone"
                          dataKey="read_bps"
                          stroke="#06b6d4"
                          strokeWidth={2}
                          dot={false}
                          name="Read"
                        />
                        <Line
                          type="monotone"
                          dataKey="write_bps"
                          stroke="#f59e0b"
                          strokeWidth={2}
                          dot={false}
                          name="Write"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                    No disk I/O data for this period.
                    {(range === "7d" || range === "30d") && (
                      <span className="block mt-1 text-xs">Disk stats are retained for 24 hours — try 1h or 24h.</span>
                    )}
                  </div>
                )}

                {/* Top 10 processes by I/O */}
                <div className="rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <h3 className="text-sm font-semibold">Top Processes by Disk I/O</h3>
                    {dataAge && (
                      <span className="text-xs text-muted-foreground">
                        snapshot {formatSnapshotAge(dataAge)}
                      </span>
                    )}
                  </div>

                  {topProcesses.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">
                      No process I/O data available.
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs text-muted-foreground">
                          <th className="text-left px-4 py-2 font-medium">Process</th>
                          <th className="text-left px-4 py-2 font-medium">User</th>
                          <th className="text-right px-4 py-2 font-medium">Read</th>
                          <th className="text-right px-4 py-2 font-medium">Write</th>
                          <th className="text-right px-4 py-2 font-medium">Total I/O</th>
                          <th className="text-right px-4 py-2 font-medium">CPU</th>
                          <th className="text-right px-4 py-2 font-medium">Memory</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topProcesses.map((p, i) => {
                          const totalIO = p.read_bps + p.write_bps;
                          const maxIO = (topProcesses[0].read_bps + topProcesses[0].write_bps) || 1;
                          const barWidth = Math.max(2, Math.round((totalIO / maxIO) * 100));
                          return (
                            <tr key={`${p.pid}-${i}`} className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors">
                              <td className="px-4 py-2">
                                <div className="font-mono text-xs font-medium">{p.name}</div>
                                <div className="text-xs text-muted-foreground">PID {p.pid}</div>
                                {/* I/O bar */}
                                <div className="mt-1 h-1 rounded bg-muted overflow-hidden w-32">
                                  <div
                                    className="h-full rounded bg-primary/60"
                                    style={{ width: `${barWidth}%` }}
                                  />
                                </div>
                              </td>
                              <td className="px-4 py-2 text-xs text-muted-foreground">
                                {p.username ?? "—"}
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs text-cyan-400">
                                {formatBytes(p.read_bps)}/s
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs text-amber-400">
                                {formatBytes(p.write_bps)}/s
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs">
                                {formatBytes(totalIO)}/s
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs">
                                {p.cpu_pct.toFixed(1)}%
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs">
                                {formatBytes(p.mem_rss_kb * 1024)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            )}
          </section>
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

function formatSnapshotAge(capturedAt: string): string {
  const seconds = Math.floor((Date.now() - new Date(capturedAt).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function parseRange(range: string): number {
  switch (range) {
    case "1h": return 60 * 60 * 1000;
    case "6h": return 6 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "7d": return 7 * 24 * 60 * 60 * 1000;
    case "30d": return 30 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
