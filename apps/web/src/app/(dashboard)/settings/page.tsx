"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useNasUnits } from "@/hooks/use-nas-units";
import { Settings, Bell, Brain, LogOut, Check, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";

export default function SettingsPage() {
  const { units } = useNasUnits();
  const [pushEnabled, setPushEnabled] = useState(false);
  const [diagnosisModel, setDiagnosisModel] = useState("");
  const [remediationModel, setRemediationModel] = useState("");
  const [modelsSaving, setModelsSaving] = useState(false);
  const [modelsSaved, setModelsSaved] = useState(false);
  const [availableModels, setAvailableModels] = useState<{ id: string; name: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    if ("Notification" in window) {
      setPushEnabled(Notification.permission === "granted");
    }
    // Load AI model settings
    fetch("/api/settings")
      .then((res) => res.json())
      .then((data) => {
        if (data.settings) {
          setDiagnosisModel(data.settings.diagnosis_model ?? "minimax/minimax-m2.7");
          setRemediationModel(data.settings.remediation_model ?? "openai/gpt-5.4");
        }
      })
      .catch(() => {});

    // Load available models from OpenRouter
    fetch("https://openrouter.ai/api/v1/models")
      .then((res) => res.json())
      .then((data) => {
        const models = (data.data ?? [])
          .map((m: { id: string; name: string }) => ({ id: m.id, name: m.name }))
          .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
        setAvailableModels(models);
      })
      .catch(() => {})
      .finally(() => setModelsLoading(false));
  }, []);

  async function enableNotifications() {
    if (!("Notification" in window)) {
      alert("Notifications not supported in this browser");
      return;
    }

    const permission = await Notification.requestPermission();
    setPushEnabled(permission === "granted");

    if (permission === "granted") {
      // Register service worker and subscribe
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.register("/sw.js");
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
        });

        // Save subscription to Supabase
        const supabase = createClient();
        const p256dh = btoa(
          String.fromCharCode(...new Uint8Array(sub.getKey("p256dh")!))
        );
        const auth = btoa(
          String.fromCharCode(...new Uint8Array(sub.getKey("auth")!))
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

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-2">
        <Settings className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Settings</h1>
      </div>

      {/* NAS Units */}
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

      {/* AI Models */}
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          <Brain className="h-4 w-4" />
          AI Models
        </h2>
        <p className="text-xs text-muted-foreground mb-4">
          Choose which models to use through OpenRouter. Use the model ID format from{" "}
          <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-primary underline">
            openrouter.ai/models
          </a>{" "}
          (e.g. &quot;minimax/minimax-m2.7&quot;, &quot;openai/gpt-4.1&quot;, &quot;anthropic/claude-sonnet-4&quot;).
        </p>

        {modelsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading available models from OpenRouter...
          </div>
        ) : (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">
              Diagnosis Model
              <span className="font-normal text-muted-foreground ml-1">(reads logs, analyzes errors, groups by root cause)</span>
            </label>
            <ModelSelect
              value={diagnosisModel}
              models={availableModels}
              onChange={(v) => { setDiagnosisModel(v); setModelsSaved(false); }}
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-1">
              Remediation Model
              <span className="font-normal text-muted-foreground ml-1">(proposes fixes, runs in NAS Copilot)</span>
            </label>
            <ModelSelect
              value={remediationModel}
              models={availableModels}
              onChange={(v) => { setRemediationModel(v); setModelsSaved(false); }}
            />
          </div>

          <button
            disabled={modelsSaving}
            onClick={async () => {
              setModelsSaving(true);
              setModelsSaved(false);
              try {
                await Promise.all([
                  fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "diagnosis_model", value: diagnosisModel }),
                  }),
                  fetch("/api/settings", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ key: "remediation_model", value: remediationModel }),
                  }),
                ]);
                setModelsSaved(true);
              } catch {
                alert("Failed to save model settings.");
              } finally {
                setModelsSaving(false);
              }
            }}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {modelsSaved ? <Check className="h-4 w-4" /> : null}
            {modelsSaving ? "Saving..." : modelsSaved ? "Saved" : "Save Models"}
          </button>
        </div>
        )}
      </section>

      {/* Notifications */}
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

      {/* Sign out */}
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
  onChange,
}: {
  value: string;
  models: { id: string; name: string }[];
  onChange: (value: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = search
    ? models.filter(
        (m) =>
          m.id.toLowerCase().includes(search.toLowerCase()) ||
          m.name.toLowerCase().includes(search.toLowerCase())
      )
    : models;

  const selectedName = models.find((m) => m.id === value)?.name;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-left text-sm focus:border-primary focus:outline-none"
      >
        <span className="block truncate">
          {selectedName ? (
            <>
              <span className="font-medium">{selectedName}</span>
              <span className="text-muted-foreground ml-2 text-xs">{value}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{value || "Select a model..."}</span>
          )}
        </span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-card shadow-lg">
          <div className="p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models..."
              autoFocus
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm focus:border-primary focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-sm text-muted-foreground">No models found</div>
            ) : (
              filtered.slice(0, 100).map((model) => (
                <button
                  key={model.id}
                  type="button"
                  onClick={() => {
                    onChange(model.id);
                    setOpen(false);
                    setSearch("");
                  }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 ${
                    model.id === value ? "bg-primary/10 font-medium" : ""
                  }`}
                >
                  <div className="truncate font-medium">{model.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{model.id}</div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
