import { z } from "zod";

/** Native nas-api job operations (no shell command). Inventory ops (Phase 1) and
 *  archive-move ops (Phase 2) both dispatch through job-client.ts. */
export type JobOp =
  // file inventory
  | "start" | "schedule" | "status" | "result" | "cancel"
  // archive move
  | "move_plan" | "move_status" | "move_manifest"
  | "move_execute" | "move_cancel" | "move_rollback" | "move_verify";

export interface McpToolDef {
  name: string;
  description: string;
  write: boolean;
  /** ZodRawShape passed directly to server.tool() */
  params: Record<string, z.ZodTypeAny>;
  /** Builds the shell command. Optional: native job tools (see `job`) dispatch
   *  to nas-api REST endpoints instead and have no command. */
  buildCommand?: (input: Record<string, unknown>) => string;
  /** Present on native job tools; selects the nas-api /jobs operation. When set,
   *  the MCP dispatcher routes through job-client.ts instead of /preview→/exec. */
  job?: { op: JobOp };
}

// ─── Shared param shapes ──────────────────────────────────────────────────────

const target = z
  .enum(["edgesynology1", "edgesynology2", "both"])
  .describe("Which NAS to run on. Use 'both' to query both simultaneously.");

const lookbackHours = z
  .number()
  .optional()
  .default(2)
  .describe("How many hours of logs to look back. Default: 2.");

const filter = z
  .string()
  .optional()
  .describe("Search term, file path, or folder name depending on the tool.");

const packageName = z
  .string()
  .describe(
    "Synology package name exactly as shown by synopkg (e.g. SynologyDrive, HyperBackup, ContainerManager)."
  );

const exactPath = z
  .string()
  .describe("Exact absolute filesystem path to inspect (e.g. /volume1/data/folder/file.txt).");

// ─── Archive file-inventory param shapes (validated server-side by nas-api) ───
const archiveSharesParam = z
  .string()
  .describe(
    "Comma-separated shared folders to scan. Allowed: files, styleguides, users, homes, Coldlion, Photography, freelancers, mgmt, mac, oldStyleguides.",
  );
const cutoffYearsParam = z
  .string()
  .optional()
  .describe("Comma-separated cutoff years for archive-candidate totals, e.g. '2021,2022'.");
const overlayParam = z
  .boolean()
  .optional()
  .describe("Run the Drive/ShareSync recent-activity overlay (default: true). It protects actively-synced folders from aggressive archive rules.");
const protectNewerThanParam = z
  .string()
  .optional()
  .describe("RFC3339/ISO date. A file is never an archive candidate if its newest timestamp (max of mtime/ctime/btime) is on or after this date, even with no sync activity.");
const maxFilesPerSecParam = z
  .number()
  .optional()
  .describe("Throttle the scan to at most this many files/second (0 or omit = unlimited).");
const useIdleIoParam = z
  .boolean()
  .optional()
  .describe("Run the scan at idle I/O priority so active SMB/Drive workloads win (default: true).");
const sleepEveryFilesParam = z
  .number()
  .optional()
  .describe("Pause briefly every N files to reduce NAS load (default: 5000).");
const sleepMsParam = z
  .number()
  .optional()
  .describe("Pause duration in milliseconds at each checkpoint (default: 25).");

// ─── Archive-move (Phase 2) param shapes ──────────────────────────────────────
const moveShareParam = z
  .string()
  .describe("The single shared folder to operate on (e.g. files, styleguides, Coldlion). Allowlisted server-side.");
const moveModeParam = z
  .enum(["move", "clean_empty_dirs"])
  .optional()
  .describe("'move' relocates old files into <share>/Archive (default). 'clean_empty_dirs' removes empty folders only, moving zero files.");
const moveRootsParam = z
  .string()
  .optional()
  .describe("Optional comma-separated sub-folder roots within the share to limit scope (e.g. 'clients/acme'). Omit for the whole share.");
const moveIncludeParam = z
  .string()
  .optional()
  .describe("Optional comma-separated include path globs (relative to the share).");
const moveExcludeParam = z
  .string()
  .optional()
  .describe("Optional comma-separated exclude path globs (relative to the share).");
const movePruneParam = z
  .boolean()
  .optional()
  .describe("Prune source folders emptied by the move, bottom-up (default: true).");
const moveRemovePreexistingParam = z
  .boolean()
  .optional()
  .describe("Also remove folders that were already empty before the move (default: false).");
const moveJobIdParam = z.string().describe("The archive-move job id (from plan_archive_move).");

const rootPath = z
  .string()
  .optional()
  .default("")
  .describe("Absolute directory to search. Leave empty to search all mounted /volumeN data volumes.");

