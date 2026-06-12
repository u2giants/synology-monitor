/**
 * HTTP client for the NAS API (three-tier shell execution service).
 * The NAS API runs as a Docker container on each Synology NAS and accepts
 * bearer-authenticated POST requests to execute shell commands.
 *
 * Tier 1 — read-only, auto-executes.
 * Tier 2 — service ops (docker/synopkg restarts), requires approval token.
 * Tier 3 — file ops touching /volume*, requires approval token.
 */

import { createHmac } from "node:crypto";
import type { NasTarget } from "@/lib/server/tools";

export interface NasApiConfig {
  /** Logical NAS name used in issue.affected_nas (e.g. "edgesynology1") */
  name: string;
  /** Base URL of the nas-api container, e.g. "http://192.168.1.100:7734" */
  url: string;
  /** Bearer token — must match NAS_API_SECRET on the NAS */
  apiSecret: string;
  /** HMAC key for approval tokens — must match NAS_API_APPROVAL_SIGNING_KEY on the NAS */
  approvalSigningKey: string;
}

export interface NasApiExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
  timed_out?: boolean;
}

export interface NasApiPreviewResult {
  tier: number;   // -1=blocked, 1=read, 2=service, 3=file
  summary: string;
  blocked: boolean;
}

export interface NasCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Reads NAS API configs from environment variables. */
export function getNasApiConfigs(): NasApiConfig[] {
  const slots: Array<{ name: string; prefix: string }> = [
    { name: "edgesynology1", prefix: "NAS_EDGE1" },
    { name: "edgesynology2", prefix: "NAS_EDGE2" },
  ];

  return slots
    .map(({ name, prefix }) => ({
      name,
      url: process.env[`${prefix}_API_URL`] ?? "",
      apiSecret: process.env[`${prefix}_API_SECRET`] ?? "",
      approvalSigningKey: process.env[`${prefix}_API_SIGNING_KEY`] ?? "",
    }))
    .filter((c) => c.url && c.apiSecret);
}

/**
 * Resolves the NAS API config for a given NAS name (or alias).
 * Returns null if no config is available for that NAS.
 */
export function resolveNasApiConfig(nasName: string): NasApiConfig | null {
  return (
    getNasApiConfigs().find(
      (c) => c.name === nasName || nasName.includes(c.name) || c.name.includes(nasName),
    ) ?? null
  );
}

/**
 * Builds a base64url-encoded HMAC-signed approval token for a Tier 2/3 command.
 * The token is verified by the NAS API before executing the command.
 *
 * Token format mirrors auth.go ApprovalToken:
 *   { command, tier, expires_at, signature }
 * Signature = HMAC-SHA256(approvalSigningKey, command + "\n" + expires_at)
 */
export function buildNasApiApprovalToken(
  config: NasApiConfig,
  command: string,
  tier: 2 | 3,
): string {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = createHmac("sha256", config.approvalSigningKey)
    .update(`${command}\n${expiresAt}`)
    .digest("hex");

  const token = { command, tier, expires_at: expiresAt, signature };
  return Buffer.from(JSON.stringify(token)).toString("base64url");
}

/**
 * Calls POST /exec on the NAS API.
 * For Tier 1 commands the approval token is not required.
 * For Tier 2/3 commands pass the token returned by buildNasApiApprovalToken.
 */
export async function nasApiExec(
  config: NasApiConfig,
  command: string,
  tier: 1 | 2 | 3,
  approvalToken?: string,
  timeoutMs = 30_000,
): Promise<NasApiExecResult> {
  const body: Record<string, unknown> = { command, tier, timeout_ms: timeoutMs };
  if (approvalToken) body.approval_token = approvalToken;

  const response = await fetch(`${config.url}/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiSecret}`,
      Connection: "close",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs + 8_000),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(`NAS API /exec error ${response.status}: ${err.error ?? response.statusText}`);
  }

  return response.json() as Promise<NasApiExecResult>;
}

/**
 * Calls POST /preview on the NAS API — classifies a command's tier
 * without executing it. Used to build the operator approval prompt.
 */
export async function nasApiPreview(
  config: NasApiConfig,
  command: string,
): Promise<NasApiPreviewResult> {
  const response = await fetch(`${config.url}/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiSecret}`,
      Connection: "close",
    },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
    throw new Error(`NAS API /preview error ${response.status}: ${err.error ?? response.statusText}`);
  }

  return response.json() as Promise<NasApiPreviewResult>;
}

