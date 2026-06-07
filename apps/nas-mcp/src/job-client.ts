// Native client for the nas-api file-inventory job endpoints. Unlike the shell
// tools (which go /preview → /exec), inventory tools hit /jobs/inventory/* REST
// endpoints directly. State-changing ops carry an HMAC approval token in the
// X-Approval-Token header, signed over a canonical op string that MUST byte-match
// nas-api's jobs.CanonicalOpString and web's nas-api-client.ts (Appendix A of
// docs/synology-archive-implementation.md).
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { type NasConfig, buildApprovalToken } from "./nas-client.js";
import { type McpToolDef, type JobOp } from "./nas-tools.js";

const JOB_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

// ── Canonical op string (byte-match Go/web) ────────────────────────────────────

interface InventoryParams {
  shares: string[];
  cutoffYears: number[];
  overlayEffective: boolean;
  protect: string;
  scheduledFor: string;
  maxFilesPerSec?: number;
  useIdleIo: boolean;
  sleepEveryFiles?: number;
  sleepMs?: number;
}

function canonShares(shares: string[]): string {
  return [...shares].sort().join(",");
}
function canonYears(years: number[]): string {
  return [...years].sort((a, b) => a - b).join(",");
}

export function canonicalOpString(op: JobOp, nas: string, jobId: string, p?: InventoryParams): string {
  if (op === "cancel") return `inventory.cancel|nas=${nas}|job_id=${jobId}`;
  const params = p!;
  const base =
    `inventory.${op}|nas=${nas}|shares=${canonShares(params.shares)}` +
    `|cutoff=${canonYears(params.cutoffYears)}|overlay=${params.overlayEffective ? "true" : "false"}` +
    `|protect=${params.protect}`;
  if (op === "schedule") return `${base}|scheduled_for=${params.scheduledFor}`;
  return base;
}

// ── Input parsing ──────────────────────────────────────────────────────────────

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