const namePattern = z
  .string()
  .describe("Strict filename glob to match against basenames only, e.g. '*budget*.xls*'. This is not fuzzy search and does not search file contents.");

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// Maps a caller-supplied share path to the nas-api writable Btrfs mount. The
// per-share /volumeN binds are :ro (docker-compose.agent.yml), so a write to
// /volume1/... returns EROFS; only /btrfs/volumeN is rw (compose line 102; the
// volume2 bind on line 103 is commented out but designed to be uncommented,
// which is why this accepts /volumeN rather than hard-coding volume1 — an
// unmounted volume then fails at the source-existence guard with a clear
// message). Same mapping write_seafile_ignore established.
//
// Both branches are ANCHORED on purpose. A loose startsWith("/btrfs/volume")
// accepts "/btrfs/volumeevil/x", which is not merely off-contract: it evades
// tier 3. ClassifyTier's filePatterns look for /volume\d+/, so "volumeevil"
// classifies tier 2 — the same downgrade this file works to prevent. Measured.
function toWritableVolumePath(value: string, toolName: string): string {
  // Component-aware, so a legitimate "my..file.txt" is allowed while a real
  // ".." traversal segment is not.
  if (value.split("/").includes("..")) throw new Error(`${toolName}: path must not contain a '..' segment.`);
  if (/^\/btrfs\/volume\d+\//.test(value)) return value;
  if (/^\/volume\d+\//.test(value)) return "/btrfs" + value;
  throw new Error(`${toolName}: path must be under /volumeN/ (or /btrfs/volumeN/).`);
}

function readOnlySql(value: string): string {
  const sql = value.trim().replace(/;+\s*$/, "");
  if (!sql || sql.length > 2000) {
    throw new Error("SQL query must be a non-empty read-only statement under 2000 characters.");
  }
  if (/[;\x00]/.test(sql) || /--|\/\*/.test(sql)) {
    throw new Error("SQL query must be a single read-only statement without comments.");
  }
  if (/\b(attach|detach|insert|update|delete|replace|create|drop|alter|vacuum|reindex|analyze|load_extension|pragma\s+(?!table_info\b|table_xinfo\b|index_list\b|index_info\b|database_list\b|foreign_key_list\b))/i.test(sql)) {
    throw new Error("Only SELECT/WITH and safe schema PRAGMA queries are allowed.");
  }
  if (!/^(select|with)\b/i.test(sql) && !/^pragma\s+(table_info|table_xinfo|index_list|index_info|database_list|foreign_key_list)\s*\(/i.test(sql)) {
    throw new Error("Only SELECT, WITH, or safe schema PRAGMA queries are allowed.");
  }
  return sql;
}

/**
 * Builds a shell command that makes a single authenticated DSM WebAPI call.
 * Handles login, the API call, result check, and logout.
 * Requires DSM_USERNAME and DSM_PASSWORD in the container environment (.env).
 */
function buildDsmApiCall(
  api: string,
  version: number,
  method: string,
  extraArgs: string[], // each entry is a --data-urlencode "key=value" fragment (value may reference $SHELL_VAR)
  description: string,
): string {
  return [
    `if [ -z "\${DSM_USERNAME:-}" ] || [ -z "\${DSM_PASSWORD:-}" ]; then echo "ERROR: DSM_USERNAME/DSM_PASSWORD not set in .env — required for WebAPI calls"; exit 1; fi`,
    `DSM_BASE="http://localhost:\${DSM_PORT:-5000}/webapi/entry.cgi"`,
    `echo "=== Authenticating to DSM WebAPI ==="`,
    `SID=$(curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.API.Auth" --data-urlencode "version=7" --data-urlencode "method=login" --data-urlencode "account=\${DSM_USERNAME}" --data-urlencode "passwd=\${DSM_PASSWORD}" --data-urlencode "format=sid" 2>/dev/null | grep -o '"sid":"[^"]*"' | cut -d'"' -f4)`,
    `if [ -z "$SID" ]; then echo "ERROR: DSM login failed — check DSM_USERNAME/DSM_PASSWORD and port \${DSM_PORT:-5000}"; exit 1; fi`,
    `echo "Authenticated"`,
    `echo ""`,
    `echo "=== ${description} (${api} v${version} method=${method}) ==="`,
    `RESULT=$(curl -sfG "$DSM_BASE" --data-urlencode "api=${api}" --data-urlencode "version=${version}" --data-urlencode "method=${method}" ${extraArgs.join(" ")} --data-urlencode "_sid=$SID" 2>/dev/null)`,
    `echo "$RESULT"`,
    `echo "$RESULT" | grep -q '"success":true' && echo "OK" || echo "Non-success — check DSM for errors"`,
    `echo ""`,
    `curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.API.Auth" --data-urlencode "version=7" --data-urlencode "method=logout" --data-urlencode "_sid=$SID" >/dev/null 2>&1 || true`,
    `echo "Session closed"`,
  ].join("\n");
}

/**
 * Builds a shell command that restarts a DSM package via the local WebAPI.
 * Requires DSM_USERNAME and DSM_PASSWORD in the container environment (.env).
 * Validator classifies this as Tier 2 because it matches the SYNO.Core.Package
 * write-method pattern.
 */
function buildDsmPackageRestart(packageId: string): string {
  return [
    `if [ -z "\${DSM_USERNAME:-}" ] || [ -z "\${DSM_PASSWORD:-}" ]; then echo "ERROR: DSM_USERNAME/DSM_PASSWORD not set in .env — required for WebAPI package restarts"; exit 1; fi`,
    `DSM_BASE="http://localhost:\${DSM_PORT:-5000}/webapi/entry.cgi"`,
    `echo "=== Authenticating to DSM WebAPI ==="`,
    `SID=$(curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.API.Auth" --data-urlencode "version=7" --data-urlencode "method=login" --data-urlencode "account=\${DSM_USERNAME}" --data-urlencode "passwd=\${DSM_PASSWORD}" --data-urlencode "format=sid" 2>/dev/null | grep -o '"sid":"[^"]*"' | cut -d'"' -f4)`,
    `if [ -z "$SID" ]; then echo "ERROR: DSM login failed — check DSM_USERNAME/DSM_PASSWORD and that DSM is reachable on port \${DSM_PORT:-5000}"; exit 1; fi`,
    `echo "Authenticated to DSM"`,
    `echo ""`,
    `echo "=== Stopping ${packageId} via SYNO.Core.Package method=stop ==="`,
    `STOP=$(curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.Core.Package" --data-urlencode "version=1" --data-urlencode "method=stop" --data-urlencode "id=${packageId}" --data-urlencode "_sid=$SID" 2>/dev/null)`,
    `echo "$STOP"`,
    `echo "$STOP" | grep -q '"success":true' && echo "Stop: OK" || echo "Stop: non-success (package may already be stopped)"`,
    `echo ""`,
    `sleep 4`,
    `echo "=== Starting ${packageId} via SYNO.Core.Package method=start ==="`,
    `START=$(curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.Core.Package" --data-urlencode "version=1" --data-urlencode "method=start" --data-urlencode "id=${packageId}" --data-urlencode "_sid=$SID" 2>/dev/null)`,
    `echo "$START"`,
    `echo "$START" | grep -q '"success":true' && echo "Start: OK" || echo "Start: non-success — check DSM Package Center for errors"`,
    `echo ""`,
    `curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.API.Auth" --data-urlencode "version=7" --data-urlencode "method=logout" --data-urlencode "_sid=$SID" >/dev/null 2>&1 || true`,
    `echo "Session closed"`,
  ].join("\n");
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const ALL_TOOL_DEFS: McpToolDef[] = [

  // ── Read tools ───────────────────────────────────────────────────────────────

  {
    name: "check_system_info",
    description: "Returns DSM version, NAS model, uptime, system load, kernel version, CPU info, and memory overview. Run this first in any new conversation to establish baseline context about the system.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DSM VERSION ==='",
      "cat /host/etc/VERSION 2>/dev/null || echo 'VERSION file not available (mount /etc/VERSION:/host/etc/VERSION:ro)'",
      "echo ''",
      "echo '=== NAS MODEL ==='",
      "grep -E 'syno_hw_version|upnpmodelname|modelname' /host/usr/syno/etc/synoinfo.conf 2>/dev/null | head -5 || echo 'Model info not available'",
      "echo ''",
      "echo '=== UPTIME & LOAD ==='",
      "uptime",
      "echo ''",
      "echo '=== KERNEL ==='",
      "uname -r",
      "echo ''",
      "echo '=== CPU ==='",
      "nproc && grep 'model name' /proc/cpuinfo | head -1",
      "echo ''",
      "echo '=== MEMORY ==='",
      "free -h",
    ].join("\n"),
  },

  {
    name: "list_volumes",
    description: "Discovers active NAS data volumes and their filesystem usage. Run this before path-sensitive diagnostics so later tools do not assume everything lives on /volume1.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DATA VOLUMES ==='",
      "mount | awk '$3 ~ /^\\/volume[0-9]+$/ {printf \"%s %s %s\\n\", $3, $1, $5}' | sort -u || true",
      "echo ''",
      "echo '=== FILESYSTEM USAGE ==='",
      "df -h 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume[0-9]+$/'",
      "echo ''",
      "echo '=== BTRFS / EXT STATUS ==='",
      "for v in /volume[0-9]*; do [ -d \"$v\" ] || continue; printf '%s\\n' \"$v\"; findmnt -no FSTYPE,SOURCE,TARGET \"$v\" 2>/dev/null || mount | awk -v vol=\"$v\" '$3==vol{print $5, $1, $3}'; done",
    ].join("\n"),
  },

  {
    name: "list_shared_folders",
    description: "Lists DSM shared folders with paths, volume placement, and selected metadata. Use this to map human share names to real paths before file, permission, or sync forensics.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== SYNOLOGY SHARE ENUMERATION ==='",
      "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null || echo 'synoshare --enum failed'",
      "echo ''",
      "echo '=== SHARE DETAILS ==='",
      "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | while read -r share; do",
      "  [ -n \"$share\" ] || continue",
      "  echo \"--- $share ---\"",
      "  LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --get \"$share\" 2>/dev/null | awk -F= '/^path=|^vol_path=|^support_acls=|^browseable=|^readonly=|^comment=/{print}'",
      "done",
    ].join("\n"),
  },

  {
    name: "inspect_mounts",
    description: "Shows the live mount graph for data volumes, package storage, tmpfs, and bind mounts. Use when a package sees the wrong path, a share is missing, or an encrypted volume is not mounted where expected.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== FINDMNT TREE ==='",
      "findmnt -R 2>/dev/null | head -200 || mount | head -200",
      "echo ''",
      "echo '=== DATA / PACKAGE MOUNTS ==='",
      "mount | awk '$3 ~ /^\\/volume[0-9]+/ || $3 ~ /^\\/var\\/packages/ || $3 ~ /^\\/run/ || $3 ~ /^\\/tmp/ {print}' | head -200",
      "echo ''",
      "echo '=== BLOCK DEVICES ==='",
      "lsblk -o NAME,FSTYPE,SIZE,MOUNTPOINT,LABEL 2>/dev/null || echo 'lsblk not available'",
    ].join("\n"),
  },

  {
    name: "inspect_encryption_state",
    description: "Checks whether Synology volumes and shares appear mounted, unlocked, and writable from the host. Use this when a share disappears after reboot or a package cannot see expected data.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== VOLUME DIRECTORIES ==='",
      "for v in /volume[0-9]*; do [ -e \"$v\" ] || continue; stat -c '%A %U:%G %n' \"$v\" 2>/dev/null || ls -ld \"$v\"; done",
      "echo ''",
      "echo '=== MOUNTED DATA PATHS ==='",
      "mount | awk '$3 ~ /^\\/volume[0-9]+/ {print}' | sort -u",
      "echo ''",
      "echo '=== SHARE ACCESS CHECK ==='",
      "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | while read -r share; do",
      "  [ -n \"$share\" ] || continue",
      "  path=$(LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --get \"$share\" 2>/dev/null | awk -F= '/^path=/{print $2; exit}')",
      "  [ -n \"$path\" ] || continue",
      "  if [ -d \"$path\" ]; then printf 'OK %s %s\\n' \"$share\" \"$path\"; else printf 'MISSING %s %s\\n' \"$share\" \"$path\"; fi",
      "done",
    ].join("\n"),
  },

  {
    name: "check_disk_space",
    description: "Shows disk usage for all active NAS data volumes and how much free space remains on each.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DATA VOLUME USAGE ==='",
      "df -h 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume[0-9]+$/' || df -h /volume1",
      "echo ''",
      "echo '=== INODE USAGE ==='",
      "df -i 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume[0-9]+$/' || df -i /volume1",
    ].join("\n"),
  },

  {
    name: "check_hardware_temps",
    description: "Reads CPU and chassis temperature sensors, fan speeds, and SMART disk temperatures. Run when the NAS is throttling, unexpectedly shutting down, or you suspect thermal problems.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== THERMAL ZONES ==='",
      "for f in /host/sys/class/thermal/thermal_zone*/temp; do",
      "  [ -f \"$f\" ] || continue",
      "  zone=$(dirname \"$f\" | xargs basename)",
      "  type=$(cat \"$(dirname \"$f\")/type\" 2>/dev/null || echo unknown)",
      "  val=$(cat \"$f\" 2>/dev/null || echo 0)",
      "  awk -v v=\"$val\" -v z=\"$zone\" -v t=\"$type\" 'BEGIN{printf \"%s (%s): %.1fC\\n\",z,t,v/1000}'",
      "done 2>/dev/null || echo 'No thermal zones at /host/sys/class/thermal'",
      "echo ''",
      "echo '=== HWMON SENSORS ==='",
      "for f in /host/sys/class/hwmon/hwmon*/temp*_input; do",
      "  [ -f \"$f\" ] || continue",
      "  lf=\"${f%_input}_label\"; label=$(cat \"$lf\" 2>/dev/null || basename \"$f\")",
      "  val=$(cat \"$f\" 2>/dev/null || echo 0)",
      "  awk -v v=\"$val\" -v l=\"$label\" 'BEGIN{printf \"%s: %.1fC\\n\",l,v/1000}'",
      "done 2>/dev/null || echo 'No hwmon sensors at /host/sys/class/hwmon'",
      "echo ''",
      "echo '=== FAN SPEEDS ==='",
      "for f in /host/sys/class/hwmon/hwmon*/fan*_input; do",
      "  [ -f \"$f\" ] || continue",
      "  lf=\"${f%_input}_label\"; label=$(cat \"$lf\" 2>/dev/null || basename \"$f\")",
      "  val=$(cat \"$f\" 2>/dev/null || echo ?)",
      "  echo \"$label: $val RPM\"",
      "done 2>/dev/null || echo 'No fan sensors found'",
      "echo ''",
      "echo '=== DISK TEMPS (SMART) ==='",
      "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo -n \"$d: \"; smartctl -A \"$d\" 2>/dev/null | grep -iE 'Temperature_Celsius|Airflow_Temp' | awk '{printf \"%sC\\n\",$10}' || echo 'N/A'; done 2>/dev/null || echo 'smartctl not available'",
      "echo ''",
      "echo '=== SYNOLOGY THERMAL ==='",
      "/host/usr/syno/bin/synothermalinfo 2>/dev/null || echo 'synothermalinfo not available on this model'",
    ].join("\n"),
  },

  {
    name: "check_volume_health",
    description: "Checks storage pool and volume health at the DSM layer (synovolumestatus, synoarraystatus), /proc/mdstat for RAID state, per-volume disk usage, and SMART overall health for all drives.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== SYNOLOGY VOLUME STATUS ==='",
      "/host/usr/syno/sbin/synovolumestatus 2>/dev/null || echo 'synovolumestatus not available'",
      "echo ''",
      "echo '=== SYNOLOGY ARRAY STATUS ==='",
      "/host/usr/syno/sbin/synoarraystatus 2>/dev/null || echo 'synoarraystatus not available'",
      "echo ''",
      "echo '=== /proc/mdstat ==='",
      "cat /proc/mdstat 2>/dev/null || echo 'mdstat not available'",
      "echo ''",
      "echo '=== DISK USAGE (all volumes) ==='",
      "df -h 2>/dev/null | grep -E 'volume|Filesystem' | head -20",
      "echo ''",
      "echo '=== SMART HEALTH (all disks) ==='",
      "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo -n \"$d: \"; smartctl -H \"$d\" 2>/dev/null | grep -iE 'result|Status|PASSED|FAILED' || echo 'N/A'; done 2>/dev/null || echo 'smartctl not available'",
    ].join("\n"),
  },

  {
    name: "check_agent_container",
    description: "Confirms whether the Synology Monitor agent container is currently running via DSM Container Manager WebAPI.",
    write: false,
    params: { target },
    buildCommand: () =>
      "/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=list 2>/dev/null | grep -E 'synology-monitor-(agent|nas-api)' || true",
  },

  {
    name: "check_cpu_iowait",
    description: "Measures CPU I/O wait on the NAS — the percentage of time the CPU is stuck waiting for disk. Values above 20% indicate an I/O problem.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== CURRENT CPU IOWAIT ==='",
      "vmstat 1 3 | tail -1 | awk '{print \"vmstat wa=\" $16 \"%\"}'",
      "echo ''",
      "echo '=== /proc/stat SAMPLE (two snapshots) ==='",
      "read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat",
      "t1=$((user+nice+system+idle+iowait+irq+softirq+steal))",
      "w1=$iowait",
      "sleep 1",
      "read cpu user nice system idle iowait irq softirq steal guest guest_nice < /proc/stat",
      "t2=$((user+nice+system+idle+iowait+irq+softirq+steal))",
      "w2=$iowait",
      "dt=$((t2-t1))",
      "dw=$((w2-w1))",
      "if [ \"$dt\" -gt 0 ]; then awk -v dw=\"$dw\" -v dt=\"$dt\" 'BEGIN { printf(\"procstat iowait=%.2f%%\\n\", (dw/dt)*100) }'; else echo 'procstat iowait unavailable'; fi",
      "echo ''",
      "echo '=== TOP SNAPSHOT ==='",
      "top -b -n2 -d0.3 2>/dev/null | grep 'Cpu(s)' | tail -1 || true",
      "echo ''",
      "echo '=== PER-CPU IOWAIT (2-second delta) ==='",
      "paste <(grep '^cpu[0-9]' /proc/stat 2>/dev/null || grep '^cpu[0-9]' /host/proc/stat 2>/dev/null) <(sleep 2; grep '^cpu[0-9]' /proc/stat 2>/dev/null || grep '^cpu[0-9]' /host/proc/stat 2>/dev/null) 2>/dev/null | awk '{cpu=$1; t1=$2+$3+$4+$5+$6+$7+$8+$9; w1=$6; t2=$11+$12+$13+$14+$15+$16+$17+$18; w2=$15; dt=t2-t1; dw=w2-w1; if(dt>0) printf \"%s iowait=%.1f%%\\n\",cpu,(dw/dt)*100}' || echo 'Per-CPU iowait not available'",
    ].join("\n"),
  },

  {
    name: "get_resource_snapshot",
    description: "Full live picture of the NAS: top processes by CPU/memory, disk I/O per disk, active SMB/NFS/Drive connections, ShareSync backlog, memory pressure, and recent kernel errors. Best first tool to run when diagnosing any performance problem.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== TOP CPU/MEM ==='",
      "ps aux --sort=-%cpu | head -20",
      "echo '=== DISK IO (diskstats) ==='",
      "awk '{if (($4+$8)>0) print $3, \"reads:\", $4, \"writes:\", $8, \"inprog:\", $12}' /proc/diskstats | grep -E 'sd|md'",
      "echo '=== OPEN FILES ON VOLUMES ==='",
      "timeout 8 lsof -nP 2>/dev/null | awk 'NR>1 && $9 ~ /^\\/volume[0-9]+\\// {print $1,$3,$9}' | sort | uniq -c | sort -rn | head -15 || true",
      "echo '=== SMB SESSIONS ==='",
      "timeout 8 smbstatus -S 2>/dev/null | head -30 || ss -tnp 'sport = :445' 2>/dev/null | head -20 || echo 'SMB status unavailable'",
      "echo '=== NETWORK TOP PEERS ==='",
      "ss -tn state established 2>/dev/null | awk 'NR>1{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -20",
      "echo '=== SHARESYNC TASKS ==='",
      "for v in /volume[0-9]*; do",
      "  for f in \"$v\"/*/@synologydrive/log/syncfolder.log \"$v\"/@SynologyDriveShareSync/*/log/syncfolder.log; do",
      "    [ -f \"$f\" ] || continue; echo \"=== $f ===\"; tail -20 \"$f\"",
      "  done",
      "done 2>/dev/null || true",
      "echo '=== MEMORY PRESSURE ==='",
      "free -h",
      "grep -E 'MemAvail|Dirty|Writeback|SwapTotal|SwapFree' /proc/meminfo",
      "echo '=== IO WAIT ==='",
      "top -b -n2 -d0.3 2>/dev/null | grep 'Cpu(s)' | tail -1 || vmstat 1 2 | tail -1",
      "echo '=== KERNEL ERRORS (last 50) ==='",
      "dmesg -T 2>/dev/null | grep -iE 'error|warn|fail|oom|i\\/o' | tail -50 || dmesg | tail -50",
    ].join("\n"),
  },

  {
    name: "check_io_stalls",
    description: "Looks for processes stuck waiting on disk (D-state), measures I/O wait percentage, checks disk queue depth, RAID sync/rebuild status, and finds hung task kernel warnings. Run when the NAS feels slow or unresponsive.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== RAID SYNC / REBUILD STATUS ==='",
      "cat /proc/mdstat 2>/dev/null | head -40 || echo 'mdstat not available'",
      "grep -qE 'check|resync|recover|reshape' /proc/mdstat 2>/dev/null && echo '*** RAID operation in progress — this is a common cause of high iowait ***' || true",
      "echo ''",
      "echo '=== PROCESSES IN D-STATE (I/O WAIT) ==='",
      "ps aux | awk '$8 ~ /D/ {print}' | head -30 || echo 'No D-state processes'",
      "echo ''",
      "echo '=== I/O WAIT CPU PERCENTAGE ==='",
      "top -b -n2 -d1 2>/dev/null | grep -i 'cpu' | tail -1 || vmstat 1 2 | tail -1",
      "echo ''",
      "echo '=== DISK QUEUE DEPTH ==='",
      "cat /proc/diskstats | awk '{if ($4+$8>0) printf \"%-8s reads:%-8d writes:%-8d in_progress:%-4d\\n\", $3, $4, $8, $12}' | grep -E 'sd|md|dm'",
      "echo ''",
      "echo '=== HUNG TASK WARNINGS (kernel) ==='",
      "dmesg -T 2>/dev/null | grep -i 'blocked for more than\\|hung_task\\|INFO: task' | tail -20 || dmesg | grep -i 'blocked\\|hung' | tail -20 || echo 'No hung task warnings'",
      "echo ''",
      "echo '=== TOP I/O CONSUMERS ==='",
      "iotop -b -o -n1 -P 2>/dev/null | head -20 || echo 'iotop not available'",
    ].join("\n"),
  },

  {
    name: "check_process_io_detail",
    description: "Deep per-process I/O diagnostic without ptrace or extra capabilities. For each given PID (or auto-detected D-state processes if no PIDs given), shows: the kernel function the process is sleeping in (wchan), the full kernel call stack (/proc/PID/stack — readable with CAP_SYS_ADMIN), open file descriptors on volumes, I/O scheduling class (ionice -p), and current working directory. Use this to identify exactly what a D-state process is waiting for without strace.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const rawFilter = (input.filter as string | undefined)?.trim();
      const pidSetup = rawFilter
        ? `PIDS="${rawFilter.split(/\s+/).join(" ")}"`
        : `PIDS=$(ps ax -o pid,stat | awk '$2 ~ /D/ {print $1}' | head -10 | tr '\\n' ' ')`;
      return [
        "echo '=== D-STATE PROCESSES (direct iowait source) ==='",
        "ps ax -o pid,stat,comm,args | awk '$2 ~ /D/ {print}' | head -20 || echo 'No D-state processes'",
        "echo ''",
        "echo '=== PER-PROCESS KERNEL DETAIL ==='",
        pidSetup,
        `if [ -z "$PIDS" ]; then echo 'No target PIDs (no D-state processes or empty filter)'; exit 0; fi`,
        "for pid in $PIDS; do",
        "  [ -z \"$pid\" ] && continue",
        "  echo \"--- PID $pid ---\"",
        "  echo -n 'wchan (kernel sleep point): '",
        "  cat /proc/$pid/wchan 2>/dev/null || cat /host/proc/$pid/wchan 2>/dev/null || echo 'n/a'",
        "  echo ''",
        "  echo 'kernel call stack (/proc/$pid/stack):'",
        "  cat /proc/$pid/stack 2>/dev/null | head -20 || cat /host/proc/$pid/stack 2>/dev/null | head -20 || echo '  (not readable — needs CAP_SYS_ADMIN)'",
        "  echo 'open volume/network fds:'",
        "  ls -la /proc/$pid/fd 2>/dev/null | grep -E '(/volume|/btrfs|nfs|smb|socket)' | head -10 || echo '  none visible'",
        "  echo -n 'ionice I/O priority class: '",
        "  ionice -p $pid 2>/dev/null || echo 'ionice not available'",
        "  echo -n 'cwd: '",
        "  readlink /proc/$pid/cwd 2>/dev/null || echo 'n/a'",
        "  echo ''",
        "done",
      ].join("\n");
    },
  },

  {
    name: "strace_process",
    description: "Attaches strace to a running process for 5 seconds and returns a syscall-count summary. Uses -c (count mode) so individual syscall arguments are NOT printed — avoids exposing passwords or file contents in logs. Requires CAP_SYS_PTRACE (set in docker-compose). Especially useful for D-state processes: the top syscalls by time directly show what the process is waiting for (e.g. fsync, write, sendfile). Pass a PID in filter.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("strace_process: pass a numeric PID in filter.");
      const pid = raw.split(/\s+/)[0];
      if (!/^\d+$/.test(pid)) throw new Error("strace_process: filter must be a numeric PID.");
      return [
        `echo '=== PROCESS ==='`,
        `ps -p ${pid} -o pid,stat,comm,args 2>/dev/null || echo 'PID ${pid} not found'`,
        `echo ''`,
        `echo '=== STRACE SYSCALL SUMMARY (5 seconds, count mode) ==='`,
        `echo 'Sampling PID ${pid} for 5 seconds — count mode only, no argument data printed...'`,
        `timeout 7 strace -p ${pid} -e trace=read,write,open,openat,close,ioctl,sync,fsync,fdatasync,pread64,pwrite64,sendfile,rename,unlink -c 2>&1; true`,
        `echo ''`,
        `echo '=== WCHAN ==='`,
        `cat /proc/${pid}/wchan 2>/dev/null || echo 'n/a'`,
        `echo ''`,
        `echo '=== KERNEL STACK ==='`,
        `cat /proc/${pid}/stack 2>/dev/null | head -20 || echo 'not readable'`,
      ].join("\n");
    },
  },

  {
    name: "hdparm_device_info",
    description: "Reads hard disk identity (model, firmware, ATA features, security state) and measures raw buffered-read throughput via hdparm. Requires /dev/sdX or /dev/mdX mounted in the container (configured in docker-compose). hdparm -I shows device capabilities; hdparm -t measures actual read speed (read-only, safe). Use to verify whether a disk is genuinely slow vs. just queue-saturated.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const device = ((input.filter as string | undefined)?.trim() || "sda").replace(/^\/dev\//, "");
      if (!/^[a-z0-9]+$/.test(device)) throw new Error("hdparm_device_info: invalid device name — use e.g. sda, sdb, md0.");
      return [
        `echo '=== DEVICE IDENTITY (hdparm -I /dev/${device}) ==='`,
        `hdparm -I /dev/${device} 2>/dev/null || echo 'hdparm not available or /dev/${device} not mounted in container (check docker-compose nas-api volumes)'`,
        `echo ''`,
        `echo '=== BUFFERED READ SPEED (hdparm -t /dev/${device}) ==='`,
        `echo 'Expected: spinning HDD ~100-200 MB/s, SSD ~400-600 MB/s, RAID array varies by RAID level'`,
        `hdparm -t /dev/${device} 2>/dev/null || echo 'hdparm not available or device not accessible'`,
        `echo ''`,
        `echo '=== /sys STATS (always available) ==='`,
        `cat /host/sys/block/${device}/queue/scheduler 2>/dev/null | xargs echo 'scheduler:'`,
        `cat /host/sys/block/${device}/queue/rotational 2>/dev/null | xargs echo 'rotational:'`,
        `cat /host/sys/block/${device}/device/model 2>/dev/null | xargs echo 'model:'`,
      ].join("\n");
    },
  },

  {
    name: "check_psi_pressure",
    description: "Reads Linux PSI (Pressure Stall Information) — the most precise modern metric for resource contention. Reports what % of time tasks were stalled waiting for I/O, CPU, or memory. 'some' = at least one task stalled; 'full' = all runnable tasks stalled (device fully saturated). Any 'full io' value above 5% indicates serious I/O saturation. Available on DSM 7.x (kernel 4.20+).",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== I/O PRESSURE STALL (PSI) ==='",
      "cat /host/proc/pressure/io 2>/dev/null || cat /proc/pressure/io 2>/dev/null || echo 'PSI not available (kernel < 4.20 or /proc/pressure not mounted)'",
      "echo ''",
      "echo '=== CPU PRESSURE STALL (PSI) ==='",
      "cat /host/proc/pressure/cpu 2>/dev/null || cat /proc/pressure/cpu 2>/dev/null || echo 'CPU PSI not available'",
      "echo ''",
      "echo '=== MEMORY PRESSURE STALL (PSI) ==='",
      "cat /host/proc/pressure/memory 2>/dev/null || cat /proc/pressure/memory 2>/dev/null || echo 'Memory PSI not available'",
      "echo ''",
      "echo 'FORMAT: avg10=<10s_%> avg60=<60s_%> avg300=<5min_%> total=<cumulative_us>'",
      "echo \"'some' = >=1 task stalled; 'full' = 100% of runnable tasks stalled (complete device saturation)\"",
    ].join("\n"),
  },

  {
    name: "check_memory_detail",
    description: "Detailed memory view: full /proc/meminfo, swap activity rates from vmstat, dirty/writeback pages, and OOM kill history from dmesg. Use when you suspect memory pressure or swap thrashing.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== MEMORY OVERVIEW ==='",
      "free -h",
      "echo ''",
      "echo '=== SWAP ACTIVITY (3 samples) ==='",
      "vmstat 1 3",
      "echo ''",
      "echo '=== KEY MEMINFO FIELDS ==='",
      "grep -E 'MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree|SwapCached|Dirty|Writeback|AnonPages|Mapped|Shmem|PageTables|VmallocUsed|HugePages' /proc/meminfo",
      "echo ''",
      "echo '=== VM DIRTY PAGE THRESHOLDS ==='",
      "for f in dirty_ratio dirty_background_ratio dirty_expire_centisecs dirty_writeback_centisecs; do printf 'vm.%-38s %s\\n' \"$f\" \"$(cat /proc/sys/vm/$f 2>/dev/null || echo unavailable)\"; done",
      "echo '(dirty_ratio: force-flush at this % of RAM; dirty_background_ratio: background flush starts at this %)'",
      "echo ''",
      "echo '=== TOP MEMORY CONSUMERS ==='",
      "ps aux --sort=-%mem | head -20",
      "echo ''",
      "echo '=== OOM KILL HISTORY ==='",
      "dmesg -T 2>/dev/null | grep -iE 'oom|killed process|out of memory' | tail -20 || dmesg | grep -i 'oom\\|killed' | tail -20 || echo 'No OOM events found'",
    ].join("\n"),
  },

  {
    name: "check_network_health",
    description: "Checks network interface stats (errors, dropped packets, carrier changes), routing table, active listening ports, NFS connections, and whether DNS resolution is working.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== INTERFACE ERRORS & DROPS ==='",
      "cat /proc/net/dev | awk 'NR>2{gsub(\":\",\" \",$1); printf \"%-12s RX_errs:%-6s RX_drop:%-6s TX_errs:%-6s TX_drop:%-6s\\n\",$1,$4,$5,$12,$13}' | grep -v '^lo '",
      "echo ''",
      "echo '=== INTERFACE IP ADDRESSES ==='",
      "ip addr 2>/dev/null | grep -E 'inet|^[0-9]+:' | head -30 || cat /proc/net/if_inet6 | head -10 || echo 'ip command not available'",
      "echo ''",
      "echo '=== ROUTING TABLE ==='",
      "ip route 2>/dev/null || route -n 2>/dev/null || cat /proc/net/route | head -10",
      "echo ''",
      "echo '=== DNS RESOLUTION TEST ==='",
      "nslookup google.com 2>/dev/null | head -6 || host google.com 2>/dev/null | head -3 || getent hosts google.com 2>/dev/null | head -3 || echo 'DNS lookup tools not available'",
      "echo ''",
      "echo '=== LISTENING PORTS ==='",
      "ss -tulnp 2>/dev/null | head -40 || cat /proc/net/tcp /proc/net/udp 2>/dev/null | awk 'NR>1{printf \"%s\\n\",$2}' | head -30 || echo 'Port listing not available'",
      "echo ''",
      "echo '=== ACTIVE NFS CONNECTIONS ==='",
      "ss -tnp 'sport = :2049 or dport = :2049' 2>/dev/null | head -20 || echo 'No active NFS connections (or ss not available)'",
      "echo ''",
      "echo '=== SMB CONNECTIONS ==='",
      "ss -tnp 'sport = :445' 2>/dev/null | head -20 || echo 'No active SMB connections visible'",
    ].join("\n"),
  },

  {
    name: "check_tailscale",
    description: "Checks Tailscale VPN status — whether the tailscale0 interface is up, what IP it has, and whether the Tailscale daemon is reachable. Critical because the entire cloud-to-NAS diagnostic path runs over Tailscale.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== TAILSCALE INTERFACE ==='",
      "ip addr show tailscale0 2>/dev/null || echo 'tailscale0 interface not found — VPN is down or not installed'",
      "echo ''",
      "echo '=== TAILSCALE LINK ==='",
      "ip link show tailscale0 2>/dev/null || echo 'No tailscale0 link'",
      "echo ''",
      "echo '=== TAILSCALE ROUTING ==='",
      "ip route show dev tailscale0 2>/dev/null || echo 'No routes via tailscale0'",
      "echo ''",
      "echo '=== TAILSCALE DAEMON REACHABLE ==='",
      "ls /var/packages/Tailscale/ 2>/dev/null && echo 'Tailscale package installed' || echo 'Tailscale package not found at /var/packages/Tailscale'",
      "/var/packages/Tailscale/target/bin/tailscale status 2>/dev/null || echo 'Cannot reach tailscale daemon from container (socket not mounted)'",
      "echo ''",
      "echo '=== CONNECTIVITY CHECK ==='",
      "ping -c 2 -W 3 100.100.100.100 2>/dev/null && echo 'Tailscale magic DNS reachable' || echo 'Tailscale magic DNS (100.100.100.100) unreachable'",
    ].join("\n"),
  },

  {
    name: "check_network_connections",
    description: "Shows all active TCP connections per process, connection counts by state, and top connected peers. Use when you suspect a process is flooding the network or holding many idle connections.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== CONNECTION SUMMARY BY STATE ==='",
      "ss -s 2>/dev/null || cat /proc/net/sockstat 2>/dev/null | head -10",
      "echo ''",
      "echo '=== ESTABLISHED CONNECTIONS WITH PROCESS ==='",
      "ss -tnp state established 2>/dev/null | head -50",
      "echo ''",
      "echo '=== TOP CONNECTED PEERS ==='",
      "ss -tn state established 2>/dev/null | awk 'NR>1{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -20",
      "echo ''",
      "echo '=== SYNOLOGY DRIVE SYNC CONNECTIONS (port 6690) ==='",
      "ss -tnp 'sport = :6690 or dport = :6690' 2>/dev/null | head -20 || echo 'No Drive sync connections on 6690'",
    ].join("\n"),
  },

  {
    name: "check_security_log",
    description: "Shows failed login attempts, security events, admin audit entries, and recent SSH connection attempts. Use when you suspect unauthorized access or to investigate blocked access issues.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 2) * 30, 40, 200);
      return [
        "echo '=== DSM SECURITY LOG ==='",
        `tail -n ${lines} /host/log/synolog/synosecurity.log 2>/dev/null || echo 'Security log not found at /host/log/synolog/synosecurity.log'`,
        "echo ''",
        "echo '=== FAILED LOGINS / AUTH FAILURES ==='",
        `grep -iE 'fail|invalid|wrong|denied|blocked|unauthorized' /host/log/synolog/synosecurity.log 2>/dev/null | tail -${lines} || grep -iE 'fail|invalid|authentication' /host/log/auth.log 2>/dev/null | tail -${lines} || echo 'Auth log not found'`,
        "echo ''",
        "echo '=== ADMIN AUDIT LOG ==='",
        `tail -n ${lines} /host/log/synolog/synoauditd.log 2>/dev/null || echo 'Audit log not found'`,
        "echo ''",
        "echo '=== SSH CONNECTIONS ==='",
        `grep -iE 'sshd|ssh.*accept|ssh.*fail' /host/log/auth.log 2>/dev/null | tail -20 || grep -i 'sshd' /host/log/messages 2>/dev/null | tail -20 || echo 'SSH log not found'`,
      ].join("\n");
    },
  },

  {
    name: "check_active_sessions",
    description: "Lists currently active SMB, NFS, SFTP/SSH, and DSM web sessions. Tells you exactly who is connected to the NAS right now.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== ACTIVE SMB SESSIONS ==='",
      "timeout 10 smbstatus 2>/dev/null | head -60 || echo 'smbstatus not available — checking port 445'",
      "ss -tnp 'sport = :445' 2>/dev/null | head -20 || true",
      "echo ''",
      "echo '=== ACTIVE NFS CLIENTS ==='",
      "showmount --no-headers -a 2>/dev/null | head -20 || ss -tnp 'dport = :2049 or sport = :2049' 2>/dev/null | head -20 || echo 'No NFS session info available'",
      "echo ''",
      "echo '=== SSH/SFTP SESSIONS ==='",
      "ss -tnp 'sport = :22' 2>/dev/null | grep -v '127.0.0.1' | head -20 || echo 'No external SSH sessions'",
      "echo ''",
      "echo '=== DSM WEB SESSIONS (port 5000/5001) ==='",
      "ss -tnp 'sport = :5000 or sport = :5001' 2>/dev/null | head -20 || echo 'No DSM web sessions visible'",
      "echo ''",
      "echo '=== SYNOLOGY DRIVE SESSIONS (port 6690) ==='",
      "ss -tnp 'sport = :6690' 2>/dev/null | head -20 || echo 'No Drive sync connections visible'",
      "echo ''",
      "echo '=== ALL ESTABLISHED CONNECTIONS (top peers) ==='",
      "ss -tn state established 2>/dev/null | awk 'NR>1{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -15",
    ].join("\n"),
  },

  {
    name: "check_packages",
    description: "Lists all installed DSM packages, their running status, and version. Also checks recent package install/update events. Use to understand what software is on the NAS and whether packages are healthy.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== ALL INSTALLED PACKAGES ==='",
      "for d in /var/packages/*/; do pkg=$(basename \"$d\"); ver=$(grep -m1 '^version=' \"${d}INFO\" 2>/dev/null | cut -d= -f2-); enabled=$([ -f \"${d}enabled\" ] && echo enabled || echo disabled); echo \"$pkg $ver [$enabled]\"; done 2>/dev/null || echo 'Package list not available'",
      "echo ''",
      "echo '=== KEY PACKAGE STATUS ==='",
      "for pkg in SynologyDrive SynologyDriveShareSync HyperBackup HyperBackupVault CloudSync ActiveBackupForBusiness Moments VideoStation AudioStation ContainerManager; do",
      "  [ -d \"/var/packages/$pkg\" ] || continue",
      "  ver=$(grep -m1 '^version=' \"/var/packages/$pkg/INFO\" 2>/dev/null | cut -d= -f2-)",
      "  enabled=$([ -f \"/var/packages/$pkg/enabled\" ] && echo enabled || echo disabled)",
      "  echo \"$pkg $ver [$enabled]\"",
      "done",
      "echo ''",
      "echo '=== RECENT PACKAGE EVENTS ==='",
      "grep -iE 'install|update|upgrade|uninstall|start|stop' /host/log/synolog/synopkg.log 2>/dev/null | tail -30 || echo 'Package log not found'",
    ].join("\n"),
  },

  {
    name: "tail_system_log",
    description: "Shows the most recent entries from /var/log/messages — the general system log capturing kernel events, service starts/stops, USB events, and anything not going to a specific app log.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 2) * 40, 60, 400);
      return [
        "echo '=== SYSTEM LOG (/var/log/messages) ==='",
        `tail -n ${lines} /host/log/messages 2>/dev/null || tail -n ${lines} /host/log/syslog 2>/dev/null || echo 'System log not found at /host/log/messages or /host/log/syslog'`,
      ].join("\n");
    },
  },

  {
    name: "tail_drive_server_log",
    description: "Shows the most recent entries from the Synology Drive server log.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) =>
      `tail -n ${clamp((input.lookback_hours as number ?? 2) * 40, 40, 300)} /host/log/synologydrive.log 2>/dev/null || echo 'Drive server log not found at /host/log/synologydrive.log'`,
  },

  {
    name: "search_drive_server_log",
    description: "Searches the Synology Drive server log for a specific word or phrase — such as a share name, username, or error message.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "error";
      const lines = clamp((input.lookback_hours as number ?? 2) * 40, 40, 300);
      return `grep -i ${quote(f)} /host/log/synologydrive.log 2>/dev/null | tail -n ${lines} || echo 'Drive log not found'`;
    },
  },

  {
    name: "tail_sharesync_log",
    description: "Shows the most recent ShareSync log entries — what files are being synced and any sync errors. Searches across all data volumes.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 2) * 30, 40, 240);
      return [
        "echo '=== SHARESYNC LOGS (all volumes) ==='",
        "for v in /volume[0-9]*; do",
        `  for f in "$v"/*/@synologydrive/log/syncfolder.log "$v"/@SynologyDriveShareSync/*/log/syncfolder.log; do`,
        `    [ -f "$f" ] || continue`,
        `    echo "=== $f ==="`,
        `    tail -n ${lines} "$f"`,
        "  done",
        "done 2>/dev/null || echo 'No ShareSync logs found on any volume'",
      ].join("\n");
    },
  },

  {
    name: "check_sharesync_status",
    description: "Looks specifically for stuck, conflicted, or erroring ShareSync tasks in the recent logs. Searches across all data volumes.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 2) * 40, 60, 200);
      return [
        "echo '=== SHARESYNC STATUS (all volumes) ==='",
        "found=0",
        "for v in /volume[0-9]*; do",
        `  for f in "$v"/*/@synologydrive/log/syncfolder.log "$v"/@SynologyDriveShareSync/*/log/syncfolder.log; do`,
        `    [ -f "$f" ] || continue`,
        "    found=1",
        `    echo "=== $f ==="`,
        `    tail -n ${lines} "$f" | grep -A2 -B2 -i 'syncing\\|stuck\\|error\\|conflict' || echo 'No issues in recent entries'`,
        "  done",
        "done 2>/dev/null",
        `[ "$found" -eq 0 ] && echo 'No ShareSync logs found on any volume'`,
      ].join("\n");
    },
  },

  {
    name: "check_kernel_io_errors",
    description: "Reads the Linux kernel error log for disk errors, SCSI faults, filesystem corruption, and memory problems. Critical for distinguishing a software bug from a failing hard drive.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== KERNEL I/O & DISK ERRORS ==='",
      "dmesg -T 2>/dev/null | grep -iE 'i/o error|scsi|ata.*error|blk_update|buffer i/o|ext4.*error|btrfs.*error|md.*error|raid.*error|sector|fault|stall|hung_task|blocked for' | tail -60 || dmesg | grep -iE 'error|scsi|ata|fault|stall' | tail -60",
      "echo ''",
      "echo '=== FILESYSTEM ERRORS ==='",
      "dmesg -T 2>/dev/null | grep -iE 'EXT4-fs|BTRFS|error.*mount|mount.*error' | tail -20 || true",
      "echo ''",
      "echo '=== OOM EVENTS ==='",
      "dmesg -T 2>/dev/null | grep -iE 'oom|out of memory|killed process' | tail -10 || true",
    ].join("\n"),
  },

  {
    name: "check_share_database",
    description: "Lists all shared folders from the DSM share database. Failures here indicate database corruption which prevents Synology Drive from working.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== SHARE DATABASE ENUMERATION ==='",
      "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>&1 || echo 'synoshare --enum failed (share database may be corrupted)'",
      "echo ''",
      "echo '=== SHARE DETAILS (first 10) ==='",
      `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | head -10 | while read -r name; do echo "--- $name ---"; LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --get "$name" 2>&1 | head -15; done`,
    ].join("\n"),
  },

  {
    name: "check_drive_package_health",
    description: "Checks whether the Synology Drive package is properly installed — its status, version, internal database files, and log locations. Detects broken installations. Searches across all data volumes.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DRIVE PACKAGE STATUS ==='",
      "for pkg in SynologyDrive SynologyDriveShareSync; do ver=$(grep -m1 '^version=' /var/packages/$pkg/INFO 2>/dev/null | cut -d= -f2-); enabled=$([ -f /var/packages/$pkg/enabled ] && echo enabled || echo disabled); echo \"$pkg: $ver [$enabled]\"; done",
      "echo ''",
      "echo '=== DRIVE VERSION ==='",
      "grep -m1 '^version=' /var/packages/SynologyDrive/INFO 2>/dev/null || echo 'SynologyDrive not found'",
      "echo ''",
      "echo '=== DRIVE DATA DIR (all volumes) ==='",
      "for v in /volume[0-9]*; do",
      "  [ -d \"$v/@synologydrive\" ] || continue",
      "  echo \"Found: $v/@synologydrive\"",
      "  ls -lh \"$v/@synologydrive/\" 2>/dev/null | head -10",
      "done 2>/dev/null || echo 'No @synologydrive dir found on any volume'",
      "echo ''",
      "echo '=== DRIVE DATABASE FILES (all volumes) ==='",
      "find /volume[0-9]*/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -20",
      "echo ''",
      "echo '=== RECENT DRIVE PACKAGE LOG ==='",
      "grep -i 'synologydrive\\|SynologyDrive' /host/log/synolog/synopkg.log 2>/dev/null | tail -20 || echo 'Package log not found'",
    ].join("\n"),
  },

  {
    name: "check_drive_database",
    description: "Checks Synology Drive's internal SQLite databases for corruption. Database corruption causes persistent sync failures that won't resolve on their own. Searches across all data volumes.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DRIVE DATABASE FILES (all volumes) ==='",
      "find /volume[0-9]*/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -10",
      "echo ''",
      "echo '=== INTEGRITY CHECK (first 3 DBs) ==='",
      "find /volume[0-9]*/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -3 | while read db; do echo \"--- $db ---\"; timeout 10 sqlite3 \"$db\" 'PRAGMA integrity_check;' 2>&1 | head -5 || echo 'timeout or error'; done",
      "echo ''",
      "echo '=== MAIN DRIVE DB TABLES ==='",
      "maindb=$(find /volume[0-9]*/@synologydrive/ -maxdepth 3 \\( -name 'synodrive.db' -o -name 'sync.db' \\) 2>/dev/null | head -1); [ -n \"$maindb\" ] && echo \"DB: $maindb\" && timeout 10 sqlite3 \"$maindb\" '.tables' 2>&1 | head -20 || echo 'Main Drive DB not found'",
    ].join("\n"),
  },

  {
    name: "search_webapi_log",
    description: "Searches DSM WebAPI logs for share access failures, authentication errors, and API call failures.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "SYNOShare|share.*error|failed.*share";
      const lines = clamp((input.lookback_hours as number ?? 4) * 40, 60, 300);
      return [
        "echo '=== WEBAPI LOG ==='",
        `grep -iE ${quote(f)} /host/log/synolog/synowebapi.log 2>/dev/null | tail -n ${lines} || echo 'WebAPI log not found at /host/log/synolog/synowebapi.log'`,
        "echo ''",
        "echo '=== STORAGE LOG ==='",
        `grep -iE 'share|volume|storage|mount' /host/log/synolog/synostorage.log 2>/dev/null | tail -40 || echo 'Storage log not found'`,
        "echo ''",
        "echo '=== SHARE LOG ==='",
        `grep -iE 'error|fail|warn' /host/log/synolog/synoshare.log 2>/dev/null | tail -40 || echo 'Share log not found'`,
      ].join("\n");
    },
  },

  {
    name: "search_all_logs",
    description: "Searches every log file on the NAS for a specific word or phrase. Use when you suspect an error is being logged somewhere but don't know where.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "error";
      return [
        `echo '=== SEARCHING ALL LOGS FOR: ${f} ==='`,
        `for logf in /host/log/synolog/*.log /host/log/messages /host/log/kern.log /host/log/synologydrive.log /host/log/samba/*.log; do`,
        `  [ -f "$logf" ] || continue`,
        `  matches=$(grep -ciE ${quote(f)} "$logf" 2>/dev/null || true)`,
        `  [ "$matches" -gt 0 ] 2>/dev/null && echo "$logf: $matches matches" && grep -iE ${quote(f)} "$logf" 2>/dev/null | tail -5 && echo ""`,
        `done`,
      ].join("\n");
    },
  },

  {
    name: "find_problematic_files",
    description: "Finds files with names that break ShareSync: colons, asterisks, question marks, pipes, angle brackets, conflict suffixes, and extremely long names. Returns exact paths that can be fixed with rename_file_to_old or remove_invalid_chars.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const folder = (input.filter as string | undefined)?.trim() || "/volume1";
      return [
        `echo '=== FILES WITH SYNC-BREAKING CHARACTERS IN ${folder} ==='`,
        `find ${folder} -maxdepth 8 \\( -name '*:*' -o -name '*\\**' -o -name '*?*' -o -name '*"*' -o -name '*<*' -o -name '*>*' -o -name '*|*' \\) 2>/dev/null | grep -v '@eaDir' | grep -v '.SynologyWorkingDirectory' | head -50 || echo 'No files with special characters found'`,
        `echo ''`,
        `echo '=== CONFLICT FILES ==='`,
        `find ${folder} -maxdepth 8 \\( -name '*conflicted*' -o -name '*.conflict' -o -name '*~conflict*' \\) 2>/dev/null | grep -v '@eaDir' | head -30 || echo 'No conflict files found'`,
        `echo ''`,
        `echo '=== VERY LONG FILENAMES (>200 chars) ==='`,
        `find ${folder} -maxdepth 8 2>/dev/null | awk 'length($0)>200' | head -20 || echo 'No extremely long filenames'`,
      ].join("\n");
    },
  },

  {
    name: "check_filesystem_health",
    description: "Checks filesystem mount status, inode usage, RAID status, and SMART disk health across all active volumes.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== MOUNT STATUS ==='",
      "mount | grep -E '/volume[0-9]+'",
      "echo ''",
      "echo '=== INODE USAGE (all volumes) ==='",
      "df -i 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume[0-9]+$/'",
      "echo ''",
      "echo '=== FILESYSTEM DETAIL (all volumes) ==='",
      "for v in /volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  echo \"--- $v ---\"",
      "  src=$(mount | awk -v vol=\"$v\" '$3==vol{print $1}' | head -1)",
      "  [ -n \"$src\" ] && (tune2fs -l \"$src\" 2>/dev/null | grep -iE 'filesystem|mount count|error|state|journal' || btrfs filesystem show \"$v\" 2>/dev/null | head -5) || echo 'Could not determine filesystem details'",
      "done",
      "echo ''",
      "echo '=== SMART STATUS ==='",
      "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo \"--- $d ---\"; smartctl -H \"$d\" 2>/dev/null | grep -E 'result|Status'; smartctl -A \"$d\" 2>/dev/null | grep -E 'Reallocated|Current_Pending|Offline_Uncorrectable|Temperature'; done 2>/dev/null || echo 'smartctl not available'",
      "echo ''",
      "echo '=== RAID STATUS ==='",
      "cat /proc/mdstat 2>/dev/null || echo 'No mdstat available'",
    ].join("\n"),
  },

  {
    name: "check_scheduled_tasks",
    description: "Lists DSM scheduled task metadata and recent scheduler errors using DSM 7 path discovery. SQLite databases are opened read-only; missing paths are reported with the candidate list that was checked.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 4) * 10, 20, 80);
      return [
        "echo '=== SCHEDULED TASKS ==='",
        "scheduler_roots='/host/usr/syno/etc/esynoscheduler /host/usr/syno/etc /host/usr/syno/etc/schedule /host/usr/syno/etc/synotask /host/etc /host/etc/synotask /host/packages /host/packages/SnapshotReplication /host/packages/ReplicationService /host/log /usr/syno/etc/esynoscheduler /usr/syno/etc /usr/syno/etc/schedule /usr/syno/etc/synotask /etc /etc/synotask /var/services /var/packages'",
        "dbs=$(",
        "  for root in $scheduler_roots; do",
        "    [ -d \"$root\" ] || continue",
        "    find \"$root\" -maxdepth 5 \\( -iname '*scheduler*.db' -o -iname '*esynoscheduler*.db' -o -iname '*synoscheduler*.db' -o -iname '*task*.db' -o -iname '*schedule*.db' \\) 2>/dev/null",
        "  done | grep -Ei 'sched|task|cron' | sort -u | head -20",
        ")",
        "if [ -z \"$dbs\" ]; then",
        "  echo 'No scheduler SQLite DB found in DSM 7 candidate paths.'",
        "  echo 'Checked roots:'",
        "  for root in $scheduler_roots; do [ -e \"$root\" ] && echo \"  $root\"; done",
        "else",
        "  for dbfile in $dbs; do",
        "    echo \"--- DB: $dbfile ---\"",
        "    echo 'tables:'",
        "    timeout 8 sqlite3 -readonly \"$dbfile\" '.tables' 2>&1 | head -20",
        "    tables=$(timeout 8 sqlite3 -readonly \"$dbfile\" '.tables' 2>/dev/null | tr ' ' '\\n' | grep -Ei 'task|sched|cron|job' | head -8)",
        "    [ -z \"$tables\" ] && echo 'No obvious task/schedule tables by name.'",
        "    for tbl in $tables; do",
        "      echo \"--- table: $tbl schema ---\"",
        "      timeout 8 sqlite3 -readonly \"$dbfile\" \".schema \\\"$tbl\\\"\" 2>&1 | head -30",
        "      echo \"--- table: $tbl rows ---\"",
        "      timeout 8 sqlite3 -readonly \"$dbfile\" \"SELECT * FROM \\\"$tbl\\\" LIMIT 20;\" 2>&1 | head -80",
        "    done",
        "    echo ''",
        "  done",
        "fi",
        "echo ''",
        "echo '=== RECENT SCHEDULER ERRORS ==='",
        "logs=$(",
        "  ls -1 /host/log/synolog/synoscheduler.log /host/var/log/synoscheduler.log /host/var/log/messages 2>/dev/null",
        "  find /host/var/log /host/log /host/var/packages -maxdepth 5 \\( -iname '*scheduler*.log' -o -iname '*synoscheduler*.log' \\) 2>/dev/null | head -20",
        ")",
        "logs=$(echo \"$logs\" | sort -u)",
        "if [ -z \"$logs\" ]; then echo 'Scheduler logs not found in DSM 7 candidate paths.'; fi",
        "for f in $logs; do",
        "  [ -f \"$f\" ] || continue",
        "  echo \"--- $f ---\"",
        `  grep -iE 'error|fail|exit [^0]|snapshot|replica|prune|delete|remove' "$f" 2>/dev/null | tail -${lines} || true`,
        "done",
        "echo ''",
        "echo '=== DSM WEBAPI TASK LIST (READ ONLY FALLBACK) ==='",
        "if [ -z \"${DSM_USERNAME:-}\" ] || [ -z \"${DSM_PASSWORD:-}\" ]; then",
        "  echo 'DSM_USERNAME/DSM_PASSWORD not set; skipping WebAPI task list fallback.'",
        "else",
        "  DSM_BASE=\"http://localhost:${DSM_PORT:-5000}/webapi/entry.cgi\"",
        "  SID=$(curl -sfG \"$DSM_BASE\" --data-urlencode 'api=SYNO.API.Auth' --data-urlencode 'version=7' --data-urlencode 'method=login' --data-urlencode \"account=${DSM_USERNAME}\" --data-urlencode \"passwd=${DSM_PASSWORD}\" --data-urlencode 'format=sid' 2>/dev/null | grep -o '\"sid\":\"[^\"]*\"' | cut -d'\"' -f4)",
        "  if [ -z \"$SID\" ]; then",
        "    echo 'DSM WebAPI login failed; check DSM credentials/port.'",
        "  else",
        "    for api_version in 3 2 1 4; do",
        "      echo \"--- SYNO.Core.TaskScheduler v${api_version} list ---\"",
        "      result=$(curl -sfG \"$DSM_BASE\" --data-urlencode 'api=SYNO.Core.TaskScheduler' --data-urlencode \"version=$api_version\" --data-urlencode 'method=list' --data-urlencode 'offset=0' --data-urlencode 'limit=200' --data-urlencode \"_sid=$SID\" 2>/dev/null)",
        "      echo \"$result\" | head -c 20000",
        "      echo ''",
        "      echo \"$result\" | grep -q '\"success\":true' && break",
        "    done",
        "    curl -sfG \"$DSM_BASE\" --data-urlencode 'api=SYNO.API.Auth' --data-urlencode 'version=7' --data-urlencode 'method=logout' --data-urlencode \"_sid=$SID\" >/dev/null 2>&1 || true",
        "  fi",
        "fi",
      ].join("\n");
    },
  },

  {
    name: "check_backup_status",
    description: "Checks Hyper Backup package status, lists backup tasks, and shows recent backup log entries — especially errors, failures, and destination connectivity issues. Discovers backup log files across every known candidate path (DSM 6, DSM 7, per-task dirs) and tails the freshest one, so it works even when the standard log path is stale or empty.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 6) * 20, 40, 200);
      const hours = clamp(input.lookback_hours as number ?? 6, 1, 168);
      return [
        "echo '=== HYPER BACKUP STATUS ==='",
        "ver=$(grep -m1 '^version=' /host/var/packages/HyperBackup/INFO 2>/dev/null || grep -m1 '^version=' /var/packages/HyperBackup/INFO 2>/dev/null); ver=${ver#version=}",
        "if [ -f /host/var/packages/HyperBackup/enabled ] || [ -f /var/packages/HyperBackup/enabled ]; then enabled=enabled; else enabled=disabled; fi",
        "echo \"HyperBackup: ${ver:-not found} [$enabled]\"",
        "echo ''",
        "echo '=== BACKUP TASK LIST ==='",
        "for cli in /host/usr/syno/bin/synobackup /usr/syno/bin/synobackup; do [ -x \"$cli\" ] && { \"$cli\" --list 2>/dev/null && break; }; done || echo 'No backup CLI available'",
        "echo ''",
        "echo '=== BACKUP LOG FILES DISCOVERED (path | mtime | size) ==='",
        // Enumerate every plausible backup-log location, list only files that exist,
        // newest first. The operator can immediately see which file is live.
        "candidates=$(",
        "  ls -1 /host/log/synolog/synobackup.log \\",
        "        /host/var/log/synolog/synobackup.log \\",
        "        /host/log/synobackup.log \\",
        "        /host/var/log/synobackup.log \\",
        "        /host/var/log/packages/HyperBackup.log \\",
        "        /host/log/packages/HyperBackup.log \\",
        "        /host/var/log/messages 2>/dev/null;",
        "  ls -1 /host/var/packages/HyperBackup/target/*/log/*.log 2>/dev/null;",
        "  ls -1 /host/var/packages/HyperBackup/target/*/*.log 2>/dev/null;",
        ")",
        "if [ -z \"$candidates\" ]; then",
        "  echo 'No backup log files found in any known location.'",
        "  FRESHEST=''",
        "else",
        "  echo \"$candidates\" | xargs -r stat -c '%Y %y | %s bytes | %n' 2>/dev/null | sort -rn | cut -d' ' -f2- | head -20",
        "  FRESHEST=$(echo \"$candidates\" | xargs -r ls -1t 2>/dev/null | head -1)",
        "fi",
        "echo ''",
        `echo "=== FRESHEST BACKUP LOG (tail, filtered to last ${hours}h where possible) ==="`,
        "if [ -n \"$FRESHEST\" ]; then",
        "  echo \"Source: $FRESHEST\"",
        "  echo ''",
        `  # Try to filter by date prefix (YYYY-MM-DD); fall back to plain tail if format unknown.`,
        `  cutoff=$(date -d "${hours} hours ago" '+%Y-%m-%d %H:%M' 2>/dev/null)`,
        "  if [ -n \"$cutoff\" ]; then",
        `    awk -v c="$cutoff" '$0 >= c' "$FRESHEST" 2>/dev/null | grep -iE 'error|fail|warn|complete|success|abort|destination' | tail -${lines}`,
        `    awk -v c="$cutoff" '$0 >= c' "$FRESHEST" 2>/dev/null | tail -5`,
        "  else",
        `    grep -iE 'error|fail|warn|complete|success|abort|destination' "$FRESHEST" 2>/dev/null | tail -${lines}`,
        `    tail -5 "$FRESHEST" 2>/dev/null`,
        "  fi",
        "else",
        "  echo '(no source file to tail)'",
        "fi",
        "echo ''",
        "echo '=== STALENESS CHECK ==='",
        "if [ -n \"$FRESHEST\" ]; then",
        "  age=$(( $(date +%s) - $(stat -c %Y \"$FRESHEST\" 2>/dev/null || echo 0) ))",
        "  if [ \"$age\" -gt 0 ]; then",
        "    h=$((age/3600)); d=$((h/24))",
        "    echo \"Freshest log last modified ${h}h ago (~${d} days). If the actual backup ran more recently, the live log is elsewhere — check the per-task dirs under /host/var/packages/HyperBackup/target/.\"",
        "  fi",
        "fi",
        "echo ''",
        "echo '=== PER-TASK LOG DIRS ==='",
        "ls -lt /host/var/packages/HyperBackup/target/ 2>/dev/null | head -15 || echo '(no per-task target dir found)'",
        "echo ''",
        "echo '=== BACKUP VAULT LOCATIONS (all volumes) ==='",
        "found=0; for v in /host/volume[0-9]* /volume[0-9]*; do for vault in \"$v\"/@SynologyHyperBackup*; do [ -e \"$vault\" ] || continue; echo \"$vault\"; found=1; done; done; [ $found -eq 0 ] && echo 'No HyperBackup vault found on any volume'",
      ].join("\n");
    },
  },

  {
    name: "check_container_io",
    description: "Shows which Docker containers are doing the most disk I/O (reads and writes). Use when disk activity is high but you don't know which container is responsible.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DOCKER CONTAINER BLOCK I/O ==='",
      "for dir in /sys/fs/cgroup/blkio/docker/*/; do",
      "  [ -d \"$dir\" ] || continue",
      "  cid=$(basename \"$dir\")",
      "  name=$(docker inspect --format '{{.Name}}' \"$cid\" 2>/dev/null | tr -d '/' || echo \"${cid:0:12}\")",
      "  rb=$(awk '$2==\"Read\"{s+=$3} END{print s+0}' \"$dir/blkio.throttle.io_service_bytes\" 2>/dev/null)",
      "  wb=$(awk '$2==\"Write\"{s+=$3} END{print s+0}' \"$dir/blkio.throttle.io_service_bytes\" 2>/dev/null)",
      "  printf 'Container: %-38s ReadBytes: %-14s WriteBytes: %s\\n' \"$name\" \"${rb:-0}\" \"${wb:-0}\"",
      "done 2>/dev/null | sort -t':' -k3 -rn | head -20 || echo 'cgroup v1 not available'",
      "echo ''",
      "echo '=== DOCKER STATS SNAPSHOT ==='",
      "docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.BlockIO}}\\t{{.NetIO}}' 2>/dev/null | head -25 || echo 'docker stats unavailable'",
    ].join("\n"),
  },

  {
    name: "check_io_scheduler",
    description: "Shows the I/O scheduler, queue depth limit, and read-ahead for each block device. Also runs iostat -x for per-device await/util% if available. Wrong scheduler (e.g. bfq on a RAID array) inflates I/O await and contributes to high iowait. Recommended: mq-deadline for HDDs/RAID; none or mq-deadline for SSDs. Use set_io_scheduler to change.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== I/O SCHEDULER AND QUEUE SETTINGS ==='",
      "for dev in /host/sys/block/*/; do",
      "  name=$(basename \"$dev\")",
      "  echo \"$name\" | grep -qE '^(sd|hd|nvme|md|xvd|vd)' || continue",
      "  sched=$(cat \"${dev}queue/scheduler\" 2>/dev/null | grep -oE '\\[[^]]+\\]' | tr -d '[]')",
      "  nr=$(cat \"${dev}queue/nr_requests\" 2>/dev/null || echo 'n/a')",
      "  ra=$(cat \"${dev}queue/read_ahead_kb\" 2>/dev/null || echo 'n/a')",
      "  rot=$(cat \"${dev}queue/rotational\" 2>/dev/null || echo '?')",
      "  devtype=$([ \"$rot\" = '1' ] && echo 'HDD' || echo 'SSD/NVMe')",
      "  printf '%-12s %-8s scheduler=%-14s nr_requests=%-6s read_ahead_kb=%s\\n' \"$name\" \"$devtype\" \"${sched:-unknown}\" \"$nr\" \"$ra\"",
      "done 2>/dev/null || echo 'Could not read /host/sys/block/'",
      "echo ''",
      "echo '=== IOSTAT EXTENDED (3-second sample) ==='",
      "iostat -x -d 3 2 2>/dev/null || { echo 'iostat not available — raw diskstats:'; awk 'NF>=14 && /sd|md/ {printf \"%-8s reads:%-8d writes:%-8d in_progress:%-4d\\n\",$3,$4,$8,$12}' /proc/diskstats 2>/dev/null; }",
    ].join("\n"),
  },

  {
    name: "check_nfs_client",
    description: "Checks whether the NAS itself has NFS client mounts that could contribute to iowait. A slow or unreachable NFS server causes iowait indistinguishable from local disk saturation. Shows active NFS mounts, client-side RPC stats, and recent NFS-related kernel messages.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== NFS CLIENT MOUNTS ==='",
      "grep ' nfs' /proc/mounts 2>/dev/null || grep ' nfs' /host/proc/mounts 2>/dev/null || echo 'No NFS client mounts'",
      "echo ''",
      "echo '=== NFS CLIENT RPC STATS ==='",
      "cat /proc/net/rpc/nfs 2>/dev/null || cat /host/proc/net/rpc/nfs 2>/dev/null || echo 'No NFS client RPC stats (no nfs client mounts active)'",
      "echo ''",
      "echo '=== NFS SERVER RPC STATS ==='",
      "cat /proc/net/rpc/nfsd 2>/dev/null || cat /host/proc/net/rpc/nfsd 2>/dev/null || echo 'NFS server not running'",
      "echo ''",
      "echo '=== NFS-RELATED KERNEL MESSAGES ==='",
      "dmesg -T 2>/dev/null | grep -i 'nfs\\|rpc\\|sunrpc' | tail -20 || dmesg | grep -i 'nfs\\|rpc' | tail -20 || echo 'No NFS kernel messages'",
      "echo ''",
      "echo '=== ACTIVE NFS CONNECTIONS ==='",
      "ss -tnp 'sport = :2049 or dport = :2049' 2>/dev/null | head -20 || echo 'ss not available'",
    ].join("\n"),
  },

  // ── Phase 1B: Package and daemon internals ────────────────────────────────────

  {
    name: "check_package_runtime",
    description: "Checks a DSM package's runtime state: synopkg status, enabled flag, var directory contents, PID files, lock files, and matching processes. Pass the package name exactly as shown by synopkg (e.g. SynologyDrive, HyperBackup).",
    write: false,
    params: { target, package_name: packageName },
    buildCommand: (input) => {
      const pkg = (input.package_name as string).trim();
      return [
        `echo '=== PACKAGE STATUS: ${pkg} ==='`,
        `ver=$(grep -m1 '^version=' /var/packages/${quote(pkg)}/INFO 2>/dev/null | cut -d= -f2-); enabled=$([ -f /var/packages/${quote(pkg)}/enabled ] && echo enabled || echo disabled); echo "${pkg}: \${ver:-not found} [\$enabled]"`,
        "echo ''",
        "echo '=== ENABLED STATE ==='",
        `[ -f /var/packages/${quote(pkg)}/enabled ] && echo 'enabled' || echo 'disabled (or not installed)'`,
        "echo ''",
        "echo '=== VAR DIRECTORY ==='",
        `ls -lh /var/packages/${quote(pkg)}/var/ 2>/dev/null | head -20 || echo 'var dir not found'`,
        "echo ''",
        "echo '=== PID FILES ==='",
        `find /var/packages/${quote(pkg)}/ -name '*.pid' -o -name 'pid' 2>/dev/null | while read -r pidfile; do echo "$pidfile:"; cat "$pidfile" 2>/dev/null; done || echo 'No PID files found'`,
        "echo ''",
        "echo '=== LOCK FILES ==='",
        `find /var/packages/${quote(pkg)}/ \\( -name '*.lock' -o -name 'lock' \\) 2>/dev/null | head -10 || echo 'No lock files'`,
        "echo ''",
        "echo '=== MATCHING PROCESSES ==='",
        `ps aux | grep -i ${quote(pkg.toLowerCase())} | grep -v grep | head -20 || echo 'No matching processes'`,
      ].join("\n");
    },
  },

  {
    name: "check_daemon_processes",
    description: "Shows process state and resource usage for key Synology daemons: synologand, invoked, syncd, cloud-control, syno_drive_server, synoindex, and crond. Use to identify a crashed or resource-heavy daemon.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== KEY SYNOLOGY DAEMON PROCESSES ==='",
      "ps aux | awk 'NR==1 || /synologand|invoked|syncd|cloud.control|syno_drive|synobackupd|synoindex|crond|syno_pkg_daemon|synoscheduler/' | head -40",
      "echo ''",
      "echo '=== DAEMON PROCESS COUNTS ==='",
      "for daemon in synologand invoked syncd syno_drive_server synoindex crond synobackupd; do",
      "  count=$(pgrep -c \"$daemon\" 2>/dev/null || echo 0)",
      "  printf '%-30s count=%s\\n' \"$daemon\" \"$count\"",
      "done",
      "echo ''",
      "echo '=== RECENT DAEMON EVENTS (syslog) ==='",
      "grep -iE 'synologand|invoked|syncd|syno_drive' /host/log/messages 2>/dev/null | tail -30 || grep -iE 'synologand|invoked' /host/log/syslog 2>/dev/null | tail -30 || echo 'No daemon events in syslog'",
      "echo ''",
      "echo '=== D-STATE PROCESSES (blocked on I/O) ==='",
      "ps aux | awk '$8 ~ /D/ {print}' | head -20 || echo 'No D-state processes'",
    ].join("\n"),
  },

  {
    name: "inspect_package_lockfiles",
    description: "Finds and shows lock files across all installed packages and common Synology runtime dirs. Stale lock files prevent packages from starting or block maintenance tasks from running.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== LOCK FILES UNDER /var/packages ==='",
      "find /host/var/packages/ -maxdepth 5 \\( -name '*.lock' -o -name 'lock' \\) 2>/dev/null | while read -r lf; do",
      "  printf '%s (mtime: %s)\\n' \"$lf\" \"$(stat -c '%y' \"$lf\" 2>/dev/null)\"",
      "done | head -40 || echo 'No lock files found under /var/packages'",
      "echo ''",
      "echo '=== LOCK FILES UNDER /tmp ==='",
      "find /tmp -maxdepth 3 \\( -name '*.lock' -o -name 'lock' \\) 2>/dev/null | head -20 || echo 'No lock files in /tmp'",
      "echo ''",
      "echo '=== RUNTIME LOCK AND PID FILES ==='",
      "find /run /var/run -maxdepth 4 \\( -name '*.lock' -o -name '*.pid' \\) 2>/dev/null | head -30 || echo 'No lock/pid files in /run'",
    ].join("\n"),
  },

  {
    name: "inspect_crash_signals",
    description: "Looks for crash evidence in dmesg, syslog, and package log dirs: segfaults, killed signals, OOM kills, and DSM error service events. Use after a package disappears or becomes unresponsive without obvious cause.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 4) * 20, 40, 200);
      return [
        "echo '=== KERNEL CRASH SIGNALS (dmesg) ==='",
        `dmesg -T 2>/dev/null | grep -iE 'segfault|general protection|killed process|oom|soft lockup|rcu stall|kernel panic|BUG:|Oops:' | tail -${lines} || dmesg | grep -iE 'segfault|killed|oom|panic' | tail -${lines}`,
        "echo ''",
        "echo '=== PROCESS KILLS / SIGNALS (syslog) ==='",
        `grep -iE 'killed|segfault|core dumped|out of memory' /host/log/messages 2>/dev/null | tail -${lines} || grep -iE 'killed|segfault|oom' /host/log/syslog 2>/dev/null | tail -${lines} || echo 'No crash signals in syslog'`,
        "echo ''",
        "echo '=== DSM ERROR SERVICE LOG ==='",
        `tail -${lines} /host/log/synolog/synoerr.log 2>/dev/null || echo 'synoerr.log not found'`,
        "echo ''",
        "echo '=== CORE DUMPS ==='",
        "find /tmp /var/crash 2>/dev/null -maxdepth 3 \\( -name 'core*' -o -name '*.core' \\) 2>/dev/null | head -10",
        "for v in /volume[0-9]*; do find \"$v/crash\" -maxdepth 2 2>/dev/null \\( -name 'core*' -o -name '*.core' \\) | head -5; done 2>/dev/null || echo 'No core dumps found'",
      ].join("\n");
    },
  },

  {
    name: "tail_package_logs",
    description: "Shows recent log entries for a specific DSM package. Checks the standard log locations under /var/packages and /var/log/synolog. Pass the package name exactly as shown by synopkg (e.g. SynologyDrive, HyperBackup).",
    write: false,
    params: { target, package_name: packageName, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const pkg = (input.package_name as string).trim();
      const lines = clamp((input.lookback_hours as number ?? 2) * 40, 40, 400);
      const pkgLower = pkg.toLowerCase();
      return [
        `echo '=== PACKAGE LOGS: ${pkg} ==='`,
        "echo ''",
        "echo '--- /host/log/packages/ (primary DSM 7 package log location) ---'",
        `for f in /host/log/packages/${quote(pkg)}.log /host/log/packages/${pkgLower}.log; do`,
        `  [ -f "$f" ] || continue`,
        `  echo "=== $f ==="`,
        `  tail -n ${lines} "$f"`,
        `done 2>/dev/null`,
        "echo ''",
        "echo '--- /var/packages log dir ---'",
        `for f in /host/var/packages/${quote(pkg)}/var/log/*.log; do`,
        `  [ -f "$f" ] || continue`,
        `  echo "=== $f ==="`,
        `  tail -n ${lines} "$f"`,
        `done 2>/dev/null || echo 'No logs in /host/var/packages/${pkg}/var/log/'`,
        "echo ''",
        "echo '--- /var/log/synolog ---'",
        `for f in /host/log/synolog/syno${pkgLower}.log /host/log/synolog/${pkgLower}.log /host/log/${pkgLower}.log; do`,
        `  [ -f "$f" ] || continue`,
        `  echo "=== $f ==="`,
        `  tail -n ${lines} "$f"`,
        `done 2>/dev/null || true`,
        "echo ''",
        "echo '--- synopkg.log (package install/start/stop events) ---'",
        `grep -i ${quote(pkg)} /host/log/synolog/synopkg.log 2>/dev/null | tail -${lines} || echo 'No entries in synopkg.log for ${pkg}'`,
      ].join("\n");
    },
  },

  {
    name: "search_package_logs",
    description: "Searches all known log locations for a specific DSM package and filter term. Checks /var/packages log dirs and /var/log/synolog for the package. Pass the package name and a search term in filter.",
    write: false,
    params: { target, package_name: packageName, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const pkg = (input.package_name as string).trim();
      const f = (input.filter as string | undefined)?.trim() || "error";
      const lines = clamp((input.lookback_hours as number ?? 4) * 40, 60, 400);
      const pkgLower = pkg.toLowerCase();
      return [
        `echo '=== SEARCHING ${pkg} LOGS FOR: ${f} ==='`,
        `for logf in /host/log/packages/${quote(pkg)}.log /host/log/packages/${pkgLower}.log /host/var/packages/${quote(pkg)}/var/log/*.log /host/log/synolog/syno${pkgLower}.log /host/log/synolog/${pkgLower}.log /host/log/${pkgLower}.log /host/log/synolog/synopkg.log; do`,
        `  [ -f "$logf" ] || continue`,
        `  matches=$(grep -ci ${quote(f)} "$logf" 2>/dev/null || true)`,
        `  [ "$matches" -gt 0 ] 2>/dev/null || continue`,
        `  echo "=== $logf ($matches matches) ==="`,
        `  grep -i ${quote(f)} "$logf" 2>/dev/null | tail -${lines}`,
        `  echo ''`,
        `done || echo 'No matching log files found for ${pkg}'`,
      ].join("\n");
    },
  },

  // ── Phase 1E: File and permission forensics (read) ────────────────────────────

  {
    name: "inspect_path_metadata",
    description: "Shows POSIX metadata for an exact filesystem path: owner, group, permissions, size, inode, link count, and timestamps. Required first step before any permission or ACL forensics. Requires exact_path.",
    write: false,
    params: { target, exact_path: exactPath },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      return [
        "echo '=== PATH METADATA ==='",
        `stat ${quote(p)} 2>&1`,
        "echo ''",
        "echo '=== LONG LISTING ==='",
        `ls -la ${quote(p)} 2>&1`,
        "echo ''",
        "echo '=== PARENT DIRECTORY ==='",
        `ls -la "$(dirname ${quote(p)})" 2>&1 | head -30`,
      ].join("\n");
    },
  },

  {
    name: "inspect_path_acl",
    description: "Shows the POSIX mode and Synology ACL entries for an exact filesystem path. Reveals which users and groups have explicit ACL permissions beyond the standard POSIX mode. Requires exact_path. A path answering 'It's Linux mode' has no Synology ACL — POSIX mode/ownership is what applies there.",
    write: false,
    params: { target, exact_path: exactPath },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      // No getfacl section: it is not installed (verified on edgesynology1) and
      // /volume1 is mounted `synoacl`, not `acl`, so POSIX ACLs are not what this
      // filesystem enforces. It only ever printed "getfacl: command not found"
      // followed by a fallback saying "not available or path not found" — which
      // reads as a possible missing path and invited chasing a non-bug.
      return [
        "echo '=== POSIX MODE ==='",
        `stat -c 'mode=%A owner=%U:%G size=%s inode=%i' ${quote(p)} 2>&1`,
        "echo ''",
        "echo '=== SYNOLOGY ACL (synoacltool) ==='",
        `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get ${quote(p)} 2>&1 || true`,
      ].join("\n");
    },
  },

  {
    name: "inspect_effective_permissions",
    description: "Shows the effective access on a path: POSIX mode, ACL entries, and optionally the group memberships and share-level access for a specific user. Requires exact_path. Pass a username in filter to check user-specific access.",
    write: false,
    params: { target, exact_path: exactPath, filter },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      const username = (input.filter as string | undefined)?.trim() || "";
      // getfacl section dropped for the same reason as inspect_path_acl: not
      // installed, and POSIX ACLs are not what a `synoacl` mount enforces.
      const lines = [
        "echo '=== PATH PERMISSIONS ==='",
        `stat -c 'mode=%A owner=%U:%G inode=%i' ${quote(p)} 2>&1`,
        "echo ''",
        "echo '=== SYNOLOGY ACL (synoacltool) ==='",
        `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get ${quote(p)} 2>&1 || true`,
      ];
      if (username) {
        lines.push(
          "echo ''",
          `echo '=== USER ${username} GROUP MEMBERSHIPS ==='`,
          `id ${quote(username)} 2>&1 || echo 'User not found'`,
          "echo ''",
          `echo '=== SHARE-LEVEL ACCESS FOR ${username} ==='`,
          `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --list-user-access ${quote(username)} 2>/dev/null || echo 'synoshare --list-user-access not available on this DSM version'`,
        );
      }
      return lines.join("\n");
    },
  },

  // ── Phase 1C: Storage deep health ────────────────────────────────────────────

  {
    name: "check_smart_detail",
    description: "Shows full SMART attributes, error log, and self-test history for a disk. Specify a device in filter (e.g. /dev/sda) or leave empty to check all disks.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const device = (input.filter as string | undefined)?.trim();
      if (device) {
        return [
          `echo '=== SMART DETAIL: ${device} ==='`,
          `smartctl -a ${quote(device)} 2>&1`,
          "echo ''",
          "echo '=== SMART ERROR LOG ==='",
          `smartctl -l error ${quote(device)} 2>&1 | head -40`,
          "echo ''",
          "echo '=== SELF-TEST LOG ==='",
          `smartctl -l selftest ${quote(device)} 2>&1 | head -20`,
        ].join("\n");
      }
      return [
        "echo '=== SMART DETAIL (all disks) ==='",
        "for d in /dev/sd?; do",
        "  [ -b \"$d\" ] || continue",
        "  echo \"=== $d ===\"",
        "  smartctl -a \"$d\" 2>&1 | head -60",
        "  echo ''",
        "  echo '--- Error log ---'",
        "  smartctl -l error \"$d\" 2>&1 | head -15",
        "  echo ''",
        "done 2>/dev/null || echo 'smartctl not available'",
      ].join("\n");
    },
  },

  {
    name: "check_scrub_status",
    description: "Shows Btrfs scrub status and history for all data volumes, and RAID sync/check progress from /proc/mdstat. Use to see if a scrub is running or when the last one completed.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== BTRFS SCRUB STATUS (all volumes) ==='",
      "found=0",
      "for v in /btrfs/volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  found=1",
      "  echo \"--- $v ---\"",
      "  btrfs scrub status \"$v\" 2>&1",
      "  echo ''",
      "done 2>/dev/null",
      "[ \"$found\" -eq 0 ] && echo 'No btrfs volumes found at /btrfs/volume* — deploy update required (see docker-compose.agent.yml)'",
      "echo ''",
      "echo '=== RAID SYNC STATUS (/proc/mdstat) ==='",
      "cat /proc/mdstat 2>/dev/null || echo 'mdstat not available'",
      "echo ''",
      "echo '=== ACTIVE RAID SYNC PROGRESS ==='",
      "for f in /sys/block/md*/md/sync_completed /sys/block/md*/md/sync_action; do",
      "  [ -f \"$f\" ] || continue",
      "  printf '%s: %s\\n' \"$f\" \"$(cat \"$f\" 2>/dev/null)\"",
      "done 2>/dev/null || echo 'No MD sync state files found'",
      "echo ''",
      "echo '=== SYNOLOGY STORAGE SCRUB LOG ==='",
      "grep -iE 'scrub|check|sync' /host/log/synolog/synostorage.log 2>/dev/null | tail -20 || echo 'Storage log not found'",
    ].join("\n"),
  },

  {
    name: "check_storage_pool_detail",
    description: "Shows detailed storage pool and RAID array state using discovered DSM binaries where present, with read-only fallbacks to mdstat, sysfs MD state, and SMART health.",
    write: false,
    params: { target },
    buildCommand: () => [
      "find_tool() {",
      "  name=\"$1\"",
      "  for p in /host/usr/syno/sbin /host/usr/syno/bin /host/usr/sbin /host/usr/bin /host/sbin /host/bin /usr/syno/sbin /usr/syno/bin /usr/sbin /usr/bin /sbin /bin; do",
      "    [ -x \"$p/$name\" ] && { echo \"$p/$name\"; return 0; }",
      "  done",
      "  command -v \"$name\" 2>/dev/null && return 0",
      "  return 1",
      "}",
      "echo '=== SYNOLOGY ARRAY STATUS ==='",
      "array_status=$(find_tool synoarraystatus || true)",
      "if [ -n \"$array_status\" ]; then \"$array_status\" 2>&1 | head -80; else echo 'synoarraystatus not found in host/container candidate paths'; fi",
      "echo ''",
      "echo '=== SYNOLOGY VOLUME STATUS ==='",
      "volume_status=$(find_tool synovolumestatus || true)",
      "if [ -n \"$volume_status\" ]; then \"$volume_status\" 2>&1 | head -80; else echo 'synovolumestatus not found in host/container candidate paths'; fi",
      "echo ''",
      "echo '=== OTHER DSM STORAGE BINARIES DISCOVERED ==='",
      "for b in synostorage synodisk syno_disk_ctl syno_hdd_util synospace; do",
      "  path=$(find_tool \"$b\" || true)",
      "  [ -n \"$path\" ] && echo \"$b: $path\" || echo \"$b: not found\"",
      "done",
      "echo ''",
      "echo '=== MDADM RAID DETAIL ==='",
      "mdadm_bin=$(find_tool mdadm || true)",
      "if [ -z \"$mdadm_bin\" ]; then echo 'mdadm not found in host/container candidate paths'; fi",
      "for md in /dev/md*; do",
      "  [ -b \"$md\" ] || continue",
      "  echo \"--- $md ---\"",
      "  if [ -n \"$mdadm_bin\" ]; then \"$mdadm_bin\" --detail \"$md\" 2>&1 | head -60; else echo 'mdadm unavailable; see sysfs fallback below'; fi",
      "  echo ''",
      "done 2>/dev/null || true",
      "echo ''",
      "echo '=== /proc/mdstat ==='",
      "cat /proc/mdstat 2>/dev/null || echo 'mdstat not available'",
      "echo ''",
      "echo '=== SYSFS MD STATE FALLBACK ==='",
      "for mdpath in /sys/block/md*/md; do",
      "  [ -d \"$mdpath\" ] || continue",
      "  echo \"--- ${mdpath%/md} ---\"",
      "  for f in array_state level raid_disks degraded sync_action sync_completed mismatch_cnt metadata_version; do",
      "    [ -r \"$mdpath/$f\" ] && printf '%s=%s\\n' \"$f\" \"$(cat \"$mdpath/$f\" 2>/dev/null)\"",
      "  done",
      "  echo ''",
      "done 2>/dev/null || echo 'No sysfs MD state files found'",
      "echo ''",
      "echo '=== DISK PRESENCE CHECK ==='",
      "smart_bin=$(find_tool smartctl || true)",
      "if [ -z \"$smart_bin\" ]; then echo 'smartctl not found'; fi",
      "for d in /dev/sd? /dev/nvme?n?; do",
      "  [ -b \"$d\" ] || continue",
      "  echo \"--- $d ---\"",
      "  if [ -n \"$smart_bin\" ]; then",
      "    \"$smart_bin\" -i \"$d\" 2>/dev/null | grep -E 'Device Model|Model Number|Serial|Capacity|User Capacity|Firmware' | head -6",
      "    \"$smart_bin\" -H \"$d\" 2>/dev/null | grep -E 'result|Status' || true",
      "  else",
      "    echo 'smartctl unavailable'",
      "  fi",
      "done 2>/dev/null || true",
    ].join("\n"),
  },

  {
    name: "check_btrfs_detail",
    description: "Shows Btrfs filesystem usage, device error counters, balance status, and subvolume list for all Btrfs data volumes. Use to diagnose Btrfs-specific errors or unexpected space allocation.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== BTRFS FILESYSTEM USAGE (all volumes) ==='",
      "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
      "  [ \"$fstype\" = 'btrfs' ] || continue",
      "  echo \"--- $v ---\"",
      "  btrfs filesystem usage \"$v\" 2>&1 | head -30",
      "  echo ''",
      "  break",
      "done 2>/dev/null || echo 'btrfs not available or no btrfs volumes'",
      "echo ''",
      "echo '=== BTRFS DEVICE STATS (error counters) ==='",
      "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
      "  [ \"$fstype\" = 'btrfs' ] || continue",
      "  echo \"--- $v ---\"",
      "  btrfs device stats \"$v\" 2>&1",
      "  echo ''",
      "  break",
      "done 2>/dev/null || true",
      "echo ''",
      "echo '=== BTRFS BALANCE STATUS ==='",
      "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
      "  [ \"$fstype\" = 'btrfs' ] || continue",
      "  echo \"--- $v ---\"",
      "  btrfs balance status \"$v\" 2>&1 | head -10",
      "  echo ''",
      "  break",
      "done 2>/dev/null || true",
      "echo ''",
      "echo '=== BTRFS SUBVOLUMES ==='",
      "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
      "  [ \"$fstype\" = 'btrfs' ] || continue",
      "  echo \"--- $v ---\"",
      "  btrfs subvolume list \"$v\" 2>&1 | head -20",
      "  echo ''",
      "  break",
      "done 2>/dev/null || true",
    ].join("\n"),
  },

  {
    name: "check_disk_error_trends",
    description: "Shows SMART error-relevant attributes (reallocated sectors, pending sectors, uncorrectable errors, temperature, power-on hours) for all disks in a compact table. Use to spot a drive silently accumulating errors.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DISK ERROR TREND SUMMARY ==='",
      "printf '%-8s %-8s %-8s %-8s %-7s %-8s %s\\n' 'DISK' 'REALLOC' 'PENDING' 'UNCORR' 'TEMP' 'POWERON' 'MODEL'",
      "for d in /dev/sd?; do",
      "  [ -b \"$d\" ] || continue",
      "  model=$(smartctl -i \"$d\" 2>/dev/null | awk -F: '/Device Model|Model Number/{gsub(/^ +/,\"\",$2); print $2}' | head -1 | cut -c1-20)",
      "  realloc=$(smartctl -A \"$d\" 2>/dev/null | awk '/Reallocated_Sector/{print $10}')",
      "  pending=$(smartctl -A \"$d\" 2>/dev/null | awk '/Current_Pending_Sector/{print $10}')",
      "  uncorr=$(smartctl -A \"$d\" 2>/dev/null | awk '/Offline_Uncorrectable/{print $10}')",
      "  temp=$(smartctl -A \"$d\" 2>/dev/null | awk '/Temperature_Celsius|Airflow_Temp/{print $10}' | head -1)",
      "  poweron=$(smartctl -A \"$d\" 2>/dev/null | awk '/Power_On_Hours/{print $10}' | head -1)",
      "  printf '%-8s %-8s %-8s %-8s %-7s %-8s %s\\n' \"$d\" \"${realloc:-?}\" \"${pending:-?}\" \"${uncorr:-?}\" \"${temp:-?}C\" \"${poweron:-?}h\" \"${model:-?}\"",
      "done 2>/dev/null || echo 'smartctl not available'",
      "echo ''",
      "echo '=== DISK ERRORS FROM KERNEL (dmesg) ==='",
      "dmesg -T 2>/dev/null | grep -iE 'ata.*error|scsi.*error|i/o error|medium error|sector' | tail -30 || dmesg | grep -iE 'error|sector' | tail -20",
    ].join("\n"),
  },

  {
    name: "check_volume_quota_and_inode_pressure",
    description: "Shows inode usage pressure and Btrfs qgroup quota state for all data volumes. High inode usage can prevent new files from being created even when disk space is available.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== INODE USAGE (all volumes) ==='",
      "df -i 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume[0-9]+$/'",
      "echo ''",
      "echo '=== INODE PRESSURE ALERT (>85% used) ==='",
      "df -i 2>/dev/null | awk '$6 ~ /^\\/volume[0-9]+$/ && $5+0 > 85 {print \"HIGH INODE USAGE:\", $0}' || echo 'No volumes at >85% inode usage'",
      "echo ''",
      "echo '=== BTRFS QGROUP QUOTA STATE ==='",
      "found=0",
      "for v in /volume[0-9]*; do",
      "  [ -d \"$v\" ] || continue",
      "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
      "  [ \"$fstype\" = 'btrfs' ] || continue",
      "  found=1",
      "  echo \"--- $v ---\"",
      "  btrfs qgroup show --human-readable \"$v\" 2>&1 | head -30 || btrfs quota status \"$v\" 2>&1 | head -10",
      "  echo ''",
      "done 2>/dev/null",
      "[ \"$found\" -eq 0 ] && echo 'No btrfs volumes found'",
      "echo ''",
      "echo '=== SHARE QUOTA (synoshare) ==='",
      "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | while read -r share; do",
      "  [ -n \"$share\" ] || continue",
      "  quota=$(LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --get \"$share\" 2>/dev/null | awk -F= '/^quota=/{print $2}')",
      "  [ -n \"$quota\" ] && [ \"$quota\" != '0' ] && echo \"$share: quota=$quota\"",
      "done 2>/dev/null || echo 'synoshare not available'",
    ].join("\n"),
  },

  // ── Phase 1D: Richer network diagnostics ─────────────────────────────────────

  {
    name: "check_interface_flaps",
    description: "Checks network interface carrier change counts, per-interface error counts, and link state. High carrier_changes indicate an unstable physical connection that can cause intermittent DSM API, ShareSync, or remote access failures.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== INTERFACE CARRIER CHANGES ==='",
      "for iface in /sys/class/net/*/carrier_changes; do",
      "  [ -f \"$iface\" ] || continue",
      "  name=$(echo \"$iface\" | awk -F/ '{print $(NF-1)}')",
      "  changes=$(cat \"$iface\" 2>/dev/null || echo 0)",
      "  state=$(cat \"/sys/class/net/$name/operstate\" 2>/dev/null || echo unknown)",
      "  speed=$(cat \"/sys/class/net/$name/speed\" 2>/dev/null || echo ?)",
      "  printf '%-15s carrier_changes=%-6s state=%-8s speed=%sMbps\\n' \"$name\" \"$changes\" \"$state\" \"$speed\"",
      "done 2>/dev/null || ip link show 2>/dev/null | grep -E '^[0-9]+:|state'",
      "echo ''",
      "echo '=== INTERFACE ERROR COUNTERS ==='",
      "cat /proc/net/dev | awk 'NR>2{gsub(\":\",\" \",$1); printf \"%-12s RX_errs:%-6s RX_drop:%-6s TX_errs:%-6s TX_drop:%-6s\\n\",$1,$4,$5,$12,$13}' | grep -v '^lo '",
      "echo ''",
      "echo '=== RECENT LINK EVENTS (syslog) ==='",
      "grep -iE 'link up|link down|carrier|autoneg|speed|duplex' /host/log/messages 2>/dev/null | tail -20 || echo 'No interface events in syslog'",
    ].join("\n"),
  },

  {
    name: "check_bond_health",
    description: "Checks bonding/LACP state if bonded network interfaces are configured — bond mode, LACP status, and individual slave interface health. Returns early if no bonding is configured.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== BOND INTERFACES ==='",
      "ls /proc/net/bonding/ 2>/dev/null || echo 'No bonding interfaces at /proc/net/bonding/ — bonding not configured'",
      "echo ''",
      "echo '=== BOND DETAILS ==='",
      "for f in /proc/net/bonding/bond*; do",
      "  [ -f \"$f\" ] || continue",
      "  echo \"=== $f ===\"",
      "  cat \"$f\" 2>/dev/null",
      "  echo ''",
      "done 2>/dev/null",
      "echo ''",
      "echo '=== BOND IP AND LINK STATE ==='",
      "ip link show type bond 2>/dev/null | head -20 || echo 'No bond interfaces via ip link'",
      "echo ''",
      "echo '=== LACP / 802.3AD STATE ==='",
      "for f in /sys/class/net/bond*/bonding/ad_info; do [ -f \"$f\" ] && cat \"$f\" 2>/dev/null; done || echo 'No LACP state available'",
      "for f in /sys/class/net/bond*/bonding/slaves; do [ -f \"$f\" ] && printf 'Bond slaves: %s\\n' \"$(cat \"$f\" 2>/dev/null)\"; done 2>/dev/null || true",
    ].join("\n"),
  },

  {
    name: "check_dns_and_gateway_health",
    description: "Tests DNS resolution, checks default gateway reachability with ping, and shows nameserver and route configuration. Use when the NAS has network connectivity but DNS or external service lookups are failing.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== NAMESERVER CONFIG ==='",
      "cat /host/etc/resolv.conf 2>/dev/null || cat /etc/resolv.conf 2>/dev/null || echo 'resolv.conf not found'",
      "echo ''",
      "echo '=== DNS RESOLUTION TESTS ==='",
      "for h in google.com 8.8.8.8; do",
      "  echo \"--- $h ---\"",
      "  nslookup \"$h\" 2>/dev/null | tail -4 || host \"$h\" 2>/dev/null | head -2 || getent hosts \"$h\" 2>/dev/null | head -2 || echo 'DNS lookup failed'",
      "  echo ''",
      "done",
      "echo '=== DEFAULT GATEWAY ==='",
      "ip route show default 2>/dev/null | head -5",
      "gw=$(ip route show default 2>/dev/null | awk '/default/{print $3}' | head -1)",
      "[ -n \"$gw\" ] && echo \"Pinging gateway $gw:\" && ping -c 3 -W 2 \"$gw\" 2>/dev/null | tail -3 || echo 'Cannot determine gateway'",
      "echo ''",
      "echo '=== SYNOLOGY DNS CONFIG ==='",
      "grep -iE 'dns|gateway|nameserver' /host/usr/syno/etc/synoinfo.conf 2>/dev/null | head -10 || echo 'synoinfo.conf not found'",
    ].join("\n"),
  },

  {
    name: "check_service_ports",
    description: "Shows listener state and active connection count for each key Synology service port: SMB (445), NFS (2049), SSH (22), DSM (5000/5001), Drive sync (6690), rsync (873), and LDAP (389/636).",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== SERVICE PORT STATUS ==='",
      "printf '%-8s %-22s %-10s %s\\n' 'PORT' 'SERVICE' 'LISTENING' 'ESTABLISHED'",
      "for port_label in '22:SSH' '80:DSM-HTTP' '443:DSM-HTTPS' '445:SMB' '2049:NFS' '5000:DSM-web' '5001:DSM-web-SSL' '6690:Drive-sync' '389:LDAP' '636:LDAPS' '873:rsync'; do",
      "  port=$(echo \"$port_label\" | cut -d: -f1)",
      "  label=$(echo \"$port_label\" | cut -d: -f2)",
      "  listening=$(ss -tlnp 2>/dev/null | awk -v p=\":$port\" '$4 ~ p {count++} END{print count+0}')",
      "  conns=$(ss -tn state established 2>/dev/null | awk -v p=\":$port\" '$4 ~ p || $5 ~ p {count++} END{print count+0}')",
      "  printf '%-8s %-22s %-10s %s\\n' \"$port\" \"$label\" \"$listening\" \"$conns\"",
      "done",
      "echo ''",
      "echo '=== FULL LISTENER LIST ==='",
      "ss -tulnp 2>/dev/null | head -40 || echo 'ss not available'",
    ].join("\n"),
  },

  {
    name: "check_synology_drive_network",
    description: "Checks Synology Drive network state — whether port 6690 is listening, active sync connections by client, recent network errors in the Drive log, and whether the Drive config shows a non-default bind address.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DRIVE SYNC LISTENER (port 6690) ==='",
      "ss -tlnp 2>/dev/null | grep ':6690' || echo 'Drive sync port 6690 is NOT listening'",
      "echo ''",
      "echo '=== ACTIVE DRIVE SYNC CONNECTIONS ==='",
      "ss -tnp 'sport = :6690 or dport = :6690' 2>/dev/null | head -30 || echo 'No active Drive sync connections'",
      "echo ''",
      "echo '=== DRIVE SYNC CONNECTION COUNT BY CLIENT ==='",
      "ss -tn state established 2>/dev/null | awk '/:6690/{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -20",
      "echo ''",
      "echo '=== RECENT DRIVE NETWORK ERRORS ==='",
      "grep -iE 'connection|timeout|refused|network|socket|TLS|SSL' /host/log/synologydrive.log 2>/dev/null | tail -30 || echo 'Drive log not found'",
      "echo ''",
      "echo '=== DRIVE NETWORK CONFIG ==='",
      "find /host/var/packages/SynologyDrive/ -maxdepth 4 -name '*.conf' -o -name '*.json' 2>/dev/null | xargs grep -liE 'port|listen|bind' 2>/dev/null | head -5 | while read -r f; do echo \"--- $f ---\"; grep -iE 'port|listen|bind|interface' \"$f\" 2>/dev/null | head -10; done || echo 'Drive config not found'",
    ].join("\n"),
  },

  // ── Phase 1E continued: File history and audit ────────────────────────────────

  {
    name: "find_recent_path_changes",
    description: "Finds files recently modified under an exact path using mtime. Shows files changed within lookback_hours (default 2h) with timestamps and owner. Requires exact_path.",
    write: false,
    params: { target, exact_path: exactPath, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      const hours = input.lookback_hours as number ?? 2;
      const minutes = Math.ceil(hours * 60);
      return [
        `echo '=== FILES MODIFIED IN LAST ${hours}h UNDER: ${p} ==='`,
        `find ${quote(p)} -maxdepth 8 -mmin -${minutes} -type f 2>/dev/null | while read -r f; do`,
        `  stat -c '%y %U:%G %n' "$f" 2>/dev/null`,
        `done | sort -r | head -50 || echo 'No recently modified files found or path does not exist'`,
        "echo ''",
        "echo '=== RECENTLY CHANGED DIRECTORIES ==='",
        `find ${quote(p)} -maxdepth 5 -mmin -${minutes} -type d 2>/dev/null | head -20 || echo 'No recently changed directories'`,
        "echo ''",
        "echo '=== PATH STAT ==='",
        `stat ${quote(p)} 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "live_file_search",
    description: "Strict live filesystem search by filename glob, with no indexing, no fuzzy matching, and no content search. Use when Universal Search or Windows Search ignore filters or return too much noise. Examples: name_pattern='*pattern*.xls*', root_path='/volume1/Share'. Returns matching paths with type, size, mtime, owner, and group.",
    write: false,
    params: {
      target,
      root_path: rootPath,
      name_pattern: namePattern,
      entry_type: z
        .enum(["file", "directory", "any"])
        .optional()
        .default("file")
        .describe("Limit matches by filesystem entry type. Default: file."),
      case_sensitive: z
        .boolean()
        .optional()
        .default(true)
        .describe("Use case-sensitive glob matching by default. Set false to use find -iname."),
      max_depth: z
        .number()
        .int()
        .optional()
        .default(0)
        .describe("Maximum directory depth below root_path. 0 means unlimited. Clamped to [0, 30]."),
      max_results: z
        .number()
        .int()
        .optional()
        .default(500)
        .describe("Maximum matches to print. Default 500, clamped to [1, 2000]."),
      include_synology_metadata: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include @eaDir and .SynologyWorkingDirectory metadata trees. Default false."),
    },
    buildCommand: (input) => {
      const root = (input.root_path as string | undefined)?.trim() || "";
      const pattern = (input.name_pattern as string).trim();
      const entryType = (input.entry_type as string | undefined) ?? "file";
      const caseSensitive = (input.case_sensitive as boolean | undefined) ?? true;
      const maxDepth = clamp(Math.floor((input.max_depth as number) ?? 0), 0, 30);
      const maxResults = clamp(Math.floor((input.max_results as number) ?? 500), 1, 2000);
      const includeSynologyMetadata = (input.include_synology_metadata as boolean | undefined) ?? false;

      if (!pattern) throw new Error("live_file_search: name_pattern is required.");
      if (pattern.includes("/")) {
        throw new Error("live_file_search: name_pattern must be a basename glob only. Put directories in root_path.");
      }
      if (pattern.length > 200) throw new Error("live_file_search: name_pattern must be 200 characters or less.");
      if (root && !root.startsWith("/")) throw new Error("live_file_search: root_path must be absolute, e.g. /volume1/Share.");
      if (root === "/") throw new Error("live_file_search: refusing to search /. Use /volume1, /volume2, or a share path.");
      if (root && !/^\/(volume[0-9]+|home)(\/|$)/.test(root)) {
        throw new Error("live_file_search: root_path must be under /volumeN or /home.");
      }

      const typeClause =
        entryType === "file" ? "-type f" :
        entryType === "directory" ? "-type d" :
        "";
      const nameOp = caseSensitive ? "-name" : "-iname";
      const depthClause = maxDepth > 0 ? `-maxdepth ${maxDepth}` : "";
      const pruneClause = includeSynologyMetadata
        ? ""
        : "\\( -path '*/@eaDir/*' -o -path '*/.SynologyWorkingDirectory/*' \\) -prune -o";

      return [
        `ROOT=${quote(root)}`,
        `PATTERN=${quote(pattern)}`,
        `MAX_RESULTS=${maxResults}`,
        "echo '=== LIVE FILE SEARCH (no index, strict basename glob) ==='",
        `printf 'root_path=%s\\nname_pattern=%s\\nentry_type=%s\\ncase_sensitive=%s\\nmax_depth=%s\\nmax_results=%s\\n' "$ROOT" "$PATTERN" ${quote(entryType)} ${quote(String(caseSensitive))} ${quote(String(maxDepth))} "$MAX_RESULTS"`,
        "echo ''",
        "echo '=== MATCHES ==='",
        "found=0",
        "search_one_root() {",
        "  search_root=\"$1\"",
        "  [ -d \"$search_root\" ] || { printf 'SKIP missing root: %s\\n' \"$search_root\"; return 0; }",
        `  find "$search_root" ${depthClause} ${pruneClause} ${typeClause} ${nameOp} "$PATTERN" -print 2>/dev/null | head -n "$MAX_RESULTS" | while IFS= read -r f; do`,
        "    found=1",
        "    stat -c '%F\t%s bytes\t%y\t%U:%G\t%n' \"$f\" 2>/dev/null || printf '%s\\n' \"$f\"",
        "  done",
        "}",
        "if [ -n \"$ROOT\" ]; then",
        "  search_one_root \"$ROOT\"",
        "else",
        "  for v in /volume[0-9]*; do",
        "    [ -d \"$v\" ] || continue",
        "    search_one_root \"$v\"",
        "  done",
        "fi",
        "echo ''",
        "echo '=== NOTE ==='",
        "echo 'Results are live find(1) basename-glob matches. No Synology index, Windows index, fuzzy expansion, or content scan was used.'",
        "echo 'If you hit max_results, rerun with a narrower root_path/name_pattern or a higher max_results.'",
      ].join("\n");
    },
  },

  {
    name: "find_path_versions_and_snapshots",
    description: "Looks for recoverable versions of a path: Btrfs snapshots under @Recently-Snapshot, recycle bin entries, and any Drive version hints in logs. Requires exact_path pointing to a file or directory.",
    write: false,
    params: { target, exact_path: exactPath },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      const filename = `$(basename ${quote(p)})`;
      return [
        `echo '=== BTRFS SNAPSHOTS (all volumes) ==='`,
        "for v in /volume[0-9]*; do",
        "  [ -d \"$v/@Recently-Snapshot\" ] || continue",
        "  echo \"--- $v/@Recently-Snapshot ---\"",
        `  find "$v/@Recently-Snapshot" -maxdepth 6 -name "${filename}" 2>/dev/null | head -10`,
        "  ls -lt \"$v/@Recently-Snapshot/\" 2>/dev/null | head -10",
        "  echo ''",
        "done 2>/dev/null || echo 'No @Recently-Snapshot directories found on any volume'",
        "echo ''",
        "echo '=== RECYCLE BIN ==='",
        "for v in /volume[0-9]*; do",
        "  for rb in \"$v\"/@Recycle \"$v\"/@recycle; do",
        "    [ -d \"$rb\" ] || continue",
        "    echo \"--- $rb ---\"",
        `    find "$rb" -maxdepth 5 -name "${filename}" 2>/dev/null | head -10`,
        "    ls -lt \"$rb\" 2>/dev/null | head -10",
        "    echo ''",
        "  done",
        "done 2>/dev/null || echo 'No recycle bin directories found'",
        "echo ''",
        "echo '=== SYNOLOGY DRIVE VERSION HINTS (log) ==='",
        `grep -i ${quote(p)} /host/log/synologydrive.log 2>/dev/null | grep -iE 'version|history|revision|backup|snapshot' | tail -20 || echo 'No version events in Drive log for this path'`,
      ].join("\n");
    },
  },

  {
    name: "search_file_access_audit",
    description: "Searches DSM file access audit logs for a path fragment or username. Pass the search term in filter. Use to investigate who accessed or modified a file. Requires DSM file access logging to be enabled.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim();
      const lines = clamp((input.lookback_hours as number ?? 4) * 40, 60, 400);
      const searchTerm = f || ".";
      return [
        `echo '=== FILE ACCESS AUDIT LOG ==='`,
        `for logf in /host/log/synolog/synofileaccesslog /host/log/synolog/fileaccesslog /host/log/synolog/synologfileaccesslog; do`,
        `  [ -f "$logf" ] || continue`,
        `  echo "=== $logf ==="`,
        `  grep -iE ${quote(searchTerm)} "$logf" 2>/dev/null | tail -${lines}`,
        `  echo ''`,
        `done`,
        `echo ''`,
        `echo '=== DSM AUDIT LOG (admin actions) ==='`,
        `grep -iE ${quote(searchTerm)} /host/log/synolog/synoauditd.log 2>/dev/null | tail -${lines} || echo 'Audit log not found or no matching entries'`,
        `echo ''`,
        `echo '=== NOTE ==='`,
        `echo 'File-level access audit requires DSM file access logging enabled in Control Panel > File Services > Advanced.'`,
      ].join("\n");
    },
  },

  {
    name: "search_file_access_log",
    description:
      "Queries the DSM Log Center file access audit via the WebAPI (SYNO.Core.Log.Center) for a given path fragment, action, or date range. Returns the raw JSON response with newest events first. Requires Log Center package installed and 'Log Sending → Local' file-access logging enabled in DSM Control Panel. Optional filters: path_filter (client-side grep on the JSON), date_from/date_to (ISO yyyy-mm-dd), action_filter (delete|write|read|rename), limit (default 100, max 1000).",
    write: false,
    params: {
      target,
      path_filter: z
        .string()
        .optional()
        .describe("Substring to grep for in the result set, e.g. a filename or folder fragment."),
      date_from: z
        .string()
        .optional()
        .describe("Lower bound ISO date yyyy-mm-dd. Converted to a unix timestamp for the API."),
      date_to: z
        .string()
        .optional()
        .describe("Upper bound ISO date yyyy-mm-dd. Converted to a unix timestamp for the API."),
      action_filter: z
        .enum(["delete", "write", "read", "rename"])
        .optional()
        .describe("Restrict to a single action. Applied client-side on the JSON response."),
      limit: z
        .number()
        .int()
        .optional()
        .default(100)
        .describe("Max records to fetch from the API. Default 100, clamped to [1, 1000]."),
    },
    buildCommand: (input) => {
      const limit = clamp(Math.floor((input.limit as number) ?? 100), 1, 1000);
      const pathFilter = (input.path_filter as string | undefined)?.trim() || "";
      const actionFilter = (input.action_filter as string | undefined)?.trim() || "";
      const dateFrom = (input.date_from as string | undefined)?.trim() || "";
      const dateTo = (input.date_to as string | undefined)?.trim() || "";

      const extra: string[] = [
        `--data-urlencode "type=file"`,
        `--data-urlencode "start=0"`,
        `--data-urlencode "limit=${limit}"`,
      ];
      if (dateFrom) {
        extra.push(
          `--data-urlencode "from_date=$(date -d ${quote(dateFrom)} +%s 2>/dev/null || echo 0)"`,
        );
      }
      if (dateTo) {
        extra.push(
          `--data-urlencode "to_date=$(date -d ${quote(dateTo)} +%s 2>/dev/null || echo 0)"`,
        );
      }

      const filterPipeline: string[] = [];
      if (actionFilter) {
        filterPipeline.push(`grep -i ${quote(actionFilter)}`);
      }
      if (pathFilter) {
        filterPipeline.push(`grep -i ${quote(pathFilter)}`);
      }
      const postFilter =
        filterPipeline.length > 0
          ? ` | tr ',' '\\n' | (${filterPipeline.join(" | ")}) | head -${limit}`
          : "";

      return [
        `if [ -z "\${DSM_USERNAME:-}" ] || [ -z "\${DSM_PASSWORD:-}" ]; then echo "ERROR: DSM_USERNAME/DSM_PASSWORD not set in .env — required for WebAPI calls"; exit 1; fi`,
        `DSM_BASE="http://localhost:\${DSM_PORT:-5000}/webapi/entry.cgi"`,
        `echo "=== Authenticating to DSM WebAPI ==="`,
        `SID=$(curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.API.Auth" --data-urlencode "version=7" --data-urlencode "method=login" --data-urlencode "account=\${DSM_USERNAME}" --data-urlencode "passwd=\${DSM_PASSWORD}" --data-urlencode "format=sid" 2>/dev/null | grep -o '"sid":"[^"]*"' | cut -d'"' -f4)`,
        `if [ -z "$SID" ]; then echo "ERROR: DSM login failed — check DSM_USERNAME/DSM_PASSWORD and port \${DSM_PORT:-5000}"; exit 1; fi`,
        `echo "Authenticated"`,
        `echo ""`,
        `echo "=== Log Center file access query (SYNO.Core.Log.Center v1 method=list type=file limit=${limit}) ==="`,
        `RESULT=$(curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.Core.Log.Center" --data-urlencode "version=1" --data-urlencode "method=list" ${extra.join(" ")} --data-urlencode "_sid=$SID" 2>/dev/null)`,
        `if echo "$RESULT" | grep -q '"success":true'; then`,
        `  echo "API: OK"`,
        ...(postFilter
          ? [
              `  echo ""`,
              `  echo "=== FILTERED ROWS (post-processed) ==="`,
              `  echo "$RESULT"${postFilter}`,
              `  echo ""`,
              `  echo "=== RAW (truncated) ==="`,
              `  echo "$RESULT" | head -c 4000`,
              `  echo ""`,
            ]
          : [
              `  echo ""`,
              `  echo "=== RAW RESPONSE ==="`,
              `  echo "$RESULT"`,
            ]),
        `else`,
        `  echo "API: non-success"`,
        `  echo "$RESULT"`,
        `  echo ""`,
        `  echo "NOTE: SYNO.Core.Log.Center requires Log Center package and may use a different api name on older DSM. Also confirm file access logging is enabled in Control Panel → Log Center → Log Sending → Local."`,
        `fi`,
        `echo ""`,
        `curl -sfG "$DSM_BASE" --data-urlencode "api=SYNO.API.Auth" --data-urlencode "version=7" --data-urlencode "method=logout" --data-urlencode "_sid=$SID" >/dev/null 2>&1 || true`,
        `echo "Session closed"`,
      ].join("\n");
    },
  },

  {
    name: "search_smb_path_activity",
    description: "Searches Samba/SMB logs for activity related to a path fragment, share name, or username. Use to investigate who accessed, created, or deleted files over SMB. Pass the search term in filter.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "access";
      const lines = clamp((input.lookback_hours as number ?? 4) * 40, 60, 300);
      return [
        `echo '=== SMB LOG SEARCH: ${f} ==='`,
        `for logf in /host/log/samba/log.smbd /host/log/smbd.log /host/log/samba/smbd.log; do`,
        `  [ -f "$logf" ] || continue`,
        `  matches=$(grep -ci ${quote(f)} "$logf" 2>/dev/null || true)`,
        `  [ "$matches" -gt 0 ] 2>/dev/null || continue`,
        `  echo "=== $logf ($matches matches) ==="`,
        `  grep -i ${quote(f)} "$logf" 2>/dev/null | tail -${lines}`,
        `  echo ''`,
        `done`,
        `echo ''`,
        `echo '=== SMB LOG DIRECTORY ==='`,
        `ls -lhS /host/log/samba/ 2>/dev/null | head -15 || echo 'No Samba log directory at /host/log/samba/'`,
        `echo ''`,
        `echo '=== ACTIVE SMB CONNECTIONS ==='`,
        `timeout 5 smbstatus -S 2>/dev/null | head -20 || ss -tnp 'sport = :445' 2>/dev/null | head -15 || echo 'smbstatus not available'`,
      ].join("\n");
    },
  },

  {
    name: "search_drive_path_activity",
    description: "Searches Synology Drive logs and ShareSync logs for activity related to a path, filename, or username. Use to investigate sync events, file changes, or errors for a specific file. Pass the search term in filter.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "error";
      const lines = clamp((input.lookback_hours as number ?? 4) * 40, 60, 400);
      return [
        `echo '=== SYNOLOGY DRIVE LOG SEARCH: ${f} ==='`,
        `grep -i ${quote(f)} /host/log/synologydrive.log 2>/dev/null | tail -${lines} || echo 'Drive server log not found'`,
        `echo ''`,
        `echo '=== SHARESYNC LOG SEARCH ==='`,
        `for v in /volume[0-9]*; do`,
        `  for logf in "$v"/*/@synologydrive/log/syncfolder.log "$v"/@SynologyDriveShareSync/*/log/syncfolder.log; do`,
        `    [ -f "$logf" ] || continue`,
        `    matches=$(grep -ci ${quote(f)} "$logf" 2>/dev/null || true)`,
        `    [ "$matches" -gt 0 ] 2>/dev/null || continue`,
        `    echo "=== $logf ($matches matches) ==="`,
        `    grep -i ${quote(f)} "$logf" 2>/dev/null | tail -${lines}`,
        `    echo ''`,
        `  done`,
        `done 2>/dev/null || echo 'No ShareSync logs found'`,
      ].join("\n");
    },
  },

  {
    name: "hash_file",
    description: "Computes SHA-256 and MD5 hashes for an exact file path, along with size and timestamps. Use to verify file integrity, detect silent corruption, or confirm whether two copies are identical. Requires exact_path.",
    write: false,
    params: { target, exact_path: exactPath },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      return [
        `echo '=== FILE IDENTITY ==='`,
        `stat -c 'size=%s mtime=%y ctime=%z owner=%U:%G mode=%A' ${quote(p)} 2>&1`,
        `echo ''`,
        `echo '=== SHA-256 ==='`,
        `sha256sum ${quote(p)} 2>&1`,
        `echo ''`,
        `echo '=== MD5 ==='`,
        `md5sum ${quote(p)} 2>/dev/null || echo 'md5sum not available'`,
      ].join("\n");
    },
  },

  {
    name: "compare_file_versions",
    description: "Compares two file paths: size, mtime, owner, mode, and SHA-256 hashes side by side. Optionally shows a text diff for small text files. Provide first path in exact_path and second path in filter.",
    write: false,
    params: { target, exact_path: exactPath, filter },
    buildCommand: (input) => {
      const p1 = (input.exact_path as string).trim();
      const p2 = (input.filter as string | undefined)?.trim();
      if (!p2) {
        return `echo 'compare_file_versions requires exact_path (first file) and filter (second file path).'`;
      }
      return [
        `echo '=== FILE 1: ${p1} ==='`,
        `stat -c 'size=%s mtime=%y owner=%U:%G mode=%A' ${quote(p1)} 2>&1`,
        `sha256sum ${quote(p1)} 2>&1`,
        `echo ''`,
        `echo '=== FILE 2: ${p2} ==='`,
        `stat -c 'size=%s mtime=%y owner=%U:%G mode=%A' ${quote(p2)} 2>&1`,
        `sha256sum ${quote(p2)} 2>&1`,
        `echo ''`,
        `echo '=== COMPARISON ==='`,
        `h1=$(sha256sum ${quote(p1)} 2>/dev/null | awk '{print $1}')`,
        `h2=$(sha256sum ${quote(p2)} 2>/dev/null | awk '{print $1}')`,
        `if [ "$h1" = "$h2" ] && [ -n "$h1" ]; then echo 'IDENTICAL: SHA-256 hashes match'; else echo 'DIFFERENT: SHA-256 hashes differ'; fi`,
        `echo ''`,
        `echo '=== TEXT DIFF (first 50 lines, text files only) ==='`,
        `diff ${quote(p1)} ${quote(p2)} 2>/dev/null | head -50 || echo 'diff failed (files may be binary or one/both paths missing)'`,
      ].join("\n");
    },
  },

  // ── Phase 1F: Evidence collection ────────────────────────────────────────────

  {
    name: "collect_incident_bundle",
    description: "Collects a targeted set of diagnostics for a specific incident type. Pass the type in filter: 'drive' (Drive/ShareSync), 'storage' (RAID/SMART/Btrfs), 'network' (interfaces/DNS), 'permission' (ACL/share), or 'crash' (daemon/OOM/segfault). Omit filter for general system snapshot.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const incidentType = (input.filter as string | undefined)?.trim()?.toLowerCase() || "general";
      const sections: string[] = [
        `echo '=== INCIDENT BUNDLE: ${incidentType.toUpperCase()} ==='`,
        `echo "Collected: $(date)"`,
        "echo ''",
        "echo '=== SYSTEM BASELINE ==='",
        "uptime && free -h && df -h 2>/dev/null | awk 'NR==1 || $6 ~ /^\\/volume[0-9]+$/'",
        "echo ''",
      ];
      if (incidentType === "drive" || incidentType === "general") {
        sections.push(
          "echo '=== DRIVE/SHARESYNC STATUS ==='",
          "for pkg in SynologyDrive SynologyDriveShareSync; do ver=$(grep -m1 '^version=' /var/packages/$pkg/INFO 2>/dev/null | cut -d= -f2-); enabled=$([ -f /var/packages/$pkg/enabled ] && echo enabled || echo disabled); echo \"$pkg: $ver [$enabled]\"; done",
          "echo ''",
          "echo '=== DRIVE LOG TAIL (50 lines) ==='",
          "tail -50 /host/log/synologydrive.log 2>/dev/null || echo 'Drive log not found'",
          "echo ''",
          "echo '=== SHARESYNC STATUS ==='",
          "for v in /volume[0-9]*; do for f in \"$v\"/*/@synologydrive/log/syncfolder.log \"$v\"/@SynologyDriveShareSync/*/log/syncfolder.log; do [ -f \"$f\" ] || continue; echo \"=== $f ===\"; tail -20 \"$f\"; done; done 2>/dev/null || true",
          "echo ''",
        );
      }
      if (incidentType === "storage" || incidentType === "general") {
        sections.push(
          "echo '=== STORAGE HEALTH ==='",
          "/host/usr/syno/sbin/synovolumestatus 2>/dev/null || echo 'synovolumestatus not available'",
          "cat /proc/mdstat 2>/dev/null",
          "echo ''",
          "echo '=== SMART SUMMARY ==='",
          "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo -n \"$d: \"; smartctl -H \"$d\" 2>/dev/null | grep -E 'result|PASSED|FAILED'; done 2>/dev/null || echo 'smartctl not available'",
          "echo ''",
          "echo '=== KERNEL DISK ERRORS ==='",
          "dmesg -T 2>/dev/null | grep -iE 'i/o error|scsi|ata.*error|btrfs.*error' | tail -20 || true",
          "echo ''",
        );
      }
      if (incidentType === "network") {
        sections.push(
          "echo '=== NETWORK INTERFACES ==='",
          "ip addr 2>/dev/null | grep -E 'inet|^[0-9]+:' | head -20",
          "cat /proc/net/dev | awk 'NR>2{gsub(\":\",\" \",$1); if ($4+$5+$12+$13 > 0) printf \"%-12s RX_errs:%-6s RX_drop:%-6s TX_errs:%-6s TX_drop:%-6s\\n\",$1,$4,$5,$12,$13}' | grep -v '^lo '",
          "echo ''",
          "echo '=== DNS + GATEWAY ==='",
          "cat /host/etc/resolv.conf 2>/dev/null | head -5",
          "ip route show default 2>/dev/null",
          "gw=$(ip route show default 2>/dev/null | awk '/default/{print $3}' | head -1); [ -n \"$gw\" ] && ping -c 2 -W 2 \"$gw\" 2>/dev/null | tail -2",
          "echo ''",
          "echo '=== TAILSCALE ==='",
          "ip addr show tailscale0 2>/dev/null | grep inet || echo 'tailscale0 not found'",
          "echo ''",
        );
      }
      if (incidentType === "permission") {
        sections.push(
          "echo '=== SHARE DATABASE ==='",
          "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>&1 | head -20",
          "echo ''",
          "echo '=== SHARE ACCESS CHECK ==='",
          "LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | while read -r share; do [ -n \"$share\" ] || continue; path=$(LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/sbin/synoshare --get \"$share\" 2>/dev/null | awk -F= '/^path=/{print $2; exit}'); [ -n \"$path\" ] || continue; if [ -d \"$path\" ]; then printf 'OK %s %s\\n' \"$share\" \"$path\"; else printf 'MISSING %s %s\\n' \"$share\" \"$path\"; fi; done",
          "echo ''",
          "echo '=== SECURITY LOG TAIL ==='",
          "tail -30 /host/log/synolog/synosecurity.log 2>/dev/null || echo 'Security log not found'",
          "echo ''",
        );
      }
      if (incidentType === "crash") {
        sections.push(
          "echo '=== CRASH SIGNALS ==='",
          "dmesg -T 2>/dev/null | grep -iE 'segfault|oom|killed process|kernel panic|BUG:|Oops:' | tail -30 || dmesg | grep -iE 'segfault|oom|killed' | tail -20",
          "echo ''",
          "echo '=== KEY DAEMON PROCESSES ==='",
          "ps aux | awk 'NR==1 || /synologand|invoked|syncd|syno_drive/' | head -20",
          "echo ''",
          "echo '=== LOCK FILES ==='",
          "find /host/var/packages/ -maxdepth 5 \\( -name '*.lock' -o -name 'lock' \\) 2>/dev/null | head -20",
          "echo ''",
          "echo '=== DSM ERROR LOG ==='",
          "tail -30 /host/log/synolog/synoerr.log 2>/dev/null || echo 'synoerr.log not found'",
          "echo ''",
        );
      }
      sections.push("echo '=== BUNDLE COMPLETE ==='");
      return sections.join("\n");
    },
  },

  {
    name: "fetch_log_file",
    description: "Returns the content of a specific log file. Specify the full log path in filter (e.g. /host/log/synolog/synosecurity.log). Use lookback_hours to limit output size. If filter is empty, lists available log files instead.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const logPath = (input.filter as string | undefined)?.trim();
      if (!logPath) {
        return [
          "echo '=== AVAILABLE LOG FILES ==='",
          "ls -lhS /host/log/synolog/*.log 2>/dev/null | head -30",
          "echo ''",
          "ls -lhS /host/log/*.log 2>/dev/null | head -20",
          "echo ''",
          "echo 'Specify the full log path in the filter parameter to fetch its contents.'",
        ].join("\n");
      }
      const lines = clamp((input.lookback_hours as number ?? 2) * 60, 100, 2000);
      return [
        `echo '=== LOG FILE: ${logPath} ==='`,
        `if [ -f ${quote(logPath)} ]; then`,
        `  wc -l ${quote(logPath)} 2>/dev/null`,
        `  echo "--- last ${lines} lines ---"`,
        `  tail -n ${lines} ${quote(logPath)} 2>&1`,
        `else`,
        `  echo 'File not found: ${logPath}'`,
        `  echo ''`,
        `  echo 'Nearby files:'`,
        `  ls -lh "$(dirname ${quote(logPath)})" 2>/dev/null | head -20`,
        `fi`,
      ].join("\n");
    },
  },

  {
    name: "fetch_package_db",
    description: "Queries a named DSM package's SQLite database in read-only mode. Pass the package name and optionally a read-only SQL query in filter (SELECT/WITH or safe schema PRAGMA only). Omit filter to list tables. Use for deep investigation of Drive, HyperBackup, or scheduler internal state.",
    write: false,
    params: { target, package_name: packageName, filter },
    buildCommand: (input) => {
      const pkg = (input.package_name as string).trim();
      const rawQuery = (input.filter as string | undefined)?.trim();
      const query = rawQuery ? readOnlySql(rawQuery) : "";
      const pkgLower = pkg.toLowerCase();
      const findCmd = `find /volume[0-9]*/@${pkgLower}/ /volume[0-9]*/@syno${pkgLower}/ /host/packages/${quote(pkg)}/var/ /host/packages/${quote(pkg)}/target/ /host/var/packages/${quote(pkg)}/var/ /var/packages/${quote(pkg)}/var/ -maxdepth 6 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null`;
      const lines: string[] = [
        `echo '=== PACKAGE DB: ${pkg} ==='`,
        `echo ''`,
        `echo '=== DATABASE FILES ==='`,
        `${findCmd} | head -10`,
        `echo ''`,
      ];
      if (query) {
        lines.push(
          `echo '=== QUERY: ${query} ==='`,
          `dbfile=$(${findCmd} | head -1)`,
          `[ -n "$dbfile" ] && echo "Using: $dbfile" && timeout 15 sqlite3 -readonly "$dbfile" ${quote(query)} 2>&1 | head -100 || echo 'No DB file found'`,
        );
      } else {
        lines.push(
          `echo '=== TABLE SUMMARY ==='`,
          `for dbfile in $(${findCmd} | head -3); do`,
          `  echo "--- $dbfile ---"`,
          `  timeout 10 sqlite3 -readonly "$dbfile" '.tables' 2>&1 | head -10`,
          `  echo ''`,
          `done || echo 'No DB files found for ${pkg}'`,
        );
      }
      return lines.join("\n");
    },
  },

  {
    name: "fetch_support_artifacts",
    description: "Lists DSM support bundle tarballs, large log files sorted by size, package log directories, and any core dumps. Use before a deep investigation session to see what artifact files are available to fetch or analyze.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DSM SUPPORT BUNDLES ==='",
      "find /tmp /var/tmp -maxdepth 2 \\( -name 'synology_support*.tgz' -o -name 'support_*.tgz' \\) 2>/dev/null | xargs ls -lh 2>/dev/null | head -10 || echo 'No support bundle tarballs found in /tmp'",
      "echo ''",
      "echo '=== LARGE LOG FILES (sorted by size) ==='",
      "find /host/log/synolog/ /host/log/ -maxdepth 2 -name '*.log' 2>/dev/null | xargs ls -lhS 2>/dev/null | head -20 || echo 'Log dir not found'",
      "echo ''",
      "echo '=== PACKAGE LOG DIRS ==='",
      "for d in /host/var/packages/*/var/log; do",
      "  [ -d \"$d\" ] || continue",
      "  pkg=$(echo \"$d\" | awk -F/ '{print $(NF-2)}')",
      "  size=$(du -sh \"$d\" 2>/dev/null | awk '{print $1}')",
      "  count=$(find \"$d\" -name '*.log' 2>/dev/null | wc -l)",
      "  printf '%-30s size=%-8s logfiles=%s\\n' \"$pkg\" \"$size\" \"$count\"",
      "done 2>/dev/null || echo 'No package log dirs found'",
      "echo ''",
      "echo '=== CORE DUMPS ==='",
      "find /tmp /var/crash -maxdepth 3 2>/dev/null \\( -name 'core*' -o -name '*.core' \\) | xargs ls -lh 2>/dev/null | head -10 || echo 'No core dumps in /tmp or /var/crash'",
      "for v in /volume[0-9]*; do find \"$v/crash\" -maxdepth 2 2>/dev/null \\( -name 'core*' -o -name '*.core' \\) | xargs ls -lh 2>/dev/null | head -5; done 2>/dev/null || true",
    ].join("\n"),
  },

  // ── Phase 3: Recovery and restoration (read) ─────────────────────────────────

  {
    name: "list_snapshot_candidates",
    description: "Lists available Btrfs snapshots on all volumes that could be used for path recovery. Shows snapshot names and recent snapshot directories without recursively scanning snapshot sizes. Optionally pass a name fragment in filter to narrow results.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const nameFilter = (input.filter as string | undefined)?.trim();
      return [
        "echo '=== BTRFS SUBVOLUME SNAPSHOTS (all volumes) ==='",
        "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
        "  [ -d \"$v\" ] || continue",
        "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
        "  [ \"$fstype\" = 'btrfs' ] || continue",
        "  echo \"--- $v ---\"",
        "  btrfs subvolume list -s \"$v\" 2>&1 | head -30",
        "  echo ''",
        "done 2>/dev/null || echo 'btrfs not available or no btrfs volumes'",
        "echo ''",
        "echo '=== @Recently-Snapshot DIRS ==='",
        "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
        "  [ -d \"$v/@Recently-Snapshot\" ] || continue",
        "  echo \"--- $v/@Recently-Snapshot ---\"",
        "  ls -lt \"$v/@Recently-Snapshot/\" 2>/dev/null | head -20",
        "  echo ''",
        "done 2>/dev/null || echo 'No @Recently-Snapshot directories found'",
        "echo ''",
        "echo '=== @prechange SNAPSHOTS ==='",
        "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
        nameFilter
          ? `  ls -dt "$v"/@prechange_* "$v"/@*${nameFilter}* 2>/dev/null | head -10`
          : `  ls -dt "$v"/@prechange_* 2>/dev/null | head -10`,
        "done 2>/dev/null || echo 'No @prechange snapshots found'",
        "echo ''",
        "echo '=== NOTE ==='",
        "echo 'Snapshot sizes are intentionally omitted here: recursive size scans can create heavy disk metadata I/O. Use targeted path/version tools for a specific restore candidate.'",
      ].join("\n");
    },
  },

  {
    name: "summarize_snapshots_by_share",
    description: "Summarizes visible Btrfs snapshots by share and creation-time bucket without dumping giant raw lists. Use to inspect Snapshot Replication retention density per shared folder. Optional filter narrows to a share/path fragment.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const nameFilter = (input.filter as string | undefined)?.trim().slice(0, 80);
      const grepFilter = nameFilter ? ` | grep -i ${quote(nameFilter)}` : "";
      return [
        "echo '=== SNAPSHOT SUMMARY BY SHARE ==='",
        "snapshot_rows=$(",
        "  for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
        "    [ -d \"$v\" ] || continue",
        "    fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
        "    [ \"$fstype\" = 'btrfs' ] || continue",
        "    btrfs subvolume list -s \"$v\" 2>/dev/null | sed -n 's/.* path //p' | head -5000 | while IFS= read -r rel; do",
        "      [ -n \"$rel\" ] || continue",
        "      share=$(printf '%s\\n' \"$rel\" | awk -F/ '",
        "        $1==\"@sharesnap\" && NF>=2 {print $2; next}",
        "        $1==\"@Recently-Snapshot\" && NF>=2 {print $2; next}",
        "        $1 ~ /^@/ && NF>=2 {print $2; next}",
        "        {print $1}",
        "      ')",
        "      stamp=$(printf '%s\\n' \"$rel\" | grep -oE 'GMT-[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-[0-9]{2}\\.[0-9]{2}\\.[0-9]{2}|[0-9]{4}[._-][0-9]{2}[._-][0-9]{2}[-_][0-9]{2}' | head -1)",
        "      if [ -z \"$stamp\" ] && [ -e \"$v/$rel\" ]; then stamp=$(stat -c '%y' \"$v/$rel\" 2>/dev/null | cut -c1-13); fi",
        "      [ -n \"$stamp\" ] || stamp='unknown-time'",
        "      printf '%s|%s|%s|%s\\n' \"$v\" \"$share\" \"$stamp\" \"$rel\"",
        "    done",
        "  done",
        ")",
        `printf '%s\\n' "$snapshot_rows"${grepFilter} | awk -F'|' 'NF>=4 { total[$2]++; bucket[$2\"|\"$3]++; if (!first[$2] || $3 < first[$2]) first[$2]=$3; if (!last[$2] || $3 > last[$2]) last[$2]=$3 } END { if (length(total)==0) { print \"No visible snapshots matched.\"; exit } printf \"%-28s %8s %-22s %-22s\\n\", \"share\", \"count\", \"oldest_bucket\", \"newest_bucket\"; for (s in total) printf \"%-28s %8d %-22s %-22s\\n\", s, total[s], first[s], last[s] }' | sort`,
        "echo ''",
        "echo '=== SNAPSHOT DENSITY BY SHARE/TIME BUCKET ==='",
        `printf '%s\\n' "$snapshot_rows"${grepFilter} | awk -F'|' 'NF>=4 { bucket[$2\"|\"$3]++ } END { for (k in bucket) { split(k, a, \"|\"); printf \"%-28s %-22s %6d\\n\", a[1], a[2], bucket[k] } }' | sort | head -200`,
        "echo ''",
        "echo '=== RECENT SAMPLE PATHS ==='",
        `printf '%s\\n' "$snapshot_rows"${grepFilter} | sort -t'|' -k3,3r | head -80 | awk -F'|' '{printf \"%-16s %-24s %-22s %s\\n\", $1, $2, $3, $4}'`,
      ].join("\n");
    },
  },

  {
    name: "inspect_snapshot_replication",
    description: "Compact read-only Snapshot Replication inspection that stays within the NAS API command-size limit: package state, daemon runtime, candidate config/DB paths, DSM scheduled snapshot tasks, snapshot counts, and recent prune/delete events. Use summarize_snapshots_by_share and fetch_package_db for deeper follow-up.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const nameFilter = (input.filter as string | undefined)?.trim().slice(0, 80);
      const grepFilter = nameFilter ? ` | grep -i ${quote(nameFilter)}` : "";
      return [
        "echo '=== SNAPSHOT REPLICATION PACKAGE ==='",
        "ver=$(grep -m1 '^version=' /host/packages/SnapshotReplication/INFO /host/var/packages/SnapshotReplication/INFO /var/packages/SnapshotReplication/INFO 2>/dev/null | head -1 | cut -d= -f2-)",
        "if [ -f /host/packages/SnapshotReplication/enabled ] || [ -f /host/var/packages/SnapshotReplication/enabled ] || [ -f /var/packages/SnapshotReplication/enabled ]; then enabled=enabled; else enabled=disabled; fi",
        "echo \"SnapshotReplication: ${ver:-not found} [$enabled]\"",
        "for p in /host/usr/syno/bin/synopkg /usr/syno/bin/synopkg; do [ -x \"$p\" ] && { \"$p\" status SnapshotReplication 2>&1 | head -20; break; }; done",
        "echo ''",
        "echo '=== SNAPSHOT REPLICATION RUNTIME ==='",
        "ps -eo pid,ppid,stat,etime,args 2>/dev/null | grep -Ei 'synobtrfsreplicad|SnapshotReplication|ReplicationService|synosnap|synobtrfs' | grep -v grep | head -40 || echo 'No Snapshot Replication runtime processes visible'",
        "echo ''",
        "echo '=== SNAPSHOT COUNTS BY VOLUME ==='",
        "for v in /btrfs/volume[0-9]* /volume[0-9]*; do",
        "  [ -d \"$v\" ] || continue",
        "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
        "  [ \"$fstype\" = 'btrfs' ] || continue",
        "  count=$(btrfs subvolume list -s \"$v\" 2>/dev/null | wc -l | tr -d ' ')",
        "  recent=$(find \"$v/@Recently-Snapshot\" -maxdepth 2 -type d 2>/dev/null | wc -l | tr -d ' ')",
        "  printf '%-16s btrfs_snapshots=%-6s recently_snapshot_dirs=%s\\n' \"$v\" \"${count:-0}\" \"${recent:-0}\"",
        "done 2>/dev/null || echo 'No Btrfs volumes visible'",
        "echo ''",
        "echo '=== CONFIG / DB CANDIDATES ==='",
        "roots='/host/packages/SnapshotReplication /host/packages/ReplicationService /host/usr/syno/etc /host/etc /var/packages/SnapshotReplication /var/packages/ReplicationService'",
        `for r in $roots; do [ -d "$r" ] && find "$r" -maxdepth 5 \\( -iname '*.db' -o -iname '*.sqlite' -o -iname '*.conf' -o -iname '*.json' -o -iname '*.ini' -o -iname '*.cfg' \\) 2>/dev/null; done | grep -Ei 'snapshot|replica|retent|sched|task|btrfs|share|rotate|policy'${grepFilter} | sort -u | head -60 || echo 'No candidate config/DB files found'`,
        "echo ''",
        "echo '=== DSM SCHEDULED SNAPSHOT TASKS ==='",
        "if [ -z \"${DSM_USERNAME:-}\" ] || [ -z \"${DSM_PASSWORD:-}\" ]; then",
        "  echo 'DSM_USERNAME/DSM_PASSWORD not set; skipping DSM WebAPI task list.'",
        "else",
        "  DSM_BASE=\"http://localhost:${DSM_PORT:-5000}/webapi/entry.cgi\"",
        "  SID=$(curl -sfG \"$DSM_BASE\" --data-urlencode 'api=SYNO.API.Auth' --data-urlencode 'version=7' --data-urlencode 'method=login' --data-urlencode \"account=${DSM_USERNAME}\" --data-urlencode \"passwd=${DSM_PASSWORD}\" --data-urlencode 'format=sid' 2>/dev/null | grep -o '\"sid\":\"[^\"]*\"' | cut -d'\"' -f4)",
        "  if [ -z \"$SID\" ]; then",
        "    echo 'DSM WebAPI login failed; check DSM credentials/port.'",
        "  else",
        "    for ver in 3 2 1 4; do out=$(curl -sfG \"$DSM_BASE\" --data-urlencode 'api=SYNO.Core.TaskScheduler' --data-urlencode \"version=$ver\" --data-urlencode 'method=list' --data-urlencode 'offset=0' --data-urlencode 'limit=200' --data-urlencode \"_sid=$SID\" 2>/dev/null); echo \"$out\" | grep -qi 'snapshot\\|replica\\|btrfs' && { echo \"$out\" | grep -oiE '.{0,80}(snapshot|replica|btrfs).{0,120}' | head -80; break; }; done",
        "    curl -sfG \"$DSM_BASE\" --data-urlencode 'api=SYNO.API.Auth' --data-urlencode 'version=7' --data-urlencode 'method=logout' --data-urlencode \"_sid=$SID\" >/dev/null 2>&1 || true",
        "  fi",
        "fi",
        "echo ''",
        "echo '=== RECENT SNAPSHOT / PRUNE / DELETE LOG EVENTS ==='",
        "for f in /host/log/synolog/synosnapshot.log /host/log/synolog/synostorage.log /host/log/messages /host/packages/SnapshotReplication/var/*.log /host/packages/ReplicationService/var/*.log /var/packages/SnapshotReplication/var/*.log /var/packages/ReplicationService/var/*.log; do",
        "  [ -f \"$f\" ] || continue",
        "  echo \"--- $f ---\"",
        `  grep -iE 'snapshot|replica|replication|retention|prune|delete|remove|rotate|schedule|task' "$f" 2>/dev/null${grepFilter} | tail -80`,
        "done",
        "echo ''",
        "echo 'Use summarize_snapshots_by_share for density and fetch_package_db for read-only DB table inspection.'",
      ].join("\n");
    },
  },

  {
    name: "list_drive_version_history",
    description: "Queries the Synology Drive SQLite database for version history of a specific file. Requires exact_path. Shows available version tables and attempts to list versions by filename.",
    write: false,
    params: { target, exact_path: exactPath },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      // Escape single quotes for SQL LIKE — double them
      const sqlSafeName = p.replace(/'/g, "''");
      return [
        `echo '=== DRIVE VERSION HISTORY FOR: ${p} ==='`,
        `maindb=$(find /volume[0-9]*/@synologydrive/ -maxdepth 5 \\( -name 'synodrive.db' -o -name 'sync.db' -o -name 'metadata.db' \\) 2>/dev/null | head -1)`,
        `if [ -z "$maindb" ]; then echo 'Drive database not found on any volume'; exit 0; fi`,
        `echo "DB: $maindb"`,
        `echo ''`,
        `echo '=== DB TABLES ==='`,
        `timeout 5 sqlite3 "$maindb" '.tables' 2>&1`,
        `echo ''`,
        `echo '=== VERSION/HISTORY SEARCH ==='`,
        `for tbl in file_version version file_history; do`,
        `  count=$(timeout 3 sqlite3 "$maindb" "SELECT count(*) FROM $tbl;" 2>/dev/null)`,
        `  [ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null || continue`,
        `  echo "--- table: $tbl (\${count} rows) ---"`,
        `  timeout 10 sqlite3 "$maindb" "SELECT * FROM $tbl WHERE path LIKE '%${sqlSafeName}%' OR name LIKE '%$(basename "${sqlSafeName}")%' ORDER BY rowid DESC LIMIT 20;" 2>/dev/null`,
        `  echo ''`,
        `done`,
        `echo ''`,
        `echo '=== SCHEMA FOR DETECTED TABLES ==='`,
        `for tbl in file_version version file_history; do`,
        `  schema=$(timeout 3 sqlite3 "$maindb" ".schema $tbl" 2>/dev/null)`,
        `  [ -n "$schema" ] && echo "--- $tbl ---" && echo "$schema" && echo ''`,
        `done`,
      ].join("\n");
    },
  },

  {
    name: "inspect_recycle_bin",
    description: "Lists contents of the Synology recycle bin across all volumes and shares. Pass a filename or path fragment in filter to search for a specific file. Shows timestamps, sizes, and full paths.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const searchTerm = (input.filter as string | undefined)?.trim();
      const findFilter = searchTerm
        ? `-name ${quote("*" + searchTerm + "*")}`
        : "-maxdepth 3";
      return [
        "echo '=== VOLUME-LEVEL RECYCLE BIN ==='",
        "for v in /volume[0-9]*; do",
        "  for rb in \"$v\"/@Recycle \"$v\"/@recycle; do",
        "    [ -d \"$rb\" ] || continue",
        "    echo \"--- $rb ---\"",
        `    find "$rb" ${findFilter} -type f 2>/dev/null | while read -r f; do stat -c '%y %s %n' "$f" 2>/dev/null; done | sort -r | head -20`,
        "    echo ''",
        "  done",
        "done 2>/dev/null || echo 'No volume-level recycle bins found'",
        "echo ''",
        "echo '=== PER-SHARE RECYCLE BIN (#recycle) ==='",
        "for v in /volume[0-9]*; do",
        "  for share in \"$v\"/*/; do",
        "    [ -d \"${share}#recycle\" ] || continue",
        "    echo \"--- ${share}#recycle ---\"",
        `    find "\${share}#recycle" ${findFilter} -type f 2>/dev/null | while read -r f; do stat -c '%y %s %n' "$f" 2>/dev/null; done | sort -r | head -10`,
        "    echo ''",
        "  done",
        "done 2>/dev/null || echo 'No per-share recycle bins found'",
      ].join("\n");
    },
  },

  // ── Phase 4: Long-running task progress (read) ────────────────────────────────

  {
    name: "check_smart_test_progress",
    description: "Shows the current progress, remaining time, and recent log of active SMART self-tests. Pass a device in filter (e.g. /dev/sda) to check a specific disk, or leave empty to check all disks.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const device = (input.filter as string | undefined)?.trim();
      if (device) {
        return [
          `echo '=== SMART TEST PROGRESS: ${device} ==='`,
          `smartctl -a ${quote(device)} 2>&1 | grep -E 'Self-test execution|remaining|progress|completed|# 1|LBA'`,
          `echo ''`,
          `echo '=== SELF-TEST LOG ==='`,
          `smartctl -l selftest ${quote(device)} 2>&1 | head -15`,
        ].join("\n");
      }
      return [
        "echo '=== SMART TEST PROGRESS (all disks) ==='",
        "for d in /dev/sd?; do",
        "  [ -b \"$d\" ] || continue",
        "  status=$(smartctl -a \"$d\" 2>/dev/null | grep -E 'Self-test execution status|remaining' | head -2)",
        "  [ -n \"$status\" ] && echo \"$d:\" && echo \"  $status\"",
        "done 2>/dev/null || echo 'smartctl not available'",
        "echo ''",
        "echo '=== RECENT SELF-TEST LOG (all disks) ==='",
        "for d in /dev/sd?; do",
        "  [ -b \"$d\" ] || continue",
        "  echo \"--- $d ---\"",
        "  smartctl -l selftest \"$d\" 2>/dev/null | head -8",
        "  echo ''",
        "done 2>/dev/null || true",
      ].join("\n");
    },
  },

  // ── Write tools ───────────────────────────────────────────────────────────────

  {
    name: "restart_monitor_agent",
    description: "WRITE — Restarts the Synology Monitor agent container through DSM Container Manager WebAPI. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () =>
      "/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=stop name='\"synology-monitor-agent\"' && sleep 3 && /usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=start name='\"synology-monitor-agent\"'",
  },

  {
    name: "stop_monitor_agent",
    description: "WRITE — Stops the Synology Monitor agent through DSM Container Manager WebAPI. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () =>
      "/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=stop name='\"synology-monitor-agent\"'",
  },

  {
    name: "start_monitor_agent",
    description: "WRITE — Starts the Synology Monitor agent through DSM Container Manager WebAPI. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () =>
      "/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=start name='\"synology-monitor-agent\"'",
  },

  {
    name: "pull_monitor_agent",
    description: "UNSUPPORTED — Image pulls must be handled by the backend deploy/update pipeline, not Docker compose from monitor tooling.",
    write: true,
    params: { target },
    buildCommand: () => {
      throw new Error("pull_monitor_agent is disabled because Docker compose mutations desync DSM Container Manager. Use the backend deploy/update pipeline.");
    },
  },

  {
    name: "build_monitor_agent",
    description: "UNSUPPORTED — Local image builds must not be run from monitor tooling because they bypass DSM Container Manager state.",
    write: true,
    params: { target },
    buildCommand: () => {
      throw new Error("build_monitor_agent is disabled because Docker compose mutations desync DSM Container Manager. Use the backend deploy/update pipeline.");
    },
  },

  {
    name: "restart_nas_api",
    description: "UNSUPPORTED — NAS API restarts must be handled by DSM Container Manager or the backend deploy/update pipeline.",
    write: true,
    params: { target },
    buildCommand: () => {
      throw new Error("restart_nas_api is disabled because Docker compose mutations desync DSM Container Manager. Restart it through DSM Container Manager or the backend deploy/update pipeline.");
    },
  },

  {
    name: "restart_synology_drive_server",
    description: "WRITE — Restarts the Synology Drive package via DSM WebAPI. Use when Drive is unresponsive or in an error state. Requires DSM_USERNAME/DSM_PASSWORD in the container .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => buildDsmPackageRestart("SynologyDrive"),
  },

  {
    name: "restart_synology_drive_sharesync",
    description: "WRITE — Restarts the SynologyDriveShareSync package via DSM WebAPI. Use when ShareSync is stuck or not syncing. Requires DSM_USERNAME/DSM_PASSWORD in the container .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => buildDsmPackageRestart("SynologyDriveShareSync"),
  },

  {
    name: "restart_hyper_backup",
    description: "WRITE — Restarts the HyperBackup package via DSM WebAPI. Use when backup jobs are stuck or failing to start. Requires DSM_USERNAME/DSM_PASSWORD in the container .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => buildDsmPackageRestart("HyperBackup"),
  },

  {
    name: "rename_file_to_old",
    description: "WRITE (tier 3) — Renames a specific file by adding .old to its name, hiding it from sync without deleting it. Requires an exact file path in the 'filter' parameter, either as a /volumeN/... path (auto-mapped to the nas-api /btrfs writable mount, since the per-share /volumeN mounts are read-only) or directly as /btrfs/volumeN/.... Refuses if the .old name already exists (checked, not atomic). Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("rename_file_to_old requires an exact file path in the 'filter' parameter.");
      const filePath = toWritableVolumePath(raw, "rename_file_to_old");
      // quote() single-quotes the path at every use site, so a `$(...)` in it is
      // inert data. Messages interpolate "$src"/"$dest", never the raw string —
      // a raw path in a double-quoted echo is still an injection (the `||` branch
      // executes it precisely when the path is hostile).
      //
      // The mv repeats the path LITERALLY instead of using "$src" on purpose:
      // nas-api's ClassifyTier matches filePatterns per line and needs a literal
      // /volumeN path beside the mv to rate this a tier-3 user-data write. Passing
      // "$src" there classifies tier 2, which drops the approval TOKEN
      // (buildApprovalToken fires on tier >= 2; nas-mcp confirms every write tool
      // regardless of tier — see apps/nas-mcp/src/index.ts:170). Delete this
      // duplication only once nas-api enforces a declared minimum tier per tool,
      // which would make tier independent of what the regex can see.
      //
      // `mv -n` supplies the no-clobber; the trailing source-survival check is what
      // makes a lost race REPORT as a failure. It cannot be dropped: deployed
      // nas-api is Debian 12 / GNU coreutils 9.1, and `mv -n` only began exiting
      // non-zero on a skipped move in coreutils 9.2 — on 9.1 it exits 0 and moves
      // nothing, i.e. a silent false success. The check proves the source is gone,
      // not that this mv is what moved it; hence "checked, not atomic".
      return [
        `src=${quote(filePath)}`,
        `dest=${quote(`${filePath}.old`)}`,
        `[ -e "$src" ] || { echo "ERROR: no such path: $src"; exit 1; }`,
        `[ -e "$dest" ] && { echo "ERROR: destination already exists: $dest"; exit 1; }`,
        `mv -n ${quote(filePath)} ${quote(`${filePath}.old`)} || { echo "FAILED to rename: $src"; exit 1; }`,
        `[ -e "$src" ] && { echo "FAILED: destination appeared concurrently; nothing was moved"; exit 1; }`,
        `echo "Renamed successfully"`,
      ].join("\n");
    },
  },

  {
    name: "remove_invalid_chars",
    description: "WRITE (tier 3) — Cleans a filename by replacing sync-breaking characters (: * ? \" < > |) in the BASENAME with underscores; the parent directory is left alone. Requires an exact file path in the 'filter' parameter, either as a /volumeN/... path (auto-mapped to the nas-api /btrfs writable mount, since the per-share /volumeN mounts are read-only) or directly as /btrfs/volumeN/.... Refuses if the cleaned name already exists (checked, not atomic). Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("remove_invalid_chars requires an exact file path in the 'filter' parameter.");
      const filePath = toWritableVolumePath(raw, "remove_invalid_chars");
      // Expanded once into "$src" via quote(); see rename_file_to_old.
      return [
        `src=${quote(filePath)}`,
        `[ -e "$src" ] || { echo "ERROR: no such path: $src"; exit 1; }`,
        `dir=$(dirname "$src"); file=$(basename "$src")`,
        `newfile=$(printf '%s' "$file" | sed 's/[\\/:*?"<>|]/_/g')`,
        // Each outcome exits on its own line: the old `[ ] && mv && echo || echo`
        // chain fired the `||` branch when mv FAILED, printing "No invalid
        // characters found" and exiting 0 — a false success on a real failure.
        `if [ "$file" = "$newfile" ]; then echo "No invalid characters found"; exit 0; fi`,
        `[ -e "$dir/$newfile" ] && { echo "ERROR: destination already exists: $dir/$newfile"; exit 1; }`,
        // Literal path on the mv line, plus `-n` and the source-survival check —
        // see rename_file_to_old for why each is load-bearing.
        `mv -n ${quote(filePath)} "$dir/$newfile" || { echo "FAILED to rename: $file"; exit 1; }`,
        `[ -e "$src" ] && { echo "FAILED: destination appeared concurrently; nothing was moved"; exit 1; }`,
        `echo "Renamed: $file -> $newfile"`,
      ].join("\n");
    },
  },

  {
    name: "trigger_sharesync_resync",
    description: "WRITE — Forces a ShareSync re-sync by restarting the SynologyDriveShareSync package via DSM WebAPI. Specify the folder or task name in the 'filter' parameter (informational only — all ShareSync tasks resume on restart). Requires DSM_USERNAME/DSM_PASSWORD in the container .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const folder = (input.filter as string | undefined)?.trim();
      if (!folder) throw new Error("trigger_sharesync_resync requires the ShareSync folder or task name in the 'filter' parameter.");
      return [
        `echo "=== Triggering ShareSync re-sync for folder: ${folder} ==="`,
        `echo "Restarting SynologyDriveShareSync to force full re-sync of all tasks"`,
        `echo ""`,
        buildDsmPackageRestart("SynologyDriveShareSync"),
      ].join("\n");
    },
  },

  // ── Phase 2: New remediation tools ───────────────────────────────────────────

  {
    name: "restart_synologand",
    description: "WRITE — Restarts the synologand daemon (core DSM package manager and hook dispatcher). Use when synologand is hung or consuming excessive CPU. DSM will automatically respawn it after kill.",
    write: true,
    params: { target },
    buildCommand: () => [
      "echo '=== SYNOLOGAND BEFORE RESTART ==='",
      "ps aux | grep synologand | grep -v grep | head -5",
      "echo ''",
      "echo '=== RESTARTING SYNOLOGAND (SIGTERM — DSM will respawn) ==='",
      "pkill -SIGTERM -x synologand 2>&1 && echo 'SIGTERM sent to synologand' || echo 'synologand not found running'",
      "echo ''",
      "echo '=== SYNOLOGAND AFTER RESTART (5s delay) ==='",
      "sleep 5",
      "ps aux | grep synologand | grep -v grep | head -5",
    ].join("\n"),
  },

  {
    name: "restart_invoked_related_services",
    description: "WRITE — Restarts the invoked daemon and esynoscheduler (DSM task scheduler). Use when scheduled tasks are not running or invoked is hung. DSM will respawn after kill.",
    write: true,
    params: { target },
    buildCommand: () => [
      "echo '=== INVOKED PROCESSES BEFORE RESTART ==='",
      "ps aux | grep -E 'invoked|esynoscheduler' | grep -v grep | head -10",
      "echo ''",
      "echo '=== RESTARTING invoked (SIGTERM) ==='",
      "pkill -SIGTERM -x invoked 2>&1 && echo 'SIGTERM sent to invoked' || echo 'invoked not found'",
      "echo '=== RESTARTING esynoscheduler (SIGTERM) ==='",
      "pkill -SIGTERM -x esynoscheduler 2>&1 && echo 'SIGTERM sent to esynoscheduler' || echo 'esynoscheduler not found'",
      "echo ''",
      "echo '=== PROCESSES AFTER RESTART (5s delay) ==='",
      "sleep 5",
      "ps aux | grep -E 'invoked|esynoscheduler' | grep -v grep | head -10",
    ].join("\n"),
  },

  {
    name: "restart_scheduler_services",
    description: "WRITE — Restarts crond. Use when scheduled tasks have stopped running and restart of invoked alone did not resolve it. DSM respawns crond automatically.",
    write: true,
    params: { target },
    buildCommand: () => [
      "echo '=== CROND BEFORE RESTART ==='",
      "ps aux | grep -E '\\bcrond?\\b' | grep -v grep | head -5",
      "echo ''",
      "echo '=== RESTARTING CROND (SIGTERM) ==='",
      "pkill -SIGTERM -x crond 2>&1 && echo 'SIGTERM sent to crond' || pkill -SIGTERM -x cron 2>&1 && echo 'SIGTERM sent to cron' || echo 'crond not found'",
      "echo ''",
      "echo '=== CROND AFTER RESTART (3s delay) ==='",
      "sleep 3",
      "ps aux | grep -E '\\bcrond?\\b' | grep -v grep | head -5",
    ].join("\n"),
  },

  {
    name: "restart_network_service_safe",
    description: "WRITE — Safely restarts a named Synology network service using synopkg or synoservice. Pass the service name in filter: smb, nfs, afp, ftp, ssh, rsync, or a package name like ContainerManager. Does NOT restart core network interfaces.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const svc = (input.filter as string | undefined)?.trim();
      if (!svc) throw new Error("restart_network_service_safe requires the service name in filter (e.g. smb, nfs, ssh).");
      const serviceMap: Record<string, string> = {
        smb: "smbd", samba: "smbd", nfs: "nfsd", afp: "afpd",
        ftp: "ftpd", ssh: "sshd", rsync: "rsyncd",
      };
      const mappedSvc = serviceMap[svc.toLowerCase()] || svc;
      return [
        `echo '=== RESTARTING NETWORK SERVICE: ${svc} ==='`,
        `echo ''`,
        `echo '--- trying synopkg restart ---'`,
        `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synopkg restart ${quote(svc)} 2>/dev/null && echo 'synopkg restart succeeded' || echo 'synopkg: not a DSM package or restart failed (gcompat required in nas-api image)'`,
        `echo ''`,
        `echo '--- trying pkill/respawn for service processes ---'`,
        `pkill -SIGTERM -x ${quote(mappedSvc)} 2>&1 && echo "SIGTERM sent to ${mappedSvc} (DSM will respawn)" || echo "${mappedSvc}: process not found"`,
        `echo ''`,
        `echo '=== SERVICE PROCESSES AFTER RESTART (2s delay) ==='`,
        `sleep 2`,
        `ps aux | grep -iE ${quote(svc)} | grep -v grep | head -10 || echo 'No matching processes found'`,
      ].join("\n");
    },
  },

  {
    name: "start_btrfs_scrub",
    description: "WRITE — Starts a Btrfs scrub on a volume to check data integrity. Pass the volume name (e.g. 'volume1') in filter, or leave empty to start scrub on all Btrfs volumes. Scrubs run in the background; use check_scrub_status to monitor progress.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const volumeFilter = (input.filter as string | undefined)?.trim();
      if (volumeFilter) {
        const vol = volumeFilter.replace(/^\//, "").replace(/^btrfs\//, "");
        const btrfsPath = `/btrfs/${vol}`;
        return [
          `echo '=== STARTING BTRFS SCRUB: ${btrfsPath} ==='`,
          `btrfs scrub start ${quote(btrfsPath)} 2>&1`,
          `echo ''`,
          `echo '=== SCRUB STATUS ==='`,
          `btrfs scrub status ${quote(btrfsPath)} 2>&1`,
        ].join("\n");
      }
      return [
        `echo '=== STARTING BTRFS SCRUB (all btrfs volumes) ==='`,
        `found=0`,
        `for v in /btrfs/volume[0-9]*; do`,
        `  [ -d "$v" ] || continue`,
        `  found=1`,
        `  echo "Starting scrub on $v"`,
        `  btrfs scrub start "$v" 2>&1`,
        `  echo ''`,
        `done 2>/dev/null`,
        `[ "$found" -eq 0 ] && echo 'No btrfs volumes found at /btrfs/volume* — deploy update required (see docker-compose.agent.yml)'`,
      ].join("\n");
    },
  },

  {
    name: "start_smart_test",
    description: "WRITE — Starts a SMART self-test on a specific disk. Pass test type and device in filter as 'short:/dev/sda' or 'long:/dev/sda'. Use check_smart_detail to see results after the test completes (short: ~2min, long: ~hours).",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const spec = (input.filter as string | undefined)?.trim();
      if (!spec) throw new Error("start_smart_test requires 'short:/dev/sda' or 'long:/dev/sda' in filter.");
      const colonIdx = spec.indexOf(":");
      const testType = spec.slice(0, colonIdx).trim();
      const device = spec.slice(colonIdx + 1).trim();
      if (!testType || !device) throw new Error("start_smart_test: filter must be 'short:/dev/sda' or 'long:/dev/sda'.");
      if (!["short", "long", "conveyance"].includes(testType)) {
        throw new Error("start_smart_test: test type must be 'short', 'long', or 'conveyance'.");
      }
      return [
        `echo '=== STARTING SMART ${testType.toUpperCase()} TEST: ${device} ==='`,
        `smartctl -t ${quote(testType)} ${quote(device)} 2>&1`,
        `echo ''`,
        `echo '=== CURRENT SELF-TEST LOG ==='`,
        `smartctl -l selftest ${quote(device)} 2>&1 | head -10`,
      ].join("\n");
    },
  },

  {
    name: "create_prechange_snapshot",
    description: "WRITE — Creates a read-only Btrfs snapshot of a volume as a recovery point before making changes. Pass the volume path (e.g. /volume1) in filter, or leave empty to snapshot all Btrfs volumes. Snapshot is named @prechange_{timestamp}.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const volumeFilter = (input.filter as string | undefined)?.trim();
      if (volumeFilter) {
        const volName = volumeFilter.replace(/^\/+/, "").replace(/^btrfs\//, "");
        const btrfsPath = `/btrfs/${volName}`;
        const qb = quote(btrfsPath);
        return [
          `echo '=== CREATING PRECHANGE SNAPSHOT: ${btrfsPath} ==='`,
          `ts=$(date +%Y%m%d_%H%M%S)`,
          `snap="${btrfsPath}/@prechange_\${ts}"`,
          `btrfs subvolume snapshot -r ${qb} "$snap" 2>&1 && echo "Snapshot created: $snap" || echo 'Snapshot FAILED — btrfs mount at /btrfs/volumeN needed (see docker-compose.agent.yml)'`,
        ].join("\n");
      }
      return [
        `echo '=== CREATING PRECHANGE SNAPSHOTS (all btrfs volumes) ==='`,
        `ts=$(date +%Y%m%d_%H%M%S)`,
        `found=0`,
        `for v in /btrfs/volume[0-9]*; do`,
        `  [ -d "$v" ] || continue`,
        `  found=1`,
        `  snap="$v/@prechange_$ts"`,
        `  echo "Snapshotting $v -> $snap"`,
        `  btrfs subvolume snapshot -r "$v" "$snap" 2>&1 && echo '  OK' || echo '  FAILED'`,
        `done 2>/dev/null`,
        `[ "$found" -eq 0 ] && echo 'No btrfs volumes found at /btrfs/volume* — deploy update required (see docker-compose.agent.yml)'`,
      ].join("\n");
    },
  },

  {
    name: "set_vm_overcommit_memory",
    description: "WRITE — Sets vm.overcommit_memory via sysctl. Use value 1 to allow overcommit (fixes invoked/synologand OOM conditions). Change is live immediately but not persistent across reboots. Pass value (0, 1, or 2) in filter.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const value = (input.filter as string | undefined)?.trim() || "1";
      if (!/^[012]$/.test(value)) throw new Error("set_vm_overcommit_memory: value must be 0, 1, or 2.");
      return [
        `echo '=== CURRENT vm.overcommit_memory ==='`,
        `sysctl vm.overcommit_memory 2>&1`,
        `echo ''`,
        `echo '=== SETTING vm.overcommit_memory=${value} ==='`,
        `sysctl -w vm.overcommit_memory=${value} 2>&1`,
        `echo ''`,
        `echo '=== VERIFY ==='`,
        `sysctl vm.overcommit_memory 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "persist_vm_overcommit_memory",
    description: "WRITE — Persists the vm.overcommit_memory sysctl setting across reboots by writing to /etc/sysctl.conf on the NAS host. Run after set_vm_overcommit_memory to make the change survive a reboot. Pass value in filter (default: 1).",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const value = (input.filter as string | undefined)?.trim() || "1";
      if (!/^[012]$/.test(value)) throw new Error("persist_vm_overcommit_memory: value must be 0, 1, or 2.");
      return [
        `echo '=== CURRENT vm.overcommit_memory ENTRIES IN sysctl.conf ==='`,
        `grep -n 'vm.overcommit_memory' /host/etc/sysctl.conf 2>/dev/null || echo '(none found)'`,
        `echo '=== WRITING SETTING ==='`,
        `sed -i '/vm\\.overcommit_memory/d' /host/etc/sysctl.conf 2>&1`,
        `echo "vm.overcommit_memory=${value}" >> /host/etc/sysctl.conf`,
        `echo '=== VERIFY (sysctl.conf) ==='`,
        `grep 'vm.overcommit_memory' /host/etc/sysctl.conf`,
        `echo '=== VERIFY (live kernel) ==='`,
        `sysctl vm.overcommit_memory 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "set_io_scheduler",
    description: "WRITE — Changes the I/O scheduler for a block device. mq-deadline is recommended for HDDs and RAID arrays (reduces seek storms, prioritises latency). none or mq-deadline for SSDs. Pass filter as 'device scheduler', e.g. 'sda mq-deadline' or 'md0 mq-deadline'. Not persistent across reboots.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("set_io_scheduler: pass filter as 'device scheduler', e.g. 'sda mq-deadline'.");
      const parts = raw.split(/\s+/);
      if (parts.length !== 2) throw new Error("set_io_scheduler: filter must be exactly two words: device then scheduler.");
      const [device, scheduler] = parts;
      if (!/^[a-z0-9]+$/.test(device)) throw new Error("set_io_scheduler: invalid device name — use e.g. sda, md0, nvme0n1.");
      const valid = ["none", "noop", "mq-deadline", "deadline", "cfq", "bfq", "kyber"];
      if (!valid.includes(scheduler)) throw new Error(`set_io_scheduler: scheduler must be one of: ${valid.join(", ")}.`);
      return [
        `echo '=== CURRENT SCHEDULER FOR ${device} ==='`,
        `cat /host/sys/block/${device}/queue/scheduler 2>/dev/null || cat /sys/block/${device}/queue/scheduler 2>/dev/null || echo 'device not found'`,
        `echo ''`,
        `echo '=== SETTING ${device} scheduler → ${scheduler} ==='`,
        `{ echo ${scheduler} > /host/sys/block/${device}/queue/scheduler 2>/dev/null && echo 'Written to /host/sys'; } || { echo ${scheduler} > /sys/block/${device}/queue/scheduler 2>/dev/null && echo 'Written to /sys'; } || { echo "Failed — device ${device} not found or scheduler ${scheduler} not supported"; exit 1; }`,
        `echo ''`,
        `echo '=== VERIFY ==='`,
        `cat /host/sys/block/${device}/queue/scheduler 2>/dev/null || cat /sys/block/${device}/queue/scheduler 2>/dev/null`,
        `echo ''`,
        `echo 'Note: not persistent across reboots.'`,
      ].join("\n");
    },
  },

  {
    name: "set_vm_dirty_ratios",
    description: "WRITE — Tunes vm.dirty_ratio and vm.dirty_background_ratio via sysctl. Lowering these forces dirty pages to flush more aggressively, smoothing out iowait spikes from large write bursts. Default Linux values: dirty_ratio=20 dirty_background_ratio=10. Recommended for NAS: 5 and 3. Pass as 'dirty_ratio=N dirty_background_ratio=M' in filter. Not persistent across reboots.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim() ?? "dirty_ratio=5 dirty_background_ratio=3";
      const drMatch = raw.match(/dirty_ratio=(\d+)/);
      const dbrMatch = raw.match(/dirty_background_ratio=(\d+)/);
      if (!drMatch && !dbrMatch) throw new Error("set_vm_dirty_ratios: filter must contain dirty_ratio=N and/or dirty_background_ratio=M.");
      const dr = drMatch ? parseInt(drMatch[1], 10) : null;
      const dbr = dbrMatch ? parseInt(dbrMatch[1], 10) : null;
      if (dr !== null && (dr < 1 || dr > 80)) throw new Error("set_vm_dirty_ratios: dirty_ratio must be 1–80.");
      if (dbr !== null && (dbr < 1 || dbr > 50)) throw new Error("set_vm_dirty_ratios: dirty_background_ratio must be 1–50.");
      if (dr !== null && dbr !== null && dbr >= dr) throw new Error("set_vm_dirty_ratios: dirty_background_ratio must be less than dirty_ratio.");
      const cmds = [
        `echo '=== CURRENT DIRTY PAGE SETTINGS ==='`,
        `sysctl vm.dirty_ratio vm.dirty_background_ratio vm.dirty_expire_centisecs vm.dirty_writeback_centisecs 2>&1`,
        `echo ''`,
        `echo '=== APPLYING CHANGES ==='`,
      ];
      if (dr !== null) cmds.push(`sysctl -w vm.dirty_ratio=${dr} 2>&1`);
      if (dbr !== null) cmds.push(`sysctl -w vm.dirty_background_ratio=${dbr} 2>&1`);
      cmds.push(`echo ''`, `echo '=== VERIFY ==='`, `sysctl vm.dirty_ratio vm.dirty_background_ratio 2>&1`, `echo 'Note: not persistent across reboots.'`);
      return cmds.join("\n");
    },
  },

  {
    name: "set_ionice",
    description: "WRITE — Changes a process's I/O scheduling class via ionice. Allowed classes: 2=best-effort (normal; pass optional priority 0-7 where 0=highest, 7=lowest), 3=idle (runs I/O only when no other process needs the disk). Class 1 (realtime) is not permitted. Use to deprioritize a heavy background process (indexer, backup daemon) crowding out foreground I/O. Pass filter as 'PID class [priority]', e.g. '1234 3' or '1234 2 6'.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("set_ionice: pass filter as 'PID class [priority]', e.g. '1234 3' or '1234 2 6'.");
      const parts = raw.split(/\s+/);
      const pid = parts[0];
      const cls = parts[1];
      const prio = parts[2];
      if (!pid || !/^\d+$/.test(pid)) throw new Error("set_ionice: first field must be a numeric PID.");
      if (!cls || !["2", "3"].includes(cls)) throw new Error("set_ionice: class must be 2 (best-effort) or 3 (idle). Class 1 (realtime) is not permitted — it would give the process unconditional disk priority.");
      if (prio !== undefined && !/^[0-7]$/.test(prio)) throw new Error("set_ionice: priority must be 0–7 (0=highest within class, 7=lowest).");
      const clsLabel: Record<string, string> = { "2": "best-effort", "3": "idle" };
      const prioArg = (cls === "2" && prio !== undefined) ? `-n ${prio}` : "";
      return [
        `echo '=== CURRENT STATE ==='`,
        `ps -p ${pid} -o pid,stat,comm,args 2>/dev/null | head -3 || echo 'PID ${pid} not found'`,
        `echo -n 'current ionice: '; ionice -p ${pid} 2>/dev/null || echo 'n/a'`,
        `echo ''`,
        `echo '=== APPLYING: class=${cls} (${clsLabel[cls]})${prio !== undefined ? ` priority=${prio}` : ""} ==='`,
        `ionice -c ${cls} ${prioArg} -p ${pid} 2>&1 && echo 'Applied' || echo 'Failed'`,
        `echo ''`,
        `echo '=== VERIFY ==='`,
        `echo -n 'new ionice: '; ionice -p ${pid} 2>/dev/null || echo 'n/a'`,
      ].join("\n");
    },
  },

  {
    name: "set_inotify_watches",
    description:
      "WRITE — Raises the Linux inotify limits (fs.inotify.max_user_watches and fs.inotify.max_user_instances) live via sysctl AND persists them to /etc/sysctl.conf so they survive a reboot. The default max_user_watches=8192 is far too low for a containerized seaf-cli worktree with hundreds of thousands of directories: the shared root inotify pool is exhausted, the worktree monitor goes blind, and seaf-cli silently reports 'synchronized' while the worktree has diverged. Pass filter as 'WATCHES' or 'WATCHES INSTANCES' (e.g. '1048576' or '1048576 1024'). Defaults: watches=1048576, instances=1024. Each watch pins ~1 KiB of non-swappable kernel RAM (so 1048576 ≈ up to 1 GiB worst case, only allocated per watch actually held). After running this, restart the seaf-cli daemon so it re-registers watches, then confirm 0 'No space left on device' errors in its log.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim() || "1048576 1024";
      const parts = raw.split(/\s+/);
      const watches = Number(parts[0]);
      const instances = parts[1] !== undefined ? Number(parts[1]) : 1024;
      if (!Number.isInteger(watches) || watches < 8192 || watches > 4194304) {
        throw new Error(
          "set_inotify_watches: watches must be an integer 8192–4194304. The 4M cap bounds pinned kernel memory (~1 KiB/watch).",
        );
      }
      if (!Number.isInteger(instances) || instances < 128 || instances > 8192) {
        throw new Error("set_inotify_watches: instances must be an integer 128–8192.");
      }
      return [
        `echo '=== CURRENT (live kernel) ==='`,
        `sysctl fs.inotify.max_user_watches fs.inotify.max_user_instances 2>&1`,
        `echo ''`,
        `echo '=== SETTING live: watches=${watches} instances=${instances} ==='`,
        `sysctl -w fs.inotify.max_user_watches=${watches} 2>&1`,
        `sysctl -w fs.inotify.max_user_instances=${instances} 2>&1`,
        `echo ''`,
        `echo '=== PERSISTING to /etc/sysctl.conf ==='`,
        `grep -n 'fs.inotify.max_user_watches\\|fs.inotify.max_user_instances' /host/etc/sysctl.conf 2>/dev/null || echo '(no prior inotify entries)'`,
        `sed -i '/fs\\.inotify\\.max_user_watches/d;/fs\\.inotify\\.max_user_instances/d' /host/etc/sysctl.conf 2>&1`,
        `echo "fs.inotify.max_user_watches=${watches}" >> /host/etc/sysctl.conf`,
        `echo "fs.inotify.max_user_instances=${instances}" >> /host/etc/sysctl.conf`,
        `echo '=== VERIFY (sysctl.conf) ==='`,
        `grep 'fs.inotify' /host/etc/sysctl.conf`,
        `echo '=== VERIFY (live kernel) ==='`,
        `sysctl fs.inotify.max_user_watches fs.inotify.max_user_instances 2>&1`,
        `echo 'NOTE: restart the seaf-cli daemon so it re-registers watches across the whole worktree.'`,
      ].join("\n");
    },
  },

  {
    name: "write_seafile_ignore",
    description:
      "WRITE (tier 3) — Writes a standard seafile-ignore.txt (the exact filename seaf-cli reads; .seafile-ignore is NOT recognized) into a seaf-cli worktree/library root so the client stops syncing Synology junk: @eaDir thumbnails, #recycle, #snapshot, @tmp, .DS_Store, Thumbs.db, *@SynoEAStream / *@SynoResource (Synology extended-attribute/resource-fork sidecars), *.tmp. Pass the worktree root in filter, either as a /volume1/... path (auto-mapped to the nas-api /btrfs writable mount) or directly as /btrfs/volume1/.... Known edgesynology1 seaf-cli roots: '/volume1/mac/Art Library', '/volume1/mac/Decor/Character Licensed', '/volume1/mac/Decor/Generic Decor', '/volume1/styleguides'. NOTE: this only stops FUTURE upload of matching files — it does not delete copies already on the Seafile server, and it does not by itself fix inotify watch exhaustion (use set_inotify_watches for that).",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      let p = (input.filter as string | undefined)?.trim();
      if (!p) throw new Error("write_seafile_ignore: filter must be the absolute worktree root path.");
      if (p.includes("..")) throw new Error("write_seafile_ignore: path must not contain '..'.");
      // Map to the nas-api writable Btrfs mount; per-share /volumeN mounts are read-only.
      if (p.startsWith("/btrfs/volume")) {
        // already the writable mount
      } else if (/^\/volume\d+\//.test(p)) {
        p = "/btrfs" + p;
      } else {
        throw new Error("write_seafile_ignore: path must be under /volume1/ (or /btrfs/volume1/).");
      }
      const dir = p.replace(/\/+$/, "");
      const q = quote(dir);
      const file = quote(dir + "/seafile-ignore.txt");
      const patterns = ["@eaDir", "#recycle", "#snapshot", "@tmp", ".DS_Store", "Thumbs.db", "*@SynoEAStream", "*@SynoResource", "*.tmp"];
      const printfArgs = patterns.map((x) => quote(x)).join(" ");
      return [
        `echo '=== TARGET WORKTREE ROOT ==='`,
        `[ -d ${q} ] || { echo "ERROR: not a directory: ${dir}"; exit 1; }`,
        `ls -la ${file} 2>/dev/null && echo '(existing ignore file will be OVERWRITTEN)' || echo '(no existing ignore file)'`,
        `echo '=== WRITING seafile-ignore.txt ==='`,
        `printf '%s\\n' ${printfArgs} > ${file}`,
        `echo '=== VERIFY ==='`,
        `cat ${file}`,
      ].join("\n");
    },
  },

  {
    name: "clear_package_lockfiles",
    description: "WRITE — Removes stale lock files for a named DSM package that are preventing it from starting or updating. Pass the package name in filter (e.g. 'SynologyDrive'). Lists all lock files found before removing them.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const pkg = (input.filter as string | undefined)?.trim();
      if (!pkg) throw new Error("clear_package_lockfiles: filter must be a package name (e.g. 'SynologyDrive').");
      if (!/^[A-Za-z0-9_\-]+$/.test(pkg)) throw new Error("clear_package_lockfiles: invalid package name.");
      const q = quote(pkg);
      return [
        `echo '=== LOCK FILES FOUND ==='`,
        `find /host/var/packages/${q} /host/tmp /host/run -name '*.lock' -o -name '*.pid' 2>/dev/null | head -40`,
        `echo '=== REMOVING LOCK FILES ==='`,
        `find /host/var/packages/${q} /host/tmp /host/run -name '*.lock' 2>/dev/null -exec rm -v {} \\;`,
        `echo '=== DONE ==='`,
      ].join("\n");
    },
  },

  {
    name: "quarantine_path",
    description: "WRITE (tier 3) — Renames an exact /volumeN path by appending .quarantine.{timestamp} to isolate it without deleting it. Uses the nas-api writable /btrfs mount, refuses an existing destination, and asks for approval first.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("quarantine_path: filter must be an absolute path.");
      const p = toWritableVolumePath(raw, "quarantine_path");
      const q = quote(p);
      return [
        `src=${q}`,
        `[ -e "$src" ] || { echo "ERROR: no such path: $src"; exit 1; }`,
        `ts=$(date +%Y%m%d_%H%M%S)`,
        `dest="$src.quarantine.$ts"`,
        `[ -e "$dest" ] && { echo "ERROR: destination already exists: $dest"; exit 1; }`,
        `mv -n ${q} "$dest" || { echo "FAILED to quarantine: $src"; exit 1; }`,
        `[ -e "$src" ] && { echo "FAILED: destination appeared concurrently; nothing was moved"; exit 1; }`,
        `echo "Quarantined successfully: $dest"`,
      ].join("\n");
    },
  },

  // Ownership repair resolves NAS principal names from the host reference files,
  // then passes numeric ids to chown. It never replaces the container's own account
  // database. Operator-facing /volumeN paths are mapped to the only writable mount,
  // /btrfs/volumeN. Recursion is deliberately rejected: an unbounded chown across a
  // live SMB share needs a separate, count-bounded capability and approval contract.
  {
    name: "repair_path_ownership",
    description: "WRITE (tier 3) — Changes ownership of one exact /volumeN path. Pass 'owner:group' in filter; names are resolved from the NAS account files and numeric ids are accepted. Recursion is refused. Shows logical and writable paths, current ACL/ownership, and verifies the result after approval.",
    write: true,
    params: { target, filter, exactPath },
    buildCommand: (input) => {
      const logicalPath = (input.exactPath as string | undefined)?.trim();
      if (!logicalPath) throw new Error("repair_path_ownership: exactPath is required.");
      const writablePath = toWritableVolumePath(logicalPath, "repair_path_ownership");
      const f = (input.filter as string | undefined)?.trim() || "";
      if (f.startsWith("recursive:")) throw new Error("repair_path_ownership: recursive ownership changes are disabled; repair one exact path at a time.");
      const ownerGroup = f;
      if (!/^[A-Za-z0-9_\-]+:[A-Za-z0-9_\-]+$/.test(ownerGroup)) throw new Error("repair_path_ownership: filter must be 'owner:group'.");
      const [owner, group] = ownerGroup.split(":");
      const qp = quote(writablePath);
      return [
        `path=${qp}`,
        `owner=${quote(owner)}`,
        `group=${quote(group)}`,
        `echo ${quote(`Logical path: ${logicalPath}`)}`,
        `echo ${quote(`Writable path: ${writablePath}`)}`,
        `[ -e "$path" ] || { echo "ERROR: no such path: $path"; exit 1; }`,
        `[ ! -L "$path" ] || { echo "ERROR: symbolic links are refused: $path"; exit 1; }`,
        `[ -r /host/etc/pass?? ] || { echo "ERROR: NAS user database is not mounted under /host/etc"; exit 1; }`,
        `[ -r /host/etc/group ] || { echo "ERROR: NAS group database is not mounted at /host/etc/group (apply the compose update on this NAS)"; exit 1; }`,
        `case "$owner" in *[!0-9]*) uid=$(awk -F: -v n="$owner" '$1==n{print $3; exit}' /host/etc/pass??);; *) uid=$owner;; esac`,
        `case "$group" in *[!0-9]*) gid=$(awk -F: -v n="$group" '$1==n{print $3; exit}' /host/etc/group);; *) gid=$group;; esac`,
        `[ -n "$uid" ] || { echo "ERROR: user '$owner' not found in NAS user database"; exit 1; }`,
        `[ -n "$gid" ] || { echo "ERROR: group '$group' not found in NAS group database"; exit 1; }`,
        `current=$(stat -c '%u:%g' "$path") || exit 1`,
        `echo "Current ownership: $current"`,
        `echo "Requested ownership: $owner:$group ($uid:$gid)"`,
        `echo '=== ACL MODE ==='`,
        // Capture synoacltool's own exit status. A `... | head -8 || echo WARNING`
        // pipeline reports head's status (0), so the warning could never fire and a
        // failed ACL read passed silently — see the § 12 note. Assign-then-test so a
        // failure is actually surfaced before the write.
        `acl_out=$(LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get "$path" 2>&1); acl_rc=$?`,
        `if [ "$acl_rc" -eq 0 ]; then printf '%s\\n' "$acl_out" | head -8; else echo "WARNING: ACL mode could not be read (synoacltool exit $acl_rc): $acl_out"; fi`,
        `chown "$uid:$gid" ${qp} || { echo "FAILED: chown returned an error"; exit 1; }`,
        `actual=$(stat -c '%u:%g' "$path") || exit 1`,
        `[ "$actual" = "$uid:$gid" ] || { echo "FAILED: ownership is $actual after chown; expected $uid:$gid"; exit 1; }`,
        `echo "VERIFIED: ownership is $actual"`,
      ].join("\n");
    },
  },

  // repair_path_acl (setfacl-based) was removed on 2026-07-16: it could never
  // have worked. Neither getfacl nor setfacl is installed in the nas-api image
  // (see apps/nas-api/Dockerfile — no `acl` package) or anywhere on the host
  // PATH, verified live on edgesynology1, so the tool could only ever print
  // "setfacl: command not found" while reporting a tier-3 approved write.
  //
  // Installing the `acl` package would not have rescued it: /volume1 is mounted
  // `synoacl`, not `acl` (verified on edgesynology1), so POSIX ACL calls are not
  // what this filesystem enforces. DSM's synoacltool is the native surface.
  //
  // It was not re-pointed at synoacltool because that is a different capability,
  // not a port — the POSIX 'u:user:rwx' spec this tool took has no meaning there.
  // Reading ACLs already works and is unaffected: inspect_path_acl and
  // inspect_effective_permissions call `synoacltool -get`.
  //
  // To add an ACL write later, the live contract (edgesynology1, DSM 7) is:
  //   synoacltool -add PATH [ACL Entry]                 e.g. user:mac:allow:rwxpdDaARWc--:fd--
  //   synoacltool -replace PATH [ACL Entry Index] [ACL Entry]
  //   synoacltool -del PATH [ACL Entry Index]
  // run it under LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib, and
  // route the path through /btrfs/volume1/<share> — the per-share /volumeN mounts
  // are ro (see write_seafile_ignore for the mapping precedent). Validate the
  // entry format on a scratch path first: a wrong ACE can lock SMB users out, and
  // a share may be in POSIX mode anyway (`-get` answers "It's Linux mode"), in
  // which case ownership/mode — not an ACE — is what to fix. The validator keeps
  // setfacl and synoacltool gated meanwhile, so hand-written run_command ACL
  // writes still require approval.

  // ── Phase 3: Recovery / Restoration write tools ─────────────────────────

  {
    name: "restore_path_from_snapshot",
    description: "WRITE (tier 3) — Restores a file or directory from a Btrfs snapshot through the writable /btrfs mount. Pass 'snapshot_path|dest_path'. Does not overwrite and verifies the destination.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "";
      const parts = f.split("|");
      if (parts.length !== 2) throw new Error("restore_path_from_snapshot: filter must be 'snapshot_path|dest_path'.");
      const [rawSrc, rawDst] = parts.map(s => s.trim());
      const src = toWritableVolumePath(rawSrc, "restore_path_from_snapshot source");
      const dst = toWritableVolumePath(rawDst, "restore_path_from_snapshot destination");
      const qs = quote(src);
      const qd = quote(dst);
      return [
        `echo '=== SOURCE (snapshot) ==='`,
        `[ -e ${qs} ] || { echo "ERROR: source does not exist"; exit 1; }`,
        `echo '=== DESTINATION ==='`,
        `ls -la ${qd} 2>/dev/null && echo "EXISTS — refusing to overwrite" && exit 1 || echo "(does not exist — safe to restore)"`,
        `echo '=== RESTORING ==='`,
        `cp -a ${qs} ${qd} 2>&1 || { echo "FAILED to restore"; exit 1; }`,
        `echo '=== VERIFY ==='`,
        `ls -la ${qd} 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "restore_from_recycle_bin",
    description: "WRITE (tier 3) — Restores a file from #recycle through the writable /btrfs mount. Pass 'recycle_path|dest_path'. Does not overwrite and verifies the destination.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "";
      const parts = f.split("|");
      if (parts.length !== 2) throw new Error("restore_from_recycle_bin: filter must be 'recycle_path|dest_path'.");
      const [rawSrc, rawDst] = parts.map(s => s.trim());
      if (!rawSrc.split("/").includes("#recycle")) throw new Error("restore_from_recycle_bin: source path must include a #recycle component.");
      const src = toWritableVolumePath(rawSrc, "restore_from_recycle_bin source");
      const dst = toWritableVolumePath(rawDst, "restore_from_recycle_bin destination");
      const qs = quote(src);
      const qd = quote(dst);
      return [
        `echo '=== SOURCE (recycle bin) ==='`,
        `[ -e ${qs} ] || { echo "ERROR: source does not exist"; exit 1; }`,
        `echo '=== DESTINATION CHECK ==='`,
        `ls -la ${qd} 2>/dev/null && echo "EXISTS — refusing to overwrite" && exit 1 || echo "(does not exist — safe to restore)"`,
        `echo '=== RESTORING ==='`,
        `mv -n ${qs} ${qd} 2>&1 || { echo "FAILED to restore"; exit 1; }`,
        `[ -e ${qs} ] && { echo "FAILED: destination appeared concurrently; nothing was moved"; exit 1; }`,
        `echo '=== VERIFY ==='`,
        `ls -la ${qd} 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "generate_support_bundle",
    description: "WRITE — Generates a DSM support bundle (synosupportd or synologand support-collect) and saves it to /tmp. Returns the path so it can be retrieved with fetch_support_artifacts or fetch_log_file.",
    write: true,
    params: { target },
    buildCommand: (_input) => {
      return [
        `echo '=== GENERATING DSM SUPPORT BUNDLE ==='`,
        `out=/tmp/support_bundle_$(date +%Y%m%d_%H%M%S)`,
        `mkdir -p "$out"`,
        `if command -v synosupportd >/dev/null 2>&1; then`,
        `  synosupportd collect --output "$out" 2>&1 && echo "synosupportd: OK" || echo "synosupportd: FAILED"`,
        `elif command -v synologand >/dev/null 2>&1; then`,
        `  synologand --support-collect --output "$out" 2>&1 && echo "synologand: OK" || echo "synologand: FAILED"`,
        `else`,
        `  echo "No support bundle tool found; collecting manually..."`,
        `  dmesg > "$out/dmesg.txt" 2>&1`,
        `  cat /proc/mdstat > "$out/mdstat.txt" 2>/dev/null`,
        `  journalctl -n 2000 --no-pager > "$out/journal.txt" 2>/dev/null`,
        `  cp /var/log/messages "$out/" 2>/dev/null`,
        `fi`,
        `echo '=== BUNDLE LOCATION ==='`,
        `ls -lh "$out"`,
        `echo "Path: $out"`,
      ].join("\n");
    },
  },

  // ── DSM WebAPI: backup and scheduled task control ───────────────────────

  {
    name: "trigger_backup_task",
    description: "WRITE — Triggers an immediate run of a HyperBackup task via DSM WebAPI. Pass the task ID (integer from check_backup_status) in filter. Requires DSM_USERNAME/DSM_PASSWORD in .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const taskId = (input.filter as string | undefined)?.trim();
      if (!taskId) throw new Error("trigger_backup_task: filter must be the HyperBackup task ID (integer from check_backup_status).");
      if (!/^\d+$/.test(taskId)) throw new Error("trigger_backup_task: task ID must be a positive integer.");
      return buildDsmApiCall(
        "SYNO.Backup.Task", 1, "run",
        [`--data-urlencode "taskId=${taskId}"`],
        `Triggering HyperBackup task ${taskId}`,
      );
    },
  },

  {
    name: "run_scheduled_task",
    description: "WRITE — Triggers an immediate run of a DSM scheduled task via DSM WebAPI. Pass the task ID (integer from check_scheduled_tasks) in filter. Requires DSM_USERNAME/DSM_PASSWORD in .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const taskId = (input.filter as string | undefined)?.trim();
      if (!taskId) throw new Error("run_scheduled_task: filter must be the scheduled task ID (integer from check_scheduled_tasks).");
      if (!/^\d+$/.test(taskId)) throw new Error("run_scheduled_task: task ID must be a positive integer.");
      return buildDsmApiCall(
        "SYNO.Core.TaskScheduler", 4, "run_now",
        [`--data-urlencode "id=${taskId}"`],
        `Running scheduled task ${taskId}`,
      );
    },
  },

  {
    name: "enable_scheduled_task",
    description: "WRITE — Enables a disabled DSM scheduled task via DSM WebAPI. Pass the task ID (integer from check_scheduled_tasks) in filter. Requires DSM_USERNAME/DSM_PASSWORD in .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const taskId = (input.filter as string | undefined)?.trim();
      if (!taskId) throw new Error("enable_scheduled_task: filter must be the scheduled task ID (integer from check_scheduled_tasks).");
      if (!/^\d+$/.test(taskId)) throw new Error("enable_scheduled_task: task ID must be a positive integer.");
      return buildDsmApiCall(
        "SYNO.Core.TaskScheduler", 4, "enable",
        [`--data-urlencode "id=${taskId}"`],
        `Enabling scheduled task ${taskId}`,
      );
    },
  },

  {
    name: "disable_scheduled_task",
    description: "WRITE — Disables a DSM scheduled task via DSM WebAPI. Use to suppress a runaway or broken task without deleting it. Pass the task ID (integer from check_scheduled_tasks) in filter. Requires DSM_USERNAME/DSM_PASSWORD in .env. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const taskId = (input.filter as string | undefined)?.trim();
      if (!taskId) throw new Error("disable_scheduled_task: filter must be the scheduled task ID (integer from check_scheduled_tasks).");
      if (!/^\d+$/.test(taskId)) throw new Error("disable_scheduled_task: task ID must be a positive integer.");
      return buildDsmApiCall(
        "SYNO.Core.TaskScheduler", 4, "disable",
        [`--data-urlencode "id=${taskId}"`],
        `Disabling scheduled task ${taskId}`,
      );
    },
  },

  // ── Phase 4: Task cancellation tools ────────────────────────────────────

  {
    name: "cancel_smart_test",
    description: "WRITE — Cancels an in-progress SMART self-test on a specific disk. Pass the device name (e.g. 'sda') in filter. Use check_smart_test_progress first to confirm a test is running.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const dev = (input.filter as string | undefined)?.trim();
      if (!dev) throw new Error("cancel_smart_test: filter must be a device name (e.g. 'sda').");
      if (!/^[a-z]{1,10}$/.test(dev)) throw new Error("cancel_smart_test: invalid device name.");
      const q = quote(dev);
      return [
        `echo '=== CURRENT SMART TEST STATUS ==='`,
        `smartctl -a /dev/${q} 2>&1 | grep -A5 'Self-test execution status'`,
        `echo '=== CANCELLING ==='`,
        `smartctl -X /dev/${q} 2>&1 && echo "OK: test cancelled" || echo "FAILED or no test running"`,
        `echo '=== VERIFY ==='`,
        `smartctl -a /dev/${q} 2>&1 | grep -A5 'Self-test execution status'`,
      ].join("\n");
    },
  },

  {
    name: "cancel_btrfs_scrub",
    description: "WRITE — Cancels an in-progress Btrfs scrub on a volume. Pass the volume name (e.g. 'volume1') in filter. Use check_scrub_status first to confirm a scrub is running.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const mp = (input.filter as string | undefined)?.trim();
      if (!mp) throw new Error("cancel_btrfs_scrub: filter must be a volume name (e.g. 'volume1').");
      if (!/^volume[0-9]+$/.test(mp)) throw new Error("cancel_btrfs_scrub: filter must be a bare volume name like 'volume1'.");
      const btrfsPath = `/btrfs/${mp}`;
      const q = quote(btrfsPath);
      return [
        `echo '=== CURRENT SCRUB STATUS ==='`,
        `btrfs scrub status ${q} 2>&1`,
        `echo '=== CANCELLING ==='`,
        `btrfs scrub cancel ${q} 2>&1 && echo "OK: scrub cancelled" || echo "FAILED or no scrub running"`,
        `echo '=== VERIFY ==='`,
        `btrfs scrub status ${q} 2>&1`,
      ].join("\n");
    },
  },


  {
    name: "kill_process",
    description:
      "WRITE — Kills one or more processes by PID using SIGKILL (-9). Pass a space-separated list of PIDs in filter (e.g. '32459 9223'). Always shows what will be killed and asks for approval before acting.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const raw = (input.filter as string | undefined)?.trim();
      if (!raw) throw new Error("kill_process: pass one or more PIDs in filter (space-separated).");
      const pids = raw.split(/\s+/).filter(Boolean);
      if (pids.some((p) => !/^\d+$/.test(p))) throw new Error("kill_process: filter must contain only numeric PIDs separated by spaces.");
      return [
        `echo '=== PROCESSES BEFORE KILL ==='`,
        `ps -p ${pids.join(",")} -o pid,ppid,etime,cmd 2>/dev/null || echo '(some PIDs may not exist)'`,
        `echo '=== SENDING SIGKILL ==='`,
        ...pids.map((pid) => `kill -9 ${pid} 2>&1 && echo "killed ${pid}" || echo "failed or already gone: ${pid}"`),
        `echo '=== VERIFY ==='`,
        `ps -p ${pids.join(",")} -o pid,cmd 2>/dev/null || echo 'all target processes gone'`,
      ].join("\n");
    },
  },

  {
    name: "run_privileged_command",
    description:
      "WRITE — Runs a single privileged shell command on the NAS. Strictly whitelisted to: synopkg restart/start/stop <package> and docker stop/start <container>. Pass the full command in filter. Always shows a preview and asks for your approval before running.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const cmd = (input.filter as string | undefined)?.trim();
      if (!cmd) throw new Error("run_privileged_command: pass the command to run in filter.");
      const allowed = [
        /^synopkg (restart|start|stop) [a-zA-Z0-9_-]+$/,
        /^docker stop [a-zA-Z0-9_-]+$/,
        /^docker start [a-zA-Z0-9_-]+$/,
      ];
      if (!allowed.some((re) => re.test(cmd))) {
        throw new Error(`run_privileged_command: command not in allowlist: "${cmd}". Allowed: insmod, mknod, mkdir /dev/net, chmod /dev/net/tun, synopkg, docker stop/start/rm, synoservice.`);
      }
      return [
        `echo '=== COMMAND PREVIEW ==='`,
        `echo ${JSON.stringify(cmd)}`,
        `echo '=== EXECUTING ==='`,
        cmd,
        `echo "exit_code=$?"`,
      ].join("\n");
    },
  },

  // ─── Archive file-inventory (native job tools — dispatch to nas-api /jobs) ─────
  // These do NOT build a shell command; the MCP server routes them through
  // job-client.ts to the nas-api /jobs/inventory/* REST endpoints. Allowlisted
  // shares are validated server-side by nas-api (jobs.AllowedShares); the list
  // is mirrored in deploy/synology/docker-compose.agent.yml and the web
  // ARCHIVE_SHARES constant.
  {
    name: "start_file_inventory",
    description:
      "WRITE — Starts a read-only file inventory on a NAS: walks the selected shared folders and reports file counts/bytes by modified year, archive-candidate cutoffs, empty-directory counts, and (optionally) a Synology Drive/ShareSync recent-activity overlay. It does NOT move, delete, or modify any files, but the metadata walk may run for HOURS on large shares, so it requires confirmation. Returns immediately with a job id; poll get_file_inventory_status and fetch results with fetch_file_inventory_result. Call again with confirmed: true to start.",
    write: true,
    job: { op: "start" },
    params: {
      target,
      shares: archiveSharesParam,
      cutoff_years: cutoffYearsParam,
      overlay: overlayParam,
      protect_newer_than: protectNewerThanParam,
      max_files_per_second: maxFilesPerSecParam,
      use_idle_io_priority: useIdleIoParam,
      sleep_every_files: sleepEveryFilesParam,
      sleep_ms: sleepMsParam,
    },
  },
  {
    name: "schedule_file_inventory",
    description:
      "WRITE — Schedules a future one-shot read-only file inventory (same scan as start_file_inventory) to run at a given time, e.g. during quiet hours. Requires scheduled_for as an RFC3339 UTC timestamp in the future. Call again with confirmed: true to schedule.",
    write: true,
    job: { op: "schedule" },
    params: {
      target,
      shares: archiveSharesParam,
      scheduled_for: z
        .string()
        .describe("When to run, as an RFC3339 UTC timestamp in the future, e.g. 2026-06-08T02:00:00Z."),
      cutoff_years: cutoffYearsParam,
      overlay: overlayParam,
      protect_newer_than: protectNewerThanParam,
      max_files_per_second: maxFilesPerSecParam,
      use_idle_io_priority: useIdleIoParam,
      sleep_every_files: sleepEveryFilesParam,
      sleep_ms: sleepMsParam,
    },
  },
  {
    name: "get_file_inventory_status",
    description:
      "Read the status/progress of file-inventory jobs on a NAS. Pass job_id for one job (status, progress, result availability, overlay notes); omit job_id to list recent jobs (newest first), including scheduled ones.",
    write: false,
    job: { op: "status" },
    params: {
      target,
      job_id: z.string().optional().describe("Inventory job id. Omit to list recent jobs."),
    },
  },
  {
    name: "fetch_file_inventory_result",
    description:
      "Fetch a completed inventory's results as bounded CSV rows. result selects which report: 'yearly' (file count + bytes per modified year), 'cutoff' (archive-candidate vs date-protected totals per cutoff year), 'dirs' (total + empty directory counts), or 'overlay' (recent Drive/ShareSync activity). Use limit/cursor to page; responses are capped so they never flood the context.",
    write: false,
    job: { op: "result" },
    params: {
      target,
      job_id: z.string().describe("Inventory job id to fetch results for."),
      result: z
        .enum(["yearly", "cutoff", "dirs", "overlay"])
        .optional()
        .describe("Which report to fetch. Default: yearly."),
      limit: z.number().int().optional().describe("Max rows to return (default 1000, max 5000)."),
      cursor: z.number().int().optional().describe("Row offset for pagination (from a prior response's next_cursor)."),
    },
  },
  {
    name: "cancel_file_inventory",
    description:
      "WRITE — Cancels a running or scheduled file-inventory job. Read-only scans cause no data changes, so this only stops the walk. Call again with confirmed: true to cancel.",
    write: true,
    job: { op: "cancel" },
    params: {
      target,
      job_id: z.string().describe("Inventory job id to cancel."),
    },
  },

  // ─── Archive move (Phase 2 — native job tools, staged + reversible) ──────────
  {
    name: "plan_archive_move",
    description:
      "WRITE (tier 2) — Plans a DRY-RUN archive move: walks the share with the same rules as inventory and writes a manifest of exactly which old files would be relocated into <share>/Archive (or, in clean_empty_dirs mode, which empty folders would be removed). Nothing is moved or deleted — it only writes a plan to review. Requires cutoff_years for a move unless force_archive is true for selected roots. Call again with confirmed: true to create the plan; then review it with fetch_archive_move_manifest before execute_archive_move.",
    write: true,
    job: { op: "move_plan" },
    params: {
      target,
      share: moveShareParam,
      mode: moveModeParam,
      cutoff_years: cutoffYearsParam,
      protect_newer_than: protectNewerThanParam,
      force_archive: z.boolean().optional().describe("Move files in the selected roots even when their modified dates are newer than the cutoff. Requires roots and still respects protect_newer_than."),
      roots: moveRootsParam,
      include_globs: moveIncludeParam,
      exclude_globs: moveExcludeParam,
      prune_emptied_source_dirs: movePruneParam,
      remove_preexisting_empty_dirs: moveRemovePreexistingParam,
    },
  },
  {
    name: "get_archive_move_status",
    description:
      "Read the status/progress of archive-move jobs: stage (planned/executing/verifying/complete/…), counts (planned/moved/verified/skipped/failed/dirs_pruned), snapshot id, and any preflight or sync-exclusion notes. Pass job_id for one job; omit to list recent move jobs.",
    write: false,
    job: { op: "move_status" },
    params: {
      target,
      job_id: z.string().optional().describe("Archive-move job id. Omit to list recent move jobs."),
    },
  },
  {
    name: "fetch_archive_move_manifest",
    description:
      "Fetch a bounded, paginated slice of an archive-move manifest (one JSONL row per planned file move and per directory removal, with source/dest paths, identity fields, and per-row status). Use this to review a plan before executing. Use limit/cursor to page.",
    write: false,
    job: { op: "move_manifest" },
    params: {
      target,
      job_id: moveJobIdParam,
      limit: z.number().int().optional().describe("Max manifest rows to return (default 1000, max 5000)."),
      cursor: z.number().int().optional().describe("Row offset for pagination (from a prior response's next_cursor)."),
    },
  },
  {
    name: "execute_archive_move",
    description:
      "WRITE (tier 3, DESTRUCTIVE) — Executes a previously-planned archive move: runs preflight safety gates, takes a read-only Btrfs snapshot, then atomically renames each planned file into <share>/Archive verifying identity per file (rolling back any file that does not match), prunes emptied source folders, and applies the Archive sync exclusion. Writes to user data. Requires a planned (or interrupted/cancelled, to resume) job_id. Call again with confirmed: true to execute.",
    write: true,
    job: { op: "move_execute" },
    params: {
      target,
      job_id: moveJobIdParam,
    },
  },
  {
    name: "cancel_archive_move",
    description:
      "WRITE (tier 2) — Cancels a running archive-move (or a planned one). A cancelled execute leaves a consistent, resumable state — already-moved files stay moved and the rest can be resumed or rolled back. Call again with confirmed: true to cancel.",
    write: true,
    job: { op: "move_cancel" },
    params: {
      target,
      job_id: moveJobIdParam,
    },
  },
  {
    name: "rollback_archive_move",
    description:
      "WRITE (tier 3, REVERSING) — Rolls back an archive move using its manifest: recreates pruned source folders, renames every moved file back to its original path, and removes the now-empty Archive folders. Restores the pre-move state. Call again with confirmed: true to roll back.",
    write: true,
    job: { op: "move_rollback" },
    params: {
      target,
      job_id: moveJobIdParam,
    },
  },
  {
    name: "verify_archive_move",
    description:
      "Re-verify a completed archive move against the current filesystem (read-only): confirms each moved file is present at its Archive destination with matching identity and reports verified/missing/identity_mismatch counts. Changes nothing.",
    write: false,
    job: { op: "move_verify" },
    params: {
      target,
      job_id: moveJobIdParam,
    },
  },

];

