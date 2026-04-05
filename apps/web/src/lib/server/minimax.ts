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

    // Clean content: strip markdown code blocks, BOM, leading/trailing whitespace
    content = content.trim();
    content = content.replace(/^\uFEFF/, "");
    content = content.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
    content = content.trim();

    return { content };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`[Minimax] Request failed: ${message}`);
    return { content: null, error: message };
  }
}

/**
 * Call Minimax and parse JSON response
 * Returns parsed JSON or null on error
 */
export async function callMinimaxJSON<T>(
  systemPrompt: string,
  userPrompt: string
): Promise<{ data: T | null; error?: string }> {
  const result = await callMinimax(systemPrompt, userPrompt, { json: true, maxTokens: 8000 });

  if (!result.content) {
    return { data: null, error: result.error };
  }

  try {
    const data = JSON.parse(result.content) as T;
    return { data };
  } catch {
    // Try to extract JSON from markdown code blocks or mixed content
    const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                      result.content.match(/(\{[\s\S]*\})/);
    if (jsonMatch?.[1]) {
      try {
        const data = JSON.parse(jsonMatch[1].trim()) as T;
        return { data };
      } catch {
        // fall through
      }
    }
    console.error("[Minimax] Failed to parse JSON response:", result.content.slice(0, 500));
    return { data: null, error: `Failed to parse JSON response. Model returned: ${result.content.slice(0, 200)}...` };
  }
}
