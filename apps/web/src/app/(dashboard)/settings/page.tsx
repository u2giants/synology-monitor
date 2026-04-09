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

type ModelOption = { id: string; name: string };
type ModelSettingsState = Record<string, string>;

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

const ALL_MODEL_KEYS = [...STAGE_MODEL_FIELDS, ...LEGACY_MODEL_FIELDS].map((field) => field.key);

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
                (STAGE_MODEL_FIELDS.find((field) => field.key === key)?.placeholder
                  || LEGACY_MODEL_FIELDS.find((field) => field.key === key)?.placeholder
                  || ""),
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
  }, []);

  const stageFields = useMemo(() => STAGE_MODEL_FIELDS, []);
  const legacyFields = useMemo(() => LEGACY_MODEL_FIELDS, []);

  function updateModel(key: string, value: string) {
    setModelSettings((current) => ({
      ...current,
      [key]: value,
    }));
    setModelsSaved(false);
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

        await supabase.from("smon_push_subscriptions").upsert({
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
                  onChange={(value) => updateModel(field.key, value)}
                />
              </div>
            ))}

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

function ModelSelect({
  value,
  models,
  placeholder,
  onChange,
}: {
  value: string;
  models: { id: string; name: string }[];
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
    </div>
  );
}
