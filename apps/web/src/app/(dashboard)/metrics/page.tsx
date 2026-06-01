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
  {
    title: "I/O Pressure",
    metrics: ["vm_pgpgout_ps", "dirty_writeback_kb"],
    colors: ["#f97316", "#a3a3a3"],
  },
  {
    title: "NFS",
    metrics: ["nfs_read_bps", "nfs_write_bps", "nfs_calls_ps"],
    colors: ["#06b6d4", "#f59e0b", "#8b5cf6"],
  },
];

// Colors for per-device util% lines
const DEVICE_COLORS = [
  "#3b82f6", "#ef4444", "#22c55e", "#f59e0b",
  "#8b5cf6", "#06b6d4", "#ec4899", "#84cc16",
];

interface DiskIOPoint {
  time: number;
  read_bps: number;
  write_bps: number;
  util_pct: number;
  await_ms: number;
  queue_depth: number;
}

interface DiskIODevice {
  device: string;
  volume_path: string | null;
  points: DiskIOPoint[];
}

interface DeviceHealth {
  device: string;
  volume_path: string | null;
  util_pct: number;
  await_ms: number;
  queue_depth: number;
  read_bps: number;
  write_bps: number;
  reads_ps: number;
  writes_ps: number;
}

interface TopProcess {
  pid: number;
  name: string;
  username: string | null;
  state: string | null;
  read_bps: number;
  write_bps: number;
  cpu_pct: number;
  mem_rss_kb: number;
}

interface ContainerIORow {
  container_id: string;
  container_name: string;
  read_bps: number;
  write_bps: number;
  read_ops: number;
  write_ops: number;
}

function useDiskIO(nasId: string | null, range: (typeof ranges)[number]) {
  const [devices, setDevices] = useState<DiskIODevice[]>([]);
  const [deviceHealth, setDeviceHealth] = useState<DeviceHealth[]>([]);
  const [topByIO, setTopByIO] = useState<TopProcess[]>([]);
  const [topByCPU, setTopByCPU] = useState<TopProcess[]>([]);
  const [loading, setLoading] = useState(true);
  const [dataAge, setDataAge] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!nasId) return;
    setLoading(true);

    const supabase = createClient();
    const from = new Date(Date.now() - parseRange(range)).toISOString();

    // Fetch disk I/O stats with saturation metrics
    const { data: ioRows } = await supabase
      .from("disk_io_stats")
      .select("captured_at, device, volume_path, read_bps, write_bps, util_pct, await_ms, queue_depth, reads_ps, writes_ps")
      .eq("nas_id", nasId)
      .gte("captured_at", from)
      .order("captured_at", { ascending: true })
      .limit(2000);

    const deviceMap = new Map<string, DiskIODevice>();
    const latestPerDevice = new Map<string, DeviceHealth>();

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
        util_pct: row.util_pct ?? 0,
        await_ms: row.await_ms ?? 0,
        queue_depth: row.queue_depth ?? 0,
      });
      // Rows are asc by time so the last write for each device is the latest
      latestPerDevice.set(row.device, {
        device: row.device,
        volume_path: row.volume_path,
        util_pct: row.util_pct ?? 0,
        await_ms: row.await_ms ?? 0,
        queue_depth: row.queue_depth ?? 0,
        read_bps: row.read_bps ?? 0,
        write_bps: row.write_bps ?? 0,
        reads_ps: row.reads_ps ?? 0,
        writes_ps: row.writes_ps ?? 0,
      });
    }

    setDevices(Array.from(deviceMap.values()));
    setDeviceHealth(
      Array.from(latestPerDevice.values()).sort((a, b) => b.util_pct - a.util_pct)
    );

    // Fetch process snapshot
    const { data: latestSnap } = await supabase
      .from("process_snapshots")
      .select("snapshot_grp, captured_at")
      .eq("nas_id", nasId)
      .order("captured_at", { ascending: false })
      .limit(1)
      .single();

    if (latestSnap) {
      setDataAge(latestSnap.captured_at);

      const { data: procRows } = await supabase
        .from("process_snapshots")
        .select("pid, name, username, state, read_bps, write_bps, cpu_pct, mem_rss_kb")
        .eq("nas_id", nasId)
        .eq("snapshot_grp", latestSnap.snapshot_grp)
        .order("cpu_pct", { ascending: false })
        .limit(100);

      const all = procRows ?? [];

      setTopByIO(
        [...all]
          .filter((p) => p.read_bps > 0 || p.write_bps > 0)
          .sort((a, b) => b.read_bps + b.write_bps - (a.read_bps + a.write_bps))
          .slice(0, 10)
      );
      setTopByCPU([...all].sort((a, b) => b.cpu_pct - a.cpu_pct).slice(0, 10));
    } else {
      setTopByIO([]);
      setTopByCPU([]);
    }

    setLoading(false);
  }, [nasId, range]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30000);
    return () => clearInterval(id);
  }, [fetch]);

  return { devices, deviceHealth, topByIO, topByCPU, loading, dataAge };
}

