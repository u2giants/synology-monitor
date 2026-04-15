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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

export const ALL_TOOL_DEFS: McpToolDef[] = [

  // ── Read tools ───────────────────────────────────────────────────────────────

  {
    name: "check_disk_space",
    description: "Shows disk usage on /volume1 — how full the NAS storage is and how much free space remains.",
    write: false,
    params: { target },
    buildCommand: () => "df -h /volume1",
  },

  {
    name: "check_agent_container",
    description: "Confirms whether the Synology Monitor agent container is currently running.",
    write: false,
    params: { target },
    buildCommand: () =>
      "/usr/local/bin/docker ps --format '{{.Image}}|{{.Status}}|{{.Names}}' | grep synology-monitor-agent || true",
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
    name: "tail_drive_server_log",
    description: "Shows the most recent entries from the Synology Drive server log.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) =>
      `tail -n ${clamp((input.lookback_hours as number ?? 2) * 40, 40, 300)} /var/log/synologydrive.log`,
  },

  {
    name: "search_drive_server_log",
    description: "Searches the Synology Drive server log for a specific word or phrase — such as a share name, username, or error message.",
    write: false,
    params: { target, lookback_hours: lookbackHours, filter },
    buildCommand: (input) => {
      const f = (input.filter as string | undefined)?.trim() || "error";
      const lines = clamp((input.lookback_hours as number ?? 2) * 40, 40, 300);
      return `grep -i ${quote(f)} /var/log/synologydrive.log | tail -n ${lines}`;
    },
  },

  {
    name: "tail_sharesync_log",
    description: "Shows the most recent ShareSync log entries — what files are being synced and any sync errors.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 2) * 30, 40, 240);
      return `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "$f"; tail -n ${lines} "$f"; done`;
    },
  },

  {
    name: "check_sharesync_status",
    description: "Looks specifically for stuck, conflicted, or erroring ShareSync tasks in the recent logs.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 2) * 40, 60, 200);
      return `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "=== $f ==="; tail -n ${lines} "$f"; done | grep -A2 -B2 -i "syncing\\|stuck\\|error\\|conflict" || echo "No issues found in recent logs"`;
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
      "/host/usr/syno/sbin/synoshare --enum ALL 2>&1 || echo 'synoshare --enum failed (share database may be corrupted)'",
      "echo ''",
      "echo '=== SHARE DETAILS (first 10) ==='",
      `/host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | head -10 | while read -r name; do echo "--- $name ---"; /host/usr/syno/sbin/synoshare --get "$name" 2>&1 | head -15; done`,
    ].join("\n"),
  },

  {
    name: "check_drive_package_health",
    description: "Checks whether the Synology Drive package is properly installed — its status, version, internal database files, and log locations. Detects broken installations.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DRIVE PACKAGE STATUS ==='",
      "/host/usr/syno/bin/synopkg status SynologyDrive 2>&1",
      "/host/usr/syno/bin/synopkg status SynologyDriveShareSync 2>&1",
      "echo ''",
      "echo '=== DRIVE VERSION ==='",
      "/host/usr/syno/bin/synopkg version SynologyDrive 2>&1",
      "echo ''",
      "echo '=== DRIVE DATABASE FILES ==='",
      "find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -20",
      "ls -lh /volume1/@synologydrive/db/ 2>/dev/null || echo 'No Drive DB directory'",
      "echo ''",
      "echo '=== RECENT DRIVE PACKAGE LOG ==='",
      "grep -i 'synologydrive\\|SynologyDrive' /var/log/synolog/synopkg.log 2>/dev/null | tail -20 || true",
    ].join("\n"),
  },

  {
    name: "check_drive_database",
    description: "Checks Synology Drive's internal SQLite databases for corruption. Database corruption causes persistent sync failures that won't resolve on their own.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== DRIVE DATABASE FILES ==='",
      `find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -10`,
      "echo ''",
      "echo '=== INTEGRITY CHECK (first 3 DBs) ==='",
      `find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -3 | while read db; do echo "--- $db ---"; timeout 10 sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -5 || echo 'timeout or error'; done`,
      "echo ''",
      "echo '=== MAIN DRIVE DB TABLES ==='",
      `maindb=$(find /volume1/@synologydrive/ -maxdepth 3 \\( -name 'synodrive.db' -o -name 'sync.db' \\) 2>/dev/null | head -1); [ -n "$maindb" ] && echo "DB: $maindb" && timeout 10 sqlite3 "$maindb" '.tables' 2>&1 | head -20 || echo 'Main Drive DB not found'`,
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
        `grep -iE ${quote(f)} /var/log/synolog/synowebapi.log 2>/dev/null | tail -n ${lines} || echo 'No matches or file not found'`,
        "echo ''",
        "echo '=== STORAGE LOG ==='",
        `grep -iE 'share|volume|storage|mount' /var/log/synolog/synostorage.log 2>/dev/null | tail -40 || echo 'No matches or file not found'`,
        "echo ''",
        "echo '=== SHARE LOG ==='",
        `grep -iE 'error|fail|warn' /var/log/synolog/synoshare.log 2>/dev/null | tail -40 || echo 'No matches or file not found'`,
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
        `for f in /var/log/synolog/*.log /var/log/messages /var/log/kern.log /var/log/synologydrive.log /var/log/samba/*.log; do`,
        `  [ -f "$f" ] || continue`,
        `  matches=$(grep -ciE ${quote(f)} "$f" 2>/dev/null || true)`,
        `  [ "$matches" -gt 0 ] 2>/dev/null && echo "$f: $matches matches" && grep -iE ${quote(f)} "$f" 2>/dev/null | tail -5 && echo ""`,
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
    description: "Checks filesystem mount status, inode usage, RAID status, and SMART disk health. Run when you suspect hardware problems or filesystem corruption.",
    write: false,
    params: { target },
    buildCommand: () => [
      "echo '=== MOUNT STATUS ==='",
      "mount | grep volume",
      "echo ''",
      "echo '=== INODE USAGE ==='",
      "df -i /volume1",
      "echo ''",
      "echo '=== FILESYSTEM TYPE ==='",
      "tune2fs -l $(mount | grep '/volume1 ' | awk '{print $1}') 2>/dev/null | grep -iE 'filesystem|mount count|error|state|journal' || btrfs filesystem show /volume1 2>/dev/null || echo 'Could not determine filesystem details'",
      "echo ''",
      "echo '=== SMART STATUS ==='",
      "for d in /dev/sd?; do [ -b \"$d\" ] || continue; echo \"--- $d ---\"; smartctl -H \"$d\" 2>/dev/null | grep -E 'result|Status'; smartctl -A \"$d\" 2>/dev/null | grep -E 'Reallocated|Current_Pending|Offline_Uncorrectable|Temperature'; done",
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
        "  echo 'Scheduler DB not found at expected path'",
        "fi",
        "echo ''",
        "echo '=== RECENT SCHEDULER ERRORS ==='",
        `grep -iE 'error|fail|exit [^0]' /var/log/synolog/synoscheduler.log 2>/dev/null | tail -${lines} || echo 'No scheduler log found'`,
      ].join("\n");
    },
  },

  {
    name: "check_backup_status",
    description: "Checks Hyper Backup package status, lists backup tasks, and shows recent backup log entries — especially errors, failures, and destination connectivity issues.",
    write: false,
    params: { target, lookback_hours: lookbackHours },
    buildCommand: (input) => {
      const lines = clamp((input.lookback_hours as number ?? 6) * 20, 40, 200);
      return [
        "echo '=== HYPER BACKUP STATUS ==='",
        "/host/usr/syno/bin/synopkg status HyperBackup 2>&1 || echo 'HyperBackup package not found'",
        "echo ''",
        "echo '=== BACKUP TASK LIST ==='",
        "/host/usr/syno/bin/synobackup --list 2>/dev/null || echo 'No backup CLI available'",
        "echo ''",
        "echo '=== RECENT BACKUP LOG ==='",
        `grep -iE 'error|fail|warn|complete|success|abort|destination' /var/log/synolog/synobackup.log 2>/dev/null | tail -${lines} || tail -${lines} /var/log/synolog/synobackup.log 2>/dev/null || echo 'Backup log not found'`,
        "echo ''",
        "echo '=== BACKUP DESTINATION ==='",
        "ls /volume1/@SynologyHyperBackup* 2>/dev/null || echo 'No HyperBackup vault found on volume1'",
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
    name: "restart_synology_drive_server",
    description: "WRITE — Restarts the Synology Drive package. Use when Drive is unresponsive or in an error state. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "/host/usr/syno/bin/synopkg restart SynologyDrive",
  },

  {
    name: "restart_synology_drive_sharesync",
    description: "WRITE — Restarts the ShareSync package. Use when ShareSync is stuck or not syncing. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target },
    buildCommand: () => "/host/usr/syno/bin/synopkg restart SynologyDriveShareSync",
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
    description: "WRITE — Forces a ShareSync re-sync by restarting ShareSync. Specify the folder or task name in the 'filter' parameter. Shows a preview and asks for your approval before doing anything.",
    write: true,
    params: { target, filter },
    buildCommand: (input) => {
      const folder = (input.filter as string | undefined)?.trim();
      if (!folder) throw new Error("trigger_sharesync_resync requires the ShareSync folder name in the 'filter' parameter.");
      return `/host/usr/syno/bin/synopkg restart SynologyDriveShareSync && sleep 10 && echo "ShareSync restarted for folder: ${folder}"`;
    },
  },
];
