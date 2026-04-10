/**
 * Diagnosis model client for bulk log analysis.
 * Routed through OpenRouter (https://openrouter.ai).
 * Model is configurable in Settings > AI Models.
 */

import { getDiagnosisModel } from "./ai-settings";

interface MinimaxOptions {
  json?: boolean;
  maxTokens?: number;
}

interface MinimaxResponse {
  content: string | null;
  error?: string;
}

interface SanitizeResult {
  json: string | null;
  raw: string;
  reason?: string;
}

/**
 * Extract the first valid JSON object or array from a string using bracket-counting.
 * Returns the JSON substring or null if none found.
 */
function extractFirstJSON(text: string): string | null {
  const startChars = ["{", "["];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!startChars.includes(ch)) continue;

    const openChar = ch;
    const closeChar = openChar === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < text.length; j++) {
      const c = text[j];

      if (escape) {
        escape = false;
        continue;
      }

      if (c === "\\" && inString) {
        escape = true;
        continue;
      }

      if (c === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (c === openChar) {
        depth++;
      } else if (c === closeChar) {
        depth--;
        if (depth === 0) {
          return text.slice(i, j + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Sanitize a raw Minimax response before JSON.parse().
 * - Strips <think>...</think> blocks (multiline, greedy)
 * - Strips markdown code fences (```json and ```)
 * - Trims whitespace
 * - Extracts first valid JSON object or array via bracket-counting scan
 */
export function sanitizeMinimaxResponse(raw: string): SanitizeResult {
  let text = raw;

  // Strip <think>...</think> blocks (greedy, multiline)
  text = text.replace(/<think>[\s\S]*?<\/think>/g, "");

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  text = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, "$1");

  // Trim whitespace
  text = text.trim();

  // Extract first valid JSON object or array
  const json = extractFirstJSON(text);

  if (!json) {
    return {
      json: null,
      raw,
      reason: "No JSON object or array found after sanitization",
    };
  }

  return { json, raw };
}

/**
 * Call Minimax M2.7 via OpenRouter with a system prompt and user prompt.
 * Returns the response text or null on error.
 */
export async function callMinimax(
  systemPrompt: string,
  userPrompt: string,
  options: MinimaxOptions = {}
): Promise<MinimaxResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const apiUrl = "https://openrouter.ai/api/v1/chat/completions";
  const model = await getDiagnosisModel();
  const maxTokens = options.maxTokens || 4000;

  if (!apiKey) {
    console.error("[Minimax] OPENROUTER_API_KEY not configured");
    return { content: null, error: "OPENROUTER_API_KEY not configured" };
  }

  try {
    const requestBody: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
    };

    if (options.json) {
      requestBody.response_format = { type: "json_object" };
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Minimax] API error ${response.status}: ${errorText}`);
      // Parse OpenRouter error for a readable message
      let detail = `API error ${response.status}`;
      try {
        const errJson = JSON.parse(errorText);
        detail = errJson.error?.message || errJson.error?.code || detail;
      } catch {
        if (errorText.length < 200) detail = errorText;
      }
      return { content: null, error: detail };
    }

    const data = await response.json();
    let content = data.choices?.[0]?.message?.content ?? "";

    if (!content) {
      console.error("[Minimax] No content in response:", JSON.stringify(data).slice(0, 300));
      return { content: null, error: "No content in response" };
    }

<<<<<<< HEAD
    return { content: (content as string).trim() };
=======
    // Clean content: strip markdown code blocks, BOM, leading/trailing whitespace
    content = content.trim();
    content = content.replace(/^\uFEFF/, "");
    content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    content = content.trim();

    return { content };
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Minimax] Request failed: ${message}`);
    return { content: null, error: message };
  }
}

/**
<<<<<<< HEAD
 * Call Minimax and parse JSON response.
 * Applies sanitizeMinimaxResponse() before JSON.parse().
 * Returns parsed JSON or null on error.
=======
 * Attempt to repair truncated JSON by closing unclosed structures.
 * Handles the common case where the model response is cut off mid-object/array.
 */
function repairTruncatedJSON(text: string): string {
  // Trim to last complete value boundary — find the last comma-separated item end
  // Strategy: count open brackets/braces and close them
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafePos = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === "\\" && inString) { escaped = true; continue; }
    if (ch === '"') {
      inString = !inString;
      if (!inString) lastSafePos = i + 1; // end of string literal
      continue;
    }
    if (inString) continue;

    if (ch === "{" || ch === "[") {
      stack.push(ch === "{" ? "}" : "]");
    } else if (ch === "}" || ch === "]") {
      if (stack.length > 0) {
        stack.pop();
        lastSafePos = i + 1;
      }
    } else if ((ch === "," || ch === ":") && stack.length > 0) {
      // don't update lastSafePos here — trailing comma before truncation is invalid
    }
  }

  if (stack.length === 0) return text; // already complete

  // Truncate back to the last safe boundary and close all open structures
  let repaired = text.slice(0, lastSafePos);
  // Close arrays/objects in reverse order
  repaired += stack.reverse().join("");
  return repaired;
}

/**
 * Call Minimax and parse JSON response
 * Returns parsed JSON or null on error
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
 */
export async function callMinimaxJSON<T>(
  systemPrompt: string,
  userPrompt: string
): Promise<{ data: T | null; error?: string }> {
  // 8192 is the safe output token limit for Gemini Flash via OpenRouter.
  // Requesting more may cause silent truncation that breaks JSON parsing.
  const result = await callMinimax(systemPrompt, userPrompt, { json: true, maxTokens: 8192 });

  if (!result.content) {
    return { data: null, error: result.error };
  }

<<<<<<< HEAD
  const sanitized = sanitizeMinimaxResponse(result.content);

  if (!sanitized.json) {
    console.error(
      "[Minimax] Sanitization failed:",
      sanitized.reason,
      "| Raw (first 500 chars):",
      sanitized.raw.slice(0, 500)
    );
    return { data: null, error: sanitized.reason || "Failed to extract JSON from response" };
  }

=======
  // Attempt 1: direct parse
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
  try {
    const data = JSON.parse(sanitized.json) as T;
    return { data };
<<<<<<< HEAD
  } catch {
    console.error(
      "[Minimax] Failed to parse JSON. Raw (first 500 chars):",
      sanitized.raw.slice(0, 500)
    );
    return { data: null, error: "Failed to parse JSON response" };
=======
  } catch { /* fall through */ }

  // Attempt 2: extract from markdown fences or find first {...} block
  const fenceMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braceMatch = result.content.match(/\{[\s\S]*/); // start of JSON even if truncated
  const candidate = fenceMatch?.[1]?.trim() ?? braceMatch?.[0];

  if (candidate) {
    // Attempt 3: parse the candidate as-is
    try {
      const data = JSON.parse(candidate) as T;
      return { data };
    } catch { /* fall through */ }

    // Attempt 4: repair truncated JSON then parse
    try {
      const repaired = repairTruncatedJSON(candidate);
      const data = JSON.parse(repaired) as T;
      console.warn("[Minimax] Parsed after JSON repair — response was likely truncated");
      return { data };
    } catch { /* fall through */ }
>>>>>>> e2a762a1685477c3b37aad1cdfb7112b8bc8349e
  }

  console.error("[Minimax] Failed to parse JSON response:", result.content.slice(0, 500));
  return { data: null, error: `Failed to parse JSON response. Model returned: ${result.content.slice(0, 200)}...` };
}