// ─── Group taxonomy + tool_search registry ────────────────────────────────────
//
// Tool name → group. Not part of McpToolDef so we can re-tag without touching
// the (very large) defs above. Tools missing from this map fall through to
// "misc" via getGroup() and are still fully searchable + invokable.

export const TOOL_GROUPS: Record<string, string> = {
  // Archive file-inventory job tools.
  start_file_inventory: "archive",
  schedule_file_inventory: "archive",
  get_file_inventory_status: "archive",
  fetch_file_inventory_result: "archive",
  cancel_file_inventory: "archive",
  // Archive-move job tools.
  plan_archive_move: "archive",
  get_archive_move_status: "archive",
  fetch_archive_move_manifest: "archive",
  execute_archive_move: "archive",
  cancel_archive_move: "archive",
  rollback_archive_move: "archive",
  verify_archive_move: "archive",

  // system
  check_system_info: "system",
  check_disk_space: "system",
  check_hardware_temps: "system",
  check_volume_health: "system",
  check_packages: "system",
  check_scheduled_tasks: "system",
  list_volumes: "system",
  list_shared_folders: "system",
  inspect_mounts: "system",
  inspect_encryption_state: "system",
  check_agent_container: "system",

  // performance
  check_cpu_iowait: "performance",
  get_resource_snapshot: "performance",
  check_io_stalls: "performance",
  check_process_io_detail: "performance",
  strace_process: "performance",
  hdparm_device_info: "performance",
  check_psi_pressure: "performance",
  check_memory_detail: "performance",
  check_container_io: "performance",
  check_io_scheduler: "performance",
  check_nfs_client: "performance",

  // network
  check_network_health: "network",
  check_tailscale: "network",
  check_network_connections: "network",
  check_interface_flaps: "network",
  check_bond_health: "network",
  check_dns_and_gateway_health: "network",
  check_service_ports: "network",
  check_synology_drive_network: "network",

  // security
  check_security_log: "security",
  check_active_sessions: "security",

  // drive_sync
  tail_drive_server_log: "drive_sync",
  search_drive_server_log: "drive_sync",
  tail_sharesync_log: "drive_sync",
  check_sharesync_status: "drive_sync",
  check_drive_package_health: "drive_sync",
  check_drive_database: "drive_sync",
  check_share_database: "drive_sync",
  search_webapi_log: "drive_sync",
  search_drive_path_activity: "drive_sync",

  // logs
  tail_system_log: "logs",
  tail_package_logs: "logs",
  search_package_logs: "logs",
  search_all_logs: "logs",
  fetch_log_file: "logs",
  fetch_support_artifacts: "logs",
  check_kernel_io_errors: "logs",

  // storage
  check_scrub_status: "storage",
  check_storage_pool_detail: "storage",
  check_btrfs_detail: "storage",
  inspect_snapshot_replication: "storage",
  check_disk_error_trends: "storage",
  check_volume_quota_and_inode_pressure: "storage",
  check_smart_detail: "storage",
  check_filesystem_health: "storage",
  check_smart_test_progress: "storage",

  // files
  inspect_path_metadata: "files",
  inspect_path_acl: "files",
  inspect_effective_permissions: "files",
  find_recent_path_changes: "files",
  live_file_search: "files",
  find_path_versions_and_snapshots: "files",
  search_file_access_audit: "files",
  search_file_access_log: "files",
  search_smb_path_activity: "files",
  hash_file: "files",
  compare_file_versions: "files",
  find_problematic_files: "files",

  // recovery
  list_snapshot_candidates: "recovery",
  summarize_snapshots_by_share: "recovery",
  list_drive_version_history: "recovery",
  inspect_recycle_bin: "recovery",
  fetch_package_db: "recovery",
  collect_incident_bundle: "recovery",

  // packages
  check_package_runtime: "packages",
  check_daemon_processes: "packages",
  inspect_package_lockfiles: "packages",
  inspect_crash_signals: "packages",

  // backup
  check_backup_status: "backup",

  // write_restart
  restart_monitor_agent: "write_restart",
  stop_monitor_agent: "write_restart",
  start_monitor_agent: "write_restart",
  pull_monitor_agent: "write_restart",
  build_monitor_agent: "write_restart",
  restart_nas_api: "write_restart",
  restart_synology_drive_server: "write_restart",
  restart_synology_drive_sharesync: "write_restart",
  restart_hyper_backup: "write_restart",
  restart_synologand: "write_restart",
  restart_invoked_related_services: "write_restart",
  restart_scheduler_services: "write_restart",
  restart_network_service_safe: "write_restart",
  trigger_sharesync_resync: "write_restart",

  // write_storage
  start_btrfs_scrub: "write_storage",
  cancel_btrfs_scrub: "write_storage",
  start_smart_test: "write_storage",
  cancel_smart_test: "write_storage",
  create_prechange_snapshot: "write_storage",
  set_vm_overcommit_memory: "write_storage",
  persist_vm_overcommit_memory: "write_storage",
  set_io_scheduler: "write_storage",
  set_vm_dirty_ratios: "write_storage",
  set_ionice: "write_storage",
  set_inotify_watches: "write_storage",
  write_seafile_ignore: "write_files",

  // write_files
  rename_file_to_old: "write_files",
  remove_invalid_chars: "write_files",
  clear_package_lockfiles: "write_files",
  quarantine_path: "write_files",
  repair_path_ownership: "write_files",
  restore_path_from_snapshot: "write_files",
  restore_from_recycle_bin: "write_files",

  // write_tasks
  generate_support_bundle: "write_tasks",
  trigger_backup_task: "write_tasks",
  run_scheduled_task: "write_tasks",
  enable_scheduled_task: "write_tasks",
  disable_scheduled_task: "write_tasks",
};

