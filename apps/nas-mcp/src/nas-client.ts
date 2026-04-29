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
  const res = await fetch(`${config.url}/preview`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiSecret}`,
    },
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`NAS preview failed (${config.name}): HTTP ${res.status}`);
  }
  return res.json() as Promise<NasPreviewResult>;
}

/** Executes a command on the NAS via the NAS API. */
export async function nasExec(
  config: NasConfig,
  command: string,
  tier: number,
  approvalToken?: string,
  timeoutMs = 90_000,
): Promise<NasExecResult> {
  const body: Record<string, unknown> = { command, tier, timeout_ms: timeoutMs };
  if (approvalToken) body.approval_token = approvalToken;

  const res = await fetch(`${config.url}/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.apiSecret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs + 15_000),
  });
  if (!res.ok) {
    // Log the full response body server-side, but only surface the status
    // code to the caller. The body sometimes contains echoed headers /
    // approval tokens / DSM credentials when nas-api errors at the wrong
    // layer; surfacing that to the LLM context (and any logs that capture
    // model context) leaks secrets.
    const text = await res.text().catch(() => "");
    if (text) console.error(`[nas-client] exec failure body for ${config.name}:`, text);
    throw new Error(`NAS exec failed (${config.name}): HTTP ${res.status}`);
  }
  return res.json() as Promise<NasExecResult>;
}
