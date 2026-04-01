"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

export interface SyncError {
  id: string;
  nas_id: string;
  nas_name: string;
  source: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown> | null;
  logged_at: string;
  ingested_at: string;
  // Enriched fields
  user?: string;
  path?: string;
  action?: string;
  component?: string;
}

export interface SyncErrorSummary {
  nas_id: string;
  nas_name: string;
  error_count: number;
  sample_errors: SyncError[];
  users_affected: string[];
  paths_affected: string[];
}

export function useSyncErrors(nasId: string | null, hours: number = 1) {
  const [errors, setErrors] = useState<SyncError[]>([]);
  const [summary, setSummary] = useState<SyncErrorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchErrors = useCallback(async () => {
    if (!nasId) return;

    const supabase = createClient();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    try {
      // Fetch sync errors from drive-related sources
      const { data: nasData } = await supabase
        .from("smon_nas_units")
        .select("id, name")
        .eq("id", nasId)
        .single();

      const { data, error: fetchError } = await supabase
        .from("smon_logs")
        .select("*")
        .eq("nas_id", nasId)
        .in("source", ["drive", "drive_server", "drive_sharesync", "smb"])
        .in("severity", ["error", "warning", "critical"])
        .gte("ingested_at", cutoff)
        .order("ingested_at", { ascending: false });

      if (fetchError) throw fetchError;

      // Enrich errors with metadata
      const enrichedErrors: SyncError[] = (data || []).map((log) => {
        const meta = (log.metadata as Record<string, unknown>) || {};
        return {
          ...log,
          user: typeof meta.user === "string" ? meta.user : undefined,
          path: typeof meta.path === "string" ? meta.path : undefined,
          action: typeof meta.action === "string" ? meta.action : undefined,
          component: typeof meta.component === "string" ? meta.component : undefined,
        };
      });

      setErrors(enrichedErrors);

      // Build summary by NAS
      const summaryData: SyncErrorSummary = {
        nas_id: nasId,
        nas_name: nasData?.name || "Unknown",
        error_count: enrichedErrors.length,
        sample_errors: enrichedErrors.slice(0, 5),
        users_affected: [...new Set(enrichedErrors.map((e) => e.user).filter(Boolean))] as string[],
        paths_affected: [...new Set(enrichedErrors.map((e) => e.path).filter(Boolean))] as string[],
      };

      setSummary([summaryData]);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch sync errors");
    } finally {
      setLoading(false);
    }
  }, [nasId, hours]);

  useEffect(() => {
    fetchErrors();
    // Refresh every 30 seconds
    const interval = setInterval(fetchErrors, 30000);
    return () => clearInterval(interval);
  }, [fetchErrors]);

  return { errors, summary, loading, error, refresh: fetchErrors };
}

export function useAllSyncErrors(hours: number = 1) {
  const [errors, setErrors] = useState<SyncError[]>([]);
  const [summary, setSummary] = useState<SyncErrorSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchErrors = useCallback(async () => {
    const supabase = createClient();
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

    try {
      // Fetch all NAS units first
      const { data: nasUnits } = await supabase
        .from("smon_nas_units")
        .select("id, name")
        .order("name");

      // Fetch all sync errors
      const { data, error: fetchError } = await supabase
        .from("smon_logs")
        .select("*")
        .in("source", ["drive", "drive_server", "drive_sharesync", "smb"])
        .in("severity", ["error", "warning", "critical"])
        .gte("ingested_at", cutoff)
        .order("ingested_at", { ascending: false });

      if (fetchError) throw fetchError;

      // Enrich errors with metadata
      const enrichedErrors: SyncError[] = (data || []).map((log) => {
        const meta = (log.metadata as Record<string, unknown>) || {};
        return {
          ...log,
          user: typeof meta.user === "string" ? meta.user : undefined,
          path: typeof meta.path === "string" ? meta.path : undefined,
          action: typeof meta.action === "string" ? meta.action : undefined,
          component: typeof meta.component === "string" ? meta.component : undefined,
        };
      });

      setErrors(enrichedErrors);

      // Build summary by NAS
      const nasMap = new Map((nasUnits || []).map((n) => [n.id, n.name]));
      const summaryByNas = new Map<string, SyncErrorSummary>();

      for (const err of enrichedErrors) {
        if (!summaryByNas.has(err.nas_id)) {
          summaryByNas.set(err.nas_id, {
            nas_id: err.nas_id,
            nas_name: nasMap.get(err.nas_id) || "Unknown",
            error_count: 0,
            sample_errors: [],
            users_affected: [],
            paths_affected: [],
          });
        }
        const s = summaryByNas.get(err.nas_id)!;
        s.error_count++;
        if (!s.users_affected.includes(err.user!) && err.user) {
          s.users_affected.push(err.user);
        }
        if (!s.paths_affected.includes(err.path!) && err.path) {
          s.paths_affected.push(err.path);
        }
        if (s.sample_errors.length < 5) {
          s.sample_errors.push(err);
        }
      }

      setSummary(Array.from(summaryByNas.values()));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch sync errors");
    } finally {
      setLoading(false);
    }
  }, [hours]);

  useEffect(() => {
    fetchErrors();
    const interval = setInterval(fetchErrors, 30000);
    return () => clearInterval(interval);
  }, [fetchErrors]);

  return { errors, summary, loading, error, refresh: fetchErrors };
}