export const KEYWORD_TO_GROUPS: Record<string, string[]> = {
  snapshot: ["storage", "recovery", "write_storage"],
  backup: ["backup", "write_tasks"],
  drive: ["drive_sync"],
  sync: ["drive_sync"],
  sharesync: ["drive_sync"],
  disk: ["storage", "system"],
  smart: ["storage", "write_storage"],
  btrfs: ["storage", "write_storage"],
  scrub: ["storage", "write_storage"],
  network: ["network"],
  tailscale: ["network"],
  bond: ["network"],
  dns: ["network"],
  memory: ["performance"],
  cpu: ["performance"],
  performance: ["performance"],
  iowait: ["performance"],
  log: ["logs", "drive_sync"],
  logs: ["logs", "drive_sync"],
  search: ["files", "logs", "drive_sync"],
  universal: ["files"],
  excel: ["files"],
  xls: ["files"],
  xlsx: ["files"],
  spreadsheet: ["files"],
  pattern: ["files"],
  package: ["packages", "write_restart"],
  packages: ["packages", "write_restart"],
  restart: ["write_restart"],
  file: ["files", "write_files"],
  files: ["files", "write_files"],
  permission: ["files", "write_files"],
  permissions: ["files", "write_files"],
  acl: ["files", "write_files"],
  delete: ["files", "recovery"],
  deleted: ["files", "recovery"],
  recover: ["recovery"],
  recovery: ["recovery"],
  recycle: ["recovery"],
  security: ["security"],
  session: ["security"],
  sessions: ["security"],
  temperature: ["system", "storage"],
  volume: ["system", "storage"],
  space: ["system"],
  audit: ["files", "security"],
  task: ["write_tasks", "system"],
  scheduled: ["write_tasks", "system"],
  archive: ["archive"],
  inventory: ["archive"],
};

