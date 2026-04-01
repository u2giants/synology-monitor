"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, FolderSync, Search, ShieldAlert, UserRound, ExternalLink, Wrench } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";
import type { Alert } from "@synology-monitor/shared";

interface LogEntry {
  id: string;
  source: string;
  severity: string;
  message: string;
  logged_at: string;
  metadata: Record<string, unknown> | null;
}

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
}

const sourceOptions = [
  { value: "all", label: "All Sync Sources" },
  { value: "drive_sharesync", label: "ShareSync" },
  { value: "drive_server", label: "Drive Admin" },
];

const actionOptions = [
  { value: "all", label: "All Actions" },
  { value: "sync_failure", label: "Sync Failure" },
  { value: "sync_conflict", label: "Sync Conflict" },
  { value: "delete", label: "Delete" },
  { value: "move", label: "Move" },
  { value: "rename", label: "Rename" },
  { value: "create", label: "Create" },
];

function metaValue(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toneClass(source: string) {
  return source === "drive_server"
    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
    : "bg-sky-500/10 text-sky-700 dark:text-sky-300";
}

export default function SyncTriagePage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [syncAlerts, setSyncAlerts] = useState<Alert[]>([]);
  const [remediations, setRemediations] = useState<SyncRemediation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [action, setAction] = useState("all");
  const [userFilter, setUserFilter] = useState("");
  const [showAlerts, setShowAlerts] = useState(false);
  const [selectedAlert, setSelectedAlert] = useState<Alert | null>(null);

  const fetchData = useCallback(async () => {
    const supabase = createClient();
    
    // Fetch logs
    let logsQuery = supabase
      .from("smon_logs")
      .select("id, source, severity, message, logged_at, metadata, ingested_at")
      .in("source", ["drive_server", "drive_sharesync"])
      .order("ingested_at", { ascending: false })
      .limit(200);

    if (source !== "all") logsQuery = logsQuery.eq("source", source);

    const logsResult = await logsQuery;
    if (!logsResult.error && logsResult.data) {
      setLogs(logsResult.data);
    }

    // Fetch sync-related alerts (source='ai' or containing sync keywords)
    const alertsResult = await supabase
      .from("smon_alerts")
      .select("*")
      .eq("status", "active")
      .or("source.eq.ai,title.ilike.%sync%,title.ilike.%sharesync%,title.ilike.%conflict%,title.ilike.%error%")
      .order("created_at", { ascending: false })
      .limit(50);
    
    if (!alertsResult.error && alertsResult.data) {
      setSyncAlerts(alertsResult.data as Alert[]);
    }

    // Fetch sync remediations if table exists
    const remediationsResult = await supabase
      .from("smon_sync_remediations")
      .select("*")
      .in("status", ["pending", "in_progress"])
      .order("created_at", { ascending: false })
      .limit(50);
    
    if (!remediationsResult.error && remediationsResult.data) {
      setRemediations(remediationsResult.data as SyncRemediation[]);
    }

    setLoading(false);
  }, [source]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const actionValue = metaValue(log.metadata, "action");
      const userValue = metaValue(log.metadata, "user");
      const pathValue = metaValue(log.metadata, "path");
      const shareName = metaValue(log.metadata, "share_name");
      const component = metaValue(log.metadata, "component");

      if (action !== "all" && actionValue !== action) return false;
      if (userFilter && !userValue.toLowerCase().includes(userFilter.toLowerCase())) return false;
      if (!search) return true;

      return [
        log.message,
        actionValue,
        userValue,
        pathValue,
        shareName,
        component,
      ]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase());
    });
  }, [action, logs, search, userFilter]);

  const summary = useMemo(() => {
    return {
      incidents: filteredLogs.filter((log) =>
        ["sync_failure", "sync_conflict", "delete", "move", "rename"].includes(
          metaValue(log.metadata, "action")
        )
      ).length,
      sharesync: filteredLogs.filter((log) => log.source === "drive_sharesync").length,
      admin: filteredLogs.filter((log) => log.source === "drive_server").length,
      withUsers: filteredLogs.filter((log) => metaValue(log.metadata, "user")).length,
    };
  }, [filteredLogs]);

  const totalIssues = syncAlerts.length + remediations.length + summary.incidents;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Sync Triage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Incident-focused ShareSync and Drive admin events for investigating sync failures, deletes, moves, and renames.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
            {filteredLogs.length} matching rows
          </div>
          {totalIssues > 0 && (
            <div className="rounded-full border border-warning/30 bg-warning/10 px-3 py-1 text-xs font-medium text-warning">
              {totalIssues} issues detected
            </div>
          )}
          {syncAlerts.length > 0 && (
            <button
              onClick={() => setShowAlerts(!showAlerts)}
              className="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-xs font-medium text-primary hover:bg-primary/20 transition-colors flex items-center gap-1"
            >
              <AlertTriangle className="h-3 w-3" />
              {syncAlerts.length} Active Alerts
            </button>
          )}
        </div>
      </div>

      {/* Alert Banner */}
      {showAlerts && syncAlerts.length > 0 && (
        <div className="rounded-lg border border-warning/30 bg-warning/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-warning flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Active Sync Alerts ({syncAlerts.length})
            </h3>
            <button
              onClick={() => setShowAlerts(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {syncAlerts.map((alert) => (
              <div
                key={alert.id}
                onClick={() => setSelectedAlert(alert)}
                className="rounded-md border border-warning/20 bg-card p-3 cursor-pointer hover:bg-warning/5 transition-colors"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{alert.title}</p>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{alert.message}</p>
                  </div>
                  <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                </div>
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full",
                    alert.severity === "critical" ? "bg-critical/20 text-critical" :
                    alert.severity === "warning" ? "bg-warning/20 text-warning" :
                    "bg-primary/20 text-primary"
                  )}>
                    {alert.severity}
                  </span>
                  <span>{timeAgo(alert.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending Remediations */}
      {remediations.length > 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <h3 className="font-semibold text-primary flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Pending Sync Remediations ({remediations.length})
          </h3>
          <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
            {remediations.map((rem) => (
              <div
                key={rem.id}
                className="rounded-md border border-primary/20 bg-card p-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-xs rounded-full bg-primary/20 text-primary capitalize">
                    {rem.issue_type.replace("_", " ")}
                  </span>
                  <span className="px-2 py-0.5 text-xs rounded-full bg-muted text-muted-foreground">
                    {rem.status}
                  </span>
                </div>
                <p className="text-sm font-mono truncate" title={rem.file_path}>
                  {rem.file_path}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {rem.action_taken.replace("_", " ")}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Incidents" value={summary.incidents} tone="critical" />
        <StatCard label="ShareSync Rows" value={summary.sharesync} tone="default" />
        <StatCard label="Admin Rows" value={summary.admin} tone="warning" />
        <StatCard label="User Tagged" value={summary.withUsers} tone="default" />
      </div>

      {/* Filters */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.6fr)_180px_180px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search message, share, path..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <div className="relative">
          <UserRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter by user"
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="w-full rounded-md border border-border bg-card py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          {sourceOptions.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>

        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          {actionOptions.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      {/* Log Entries */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading triage events...</div>
      ) : filteredLogs.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No ShareSync or admin events matched the current filters.
        </div>
      ) : (
        <div className="space-y-3">
          {filteredLogs.map((log) => {
            const actionValue = metaValue(log.metadata, "action");
            const component = metaValue(log.metadata, "component");
            const pathValue = metaValue(log.metadata, "path");
            const shareName = metaValue(log.metadata, "share_name");
            const newShareName = metaValue(log.metadata, "new_share_name");
            const userValue = metaValue(log.metadata, "user");
            const incident =
              actionValue === "sync_failure" ||
              actionValue === "sync_conflict" ||
              actionValue === "delete" ||
              actionValue === "move" ||
              actionValue === "rename";

            return (
              <article
                key={log.id}
                className={cn(
                  "rounded-xl border bg-card p-4 shadow-sm",
                  incident ? "border-amber-500/40" : "border-border"
                )}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div
                      className={cn(
                        "rounded-lg p-2",
                        incident ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-primary/10 text-primary"
                      )}
                    >
                      {incident ? <AlertTriangle className="h-4 w-4" /> : <FolderSync className="h-4 w-4" />}
                    </div>

                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", toneClass(log.source))}>
                          {log.source}
                        </span>
                        {component && (
                          <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
                            {component}
                          </span>
                        )}
                        {actionValue && (
                          <span className="rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
                            {actionValue}
                          </span>
                        )}
                        {userValue && (
                          <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                            {userValue}
                          </span>
                        )}
                      </div>

                      <p className="max-w-4xl text-sm leading-6 text-foreground">
                        {log.message}
                      </p>

                      <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
                        {pathValue && (
                          <div className="rounded-md bg-muted/50 px-3 py-2 font-mono">
                            <span className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground/80">
                              Path
                            </span>
                            {pathValue}
                          </div>
                        )}
                        {(shareName || newShareName) && (
                          <div className="rounded-md bg-muted/50 px-3 py-2">
                            <span className="mb-1 block text-[10px] uppercase tracking-wide text-muted-foreground/80">
                              Share
                            </span>
                            <div>{shareName || "—"}</div>
                            {newShareName && newShareName !== shareName && (
                              <div className="mt-1 flex items-center gap-1 text-primary">
                                <ArrowRightLeft className="h-3 w-3" />
                                <span>{newShareName}</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right text-xs text-muted-foreground">
                    <div>{new Date(log.logged_at).toLocaleString()}</div>
                    <div className="mt-1">{timeAgo(log.logged_at)}</div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Alert Detail Modal */}
      {selectedAlert && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setSelectedAlert(null)}>
          <div className="bg-card rounded-xl border border-border max-w-2xl w-full max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold">{selectedAlert.title}</h2>
                  <div className="flex items-center gap-2 mt-2">
                    <span className={cn(
                      "px-2 py-0.5 rounded-full text-xs font-medium",
                      selectedAlert.severity === "critical" ? "bg-critical/20 text-critical" :
                      selectedAlert.severity === "warning" ? "bg-warning/20 text-warning" :
                      "bg-primary/20 text-primary"
                    )}>
                      {selectedAlert.severity}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {new Date(selectedAlert.created_at).toLocaleString()}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => setSelectedAlert(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              </div>

              <div className="prose prose-sm max-w-none">
                <p className="text-sm">{selectedAlert.message}</p>
              </div>

              {selectedAlert.details && Object.keys(selectedAlert.details).length > 0 && (
                <div className="rounded-md bg-muted p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Details
                  </h4>
                  <pre className="text-xs overflow-auto">
                    {JSON.stringify(selectedAlert.details, null, 2)}
                  </pre>
                </div>
              )}

              <div className="flex gap-3 pt-4 border-t">
                <a
                  href="/assistant"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  <Wrench className="h-4 w-4" />
                  Analyze with Copilot
                </a>
                <a
                  href="/ai-insights"
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border text-sm font-medium hover:bg-muted transition-colors"
                >
                  View AI Insights
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
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "warning" | "critical";
}) {
  const toneClass =
    tone === "critical"
      ? "border-critical/30 bg-critical/5"
      : tone === "warning"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-border bg-card";

  return (
    <div className={cn("rounded-xl border p-4", toneClass)}>
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <ShieldAlert className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}
