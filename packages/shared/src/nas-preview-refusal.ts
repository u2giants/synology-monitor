export interface NasPreviewClassification {
  tier: number;
  summary: string;
  blocked: boolean;
}

export interface NasPreviewRefusal {
  content: string;
  isError: true;
}

/**
 * Formats a NAS API preview that Stage 2 must not execute automatically.
 *
 * The NAS API owns hard-block explanations. Preserve its summary so callers do
 * not turn a permanent command-specific refusal into a misleading session or
 * rate-limit error.
 */
export function formatNasPreviewRefusal(
  preview: NasPreviewClassification,
  operationLabel: string,
): NasPreviewRefusal {
  const label = operationLabel.trim() || "NAS operation";

  if (preview.blocked) {
    const hasSummary = preview.summary.trim().length > 0;
    return {
      content: hasSummary
        ? `${label}: ${preview.summary}`
        : `${label}: Blocked permanently by the NAS validator for this command pattern. ` +
          "This refusal is stateless and is not a rate limit or session limit. Change the command before trying again.",
      isError: true,
    };
  }

  const tier = Number.isInteger(preview.tier) && preview.tier > 1
    ? `tier-${preview.tier}`
    : "a privileged or invalid tier";
  return {
    content:
      `${label} requires ${tier} and is not auto-executable. ` +
      "Read-only investigation is tier-1 only. If a change or privileged read is warranted, " +
      "propose it as a remediation so the operator can approve it.",
    isError: true,
  };
}