const KNOWN_GROUPS: Set<string> = new Set([
  ...Object.values(TOOL_GROUPS),
  "misc",
]);

export function getGroup(toolName: string): string {
  return TOOL_GROUPS[toolName] ?? "misc";
}

export function listUntaggedTools(): string[] {
  return ALL_TOOL_DEFS.filter((t) => !(t.name in TOOL_GROUPS)).map((t) => t.name);
}

export function searchTools(query: string, enabled: Set<string>): McpToolDef[] {
  const lower = query.toLowerCase().trim();
  if (!lower) return [];
  const words = lower.split(/\s+/).filter(Boolean);

  // For each query word, build the set of matching tool names independently.
  // - Direct group name (e.g. "files", "recovery"): only tools in that group, no description fallback.
  // - KEYWORD_TO_GROUPS alias (e.g. "snapshot"): tools in the mapped groups + name/description match.
  // - No mapping: name/description match only.
  const perWord: Set<string>[] = words.map((word) => {
    const matching = new Set<string>();
    if (KNOWN_GROUPS.has(word)) {
      for (const tool of ALL_TOOL_DEFS) {
        if (enabled.has(tool.name) && getGroup(tool.name) === word) matching.add(tool.name);
      }
    } else {
      const mappedGroups = new Set<string>(KEYWORD_TO_GROUPS[word] ?? []);
      for (const tool of ALL_TOOL_DEFS) {
        if (!enabled.has(tool.name)) continue;
        if (
          mappedGroups.has(getGroup(tool.name)) ||
          tool.name.toLowerCase().includes(word) ||
          tool.description.toLowerCase().includes(word)
        ) {
          matching.add(tool.name);
        }
      }
    }
    return matching;
  });

  // AND semantics: a tool must match every query word.
  let candidates = perWord[0];
  for (let i = 1; i < perWord.length; i++) {
    const next = new Set<string>();
    for (const name of candidates) {
      if (perWord[i].has(name)) next.add(name);
    }
    candidates = next;
  }

  // Score for ordering within the intersection (name hit outweighs description hit).
  const toolMap = new Map<string, McpToolDef>(ALL_TOOL_DEFS.map((t) => [t.name, t]));
  const scored: { tool: McpToolDef; score: number }[] = [];
  for (const name of candidates) {
    const tool = toolMap.get(name)!;
    let score = 0;
    const nameLower = tool.name.toLowerCase();
    const descLower = tool.description.toLowerCase();
    for (const word of words) {
      if (nameLower.includes(word)) score += 3;
      if (descLower.includes(word)) score += 1;
    }
    scored.push({ tool, score });
  }
  scored.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return scored.map((s) => s.tool);
}

