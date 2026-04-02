/**
 * Minimax M2.7 client for bulk log analysis and diagnostics
 * Uses OpenAI-compatible chat completions endpoint
 */

interface MinimaxOptions {
  json?: boolean;
  maxTokens?: number;
}

interface MinimaxResponse {
  content: string | null;
  error?: string;
}

/**
 * Call Minimax M2.7 with a system prompt and user prompt
 * Returns the response text or null on error
 */
export async function callMinimax(
  systemPrompt: string,
  userPrompt: string,
  options: MinimaxOptions = {}
): Promise<MinimaxResponse> {
  const apiKey = process.env.MINIMAX_API_KEY;
  const apiUrl = process.env.MINIMAX_API_URL || "https://api.minimax.io/v1/chat/completions";
  const model = process.env.MINIMAX_MODEL || "MiniMax-M2.7";
  const maxTokens = options.maxTokens || 4000;

  if (!apiKey) {
    console.error("[Minimax] MINIMAX_API_KEY not configured");
    return { content: null, error: "MINIMAX_API_KEY not configured" };
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

    // Add response format for JSON output when requested
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

    return { content: content.trim() };
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
  const result = await callMinimax(systemPrompt, userPrompt, { json: true });

  if (!result.content) {
    return { data: null, error: result.error };
  }

  try {
    const data = JSON.parse(result.content) as T;
    return { data };
  } catch {
    console.error("[Minimax] Failed to parse JSON response:", result.content);
    return { data: null, error: "Failed to parse JSON response" };
  }
}
