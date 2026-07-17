// Keeps the server-owned named-tool tier registry byte-identical to the shared
// TypeScript registry. nas-api embeds this file at build time; drift must fail
// CI so a new tool cannot deploy without a declared server-side minimum.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_TOOL_DEFS, getDeclaredMinimumTier } from "./nas-tools";

const CONTRACT_PATH = resolve(
  __dirname,
  "../../../apps/nas-api/internal/validator/nas_tool_minimum_tiers.json",
);

function currentContract(): Record<string, number> {
  return Object.fromEntries(
    ALL_TOOL_DEFS
      .filter((tool) => tool.buildCommand)
      .map((tool): [string, 1 | 2 | 3] => [tool.name, getDeclaredMinimumTier(tool)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

describe("nas-api named-tool minimum-tier contract", () => {
  it("matches every shell-backed shared tool", () => {
    const current = currentContract();
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(CONTRACT_PATH, `${JSON.stringify(current, null, 2)}\n`);
    }
    expect(
      JSON.parse(readFileSync(CONTRACT_PATH, "utf8")),
      "Named-tool tiers changed. Regenerate with UPDATE_GOLDEN=1 pnpm --filter @synology-monitor/shared test, then run nas-api Go tests.",
    ).toEqual(current);
  });

  it("defaults an ungrouped future write tool to tier 3", () => {
    expect(
      getDeclaredMinimumTier({
        name: "future_write_tool",
        description: "test",
        write: true,
        params: {},
        buildCommand: () => "touch /tmp/test",
      }),
    ).toBe(3);
  });
});
