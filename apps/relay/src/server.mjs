import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const RELAY_BEARER_TOKEN = requiredEnv("RELAY_BEARER_TOKEN");
const RELAY_ADMIN_SECRET = requiredEnv("RELAY_ADMIN_SECRET");
const ALLOWED_ORIGINS = parseCsv(process.env.RELAY_ALLOWED_ORIGINS ?? "");

const NAS_CONFIGS = {
  edgesynology1: {
    url: requiredEnv("NAS_EDGE1_API_URL"),
    apiSecret: requiredEnv("NAS_EDGE1_API_SECRET"),
    approvalSigningKey: requiredEnv("NAS_EDGE1_API_SIGNING_KEY"),
  },
  edgesynology2: {
    url: requiredEnv("NAS_EDGE2_API_URL"),
    apiSecret: requiredEnv("NAS_EDGE2_API_SECRET"),
    approvalSigningKey: requiredEnv("NAS_EDGE2_API_SIGNING_KEY"),
  },
};

const ACTIONS = {
  check_disk_space: {
    write: false,
    buildCommand: () => "df -h /volume1",
  },
  check_agent_container: {
    write: false,
    buildCommand: () => "docker ps --format '{{.Image}}|{{.Status}}|{{.Names}}' | grep synology-monitor-agent || true",
  },
  check_cpu_iowait: {
    write: false,
    buildCommand: () => [
      "echo '=== CURRENT CPU IOWAIT ==='",
      "vmstat 1 3 | tail -1 | awk '{print \"vmstat wa=\" $16 \"%\"}'",
      "echo ''",
      "echo '=== /proc/stat SAMPLE ==='",
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
    ].join("\n"),
  },
  tail_drive_server_log: {
    write: false,
    buildCommand: ({ lookbackHours = 2 }) =>
      `tail -n ${clamp(lookbackHours * 40, 40, 300)} /var/log/synologydrive.log 2>/dev/null || true`,
  },
  search_drive_server_log: {
    write: false,
    buildCommand: ({ lookbackHours = 2, filter = "error" }) =>
      `grep -i ${quote(filter)} /var/log/synologydrive.log | tail -n ${clamp(lookbackHours * 40, 40, 300)}`,
  },
  tail_sharesync_log: {
    write: false,
    buildCommand: ({ lookbackHours = 2 }) =>
      `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "$f"; tail -n ${clamp(lookbackHours * 30, 40, 240)} "$f"; done`,
  },
  get_resource_snapshot: {
    write: false,
    buildCommand: () => [
      "echo '=== TOP CPU/MEM ==='",
      "ps aux --sort=-%cpu | head -20",
      "echo '=== DISK IO ==='",
      "awk '{if (($4+$8)>0) print $3, \"reads:\", $4, \"writes:\", $8, \"inprog:\", $12}' /proc/diskstats | grep -E 'sd|md' || true",
      "echo '=== OPEN FILES ON VOLUME ==='",
      "timeout 15 lsof -n +D /volume1 2>/dev/null | awk 'NR>1{print $1,$3,$9}' | sort | uniq -c | sort -rn | head -25 || true",
      "echo '=== NETWORK TOP PEERS ==='",
      "ss -tn state established 2>/dev/null | awk 'NR>1{split($5,a,\":\"); print a[1]}' | sort | uniq -c | sort -rn | head -20 || true",
      "echo '=== SHARESYNC TASKS ==='",
      "for f in /volume1/*/@synologydrive/log/syncfolder.log /volume1/@SynologyDriveShareSync/*/log/syncfolder.log; do [ -f \"$f\" ] || continue; echo \"=== $f ===\"; tail -40 \"$f\"; done 2>/dev/null || true",
      "echo '=== MEMORY PRESSURE ==='",
      "free -h || true",
      "grep -E 'MemAvail|Dirty|Writeback|SwapTotal|SwapFree' /proc/meminfo || true",
    ].join("\n"),
  },
  restart_monitor_agent: {
    write: true,
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose restart",
  },
  stop_monitor_agent: {
    write: true,
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose stop",
  },
  start_monitor_agent: {
    write: true,
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose up -d",
  },
  pull_monitor_agent: {
    write: true,
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose pull",
  },
  build_monitor_agent: {
    write: true,
    buildCommand: () => "cd /volume1/docker/synology-monitor-agent && docker compose build --pull",
  },
  restart_synology_drive_server: {
    write: true,
    buildCommand: () => "/host/usr/syno/bin/synopkg restart SynologyDrive",
  },
  restart_synology_drive_sharesync: {
    write: true,
    buildCommand: () => "/host/usr/syno/bin/synopkg restart SynologyDriveShareSync",
  },
  check_sharesync_status: {
    write: false,
    buildCommand: ({ lookbackHours = 2 }) =>
      `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "=== $f ==="; tail -n ${clamp(lookbackHours * 40, 60, 200)} "$f"; done | grep -A2 -B2 -i "syncing\\|stuck\\|error\\|conflict" || echo "No issues found in recent logs"`,
  },
  check_io_stalls: {
    write: false,
    buildCommand: () => [
      "ps aux | awk '$8 ~ /D/ {print}' | head -30 || echo 'No D-state processes'",
      "top -b -n2 -d1 2>/dev/null | grep -i 'cpu' | tail -1 || vmstat 1 2 | tail -1",
      "cat /proc/diskstats | awk '{if ($4+$8>0) printf \"%-8s reads:%-8d writes:%-8d in_progress:%-4d\\n\", $3, $4, $8, $12}' | grep -E 'sd|md|dm' || true",
      "dmesg -T 2>/dev/null | grep -i 'blocked for more than\\|hung_task\\|INFO: task' | tail -20 || true",
    ].join("\n"),
  },
  check_share_database: {
    write: false,
    buildCommand: () => [
      "/host/usr/syno/sbin/synoshare --enum ALL 2>&1 || echo 'synoshare --enum failed'",
      `/host/usr/syno/sbin/synoshare --enum ALL 2>/dev/null | head -10 | while read -r name; do echo "--- $name ---"; /host/usr/syno/sbin/synoshare --get "$name" 2>&1 | head -15; done`,
    ].join("\n"),
  },
  check_drive_package_health: {
    write: false,
    buildCommand: () => [
      "/host/usr/syno/bin/synopkg status SynologyDrive 2>&1",
      "/host/usr/syno/bin/synopkg status SynologyDriveShareSync 2>&1",
      "/host/usr/syno/bin/synopkg version SynologyDrive 2>&1",
      "ls -la /var/packages/SynologyDrive/target/ 2>/dev/null | head -20",
      "find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -20",
      "find /var/log -maxdepth 3 \\( -name '*drive*' -o -name '*Drive*' \\) 2>/dev/null | head -20",
    ].join("\n"),
  },
  check_kernel_io_errors: {
    write: false,
    buildCommand: () => "dmesg -T 2>/dev/null | grep -iE 'i/o error|scsi|ata.*error|blk_update|buffer i/o|ext4.*error|btrfs.*error|md.*error|raid.*error|sector|fault|stall|hung_task|blocked for' | tail -60 || true",
  },
  search_webapi_log: {
    write: false,
    buildCommand: ({ lookbackHours = 4, filter = "SYNOShare\\|share.*error\\|failed.*share" }) => [
      `grep -iE ${quote(filter)} /var/log/synolog/synowebapi.log 2>/dev/null | tail -n ${clamp(lookbackHours * 40, 60, 300)} || echo 'No matches or file not found'`,
      "grep -iE 'share\\|volume\\|storage\\|mount' /var/log/synolog/synostorage.log 2>/dev/null | tail -40 || true",
      "grep -iE 'error\\|fail\\|warn' /var/log/synolog/synoshare.log 2>/dev/null | tail -40 || true",
    ].join("\n"),
  },
  check_drive_database: {
    write: false,
    buildCommand: () => [
      `find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -10`,
      `find /volume1/@synologydrive/ -maxdepth 3 \\( -name '*.db' -o -name '*.sqlite' \\) 2>/dev/null | head -3 | while read db; do echo "--- $db ($(ls -lh "$db" 2>/dev/null | awk '{print $5}')) ---"; timeout 10 sqlite3 "$db" 'PRAGMA integrity_check;' 2>&1 | head -5 || echo 'timeout or error'; done`,
      `maindb=$(find /volume1/@synologydrive/ -maxdepth 3 \\( -name 'synodrive.db' -o -name 'sync.db' \\) 2>/dev/null | head -1); [ -n "$maindb" ] && echo "DB: $maindb" && timeout 10 sqlite3 "$maindb" '.tables' 2>&1 | head -20 || echo 'Main Drive DB not found'`,
    ].join("\n"),
  },
  search_all_logs: {
    write: false,
    buildCommand: ({ filter = "error" }) => [
      `for f in /var/log/synolog/*.log /var/log/messages /var/log/kern.log /var/log/synologydrive.log /var/log/samba/*.log; do`,
      `  [ -f "$f" ] || continue`,
      `  matches=$(grep -ciE ${quote(filter)} "$f" 2>/dev/null || true)`,
      `  [ "$matches" -gt 0 ] 2>/dev/null && echo "$f: $matches matches" && grep -iE ${quote(filter)} "$f" 2>/dev/null | tail -5 && echo ""`,
      `done`,
    ].join("\n"),
  },
  find_problematic_files: {
    write: false,
    buildCommand: ({ filter = "/volume1" }) => [
      `find ${filter} -maxdepth 8 \\( -name '*:*' -o -name '*\\**' -o -name '*?*' -o -name '*\"*' -o -name '*<*' -o -name '*>*' -o -name '*|*' \\) 2>/dev/null | grep -v '@eaDir' | grep -v '.SynologyWorkingDirectory' | head -50 || echo 'No files with special characters found'`,
      `find ${filter} -maxdepth 8 \\( -name '*conflicted*' -o -name '*.conflict' -o -name '*~conflict*' \\) 2>/dev/null | grep -v '@eaDir' | head -30 || echo 'No conflict files found'`,
    ].join("\n"),
  },
  check_filesystem_health: {
    write: false,
    buildCommand: () => [
      "mount | grep volume || true",
      "df -i /volume1 || true",
      "tune2fs -l $(mount | grep '/volume1 ' | awk '{print $1}') 2>/dev/null | grep -iE 'filesystem|mount count|error|state|journal' || btrfs filesystem show /volume1 2>/dev/null || echo 'Could not determine filesystem details'",
      "cat /proc/mdstat 2>/dev/null || true",
    ].join("\n"),
  },
  check_scheduled_tasks: {
    write: false,
    buildCommand: ({ lookbackHours = 4 }) => [
      "if [ -f /host/usr/syno/etc/schedule/synoscheduler.db ]; then sqlite3 /host/usr/syno/etc/schedule/synoscheduler.db \"SELECT id, name, type, enable, status, last_work_time, next_trigger_time FROM task\" 2>/dev/null | head -40; else echo 'Scheduler DB not at expected path'; fi",
      `grep -iE 'error|fail|exit [^0]' /var/log/synolog/synoscheduler.log 2>/dev/null | tail -${clamp(lookbackHours * 10, 20, 80)} || echo 'No scheduler log found'`,
    ].join("\n"),
  },
  check_backup_status: {
    write: false,
    buildCommand: ({ lookbackHours = 6 }) => [
      "echo '=== HYPER BACKUP METADATA ==='",
      "for f in /volume1/@appdata/HyperBackup/config/task_state.conf /volume1/@appdata/HyperBackup/last_result/backup.last; do [ -f \"$f\" ] && { echo \"--- $f ---\"; sed -n \"1,120p\" \"$f\"; echo; }; done || true",
      "echo '=== HYPER BACKUP LOGS ==='",
      `grep -iE 'error|fail|warn|complete|success|abort|cancel|destination' /var/log/synolog/synobackup.log 2>/dev/null | tail -${clamp(lookbackHours * 20, 40, 200)} || tail -${clamp(lookbackHours * 20, 40, 200)} /volume1/@appdata/HyperBackup/log/synolog/synobackup.log 2>/dev/null || echo 'Backup log not found'`,
    ].join("\n"),
  },
  check_container_io: {
    write: false,
    buildCommand: () => [
      "docker stats --no-stream --format 'table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.BlockIO}}\\t{{.NetIO}}' 2>/dev/null | head -25 || echo 'docker stats unavailable'",
      "for dir in /sys/fs/cgroup/blkio/docker/*/; do [ -d \"$dir\" ] || continue; cid=$(basename \"$dir\"); name=$(docker inspect --format '{{.Name}}' \"$cid\" 2>/dev/null | tr -d '/' || echo \"$cid\"); rb=$(awk '$2==\"Read\"{s+=$3} END{print s+0}' \"$dir/blkio.throttle.io_service_bytes\" 2>/dev/null); wb=$(awk '$2==\"Write\"{s+=$3} END{print s+0}' \"$dir/blkio.throttle.io_service_bytes\" 2>/dev/null); printf '%s %s %s\\n' \"$name\" \"${rb:-0}\" \"${wb:-0}\"; done 2>/dev/null | head -20 || true",
    ].join("\n"),
  },
};

