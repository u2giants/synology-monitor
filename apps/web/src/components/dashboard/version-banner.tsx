"use client";

import { useEffect, useState } from "react";

export function VersionBanner() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    // Check if user is admin by hitting the session endpoint
    fetch("/api/copilot/session")
      .then((res) => res.json())
      .then((data) => {
        if (data.role === "admin") setIsAdmin(true);
      })
      .catch(() => {});
  }, []);

  if (!isAdmin) return null;

  const sha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";
  const dateRaw = process.env.NEXT_PUBLIC_BUILD_DATE;

  let dateStr = "unknown";
  if (dateRaw) {
    try {
      dateStr = new Date(dateRaw).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
    } catch {
      dateStr = dateRaw;
    }
  }

  return (
    <div className="fixed top-0 right-0 z-50 mr-4 mt-2 rounded-md bg-muted/80 px-2 py-1 text-[11px] text-muted-foreground backdrop-blur-sm">
      build <span className="font-mono font-medium">{sha}</span> · {dateStr}
    </div>
  );
}
