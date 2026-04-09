"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { Container, Play, Square, RotateCw } from "lucide-react";

interface ContainerData {
  container_id: string;
  container_name: string;
  image: string;
  status: string;
  cpu_percent: number;
  memory_bytes: number;
  memory_limit_bytes: number;
  uptime_seconds: number;
  recorded_at: string;
  nas_name: string;
  io_read_bps?: number;
  io_write_bps?: number;
}

export default function DockerPage() {
  const [containers, setContainers] = useState<ContainerData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      const supabase = createClient();
      const since30m = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const [statusResult, ioResult] = await Promise.all([
        supabase
          .from("smon_container_status")
          .select("*, smon_nas_units!inner(name)")
          .order("recorded_at", { ascending: false })
          .limit(50),
        supabase
          .from("smon_container_io")
          .select("nas_id, container_name, read_bps, write_bps, captured_at")
          .gte("captured_at", since30m)
          .order("captured_at", { ascending: false })
          .limit(200),
      ]);

      if (!statusResult.error && statusResult.data) {
        // Build latest I/O map: key = nas_id + container_name
        const ioMap = new Map<string, { read_bps: number; write_bps: number }>();
        for (const row of ioResult.data ?? []) {
          const key = `${row.nas_id}-${row.container_name}`;
          if (!ioMap.has(key)) {
            ioMap.set(key, { read_bps: row.read_bps ?? 0, write_bps: row.write_bps ?? 0 });
          }
        }

        // Dedupe by container_name (keep latest)
        const seen = new Set<string>();
        const deduped: ContainerData[] = [];
        for (const row of statusResult.data) {
          const key = `${row.nas_id}-${row.container_name}`;
          if (!seen.has(key)) {
            seen.add(key);
            const io = ioMap.get(key);
            deduped.push({
              ...row,
              nas_name: (row.smon_nas_units as any)?.name ?? "Unknown",
              io_read_bps: io?.read_bps,
              io_write_bps: io?.write_bps,
            });
          }
        }
        setContainers(deduped);
      }
      setLoading(false);
    }
    fetchData();
  }, []);

  const statusIcons: Record<string, typeof Play> = {
    running: Play,
    stopped: Square,
    restarting: RotateCw,
  };

  const statusColors: Record<string, string> = {
    running: "text-success",
    stopped: "text-muted-foreground",
    restarting: "text-warning",
    paused: "text-warning",
    exited: "text-critical",
  };

  function formatUptime(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Container className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Docker Containers</h1>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : containers.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
          No container data available yet.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {containers.map((ct) => {
            const Icon = statusIcons[ct.status] || Square;
            const memPct = ct.memory_limit_bytes > 0
              ? (ct.memory_bytes / ct.memory_limit_bytes) * 100
              : 0;

            return (
              <div key={`${ct.container_id}-${ct.recorded_at}`} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Icon className={cn("h-4 w-4", statusColors[ct.status])} />
                    <h3 className="font-semibold text-sm">{ct.container_name}</h3>
                  </div>
                  <span className={cn("text-xs font-medium", statusColors[ct.status])}>
                    {ct.status}
                  </span>
                </div>

                <p className="text-xs text-muted-foreground mb-3 truncate">{ct.image}</p>

                <div className="grid grid-cols-4 gap-2 text-center">
                  <div>
                    <p className="text-xs text-muted-foreground">Read I/O</p>
                    <p className="font-mono text-sm">
                      {ct.io_read_bps != null ? formatBytes(ct.io_read_bps) + "/s" : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Write I/O</p>
                    <p className="font-mono text-sm">
                      {ct.io_write_bps != null ? formatBytes(ct.io_write_bps) + "/s" : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Memory</p>
                    <p className={cn("font-mono text-sm", ct.memory_bytes === 0 ? "text-muted-foreground" : "")}>
                      {ct.memory_bytes > 0 ? formatBytes(ct.memory_bytes) : "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Uptime</p>
                    <p className="font-mono text-sm">{formatUptime(ct.uptime_seconds)}</p>
                  </div>
                </div>

                <p className="mt-2 text-xs text-muted-foreground">{ct.nas_name}</p>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
