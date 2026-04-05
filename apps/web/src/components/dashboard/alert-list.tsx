"use client";

import { useState, useEffect, useCallback } from "react";
import { cn, timeAgo, formatET } from "@/lib/utils";
import { AlertTriangle, AlertCircle, Info, ExternalLink, Wrench, Loader2, XCircle, FolderSync, User, Clock } from "lucide-react";
import type { Alert } from "@synology-monitor/shared";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

interface AlertListProps {
  alerts: Alert[];
  limit?: number;
  onAlertClick?: (alert: Alert) => void;
}

// AI-analyzed problem type
interface AnalyzedProblem {
  id: string;
  slug: string;
  title: string;
  explanation: string;
  severity: "critical" | "warning" | "info";
  affected_nas: string[];
  affected_shares: string[];
  affected_users: string[];
  affected_files: { path: string; detail: string }[];
  raw_event_count: number;
  raw_event_ids: string[];
  technical_diagnosis: string;
  first_seen: string;
  last_seen: string;
  status: "open" | "investigating" | "resolved";
  resolution?: string;
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

export function AlertList({ alerts, limit, onAlertClick }: AlertListProps) {
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
            onClick={() => onAlertClick?.(alert)}
            className={cn(
              "flex items-start gap-3 rounded-md border p-3 cursor-pointer",
              config.border,
              config.bg,
              "hover:opacity-80 transition-opacity"
            )}
          >
            <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", config.color)} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium truncate">{alert.title}</p>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {timeAgo(alert.created_at)}
                  </span>
                  <ExternalLink className="h-3 w-3 text-muted-foreground" />
                </div>
              </div>
              {alert.message && (
                <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                  {alert.message}
                </p>
              )}
              {onAlertClick && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-[10px] text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                    Click to view details →
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
      {limit && alerts.length > limit && (
        <Link
          href="/sync-triage"
          className="flex items-center justify-center gap-2 py-2 text-sm text-primary hover:underline"
        >
          View sync events in Sync Triage
          <ExternalLink className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

// Alert Detail Modal Component
interface AlertDetailModalProps {
  alert: Alert | null;
  onClose: () => void;
}

export function AlertDetailModal({ alert, onClose }: AlertDetailModalProps) {
  if (!alert) return null;

  const config =
    severityConfig[alert.severity as keyof typeof severityConfig] ||
    severityConfig.info;
  const Icon = config.icon;

  return (
    <div 
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div 
        className="bg-card rounded-xl border border-border max-w-2xl w-full max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3">
              <div className={cn("rounded-lg p-2", config.bg)}>
                <Icon className={cn("h-5 w-5", config.color)} />
              </div>
              <div>
                <h2 className="text-xl font-bold">{alert.title}</h2>
                <div className="flex items-center gap-2 mt-2">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-xs font-medium",
                    alert.severity === "critical" ? "bg-critical/20 text-critical" :
                    alert.severity === "warning" ? "bg-warning/20 text-warning" :
                    "bg-primary/20 text-primary"
                  )}>
                    {alert.severity}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(alert.created_at).toLocaleString()}
                  </span>
                </div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-2xl text-muted-foreground hover:text-foreground leading-none"
            >
              ×
            </button>
          </div>

          {alert.message && (
            <div className="rounded-md bg-muted/50 p-4">
              <p className="text-sm">{alert.message}</p>
            </div>
          )}

          {alert.details && Object.keys(alert.details).length > 0 && (
            <div className="rounded-md bg-muted p-4">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                Details
              </h4>
              <pre className="text-xs overflow-auto">
                {JSON.stringify(alert.details, null, 2)}
              </pre>
            </div>
          )}

          <div className="flex gap-3 pt-4 border-t">
            <Link
              href={`/assistant?alert_id=${alert.id}&title=${encodeURIComponent(alert.title)}&message=${encodeURIComponent(alert.message || "")}&severity=${alert.severity}`}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              <Wrench className="h-4 w-4" />
              Analyze with Copilot
            </Link>
            <Link
              href="/sync-triage"
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors"
            >
              View in Sync Triage
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
