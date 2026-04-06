"use client";

import { useEffect } from "react";

const INTERVAL_MS = 60_000; // check for due metrics every 60 seconds

/** Invisible background component that fires the metric collection API on a timer. */
export function MetricCollectorTrigger() {
  useEffect(() => {
    async function collect() {
      try {
        await fetch("/api/metrics/collect", { method: "POST" });
      } catch {
        // silent — non-critical background task
      }
    }

    // Run once immediately on mount, then on interval
    collect();
    const id = setInterval(collect, INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  return null;
}
