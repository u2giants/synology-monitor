"use client";

import { useNasUnits } from "@/hooks/use-nas-units";
import { useRealtimeAlerts } from "@/hooks/use-realtime-alerts";
import { useMetrics } from "@/hooks/use-metrics";
import { NasStatusCard } from "@/components/dashboard/nas-status-card";
import { AlertList } from "@/components/dashboard/alert-list";
import { MetricGauge } from "@/components/dashboard/metric-gauge";
import { Activity, AlertTriangle, HardDrive, Shield } from "lucide-react";

export default function OverviewPage() {
  const { units, loading: unitsLoading } = useNasUnits();
  const { alerts, loading: alertsLoading } = useRealtimeAlerts();

  const firstNasId = units[0]?.id ?? null;
  const { series } = useMetrics(
    firstNasId,
    ["cpu_usage", "memory_usage"],
    "1h"
  );

  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  const warningCount = alerts.filter((a) => a.severity === "warning").length;

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
          label="Critical Alerts"
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

      <div className="grid grid-cols-2 gap-6">
        {/* Metrics */}
        <section>
          <h2 className="mb-3 text-lg font-semibold">System Metrics</h2>
          <div className="rounded-lg border border-border p-4 space-y-4">
            <MetricGauge label="CPU Usage" value={latestCpu} />
            <MetricGauge label="Memory Usage" value={latestMem} />
          </div>
        </section>

        {/* Alerts */}
        <section>
          <h2 className="mb-3 text-lg font-semibold">Active Alerts</h2>
          <div className="rounded-lg border border-border p-4">
            {alertsLoading ? (
              <div className="text-sm text-muted-foreground">Loading...</div>
            ) : (
              <AlertList alerts={alerts} limit={5} />
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
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlight ? "border-critical/30 bg-critical/5" : "border-border bg-card"
      }`}
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
