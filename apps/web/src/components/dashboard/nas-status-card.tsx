"use client";

import { cn, timeAgo } from "@/lib/utils";
import { Server, Wifi, WifiOff } from "lucide-react";
import type { NasUnit } from "@synology-monitor/shared";

interface NasStatusCardProps {
  unit: NasUnit;
}

export function NasStatusCard({ unit }: NasStatusCardProps) {
  const isOnline = unit.status === "online";
  const isDegraded = unit.status === "degraded";

  return (
    <div
      className={cn(
        "rounded-lg border p-4 transition-colors",
        isOnline
          ? "border-success/30 bg-success/5"
          : isDegraded
          ? "border-warning/30 bg-warning/5"
          : "border-destructive/30 bg-destructive/5"
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <Server className="h-8 w-8 text-muted-foreground" />
          <div>
            <h3 className="font-semibold">{unit.name}</h3>
            <p className="text-sm text-muted-foreground">
              {unit.model} &middot; DSM {unit.dsm_version || "unknown"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {isOnline ? (
            <Wifi className="h-4 w-4 text-success" />
          ) : (
            <WifiOff className="h-4 w-4 text-destructive" />
          )}
          <span
            className={cn(
              "text-xs font-medium",
              isOnline
                ? "text-success"
                : isDegraded
                ? "text-warning"
                : "text-destructive"
            )}
          >
            {unit.status.toUpperCase()}
          </span>
        </div>
      </div>

      {unit.last_seen && (
        <p className="mt-2 text-xs text-muted-foreground">
          Last seen: {timeAgo(unit.last_seen)}
        </p>
      )}
    </div>
  );
}
