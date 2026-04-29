"use client";

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useNasUnits } from "@/hooks/use-nas-units";
import {
  Settings,
  Bell,
  Brain,
  LogOut,
  Check,
  Loader2,
  ChevronDown,
} from "lucide-react";
import { useRouter } from "next/navigation";

type ModelOption = {
  id: string;
  name: string;
  context_length?: number | null;
  pricing?: Record<string, unknown> | null;
  supported_parameters?: string[];
  supports_reasoning?: boolean;
};
type ModelRecommendation = {
  model: ModelOption;
  capability: number;
  estimated_full_million_cost: number;
  value: number;
};
type RecommendationBuckets = {
  planner: ModelRecommendation[];
  deep_investigation: ModelRecommendation[];
  explainer: ModelRecommendation[];
};
type ModelSettingsState = Record<string, string>;
type ReasoningOption = "auto" | "minimal" | "low" | "medium" | "high";

const STAGE_MODEL_FIELDS = [
  {
    key: "extractor_model",
    label: "Evidence Extraction",
    description: "Turns noisy telemetry into typed facts. Best fit is cheap, fast, strict JSON output.",
    placeholder: "minimax/minimax-m2.7",
  },
  {
    key: "cluster_model",
    label: "Issue Clustering",
    description: "Groups repeated events into one issue thread. Best fit is cheap/medium semantic grouping.",
    placeholder: "minimax/minimax-m2.7",
  },
  {
    key: "hypothesis_model",
    label: "Hypothesis Ranking",
    description: "Chooses the best current explanation and confidence. This should be the strongest reasoning model.",
    placeholder: "openai/gpt-5.4",
  },
  {
    key: "planner_model",
    label: "Next-Step Planning",
    description: "Selects one next diagnostic or one blocked/user-question outcome.",
    placeholder: "openai/gpt-5.4",
  },
  {
    key: "remediation_planner_model",
    label: "Remediation Planning",
    description: "Refines a concrete fix proposal with exact target, risk, and rollback.",
    placeholder: "openai/gpt-5.4",
  },
  {
    key: "explainer_model",
    label: "Operator Explanation",
    description: "Writes the concise operator-facing update for the issue thread.",
    placeholder: "minimax/minimax-m2.7",
  },
  {
    key: "verifier_model",
    label: "Verification",
    description: "Judges whether the last action helped, failed, or was inconclusive.",
    placeholder: "openai/gpt-5.4",
  },
] as const;

const STAGE_REASONING_FIELDS = [
  {
    key: "hypothesis_reasoning_effort",
    label: "Hypothesis Reasoning",
    description: "How much extra reasoning budget to spend when ranking the current best explanation.",
    placeholder: "medium",
  },
  {
    key: "planner_reasoning_effort",
    label: "Planning Reasoning",
    description: "How much reasoning to spend choosing the next investigation or remediation step.",
    placeholder: "medium",
  },
  {
    key: "remediation_planner_reasoning_effort",
    label: "Remediation Reasoning",
    description: "Reasoning budget for refining an exact fix proposal with rollback and risk.",
    placeholder: "medium",
  },
  {
    key: "verifier_reasoning_effort",
    label: "Verification Reasoning",
    description: "Reasoning budget for judging whether the latest action actually helped.",
    placeholder: "medium",
  },
] as const;

const DEEP_MODE_FIELDS = [
  {
    key: "deep_mode_model_override",
    label: "Deep Investigation Model Override",
    description: "Optional stronger model to use when deep mode is active. Leave blank to keep stage-specific models.",
    placeholder: "",
  },
  {
    key: "deep_mode_reasoning_override",
    label: "Deep Investigation Reasoning Override",
    description: "Default reasoning effort when deep mode escalates reasoning-sensitive stages.",
    placeholder: "high",
  },
  {
    key: "deep_mode_max_messages",
    label: "Deep Investigation Max Messages",
    description: "Upper bound for retained user/agent conversation turns in deep mode.",
    placeholder: "80",
  },
  {
    key: "deep_mode_max_evidence",
    label: "Deep Investigation Max Evidence",
    description: "Upper bound for retained evidence items in deep mode before rebasing is considered.",
    placeholder: "150",
  },
  {
    key: "context_rebase_threshold_pct",
    label: "Context Rebase Threshold (%)",
    description: "When estimated prompt pressure reaches this threshold, the app should propose a fresh working session with an investigation brief.",
    placeholder: "80",
  },
  {
    key: "deep_mode_include_raw_logs",
    label: "Include Raw Logs In Deep Mode",
    description: "Whether deep mode should preserve larger raw-log excerpts instead of only normalized facts.",
    placeholder: "true",
  },
] as const;

