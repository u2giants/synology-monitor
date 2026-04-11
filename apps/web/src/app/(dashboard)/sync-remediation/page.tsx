"use client";

import { useCallback, useEffect, useState } from "react";
import { Wrench, CheckCircle, Clock, AlertTriangle, RefreshCw, FileText, ArrowRightLeft } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";

interface SyncRemediation {
  id: string;
  nas_id: string;
  file_path: string;
  issue_type: string;
  action_taken: string;
  status: string;
  details: Record<string, unknown>;
  created_at: string;
  completed_at: string | null;
  resolved_by?: string;
}

interface NasUnit {
  id: string;
  name: string;
  hostname: string;
}

const issueTypeLabels: Record<string, { label: string; color: string }> = {
  sync_conflict: { label: "Sync Conflict", color: "bg-amber-500/20 text-amber-700 dark:text-amber-300" },
  sync_failure: { label: "Sync Failure", color: "bg-critical/20 text-critical" },
  invalid_chars: { label: "Invalid Characters", color: "bg-purple-500/20 text-purple-700 dark:text-purple-300" },
  permission_error: { label: "Permission Error", color: "bg-red-500/20 text-red-700 dark:text-red-300" },
  path_not_found: { label: "Path Not Found", color: "bg-gray-500/20 text-gray-700 dark:text-gray-300" },
  unknown: { label: "Unknown Issue", color: "bg-muted text-muted-foreground" },
};

const statusConfig: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending: { label: "Pending", color: "bg-amber-500/20 text-amber-700 dark:text-amber-300", icon: Clock },
  in_progress: { label: "In Progress", color: "bg-blue-500/20 text-blue-700 dark:text-blue-300", icon: RefreshCw },
  completed: { label: "Completed", color: "bg-success/20 text-success", icon: CheckCircle },
  failed: { label: "Failed", color: "bg-critical/20 text-critical", icon: AlertTriangle },
};

