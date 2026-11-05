"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { mergeActiveAlert } from "@/lib/active-alerts";
import type { Alert } from "@synology-monitor/shared";

export function useRealtimeAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // Initial fetch
    async function fetchAlerts() {
      const { data, error } = await supabase
        .from("alerts")
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
          table: "alerts",
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newAlert = payload.new as Alert;
            setAlerts((prev) => mergeActiveAlert(prev, newAlert));

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
              mergeActiveAlert(prev, updated)
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
