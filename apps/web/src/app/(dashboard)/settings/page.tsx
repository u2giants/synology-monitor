"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { useNasUnits } from "@/hooks/use-nas-units";
import { Settings, Bell, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

export default function SettingsPage() {
  const { units } = useNasUnits();
  const [pushEnabled, setPushEnabled] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if ("Notification" in window) {
      setPushEnabled(Notification.permission === "granted");
    }
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
