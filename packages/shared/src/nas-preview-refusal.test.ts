import { describe, expect, it } from "vitest";
import { formatNasPreviewRefusal } from "./nas-preview-refusal";

describe("NAS preview refusal formatter", () => {
  it("REFUSAL-002 preserves a nonempty blocked summary verbatim", () => {
    const summary =
      "  Recursive searches of Synology Drive stores are blocked. This refusal is permanent and stateless, NOT a rate limit.  ";
    const result = formatNasPreviewRefusal(
      { blocked: true, tier: -1, summary },
      "run_command",
    );

    expect(result).toEqual({ content: `run_command: ${summary}`, isError: true });
  });

  it("REFUSAL-003 fails loudly when a blocked summary is empty", () => {
    const result = formatNasPreviewRefusal(
      { blocked: true, tier: -1, summary: "   " },
      "inspect_drive",
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Blocked permanently");
    expect(result.content).toContain("stateless");
    expect(result.content).toContain("not a rate limit or session limit");
    expect(result.content).toContain("Change the command");
  });

  it("REFUSAL-004 never emits a negative tier label", () => {
    const result = formatNasPreviewRefusal(
      { blocked: false, tier: -1, summary: "Unexpected classifier result" },
      "inspect_drive",
    );

    expect(result.content).not.toContain("tier--1");
    expect(result.isError).toBe(true);
  });

  it("REFUSAL-007 keeps approval guidance for a privileged preview", () => {
    const result = formatNasPreviewRefusal(
      { blocked: false, tier: 3, summary: "File operation" },
      "rename_file",
    );

    expect(result.content).toContain("tier-3");
    expect(result.content).toContain("propose it as a remediation");
    expect(result.content).toContain("operator can approve it");
    expect(result.isError).toBe(true);
  });
});
