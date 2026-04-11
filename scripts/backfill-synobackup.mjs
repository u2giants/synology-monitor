import { execFileSync } from "node:child_process";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "https://qnjimovrsaacneqkggsn.supabase.co";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFuamltb3Zyc2FhY25lcWtnZ3NuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTM2MDE3NSwiZXhwIjoyMDkwOTM2MTc1fQ.3EaEht21dAjN3PFIX6glJkBb1BTshzvZkU5m1yab07c";

const TARGETS = [
  { nasId: "4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001", host: "100.107.131.35", port: "22", user: "popdam", password: "D@Mp0p123", sudoPassword: "D@Mp0p123" },
  { nasId: "9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002", host: "100.107.131.36", port: "1904", user: "popdam", password: "D@Mp0p123", sudoPassword: "D@Mp0p123" },
];

function sshReadBackupLog(target) {
  const remote = `printf '%s\\n' '${target.sudoPassword}' | sudo -S -p '' sh -lc 'cat /var/log/synolog/synobackup.log /var/log/synolog/synobackup.log.0 2>/dev/null'`;
  return execFileSync(
    "sshpass",
    [
      "-p",
      target.password,
      "ssh",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-p",
      target.port,
      `${target.user}@${target.host}`,
      remote,
    ],
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
}

function parseTimestamp(raw) {
  const match = raw.match(/^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return new Date().toISOString();
  const [, y, m, d, hh, mm, ss] = match;
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))).toISOString();
}

function parseLine(line, nasId) {
  const match = line.match(/^(info|err|warn)\t(\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2})\tSYSTEM:\t(.+)$/i);
  if (!match) return null;

  const [, rawSeverity, rawTimestamp, message] = match;
  const lower = message.toLowerCase();
  const severity =
    rawSeverity.toLowerCase() === "err" ? "error" :
    rawSeverity.toLowerCase() === "warn" ? "warning" :
    lower.includes("failed") || lower.includes("exception") || lower.includes("error") ? "error" :
    "info";

  const taskMatch = message.match(/\[([^\]]+)\](?:\[(.+?)\])?/);
  const metadata = {
    component: "hyper_backup",
    action:
      lower.includes("backup task started") ? "backup_started" :
      lower.includes("backup task finished successfully") ? "backup_finished" :
      lower.includes("backup integrity check has started") ? "backup_integrity_started" :
      lower.includes("backup integrity check is finished") ? "backup_integrity_finished" :
      lower.includes("exception occurred while backing up data") || lower.includes("failed") ? "backup_failure" :
      "backup_event",
    task_name: taskMatch?.[2] || taskMatch?.[1] || "backup",
  };

  return {
    nas_id: nasId,
    source: "backup",
    severity,
    message,
    metadata,
    logged_at: parseTimestamp(rawTimestamp),
    ingested_at: parseTimestamp(rawTimestamp),
  };
}

async function insertRows(rows) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/nas_logs`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates",
    },
    body: JSON.stringify(rows),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Supabase insert failed: ${response.status} ${text}`);
  }
}

async function main() {
  for (const target of TARGETS) {
    const raw = sshReadBackupLog(target);
    const rows = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseLine(line, target.nasId))
      .filter(Boolean);

    const deduped = Array.from(new Map(rows.map((row) => [`${row.nas_id}|${row.logged_at}|${row.message}`, row])).values());
    for (let i = 0; i < deduped.length; i += 500) {
      await insertRows(deduped.slice(i, i + 500));
    }

    console.log(JSON.stringify({ nasId: target.nasId, inserted: deduped.length }));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
