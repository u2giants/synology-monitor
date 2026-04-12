"use client";

import { useEffect, useMemo, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo, formatET } from "@/lib/utils";
import { Search, Filter, FolderSync, UserRound, ArrowRightLeft, Trash2, Pencil, Download, Upload, ShieldAlert } from "lucide-react";

interface LogEntry {
  id: string;
  source: string;
  severity: string;
  message: string;
  logged_at: string;
  metadata: Record<string, unknown> | null;
}

const sources = [
  { value: "all", label: "All Sources" },
  { value: "drive", label: "Drive" },
  { value: "drive_server", label: "Drive Server" },
  { value: "drive_sharesync", label: "ShareSync" },
  { value: "system", label: "System" },
  { value: "security", label: "Security" },
  { value: "connection", label: "Connection" },
  { value: "package", label: "Package" },
  { value: "docker", label: "Docker" },
];

const actionOptions = [
  { value: "all", label: "All Actions" },
  { value: "create", label: "Create" },
  { value: "delete", label: "Delete" },
  { value: "rename", label: "Rename" },
  { value: "move", label: "Move" },
  { value: "upload", label: "Upload" },
  { value: "download", label: "Download" },
  { value: "sync_failure", label: "Sync Failure" },
  { value: "sync_conflict", label: "Sync Conflict" },
];

function metaValue(metadata: Record<string, unknown> | null, key: string) {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function actionIcon(action: string) {
  switch (action) {
    case "rename":
      return Pencil;
    case "move":
      return ArrowRightLeft;
    case "delete":
      return Trash2;
    case "download":
      return Download;
    case "upload":
      return Upload;
    case "sync_failure":
    case "sync_conflict":
      return ShieldAlert;
    default:
      return FolderSync;
  }
}

function sourceTone(source: string) {
  switch (source) {
    case "drive_server":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "drive_sharesync":
      return "bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "drive":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [action, setAction] = useState("all");
  const [userFilter, setUserFilter] = useState("");

  const fetchLogs = useCallback(async () => {
    const supabase = createClient();
    let query = supabase
      .from("nas_logs")
      .select("id, source, severity, message, logged_at, metadata")
      .order("ingested_at", { ascending: false })
      .limit(250);

    if (source !== "all") query = query.eq("source", source);
    if (search) query = query.ilike("message", `%${search}%`);

    const { data, error } = await query;
    if (!error && data) {
      setLogs(data);
    }
    setLoading(false);
  }, [search, source]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      const metadata = log.metadata;
      const actionValue = metaValue(metadata, "action");
      const userValue = metaValue(metadata, "user");
      const pathValue = metaValue(metadata, "path");
      const shareName = metaValue(metadata, "share_name");
      const component = metaValue(metadata, "component");

      if (action !== "all" && actionValue !== action) return false;

      if (userFilter) {
        const needle = userFilter.toLowerCase();
        if (!userValue.toLowerCase().includes(needle)) return false;
      }

      if (!search) return true;

      const needle = search.toLowerCase();
      return [
        log.message,
        log.source,
        actionValue,
        userValue,
        pathValue,
        shareName,
        component,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [action, logs, search, userFilter]);

  const driveActivity = useMemo(
    () =>
      filteredLogs.filter((log) =>
        ["drive", "drive_server", "drive_sharesync"].includes(log.source)
      ),
    [filteredLogs]
  );

  const summary = useMemo(() => {
    const driveOnly = logs.filter((log) =>
      ["drive", "drive_server", "drive_sharesync"].includes(log.source)
    );

    const withUsers = driveOnly.filter((log) => metaValue(log.metadata, "user")).length;
    const syncFailures = driveOnly.filter(
      (log) => metaValue(log.metadata, "action") === "sync_failure"
    ).length;
    const destructive = driveOnly.filter((log) => {
      const value = metaValue(log.metadata, "action");
      return value === "delete" || value === "rename" || value === "move";
    }).length;

    return {
      driveOnly: driveOnly.length,
      withUsers,
      syncFailures,
      destructive,
    };
  }, [logs]);

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Filesystem And Sync Activity</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drive, ShareSync, and admin-console events with user, path, and action metadata when Synology exposes them.
          </p>
        </div>
        <div className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          {driveActivity.length} matching rows
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard label="Drive Rows" value={summary.driveOnly} tone="default" />
        <SummaryCard label="User Tagged" value={summary.withUsers} tone="default" />
        <SummaryCard label="Sync Failures" value={summary.syncFailures} tone="critical" />
        <SummaryCard label="Delete / Move / Rename" value={summary.destructive} tone="warning" />
      </div>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.6fr)_180px_180px]">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search message, path, share, component..."
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
          {sources.map((item) => (
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

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading activity...</div>
      ) : driveActivity.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          No Drive or ShareSync events matched the current filters.
        </div>
      ) : (
        <div className="space-y-3">
          {driveActivity.map((log) => {
            const metadata = log.metadata;
            const actionValue = metaValue(metadata, "action");
            const component = metaValue(metadata, "component");
            const pathValue = metaValue(metadata, "path");
            const userValue = metaValue(metadata, "user");
            const shareName = metaValue(metadata, "share_name");
            const newShareName = metaValue(metadata, "new_share_name");
            const Icon = actionIcon(actionValue);

            return (
              <article
                key={log.id}
                className="rounded-xl border border-border bg-card p-4 shadow-sm transition-colors hover:bg-muted/20"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className={cn("rounded-full px-2.5 py-1 text-[11px] font-medium", sourceTone(log.source))}>
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
                              <div className="mt-1 text-primary">New name: {newShareName}</div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="text-right text-xs text-muted-foreground">
                    <div>{formatET(log.logged_at)} ET</div>
                    <div className="mt-1">{timeAgo(log.logged_at)}</div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SummaryCard({
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
        <Filter className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
    </div>
  );
}
