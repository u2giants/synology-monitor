"use client";

import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Database,
  FileSearch,
  Folder,
  FolderOpen,
  HardDrive,
  Loader2,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Target = "both" | "edgesynology1" | "edgesynology2";
type BrowseTarget = "edgesynology1" | "edgesynology2";
type EntryType = "file" | "directory" | "any";

interface SearchMatch {
  kind: string;
  size_bytes: number | null;
  modified_at: string;
  owner_group: string;
  path: string;
}

interface NasResult {
  target: string;
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  matches: SearchMatch[];
}

interface SearchResponse {
  ok: boolean;
  results: NasResult[];
  error?: string;
}

interface TreeEntry {
  name: string;
  path: string;
  modified_at: string;
  owner_group: string;
}

interface TreeResponse {
  ok: boolean;
  entries: TreeEntry[];
  error?: string;
}

const targetOptions: Array<{ value: Target; label: string }> = [
  { value: "both", label: "Both NASes" },
  { value: "edgesynology1", label: "Edge Synology 1" },
  { value: "edgesynology2", label: "Edge Synology 2" },
];

const browseTargetOptions: Array<{ value: BrowseTarget; label: string }> = [
  { value: "edgesynology1", label: "Edge Synology 1" },
  { value: "edgesynology2", label: "Edge Synology 2" },
];

const entryTypeOptions: Array<{ value: EntryType; label: string }> = [
  { value: "file", label: "Files" },
  { value: "directory", label: "Folders" },
  { value: "any", label: "Both" },
];

