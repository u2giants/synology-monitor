"use client";

import Link from "next/link";
import { useAllSyncErrors } from "@/hooks/use-sync-errors";

export function SyncErrorsCard() {
  const { summary, loading, error } = useAllSyncErrors(1);

  const totalErrors = summary.reduce((acc, s) => acc + s.error_count, 0);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-4">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-2"></div>
          <div className="h-8 bg-gray-200 rounded w-3/4"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-4 border-l-4 border-red-400">
        <h3 className="text-sm font-medium text-gray-500">Sync Errors</h3>
        <p className="text-red-600 text-sm">Error loading</p>
      </div>
    );
  }

  if (totalErrors === 0) {
    return (
      <Link href="/sync-triage">
        <div className="bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow cursor-pointer">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-500">Sync Errors</h3>
              <p className="text-2xl font-bold text-green-600">0</p>
              <p className="text-xs text-gray-400">Last hour</p>
            </div>
            <div className="text-green-500">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </div>
      </Link>
    );
  }

  // Group by severity
  const errorsBySeverity = {
    critical: 0,
    error: 0,
    warning: 0,
  };

  summary.forEach((s) => {
    s.sample_errors.forEach((e) => {
      if (e.severity === "critical") errorsBySeverity.critical++;
      else if (e.severity === "error") errorsBySeverity.error++;
      else if (e.severity === "warning") errorsBySeverity.warning++;
    });
  });

  const severityColor = errorsBySeverity.critical > 0 ? "red" : errorsBySeverity.error > 0 ? "orange" : "yellow";
  const severityTextColor = {
    red: "text-red-600",
    orange: "text-orange-600",
    yellow: "text-yellow-600",
  }[severityColor];

  return (
    <Link href="/sync-triage">
      <div className={`bg-white rounded-lg shadow p-4 hover:shadow-md transition-shadow cursor-pointer border-l-4 ${
        severityColor === "red" ? "border-l-red-500" : severityColor === "orange" ? "border-l-orange-400" : "border-l-yellow-400"
      }`}>
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-medium text-gray-500">Sync Errors</h3>
            <p className={`text-2xl font-bold ${severityTextColor}`}>{totalErrors}</p>
            <p className="text-xs text-gray-400">Last hour</p>
          </div>
          <div className="text-right">
            <div className="flex flex-col gap-1 text-xs">
              {errorsBySeverity.critical > 0 && (
                <span className="text-red-600 font-medium">{errorsBySeverity.critical} critical</span>
              )}
              {errorsBySeverity.error > 0 && (
                <span className="text-orange-600 font-medium">{errorsBySeverity.error} errors</span>
              )}
              {errorsBySeverity.warning > 0 && (
                <span className="text-yellow-600 font-medium">{errorsBySeverity.warning} warnings</span>
              )}
            </div>
            <p className="text-xs text-blue-600 mt-2">View in Sync Triage →</p>
          </div>
        </div>

        {/* Quick stats */}
        {summary.length > 0 && (
          <div className="mt-3 pt-3 border-t">
            <div className="flex flex-wrap gap-2">
              {summary.slice(0, 3).map((s) => (
                <span key={s.nas_id} className="text-xs bg-gray-100 px-2 py-1 rounded">
                  {s.nas_name}: {s.error_count}
                </span>
              ))}
              {summary.length > 3 && (
                <span className="text-xs text-gray-400">+{summary.length - 3} more</span>
              )}
            </div>
          </div>
        )}
      </div>
    </Link>
  );
}