function describeZodParam(schema: z.ZodTypeAny): string {
  let inner: z.ZodTypeAny = schema;
  let optional = false;
  let defaultVal: unknown;
  // Unwrap ZodOptional / ZodDefault chains
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while ((inner as any)?._def?.typeName === "ZodOptional" || (inner as any)?._def?.typeName === "ZodDefault") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = (inner as any)._def;
    if (d.typeName === "ZodOptional") optional = true;
    if (d.typeName === "ZodDefault") {
      try { defaultVal = d.defaultValue?.(); } catch { /* ignore */ }
    }
    inner = d.innerType;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tn: string | undefined = (inner as any)?._def?.typeName;
  let type = "unknown";
  if (tn === "ZodString") type = "string";
  else if (tn === "ZodNumber") type = "number";
  else if (tn === "ZodBoolean") type = "boolean";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  else if (tn === "ZodEnum") type = ((inner as any)._def.values as string[]).map((v) => JSON.stringify(v)).join(" | ");
  else if (tn === "ZodArray") type = "array";
  else if (tn === "ZodObject" || tn === "ZodRecord") type = "object";

  const flags: string[] = [];
  if (optional) flags.push("optional");
  if (defaultVal !== undefined) flags.push(`default=${JSON.stringify(defaultVal)}`);
  const flagStr = flags.length ? ` (${flags.join(", ")})` : "";
  const desc = schema.description ? `  // ${schema.description}` : "";
  return `${type}${flagStr}${desc}`;
}

