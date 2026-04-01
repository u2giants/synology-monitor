"use client";

import { useState } from "react";
import { useAllSyncErrors, type SyncError, type SyncErrorSummary } from "@/hooks/use-sync-errors";
import { createClient } from "@/lib/supabase/client";

export function SyncTriagePage() {
  const [hours, setHours] = useState(1);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<{
    answer: string;
    context: {
      errors_analyzed: number;
      severity_breakdown: { error: number; warning: number; critical: number };
      top_users: Array<[string, number]>;
      top_paths: Array<[string, number]>;
      top_components: Array<[string, number]>;
    };
  } | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  const { errors, summary, loading, error, refresh } = useAllSyncErrors(hours);

  const runBatchAnalysis = async () => {
    if (errors.length === 0) return;

    setAnalyzing(true);
    setAnalysisError(null);
    setAnalysisResult(null);

    try {
      const response = await fetch("/api/sync-triage/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours, maxErrors: 50 }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Analysis failed");
      }

      const data = await response.json();
      setAnalysisResult(data);
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-gray-500">Loading sync errors...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <div className="text-red-600">Error: {error}</div>
        <button onClick={refresh} className="mt-2 px-4 py-2 bg-blue-500 text-white rounded">
          Retry
        </button>
      </div>
    );
  }

  const totalErrors = summary.reduce((acc, s) => acc + s.error_count, 0);

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Sync Triage</h1>
        <div className="flex items-center gap-4">
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="px-3 py-2 border rounded-md"
          >
            <option value={1}>Last 1 hour</option>
            <option value={2}>Last 2 hours</option>
            <option value={6}>Last 6 hours</option>
            <option value={24}>Last 24 hours</option>
          </select>
          <button onClick={refresh} className="px-4 py-2 border rounded-md hover:bg-gray-50">
            Refresh
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <SummaryCard
          title="Total Errors"
          value={totalErrors}
          color={totalErrors > 100 ? "red" : totalErrors > 50 ? "orange" : "gray"}
        />
        <SummaryCard
          title="NAS Units"
          value={summary.length}
          color="blue"
        />
        <SummaryCard
          title="Drive Errors"
          value={errors.filter((e) => e.source === "drive" || e.source === "drive_server").length}
          color="purple"
        />
        <SummaryCard
          title="ShareSync Errors"
          value={errors.filter((e) => e.source === "drive_sharesync").length}
          color="green"
        />
      </div>

      {/* Batch Analysis Button */}
      {totalErrors > 0 && (
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-semibold text-blue-900">Batch AI Analysis</h3>
              <p className="text-sm text-blue-700">
                Let AI analyze all {totalErrors} errors to find patterns and correlations
              </p>
            </div>
            <button
              onClick={runBatchAnalysis}
              disabled={analyzing}
              className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {analyzing ? "Analyzing..." : "Analyze All Errors"}
            </button>
          </div>
        </div>
      )}

      {/* Analysis Results */}
      {analysisError && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
          <p className="text-red-700">{analysisError}</p>
        </div>
      )}

      {analysisResult && (
        <div className="mb-6 p-6 bg-white border border-gray-200 rounded-lg shadow-sm">
          <h3 className="text-lg font-semibold mb-4">AI Analysis Results</h3>
          <div className="mb-4">
            <p className="whitespace-pre-wrap">{analysisResult.answer}</p>
          </div>
          {analysisResult.context && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-4 pt-4 border-t">
              <div>
                <h4 className="font-medium text-gray-700 mb-2">Severity Breakdown</h4>
                <ul className="text-sm space-y-1">
                  <li className="flex justify-between">
                    <span>Errors:</span>
                    <span className="font-medium text-red-600">{analysisResult.context.severity_breakdown.error}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Warnings:</span>
                    <span className="font-medium text-orange-600">{analysisResult.context.severity_breakdown.warning}</span>
                  </li>
                  <li className="flex justify-between">
                    <span>Critical:</span>
                    <span className="font-medium text-red-800">{analysisResult.context.severity_breakdown.critical}</span>
                  </li>
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-700 mb-2">Top Users Affected</h4>
                <ul className="text-sm space-y-1">
                  {analysisResult.context.top_users.slice(0, 5).map(([user, count]) => (
                    <li key={user} className="flex justify-between">
                      <span>{user}</span>
                      <span className="text-gray-500">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className="font-medium text-gray-700 mb-2">Top Components</h4>
                <ul className="text-sm space-y-1">
                  {analysisResult.context.top_components.slice(0, 5).map(([component, count]) => (
                    <li key={component} className="flex justify-between">
                      <span>{component}</span>
                      <span className="text-gray-500">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      )}

      {/* NAS Summary */}
      <div className="space-y-4">
        {summary.map((s) => (
          <NASErrorSummary
            key={s.nas_id}
            summary={s}
            hours={hours}
          />
        ))}
      </div>

      {/* Error List */}
      <div className="mt-8">
        <h2 className="text-xl font-semibold mb-4">Recent Errors</h2>
        {errors.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No sync errors found in the selected time period.
          </div>
        ) : (
          <div className="space-y-2">
            {errors.slice(0, 100).map((error) => (
              <ErrorCard key={error.id} error={error} />
            ))}
            {errors.length > 100 && (
              <p className="text-center text-gray-500 py-4">
                Showing 100 of {errors.length} errors
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  color,
}: {
  title: string;
  value: number;
  color: "red" | "orange" | "blue" | "purple" | "green" | "gray";
}) {
  const colorClasses = {
    red: "bg-red-50 border-red-200 text-red-700",
    orange: "bg-orange-50 border-orange-200 text-orange-700",
    blue: "bg-blue-50 border-blue-200 text-blue-700",
    purple: "bg-purple-50 border-purple-200 text-purple-700",
    green: "bg-green-50 border-green-200 text-green-700",
    gray: "bg-gray-50 border-gray-200 text-gray-700",
  };

  return (
    <div className={`p-4 border rounded-lg ${colorClasses[color]}`}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-sm opacity-80">{title}</div>
    </div>
  );
}

function NASErrorSummary({
  summary,
  hours,
}: {
  summary: SyncErrorSummary;
  hours: number;
}) {
  const severityColor = (severity: string) => {
    switch (severity) {
      case "critical":
        return "bg-red-100 text-red-800";
      case "error":
        return "bg-red-50 text-red-700";
      case "warning":
        return "bg-orange-50 text-orange-700";
      default:
        return "bg-gray-50 text-gray-700";
    }
  };

  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-lg">{summary.nas_name}</h3>
        <span className="text-2xl font-bold text-red-600">{summary.error_count} errors</span>
      </div>

      <div className="text-sm text-gray-600 mb-3">
        <span>{hours}h window</span>
        {summary.users_affected.length > 0 && (
          <span className="ml-4">Users: {summary.users_affected.join(", ")}</span>
        )}
      </div>

      {/* Severity breakdown */}
      <div className="flex gap-2 mb-3">
        {["error", "warning", "critical"].map((sev) => {
          const count = summary.sample_errors.filter((e) => e.severity === sev).length;
          if (count === 0) return null;
          return (
            <span
              key={sev}
              className={`px-2 py-1 rounded text-xs font-medium ${severityColor(sev)}`}
            >
              {sev}: {count}
            </span>
          );
        })}
      </div>

      {/* Sample errors */}
      {summary.sample_errors.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-gray-700">Sample Errors</h4>
          {summary.sample_errors.slice(0, 3).map((err) => (
            <ErrorCard key={err.id} error={err} compact />
          ))}
        </div>
      )}
    </div>
  );
}

function ErrorCard({ error, compact = false }: { error: SyncError; compact?: boolean }) {
  const severityStyles = {
    critical: "border-l-red-500 bg-red-50",
    error: "border-l-red-400 bg-red-50/30",
    warning: "border-l-orange-400 bg-orange-50/30",
    info: "border-l-gray-400 bg-gray-50/30",
  };

  return (
    <div
      className={`border-l-4 border rounded-r p-3 ${severityStyles[error.severity as keyof typeof severityStyles] || severityStyles.info}`}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-gray-500 uppercase">{error.source}</span>
            <span className={`text-xs px-2 py-0.5 rounded ${error.severity === "error" ? "bg-red-200 text-red-800" : error.severity === "warning" ? "bg-orange-200 text-orange-800" : "bg-gray-200 text-gray-800"}`}>
              {error.severity}
            </span>
          </div>
          <p className={compact ? "text-sm" : "text-base"}>{error.message}</p>
          {!compact && (
            <div className="mt-2 flex flex-wrap gap-4 text-xs text-gray-500">
              {error.user && <span>User: {error.user}</span>}
              {error.path && <span>Path: {error.path}</span>}
              {error.action && <span>Action: {error.action}</span>}
              {error.component && <span>Component: {error.component}</span>}
            </div>
          )}
          <div className="mt-1 text-xs text-gray-400">
            {new Date(error.ingested_at).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  );
}
