"use client";

import { useEffect, useState } from "react";
import { useNasUnits } from "@/hooks/use-nas-units";
import { useMetrics } from "@/hooks/use-metrics";
import { NasStatusCard } from "@/components/dashboard/nas-status-card";
import { MetricGauge } from "@/components/dashboard/metric-gauge";
import { ProblemsSection } from "@/components/dashboard/problems-section";
import { Activity, AlertTriangle, Bot, HardDrive, Shield } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { cn, timeAgo } from "@/lib/utils";

interface ActiveIssue {
  id: string;
  title: string;
  severity: "critical" | "warning" | "info";
  status: string;
  summary: string;
  affected_nas: string[];
  updated_at: string;
}

const STATUS_LABELS: Record<string, string> = {
  open: "Open",
  running: "Working",
  waiting_on_user: "Waiting on you",
  waiting_for_approval: "Awaiting approval",
  resolved: "Resolved",
  stuck: "Blocked",
  cancelled: "Cancelled",
};

function useActiveIssues() {
  const [issues, setIssues] = useState<ActiveIssue[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    supabase
      .from("issues")
      .select("id, title, severity, status, summary, affected_nas, updated_at")
      .not("status", "in", "(resolved,cancelled)")
      .order("updated_at", { ascending: false })
      .limit(20)
      .then(({ data }) => {
        setIssues((data ?? []) as ActiveIssue[]);
        setLoading(false);
      });
  }, []);

  return { issues, loading };
}

export default function OverviewPage() {
  const { units, loading: unitsLoading } = useNasUnits();
  const { issues, loading: issuesLoading } = useActiveIssues();

  const firstNasId = units[0]?.id ?? null;
  const { series } = useMetrics(
    firstNasId,
    ["cpu_usage", "memory_usage"],
    "1h"
  );

  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;

  // Get latest metric values
  const latestCpu = series.find((s) => s.type === "cpu_usage")?.data?.at(-1)?.value ?? 0;
  const latestMem = series.find((s) => s.type === "memory_usage")?.data?.at(-1)?.value ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-4">
        <StatCard
          icon={<HardDrive className="h-5 w-5" />}
          label="NAS Units"
          value={units.length.toString()}
          detail={`${units.filter((u) => u.status === "online").length} online`}
        />
        <StatCard
          icon={<AlertTriangle className="h-5 w-5 text-critical" />}
          label="Open Issues"
          value={criticalCount.toString()}
          detail={`${warningCount} warnings`}
          highlight={criticalCount > 0}
        />
        <StatCard
          icon={<Activity className="h-5 w-5 text-primary" />}
          label="CPU Usage"
          value={`${latestCpu.toFixed(1)}%`}
          detail={units[0]?.name ?? "—"}
        />
        <StatCard
          icon={<Shield className="h-5 w-5 text-success" />}
          label="Security"
          value="Normal"
          detail="No threats detected"
        />
      </div>

      {/* NAS Status */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">NAS Units</h2>
        {unitsLoading ? (
          <div className="text-muted-foreground text-sm">Loading...</div>
        ) : units.length === 0 ? (
          <div className="rounded-lg border border-border p-6 text-center text-muted-foreground">
            No NAS units registered yet. Deploy an agent to get started.
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {units.map((unit) => (
              <NasStatusCard key={unit.id} unit={unit} />
            ))}
          </div>
        )}
      </section>

      {/* AI-Analyzed Problems */}
      <ProblemsSection />

      <div className="grid grid-cols-2 gap-6">
        {/* Metrics */}
        <section>
          <h2 className="mb-3 text-lg font-semibold">System Metrics</h2>
          <div className="rounded-lg border border-border p-4 space-y-4">
            <MetricGauge label="CPU Usage" value={latestCpu} />
            <MetricGauge label="Memory Usage" value={latestMem} />
          </div>
        </section>

        {/* Active Issues */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-semibold">Active Issues</h2>
            <Link
              href="/assistant"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              Open Issue Agent
            </Link>
          </div>
          <div className="rounded-lg border border-border p-4">
            {issuesLoading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : issues.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                <Bot className="h-7 w-7 mb-2 opacity-40" />
                <p className="text-sm">No open issue threads. Run detection on the dashboard.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {issues.slice(0, 12).map((issue) => {
                  const severityClass = issue.severity === "critical"
                    ? "border-critical/30 bg-critical/5"
                    : issue.severity === "warning"
                      ? "border-warning/30 bg-warning/5"
                      : "border-border bg-background";
                  return (
                    <Link
                      key={issue.id}
                      href={`/assistant?resolutionId=${issue.id}`}
                      className={cn(
                        "block rounded-md border p-3 hover:opacity-80 transition-opacity",
                        severityClass
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium truncate">{issue.title}</p>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {timeAgo(issue.updated_at)}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{STATUS_LABELS[issue.status] ?? issue.status}</span>
                        {issue.affected_nas.length > 0 && (
                          <span>· {issue.affected_nas.join(", ")}</span>
                        )}
                      </div>
                    </Link>
                  );
                })}
                {issues.length > 12 && (
                  <div className="text-center text-xs text-muted-foreground pt-1">
                    Showing 12 of {issues.length} active issues
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  detail,
  highlight = false,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  highlight?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-lg border p-4 ${
        highlight ? "border-critical/30 bg-critical/5" : "border-border bg-card"
      } ${onClick ? "cursor-pointer hover:opacity-80 transition-opacity" : ""}`}
    >
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-sm">{label}</span>
      </div>
      <p className="mt-2 text-2xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
