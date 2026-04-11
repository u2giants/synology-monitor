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
