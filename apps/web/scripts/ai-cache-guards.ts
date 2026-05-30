/**
 * AI caching CI guards (PLAN.md §9.7) — hard build blockers.
 *
 * Run before the web image is built (see .github/workflows/web-image.yml). If any
 * assertion fails the job fails, the image is never pushed, and nothing deploys.
 * These guard the three silent-failure modes from §9.6:
 *   1. stable-before-dynamic ordering — the context compiler must THROW.
 *   2. Stage-2 multi-turn history must be preserved through every provider's
 *      message-building path (a cache "optimization" must never collapse history).
 *   3. every provider must have a usage normalizer that actually reads its cache
 *      field (an un-normalized provider silently reports 0% cache-hit).
 *
 * Pure modules only — no network, no secrets, no Next runtime.
 */

import assert from "node:assert/strict";
import { block, compileContext, ContextOrderingError } from "../src/lib/server/ai/context-compiler";
import { buildAnthropicMessages } from "../src/lib/server/ai/providers/anthropic";
import { buildOpenAIMessages } from "../src/lib/server/ai/providers/openai-compatible";
import { buildGeminiContents } from "../src/lib/server/ai/providers/gemini";
import { PROVIDER_CLIENTS } from "../src/lib/server/ai/providers";
import { USAGE_NORMALIZERS } from "../src/lib/server/ai/usage";
import type { AiProvider } from "@synology-monitor/shared";
import type { ChatMessage } from "../src/lib/server/ai/providers/types";

const EXPECTED_PROVIDERS: AiProvider[] = ["anthropic", "openai", "gemini", "deepseek", "qwen"];

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- Guard 1: stable-before-dynamic ordering throws -------------------------
console.log("Guard 1 — context compiler enforces stable-before-dynamic");

check("throws when a dynamic block precedes a stable block", () => {
  assert.throws(
    () =>
      compileContext([
        block.dynamic("evidence", "x"),
        block.stable("system", "y"),
      ]),
    ContextOrderingError,
  );
});

check("throws when semi_stable precedes stable", () => {
  assert.throws(
    () => compileContext([block.semiStable("taxonomy", "a"), block.stable("system", "b")]),
    ContextOrderingError,
  );
});

check("accepts a correctly ordered prompt and isolates dynamic text", () => {
  const compiled = compileContext([
    block.stable("system", "S".repeat(5_000)),
    block.semiStable("snapshot", "snap"),
    block.dynamic("evidence", "EVID"),
    block.dynamic("instruction", "DO IT"),
  ]);
  assert.equal(compiled.cacheBoundaryIndex, 2);
  assert.ok(!compiled.stableText.includes("EVID"), "evidence must not be in the stable prefix");
  assert.ok(compiled.dynamicText.includes("EVID"));
  assert.match(compiled.stablePrefixHash, /^[0-9a-f]{64}$/);
});

check("stablePrefixHash is stable for identical stable content", () => {
  const mk = () =>
    compileContext([block.stable("s", "ABC".repeat(2_000)), block.dynamic("d", "1")]).stablePrefixHash;
  assert.equal(mk(), mk());
});

// ---- Guard 2: multi-turn history preserved through every provider -----------
console.log("Guard 2 — multi-turn history preserved through caching paths");

const compiled = compileContext([
  block.stable("system", "SYS".repeat(2_000)), // > min cacheable so the cache path is exercised
  block.dynamic("instruction", "LATEST_INSTRUCTION"),
]);
const prior: ChatMessage[] = [
  { role: "user", content: "TURN_0" },
  { role: "assistant", content: "TURN_1" },
  { role: "user", content: "TURN_2" },
  { role: "assistant", content: "TURN_3" },
];

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : ""))
      .join("");
  }
  return "";
}

check("Anthropic builder preserves all prior turns in order + appends latest", () => {
  const msgs = buildAnthropicMessages(compiled, prior);
  assert.equal(msgs.length, prior.length + 1);
  prior.forEach((m, i) => assert.equal(textOf(msgs[i].content), m.content));
  assert.equal(textOf(msgs[msgs.length - 1].content), "LATEST_INSTRUCTION");
});

check("OpenAI-compatible builder preserves history (system + turns + latest)", () => {
  const msgs = buildOpenAIMessages(compiled, prior);
  assert.equal(msgs.length, prior.length + 2); // system + N + latest
  assert.equal(msgs[0].role, "system");
  prior.forEach((m, i) => assert.equal(textOf(msgs[i + 1].content), m.content));
  assert.equal(textOf(msgs[msgs.length - 1].content), "LATEST_INSTRUCTION");
});

check("Gemini builder preserves history + maps assistant→model", () => {
  const contents = buildGeminiContents(compiled, prior);
  assert.equal(contents.length, prior.length + 1);
  prior.forEach((m, i) => {
    assert.equal(textOf(contents[i].parts), m.content);
    assert.equal(contents[i].role, m.role === "assistant" ? "model" : "user");
  });
  assert.equal(textOf(contents[contents.length - 1].parts), "LATEST_INSTRUCTION");
});

// ---- Guard 3: every provider has a client + a real usage normalizer ----------
console.log("Guard 3 — every provider has a client and a cache-aware usage normalizer");

const REPRESENTATIVE_USAGE: Record<AiProvider, unknown> = {
  anthropic: {
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
    output_tokens: 30,
  },
  openai: {
    prompt_tokens: 1_000,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 800 },
  },
  qwen: {
    prompt_tokens: 1_000,
    completion_tokens: 30,
    prompt_tokens_details: { cached_tokens: 800 },
  },
  deepseek: {
    prompt_tokens: 1_000,
    completion_tokens: 30,
    prompt_cache_hit_tokens: 700,
    prompt_cache_miss_tokens: 300,
  },
  gemini: {
    promptTokenCount: 1_000,
    candidatesTokenCount: 30,
    cachedContentTokenCount: 600,
    thoughtsTokenCount: 5,
  },
};

check("PROVIDER_CLIENTS covers exactly the expected providers", () => {
  assert.deepEqual(Object.keys(PROVIDER_CLIENTS).sort(), [...EXPECTED_PROVIDERS].sort());
});

check("USAGE_NORMALIZERS covers exactly the expected providers", () => {
  assert.deepEqual(Object.keys(USAGE_NORMALIZERS).sort(), [...EXPECTED_PROVIDERS].sort());
});

for (const provider of EXPECTED_PROVIDERS) {
  check(`${provider} normalizer reads cached + input tokens (no silent 0%)`, () => {
    const u = USAGE_NORMALIZERS[provider](REPRESENTATIVE_USAGE[provider]);
    assert.ok(u.inputTokens > 0, `${provider}: inputTokens should be > 0`);
    assert.ok(u.cachedInputTokens > 0, `${provider}: cachedInputTokens should be > 0`);
    assert.ok(u.cachedInputTokens <= u.inputTokens, `${provider}: cached must be <= total input`);
  });
}

// ---- Summary ----------------------------------------------------------------
if (failures > 0) {
  console.error(`\nAI cache guards FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll AI cache guards passed.");