export async function executeNasCommand(
  target: NasTarget,
  command: string,
  timeoutMs = 90_000,
): Promise<NasCommandResult> {
  const config = resolveNasApiConfig(target);
  if (!config) {
    throw new Error(`NAS API config is missing for target: ${target}`);
  }

  const preview = await nasApiPreview(config, command);
  if (preview.blocked || preview.tier < 1 || preview.tier > 3) {
    throw new Error(`Command is blocked by NAS API validation: ${preview.summary}`);
  }

  const tier = preview.tier as 1 | 2 | 3;
  let approvalToken: string | undefined;
  if (tier === 2 || tier === 3) {
    approvalToken = buildNasApiApprovalToken(config, command, tier);
  }

  const result = await nasApiExec(config, command, tier, approvalToken, timeoutMs);
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.exit_code,
  };
}

export async function executeNasCommandOnConfig(
  config: NasApiConfig,
  command: string,
  timeoutMs = 90_000,
): Promise<NasCommandResult> {
  const preview = await nasApiPreview(config, command);
  if (preview.blocked || preview.tier < 1 || preview.tier > 3) {
    throw new Error(`Command is blocked by NAS API validation: ${preview.summary}`);
  }

  const tier = preview.tier as 1 | 2 | 3;
  let approvalToken: string | undefined;
  if (tier === 2 || tier === 3) {
    approvalToken = buildNasApiApprovalToken(config, command, tier);
  }

  const result = await nasApiExec(config, command, tier, approvalToken, timeoutMs);
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exitCode: result.exit_code,
  };
}

// ─── File-inventory jobs (Phase 1) ────────────────────────────────────────────
//
// These hit the native nas-api /jobs/inventory/* REST endpoints (NOT /exec).
// State-changing ops carry an HMAC approval token in the X-Approval-Token header
// signed over a canonical op string that MUST byte-match nas-api's
// jobs.CanonicalOpString and nas-mcp's job-client.ts (Appendix A of
// docs/synology-archive-implementation.md).

const INVENTORY_TIMEOUT_MS = 15_000;

export interface InventoryStartInput {
  shares: string[];
  cutoff_years?: number[];
  overlay?: boolean;
  protect_newer_than?: string;
  max_files_per_second?: number;
  use_idle_io_priority?: boolean;
  sleep_every_files?: number;
  sleep_ms?: number;
  scheduled_for?: string;
}

type InventoryOp = "start" | "schedule" | "cancel";

function canonShares(shares: string[]): string {
  return [...shares].sort().join(",");
}
function canonYears(years: number[]): string {
  return [...years].sort((a, b) => a - b).join(",");
}

interface CanonicalParams {
  shares: string[];
  cutoffYears: number[];
  overlayEffective: boolean;
  protect: string;
  scheduledFor: string;
}

function canonicalInventoryOp(op: InventoryOp, nas: string, jobId: string, p?: CanonicalParams): string {
  if (op === "cancel") return `inventory.cancel|nas=${nas}|job_id=${jobId}`;
  const params = p!;
  const base =
    `inventory.${op}|nas=${nas}|shares=${canonShares(params.shares)}` +
    `|cutoff=${canonYears(params.cutoffYears)}|overlay=${params.overlayEffective ? "true" : "false"}` +
    `|protect=${params.protect}`;
  if (op === "schedule") return `${base}|scheduled_for=${params.scheduledFor}`;
  return base;
}

// Normalizes raw input into the body sent to nas-api AND the matching canonical
// params, so the signed string and the request body never drift.
function normalizeInventoryBody(raw: InventoryStartInput): { body: Record<string, unknown>; params: CanonicalParams } {
  const shares = (raw.shares ?? []).map((s) => s.trim()).filter(Boolean);
  const cutoffYears = (raw.cutoff_years ?? []).filter((n) => Number.isFinite(n));
  const overlayEffective = raw.overlay !== false; // undefined → true
  const useIdleIo = raw.use_idle_io_priority !== false; // undefined → true
  const protect = (raw.protect_newer_than ?? "").trim();
  const scheduledFor = (raw.scheduled_for ?? "").trim();

  const body: Record<string, unknown> = {
    shares,
    cutoff_years: cutoffYears,
    overlay: overlayEffective,
    protect_newer_than: protect,
    use_idle_io_priority: useIdleIo,
  };
  if (raw.max_files_per_second !== undefined) body.max_files_per_second = raw.max_files_per_second;
  if (raw.sleep_every_files !== undefined) body.sleep_every_files = raw.sleep_every_files;
  if (raw.sleep_ms !== undefined) body.sleep_ms = raw.sleep_ms;
  if (scheduledFor) body.scheduled_for = scheduledFor;

  return { body, params: { shares, cutoffYears, overlayEffective, protect, scheduledFor } };
}

