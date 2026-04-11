"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatBytes, formatPercent, cn } from "@/lib/utils";
import { HardDrive, Thermometer } from "lucide-react";

interface StorageData {
  volume_id: string;
  volume_path: string;
  total_bytes: number;
  used_bytes: number;
  status: string;
  raid_type: string;
  disks: {
    id: string;
    name: string;
    model: string;
    temperature_c: number;
    smart_status: string;
  }[];
  nas_name: string;
}

export default function StoragePage() {
  const [volumes, setVolumes] = useState<StorageData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      const supabase = createClient();

      // Get latest snapshot per volume
      const { data, error } = await supabase
        .from("storage_snapshots")
        .select("*, nas_units!inner(name)")
        .order("recorded_at", { ascending: false })
        .limit(20);

      if (!error && data) {
        // Dedupe by volume_id (keep latest)
        const seen = new Set<string>();
        const deduped: StorageData[] = [];
        for (const row of data) {
          if (!seen.has(row.volume_id)) {
            seen.add(row.volume_id);
            deduped.push({
              ...row,
              nas_name: (row.nas_units as any)?.name ?? "Unknown",
            });
          }
        }
        setVolumes(deduped);
      }
      setLoading(false);
    }
    fetch();
  }, []);

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading storage data...</div>;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Storage</h1>

      {volumes.length === 0 ? (
        <div className="rounded-lg border border-border p-8 text-center text-muted-foreground">
          No storage data available yet. Waiting for agent data.
        </div>
      ) : (
        <div className="space-y-4">
          {volumes.map((vol) => {
            const usedPct = (vol.used_bytes / vol.total_bytes) * 100;
            const isCritical = usedPct >= 90;
            const isWarning = usedPct >= 70;

            return (
              <div key={vol.volume_id} className="rounded-lg border border-border bg-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <HardDrive className="h-5 w-5 text-muted-foreground" />
                    <h3 className="font-semibold">
                      {vol.volume_path} <span className="text-muted-foreground font-normal">({vol.nas_name})</span>
                    </h3>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-muted-foreground">{vol.raid_type}</span>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-xs font-medium",
                        vol.status === "normal"
                          ? "bg-success/10 text-success"
                          : vol.status === "degraded"
                          ? "bg-warning/10 text-warning"
                          : "bg-destructive/10 text-destructive"
                      )}
                    >
                      {vol.status}
                    </span>
                  </div>
                </div>

                {/* Usage bar */}
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {formatBytes(vol.used_bytes)} / {formatBytes(vol.total_bytes)}
                  </span>
                  <span
                    className={cn(
                      "font-mono font-semibold",
                      isCritical ? "text-critical" : isWarning ? "text-warning" : "text-success"
                    )}
                  >
                    {formatPercent(usedPct)}
                  </span>
                </div>
                <div className="h-3 w-full rounded-full bg-muted">
                  <div
                    className={cn(
                      "h-full rounded-full transition-all",
                      isCritical ? "bg-critical" : isWarning ? "bg-warning" : "bg-success"
                    )}
                    style={{ width: `${usedPct}%` }}
                  />
                </div>

                {/* Disk details */}
                {vol.disks && vol.disks.length > 0 && (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    {vol.disks.map((disk) => (
                      <div
                        key={disk.id}
                        className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm"
                      >
                        <div>
                          <span className="font-medium">{disk.name}</span>
                          <span className="ml-2 text-muted-foreground">{disk.model}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="flex items-center gap-1">
                            <Thermometer className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className={cn(
                              "font-mono",
                              disk.temperature_c > 50 ? "text-critical" :
                              disk.temperature_c > 40 ? "text-warning" : "text-muted-foreground"
                            )}>
                              {disk.temperature_c}C
                            </span>
                          </div>
                          <span
                            className={cn(
                              "text-xs",
                              disk.smart_status === "healthy"
                                ? "text-success"
                                : "text-warning"
                            )}
                          >
                            {disk.smart_status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
