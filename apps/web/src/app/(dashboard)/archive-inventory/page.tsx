"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ARCHIVE_SHARES,
  ARCHIVE_NAS_TARGETS,
  type ArchiveNasTarget,
} from "@synology-monitor/shared";
import { cn } from "@/lib/utils";
import {
  Play,
  CalendarClock,
  Square,
  Download,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

interface InventoryJob {
  id: string;
  status: string;
  target_shares: string[];
  scheduled_for: string;
  current_share: string;
  files_scanned: number;
  bytes_scanned: number;
  elapsed_seconds: number;
  result_available: boolean;
  overlay_note: string;
  error: string;
}

interface ResultEnvelope {
  header: string;
  rows: string[];
  total_rows: number;
  next_cursor: number;
}

const TERMINAL = new Set(["complete", "failed", "cancelled", "interrupted"]);
const RESULT_LIMIT = 5000;

function toUtcIso(localValue: string): string {
  // <input type="datetime-local"> yields local wall-clock with no zone.
  return localValue ? new Date(localValue).toISOString() : "";
}

function parseCsvRows(rows: string[]): string[][] {
  return rows.map((r) => r.split(","));
}

export default function ArchiveInventoryPage() {
  const [nas, setNas] = useState<ArchiveNasTarget>(ARCHIVE_NAS_TARGETS[0]);
  const [shares, setShares] = useState<Set<string>>(new Set(["files"]));
  const [cutoffYears, setCutoffYears] = useState("2021,2022");
  const [overlay, setOverlay] = useState(true);
  const [protectNewerThan, setProtectNewerThan] = useState("");
  const [scheduledFor, setScheduledFor] = useState("");

  // Advanced tuning.
  const [useIdleIo, setUseIdleIo] = useState(true);
  const [maxFilesPerSec, setMaxFilesPerSec] = useState("0");
  const [sleepEveryFiles, setSleepEveryFiles] = useState("5000");
  const [sleepMs, setSleepMs] = useState("25");

  const [jobs, setJobs] = useState<InventoryJob[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeJob, setActiveJob] = useState<InventoryJob | null>(null);
  const [results, setResults] = useState<Record<string, string[][]> | null>(null);
  const [resultsJobId, setResultsJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch(`/api/archive/jobs?nas=${nas}`);
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? `Failed to list jobs (HTTP ${res.status}).` });
        setJobs([]);
        return;
      }
      setJobs((data.jobs as InventoryJob[]) ?? []);
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to reach the server." });
    }
  }, [nas]);

  useEffect(() => {
    setResults(null);
    setActiveId(null);
    setActiveJob(null);
    refreshList();
  }, [nas, refreshList]);

  // Poll the active job every 2s while it is queued/running.
  useEffect(() => {
    if (!activeId) return;
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`/api/archive/jobs/${activeId}?nas=${nas}`);
        const job = (await res.json()) as InventoryJob;
        if (stop || !res.ok) return;
        setActiveJob(job);
        if (TERMINAL.has(job.status)) {
          setActiveId(null);
          refreshList();
          if (job.result_available) loadResults(job.id);
        }
      } catch {
        /* transient — keep polling */
      }
    }
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, nas]);

  const loadResults = useCallback(
    async (jobId: string) => {
      const kinds = ["yearly", "cutoff", "dirs"] as const;
      const out: Record<string, string[][]> = {};
      await Promise.all(
        kinds.map(async (kind) => {
          try {
            const res = await fetch(`/api/archive/jobs/${jobId}/result?nas=${nas}&result=${kind}&limit=${RESULT_LIMIT}`);
            if (!res.ok) return;
            const env = (await res.json()) as ResultEnvelope;
            out[kind] = parseCsvRows(env.rows ?? []);
          } catch {
            /* ignore a single missing report */
          }
        }),
      );
      setResults(out);
      setResultsJobId(jobId);
    },
    [nas],
  );

  function buildInput() {
    const input: Record<string, unknown> = {
      nas,
      shares: [...shares],
      overlay,
      use_idle_io_priority: useIdleIo,
    };
    const cutoffs = cutoffYears
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isFinite(n));
    if (cutoffs.length) input.cutoff_years = cutoffs;
    if (protectNewerThan) input.protect_newer_than = toUtcIso(protectNewerThan);
    const fps = parseInt(maxFilesPerSec, 10);
    if (Number.isFinite(fps)) input.max_files_per_second = fps;
    const sef = parseInt(sleepEveryFiles, 10);
    if (Number.isFinite(sef)) input.sleep_every_files = sef;
    const sms = parseInt(sleepMs, 10);
    if (Number.isFinite(sms)) input.sleep_ms = sms;
    return input;
  }

  async function submit(path: string, extra: Record<string, unknown> = {}) {
    if (shares.size === 0) {
      setNotice({ kind: "error", text: "Select at least one share to scan." });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...buildInput(), ...extra }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? `Request failed (HTTP ${res.status}).` });
        return;
      }
      const job = data as InventoryJob;
      setNotice({ kind: "info", text: extra.scheduled_for ? `Scheduled job ${job.id}.` : `Started job ${job.id}.` });
      if (!extra.scheduled_for) {
        setActiveId(job.id);
        setResults(null);
      }
      refreshList();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Request failed." });
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      const res = await fetch(`/api/archive/jobs/${id}/cancel?nas=${nas}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) setNotice({ kind: "error", text: data.error ?? `Cancel failed (HTTP ${res.status}).` });
      refreshList();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Cancel failed." });
    }
  }

  const scheduled = jobs.filter((j) => j.status === "scheduled");

  const yearlyChart = useMemo(() => {
    const rows = results?.yearly ?? [];
    const byYear = new Map<string, { year: string; files: number; gib: number }>();
    for (const r of rows) {
      // nas,share,year,file_count,total_bytes,total_gib
      const [, , year, fileCount, , gibStr] = r;
      if (!year) continue;
      const acc = byYear.get(year) ?? { year, files: 0, gib: 0 };
      acc.files += Number(fileCount) || 0;
      acc.gib += Number(gibStr) || 0;
      byYear.set(year, acc);
    }
    return [...byYear.values()].sort((a, b) => a.year.localeCompare(b.year));
  }, [results]);

  function toggleShare(s: string) {
    setShares((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Archive Inventory</h1>
        <p className="text-sm text-muted-foreground">
          Read-only scan of shared folders by modified year — evidence for choosing archive cutoffs. It never moves,
          deletes, or modifies files.
        </p>
      </div>

      {notice && (
        <div
          className={cn(
            "rounded-md border px-4 py-2 text-sm",
            notice.kind === "error"
              ? "border-critical/40 bg-critical/10 text-critical"
              : "border-border bg-muted text-foreground",
          )}
        >
          {notice.text}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Configure ─────────────────────────────────────────────── */}
        <section className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium">New scan</h2>

          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Target NAS</span>
            <select
              value={nas}
              onChange={(e) => setNas(e.target.value as ArchiveNasTarget)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              {ARCHIVE_NAS_TARGETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>

          <div className="text-sm">
            <span className="mb-1 block text-muted-foreground">Shares</span>
            <div className="grid grid-cols-2 gap-1">
              {ARCHIVE_SHARES.map((s) => (
                <label key={s} className="flex items-center gap-2">
                  <input type="checkbox" checked={shares.has(s)} onChange={() => toggleShare(s)} />
                  {s}
                </label>
              ))}
            </div>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Cutoff years (comma-separated)</span>
            <input
              value={cutoffYears}
              onChange={(e) => setCutoffYears(e.target.value)}
              placeholder="2021,2022"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
          </label>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
            Drive/ShareSync recent-activity overlay
          </label>

          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Protect files newer than</span>
            <input
              type="datetime-local"
              value={protectNewerThan}
              onChange={(e) => setProtectNewerThan(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Files modified, changed, or created on/after this date are never archive candidates, even with no sync
              activity.
            </span>
          </label>

          <details className="rounded-md border border-border p-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground">Advanced options</summary>
            <div className="mt-3 space-y-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={useIdleIo} onChange={(e) => setUseIdleIo(e.target.checked)} />
                Use idle I/O priority
              </label>
              <label className="block">
                <span className="mb-1 block text-muted-foreground">Max files/sec (0 = unlimited)</span>
                <input
                  type="number"
                  value={maxFilesPerSec}
                  onChange={(e) => setMaxFilesPerSec(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-muted-foreground">Pause every N files</span>
                <input
                  type="number"
                  value={sleepEveryFiles}
                  onChange={(e) => setSleepEveryFiles(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-muted-foreground">Pause duration (ms)</span>
                <input
                  type="number"
                  value={sleepMs}
                  onChange={(e) => setSleepMs(e.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => submit("/api/archive/jobs")}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Start now
            </button>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <button
              onClick={() => {
                if (!scheduledFor) {
                  setNotice({ kind: "error", text: "Pick a date/time to schedule." });
                  return;
                }
                submit("/api/archive/jobs/schedule", { scheduled_for: toUtcIso(scheduledFor) });
              }}
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium disabled:opacity-50"
            >
              <CalendarClock className="h-4 w-4" />
              Schedule
            </button>
          </div>
        </section>

        {/* ── Status ────────────────────────────────────────────────── */}
        <section className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Jobs</h2>
            <button onClick={refreshList} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>

          {activeJob && !TERMINAL.has(activeJob.status) && (
            <div className="rounded-md border border-border bg-muted p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
                  {activeJob.status} — {activeJob.current_share || "starting"}
                </span>
                <button onClick={() => cancel(activeJob.id)} className="inline-flex items-center gap-1 text-critical">
                  <Square className="h-3 w-3" /> Cancel
                </button>
              </div>
              <div className="mt-1 text-muted-foreground">
                {activeJob.files_scanned.toLocaleString()} files · {(activeJob.bytes_scanned / 1024 ** 3).toFixed(2)} GiB ·{" "}
                {activeJob.elapsed_seconds}s
              </div>
            </div>
          )}

          {scheduled.length > 0 && (
            <div className="text-sm">
              <span className="mb-1 block text-muted-foreground">Scheduled</span>
              <ul className="space-y-1">
                {scheduled.map((j) => (
                  <li key={j.id} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                    <span>
                      {j.scheduled_for} · {j.target_shares.join("/")}
                    </span>
                    <button onClick={() => cancel(j.id)} className="text-critical">
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="text-sm">
            <span className="mb-1 block text-muted-foreground">Recent</span>
            {jobs.length === 0 ? (
              <p className="text-muted-foreground">No jobs yet.</p>
            ) : (
              <ul className="space-y-1">
                {jobs.slice(0, 10).map((j) => (
                  <li key={j.id} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                    <span className="truncate">
                      <span className="font-mono text-xs">{j.id}</span> · {j.status}
                    </span>
                    {j.result_available && (
                      <button onClick={() => loadResults(j.id)} className="text-primary">
                        View
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* ── Results ───────────────────────────────────────────────────── */}
      {results && (
        <section className="space-y-6 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium">Results</h2>

          {yearlyChart.length > 0 && (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={yearlyChart}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="year" className="text-xs" />
                  <YAxis className="text-xs" />
                  <Tooltip />
                  <Bar dataKey="files" name="files" fill="#2563eb" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <ResultTable
            title="Cutoff summary (candidates vs protected)"
            header={["share", "cutoff", "candidate #", "candidate bytes", "candidate GiB", "protected #", "protected bytes"]}
            rows={(results.cutoff ?? []).map((r) => r.slice(1))}
          />
          <ResultTable
            title="Directory summary"
            header={["share", "total dirs", "empty dirs"]}
            rows={(results.dirs ?? []).map((r) => r.slice(1))}
          />

          {activeJob?.overlay_note && (
            <p className="text-xs text-muted-foreground">Overlay note: {activeJob.overlay_note}</p>
          )}

          <div className="flex flex-wrap gap-2 text-sm">
            {resultsJobId &&
              (["yearly", "cutoff", "dirs", "overlay"] as const).map((kind) => (
                <a
                  key={kind}
                  href={`/api/archive/jobs/${resultsJobId}/result?nas=${nas}&result=${kind}&download=1`}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 hover:bg-muted"
                >
                  <Download className="h-4 w-4" /> {kind}.csv
                </a>
              ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ResultTable({ title, header, rows }: { title: string; header: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {header.map((h) => (
                <th key={h} className="px-2 py-1 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-border/50">
                {r.map((c, j) => (
                  <td key={j} className="px-2 py-1">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