async function inventoryFetch(
  config: NasApiConfig,
  method: "GET" | "POST",
  path: string,
  opts: { body?: Record<string, unknown>; approvalToken?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.apiSecret}` };
  if (opts.body) headers["Content-Type"] = "application/json";
  if (opts.approvalToken) headers["X-Approval-Token"] = opts.approvalToken;
  headers.Connection = "close";
  return fetch(`${config.url}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(INVENTORY_TIMEOUT_MS),
  });
}

export async function startInventory(config: NasApiConfig, raw: InventoryStartInput): Promise<Response> {
  const { body, params } = normalizeInventoryBody(raw);
  const canonical = canonicalInventoryOp("start", config.name, "", params);
  const token = buildNasApiApprovalToken(config, canonical, 2);
  return inventoryFetch(config, "POST", "/jobs/inventory", { body, approvalToken: token });
}

export async function scheduleInventory(config: NasApiConfig, raw: InventoryStartInput): Promise<Response> {
  const { body, params } = normalizeInventoryBody(raw);
  const canonical = canonicalInventoryOp("schedule", config.name, "", params);
  const token = buildNasApiApprovalToken(config, canonical, 2);
  return inventoryFetch(config, "POST", "/jobs/inventory/schedule", { body, approvalToken: token });
}

export async function listInventory(config: NasApiConfig): Promise<Response> {
  return inventoryFetch(config, "GET", "/jobs/inventory");
}

export async function statusInventory(config: NasApiConfig, id: string): Promise<Response> {
  return inventoryFetch(config, "GET", `/jobs/inventory/${encodeURIComponent(id)}`);
}

export async function cancelInventory(config: NasApiConfig, id: string): Promise<Response> {
  const canonical = canonicalInventoryOp("cancel", config.name, id);
  const token = buildNasApiApprovalToken(config, canonical, 2);
  return inventoryFetch(config, "POST", `/jobs/inventory/${encodeURIComponent(id)}/cancel`, { approvalToken: token });
}

export async function fetchInventoryResult(config: NasApiConfig, id: string, query: URLSearchParams): Promise<Response> {
  const qs = query.toString();
  return inventoryFetch(config, "GET", `/jobs/inventory/${encodeURIComponent(id)}/result${qs ? `?${qs}` : ""}`);
}

// ─── Archive move (Phase 2) ───────────────────────────────────────────────────
//
// Move ops reuse inventoryFetch's transport. Canonical op strings MUST byte-match
// nas-api jobs.MoveCanonicalOpString and nas-mcp's job-client.ts. Plan/cancel are
// tier 2; execute/rollback are tier 3.

export interface MovePlanInput {
  share: string;
  mode?: string; // "move" | "clean_empty_dirs"
  roots?: string[];
  include_globs?: string[];
  exclude_globs?: string[];
  cutoff_years?: number[];
  protect_newer_than?: string;
  force_archive?: boolean;
  prune_emptied_source_dirs?: boolean;
  remove_preexisting_empty_dirs?: boolean;
}

function moveCanonicalPlan(nas: string, p: Required<Pick<MovePlanInput, "share">> & {
  mode: string;
  roots: string[];
  include: string[];
  exclude: string[];
  cutoffYears: number[];
  protect: string;
  forceArchive: boolean;
  prune: boolean;
  removePreexisting: boolean;
}): string {
  return (
    `move.plan|nas=${nas}|share=${p.share}|mode=${p.mode}` +
    `|roots=${canonShares(p.roots)}|include=${canonShares(p.include)}|exclude=${canonShares(p.exclude)}` +
    `|cutoff=${canonYears(p.cutoffYears)}|protect=${p.protect}` +
    `|force=${p.forceArchive ? "true" : "false"}` +
    `|prune=${p.prune ? "true" : "false"}|rmpre=${p.removePreexisting ? "true" : "false"}`
  );
}

