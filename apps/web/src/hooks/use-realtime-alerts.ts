"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Alert } from "@synology-monitor/shared";

export function useRealtimeAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // Initial fetch
    async function fetchAlerts() {
      const { data, error } = await supabase
        .from("smon_alerts")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false })
        .limit(50);

      if (!error && data) {
        setAlerts(data as Alert[]);
      }
      setLoading(false);
    }

    fetchAlerts();

    // Subscribe to realtime changes
    const channel = supabase
      .channel("smon-alerts")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "smon_alerts",
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newAlert = payload.new as Alert;
            setAlerts((prev) => [newAlert, ...prev]);

            // Trigger push notification for critical alerts
            if (newAlert.severity === "critical" && Notification.permission === "granted") {
              new Notification(`CRITICAL: ${newAlert.title}`, {
                body: newAlert.message,
                icon: "/icon-192.png",
                tag: newAlert.id,
              });
            }
          } else if (payload.eventType === "UPDATE") {
            const updated = payload.new as Alert;
            setAlerts((prev) =>
              prev.map((a) => (a.id === updated.id ? updated : a))
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return { alerts, loading };
}
