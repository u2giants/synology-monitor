"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { NasUnit } from "@synology-monitor/shared";

export function useNasUnits() {
  const [units, setUnits] = useState<NasUnit[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    async function fetch() {
      const { data, error } = await supabase
        .from("nas_units")
        .select("*")
        .order("name");

      if (!error && data) {
        setUnits(data as NasUnit[]);
      }
      setLoading(false);
    }

    fetch();

    // Subscribe to status changes
    const channel = supabase
      .channel("smon-nas-units")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "nas_units" },
        (payload) => {
          if (payload.eventType === "UPDATE") {
            setUnits((prev) =>
              prev.map((u) =>
                u.id === (payload.new as NasUnit).id
                  ? (payload.new as NasUnit)
                  : u
              )
            );
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return { units, loading };
}
