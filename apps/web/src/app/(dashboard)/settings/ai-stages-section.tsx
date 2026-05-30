"use client";

import { useEffect, useState } from "react";
import { Brain, Check, ClipboardCopy, Loader2, WifiOff, X, Zap } from "lucide-react";
import {
  AI_STAGES,
  STAGE_DESCRIPTORS,
  effortLevelsForModel,
  getModelDescriptor,
  modelsForStage,
  type AiStage,
} from "@synology-monitor/shared";

type StageValues = Record<string, string>; // ai_settings key -> value

interface CacheStats {
  overall: { calls: number; cacheHitRatio: number; input: number; cached: number };
  byStage: Record<string, { calls: number; cacheHitRatio: number }>;
  byModel: Array<{ provider: string; model: string; calls: number; cacheHitRatio: number; input: number; cached: number }>;
}

interface NasHealth {
  units: Array<{ name: string; reachable: boolean }>;
  anyOffline: boolean;
}

interface ProviderProbe {
  provider: string;
  model: string;
  keyPresent: boolean;
  ok: boolean;
  keyValid?: boolean;
  latencyMs?: number;
  error?: string;
}

interface IssueOption {
  id: string;
  title: string;
  status: string;
  severity: string;
  pipeline: string;
}

export function AiStagesSection() {
  const [values, setValues] = useState<StageValues>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [health, setHealth] = useState<NasHealth | null>(null);
  const [probe, setProbe] = useState<{ results: ProviderProbe[]; defaultsReady: boolean } | null>(null);
  const [probing, setProbing] = useState(false);
  const [issues, setIssues] = useState<IssueOption[]>([]);
  const [selectedIssue, setSelectedIssue] = useState("");
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        const settings = (data?.settings ?? {}) as StageValues;
        const next: StageValues = {};
        for (const stage of AI_STAGES) {
          const d = STAGE_DESCRIPTORS[stage];
          next[d.modelKey] = settings[d.modelKey] ?? d.fallbackModel;
          next[d.effortKey] = settings[d.effortKey] ?? d.fallbackEffort;
        }
        setValues(next);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetch("/api/ai-usage").then((r) => r.json()).then(setStats).catch(() => {});
    fetch("/api/nas-health").then((r) => r.json()).then(setHealth).catch(() => {});
    fetch("/api/issues").then((r) => r.json()).then((d) => setIssues(d.issues ?? [])).catch(() => {});
  }, []);

  async function runV2() {
    if (!selectedIssue) return;
    setRunning(true);
    setRunResult(null);
    try {
      const res = await fetch(`/api/issues/${selectedIssue}/run-v2`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setRunResult(`Error: ${data.error ?? res.statusText}`);
      } else {
        const t = data.turn;
        setRunResult(
          `Status: ${data.status}` +
            (data.forcedFrom ? ` (forced from ${data.forcedFrom})` : "") +
            (t ? ` · ${t.toolCallCount ?? 0} tool calls${t.reChewed ? " · re-chew guard fired" : ""}` : " · no turn run"),
        );
      }
    } catch (e) {
      setRunResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
    }
  }

  function setModel(stage: AiStage, model: string) {
    const d = STAGE_DESCRIPTORS[stage];
    setValues((cur) => {
      const next = { ...cur, [d.modelKey]: model };
      // If the new model doesn't support the current effort, snap to a valid one.
      const levels = effortLevelsForModel(model);
      if (levels.length > 0 && !levels.includes(next[d.effortKey] as never)) {
        next[d.effortKey] = levels.includes("medium" as never) ? "medium" : levels[0];
      }
      return next;
    });
    setSaved(false);
  }

  function setEffort(stage: AiStage, effort: string) {
    const d = STAGE_DESCRIPTORS[stage];
    setValues((cur) => ({ ...cur, [d.effortKey]: effort }));
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    try {
      const keys = AI_STAGES.flatMap((s) => [STAGE_DESCRIPTORS[s].modelKey, STAGE_DESCRIPTORS[s].effortKey]);
      await Promise.all(
        keys.map((key) =>
          fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value: values[key] }),
          }),
        ),
      );
      setSaved(true);
    } catch {
      alert("Failed to save stage settings.");
    } finally {
      setSaving(false);
    }
  }

  async function testProviders() {
    setProbing(true);
    setProbe(null);
    try {
      const res = await fetch("/api/ai-health");
      const data = await res.json();
      setProbe({ results: data.results ?? [], defaultsReady: !!data.defaultsReady });
    } catch {
      setProbe({ results: [], defaultsReady: false });
    } finally {
      setProbing(false);
    }
  }

  async function copySpec(stage: AiStage) {
    const d = STAGE_DESCRIPTORS[stage];
    const model = values[d.modelKey];
    const desc = getModelDescriptor(model);
    const spec = [
      `# AI stage spec — ${d.label}`,
      ``,
      `Purpose: ${d.purpose}`,
      `Required capabilities: tool_use=${d.requires.toolUse}, structured_output=${d.requires.structuredOutput}`,
      `Current model: ${model}${desc ? ` (provider: ${desc.provider})` : ""}`,
      `Current effort: ${values[d.effortKey]}`,
      `Effort control: ${desc?.effortControl ?? "unknown"}`,
      ``,
      `Question for an external model: which available model best fits this stage,`,
      `given the purpose and required capabilities above? Reply with a provider-native`,
      `model id and a one-line rationale.`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(spec);
      setCopied(stage);
      setTimeout(() => setCopied((c) => (c === stage ? null : c)), 1500);
    } catch {
      /* clipboard may be unavailable; ignore */
    }
  }

  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2">
          <Brain className="h-4 w-4" />
          AI Stages (3-stage pipeline)
        </h2>
        {health?.anyOffline && (
          <span className="inline-flex items-center gap-1 rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-medium text-destructive">
            <WifiOff className="h-3 w-3" />
            NAS offline
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground mb-4">
        Model + reasoning effort for each of the three rebuild stages. Models are filtered to those
        that support each stage&apos;s required capabilities; effort is disabled for models with no
        reasoning knob.
      </p>

      <div className="mb-4">
        <button
          type="button"
          onClick={testProviders}
          disabled={probing}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted/40 disabled:opacity-50"
        >
          {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          {probing ? "Testing providers…" : "Test providers"}
        </button>
        {probe && (
          <div className="mt-3 space-y-1">
            {probe.results.length === 0 && <div className="text-xs text-destructive">Probe failed to run.</div>}
            {probe.results.map((r) => (
              <div key={r.provider} className="flex items-center gap-2 text-xs">
                {r.ok ? (
                  <Check className="h-3.5 w-3.5 text-success" />
                ) : r.keyValid ? (
                  <Check className="h-3.5 w-3.5 text-amber-500" />
                ) : (
                  <X className="h-3.5 w-3.5 text-destructive" />
                )}
                <span className="font-medium w-20">{r.provider}</span>
                <span className="text-muted-foreground">{r.model}</span>
                {r.ok ? (
                  <span className="text-muted-foreground">· {r.latencyMs}ms</span>
                ) : r.keyValid ? (
                  <span className="text-amber-500 truncate">· key valid · {r.error}</span>
                ) : (
                  <span className="text-destructive truncate">
                    · {!r.keyPresent ? "key not set" : r.error}
                  </span>
                )}
              </div>
            ))}
            <div className={`mt-1 text-xs font-medium ${probe.defaultsReady ? "text-success" : "text-amber-500"}`}>
              {probe.defaultsReady
                ? "Default lineup ready (Anthropic + Gemini reachable)."
                : "Default lineup not ready — Anthropic and Gemini must both pass before cutover."}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading stage config…
        </div>
      ) : (
        <div className="space-y-5">
          {AI_STAGES.map((stage) => {
            const d = STAGE_DESCRIPTORS[stage];
            const model = values[d.modelKey] ?? "";
            const options = modelsForStage(stage);
            const effortLevels = effortLevelsForModel(model);
            const stageStat = stats?.byStage?.[stage];
            const known = options.some((m) => m.id === model);
            return (
              <div key={stage} className="rounded-lg border border-border bg-muted/10 p-4">
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-sm font-medium">{d.label}</div>
                  <button
                    type="button"
                    onClick={() => copySpec(stage)}
                    title="Copy an AI-optimized spec of this stage for asking an external model"
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {copied === stage ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
                    {copied === stage ? "Copied" : "Copy spec"}
                  </button>
                </div>
                <p className="mb-3 text-xs text-muted-foreground">{d.purpose}</p>

                <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                  <div>
                    <label className="block text-xs font-medium mb-1 text-muted-foreground">Model</label>
                    <select
                      value={known ? model : ""}
                      onChange={(e) => setModel(stage, e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
                    >
                      {!known && <option value="">{model || "Select a model"}</option>}
                      {options.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label} ({m.provider})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1 text-muted-foreground">Effort</label>
                    <select
                      value={values[d.effortKey] ?? ""}
                      disabled={effortLevels.length === 0}
                      onChange={(e) => setEffort(stage, e.target.value)}
                      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none disabled:opacity-50"
                    >
                      {effortLevels.length === 0 ? (
                        <option value={values[d.effortKey] ?? ""}>n/a (no effort knob)</option>
                      ) : (
                        effortLevels.map((lvl) => (
                          <option key={lvl} value={lvl}>
                            {lvl}
                          </option>
                        ))
                      )}
                    </select>
                  </div>
                </div>

                {stageStat && stageStat.calls > 0 && (
                  <div className="mt-2 text-xs text-muted-foreground">
                    7-day cache hit: {(stageStat.cacheHitRatio * 100).toFixed(0)}% over {stageStat.calls} calls
                  </div>
                )}
              </div>
            );
          })}

          {stats && stats.overall.calls > 0 && (
            <div className="rounded-md bg-muted/20 px-3 py-2 text-xs text-muted-foreground space-y-2">
              <div>
                Overall (7d): {(stats.overall.cacheHitRatio * 100).toFixed(0)}% prompt-cache hit across{" "}
                {stats.overall.calls} model calls ({stats.overall.cached.toLocaleString()} /{" "}
                {stats.overall.input.toLocaleString()} input tokens cached).
              </div>
              {stats.byModel?.length > 0 && (
                <div>
                  <div className="font-medium text-foreground/80 mb-1">Cache hit by model (7d)</div>
                  <div className="space-y-0.5">
                    {stats.byModel.map((m) => (
                      <div key={`${m.provider}/${m.model}`} className="flex items-center gap-2">
                        <span className="w-44 truncate">
                          {m.model} <span className="text-muted-foreground/70">({m.provider})</span>
                        </span>
                        <span className="tabular-nums">{(m.cacheHitRatio * 100).toFixed(0)}%</span>
                        <span className="text-muted-foreground/70">
                          · {m.calls} call{m.calls === 1 ? "" : "s"} · {m.cached.toLocaleString()}/
                          {m.input.toLocaleString()} tok
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          <button
            disabled={saving}
            onClick={save}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saved ? <Check className="h-4 w-4" /> : null}
            {saving ? "Saving…" : saved ? "Saved" : "Save Stage Config"}
          </button>

          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
            <div className="text-sm font-medium mb-1">Validate the new pipeline (v2)</div>
            <p className="mb-3 text-xs text-muted-foreground">
              Run one chosen issue through the 3-stage pipeline without affecting any other issue.
              The issue is opted into v2 and continues on v2 from here. The old pipeline stays the
              default for everything else.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedIssue}
                onChange={(e) => setSelectedIssue(e.target.value)}
                className="min-w-[16rem] flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none"
              >
                <option value="">Select an issue…</option>
                {issues.map((i) => (
                  <option key={i.id} value={i.id}>
                    [{i.status}] {i.title} {i.pipeline === "v2" ? "· v2" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!selectedIssue || running}
                onClick={runV2}
                className="inline-flex items-center gap-2 rounded-md border border-amber-500/40 px-3 py-2 text-sm font-medium hover:bg-amber-500/10 disabled:opacity-50"
              >
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />}
                {running ? "Running turn…" : "Run v2 turn"}
              </button>
            </div>
            {runResult && <div className="mt-2 text-xs text-muted-foreground">{runResult}</div>}
          </div>
        </div>
      )}
    </section>
  );
}