export function formatToolForSearch(tool: McpToolDef): string {
  const lines: string[] = [];
  lines.push(`TOOL: ${tool.name}`);
  lines.push(`GROUP: ${getGroup(tool.name)}`);
  lines.push(`TYPE: ${tool.write ? "write (requires confirmed: true to execute)" : "read"}`);
  lines.push(`DESCRIPTION: ${tool.description}`);
  const paramKeys = Object.keys(tool.params);
  if (paramKeys.length === 0) {
    lines.push(`PARAMS: (none)`);
  } else {
    lines.push(`PARAMS:`);
    for (const key of paramKeys) {
      lines.push(`  ${key}: ${describeZodParam(tool.params[key])}`);
    }
    if (tool.write) {
      lines.push(`  confirmed: boolean (optional, default=false — omit to preview, set true to execute)`);
    }
  }
  return lines.join("\n");
}

export function findToolByName(name: string): McpToolDef | undefined {
  return ALL_TOOL_DEFS.find((t) => t.name === name);
}

// ─── JSON-schema view (for the issue-agent Stage 2 tool catalog) ──────────────
// nas-mcp uses the Zod `params` directly with server.tool(); the web issue agent
// needs a provider-native JSON-schema input. This converts the small param
// vocabulary used here (string/number/boolean/enum, optional/default) without a
// json-schema dependency.

