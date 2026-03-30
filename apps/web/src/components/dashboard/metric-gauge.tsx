"use client";

import { cn, formatPercent } from "@/lib/utils";

interface MetricGaugeProps {
  label: string;
  value: number;
  maxValue?: number;
  unit?: string;
  thresholds?: { warning: number; critical: number };
}

export function MetricGauge({
  label,
  value,
  maxValue = 100,
  unit = "%",
  thresholds = { warning: 70, critical: 90 },
}: MetricGaugeProps) {
  const percent = Math.min((value / maxValue) * 100, 100);
  const isCritical = percent >= thresholds.critical;
  const isWarning = percent >= thresholds.warning;

  const color = isCritical
    ? "text-critical"
    : isWarning
    ? "text-warning"
    : "text-success";

  const barColor = isCritical
    ? "bg-critical"
    : isWarning
    ? "bg-warning"
    : "bg-success";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={cn("text-sm font-mono font-semibold", color)}>
          {unit === "%" ? formatPercent(value) : `${value.toFixed(1)} ${unit}`}
        </span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all duration-500", barColor)}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
