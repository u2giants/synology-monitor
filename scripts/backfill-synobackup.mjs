import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_SUPABASE_URL = "https://qnjimovrsaacneqkggsn.supabase.co";
const DEFAULT_SUPABASE_SERVICE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFuamltb3Zyc2FhY25lcWtnZ3NuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTM2MDE3NSwiZXhwIjoyMDkwOTM2MTc1fQ.3EaEht21dAjN3PFIX6glJkBb1BTshzvZkU5m1yab07c";

const dotenvPaths = [
  ".env",
  "apps/web/.env.local",
  "apps/web/.env",
  "apps/web/.env.example",
  "deploy/synology/nas-1.env.example",
  "deploy/synology/nas-2.env.example",
];

const fileEnv = loadFileEnv();
const SUPABASE_URL = process.env.SUPABASE_URL ?? fileEnv.SUPABASE_URL ?? DEFAULT_SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY
  ?? process.env.SUPABASE_SERVICE_ROLE_KEY
  ?? fileEnv.SUPABASE_SERVICE_KEY
  ?? fileEnv.SUPABASE_SERVICE_ROLE_KEY
  ?? DEFAULT_SUPABASE_SERVICE_KEY;

const DEFAULT_TARGETS = [
  { nasId: "4f1d7e2a-7d5d-4d5f-8b55-0f8efb0d1001", prefix: "NAS_EDGE1" },
  { nasId: "9dbd4646-5f4e-4fa0-8f44-1d0dbe6f1002", prefix: "NAS_EDGE2" },
];

function requiredEnv(name) {
  const value = process.env[name] ?? fileEnv[name];
  if (!value) {
    throw new Error(`Required env var ${name} is not set.`);
  }
  return value;
}

function loadFileEnv() {
  const loaded = {};

  for (const relativePath of dotenvPaths) {
    const filePath = resolve(relativePath);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eqIndex = line.indexOf("=");
      if (eqIndex <= 0) continue;

      const key = line.slice(0, eqIndex).trim();
      if (!key || loaded[key] !== undefined) continue;

      let value = line.slice(eqIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      loaded[key] = value;
    }
  }

  return loaded;
}

function loadTargets() {
  return DEFAULT_TARGETS.map(({ nasId, prefix }) => ({
    nasId: process.env[`${prefix}_NAS_ID`] ?? fileEnv[`${prefix}_NAS_ID`] ?? nasId,
    name: prefix.toLowerCase(),
    apiUrl: requiredEnv(`${prefix}_API_URL`),
    apiSecret: requiredEnv(`${prefix}_API_SECRET`),
  }));
}

async function readBackupLog(target) {
  const command = [
    "sh -lc",
    "'",
    "[ -f /host/log/synolog/synobackup.log ] && cat /host/log/synolog/synobackup.log;",
    "[ -f /host/log/synolog/synobackup.log.0 ] && cat /host/log/synolog/synobackup.log.0;",
    "[ -f /host/log/synobackup.log ] && cat /host/log/synobackup.log;",
    "[ -f /host/log/synobackup.log.0 ] && cat /host/log/synobackup.log.0",
    "'",
  ].join(" ");
  const response = await fetch(`${target.apiUrl}/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      command,
      tier: 1,
      timeout_ms: 30_000,
    }),
    signal: AbortSignal.timeout(38_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`NAS API read failed for ${target.name}: ${response.status} ${text}`);
  }

  const payload = await response.json();
  if (typeof payload?.stdout !== "string") {
    throw new Error(`NAS API read returned no stdout for ${target.name}.`);
  }

  return payload.stdout;
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
    rawSeverity.toLowerCase() === "err"
      ? "error"
      : rawSeverity.toLowerCase() === "warn"
        ? "warning"
        : lower.includes("failed") || lower.includes("exception") || lower.includes("error")
          ? "error"
          : "info";

  const taskMatch = message.match(/\[([^\]]+)\](?:\[(.+?)\])?/);
  const metadata = {
    component: "hyper_backup",
    action:
      lower.includes("backup task started")
        ? "backup_started"
        : lower.includes("backup task finished successfully")
          ? "backup_finished"
          : lower.includes("backup integrity check has started")
            ? "backup_integrity_started"
            : lower.includes("backup integrity check is finished")
              ? "backup_integrity_finished"
              : lower.includes("exception occurred while backing up data") || lower.includes("failed")
                ? "backup_failure"
                : "backup_event",
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required.");
  }

  const targets = loadTargets();

  for (const target of targets) {
    const raw = await readBackupLog(target);
    const rows = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseLine(line, target.nasId))
      .filter(Boolean);

    const deduped = Array.from(
      new Map(rows.map((row) => [`${row.nas_id}|${row.logged_at}|${row.message}`, row])).values(),
    );

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