function formatSize(bytes: number | null): string {
  if (bytes === null) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function treeKey(target: BrowseTarget, path: string): string {
  return `${target}:${path || "/"}`;
}

export default function FileSearchPage() {
  const [target, setTarget] = useState<Target>("both");
  const [browseTarget, setBrowseTarget] = useState<BrowseTarget>("edgesynology1");
  const [rootPath, setRootPath] = useState("");
  const [namePattern, setNamePattern] = useState("*.xls*");
  const [entryType, setEntryType] = useState<EntryType>("file");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [maxDepth, setMaxDepth] = useState(0);
  const [maxResults, setMaxResults] = useState(500);
  const [includeMetadata, setIncludeMetadata] = useState(false);
  const [loading, setLoading] = useState(false);
  const [treeLoading, setTreeLoading] = useState("");
  const [error, setError] = useState("");
  const [treeError, setTreeError] = useState("");
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "/": true });
  const [childrenByPath, setChildrenByPath] = useState<Record<string, TreeEntry[]>>({});

  const totalMatches = useMemo(
    () => response?.results.reduce((sum, result) => sum + result.matches.length, 0) ?? 0,
    [response],
  );

  const selectedLabel = rootPath || "All mounted volumes";

  const loadTree = useCallback(
    async (path: string) => {
      const normalized = path || "/";
      const key = treeKey(browseTarget, normalized);

      setTreeLoading(key);
      setTreeError("");
      try {
        const params = new URLSearchParams({ target: browseTarget, path: normalized });
        const res = await fetch(`/api/files/tree?${params.toString()}`);
        const data = (await res.json().catch(() => ({}))) as TreeResponse;
        if (!res.ok) throw new Error(data.error ?? `Failed to load folder tree (${res.status})`);
        setChildrenByPath((current) => ({ ...current, [key]: data.entries ?? [] }));
      } catch (err) {
        setTreeError(err instanceof Error ? err.message : "Failed to load folder tree.");
      } finally {
        setTreeLoading("");
      }
    },
    [browseTarget],
  );

  useEffect(() => {
    if (target !== "both") setBrowseTarget(target);
  }, [target]);

  useEffect(() => {
    setExpanded({ "/": true });
    setChildrenByPath({});
    void loadTree("/");
  }, [browseTarget, loadTree]);

  async function runSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResponse(null);

    try {
      const res = await fetch("/api/files/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          root_path: rootPath,
          name_pattern: namePattern,
          entry_type: entryType,
          case_sensitive: caseSensitive,
          max_depth: maxDepth,
          max_results: maxResults,
          include_synology_metadata: includeMetadata,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as SearchResponse;
      if (!res.ok) throw new Error(data.error ?? `Search failed with HTTP ${res.status}`);
      setResponse(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setLoading(false);
    }
  }

  function toggleFolder(path: string) {
    const normalized = path || "/";
    const key = treeKey(browseTarget, normalized);
    const nextExpanded = !expanded[normalized];
    setExpanded((current) => ({ ...current, [normalized]: nextExpanded }));
    if (nextExpanded && !childrenByPath[key]) void loadTree(normalized);
  }

  function renderTreeNodes(entries: TreeEntry[], level: number): ReactNode[] {
    return entries.map((entry) => {
      const isExpanded = expanded[entry.path] === true;
      const key = treeKey(browseTarget, entry.path);
      const children = childrenByPath[key] ?? [];
      const isSelected = rootPath === entry.path;
      const isLoading = treeLoading === key;

      return (
        <div key={entry.path}>
          <div
            className={cn(
              "grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted",
            )}
            style={{ paddingLeft: `${8 + level * 18}px` }}
          >
            <button
              type="button"
              onClick={() => toggleFolder(entry.path)}
              className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-background"
              aria-label={isExpanded ? "Collapse folder" : "Expand folder"}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setRootPath(entry.path)}
              className="flex min-w-0 items-center gap-2 text-left"
            >
              {isExpanded ? <FolderOpen className="h-4 w-4 shrink-0" /> : <Folder className="h-4 w-4 shrink-0" />}
              <span className="truncate">{entry.name}</span>
            </button>
            <span className="hidden text-xs text-muted-foreground md:inline">{entry.owner_group}</span>
          </div>
          {isExpanded && children.length > 0 && renderTreeNodes(children, level + 1)}
        </div>
      );
    });
  }

  const rootChildren = childrenByPath[treeKey(browseTarget, "/")] ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">File Search</h1>
          <p className="mt-1 text-sm text-muted-foreground">Live filename glob search across NAS volumes.</p>
        </div>
        <div className="rounded-full border border-border bg-card px-3 py-1 text-xs text-muted-foreground">
          {totalMatches} matches
        </div>
      </div>

      <form onSubmit={runSearch} className="rounded-lg border border-border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-[190px_minmax(220px,1fr)_140px]">
          <label className="text-sm">
            <span className="mb-1 flex items-center gap-2 text-muted-foreground">
              <Database className="h-4 w-4" />
              Search Target
            </span>
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value as Target)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              {targetOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 flex items-center gap-2 text-muted-foreground">
              <Search className="h-4 w-4" />
              Filename Glob
            </span>
            <input
              value={namePattern}
              onChange={(event) => setNamePattern(event.target.value)}
              placeholder="*pattern*.xls*"
              className="h-10 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
              required
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Type</span>
            <select
              value={entryType}
              onChange={(event) => setEntryType(event.target.value as EntryType)}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              {entryTypeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-4 rounded-md border border-border bg-background">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-3">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Search Root</div>
              <div className="truncate font-mono text-sm">{selectedLabel}</div>
            </div>
            <div className="flex items-center gap-2">
              {target === "both" && (
                <select
                  value={browseTarget}
                  onChange={(event) => setBrowseTarget(event.target.value as BrowseTarget)}
                  className="h-9 rounded-md border border-border bg-card px-3 text-sm"
                >
                  {browseTargetOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={() => setRootPath("")}
                className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-muted"
              >
                <HardDrive className="h-4 w-4" />
                All Volumes
              </button>
            </div>
          </div>

          <div className="max-h-[360px] overflow-auto p-2">
            <div
              className={cn(
                "grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                rootPath === "" ? "bg-primary/10 text-primary" : "hover:bg-muted",
              )}
            >
              <button
                type="button"
                onClick={() => toggleFolder("/")}
                className="flex h-7 w-7 items-center justify-center rounded-md hover:bg-background"
                aria-label={expanded["/"] ? "Collapse mounted volumes" : "Expand mounted volumes"}
              >
                {treeLoading === treeKey(browseTarget, "/") ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : expanded["/"] ? (
                  <ChevronDown className="h-4 w-4" />
                ) : (
                  <ChevronRight className="h-4 w-4" />
                )}
              </button>
              <button type="button" onClick={() => setRootPath("")} className="flex min-w-0 items-center gap-2 text-left">
                <HardDrive className="h-4 w-4 shrink-0" />
                <span className="truncate">All mounted volumes</span>
              </button>
              <span className="hidden text-xs text-muted-foreground md:inline">{browseTarget}</span>
            </div>

            {expanded["/"] && (
              <div className="mt-1">
                {rootChildren.length > 0 ? (
                  renderTreeNodes(rootChildren, 1)
                ) : treeLoading ? (
                  <div className="px-3 py-3 text-sm text-muted-foreground">Loading folders...</div>
                ) : (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No mounted folders found.</div>
                )}
              </div>
            )}
          </div>
        </div>

        {treeError && (
          <div className="mt-3 flex items-start gap-3 rounded-md border border-critical/30 bg-critical/5 p-3 text-sm text-critical">
            <AlertCircle className="mt-0.5 h-4 w-4" />
            <span>{treeError}</span>
          </div>
        )}

        <div className="mt-4 grid gap-3 md:grid-cols-[170px_170px_1fr_auto]">
          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Max Depth</span>
            <input
              type="number"
              min={0}
              max={30}
              value={maxDepth}
              onChange={(event) => setMaxDepth(Number(event.target.value))}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-muted-foreground">Max Results</span>
            <input
              type="number"
              min={1}
              max={2000}
              value={maxResults}
              onChange={(event) => setMaxResults(Number(event.target.value))}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            />
          </label>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
              <input
                type="checkbox"
                checked={caseSensitive}
                onChange={(event) => setCaseSensitive(event.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              <CaseSensitive className="h-4 w-4 text-muted-foreground" />
              Case sensitive
            </label>

            <label className="flex h-10 items-center gap-2 rounded-md border border-border bg-background px-3 text-sm">
              <input
                type="checkbox"
                checked={includeMetadata}
                onChange={(event) => setIncludeMetadata(event.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Include Synology metadata
            </label>
          </div>

          <button
            type="submit"
            disabled={loading || !namePattern.trim()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-60"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileSearch className="h-4 w-4" />}
            Search
          </button>
        </div>
      </form>

      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-critical/30 bg-critical/5 p-4 text-sm text-critical">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <span>{error}</span>
        </div>
      )}

      {response && (
        <div className="space-y-4">
          {response.results.map((result) => (
            <section key={result.target} className="rounded-lg border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div>
                  <h2 className="font-semibold">{result.target}</h2>
                  <p className="text-xs text-muted-foreground">exit {result.exit_code}</p>
                </div>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-medium",
                    result.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-critical/10 text-critical",
                  )}
                >
                  {result.matches.length} matches
                </span>
              </div>

              {result.stderr && (
                <pre className="border-b border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {result.stderr}
                </pre>
              )}

              {result.matches.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No matches.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[820px] text-left text-sm">
                    <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="px-4 py-3 font-medium">Name</th>
                        <th className="px-4 py-3 font-medium">Size</th>
                        <th className="px-4 py-3 font-medium">Modified</th>
                        <th className="px-4 py-3 font-medium">Owner</th>
                        <th className="px-4 py-3 font-medium">Path</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.matches.map((match) => (
                        <tr key={`${result.target}:${match.path}`} className="border-b border-border/60 last:border-0">
                          <td className="px-4 py-3 font-medium">{basename(match.path)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{formatSize(match.size_bytes)}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{match.modified_at}</td>
                          <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{match.owner_group}</td>
                          <td className="px-4 py-3 font-mono text-xs">{match.path}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