function useContainerIO(nasId: string | null) {
  const [containers, setContainers] = useState<ContainerIORow[]>([]);
  const [dataAge, setDataAge] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!nasId) return;
    const supabase = createClient();
    const from = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const { data: rows } = await supabase
      .from("container_io")
      .select("container_id, container_name, read_bps, write_bps, read_ops, write_ops, captured_at")
      .eq("nas_id", nasId)
      .gte("captured_at", from)
      .order("captured_at", { ascending: false })
      .limit(200);

    const seen = new Map<string, ContainerIORow & { captured_at: string }>();
    for (const row of rows ?? []) {
      if (!seen.has(row.container_id)) seen.set(row.container_id, row);
    }

    if (rows?.[0]) setDataAge(rows[0].captured_at);

    setContainers(
      Array.from(seen.values())
        .filter((c) => c.read_bps > 0 || c.write_bps > 0)
        .sort((a, b) => b.read_bps + b.write_bps - (a.read_bps + a.write_bps))
        .slice(0, 10)
    );
  }, [nasId]);

  useEffect(() => {
    fetch();
    const id = setInterval(fetch, 30000);
    return () => clearInterval(id);
  }, [fetch]);

  return { containers, dataAge };
}

function aggregateDevicePoints(devices: DiskIODevice[]): { time: number; read_bps: number; write_bps: number }[] {
  const byTime = new Map<number, { time: number; read_bps: number; write_bps: number }>();

  for (const dev of devices) {
    for (const pt of dev.points) {
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

// Merge per-device util_pct into a single time series for a multi-line chart.
function mergeDeviceUtil(devices: DiskIODevice[]): Record<string, number>[] {
  const byTime = new Map<number, Record<string, number>>();

  for (const dev of devices) {
    for (const pt of dev.points) {
      const bucket = Math.round(pt.time / 15000) * 15000;
      const existing = byTime.get(bucket) ?? { time: bucket };
      existing[dev.device] = pt.util_pct;
      byTime.set(bucket, existing);
    }
  }

  return Array.from(byTime.values()).sort((a, b) => (a.time as number) - (b.time as number));
}

export default function MetricsPage() {
  const { units } = useNasUnits();
  const [selectedNas, setSelectedNas] = useState<string | null>(null);
  const [range, setRange] = useState<(typeof ranges)[number]>("24h");
  const [procSort, setProcSort] = useState<"io" | "cpu">("io");

  const nasId = selectedNas ?? units[0]?.id ?? null;
  const allMetrics = metricGroups.flatMap((g) => g.metrics);
  const { series, loading } = useMetrics(nasId, allMetrics, range);
  const { devices, deviceHealth, topByIO, topByCPU, loading: diskLoading, dataAge } = useDiskIO(nasId, range);
  const { containers: containerIO, dataAge: containerAge } = useContainerIO(nasId);

  const latestIowait = useMemo(() => {
    const ioSeries = series.find((item) => item.type === "cpu_iowait_pct");
    const last = ioSeries?.data.at(-1);
    return last ? { value: last.value, recordedAt: last.recorded_at } : null;
  }, [series]);

  const topDevice = deviceHealth[0] ?? null;

  const diskChartData = aggregateDevicePoints(devices);
  const deviceUtilData = useMemo(() => mergeDeviceUtil(devices), [devices]);

  const topProcesses = procSort === "io" ? topByIO : topByCPU;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Metrics</h1>

        <div className="flex items-center gap-4">
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
          {/* Summary cards */}
          <section className="grid gap-4 md:grid-cols-3">
            <div className="rounded-lg border border-critical/20 bg-critical/5 p-4">
              <div className="text-sm font-semibold text-critical">Current CPU iowait</div>
              <div className="mt-2 text-2xl font-bold">
                {latestIowait ? `${latestIowait.value.toFixed(2)}%` : "—"}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {latestIowait
                  ? `Last sample ${formatTime(new Date(latestIowait.recordedAt).getTime())}`
                  : "No cpu_iowait_pct samples yet"}
              </div>
            </div>

            {topDevice && (
              <div
                className={cn(
                  "rounded-lg border p-4",
                  topDevice.util_pct >= 80
                    ? "border-critical/20 bg-critical/5"
                    : topDevice.util_pct >= 50
                    ? "border-warning/20 bg-warning/5"
                    : "border-border bg-card"
                )}
              >
                <div
                  className={cn(
                    "text-sm font-semibold",
                    topDevice.util_pct >= 80
                      ? "text-critical"
                      : topDevice.util_pct >= 50
                      ? "text-warning"
                      : "text-muted-foreground"
                  )}
                >
                  Most saturated device
                </div>
                <div className="mt-2 text-2xl font-bold font-mono">
                  {topDevice.util_pct.toFixed(1)}%
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {topDevice.device}
                  {topDevice.volume_path ? ` (${topDevice.volume_path})` : ""} — {topDevice.await_ms.toFixed(1)} ms avg await
                </div>
              </div>
            )}

            {topDevice && (
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="text-sm font-semibold text-muted-foreground">Disk queue depth</div>
                <div className="mt-2 text-2xl font-bold font-mono">
                  {topDevice.queue_depth.toFixed(2)}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {topDevice.device} — {topDevice.reads_ps.toFixed(0)} r/s · {topDevice.writes_ps.toFixed(0)} w/s
                </div>
              </div>
            )}
          </section>

          {/* Standard metric charts */}
          {metricGroups.map((group) => {
            const groupSeries = series.filter((s) => group.metrics.includes(s.type));
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

          {/* Device Saturation — primary iowait diagnostic */}
          <section>
            <h2 className="mb-3 text-lg font-semibold">Device Saturation</h2>

            {diskLoading ? (
              <div className="text-sm text-muted-foreground">Loading device stats...</div>
            ) : deviceHealth.length === 0 ? (
              <div className="rounded-lg border border-border bg-card p-6 text-center text-sm text-muted-foreground">
                No device saturation data for this period.
              </div>
            ) : (
              <div className="space-y-4">
                {/* Per-device health table */}
                <div className="rounded-lg border border-border bg-card">
                  <div className="px-4 py-3 border-b border-border">
                    <p className="text-xs text-muted-foreground">
                      Util% ≥ 80% = device bottleneck (causes high iowait). Await = avg I/O latency ms.
                    </p>
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="text-left px-4 py-2 font-medium">Device</th>
                        <th className="text-right px-4 py-2 font-medium">Util %</th>
                        <th className="text-right px-4 py-2 font-medium">Await (ms)</th>
                        <th className="text-right px-4 py-2 font-medium">Queue depth</th>
                        <th className="text-right px-4 py-2 font-medium">Read IOPS</th>
                        <th className="text-right px-4 py-2 font-medium">Write IOPS</th>
                        <th className="text-right px-4 py-2 font-medium">Throughput</th>
                      </tr>
                    </thead>
                    <tbody>
                      {deviceHealth.map((dh) => (
                        <tr
                          key={dh.device}
                          className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                        >
                          <td className="px-4 py-2">
                            <div className="font-mono text-xs font-medium">{dh.device}</div>
                            {dh.volume_path && (
                              <div className="text-xs text-muted-foreground">{dh.volume_path}</div>
                            )}
                          </td>
                          <td className="px-4 py-2 text-right">
                            <span
                              className={cn(
                                "font-mono text-xs font-semibold",
                                dh.util_pct >= 80
                                  ? "text-critical"
                                  : dh.util_pct >= 50
                                  ? "text-warning"
                                  : "text-muted-foreground"
                              )}
                            >
                              {dh.util_pct.toFixed(1)}%
                            </span>
                            <div className="mt-1 h-1 rounded bg-muted overflow-hidden w-16 ml-auto">
                              <div
                                className={cn(
                                  "h-full rounded",
                                  dh.util_pct >= 80 ? "bg-critical" : dh.util_pct >= 50 ? "bg-warning" : "bg-primary/60"
                                )}
                                style={{ width: `${Math.min(dh.util_pct, 100)}%` }}
                              />
                            </div>
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {dh.await_ms.toFixed(1)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {dh.queue_depth.toFixed(2)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-cyan-400">
                            {dh.reads_ps.toFixed(0)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs text-amber-400">
                            {dh.writes_ps.toFixed(0)}
                          </td>
                          <td className="px-4 py-2 text-right font-mono text-xs">
                            {formatBytes(dh.read_bps + dh.write_bps)}/s
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Util% over time per device */}
                {deviceUtilData.length > 0 && (
                  <div className="rounded-lg border border-border bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-3">
                      Device utilisation % over time — a device near 100% is saturated and will stall the kernel I/O queue
                    </p>
                    <ResponsiveContainer width="100%" height={250}>
                      <LineChart data={deviceUtilData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#262626" />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 11, fill: "#737373" }}
                          tickFormatter={formatTime}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: "#737373" }}
                          domain={[0, 100]}
                          tickFormatter={(v) => `${v}%`}
                          width={45}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: "#141414",
                            border: "1px solid #262626",
                            borderRadius: "6px",
                            fontSize: 12,
                          }}
                          formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name]}
                          labelFormatter={(ts) =>
                            new Date(ts).toLocaleTimeString("en-US", {
                              timeZone: "America/New_York",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            }) + " ET"
                          }
                        />
                        {devices.map((dev, i) => (
                          <Line
                            key={dev.device}
                            type="monotone"
                            dataKey={dev.device}
                            stroke={DEVICE_COLORS[i % DEVICE_COLORS.length]}
                            strokeWidth={2}
                            dot={false}
                            name={dev.volume_path ? `${dev.device} (${dev.volume_path})` : dev.device}
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Disk I/O throughput */}
          <section>
            <h2 className="mb-3 text-lg font-semibold">Disk I/O</h2>

            {diskLoading ? (
              <div className="text-sm text-muted-foreground">Loading disk I/O...</div>
            ) : (
              <div className="space-y-4">
                {diskChartData.length > 0 ? (
                  <div className="rounded-lg border border-border bg-card p-4">
                    <p className="text-xs text-muted-foreground mb-3">
                      Total throughput across all devices
                      {devices.length > 0 && (
                        <span className="ml-1">
                          ({devices.map((d) => (d.volume_path ? `${d.device} (${d.volume_path})` : d.device)).join(", ")})
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
                          labelFormatter={(ts) =>
                            new Date(ts).toLocaleTimeString("en-US", {
                              timeZone: "America/New_York",
                              hour: "2-digit",
                              minute: "2-digit",
                              hour12: true,
                            }) + " ET"
                          }
                        />
                        <Line type="monotone" dataKey="read_bps" stroke="#06b6d4" strokeWidth={2} dot={false} name="Read" />
                        <Line type="monotone" dataKey="write_bps" stroke="#f59e0b" strokeWidth={2} dot={false} name="Write" />
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

                {/* Top processes by I/O or CPU */}
                <div className="rounded-lg border border-border bg-card">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                    <div className="flex items-center gap-3">
                      <h3 className="text-sm font-semibold">Top Processes</h3>
                      <div className="flex rounded border border-border text-xs">
                        <button
                          onClick={() => setProcSort("io")}
                          className={cn(
                            "px-2 py-1 transition-colors",
                            procSort === "io"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          by I/O
                        </button>
                        <button
                          onClick={() => setProcSort("cpu")}
                          className={cn(
                            "px-2 py-1 transition-colors",
                            procSort === "cpu"
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          by CPU
                        </button>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        D = uninterruptible sleep (waiting for I/O)
                      </span>
                    </div>
                    {dataAge && (
                      <span className="text-xs text-muted-foreground">
                        snapshot {formatSnapshotAge(dataAge)}
                      </span>
                    )}
                  </div>

                  {topProcesses.length === 0 ? (
                    <div className="p-6 text-center text-sm text-muted-foreground">
                      No process data available.
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border text-xs text-muted-foreground">
                          <th className="text-left px-4 py-2 font-medium">Process</th>
                          <th className="text-left px-4 py-2 font-medium">User</th>
                          <th className="text-right px-4 py-2 font-medium">CPU</th>
                          <th className="text-right px-4 py-2 font-medium">Read</th>
                          <th className="text-right px-4 py-2 font-medium">Write</th>
                          <th className="text-right px-4 py-2 font-medium">Total I/O</th>
                          <th className="text-right px-4 py-2 font-medium">Memory</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topProcesses.map((p, i) => {
                          const totalIO = p.read_bps + p.write_bps;
                          const isDState = p.state === "D";
                          return (
                            <tr
                              key={`${p.pid}-${i}`}
                              className={cn(
                                "border-b border-border last:border-0 transition-colors",
                                isDState ? "bg-warning/5 hover:bg-warning/10" : "hover:bg-muted/30"
                              )}
                            >
                              <td className="px-4 py-2">
                                <div className="flex items-center gap-1.5">
                                  <span className="font-mono text-xs font-medium">{p.name}</span>
                                  {isDState && (
                                    <span
                                      className="rounded px-1 py-0.5 text-[10px] font-bold bg-warning/20 text-warning"
                                      title="Uninterruptible sleep — this process is blocked waiting for I/O"
                                    >
                                      D
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-muted-foreground">PID {p.pid}</div>
                              </td>
                              <td className="px-4 py-2 text-xs text-muted-foreground">
                                {p.username ?? "—"}
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-xs">
                                {p.cpu_pct.toFixed(1)}%
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

          {/* Container I/O */}
          {(containerIO.length > 0 || containerAge) && (
            <section>
              <h2 className="mb-3 text-lg font-semibold">Container I/O</h2>
              <div className="rounded-lg border border-border bg-card">
                <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                  <h3 className="text-sm font-semibold">Top Containers by Disk I/O</h3>
                  {containerAge && (
                    <span className="text-xs text-muted-foreground">
                      {formatSnapshotAge(containerAge)}
                    </span>
                  )}
                </div>

                {containerIO.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    No active container I/O in the last 5 minutes.
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="text-left px-4 py-2 font-medium">Container</th>
                        <th className="text-right px-4 py-2 font-medium">Read</th>
                        <th className="text-right px-4 py-2 font-medium">Write</th>
                        <th className="text-right px-4 py-2 font-medium">Total I/O</th>
                        <th className="text-right px-4 py-2 font-medium">Read OPS</th>
                        <th className="text-right px-4 py-2 font-medium">Write OPS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {containerIO.map((c, i) => {
                        const totalIO = c.read_bps + c.write_bps;
                        const maxIO = (containerIO[0].read_bps + containerIO[0].write_bps) || 1;
                        const barWidth = Math.max(2, Math.round((totalIO / maxIO) * 100));
                        return (
                          <tr
                            key={c.container_id}
                            className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors"
                          >
                            <td className="px-4 py-2">
                              <div className="font-mono text-xs font-medium">{c.container_name}</div>
                              <div className="mt-1 h-1 rounded bg-muted overflow-hidden w-32">
                                <div
                                  className="h-full rounded bg-primary/60"
                                  style={{ width: `${barWidth}%` }}
                                />
                              </div>
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-xs text-cyan-400">
                              {formatBytes(c.read_bps)}/s
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-xs text-amber-400">
                              {formatBytes(c.write_bps)}/s
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-xs">
                              {formatBytes(totalIO)}/s
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-xs text-cyan-400">
                              {c.read_ops}/s
                            </td>
                            <td className="px-4 py-2 text-right font-mono text-xs text-amber-400">
                              {c.write_ops}/s
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </section>
          )}
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
  return new Date(ts).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
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
