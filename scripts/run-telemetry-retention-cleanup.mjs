#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const env = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const fileEnv = {
  ...parseEnvFile(path.join(repoRoot, ".env")),
  ...parseEnvFile(path.join(repoRoot, ".env.local")),
  ...parseEnvFile(path.join(repoRoot, "apps/web/.env.local")),
  ...parseEnvFile(path.join(repoRoot, "apps/relay/.env.runtime")),
};

const supabaseUrl =
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  fileEnv.SUPABASE_URL ??
  fileEnv.NEXT_PUBLIC_SUPABASE_URL;

const serviceKey =
  process.env.SUPABASE_SERVICE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  fileEnv.SUPABASE_SERVICE_KEY ??
  fileEnv.SUPABASE_SERVICE_ROLE_KEY;

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const install = args.has("--install");
const cleanup = args.has("--cleanup") || (!dryRun && !install);

const batchLimit = Number(process.env.RETENTION_BATCH_LIMIT ?? "25000");
const maxBatches = Number(process.env.RETENTION_MAX_BATCHES ?? "10");

// This script issues bulk deletes, so it must never guess its target. There is no
// default URL: an earlier run silently fell back to a hardcoded default and purged
// ~27.8M rows from the wrong (pre-migration) project. Fail loudly instead.
if (!supabaseUrl) {
  throw new Error(
    "SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required. Set it explicitly — " +
      "this script deletes rows and will not guess a target project."
  );
}

// qnjimovrsaacneqkggsn was the pre-2026-06-21 Ohio project, deleted after the
// Virginia migration. Anything still pointing at it is stale config, not a target.
if (supabaseUrl.includes("qnjimovrsaacneqkggsn")) {
  throw new Error(
    `Refusing to run against ${supabaseUrl}: that project was retired in the ` +
      "2026-06-21 Ohio->Virginia migration and no longer exists. Point " +
      "SUPABASE_URL at the current project (see AGENTS.md)."
  );
}

if (!serviceKey) {
  throw new Error(
    "SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY is required. " +
      "Pass --dry-run only after providing credentials; the script never prints the key."
  );
}

console.log(`Target project: ${supabaseUrl}`);

async function postRpc(functionName, body) {
  const response = await fetch(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/${functionName}`, {
    method: "POST",
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${functionName} failed (${response.status}): ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function execSql(sql) {
  return postRpc("exec_sql", { sql });
}

function splitSqlStatements(sql) {
  const statements = [];
  let current = "";
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarTag = null;

  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (lineComment) {
      current += ch;
      if (ch === "\n") lineComment = false;
      continue;
    }

    if (blockComment) {
      current += ch;
      if (ch === "*" && next === "/") {
        current += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }

    if (dollarTag) {
      current += ch;
      if (sql.startsWith(dollarTag, i)) {
        current += sql.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }

    if (!singleQuoted && !doubleQuoted && ch === "-" && next === "-") {
      current += ch + next;
      i += 1;
      lineComment = true;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && ch === "/" && next === "*") {
      current += ch + next;
      i += 1;
      blockComment = true;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && ch === "$") {
      const match = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
      if (match) {
        dollarTag = match[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }

    if (singleQuoted && ch === "'" && next === "'") {
      current += ch + next;
      i += 1;
      continue;
    }

    if (!doubleQuoted && ch === "'") {
      singleQuoted = !singleQuoted;
      current += ch;
      continue;
    }

    if (!singleQuoted && ch === '"') {
      doubleQuoted = !doubleQuoted;
      current += ch;
      continue;
    }

    if (!singleQuoted && !doubleQuoted && ch === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

if (install) {
  const migration = fs.readFileSync(
    path.join(repoRoot, "supabase/migrations/00042_telemetry_retention_cleanup.sql"),
    "utf8"
  );
  const statements = splitSqlStatements(migration);
  for (const [index, statement] of statements.entries()) {
    await execSql(statement);
    console.log(`Installed statement ${index + 1}/${statements.length}`);
  }
}

if (dryRun) {
  const result = await postRpc("telemetry_retention_estimates", {});
  console.table(result);
}

if (cleanup) {
  const result = await postRpc("cleanup_high_volume_telemetry", {
    p_max_batches_per_table: maxBatches,
    p_batch_limit: batchLimit,
  });

  console.table(result);
}