function prepMovePlan(config: NasApiConfig, raw: MovePlanInput) {
  const roots = (raw.roots ?? []).map((r) => r.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  const p = {
    share: (raw.share ?? "").trim(),
    mode: (raw.mode ?? "move") || "move",
    roots,
    include: (raw.include_globs ?? []).map((s) => s.trim()).filter(Boolean),
    exclude: (raw.exclude_globs ?? []).map((s) => s.trim()).filter(Boolean),
    cutoffYears: (raw.cutoff_years ?? []).filter((n) => Number.isFinite(n)),
    protect: (raw.protect_newer_than ?? "").trim(),
    forceArchive: raw.force_archive === true,
    prune: raw.prune_emptied_source_dirs !== false, // undefined → true
    removePreexisting: raw.remove_preexisting_empty_dirs === true, // undefined → false
  };
  const body: Record<string, unknown> = {
    share: p.share,
    mode: p.mode,
    roots: p.roots,
    include_globs: p.include,
    exclude_globs: p.exclude,
    cutoff_years: p.cutoffYears,
    protect_newer_than: p.protect,
    force_archive: p.forceArchive,
    prune_emptied_source_dirs: p.prune,
    remove_preexisting_empty_dirs: p.removePreexisting,
  };
  return { body, canonical: moveCanonicalPlan(config.name, p) };
}

export async function planMove(config: NasApiConfig, raw: MovePlanInput): Promise<Response> {
  const { body, canonical } = prepMovePlan(config, raw);
  const token = buildNasApiApprovalToken(config, canonical, 2);
  return inventoryFetch(config, "POST", "/jobs/archive-move/plan", { body, approvalToken: token });
}

export async function listMoves(config: NasApiConfig): Promise<Response> {
  return inventoryFetch(config, "GET", "/jobs/archive-move");
}

export async function moveTree(config: NasApiConfig, share: string, path: string): Promise<Response> {
  const qs = new URLSearchParams({ share, path });
  return inventoryFetch(config, "GET", `/jobs/archive-move/tree?${qs.toString()}`);
}

export async function moveStatus(config: NasApiConfig, id: string): Promise<Response> {
  return inventoryFetch(config, "GET", `/jobs/archive-move/${encodeURIComponent(id)}`);
}

export async function moveManifest(config: NasApiConfig, id: string, query: URLSearchParams): Promise<Response> {
  const qs = query.toString();
  return inventoryFetch(config, "GET", `/jobs/archive-move/${encodeURIComponent(id)}/manifest${qs ? `?${qs}` : ""}`);
}

export async function moveResult(config: NasApiConfig, id: string, query: URLSearchParams): Promise<Response> {
  const qs = query.toString();
  return inventoryFetch(config, "GET", `/jobs/archive-move/${encodeURIComponent(id)}/result${qs ? `?${qs}` : ""}`);
}

export async function verifyMove(config: NasApiConfig, id: string): Promise<Response> {
  return inventoryFetch(config, "POST", `/jobs/archive-move/${encodeURIComponent(id)}/verify`);
}

function moveTokenFor(config: NasApiConfig, op: "execute" | "cancel" | "rollback", id: string): string {
  const canonical = `move.${op}|nas=${config.name}|job_id=${id}`;
  const tier: 2 | 3 = op === "cancel" ? 2 : 3;
  return buildNasApiApprovalToken(config, canonical, tier);
}

export async function executeMove(config: NasApiConfig, id: string): Promise<Response> {
  return inventoryFetch(config, "POST", `/jobs/archive-move/${encodeURIComponent(id)}/execute`, { approvalToken: moveTokenFor(config, "execute", id) });
}

export async function cancelMove(config: NasApiConfig, id: string): Promise<Response> {
  return inventoryFetch(config, "POST", `/jobs/archive-move/${encodeURIComponent(id)}/cancel`, { approvalToken: moveTokenFor(config, "cancel", id) });
}

export async function rollbackMove(config: NasApiConfig, id: string): Promise<Response> {
  return inventoryFetch(config, "POST", `/jobs/archive-move/${encodeURIComponent(id)}/rollback`, { approvalToken: moveTokenFor(config, "rollback", id) });
}

export async function collectNasDiagnostics(lookbackHours = 2) {
  const configs = getNasApiConfigs();
  const driveLines = Math.max(60, Math.min(300, lookbackHours * 50));
  const shareSyncLines = Math.max(40, Math.min(240, lookbackHours * 30));
  const command = [
    "set -e",
    "echo '## hostname'",
    "hostname",
    "echo '## uptime'",
    "uptime",
    "echo '## volume1'",
    "df -h /volume1 2>/dev/null || true",
    "echo '## agent'",
    "/usr/syno/bin/synowebapi --exec api=SYNO.Docker.Container version=1 method=list 2>/dev/null | grep -E 'synology-monitor-(agent|nas-api)' || true",
    "echo '## drive_log'",
    `tail -n ${driveLines} /var/log/synologydrive.log 2>/dev/null || true`,
    "echo '## sharesync_log'",
    `for f in /volume1/*/@synologydrive/log/syncfolder.log; do [ -f "$f" ] || continue; echo "$f"; tail -n ${shareSyncLines} "$f"; done 2>/dev/null || true`,
  ].join("\n");

  return Promise.all(
    configs.map(async (config) => {
      try {
        const result = await nasApiExec(config, command, 1, undefined, 30_000);
        return {
          target: config.name,
          ok: result.exit_code === 0,
          stdout: result.stdout.trim(),
          stderr: result.stderr.trim(),
        };
      } catch (error) {
        return {
          target: config.name,
          ok: false,
          stdout: "",
          stderr: error instanceof Error ? error.message : "Unknown NAS API error",
        };
      }
    }),
  );
}
