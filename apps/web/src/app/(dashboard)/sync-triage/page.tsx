"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowRightLeft, FolderSync, Search, ShieldAlert, UserRound } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";

interface LogEntry {
  id: string;
  source: string;
  severity: string;
  message: string;
  logged_at: string;
  metadata: Record<string, unknown> | null;
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
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [action, setAction] = useState("all");
  const [userFilter, setUserFilter] = useState("");

  const fetchLogs = useCallback(async () => {
    const supabase = createClient();
    let query = supabase
      .from("smon_logs")
      .select("id, source, severity, message, logged_at, metadata")
      .in("source", ["drive_server", "drive_sharesync"])
      .order("ingested_at", { ascending: false })
      .limit(200);

    if (source !== "all") query = query.eq("source", source);

    const { data, error } = await query;
    if (!error && data) {
      setLogs(data);
    }
    setLoading(false);
  }, [source]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Sync Triage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Incident-focused ShareSync and Drive admin events for investigating sync failures, deletes, moves, and renames.
          </p>
        </div>
        <div className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          {filteredLogs.length} matching rows
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard label="Incidents" value={summary.incidents} tone="critical" />
        <StatCard label="ShareSync Rows" value={summary.sharesync} tone="default" />
        <StatCard label="Admin Rows" value={summary.admin} tone="warning" />
        <StatCard label="User Tagged" value={summary.withUsers} tone="default" />
      </div>

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
