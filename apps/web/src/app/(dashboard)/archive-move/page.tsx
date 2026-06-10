"use client";

import { useCallback, useEffect, useState } from "react";
import { ARCHIVE_SHARES, ARCHIVE_NAS_TARGETS, type ArchiveNasTarget } from "@synology-monitor/shared";
import { cn } from "@/lib/utils";
import { AlertTriangle, ChevronDown, ChevronRight, Download, FileSearch, Folder, Loader2, Play, ShieldCheck, Square, Undo2, X } from "lucide-react";

interface MoveJob {
  id: string;
  status: string;
  share: string;
  mode: string;
  planned: number;
  moved: number;
  verified: number;
  skipped: number;
  failed: number;
  dirs_pruned: number;
  bytes_moved: number;
  current_path: string;
  snapshot_id: string;
  snapshot_path: string;
  preflight_note: string;
  sync_exclusion_note: string;
  error: string;
}

interface TreeDir {
  name: string;
  path: string;
}

interface TreeNodeState {
  dirs: TreeDir[];
  loaded: boolean;
  loading: boolean;
  open: boolean;
  error: string;
}

const ACTIVE = new Set(["planning", "preflight", "snapshotting", "executing", "verifying"]);
const toUtcIso = (v: string) => (v ? new Date(v).toISOString() : "");
const splitRoots = (value: string) => value.split(",").map((s) => s.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);
const formatRoots = (values: string[]) => Array.from(new Set(values)).sort((a, b) => a.localeCompare(b)).join(", ");

