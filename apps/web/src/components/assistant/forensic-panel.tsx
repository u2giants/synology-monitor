"use client";

// Forensic Incident Explainer Panel — extracted from the old assistant page.
// Shown when Drive / Backup forensic facts are present.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ResolutionFact } from "@/hooks/use-resolution";

export function ForensicIncidentPanel({ facts }: { facts: ResolutionFact[] }) {
  const [expanded, setExpanded] = useState(false);

  const attribution = facts.find((f) => f.fact_type === "forensic_drive_attribution");
  const classification = facts.find((f) => f.fact_type === "forensic_drive_classification");
  const backupTimeline = facts.find((f) => f.fact_type === "forensic_backup_timeline");

  if (!attribution && !classification && !backupTimeline) return null;

  const devices = (attribution?.value?.devices as string[] | undefined) ?? [];
  const users = (attribution?.value?.users as string[] | undefined) ?? [];
  const matchRate = (classification?.value?.match_rate as number | undefined) ?? null;
  const classificationKind = (classification?.value?.classification as string | undefined) ?? null;
  const backupSucceededButCleanupFailed =
    (backupTimeline?.value?.cleanup_unhealthy as boolean | undefined) ?? false;

  const incidentClassification = (() => {
    if (backupTimeline && classification) return "Hyper Backup cleanup failure driven by Drive reorganization";
    if (backupTimeline) return "Hyper Backup cleanup failure";
    if (classification) return "Synology Drive reorganization";
    return "Drive / storage incident";
  })();

  const likelyCause = (() => {
    const parts: string[] = [];
    if (classificationKind === "restructure_likely") {
      parts.push(
        `A large Synology Drive reorganization caused ${
          matchRate !== null ? `${Math.round(matchRate * 100)}%` : "most"
        } of the observed deletes to be moves or replacements, not true deletions.`,
      );
    } else if (classificationKind === "destructive_delete_likely") {
      parts.push("A significant portion of the observed deletes appear to be true deletions without matching replacements.");
    } else if (classificationKind) {
      parts.push("The observed deletes are a mix of moves/replacements and true deletions.");
    }
    if (backupSucceededButCleanupFailed) {
      parts.push(
        "Hyper Backup finished the backup itself, but got stuck deleting old versions after the Drive reorganization.",
      );
    }
    return parts.join(" ");
  })();

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <button
        className="flex w-full items-start justify-between gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600">
              Forensic Analysis
            </span>
          </div>
          <h3 className="mt-2 text-sm font-semibold">{incidentClassification}</h3>
          {!expanded && likelyCause && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{likelyCause}</p>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="mt-4 space-y-3 border-t border-amber-500/20 pt-3">
          {likelyCause && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                What likely happened
              </div>
              <p className="text-xs leading-relaxed">{likelyCause}</p>
            </div>
          )}

          {(attribution || classification) && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Drive churn summary
              </div>
              {devices.length > 0 && (
                <p className="text-xs">
                  <span className="font-medium">Clients involved: </span>
                  {devices.slice(0, 6).join(", ")}
                  {devices.length > 6 ? ` +${devices.length - 6} more` : ""}
                </p>
              )}
              {users.length > 0 && (
                <p className="mt-0.5 text-xs">
                  <span className="font-medium">Users: </span>
                  {users.join(", ")}
                </p>
              )}
              {classification && (
                <p className="mt-0.5 text-xs text-muted-foreground">{classification.title}</p>
              )}
            </div>
          )}

          {backupTimeline && (
            <div>
              <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Backup cleanup state
              </div>
              <p className="text-xs">{backupTimeline.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                {backupTimeline.detail}
              </p>
            </div>
          )}

          {classificationKind === "restructure_likely" && (
            <div className="rounded-md bg-background px-3 py-2">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">Not a one-way wipe: </span>
                Most of the delete activity matches moves or replacements, so this does not look
                like random corruption or destructive data loss.
              </p>
            </div>
          )}

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Recommended next step
            </div>
            <p className="text-xs text-muted-foreground">
              {backupSucceededButCleanupFailed
                ? "Wait for Hyper Backup cleanup to complete naturally, or use DSM to cancel and restart the stuck task. High I/O should subside once version cleanup finishes."
                : classification
                  ? "Verify Drive sync is now idle and no further reorganization is in progress. Check whether any conflict files need manual resolution."
                  : "Investigate the storage pressure source and monitor iowait as the activity subsides."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