function toYearArray(v: unknown): number[] {
  return toStringArray(v)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

function parseInventoryInput(input: Record<string, unknown>): InventoryParams {
  return {
    shares: toStringArray(input.shares),
    cutoffYears: toYearArray(input.cutoff_years),
    overlayEffective: input.overlay !== false, // undefined → true
    protect: String(input.protect_newer_than ?? "").trim(),
    scheduledFor: String(input.scheduled_for ?? "").trim(),
    maxFilesPerSec: typeof input.max_files_per_second === "number" ? input.max_files_per_second : undefined,
    useIdleIo: input.use_idle_io_priority !== false, // undefined → true
    sleepEveryFiles: typeof input.sleep_every_files === "number" ? input.sleep_every_files : undefined,
    sleepMs: typeof input.sleep_ms === "number" ? input.sleep_ms : undefined,
  };
}

// nas-api StartRequest body (JSON tags match Go).
function startBody(p: InventoryParams, includeSchedule: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    shares: p.shares,
    cutoff_years: p.cutoffYears,
    overlay: p.overlayEffective,
    protect_newer_than: p.protect,
    use_idle_io_priority: p.useIdleIo,
  };
  if (p.maxFilesPerSec !== undefined) body.max_files_per_second = p.maxFilesPerSec;
  if (p.sleepEveryFiles !== undefined) body.sleep_every_files = p.sleepEveryFiles;
  if (p.sleepMs !== undefined) body.sleep_ms = p.sleepMs;
  if (includeSchedule) body.scheduled_for = p.scheduledFor;
  return body;
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

interface JobHttpOptions {
  body?: Record<string, unknown>;
  approvalToken?: string;
}

async function jobHttp(
  config: NasConfig,
  method: "GET" | "POST",
  path: string,
  opts: JobHttpOptions = {},
): Promise<unknown> {
  const url = new URL(path, config.url);
  const payload = opts.body ? JSON.stringify(opts.body) : undefined;
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiSecret}`,
    Connection: "close",
  };
  if (payload) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = String(Buffer.byteLength(payload));
  }
  if (opts.approvalToken) headers["X-Approval-Token"] = opts.approvalToken;

  return new Promise<unknown>((resolve, reject) => {
    const req = requestImpl(url, { method, agent: false, headers }, (res) => {
      res.setEncoding("utf8");
      let raw = "";
      res.on("data", (chunk: string) => {
        raw += chunk;
        if (raw.length > MAX_RESPONSE_BYTES) {
          res.destroy(new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes`));
        }
      });
      res.on("end", () => {
        const status = res.statusCode ?? 500;
        let parsed: unknown = raw;
        try {
          parsed = JSON.parse(raw);
        } catch {
          /* keep raw text */
        }
        if (status < 200 || status >= 300) {
          const msg = typeof parsed === "object" && parsed && "error" in parsed ? (parsed as { error: string }).error : raw.trim();
          reject(new Error(`HTTP ${status}: ${msg}`));
          return;
        }
        resolve(parsed);
      });
      res.on("error", reject);
    });
    req.setTimeout(JOB_TIMEOUT_MS, () => req.destroy(new Error(`request timed out after ${JOB_TIMEOUT_MS}ms`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Dispatch ───────────────────────────────────────────────────────────────────

/**
 * Executes a native inventory job tool against one NAS. Read ops call the
 * endpoint directly; write ops (start/schedule/cancel) require a tier-2 approval
 * token and gate on confirmed:true with a preview, mirroring the shell-tool flow.
 */
export async function runJobTool(
  tool: McpToolDef,
  input: Record<string, unknown>,
  config: NasConfig,
): Promise<string> {
  const op = tool.job!.op;
  const jobId = String(input.job_id ?? "").trim();
  const tag = `[${config.name}]`;

  try {
    switch (op) {
      case "status": {
        if (jobId) return `${tag} ${formatJob(await jobHttp(config, "GET", `/jobs/inventory/${encodeURIComponent(jobId)}`))}`;
        const list = (await jobHttp(config, "GET", "/jobs/inventory")) as { jobs?: unknown[] };
        return `${tag} ${formatList(list.jobs ?? [])}`;
      }
      case "result": {
        if (!jobId) return `${tag} job_id is required for fetch_file_inventory_result.`;
        const kind = String(input.result ?? "yearly");
        const q = new URLSearchParams({ result: kind });
        if (input.limit !== undefined) q.set("limit", String(input.limit));
        if (input.cursor !== undefined) q.set("cursor", String(input.cursor));
        const r = await jobHttp(config, "GET", `/jobs/inventory/${encodeURIComponent(jobId)}/result?${q.toString()}`);
        return `${tag} ${formatResult(kind, r)}`;
      }
      case "cancel": {
        if (!jobId) return `${tag} job_id is required for cancel_file_inventory.`;
        if (!input.confirmed) {
          return `${tag} This will cancel inventory job ${jobId}. Call again with confirmed: true to proceed.`;
        }
        const canonical = canonicalOpString("cancel", config.name, jobId);
        const token = buildApprovalToken(config, canonical, 2);
        await jobHttp(config, "POST", `/jobs/inventory/${encodeURIComponent(jobId)}/cancel`, { approvalToken: token });
        return `${tag} Cancellation requested for job ${jobId}.`;
      }
      case "start":
      case "schedule": {
        const p = parseInventoryInput(input);
        if (p.shares.length === 0) return `${tag} shares is required (comma-separated allowlisted share names).`;
        if (op === "schedule" && !p.scheduledFor) return `${tag} scheduled_for (RFC3339 UTC) is required for schedule_file_inventory.`;
        if (!input.confirmed) {
          const when = op === "schedule" ? ` at ${p.scheduledFor}` : "";
          return [
            `${tag} This will ${op} a read-only file inventory${when} on ${config.name}.`,
            `Shares: ${p.shares.join(", ")}`,
            `Overlay: ${p.overlayEffective ? "on" : "off"}${p.protect ? `  ·  protect-newer-than: ${p.protect}` : ""}`,
            `It is read-only but may run for hours on large shares.`,
            `Call again with confirmed: true to proceed.`,
          ].join("\n");
        }
        const canonical = canonicalOpString(op, config.name, "", p);
        const token = buildApprovalToken(config, canonical, 2);
        const path = op === "schedule" ? "/jobs/inventory/schedule" : "/jobs/inventory";
        const job = await jobHttp(config, "POST", path, { body: startBody(p, op === "schedule"), approvalToken: token });
        return `${tag} ${op === "schedule" ? "Scheduled" : "Started"} inventory job.\n${formatJob(job)}`;
      }
      default:
        return `${tag} Unknown job operation: ${op}`;
    }
  } catch (err) {
    return `${tag} Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Formatting ─────────────────────────────────────────────────────────────────

function formatJob(j: unknown): string {
  const job = j as Record<string, unknown>;
  const lines = [
    `job ${job.id} — ${job.status}`,
    `shares: ${(job.target_shares as string[] | undefined)?.join(", ") ?? "—"}`,
  ];
  if (job.scheduled_for) lines.push(`scheduled_for: ${job.scheduled_for}`);
  if (job.files_scanned !== undefined) lines.push(`progress: ${job.files_scanned} files, ${job.bytes_scanned} bytes (${job.current_share ?? "—"})`);
  if (job.result_available) lines.push(`results: ready (fetch with fetch_file_inventory_result)`);
  if (job.overlay_note) lines.push(`overlay note: ${job.overlay_note}`);
  if (job.error) lines.push(`error: ${job.error}`);
  return lines.join("\n");
}

function formatList(jobs: unknown[]): string {
  if (jobs.length === 0) return "No inventory jobs found.";
  return jobs
    .map((j) => {
      const job = j as Record<string, unknown>;
      return `· ${job.id} [${job.status}] shares=${(job.target_shares as string[] | undefined)?.join("/") ?? "—"}${job.scheduled_for ? ` scheduled=${job.scheduled_for}` : ""}`;
    })
    .join("\n");
}

function formatResult(kind: string, r: unknown): string {
  const res = r as { header?: string; rows?: string[]; total_rows?: number; next_cursor?: number };
  const lines = [`${kind} result (${res.total_rows ?? 0} rows)`];
  if (res.header) lines.push(res.header);
  if (res.rows) lines.push(...res.rows);
  if (typeof res.next_cursor === "number" && res.next_cursor >= 0) {
    lines.push(`… more rows: pass cursor=${res.next_cursor} to continue.`);
  }
  return lines.join("\n");
}
