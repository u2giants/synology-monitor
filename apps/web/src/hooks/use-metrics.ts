"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

interface MetricDataPoint {
  recorded_at: string;
  value: number;
}

interface MetricSeries {
  type: string;
  unit: string;
  data: MetricDataPoint[];
}

export function useMetrics(
  nasId: string | null,
  types: string[],
  range: "1h" | "6h" | "24h" | "7d" | "30d" = "24h"
) {
  const [series, setSeries] = useState<MetricSeries[]>([]);
  const [loading, setLoading] = useState(true);

  // Memoize types to prevent infinite re-render loop
  const typesKey = types.join(",");
  const typesRef = useRef(typesKey);
  if (typesKey !== typesRef.current) {
    typesRef.current = typesKey;
  }

  const fetchMetrics = useCallback(async () => {
    if (!nasId) return;

    const supabase = createClient();
    const from = new Date(
      Date.now() - parseRange(range)
    ).toISOString();

    const results: MetricSeries[] = [];

    for (const type of typesRef.current.split(",")) {
      const { data, error } = await supabase
        .from("smon_metrics")
        .select("recorded_at, value, unit")
        .eq("nas_id", nasId)
        .eq("type", type)
        .gte("recorded_at", from)
        .order("recorded_at", { ascending: true })
        .limit(500);

      if (!error && data && data.length > 0) {
        results.push({
          type,
          unit: data[0].unit,
          data: data.map((d) => ({
            recorded_at: d.recorded_at,
            value: d.value,
          })),
        });
      }
    }

    setSeries(results);
    setLoading(false);
  }, [nasId, range]); // Only depend on nasId and range, not types

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 30000); // Poll every 30s
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  return { series, loading, refresh: fetchMetrics };
}

function parseRange(range: string): number {
  switch (range) {
    case "1h": return 60 * 60 * 1000;
    case "6h": return 6 * 60 * 60 * 1000;
    case "24h": return 24 * 60 * 60 * 1000;
    case "7d": return 7 * 24 * 60 * 60 * 1000;
    case "30d": return 30 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
