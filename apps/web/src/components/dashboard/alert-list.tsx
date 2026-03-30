"use client";

import { cn, timeAgo } from "@/lib/utils";
import { AlertTriangle, AlertCircle, Info } from "lucide-react";
import type { Alert } from "@synology-monitor/shared";

interface AlertListProps {
  alerts: Alert[];
  limit?: number;
}

const severityConfig = {
  critical: {
    icon: AlertTriangle,
    color: "text-critical",
    bg: "bg-critical/10",
    border: "border-critical/30",
  },
  warning: {
    icon: AlertCircle,
    color: "text-warning",
    bg: "bg-warning/10",
    border: "border-warning/30",
  },
  info: {
    icon: Info,
    color: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/30",
  },
};

export function AlertList({ alerts, limit }: AlertListProps) {
  const displayed = limit ? alerts.slice(0, limit) : alerts;

  if (displayed.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Info className="h-8 w-8 mb-2" />
        <p className="text-sm">No active alerts</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {displayed.map((alert) => {
        const config =
          severityConfig[alert.severity as keyof typeof severityConfig] ||
          severityConfig.info;
        const Icon = config.icon;

        return (
          <div
            key={alert.id}
            className={cn(
              "flex items-start gap-3 rounded-md border p-3",
              config.border,
              config.bg
            )}
          >
            <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", config.color)} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium truncate">{alert.title}</p>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {timeAgo(alert.created_at)}
                </span>
              </div>
              {alert.message && (
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                  {alert.message}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
