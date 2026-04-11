"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";
import { Shield, ShieldAlert, Eye, FileWarning } from "lucide-react";
import type { SecurityEvent } from "@synology-monitor/shared";

export default function SecurityPage() {
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    async function fetch() {
      const { data, error } = await supabase
        .from("security_events")
        .select("*")
        .order("detected_at", { ascending: false })
        .limit(100);

      if (!error && data) {
        setEvents(data as SecurityEvent[]);
      }
      setLoading(false);
    }

    fetch();

    // Subscribe to new security events
    const channel = supabase
      .channel("smon-security")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "security_events" },
        (payload) => {
          setEvents((prev) => [payload.new as SecurityEvent, ...prev]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const criticalEvents = events.filter((e) => e.severity === "critical");
  const unacknowledged = events.filter((e) => !e.acknowledged);

  const typeIcons: Record<string, typeof Shield> = {
    mass_file_rename: ShieldAlert,
    high_entropy_file: FileWarning,
    suspicious_file_change: Eye,
    unauthorized_access: ShieldAlert,
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Security</h1>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Events</p>
          <p className="text-2xl font-bold">{events.length}</p>
        </div>
        <div className={cn(
          "rounded-lg border p-4",
          criticalEvents.length > 0 ? "border-critical/30 bg-critical/5" : "border-border bg-card"
        )}>
          <p className="text-sm text-muted-foreground">Critical</p>
          <p className="text-2xl font-bold">{criticalEvents.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Unacknowledged</p>
          <p className="text-2xl font-bold">{unacknowledged.length}</p>
        </div>
      </div>

      {/* Event list */}
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading...</div>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-success/30 bg-success/5 p-8 text-center">
          <Shield className="mx-auto h-12 w-12 text-success mb-3" />
          <p className="text-lg font-semibold text-success">All Clear</p>
          <p className="text-sm text-muted-foreground">No security events detected</p>
        </div>
      ) : (
        <div className="space-y-2">
          {events.map((event) => {
            const Icon = typeIcons[event.type] || Shield;

            return (
              <div
                key={event.id}
                className={cn(
                  "rounded-lg border p-4",
                  event.severity === "critical"
                    ? "border-critical/30 bg-critical/5"
                    : event.severity === "warning"
                    ? "border-warning/30 bg-warning/5"
                    : "border-border bg-card"
                )}
              >
                <div className="flex items-start gap-3">
                  <Icon className={cn(
                    "h-5 w-5 mt-0.5",
                    event.severity === "critical" ? "text-critical" :
                    event.severity === "warning" ? "text-warning" : "text-muted-foreground"
                  )} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <h3 className="font-medium text-sm">{event.title}</h3>
                      <span className="text-xs text-muted-foreground">
                        {timeAgo(event.detected_at)}
                      </span>
                    </div>
                    {event.description && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {event.description}
                      </p>
                    )}
                    {event.file_path && (
                      <p className="mt-1 text-xs font-mono text-muted-foreground truncate">
                        {event.file_path}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
