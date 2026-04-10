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
      return { content: null, error: `API error ${response.status}` };
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      console.error("[Minimax] No content in response");
      return { content: null, error: "No content in response" };
    }

    return { content: (content as string).trim() };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Minimax] Request failed: ${message}`);
    return { content: null, error: message };
  }
}

/**
 * Call Minimax and parse JSON response.
 * Applies sanitizeMinimaxResponse() before JSON.parse().
 * Returns parsed JSON or null on error.
 */
export async function callMinimaxJSON<T>(
  systemPrompt: string,
  userPrompt: string
): Promise<{ data: T | null; error?: string }> {
  const result = await callMinimax(systemPrompt, userPrompt, { json: true });

  if (!result.content) {
    return { data: null, error: result.error };
  }

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

  try {
    const data = JSON.parse(sanitized.json) as T;
    return { data };
  } catch {
    console.error(
      "[Minimax] Failed to parse JSON. Raw (first 500 chars):",
      sanitized.raw.slice(0, 500)
    );
    return { data: null, error: "Failed to parse JSON response" };
  }
}
