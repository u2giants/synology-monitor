"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";
import { Search, Filter } from "lucide-react";

interface LogEntry {
  id: string;
  source: string;
  severity: string;
  message: string;
  logged_at: string;
  metadata: Record<string, unknown> | null;
}

const sources = ["all", "system", "security", "connection", "package", "docker"];
const severities = ["all", "info", "warning", "error", "critical"];

export default function LogsPage() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [severity, setSeverity] = useState("all");

  const fetchLogs = useCallback(async () => {
    const supabase = createClient();
    let query = supabase
      .from("smon_logs")
      .select("id, source, severity, message, logged_at, metadata")
      .order("ingested_at", { ascending: false })
      .limit(200);

    if (source !== "all") query = query.eq("source", source);
    if (severity !== "all") query = query.eq("severity", severity);
    if (search) query = query.ilike("message", `%${search}%`);

    const { data, error } = await query;
    if (!error && data) {
      setLogs(data);
    }
    setLoading(false);
  }, [source, severity, search]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const severityColors: Record<string, string> = {
    info: "text-muted-foreground",
    warning: "text-warning",
    error: "text-critical",
    critical: "bg-critical/10 text-critical font-semibold",
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Logs</h1>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search logs..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-card pl-9 pr-3 py-2 text-sm focus:border-primary focus:outline-none"
          />
        </div>

        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          {sources.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Sources" : s}</option>
          ))}
        </select>

        <select
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="rounded-md border border-border bg-card px-3 py-2 text-sm"
        >
          {severities.map((s) => (
            <option key={s} value={s}>{s === "all" ? "All Severities" : s}</option>
          ))}
        </select>
      </div>

      {/* Log table */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading logs...</div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Time</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Source</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Severity</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(log.logged_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                      {log.source}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={cn("text-xs font-medium", severityColors[log.severity])}>
                      {log.severity}
                    </span>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs max-w-lg truncate">
                    {log.message}
                  </td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No logs found matching your filters
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