const ESCALATION_FIELDS = [
  {
    key: "escalation_policy",
    label: "Escalation Policy",
    description: "Controls whether the app asks before spending more on model, reasoning, or context escalation.",
    placeholder: "ask_always",
  },
  {
    key: "escalation_turn_budget_usd",
    label: "Per-Turn Escalation Budget (USD)",
    description: "Maximum estimated extra cost the app may request or auto-approve for a single turn.",
    placeholder: "0.25",
  },
  {
    key: "escalation_issue_budget_usd",
    label: "Per-Issue Escalation Budget (USD)",
    description: "Maximum estimated extra cost the app may request or auto-approve across a whole investigation.",
    placeholder: "2.00",
  },
] as const;

const LEGACY_MODEL_FIELDS = [
  {
    key: "diagnosis_model",
    label: "Legacy Diagnosis Model",
    description: "Compatibility fallback for older code paths and detection-era settings.",
    placeholder: "minimax/minimax-m2.7",
  },
  {
    key: "remediation_model",
    label: "Legacy Remediation Model",
    description: "Compatibility fallback for older remediation paths and shared defaults.",
    placeholder: "openai/gpt-5.4",
  },
  {
    key: "second_opinion_model",
    label: "Second Opinion Model",
    description: "Optional fallback when a stronger cross-check is needed.",
    placeholder: "anthropic/claude-sonnet-4",
  },
] as const;

const ALL_MODEL_KEYS = [
  ...STAGE_MODEL_FIELDS,
  ...LEGACY_MODEL_FIELDS,
  ...STAGE_REASONING_FIELDS,
  ...DEEP_MODE_FIELDS,
  ...ESCALATION_FIELDS,
].map((field) => field.key);

const ALL_SETTING_FIELDS = [
  ...STAGE_MODEL_FIELDS,
  ...LEGACY_MODEL_FIELDS,
  ...STAGE_REASONING_FIELDS,
  ...DEEP_MODE_FIELDS,
  ...ESCALATION_FIELDS,
];

