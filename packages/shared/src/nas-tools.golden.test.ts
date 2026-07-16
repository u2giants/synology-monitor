// Keeps `nas-write-commands.golden.json` byte-identical to what the real
// buildCommand emits today.
//
// The golden is the contract handoff to nas-api's Go test
// (apps/nas-api/internal/validator/nas_write_tools_contract_test.go), which asserts
// the tier the real classifier assigns these commands. Go cannot call the TypeScript
// builder, so the golden is the seam — and a golden nobody re-generates is a lie.
// This test is what makes it honest: change the builder without regenerating and it
// fails here, in the same CI job that owns the builder.
//
// To regenerate after an intentional builder change:
//   UPDATE_GOLDEN=1 npx vitest run src/nas-tools.golden.test.ts
// then re-run nas-api's Go tests, which will re-check the tier of the new commands.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_TOOL_DEFS } from "./nas-tools";

const GOLDEN_PATH = join(__dirname, "__fixtures__", "nas-write-commands.golden.json");

// Each case must be a path the Go side expects to classify tier 3 (a real user-data
// write). Keep `expectedTier` here so the two languages agree on one declared truth.
const CASES = [
  { tool: "rename_file_to_old", filter: "/volume1/mac/Art Library/a.txt", expectedTier: 3 },
  { tool: "rename_file_to_old", filter: "/volume1/mac/weird name: v2?.txt", expectedTier: 3 },
  { tool: "rename_file_to_old", filter: "/btrfs/volume1/files/report.docx", expectedTier: 3 },
  // A hostile filter must still classify tier 3 — it is inert data, not code.
  { tool: "rename_file_to_old", filter: "/volume1/mac/x$(touch /tmp/OWNED).txt", expectedTier: 3 },
  { tool: "remove_invalid_chars", filter: "/volume1/mac/bad:name?.txt", expectedTier: 3 },
  { tool: "remove_invalid_chars", filter: "/btrfs/volume1/files/a|b.txt", expectedTier: 3 },
  { tool: "remove_invalid_chars", filter: "/volume1/mac/y`touch /tmp/OWNED`.txt", expectedTier: 3 },
];

function build(tool: string, filter: string): string {
  const def = ALL_TOOL_DEFS.find((t) => t.name === tool);
  if (!def?.buildCommand) throw new Error(`tool not found or has no buildCommand: ${tool}`);
  return def.buildCommand({ filter } as never);
}

describe("nas write-tool command golden (cross-language contract with nas-api)", () => {
  const current = CASES.map((c) => ({ ...c, command: build(c.tool, c.filter) }));

  it("golden file matches the current builder output", () => {
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(current, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8"));
    expect(
      golden,
      "The generated commands changed. Regenerate with `UPDATE_GOLDEN=1 npx vitest run src/nas-tools.golden.test.ts`, " +
        "then run nas-api's Go tests — they re-check the tier the real validator assigns the new commands.",
    ).toEqual(current);
  });
});
