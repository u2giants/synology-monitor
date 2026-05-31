"use client";

// apps/web/src/components/assistant/issue-queue.tsx — left rail.

import { useState } from "react";
import { Plus, Radar, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Resolution } from "@/hooks/use-resolution";
import { StatusDot, SevBadge, STATUS_META } from "./shared";

export function IssueQueue({
  items, activeId, onSelect, onNew, onImport, importing,
}: {
  items: Resolution[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onImport: () => void;
  importing: boolean;
}) {
  const [q, setQ] = useState("");
  const filtered = items.filter((i) => i.title.toLowerCase().includes(q.toLowerCase()));

  return (
    <aside className="sticky top-6 rounded-[14px] border border-border bg-card p-3.5">
      <div className="flex items-center justify-between px-1 pb-3">
        <div className="flex items-center gap-2 text-sm font-bold">
          <span>Issues</span>
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{items.length}</span>
        </div>
        <button onClick={onNew} className="rounded-lg bg-muted p-1.5 text-muted-foreground hover:text-foreground" title="New issue"><Plus className="h-[15px] w-[15px]" /></button>
      </div>

      <div className="mb-2.5 flex items-center gap-2 rounded-[9px] bg-muted px-2.5 py-2 text-muted-foreground">
        <Search className="h-3.5 w-3.5" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter issues" className="w-full bg-transparent text-[13px] text-foreground outline-none" />
      </div>

      <div className="flex flex-col gap-1">
        {filtered.map((it) => (
          <button
            key={it.id}
            onClick={() => onSelect(it.id)}
            className={cn(
              "flex w-full flex-col gap-1.5 rounded-[10px] border p-2.5 text-left transition-colors",
              it.id === activeId ? "border-primary/30 bg-primary/5" : "border-transparent hover:bg-muted",
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-1"><StatusDot status={it.status} /></span>
              <span className="text-[13px] font-semibold leading-snug">{it.title}</span>
            </div>
            <div className="flex items-center gap-2 pl-4">
              <SevBadge severity={it.severity} small />
              <span className="text-[11px] text-muted-foreground">{STATUS_META[it.status].label}</span>
            </div>
          </button>
        ))}
      </div>

      <button
        onClick={onImport}
        disabled={importing}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-[9px] border border-dashed border-border py-2.5 text-[12.5px] font-semibold text-muted-foreground hover:border-primary hover:text-foreground disabled:opacity-50"
      >
        <Radar className="h-3.5 w-3.5" /> Import backend findings
      </button>
    </aside>
  );
}