export default function ArchiveMovePage() {
  const [nas, setNas] = useState<ArchiveNasTarget>(ARCHIVE_NAS_TARGETS[0]);
  const [share, setShare] = useState<string>("Coldlion");
  const [mode, setMode] = useState("move");
  const [roots, setRoots] = useState("");
  const [cutoffYears, setCutoffYears] = useState("2022");
  const [protect, setProtect] = useState("");
  const [prune, setPrune] = useState(true);
  const [removePreexisting, setRemovePreexisting] = useState(false);

  const [jobs, setJobs] = useState<MoveJob[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [job, setJob] = useState<MoveJob | null>(null);
  const [manifest, setManifest] = useState<{ lines: string[]; total: number } | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [tree, setTree] = useState<Record<string, TreeNodeState>>({});

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/archive/move?nas=${nas}`);
      const data = await res.json();
      if (res.ok) setJobs((data.jobs as MoveJob[]) ?? []);
    } catch {
      /* ignore */
    }
  }, [nas]);

  useEffect(() => {
    setActiveId(null);
    setJob(null);
    setManifest(null);
    setReviewed(false);
    setConfirmText("");
    refresh();
  }, [nas, refresh]);

  useEffect(() => {
    setTree({});
  }, [nas, share]);

  // Poll the active job while it is in a live stage.
  useEffect(() => {
    if (!activeId) return;
    let stop = false;
    async function poll() {
      try {
        const res = await fetch(`/api/archive/move/${activeId}?nas=${nas}`);
        const j = (await res.json()) as MoveJob;
        if (stop || !res.ok) return;
        setJob(j);
        if (!ACTIVE.has(j.status)) {
          setActiveId(null);
          refresh();
          if (j.status === "planned") loadManifest(j.id);
        }
      } catch {
        /* transient */
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

  const loadManifest = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/archive/move/${id}/manifest?nas=${nas}&limit=200`);
        const data = await res.json();
        if (res.ok) setManifest({ lines: data.lines ?? [], total: data.total_rows ?? 0 });
      } catch {
        /* ignore */
      }
    },
    [nas],
  );

  const loadTree = useCallback(
    async (path = "") => {
      setTree((prev) => ({
        ...prev,
        [path]: { dirs: prev[path]?.dirs ?? [], loaded: prev[path]?.loaded ?? false, loading: true, open: true, error: "" },
      }));
      try {
        const qs = new URLSearchParams({ nas, share, path });
        const res = await fetch(`/api/archive/move/tree?${qs.toString()}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Folder load failed (HTTP ${res.status}).`);
        setTree((prev) => ({
          ...prev,
          [path]: { dirs: (data.dirs as TreeDir[]) ?? [], loaded: true, loading: false, open: true, error: "" },
        }));
      } catch (err) {
        setTree((prev) => ({
          ...prev,
          [path]: { dirs: prev[path]?.dirs ?? [], loaded: prev[path]?.loaded ?? false, loading: false, open: true, error: err instanceof Error ? err.message : "Folder load failed." },
        }));
      }
    },
    [nas, share],
  );

  function toggleTree(path: string) {
    const node = tree[path];
    if (!node?.loaded) {
      loadTree(path);
      return;
    }
    setTree((prev) => ({ ...prev, [path]: { ...node, open: !node.open } }));
  }

  function setRootSelected(path: string, selected: boolean) {
    const current = splitRoots(roots);
    setRoots(formatRoots(selected ? [...current, path] : current.filter((r) => r !== path)));
  }

  function planBody() {
    const body: Record<string, unknown> = { nas, share, mode, prune_emptied_source_dirs: prune, remove_preexisting_empty_dirs: removePreexisting };
    if (roots.trim()) body.roots = roots.split(",").map((s) => s.trim()).filter(Boolean);
    const cy = cutoffYears.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
    if (cy.length) body.cutoff_years = cy;
    if (protect) body.protect_newer_than = toUtcIso(protect);
    return body;
  }

  async function plan() {
    setBusy(true);
    setNotice(null);
    setManifest(null);
    setReviewed(false);
    setConfirmText("");
    try {
      const res = await fetch(`/api/archive/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planBody()),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? `Plan failed (HTTP ${res.status}).` });
        return;
      }
      setJob(data as MoveJob);
      setActiveId(data.id);
      setNotice({ kind: "info", text: `Planning job ${data.id} (dry-run, nothing moved yet).` });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Plan failed." });
    } finally {
      setBusy(false);
    }
  }

  async function action(id: string, path: string, label: string) {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/archive/move/${id}/${path}?nas=${nas}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setNotice({ kind: "error", text: data.error ?? `${label} failed (HTTP ${res.status}).` });
        return;
      }
      setNotice({ kind: "info", text: `${label} started for ${id}.` });
      if (path === "execute" || path === "rollback") {
        setActiveId(id);
        setConfirmText("");
      } else if (path === "verify") {
        setJob((data.job as MoveJob) ?? job);
        setNotice({ kind: "info", text: `Re-verify: ${data.verify_report ?? ""}` });
      }
      refresh();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : `${label} failed.` });
    } finally {
      setBusy(false);
    }
  }

  const isMove = mode === "move";
  const selectedRoots = new Set(splitRoots(roots));
  const planned = job?.status === "planned";
  const canExecute = planned && reviewed && confirmText === share && !busy;
  const completed = job?.status === "complete";

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Archive Move</h1>
        <p className="text-sm text-muted-foreground">
          Relocate old files into <code>&lt;share&gt;/Archive</code> (or clean up empty folders) — staged, snapshot-protected,
          and fully reversible. <span className="text-foreground">This is the only step that writes to your files.</span>
        </p>
      </div>

      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
        <AlertTriangle className="mr-1 inline h-4 w-4" />
        Always <strong>Plan</strong> first and review the file list. Execute takes a Btrfs snapshot, moves by rename only
        (identity verified per file), and can be rolled back.
      </div>

      {notice && (
        <div className={cn("rounded-md border px-4 py-2 text-sm", notice.kind === "error" ? "border-critical/40 bg-critical/10 text-critical" : "border-border bg-muted")}>
          {notice.text}
        </div>
      )}

      {/* ── 1. Scope & rules ─────────────────────────────────────────── */}
      <section className="space-y-3 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">1. Scope &amp; rules</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">NAS</span>
            <select value={nas} onChange={(e) => setNas(e.target.value as ArchiveNasTarget)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              {ARCHIVE_NAS_TARGETS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Shared folder</span>
            <select value={share} onChange={(e) => { setShare(e.target.value); setRoots(""); }} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              {ARCHIVE_SHARES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">What to do</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm">
              <option value="move">Move old files into Archive</option>
              <option value="clean_empty_dirs">Only remove empty folders</option>
            </select>
          </label>
          <div className="space-y-2 text-sm sm:col-span-2">
            <label className="block">
              <span className="mb-1 block text-muted-foreground">Limit to sub-folders</span>
              <input value={roots} onChange={(e) => setRoots(e.target.value)} placeholder="No limit selected" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
            </label>
            <div className="rounded-md border border-border bg-background p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <button type="button" onClick={() => toggleTree("")} className="inline-flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
                  {tree[""]?.loading ? <Loader2 className="h-3 w-3 animate-spin" /> : tree[""]?.open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <Folder className="h-3 w-3" /> Browse {share}
                </button>
                {selectedRoots.size > 0 && (
                  <button type="button" onClick={() => setRoots("")} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" /> Clear
                  </button>
                )}
              </div>
              {tree[""]?.open && (
                <FolderTree path="" tree={tree} selected={selectedRoots} onToggle={toggleTree} onSelect={setRootSelected} />
              )}
              {selectedRoots.size > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {[...selectedRoots].map((path) => (
                    <button key={path} type="button" onClick={() => setRootSelected(path, false)} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs">
                      <span className="truncate">{path}</span><X className="h-3 w-3 shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          {isMove && (
            <>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Archive files modified before year</span>
                <input value={cutoffYears} onChange={(e) => setCutoffYears(e.target.value)} placeholder="2022" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">Never archive files newer than (optional)</span>
                <input type="datetime-local" value={protect} onChange={(e) => setProtect(e.target.value)} className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>
            </>
          )}
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={prune} onChange={(e) => setPrune(e.target.checked)} /> Remove folders emptied by the move</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={removePreexisting} onChange={(e) => setRemovePreexisting(e.target.checked)} /> Also remove already-empty folders</label>
        </div>
        <button onClick={plan} disabled={busy} className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />} Plan (dry-run)
        </button>
      </section>

      {/* ── 2. Review the plan ───────────────────────────────────────── */}
      {job && (job.status === "planned" || ACTIVE.has(job.status) || completed || job.status === "rolled_back" || job.status === "failed" || job.status === "cancelled" || job.status === "preflight_failed") && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium">2. Plan &amp; progress</h2>
          <div className="rounded-md border border-border bg-muted p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="font-medium">
                {ACTIVE.has(job.status) && <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />}
                {job.status}{job.current_path ? ` · ${job.current_path}` : ""}
              </span>
              <span className="font-mono text-xs">{job.id}</span>
            </div>
            <div className="mt-1 text-muted-foreground">
              planned {job.planned} · moved {job.moved} · verified {job.verified} · skipped {job.skipped} · failed {job.failed} · folders pruned {job.dirs_pruned}
            </div>
            {job.snapshot_id && <div className="mt-1 text-xs text-muted-foreground">snapshot: {job.snapshot_id} ({job.snapshot_path})</div>}
            {job.preflight_note && <div className="mt-1 text-xs text-critical">preflight: {job.preflight_note}</div>}
            {job.sync_exclusion_note && <div className="mt-1 text-xs text-muted-foreground">sync exclusion: {job.sync_exclusion_note}</div>}
            {job.error && <div className="mt-1 text-xs text-critical">error: {job.error}</div>}
          </div>

          {manifest && (
            <div>
              <div className="mb-1 flex items-center justify-between text-sm text-muted-foreground">
                <span>Planned changes — showing {manifest.lines.length} of {manifest.total}</span>
                <a href={`/api/archive/move/${job.id}/result?nas=${nas}&kind=move-report&download=1`} className="inline-flex items-center gap-1 hover:text-foreground"><Download className="h-3 w-3" /> report</a>
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border border-border bg-background p-2 text-xs">{manifest.lines.map((l) => prettyRow(l)).join("\n")}</pre>
            </div>
          )}
        </section>
      )}

      {/* ── 3. Execute (gated) ───────────────────────────────────────── */}
      {planned && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium">3. Execute</h2>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="mt-1" />
            <span>I reviewed the plan above — {job?.planned} file(s)/folder(s) will be {isMove ? "moved into Archive" : "removed"}.</span>
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-muted-foreground">Type the share name <code>{share}</code> to confirm</span>
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm" />
          </label>
          <button onClick={() => action(job!.id, "execute", "Execute")} disabled={!canExecute} className="inline-flex items-center gap-2 rounded-md bg-critical px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
            <Play className="h-4 w-4" /> Execute move
          </button>
        </section>
      )}

      {ACTIVE.has(job?.status ?? "") && (
        <button onClick={() => action(job!.id, "cancel", "Cancel")} className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-sm text-critical">
          <Square className="h-3 w-3" /> Cancel running job
        </button>
      )}

      {/* ── 4. Verify & rollback ─────────────────────────────────────── */}
      {(completed || job?.status === "rolled_back") && (
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="font-medium">4. Verify &amp; rollback</h2>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => action(job!.id, "verify", "Verify")} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
              <ShieldCheck className="h-4 w-4" /> Re-verify
            </button>
            <a href={`/api/archive/move/${job!.id}/result?nas=${nas}&kind=verify-report&download=1`} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
              <Download className="h-4 w-4" /> verify report
            </a>
          </div>
          {completed && (
            <div className="space-y-2">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">To roll everything back, type the share name <code>{share}</code></span>
                <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} className="w-full max-w-xs rounded-md border border-border bg-background px-3 py-2 text-sm" />
              </label>
              <button onClick={() => action(job!.id, "rollback", "Rollback")} disabled={confirmText !== share || busy} className="inline-flex items-center gap-2 rounded-md border border-critical px-3 py-2 text-sm text-critical disabled:opacity-40">
                <Undo2 className="h-4 w-4" /> Roll back this move
              </button>
            </div>
          )}
        </section>
      )}

      {/* Recent jobs */}
      <section className="space-y-2 rounded-lg border border-border bg-card p-4">
        <h2 className="font-medium">Recent move jobs</h2>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No move jobs yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {jobs.slice(0, 10).map((j) => (
              <li key={j.id} className="flex items-center justify-between rounded-md border border-border px-3 py-1.5">
                <span className="truncate"><span className="font-mono text-xs">{j.id}</span> · {j.status} · {j.share}/{j.mode}</span>
                <button onClick={() => { setJob(j); setActiveId(ACTIVE.has(j.status) ? j.id : null); loadManifest(j.id); }} className="text-primary">Open</button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FolderTree({
  path,
  tree,
  selected,
  onToggle,
  onSelect,
}: {
  path: string;
  tree: Record<string, TreeNodeState>;
  selected: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string, selected: boolean) => void;
}) {
  const node = tree[path];
  if (!node) return null;
  if (node.error) return <div className="rounded-md border border-critical/40 bg-critical/10 px-2 py-1 text-xs text-critical">{node.error}</div>;
  if (node.loading && node.dirs.length === 0) return <div className="px-2 py-1 text-xs text-muted-foreground">Loading folders...</div>;
  if (node.loaded && node.dirs.length === 0) return <div className="px-2 py-1 text-xs text-muted-foreground">No sub-folders here.</div>;

  return (
    <ul className="space-y-0.5">
      {node.dirs.map((dir) => {
        const child = tree[dir.path];
        const isOpen = child?.open ?? false;
        const isSelected = selected.has(dir.path);
        return (
          <li key={dir.path}>
            <div className="flex min-w-0 items-center gap-1 rounded-md px-1 py-1 hover:bg-muted">
              <button type="button" onClick={() => onToggle(dir.path)} className="grid h-6 w-6 shrink-0 place-items-center rounded hover:bg-background">
                {child?.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <label className="flex min-w-0 flex-1 items-center gap-2">
                <input type="checkbox" checked={isSelected} onChange={(e) => onSelect(dir.path, e.target.checked)} />
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{dir.name}</span>
              </label>
            </div>
            {isOpen && (
              <div className="ml-6 border-l border-border pl-2">
                <FolderTree path={dir.path} tree={tree} selected={selected} onToggle={onToggle} onSelect={onSelect} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// prettyRow renders a manifest JSONL line as a compact one-liner.
function prettyRow(line: string): string {
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    if (e.kind === "dir") return `[dir] ${e.status}  ${e.removed_reason ?? ""}  ${e.path}`;
    return `[file] ${e.status}${e.detail ? `(${e.detail})` : ""}  ${e.rel_path} → Archive/${e.rel_path}`;
  } catch {
    return line;
  }
}
