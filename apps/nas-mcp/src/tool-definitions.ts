import { z } from "zod";

export interface McpToolDef {
  name: string;
  description: string;
  write: boolean;
  /** ZodRawShape passed directly to server.tool() */
  params: Record<string, z.ZodTypeAny>;
  buildCommand: (input: Record<string, unknown>) => string;
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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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
    description: "Confirms whether the Synology Monitor agent container is currently running.",
    write: false,
    params: { target },
    buildCommand: () =>
      "timeout 15 docker ps --format '{{.Image}}|{{.Status}}|{{.Names}}' | grep synology-monitor-agent || true",
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
      "for v in /volume[0-9]*; do [ -d \"$v\" ] || continue; timeout 10 lsof -n +D \"$v\" 2>/dev/null | awk 'NR>1{print $1,$3,$9}' | sort | uniq -c | sort -rn | head -15 && break; done || true",
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
    description: "Looks for processes stuck waiting on disk (D-state), measures I/O wait percentage, checks disk queue depth, and finds hung task kernel warnings. Run when the NAS feels slow or unresponsive.",
    write: false,
    params: { target },
    buildCommand: () => [
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
    description: "Lists all DSM scheduled tasks (cron-like jobs) and their last run result. A non-zero exit code means the task failed silently — useful for catching backup or maintenance script failures.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 4) * 10, 20, 80);
      return [
        "echo '=== SCHEDULED TASKS ==='",
        "if [ -f /host/usr/syno/etc/schedule/synoscheduler.db ]; then",
        "  sqlite3 /host/usr/syno/etc/schedule/synoscheduler.db \"SELECT id, name, type, enable, status, last_work_time, next_trigger_time FROM task\" 2>/dev/null | head -40",
        "else",
        "  echo 'Scheduler DB not found at /host/usr/syno/etc/schedule/synoscheduler.db'",
        "fi",
        "echo ''",
        "echo '=== RECENT SCHEDULER ERRORS ==='",
        `grep -iE 'error|fail|exit [^0]' /host/log/synolog/synoscheduler.log 2>/dev/null | tail -${lines} || echo 'Scheduler log not found'`,
      ].join("\n");
    },
  },

  {
    name: "check_backup_status",
    description: "Checks Hyper Backup package status, lists backup tasks, and shows recent backup log entries — especially errors, failures, and destination connectivity issues. Searches across all volumes.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 6) * 20, 40, 200);
      return [
        "echo '=== HYPER BACKUP STATUS ==='",
        "ver=$(grep -m1 '^version=' /var/packages/HyperBackup/INFO 2>/dev/null | cut -d= -f2-); enabled=$([ -f /var/packages/HyperBackup/enabled ] && echo enabled || echo disabled); echo \"HyperBackup: ${ver:-not found} [$enabled]\"",
        "echo ''",
        "echo '=== BACKUP TASK LIST ==='",
        "/host/usr/syno/bin/synobackup --list 2>/dev/null || echo 'No backup CLI available'",
        "echo ''",
        "echo '=== RECENT BACKUP LOG ==='",
        `grep -iE 'error|fail|warn|complete|success|abort|destination' /host/log/synolog/synobackup.log 2>/dev/null | tail -${lines} || tail -${lines} /host/log/synolog/synobackup.log 2>/dev/null || echo 'Backup log not found'`,
        "echo ''",
        "echo '=== BACKUP VAULT LOCATIONS (all volumes) ==='",
        "for v in /volume[0-9]*; do ls -d \"$v\"/@SynologyHyperBackup* 2>/dev/null && printf '  (on %s)\\n' \"$v\"; done || echo 'No HyperBackup vault found on any volume'",
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
    description: "Shows the POSIX and Synology ACL entries for an exact filesystem path. Reveals which users and groups have explicit ACL permissions beyond standard POSIX mode. Requires exact_path.",
    write: false,
    params: { target, exact_path: exactPath },
    buildCommand: (input) => {
      const p = (input.exact_path as string).trim();
      return [
        "echo '=== POSIX MODE ==='",
        `stat -c 'mode=%A owner=%U:%G size=%s inode=%i' ${quote(p)} 2>&1`,
        "echo ''",
        "echo '=== POSIX ACL (getfacl) ==='",
        `getfacl ${quote(p)} 2>&1 || echo 'getfacl not available or path not found'`,
        "echo ''",
        "echo '=== SYNOLOGY ACL (synoacltool) ==='",
        `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get ${quote(p)} 2>/dev/null || echo 'synoacltool not available'`,
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
      const lines = [
        "echo '=== PATH PERMISSIONS ==='",
        `stat -c 'mode=%A owner=%U:%G inode=%i' ${quote(p)} 2>&1`,
        "echo ''",
        "echo '=== ACL ==='",
        `getfacl ${quote(p)} 2>&1 || echo 'getfacl not available'`,
        "echo ''",
        "echo '=== SYNOLOGY ACL (synoacltool) ==='",
        `LD_LIBRARY_PATH=/host/lib:/host/usr/lib:/host/usr/syno/lib /host/usr/syno/bin/synoacltool -get ${quote(p)} 2>/dev/null || echo 'synoacltool not available'`,
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
    description: "Shows detailed storage pool and RAID array state from DSM (synoarraystatus, synovolumestatus) and mdadm. Reveals degraded arrays, rebuilding disks, and parity errors.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== SYNOLOGY ARRAY STATUS ==='",
      "/host/usr/syno/sbin/synoarraystatus 2>/dev/null || echo 'synoarraystatus not available'",
      "echo ''",
      "echo '=== SYNOLOGY VOLUME STATUS ==='",
      "/host/usr/syno/sbin/synovolumestatus 2>/dev/null || echo 'synovolumestatus not available'",
      "echo ''",
      "echo '=== MDADM RAID DETAIL ==='",
      "for md in /dev/md*; do",
      "  [ -b \"$md\" ] || continue",
      "  echo \"--- $md ---\"",
      "  mdadm --detail \"$md\" 2>&1 | head -40",
      "  echo ''",
      "done 2>/dev/null || echo 'No MD devices found or mdadm not available'",
      "echo ''",
      "echo '=== /proc/mdstat ==='",
      "cat /proc/mdstat 2>/dev/null || echo 'mdstat not available'",
      "echo ''",
      "echo '=== DISK PRESENCE CHECK ==='",
      "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo \"--- $d ---\"; smartctl -i \"$d\" 2>/dev/null | grep -E 'Device Model|Model Number|Serial|Capacity' | head -3; done 2>/dev/null || echo 'smartctl not available'",
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
    description: "Queries a named DSM package's SQLite database. Pass the package name and optionally a SQL query in filter. Omit filter to list all tables and row counts. Use for deep investigation of Drive, HyperBackup, or scheduler internal state.",
    write: false,
    params: { target, package_name: packageName, filter },
    buildCommand: (input) => {
      const pkg = (input.package_name as string).trim();
      const query = (input.filter as string | undefined)?.trim();
      const pkgLower = pkg.toLowerCase();
      const findCmd = `find /volume[0-9]*/@${pkgLower}/ /volume[0-9]*/@syno${pkgLower}/ /host/var/packages/${quote(pkg)}/var/ -maxdepth 5 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null`;
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
          `[ -n "$dbfile" ] && echo "Using: $dbfile" && timeout 15 sqlite3 "$dbfile" ${quote(query)} 2>&1 | head -100 || echo 'No DB file found'`,
        );
      } else {
        lines.push(
          `echo '=== TABLE SUMMARY ==='`,
          `for dbfile in $(${findCmd} | head -3); do`,
          `  echo "--- $dbfile ---"`,
          `  timeout 10 sqlite3 "$dbfile" '.tables' 2>&1 | head -10`,
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
    description: "Lists available Btrfs snapshots on all volumes that could be used for path recovery. Shows snapshot names, creation times. Optionally pass a name fragment in filter to narrow results.",
    write: false,
    params: { target, filter },
    buildCommand: (input) => {
      const nameFilter = (input.filter as string | undefined)?.trim();
      return [
        "echo '=== BTRFS SUBVOLUME SNAPSHOTS (all volumes) ==='",
        "for v in /volume[0-9]*; do",
        "  [ -d \"$v\" ] || continue",
        "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
        "  [ \"$fstype\" = 'btrfs' ] || continue",
        "  echo \"--- $v ---\"",
        "  btrfs subvolume list -s \"$v\" 2>&1 | head -30",
        "  echo ''",
        "done 2>/dev/null || echo 'btrfs not available or no btrfs volumes'",
        "echo ''",
        "echo '=== @Recently-Snapshot DIRS ==='",
        "for v in /volume[0-9]*; do",
        "  [ -d \"$v/@Recently-Snapshot\" ] || continue",
        "  echo \"--- $v/@Recently-Snapshot ---\"",
        "  ls -lt \"$v/@Recently-Snapshot/\" 2>/dev/null | head -20",
        "  echo ''",
        "done 2>/dev/null || echo 'No @Recently-Snapshot directories found'",
        "echo ''",
        "echo '=== @prechange SNAPSHOTS ==='",
        "for v in /volume[0-9]*; do",
        nameFilter
          ? `  ls -dt "$v"/@prechange_* "$v"/@*${nameFilter}* 2>/dev/null | head -10`
          : `  ls -dt "$v"/@prechange_* 2>/dev/null | head -10`,
        "done 2>/dev/null || echo 'No @prechange snapshots found'",
        "echo ''",
        "echo '=== BTRFS SNAPSHOT SIZES ==='",
        "for v in /volume[0-9]*; do",
        "  [ -d \"$v\" ] || continue",
        "  fstype=$(findmnt -no FSTYPE \"$v\" 2>/dev/null)",
        "  [ \"$fstype\" = 'btrfs' ] || continue",
        "  btrfs subvolume list -s \"$v\" 2>/dev/null | awk '{print $NF}' | while read -r rel; do",
        "    path=\"$v/$rel\"",
        "    [ -d \"$path\" ] && printf '%s\\t%s\\n' \"$(du -sh \"$path\" 2>/dev/null | awk '{print $1}')\" \"$path\"",
        "  done | head -20",
        "done 2>/dev/null || true",
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
    description: "WRITE — Restarts the Synology Monitor agent container. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose restart",
  },

  {
    name: "stop_monitor_agent",
    description: "WRITE — Stops the Synology Monitor agent. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose stop",
  },

  {
    name: "start_monitor_agent",
    description: "WRITE — Starts the Synology Monitor agent. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose up -d",
  },

  {
    name: "pull_monitor_agent",
    description: "WRITE — Downloads the latest Synology Monitor agent image. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose pull",
  },

  {
    name: "build_monitor_agent",
    description: "WRITE — Rebuilds the Synology Monitor agent container locally. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose build --pull",
  },

  {
    name: "restart_nas_api",
    description: "WRITE — Restarts the NAS API container (the service that runs commands on the NAS). Use if the API becomes unresponsive. Shows a preview and asks for your approval.",
    write: true,
    params: { target },
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose restart nas-api",
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
    description: "WRITE — Renames a specific file by adding .old to its name, hiding it from sync without deleting it. Requires an exact file path in the 'filter' parameter. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const filePath = (input.filter as string | undefined)?.trim();
      if (!filePath) throw new Error("rename_file_to_old requires an exact file path in the 'filter' parameter.");
      return `mv "${filePath}" "${filePath}.old" && echo "Renamed successfully"`;
    },
  },

  {
    name: "remove_invalid_chars",
    description: "WRITE — Cleans a filename by replacing sync-breaking characters (: * ? \" < > |) with underscores. Requires an exact file path in the 'filter' parameter. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const filePath = (input.filter as string | undefined)?.trim();
      if (!filePath) throw new Error("remove_invalid_chars requires an exact file path in the 'filter' parameter.");
      return `dir=$(dirname "${filePath}"); file=$(basename "${filePath}"); newfile=$(echo "$file" | sed 's/[\\/:*?"<>|]/_/g'); [ "$file" != "$newfile" ] && mv "${filePath}" "$dir/$newfile" && echo "Renamed: $file -> $newfile" || echo "No invalid characters found"`;
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
    name: "repair_drive_db_permissions",
    description: "WRITE — Fixes ownership and permissions on @synologydrive database directories across all volumes. Useful when Synology Drive fails to start due to permission errors on its database files.",
    write: true,
    params: { target },
    buildCommand: (_input) => {
      return [
        `echo '=== SYNOLOGYDRIVE DIRS ==='`,
        `find /volume[0-9]* -maxdepth 2 -name '@synologydrive' -type d 2>/dev/null`,
        `echo '=== REPAIRING OWNERSHIP ==='`,
        `find /volume[0-9]* -maxdepth 2 -name '@synologydrive' -type d 2>/dev/null | while read d; do`,
        `  echo "chown -R SynologyDrive:SynologyDrive $d"`,
        `  chown -R SynologyDrive:SynologyDrive "$d" 2>&1 && echo "OK: $d" || echo "FAILED: $d"`,
        `done`,
        `echo '=== VERIFY ==='`,
        `find /volume[0-9]* -maxdepth 2 -name '@synologydrive' -type d 2>/dev/null | xargs -I{} stat --format='%U:%G %a %n' {} 2>/dev/null`,
      ].join("\n");
    },
  },

  {
    name: "quarantine_path",
    description: "WRITE — Renames an exact path by appending .quarantine.{timestamp} to isolate a problematic file or directory without deleting it. Pass the exact absolute path in filter.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const p = (input.filter as string | undefined)?.trim();
      if (!p) throw new Error("quarantine_path: filter must be an absolute path.");
      if (!p.startsWith("/")) throw new Error("quarantine_path: path must be absolute.");
      const q = quote(p);
      return [
        `echo '=== PATH TO QUARANTINE ==='`,
        `ls -la ${q} 2>&1`,
        `echo '=== QUARANTINING ==='`,
        `ts=$(date +%Y%m%d_%H%M%S)`,
        `dest="${p}.quarantine.\${ts}"`,
        `mv ${q} "$dest" && echo "Renamed to: $dest" || echo "FAILED"`,
      ].join("\n");
    },
  },

  {
    name: "repair_path_ownership",
    description: "WRITE — Runs chown on an exact path to fix file ownership. Pass 'owner:group' or 'recursive:owner:group' in filter (recursive prefix triggers -R). Path must be absolute.",
    write: true,
    params: { target, filter, exactPath },
    buildCommand: (input) => {
      const p = (input.exactPath as string | undefined)?.trim();
      if (!p || !p.startsWith("/")) throw new Error("repair_path_ownership: exactPath must be an absolute path.");
      const f = (input.filter as string | undefined)?.trim() || "";
      let recursive = false;
      let ownerGroup = f;
      if (f.startsWith("recursive:")) { recursive = true; ownerGroup = f.slice("recursive:".length); }
      if (!/^[A-Za-z0-9_\-]+:[A-Za-z0-9_\-]+$/.test(ownerGroup)) throw new Error("repair_path_ownership: filter must be 'owner:group' or 'recursive:owner:group'.");
      const qp = quote(p);
      const qo = quote(ownerGroup);
      const flag = recursive ? "-R " : "";
      return [
        `echo '=== CURRENT OWNERSHIP ==='`,
        `ls -la ${qp} 2>&1`,
        `echo '=== APPLYING chown ${flag}${ownerGroup} ==='`,
        `chown ${flag}${qo} ${qp} 2>&1 && echo OK || echo FAILED`,
        `echo '=== VERIFY ==='`,
        `ls -la ${qp} 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "repair_path_acl",
    description: "WRITE — Runs setfacl on an exact path to repair or set POSIX ACL entries. Pass the ACL spec in filter (e.g. 'u:username:rwx' or 'd:u:username:rwx'). Path must be absolute.",
    write: true,
    params: { target, filter, exactPath },
    buildCommand: (input) => {
      const p = (input.exactPath as string | undefined)?.trim();
      if (!p || !p.startsWith("/")) throw new Error("repair_path_acl: exactPath must be an absolute path.");
      const aclSpec = (input.filter as string | undefined)?.trim();
      if (!aclSpec) throw new Error("repair_path_acl: filter must be an ACL spec (e.g. 'u:username:rwx').");
      if (!/^[A-Za-z0-9_:,\-\.]+$/.test(aclSpec)) throw new Error("repair_path_acl: invalid ACL spec characters.");
      const qp = quote(p);
      const qs = quote(aclSpec);
      return [
        `echo '=== CURRENT ACL ==='`,
        `getfacl ${qp} 2>&1`,
        `echo '=== APPLYING setfacl -m ${aclSpec} ==='`,
        `setfacl -m ${qs} ${qp} 2>&1 && echo OK || echo FAILED`,
        `echo '=== VERIFY ==='`,
        `getfacl ${qp} 2>&1`,
      ].join("\n");
    },
  },

  // ── Phase 3: Recovery / Restoration write tools ─────────────────────────

  {
    name: "restore_path_from_snapshot",
    description: "WRITE — Restores a file or directory from a Btrfs snapshot. Pass the snapshot path (from list_snapshot_candidates) and the destination path in filter as 'snapshot_path|dest_path'. Both must be absolute. Does NOT overwrite — destination must not exist.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "";
      const parts = f.split("|");
      if (parts.length !== 2) throw new Error("restore_path_from_snapshot: filter must be 'snapshot_path|dest_path'.");
      const [src, dst] = parts.map(s => s.trim());
      if (!src.startsWith("/") || !dst.startsWith("/")) throw new Error("restore_path_from_snapshot: both paths must be absolute.");
      const qs = quote(src);
      const qd = quote(dst);
      return [
        `echo '=== SOURCE (snapshot) ==='`,
        `ls -la ${qs} 2>&1`,
        `echo '=== DESTINATION ==='`,
        `ls -la ${qd} 2>/dev/null && echo "EXISTS — refusing to overwrite" && exit 1 || echo "(does not exist — safe to restore)"`,
        `echo '=== RESTORING ==='`,
        `cp -a ${qs} ${qd} 2>&1 && echo "OK: restored to ${dst}" || echo "FAILED"`,
        `echo '=== VERIFY ==='`,
        `ls -la ${qd} 2>&1`,
      ].join("\n");
    },
  },

  {
    name: "restore_from_recycle_bin",
    description: "WRITE — Restores a file from a share's recycle bin (#recycle) to its original or specified destination. Pass 'recycle_bin_path|dest_path' in filter — both absolute. Destination must not exist.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "";
      const parts = f.split("|");
      if (parts.length !== 2) throw new Error("restore_from_recycle_bin: filter must be 'recycle_path|dest_path'.");
      const [src, dst] = parts.map(s => s.trim());
      if (!src.startsWith("/") || !dst.startsWith("/")) throw new Error("restore_from_recycle_bin: both paths must be absolute.");
      if (!src.includes("#recycle")) throw new Error("restore_from_recycle_bin: source path must include #recycle.");
      const qs = quote(src);
      const qd = quote(dst);
      return [
        `echo '=== SOURCE (recycle bin) ==='`,
        `ls -la ${qs} 2>&1`,
        `echo '=== DESTINATION CHECK ==='`,
        `ls -la ${qd} 2>/dev/null && echo "EXISTS — refusing to overwrite" && exit 1 || echo "(does not exist — safe to restore)"`,
        `echo '=== RESTORING ==='`,
        `mv ${qs} ${qd} 2>&1 && echo "OK: restored to ${dst}" || echo "FAILED"`,
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
];
