export function sanitizeModelJson(text: string) {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export function extractFirstJsonObject(text: string) {
  const sanitized = sanitizeModelJson(text);
  const start = sanitized.indexOf("{");
  if (start === -1) return sanitized;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < sanitized.length; i += 1) {
    const char = sanitized[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;

    if (depth === 0) {
      return sanitized.slice(start, i + 1);
    }
  }

  return sanitized.slice(start);
}

export function parseJsonObject<T>(raw: string): T {
  return JSON.parse(extractFirstJsonObject(raw)) as T;
}
