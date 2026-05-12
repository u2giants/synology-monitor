import { createHmac } from "node:crypto";

export interface NasConfig {
  name: string;
  url: string;
  apiSecret: string;
  approvalSigningKey: string;
}

export interface NasPreviewResult {
  tier: number;
  summary: string;
  blocked: boolean;
}

export interface NasExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  timed_out?: boolean;
}

// Hard cap on exec timeout sent to nas-api. Callers can request less but never more.
const MAX_EXEC_TIMEOUT_MS = 25_000;
const PREVIEW_TIMEOUT_MS = 8_000;
// Extra buffer between the body timeout_ms and the AbortController deadline.
const ABORT_BUFFER_MS = 5_000;

/**
 * Returns an AbortSignal that fires after `ms` milliseconds.
 * Uses AbortController + setTimeout instead of AbortSignal.timeout() to avoid
 * undici connection-pool issues where AbortSignal.timeout() fails to cancel
 * stalled TCP connections in some undici versions.
 */
function makeTimeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`NAS API request timed out after ${ms}ms`)),
    ms,
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Returns NAS configs matching the target. "both" returns all configured NASes. */
export function getNasConfigs(target: string): NasConfig[] {
  const configs: NasConfig[] = [];

  const nas1 = buildConfig(
    process.env.NAS_EDGE1_NAME ?? "edgesynology1",
    process.env.NAS_EDGE1_API_URL,
    process.env.NAS_EDGE1_API_SECRET,
    process.env.NAS_EDGE1_API_SIGNING_KEY,
  );
  const nas2 = buildConfig(
    process.env.NAS_EDGE2_NAME ?? "edgesynology2",
    process.env.NAS_EDGE2_API_URL,
    process.env.NAS_EDGE2_API_SECRET,
    process.env.NAS_EDGE2_API_SIGNING_KEY,
  );

  if (nas1) configs.push(nas1);
  if (nas2) configs.push(nas2);

  if (target === "both") return configs;
  const match = configs.find((c) => c.name === target);
  return match ? [match] : [];
}

function buildConfig(
  name: string,
  url: string | undefined,
  apiSecret: string | undefined,
  approvalSigningKey: string | undefined,
): NasConfig | null {
  if (!url || !apiSecret || !approvalSigningKey) return null;
  return { name, url, apiSecret, approvalSigningKey };
}

/**
 * Builds an HMAC-signed approval token for tier 2/3 commands.
 * Matches the token format expected by the NAS API validator.
 */
export function buildApprovalToken(config: NasConfig, command: string, tier: number): string {
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
  const signature = createHmac("sha256", config.approvalSigningKey)
    .update(`${command}\n${expiresAt}`)
    .digest("hex");
  return Buffer.from(
    JSON.stringify({ command, tier, expires_at: expiresAt, signature }),
  ).toString("base64url");
}

/** Asks the NAS API to classify a command's tier without running it. */
export async function nasPreview(config: NasConfig, command: string): Promise<NasPreviewResult> {
  const { signal, clear } = makeTimeoutSignal(PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetch(`${config.url}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiSecret}`,
        Connection: "close",
      },
      body: JSON.stringify({ command }),
      signal,
    });
    if (!res.ok) {
      throw new Error(`NAS preview failed (${config.name}): HTTP ${res.status}`);
    }
    return res.json() as Promise<NasPreviewResult>;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`NAS preview timed out after ${PREVIEW_TIMEOUT_MS}ms (${config.name}) — NAS may be under load`);
    }
    throw err;
  } finally {
    clear();
  }
}

/**
 * Executes a command on the NAS via the NAS API.
 * `timeoutMs` controls how long nas-api is given to run the command (capped at MAX_EXEC_TIMEOUT_MS).
 * The HTTP abort fires ABORT_BUFFER_MS after that deadline.
 */
export async function nasExec(
  config: NasConfig,
  command: string,
  tier: number,
  approvalToken?: string,
  timeoutMs = MAX_EXEC_TIMEOUT_MS,
): Promise<NasExecResult> {
  const clampedTimeout = Math.min(timeoutMs, MAX_EXEC_TIMEOUT_MS);
  const body: Record<string, unknown> = { command, tier, timeout_ms: clampedTimeout };
  if (approvalToken) body.approval_token = approvalToken;

  const abortMs = clampedTimeout + ABORT_BUFFER_MS;
  const { signal, clear } = makeTimeoutSignal(abortMs);
  try {
    const res = await fetch(`${config.url}/exec`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiSecret}`,
        Connection: "close",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`NAS exec failed (${config.name}): HTTP ${res.status} — ${text}`);
    }
    return res.json() as Promise<NasExecResult>;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`NAS exec timed out after ${abortMs}ms (${config.name}) — NAS may be under load`);
    }
    throw err;
  } finally {
    clear();
  }
}