const REASONING_OPTIONS: Array<{ value: ReasoningOption; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const ESCALATION_OPTIONS = [
  { value: "ask_always", label: "Ask Always" },
  { value: "auto_approve_read_only_under_budget", label: "Auto-Approve Read-Only Under Budget" },
  { value: "manual_for_model_switch_auto_for_reasoning", label: "Manual Model Switch / Auto Reasoning" },
] as const;

const REASONING_MODEL_MAP: Record<string, string> = {
  hypothesis_reasoning_effort: "hypothesis_model",
  planner_reasoning_effort: "planner_model",
  remediation_planner_reasoning_effort: "remediation_planner_model",
  verifier_reasoning_effort: "verifier_model",
  deep_mode_reasoning_override: "deep_mode_model_override",
};

const BOOLEAN_OPTIONS = [
  { value: "true", label: "Enabled" },
  { value: "false", label: "Disabled" },
] as const;

const MODEL_BUCKET_BY_KEY: Record<string, keyof RecommendationBuckets> = {
  hypothesis_model: "planner",
  planner_model: "planner",
  remediation_planner_model: "planner",
  verifier_model: "planner",
  deep_mode_model_override: "deep_investigation",
  explainer_model: "explainer",
};

function buildInitialState() {
  return Object.fromEntries(ALL_MODEL_KEYS.map((key) => [key, ""])) as ModelSettingsState;
}

export default function SettingsPage() {
  const { units } = useNasUnits();
  const [pushEnabled, setPushEnabled] = useState(false);
  const [modelSettings, setModelSettings] = useState<ModelSettingsState>(buildInitialState);
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsSaved, setModelsSaved] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [recommendedModels, setRecommendedModels] = useState<ModelRecommendation[]>([]);
  const [recommendationBuckets, setRecommendationBuckets] = useState<RecommendationBuckets | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [showLegacyModels, setShowLegacyModels] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if ("Notification" in window) {
      setPushEnabled(Notification.permission === "granted");
    }

    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (!data.settings) return;
        setModelSettings((current) => ({
          ...current,
          ...Object.fromEntries(
            ALL_MODEL_KEYS.map((key) => [
              key,
              data.settings[key] ??
                current[key] ??
                (ALL_SETTING_FIELDS.find((field) => field.key === key)?.placeholder || ""),
            ]),
          ),
        }));
      })
      .catch(() => {});

    fetch("/api/models")
      .then((res) => res.json())
      .then((data) => {
        setAvailableModels(data.models ?? []);
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));

    fetch("/api/models/recommendations?limit=5&minCapabilityScore=5")
      .then((res) => res.json())
      .then((data) => {
        setRecommendedModels(data.recommendations ?? []);
      })
      .catch(() => {});

    fetch("/api/models/recommendations?limit=5&bucketed=true")
      .then((res) => res.json())
      .then((data) => {
        setRecommendationBuckets(data.buckets ?? null);
      })
      .catch(() => {});
  }, []);

  const stageFields = useMemo(() => STAGE_MODEL_FIELDS, []);
  const stageReasoningFields = useMemo(() => STAGE_REASONING_FIELDS, []);
  const deepModeFields = useMemo(() => DEEP_MODE_FIELDS, []);
  const escalationFields = useMemo(() => ESCALATION_FIELDS, []);
  const legacyFields = useMemo(() => LEGACY_MODEL_FIELDS, []);

  function updateModel(key: string, value: string) {
    setModelSettings((current) => ({
      ...current,
      [key]: value,
    }));
    setModelsSaved(false);
  }

  function getReasoningOptions(settingKey: string) {
    const modelKey = REASONING_MODEL_MAP[settingKey];
    const selectedModelId = modelKey ? modelSettings[modelKey] : "";
    const selectedModel = availableModels.find((model) => model.id === selectedModelId);
    if (selectedModel?.supports_reasoning === false) {
      return REASONING_OPTIONS.filter((option) => option.value === "auto");
    }
    return REASONING_OPTIONS;
  }

  function getSuggestedModels(settingKey: string) {
    const bucketKey = MODEL_BUCKET_BY_KEY[settingKey];
    if (!bucketKey || !recommendationBuckets) return [] as ModelRecommendation[];
    return recommendationBuckets[bucketKey].slice(0, 3);
  }

  async function enableNotifications() {
    if (!("Notification" in window)) {
      alert("Notifications not supported in this browser");
      return;
    }

    const permission = await Notification.requestPermission();
    setPushEnabled(permission === "granted");

    if (permission === "granted") {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        });

        const supabase = createClient();
        const p256dh = btoa(
          String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!)),
        );
        const auth = btoa(
          String.fromCharCode(...new Uint8Array(sub.getKey("auth")!)),
        );

        await supabase.from("push_subscriptions").upsert({
          endpoint: sub.endpoint,
          p256dh,
          auth,
          user_agent: navigator.userAgent,
        });
      }
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  async function saveModels() {
    setModelsSaving(true);
    setModelsSaved(false);
    try {
      await Promise.all(
        ALL_MODEL_KEYS.map((key) =>
          fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key, value: modelSettings[key] }),
          }),
        ),
      );
      setModelsSaved(true);
    } catch {
      alert("Failed to save model settings.");
    } finally {
      setModelsSaving(false);
    }
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center gap-2">
        <Settings className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold mb-3">Registered NAS Units</h2>
        {units.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No NAS units registered. Deploy the agent to register automatically.
          </p>
        ) : (
          <div className="space-y-2">
            {units.map((unit) => (
              <div key={unit.id} className="flex items-center justify-between rounded-md bg-muted/30 px-3 py-2">
                <div>
                  <span className="font-medium text-sm">{unit.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">{unit.model}</span>
                </div>
                <code className="text-xs text-muted-foreground">{unit.id}</code>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <Brain className="h-4 w-4" />
          Stage Models
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          Configure the model used for each model-driven stage of the issue workflow. Use OpenRouter model IDs from{" "}
          <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-primary underline">
            openrouter.ai/models
          </a>.
        </p>

        {modelsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading available models from OpenRouter...
          </div>
        ) : (
          <div className="space-y-5">
            {stageFields.map((field) => (
              <div key={field.key}>
                <label className="block text-sm font-medium mb-1">{field.label}</label>
                <p className="mb-2 text-xs text-muted-foreground">{field.description}</p>
                <ModelSelect
                  value={modelSettings[field.key]}
                  placeholder={field.placeholder}
                  models={availableModels}
                  suggestedModels={getSuggestedModels(field.key)}
                  onChange={(value) => updateModel(field.key, value)}
                />
              </div>
            ))}

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-sm font-medium">Reasoning controls</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Use higher reasoning where it materially improves investigation quality. Not all models honor every level; unsupported levels may map to the nearest supported effort.
              </div>
              <div className="mt-4 space-y-4">
                {stageReasoningFields.map((field) => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium mb-1">{field.label}</label>
                    <p className="mb-2 text-xs text-muted-foreground">{field.description}</p>
                    <SelectSetting
                      value={modelSettings[field.key] || field.placeholder}
                      options={getReasoningOptions(field.key)}
                      onChange={(value) => updateModel(field.key, value)}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-sm font-medium">Deep investigation defaults</div>
              <div className="mt-1 text-xs text-muted-foreground">
                These defaults control how aggressively the app expands context and reasoning when a case is complex.
              </div>
              <div className="mt-4 space-y-4">
                {deepModeFields.map((field) => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium mb-1">{field.label}</label>
                    <p className="mb-2 text-xs text-muted-foreground">{field.description}</p>
                    {field.key === "deep_mode_model_override" ? (
                      <ModelSelect
                        value={modelSettings[field.key]}
                        placeholder={field.placeholder}
                        models={availableModels}
                        suggestedModels={getSuggestedModels(field.key)}
                        onChange={(value) => updateModel(field.key, value)}
                      />
                    ) : field.key === "deep_mode_reasoning_override" ? (
                      <SelectSetting
                        value={modelSettings[field.key] || field.placeholder}
                        options={getReasoningOptions(field.key)}
                        onChange={(value) => updateModel(field.key, value)}
                      />
                    ) : field.key === "deep_mode_include_raw_logs" ? (
                      <SelectSetting
                        value={modelSettings[field.key] || field.placeholder}
                        options={BOOLEAN_OPTIONS}
                        onChange={(value) => updateModel(field.key, value)}
                      />
                    ) : (
                      <input
                        type="text"
                        value={modelSettings[field.key]}
                        onChange={(event) => updateModel(field.key, event.target.value)}
                        placeholder={field.placeholder}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <div className="text-sm font-medium">Escalation policy</div>
              <div className="mt-1 text-xs text-muted-foreground">
                The app should ask before higher spend unless you explicitly allow automatic read-only escalation under budget.
              </div>
              <div className="mt-4 space-y-4">
                {escalationFields.map((field) => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium mb-1">{field.label}</label>
                    <p className="mb-2 text-xs text-muted-foreground">{field.description}</p>
                    {field.key === "escalation_policy" ? (
                      <SelectSetting
                        value={modelSettings[field.key] || field.placeholder}
                        options={ESCALATION_OPTIONS}
                        onChange={(value) => updateModel(field.key, value)}
                      />
                    ) : (
                      <input
                        type="text"
                        value={modelSettings[field.key]}
                        onChange={(event) => updateModel(field.key, event.target.value)}
                        placeholder={field.placeholder}
                        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {(recommendedModels.length > 0 || recommendationBuckets) && (
              <div className="rounded-lg border border-border bg-muted/20 p-4">
                <div className="text-sm font-medium">Best-value OpenRouter candidates</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  These are filtered above the current capability floor, then ranked by capability relative to price. Use them as starting points for planner, hypothesis, verifier, or deep-mode overrides.
                </div>
                {recommendationBuckets && (
                  <div className="mt-4 grid gap-4 lg:grid-cols-3">
                    <RecommendationBucketCard
                      title="Planner / Hypothesis"
                      description="Good value for reasoning-heavy stage models."
                      entries={recommendationBuckets.planner}
                    />
                    <RecommendationBucketCard
                      title="Deep Investigation"
                      description="Higher-capability candidates worth using when ambiguity is expensive."
                      entries={recommendationBuckets.deep_investigation}
                    />
                    <RecommendationBucketCard
                      title="Explainer"
                      description="Cheaper operator-facing models above the capability floor."
                      entries={recommendationBuckets.explainer}
                    />
                  </div>
                )}
                {recommendedModels.length > 0 && (
                  <div className="mt-4 space-y-3">
                    {recommendedModels.map((entry) => (
                      <div key={entry.model.id} className="rounded-md border border-border bg-background px-3 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-medium">{entry.model.name}</div>
                            <div className="text-xs text-muted-foreground">{entry.model.id}</div>
                          </div>
                          <div className="text-right text-xs text-muted-foreground">
                            <div>Capability score: {entry.capability}</div>
                            <div>
                              1M in + 1M out est.: {Number.isFinite(entry.estimated_full_million_cost) ? `$${entry.estimated_full_million_cost.toFixed(2)}` : "unknown"}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <button
                type="button"
                onClick={() => setShowLegacyModels((value) => !value)}
                className="flex w-full items-center justify-between text-left"
              >
                <div>
                  <div className="text-sm font-medium">Legacy / compatibility model settings</div>
                  <div className="text-xs text-muted-foreground">
                    Older fallback keys still used by compatibility paths and defaults.
                  </div>
                </div>
                <ChevronDown className={`h-4 w-4 transition-transform ${showLegacyModels ? "rotate-180" : ""}`} />
              </button>

              {showLegacyModels && (
                <div className="mt-4 space-y-4">
                  {legacyFields.map((field) => (
                    <div key={field.key}>
                      <label className="block text-sm font-medium mb-1">{field.label}</label>
                      <p className="mb-2 text-xs text-muted-foreground">{field.description}</p>
                      <ModelSelect
                        value={modelSettings[field.key]}
                        placeholder={field.placeholder}
                        models={availableModels}
                        suggestedModels={getSuggestedModels(field.key)}
                        onChange={(value) => updateModel(field.key, value)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>

            <button
              disabled={modelsSaving}
              onClick={saveModels}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {modelsSaved ? <Check className="h-4 w-4" /> : null}
              {modelsSaving ? "Saving..." : modelsSaved ? "Saved" : "Save Models"}
            </button>
          </div>
        )}
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold mb-3 flex items-center gap-2">
          <Bell className="h-4 w-4" />
          Push Notifications
        </h2>
        {pushEnabled ? (
          <p className="text-sm text-success">Notifications are enabled</p>
        ) : (
          <div>
            <p className="text-sm text-muted-foreground mb-3">
              Enable push notifications to receive alerts for critical events.
            </p>
            <button
              onClick={enableNotifications}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Enable Notifications
            </button>
          </div>
        )}
      </section>

      <section>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-muted-foreground hover:text-foreground hover:border-foreground/20 transition-colors"
        >
          <LogOut className="h-4 w-4" />
          Sign Out
        </button>
      </section>
    </div>
  );
}

function SelectSetting({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function ModelSelect({
  value,
  models,
  suggestedModels,
  placeholder,
  onChange,
}: {
  value: string;
  models: { id: string; name: string }[];
  suggestedModels?: ModelRecommendation[];
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      />

      <select
        value=""
        onChange={(event) => {
          if (event.target.value) onChange(event.target.value);
        }}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
      >
        <option value="">Pick from available models…</option>
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name} ({model.id})
          </option>
        ))}
      </select>

      {suggestedModels && suggestedModels.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestedModels.map((entry) => (
            <button
              key={entry.model.id}
              type="button"
              onClick={() => onChange(entry.model.id)}
              className="rounded-full border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              title={`${entry.model.id} · score ${entry.capability} · est. ${Number.isFinite(entry.estimated_full_million_cost) ? `$${entry.estimated_full_million_cost.toFixed(2)}` : "unknown"} / 1M in + 1M out`}
            >
              {entry.model.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function RecommendationBucketCard({
  title,
  description,
  entries,
}: {
  title: string;
  description: string;
  entries: ModelRecommendation[];
}) {
  return (
    <div className="rounded-md border border-border bg-background p-3">
      <div className="text-sm font-medium">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{description}</div>
      <div className="mt-3 space-y-2">
        {entries.length === 0 ? (
          <div className="text-xs text-muted-foreground">No matching models available.</div>
        ) : (
          entries.map((entry) => (
            <div key={entry.model.id} className="rounded-md border border-border/70 px-2 py-2">
              <div className="text-xs font-medium">{entry.model.name}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">{entry.model.id}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                score {entry.capability} · est. {Number.isFinite(entry.estimated_full_million_cost) ? `$${entry.estimated_full_million_cost.toFixed(2)}` : "unknown"} / 1M in + 1M out
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
