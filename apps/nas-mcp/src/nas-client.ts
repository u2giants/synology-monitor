import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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
const MAX_RESPONSE_BYTES = 512 * 1024;

function normalizeRequestError(err: unknown, label: string, timeoutMs: number): Error {
  if (err instanceof Error) {
    if (err.message.includes("__NAS_TIMEOUT__")) {
      return new Error(`${label} timed out after ${timeoutMs}ms — NAS may be under load`);
    }
    return err;
  }
  return new Error(`${label} failed: ${String(err)}`);
}

async function requestJson<T>(
  config: NasConfig,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const url = new URL(path, config.url);
  const payload = JSON.stringify(body);
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise<T>((resolve, reject) => {
    const req = requestImpl(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Authorization: `Bearer ${config.apiSecret}`,
          Connection: "close",
        },
      },
      (res) => {
        res.setEncoding("utf8");

        let raw = "";
        res.on("data", (chunk: string) => {
          raw += chunk;
          if (raw.length > MAX_RESPONSE_BYTES) {
            res.destroy(new Error(`${label} failed (${config.name}): response exceeded ${MAX_RESPONSE_BYTES} bytes`));
          }
        });
        res.on("end", () => {
          const status = res.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            reject(new Error(`${label} failed (${config.name}): HTTP ${status} — ${raw.trim()}`));
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
          } catch (err) {
            reject(new Error(`${label} failed (${config.name}): invalid JSON response: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
        res.on("error", reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("__NAS_TIMEOUT__"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  }).catch((err) => {
    throw normalizeRequestError(err, `${label} (${config.name})`, timeoutMs);
  });
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
  return requestJson<NasPreviewResult>(
    config,
    "/preview",
    { command },
    PREVIEW_TIMEOUT_MS,
    "NAS preview",
  );
}

/**
 * Executes a command on the NAS via the NAS API.
 * `timeoutMs` controls how long nas-api is given to run the command (capped at MAX_EXEC_TIMEOUT_MS).
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
  return requestJson<NasExecResult>(config, "/exec", body, clampedTimeout + 5_000, "NAS exec");
}