const server = createServer(async (req, res) => {
  try {
    applyCors(req, res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      sendJson(res, 200, { status: "ok", service: "nas-relay" });
      return;
    }

    if (!verifyBearer(req.headers.authorization)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.url === "/catalog" && req.method === "GET") {
      sendJson(res, 200, {
        actions: Object.entries(ACTIONS).map(([name, action]) => ({ name, write: action.write })),
      });
      return;
    }

    if ((req.url === "/actions/preview" || req.url === "/actions/exec") && req.method === "POST") {
      const body = await readJson(req);
      const target = validateTarget(body.target);
      const actionName = validateAction(body.action);
      const action = ACTIONS[actionName];
      const input = body.input && typeof body.input === "object" ? body.input : {};
      const command = action.buildCommand(input);
      const config = NAS_CONFIGS[target];
      const preview = await nasPreview(config, command);

      if (req.url === "/actions/preview") {
        sendJson(res, 200, {
          target,
          action: actionName,
          command,
          write: action.write,
          preview,
        });
        return;
      }

      if (action.write && !verifyAdminSecret(req.headers["x-relay-admin-secret"])) {
        sendJson(res, 403, { error: "admin secret required for write actions" });
        return;
      }

      const timeoutMs = Number.isFinite(body.timeoutMs) ? clamp(body.timeoutMs, 1000, 120000) : 30000;
      const approvalToken = preview.tier >= 2 ? buildNasApprovalToken(config, command, preview.tier) : undefined;
      const result = await nasExec(config, command, preview.tier, approvalToken, timeoutMs);
      sendJson(res, 200, {
        target,
        action: actionName,
        command,
        preview,
        result,
      });
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "unknown error" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NAS relay listening on :${PORT}`);
});

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}`);
  return value;
}

function parseCsv(value) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function verifyBearer(header) {
  const raw = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return safeEqual(raw, RELAY_BEARER_TOKEN);
}

function verifyAdminSecret(value) {
  return safeEqual(Array.isArray(value) ? value[0] : (value ?? ""), RELAY_ADMIN_SECRET);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function validateTarget(value) {
  if (value !== "edgesynology1" && value !== "edgesynology2") {
    throw new Error("invalid target");
  }
  return value;
}

function validateAction(value) {
  if (typeof value !== "string" || !(value in ACTIONS)) {
    throw new Error("invalid action");
  }
  return value;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Relay-Admin-Secret");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function buildNasApprovalToken(config, command, tier) {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = createHmac("sha256", config.approvalSigningKey)
    .update(`${command}\n${expiresAt}`)
    .digest("hex");
  return Buffer.from(JSON.stringify({
    command,
    tier,
    expires_at: expiresAt,
    signature,
  })).toString("base64url");
}

async function nasPreview(config, command) {
  const response = await fetch(`${config.url}/preview`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`nas preview failed: ${response.status} ${text}`);
  }
  const data = await response.json();
  if (data.blocked || data.tier < 1 || data.tier > 3) {
    throw new Error(`command blocked by nas api: ${data.summary ?? "blocked"}`);
  }
  return data;
}

async function nasExec(config, command, tier, approvalToken, timeoutMs) {
  const response = await fetch(`${config.url}/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      command,
      tier,
      timeout_ms: timeoutMs,
      approval_token: approvalToken,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`nas exec failed: ${response.status} ${text}`);
  }
  return response.json();
}
