/**
 * Shared NAS tool definitions, approval token signing, and command builders.
 * Used by both the legacy copilot chat and the new resolution agent.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type NasTarget = "edgesynology1" | "edgesynology2";

export type CopilotToolName =
  | "check_disk_space"
  | "check_agent_container"
  | "tail_drive_server_log"
  | "search_drive_server_log"
  | "tail_sharesync_log"
  | "get_resource_snapshot"
  | "restart_monitor_agent"
  | "restart_synology_drive_server"
  | "restart_synology_drive_sharesync"
  | "check_sharesync_status"
  | "rename_file_to_old"
  | "remove_invalid_chars"
  | "trigger_sharesync_resync";

export interface ToolDefinition {
  description: string;
  write: boolean;
  buildPreview: (target: NasTarget, input: { lookbackHours?: number; filter?: string }) => string;
}

function quote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export const TOOL_DEFINITIONS: Record<CopilotToolName, ToolDefinition> = {
  check_disk_space: {
    description: "Read-only. Check volume1 disk utilization and free space.",
    write: false,
    buildPreview: () => "df -h /volume1",
  },
  check_agent_container: {
    description: "Read-only. Confirm whether the Synology Monitor agent container is running.",
    write: false,
    buildPreview: () =>
      "/usr/local/bin/docker ps --format '{{.Image}}|{{.Status}}|{{.Names}}' | grep synology-monitor-agent || true",
  },
  tail_drive_server_log: {
    description: "Read-only. Inspect recent Synology Drive server log lines.",
    write: false,
    buildPreview: (_target, input) => `tail -n ${Math.max(40, Math.min(300, (input.lookbackHours ?? 2) * 40))} /var/log/synologydrive.log`,
  },
  search_drive_server_log: {
    description: "Read-only. Search Synology Drive server logs for a specific term such as a share, user, or error fragment.",
    write: false,
    buildPreview: (_target, input) => {
      const filter = input.filter?.trim() || "error";
      const lines = Math.max(40, Math.min(300, (input.lookbackHours ?? 2) * 40));
      return `grep -i ${quote(filter)} /var/log/synologydrive.log | tail -n ${lines}`;
    },
  },
  tail_sharesync_log: {
    description: "Read-only. Inspect recent ShareSync log lines under @synologydrive/log/syncfolder.log.",
    write: false,
    buildPreview: (_target, input) => {
      const lines = Math.max(40, Math.min(240, (input.lookbackHours ?? 2) * 30));
      return `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "$f"; tail -n ${lines} "$f"; done`;
    },
  },
  restart_monitor_agent: {
    description: "Write. Restart the Synology Monitor agent container on the NAS.",
    write: true,
    buildPreview: () => "cd /volume1/docker/synology-monitor-agent && docker compose restart",
  },
  restart_synology_drive_server: {
    description: "Write. Restart the Synology Drive package.",
    write: true,
    buildPreview: () => "/usr/syno/bin/synopkg restart SynologyDrive",
  },
  restart_synology_drive_sharesync: {
    description: "Write. Restart the Synology Drive ShareSync package.",
    write: true,
    buildPreview: () => "/usr/syno/bin/synopkg restart SynologyDriveShareSync",
  },
  check_sharesync_status: {
    description: "Read-only. Check current ShareSync task status and any stuck sync operations.",
    write: false,
    buildPreview: (_target, input) => {
      const lines = Math.max(60, Math.min(200, (input.lookbackHours ?? 2) * 40));
      return `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "=== $f ==="; tail -n ${lines} "$f"; done | grep -A2 -B2 -i "syncing\\|stuck\\|error\\|conflict" || echo "No issues found in recent logs"`;
    },
  },
  get_resource_snapshot: {
    description: "Read-only. Live on-NAS snapshot: top processes by CPU/mem/IO, per-disk I/O stats, active SMB/NFS/Drive connections, ShareSync backlog, memory pressure, and recent kernel errors.",
    write: false,
    buildPreview: () => {
      return [
        "echo '=== TOP CPU/MEM ==='",
        "ps aux --sort=-%cpu | head -20",
        "echo '=== DISK IO (diskstats) ==='",
        "awk '{if (($4+$8)>0) print $3, \"reads:\", $4, \"writes:\", $8, \"inprog:\", $12}' /proc/diskstats | grep -E 'sd|md'",
        "echo '=== OPEN FILES ON VOLUME ==='",
        "timeout 15 lsof -n +D /volume1 2>/dev/null | awk 'NR>1{print $1,$3,$9}' | sort | uniq -c | sort -rn | head -25 || true",
        "echo '=== SMB SESSIONS ==='",
        "timeout 8 smbstatus -S 2>/dev/null | head -30 || ss -tnp 'sport = :445' 2>/dev/null | head -20 || echo 'SMB status unavailable'",
        "echo '=== NETWORK TOP PEERS ==='",
        "ss -tn state established 2>/dev/null | awk 'NR>1{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -20",
        "echo '=== SHARESYNC TASKS ==='",
        "for f in /volume1/*/@synologydrive/log/syncfolder.log /volume1/@SynologyDriveShareSync/*/log/syncfolder.log; do [ -f \"$f\" ] || continue; echo \"=== $f ===\"; tail -40 \"$f\"; done 2>/dev/null || true",
        "echo '=== MEMORY PRESSURE ==='",
        "free -h",
        "grep -E 'MemAvail|Dirty|Writeback|SwapTotal|SwapFree' /proc/meminfo",
        "echo '=== IO WAIT ==='",
        "top -b -n2 -d0.3 2>/dev/null | grep 'Cpu(s)' | tail -1 || vmstat 1 2 | tail -1",
        "echo '=== KERNEL ERRORS (last 50) ==='",
        "dmesg -T 2>/dev/null | grep -iE 'error|warn|fail|oom|i\\/o' | tail -50 || dmesg | tail -50",
      ].join("\n");
    },
  },
  rename_file_to_old: {
    description: "Write. Rename a problematic file by appending .old to its name.",
    write: true,
    buildPreview: (_target, input) => {
      const filePath = input.filter || "/volume1/SharedDrive/problematic_file.txt";
      return `mv "${filePath}" "${filePath}.old" && echo "Renamed successfully"`;
    },
  },
  remove_invalid_chars: {
    description: "Write. Remove invalid characters from a filename that breaks ShareSync.",
    write: true,
    buildPreview: (_target, input) => {
      const filePath = input.filter || "/volume1/SharedDrive/file_with_invalid_chars.txt";
      return `dir=$(dirname "${filePath}"); file=$(basename "${filePath}"); newfile=$(echo "$file" | sed 's/[/\\:*?"<>|]/_/g'); [ "$file" != "$newfile" ] && mv "${filePath}" "$dir/$newfile" && echo "Renamed: $file -> $newfile" || echo "No invalid characters found"`;
    },
  },
  trigger_sharesync_resync: {
    description: "Write. Trigger a manual re-sync by restarting ShareSync.",
    write: true,
    buildPreview: (_target, input) => {
      const folder = input.filter || "/volume1/SharedFolder";
      return `/usr/syno/bin/synopkg restart SynologyDriveShareSync && sleep 10 && echo "ShareSync restarted for folder: ${folder}"`;
    },
  },
};

export function toolCatalogText() {
  return Object.entries(TOOL_DEFINITIONS)
    .map(([name, tool]) => `- ${name}: ${tool.description}`)
    .join("\n");
}

// --- Approval token signing ---

function getActionSigningKey(): string {
  const signingKey = process.env.COPILOT_ACTION_SIGNING_KEY ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  if (!signingKey) {
    throw new Error("COPILOT_ACTION_SIGNING_KEY or OPENROUTER_API_KEY must be set.");
  }
  return signingKey;
}

function signAction(target: NasTarget, commandPreview: string, expiresAt: string) {
  return createHmac("sha256", getActionSigningKey())
    .update(`${target}\n${commandPreview}\n${expiresAt}`)
    .digest("hex");
}

export function buildApprovalToken(target: NasTarget, commandPreview: string) {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = signAction(target, commandPreview, expiresAt);
  return Buffer.from(JSON.stringify({ target, commandPreview, expiresAt, signature })).toString("base64url");
}

export function verifyApprovalToken(target: NasTarget, commandPreview: string, token: string) {
  let parsed: { target: NasTarget; commandPreview: string; expiresAt: string; signature: string };
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("Approval token is invalid.");
  }
  if (parsed.target !== target || parsed.commandPreview !== commandPreview) {
    throw new Error("Approval token does not match the requested action.");
  }
  if (Date.parse(parsed.expiresAt) < Date.now()) {
    throw new Error("Approval token has expired.");
  }
  const expectedSignature = signAction(parsed.target, parsed.commandPreview, parsed.expiresAt);
  const expectedBuf = Buffer.from(expectedSignature, "hex");
  const actualBuf = Buffer.from(parsed.signature, "hex");
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    throw new Error("Approval token signature is invalid.");
  }
}

export function randomId() {
  return randomUUID();
}