export default function SyncRemediationPage() {
  const [remediations, setRemediations] = useState<SyncRemediation[]>([]);
  const [nasUnits, setNasUnits] = useState<NasUnit[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedRemediation, setSelectedRemediation] = useState<SyncRemediation | null>(null);

  const fetchData = useCallback(async () => {
    const supabase = createClient();
    
    // Fetch NAS units for display
    const nasResult = await supabase.from("nas_units").select("id, name, hostname");
    if (!nasResult.error && nasResult.data) {
      setNasUnits(nasResult.data);
    }

    // Fetch remediations
    let query = supabase
      .from("sync_remediations")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);

    if (statusFilter !== "all") {
      query = query.eq("status", statusFilter);
    }

    const result = await query;
    if (!result.error && result.data) {
      setRemediations(result.data as SyncRemediation[]);
    }

    setLoading(false);
  }, [statusFilter]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const nasUnitMap = new Map(nasUnits.map((u) => [u.id, u.name]));

  const stats = {
    total: remediations.length,
    pending: remediations.filter((r) => r.status === "pending").length,
    inProgress: remediations.filter((r) => r.status === "in_progress").length,
    completed: remediations.filter((r) => r.status === "completed").length,
    failed: remediations.filter((r) => r.status === "failed").length,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Sync Remediation</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Track and manage ShareSync fix operations including conflict resolution, file renaming, and character sanitization.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            {stats.total} total records
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          icon={<Wrench className="h-5 w-5" />}
          label="Pending"
          value={stats.pending}
          tone="warning"
        />
        <StatCard
          icon={<RefreshCw className="h-5 w-5" />}
          label="In Progress"
          value={stats.inProgress}
          tone="info"
        />
        <StatCard
          icon={<CheckCircle className="h-5 w-5" />}
          label="Completed"
          value={stats.completed}
          tone="success"
        />
        <StatCard
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Failed"
          value={stats.failed}
          tone="critical"
        />
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          <option value="all">All Statuses</option>
          <option value="pending">Pending</option>
          <option value="in_progress">In Progress</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>

        <button
          onClick={() => fetchData()}
          className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm hover:bg-muted transition-colors"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Remediation Table */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading remediations...</div>
      ) : remediations.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No sync remediations found. Use the Issue Agent to diagnose and fix ShareSync issues.
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Issue
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  File Path
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Action
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  NAS
                </th>
                <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Created
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {remediations.map((rem) => {
                const issueInfo = issueTypeLabels[rem.issue_type] || issueTypeLabels.unknown;
                const statusInfo = statusConfig[rem.status] || statusConfig.pending;
                const StatusIcon = statusInfo.icon;

                return (
                  <tr
                    key={rem.id}
                    onClick={() => setSelectedRemediation(rem)}
                    className="cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className={cn("rounded-full px-2.5 py-1 text-xs font-medium", issueInfo.color)}>
                        {issueInfo.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 max-w-xs">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="text-sm font-mono truncate" title={rem.file_path}>
                          {rem.file_path}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground capitalize">
                        {rem.action_taken.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", statusInfo.color)}>
                        <StatusIcon className="h-3 w-3" />
                        {statusInfo.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-muted-foreground">
                        {nasUnitMap.get(rem.nas_id) || rem.nas_id}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                      {timeAgo(rem.created_at)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Modal */}
      {selectedRemediation && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={() => setSelectedRemediation(null)}
        >
          <div
            className="bg-card rounded-xl border border-border max-w-2xl w-full max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold">Remediation Details</h2>
                  <p className="text-sm text-muted-foreground mt-1">
                    {timeAgo(selectedRemediation.created_at)} • {nasUnitMap.get(selectedRemediation.nas_id) || selectedRemediation.nas_id}
                  </p>
                </div>
                <button
                  onClick={() => setSelectedRemediation(null)}
                  className="text-2xl text-muted-foreground hover:text-foreground leading-none"
                >
                  ×
                </button>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Issue Type
                    </label>
                    <div className="mt-1">
                      <span className={cn(
                        "rounded-full px-2.5 py-1 text-xs font-medium",
                        issueTypeLabels[selectedRemediation.issue_type]?.color || issueTypeLabels.unknown.color
                      )}>
                        {issueTypeLabels[selectedRemediation.issue_type]?.label || "Unknown"}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Status
                    </label>
                    <div className="mt-1">
                      {(() => {
                        const info = statusConfig[selectedRemediation.status] || statusConfig.pending;
                        const Icon = info.icon;
                        return (
                          <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", info.color)}>
                            <Icon className="h-3 w-3" />
                            {info.label}
                          </span>
                        );
                      })()}
                    </div>
                  </div>

                  <div>
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Action Taken
                    </label>
                    <p className="mt-1 text-sm capitalize">
                      {selectedRemediation.action_taken.replace(/_/g, " ")}
                    </p>
                  </div>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      File Path
                    </label>
                    <p className="mt-1 text-sm font-mono break-all">
                      {selectedRemediation.file_path}
                    </p>
                  </div>

                  {selectedRemediation.completed_at && (
                    <div>
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Completed At
                      </label>
                      <p className="mt-1 text-sm">
                        {new Date(selectedRemediation.completed_at).toLocaleString()}
                      </p>
                    </div>
                  )}

                  {selectedRemediation.resolved_by && (
                    <div>
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Resolved By
                      </label>
                      <p className="mt-1 text-sm">
                        {selectedRemediation.resolved_by}
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {selectedRemediation.details && Object.keys(selectedRemediation.details).length > 0 && (
                <div className="rounded-md bg-muted p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Additional Details
                  </h4>
                  <pre className="text-xs overflow-auto">
                    {JSON.stringify(selectedRemediation.details, null, 2)}
                  </pre>
                </div>
              )}

              <div className="flex gap-3 pt-4 border-t">
                <a
                  href="/assistant"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <Wrench className="h-4 w-4" />
                  Create Similar Fix
                </a>
                <a
                  href="/sync-triage"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors"
                >
                  View in Triage
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  tone: "default" | "warning" | "critical" | "success" | "info";
}) {
  const toneClasses = {
    default: "border-border bg-card",
    warning: "border-amber-500/30 bg-amber-500/5",
    critical: "border-critical/30 bg-critical/5",
    success: "border-success/30 bg-success/5",
    info: "border-blue-500/30 bg-blue-500/5",
  };

  const iconColors = {
    default: "text-muted-foreground",
    warning: "text-amber-500",
    critical: "text-critical",
    success: "text-success",
    info: "text-blue-500",
  };

  return (
    <div className={cn("rounded-xl border p-4", toneClasses[tone])}>
      <div className={cn("flex items-center gap-2", iconColors[tone])}>
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}