export interface ToolJsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
}

function zodFieldToJson(schema: z.ZodTypeAny): { json: Record<string, unknown>; required: boolean } {
  const description = (schema as { description?: string }).description;
  let required = true;
  let s: z.ZodTypeAny = schema;
  // Unwrap optional/default/nullable wrappers.
  for (let i = 0; i < 6; i += 1) {
    const tn = (s as { _def?: { typeName?: string } })._def?.typeName;
    if (tn === "ZodOptional" || tn === "ZodDefault" || tn === "ZodNullable") {
      required = false;
      s = (s as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    } else break;
  }
  const def = (s as unknown as { _def: { typeName?: string; values?: unknown[]; value?: unknown } })._def;
  let json: Record<string, unknown>;
  switch (def?.typeName) {
    case "ZodNumber":
      json = { type: "number" };
      break;
    case "ZodBoolean":
      json = { type: "boolean" };
      break;
    case "ZodEnum":
      json = { type: "string", enum: def.values };
      break;
    case "ZodLiteral":
      json = { const: def.value };
      break;
    case "ZodString":
    default:
      json = { type: "string" };
      break;
  }
  if (description) json.description = description;
  return { json, required };
}

/** Convert a tool's Zod `params` into a JSON-schema object for model tool use. */
export function toInputSchema(def: McpToolDef): ToolJsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const [key, field] of Object.entries(def.params)) {
    const { json, required: req } = zodFieldToJson(field);
    properties[key] = json;
    if (req) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}
