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
  | "trigger_sharesync_resync"
  // --- New diagnostics for share/sync issues ---
  | "check_io_stalls"
  | "check_share_database"
  | "check_drive_package_health"
  | "check_kernel_io_errors"
  | "search_webapi_log"
  | "check_drive_database"
  | "search_all_logs"
  | "find_problematic_files"
  | "check_filesystem_health";

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
      const filePath = input.filter?.trim();
      if (!filePath) {
        throw new Error("rename_file_to_old requires an exact file path.");
      }
      return `mv "${filePath}" "${filePath}.old" && echo "Renamed successfully"`;
    },
  },
  remove_invalid_chars: {
    description: "Write. Remove invalid characters from a filename that breaks ShareSync.",
    write: true,
    buildPreview: (_target, input) => {
      const filePath = input.filter?.trim();
      if (!filePath) {
        throw new Error("remove_invalid_chars requires an exact file path.");
      }
      return `dir=$(dirname "${filePath}"); file=$(basename "${filePath}"); newfile=$(echo "$file" | sed 's/[/\\:*?"<>|]/_/g'); [ "$file" != "$newfile" ] && mv "${filePath}" "$dir/$newfile" && echo "Renamed: $file -> $newfile" || echo "No invalid characters found"`;
    },
  },
  trigger_sharesync_resync: {
    description: "Write. Trigger a manual re-sync by restarting ShareSync.",
    write: true,
    buildPreview: (_target, input) => {
      const folder = input.filter?.trim();
      if (!folder) {
        throw new Error("trigger_sharesync_resync requires the exact ShareSync folder or task identifier.");
      }
      return `/usr/syno/bin/synopkg restart SynologyDriveShareSync && sleep 10 && echo "ShareSync restarted for folder: ${folder}"`;
    },
  },

  // === New diagnostic tools for share/sync issues ===

  check_io_stalls: {
    description: "Read-only. Check for processes stuck in D-state (uninterruptible sleep), I/O wait percentage, disk queue depths, and hung tasks. Detects I/O contention that causes cascading service failures.",
    write: false,
    buildPreview: () => [
      "echo '=== PROCESSES IN D-STATE (I/O WAIT) ==='",
      "ps aux | awk '$8 ~ /D/ {print}' | head -30 || echo 'No D-state processes'",
      "echo ''",
      "echo '=== I/O WAIT CPU PERCENTAGE ==='",
      "top -b -n2 -d1 2>/dev/null | grep -i 'cpu' | tail -1 || vmstat 1 2 | tail -1",
      "echo ''",
      "echo '=== DISK QUEUE DEPTH & LATENCY ==='",
      "cat /proc/diskstats | awk '{if ($4+$8>0) printf \"%-8s reads:%-8d writes:%-8d in_progress:%-4d\\n\", $3, $4, $8, $12}' | grep -E 'sd|md|dm'",
      "echo ''",
      "echo '=== HUNG TASK WARNINGS (kernel) ==='",
      "dmesg -T 2>/dev/null | grep -i 'blocked for more than\\|hung_task\\|INFO: task' | tail -20 || dmesg | grep -i 'blocked\\|hung' | tail -20 || echo 'No hung task warnings'",
      "echo ''",
      "echo '=== TOP I/O CONSUMERS ==='",
      "iotop -b -o -n1 -P 2>/dev/null | head -20 || echo 'iotop not available'",
    ].join("\n"),
  },

  check_share_database: {
    description: "Read-only. Enumerate all shared folders from the DSM share database (synoshare). Shows share names, paths, and configuration. Failures here indicate a corrupted share database.",
    write: false,
    buildPreview: () => [
      "echo '=== SHARE DATABASE ENUMERATION ==='",
      "/usr/syno/sbin/synoshare --enum ALL 2>&1 || echo 'synoshare --enum failed (share database may be corrupted)'",
      "echo ''",
      "echo '=== SHARE DETAILS (first 10) ==='",
      `/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | head -10 | while read -r name; do echo "--- $name ---"; /usr/syno/sbin/synoshare --get "$name" 2>&1 | head -15; done`,
    ].join("\n"),
  },
  check_drive_package_health: {
    description: "Read-only. Check Synology Drive package status, version, registration, and internal database files. Detects broken installations.",
    write: false,
    buildPreview: () => [
      "echo '=== DRIVE PACKAGE STATUS ==='",
      "/usr/syno/bin/synopkg status SynologyDrive 2>&1",
      "/usr/syno/bin/synopkg status SynologyDriveShareSync 2>&1",
      "echo ''",
      "echo '=== DRIVE VERSION ==='",
      "/usr/syno/bin/synopkg version SynologyDrive 2>&1",
      "echo ''",
      "echo '=== DRIVE PACKAGE FILES ==='",
      "ls -la /var/packages/SynologyDrive/target/ 2>/dev/null | head -20",
      "echo ''",
      "echo '=== DRIVE DATABASE FILES ==='",
      "find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -20",
      "ls -lh /volume1/@synologydrive/db/ 2>/dev/null || echo 'No Drive DB directory'",
      "echo ''",
      "echo '=== DRIVE LOG FILES ==='",
      "find /var/log -maxdepth 3 \\( -name '*drive*' -o -name '*Drive*' \\) 2>/dev/null | head -20",
      "ls -lh /volume1/@synologydrive/log/ 2>/dev/null | head -20 || echo 'No Drive log directory'",
      "echo ''",
      "echo '=== RECENT DRIVE PACKAGE LOG ==='",
      "grep -i 'synologydrive\\|SynologyDrive' /var/log/synolog/synopkg.log 2>/dev/null | tail -20 || true",
    ].join("\n"),
  },
  check_kernel_io_errors: {
    description: "Read-only. Check kernel ring buffer (dmesg) for I/O errors, SCSI errors, disk faults, filesystem corruption, and stall warnings. Critical for distinguishing software bugs from hardware failures.",
    write: false,
    buildPreview: () => [
      "echo '=== KERNEL I/O & DISK ERRORS ==='",
      "dmesg -T 2>/dev/null | grep -iE 'i/o error|scsi|ata.*error|blk_update|buffer i/o|ext4.*error|btrfs.*error|md.*error|raid.*error|sector|fault|stall|hung_task|blocked for' | tail -60 || dmesg | grep -iE 'error|scsi|ata|fault|stall' | tail -60",
      "echo ''",
      "echo '=== FILESYSTEM ERRORS ==='",
      "dmesg -T 2>/dev/null | grep -iE 'EXT4-fs|BTRFS|error.*mount\\|mount.*error' | tail -20 || true",
      "echo ''",
      "echo '=== RECENT OOM EVENTS ==='",
      "dmesg -T 2>/dev/null | grep -iE 'oom|out of memory|killed process' | tail -10 || true",
    ].join("\n"),
  },
  search_webapi_log: {
    description: "Read-only. Search the DSM WebAPI log for share errors, SYNOShareGet failures, and API call failures. This is where 'Failed to SYNOShareGet' errors are logged.",
    write: false,
    buildPreview: (_target, input) => {
      const filter = input.filter?.trim() || "SYNOShare\\|share.*error\\|failed.*share";
      const lines = Math.max(60, Math.min(300, (input.lookbackHours ?? 4) * 40));
      return [
        "echo '=== WEBAPI LOG (share/drive errors) ==='",
        `grep -iE ${quote(filter)} /var/log/synolog/synowebapi.log 2>/dev/null | tail -n ${lines} || echo 'No matches or file not found'`,
        "echo ''",
        "echo '=== STORAGE LOG ==='",
        `grep -iE 'share\\|volume\\|storage\\|mount' /var/log/synolog/synostorage.log 2>/dev/null | tail -40 || echo 'No matches or file not found'`,
        "echo ''",
        "echo '=== SHARE LOG ==='",
        `grep -iE 'error\\|fail\\|warn' /var/log/synolog/synoshare.log 2>/dev/null | tail -40 || echo 'No matches or file not found'`,
      ].join("\n");
    },
  },
  check_drive_database: {
    description: "Read-only. Check integrity of Synology Drive's internal SQLite databases. Detects corruption that causes persistent sync failures.",
    write: false,
    buildPreview: () => [
      "echo '=== DRIVE DATABASE FILES ==='",
      `find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -10`,
      "echo ''",
      "echo '=== DRIVE DATABASE INTEGRITY (first 3 DBs, 10s timeout each) ==='",
      `find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -3 | while read db; do echo "--- $db ($(ls -lh "$db" 2>/dev/null | awk '{print $5}')) ---"; timeout 10 sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -5 || echo 'timeout or error'; done`,
      "echo ''",
      "echo '=== MAIN DRIVE DB TABLES ==='",
      `maindb=$(find /volume1/@synologydrive/ -maxdepth 3 \\( -name 'synodrive.db' -o -name 'sync.db' \\) 2>/dev/null | head -1); [ -n "$maindb" ] && echo "DB: $maindb" && timeout 10 sqlite3 "$maindb" '.tables' 2>&1 | head -20 || echo 'Main Drive DB not found'`,
      "echo ''",
      "echo '=== RECENT DRIVE DB ERRORS ==='",
      "grep -i 'database\\|sqlite\\|db.*error\\|corrupt' /var/log/synologydrive.log 2>/dev/null | tail -20 || echo 'No DB errors in Drive log'",
    ].join("\n"),
  },
  search_all_logs: {
    description: "Read-only. Search ALL system and application logs for a specific term. Use this when you suspect an error appears in a log you haven't checked yet.",
    write: false,
    buildPreview: (_target, input) => {
      const filter = input.filter?.trim() || "error";
      return [
        `echo '=== SEARCHING ALL LOGS FOR: ${filter} ==='`,
        `for f in /var/log/synolog/*.log /var/log/messages /var/log/kern.log /var/log/synologydrive.log /var/log/samba/*.log; do`,
        `  [ -f "$f" ] || continue`,
        `  matches=$(grep -ciE ${quote(filter)} "$f" 2>/dev/null || true)`,
        `  [ "$matches" -gt 0 ] 2>/dev/null && echo "$f: $matches matches" && grep -iE ${quote(filter)} "$f" 2>/dev/null | tail -5 && echo ""`,
        `done`,
      ].join("\n");
    },
  },
  find_problematic_files: {
    description: "Read-only. Search ShareSync-monitored folders for files whose names contain characters that break sync: colons, asterisks, question marks, backslashes, angle brackets, pipes, null bytes. Returns exact file paths that can then be renamed or removed with rename_file_to_old or remove_invalid_chars.",
    write: false,
    buildPreview: (_target, input) => {
      const folder = input.filter?.trim() || "/volume1";
      return [
        `echo '=== FILES WITH SYNC-BREAKING CHARACTERS IN ${folder} ==='`,
        `find ${folder} -maxdepth 8 \\( -name '*:*' -o -name '*\\**' -o -name '*?*' -o -name '*"*' -o -name '*<*' -o -name '*>*' -o -name '*|*' \\) 2>/dev/null | grep -v '@eaDir' | grep -v '.SynologyWorkingDirectory' | head -50 || echo 'No files with special characters found'`,
        `echo ''`,
        `echo '=== SHARESYNC CONFLICT / ERROR FILES ==='`,
        `find ${folder} -maxdepth 8 \\( -name '*conflicted*' -o -name '*.conflict' -o -name '*~conflict*' \\) 2>/dev/null | grep -v '@eaDir' | head -30 || echo 'No conflict files found'`,
        `echo ''`,
        `echo '=== VERY LONG FILENAMES (>200 chars) ==='`,
        `find ${folder} -maxdepth 8 2>/dev/null | awk 'length($0)>200' | head -20 || echo 'No extremely long filenames'`,
        `echo ''`,
        `echo '=== SHARESYNC INTERNAL STATE FILES ==='`,
        `find /volume1/@synologydrive /volume1/@SynologyDriveShareSync -maxdepth 4 -name '*.db' -o -name '*.conf' -o -name '*.json' 2>/dev/null | head -20 || echo 'No internal state files found'`,
      ].join("\n");
    },
  },
  check_filesystem_health: {
    description: "Read-only. Check filesystem health: mount status, inode usage, journal status, and SMART disk health. Detects issues that cause I/O stalls.",
    write: false,
    buildPreview: () => [
      "echo '=== MOUNT STATUS ==='",
      "mount | grep volume",
      "echo ''",
      "echo '=== INODE USAGE ==='",
      "df -i /volume1",
      "echo ''",
      "echo '=== FILESYSTEM TYPE & FLAGS ==='",
      "tune2fs -l $(mount | grep '/volume1 ' | awk '{print $1}') 2>/dev/null | grep -iE 'filesystem|mount count|error|state|journal' || btrfs filesystem show /volume1 2>/dev/null || echo 'Could not determine filesystem details'",
      "echo ''",
      "echo '=== SMART STATUS (all disks) ==='",
      "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo \"--- $d ---\"; smartctl -H \"$d\" 2>/dev/null | grep -E 'result|Status'; smartctl -A \"$d\" 2>/dev/null | grep -E 'Reallocated|Current_Pending|Offline_Uncorrectable|Temperature'; done",
      "echo ''",
      "echo '=== MDADM RAID STATUS ==='",
      "cat /proc/mdstat 2>/dev/null || echo 'No mdstat available'",
    ].join("\n"),
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
