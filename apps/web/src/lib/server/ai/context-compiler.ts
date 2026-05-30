/**
 * Context compiler (PLAN.md §9.1.2, §9.4).
 *
 * Caching only works if the prompt is laid out stable-before-dynamic: one early
 * dynamic token busts the cache for everything after it. This compiler is the
 * enforcement point — it sorts/validates prompt blocks into the required order
 * and THROWS if a dynamic block precedes a stable one, so a cache-hostile prompt
 * fails loudly in CI/dev instead of silently costing money in prod (CI guard #1,
 * §9.7).
 *
 * Required order (§9.1.2):
 *   [stable system] → [stable tools] → [stable schema]
 *   → [semi-stable taxonomy] → [semi-stable whole-system snapshot]
 *   → [dynamic bounded evidence] → [dynamic instruction] → [dynamic retry]
 *
 * The cache is never load-bearing (§9.4): the stablePrefixHash is a reuse key
 * only; a hit saves money, a miss costs money, neither changes behaviour.
 */

import { createHash } from "node:crypto";

export type BlockTier = "stable" | "semi_stable" | "dynamic";

const TIER_RANK: Record<BlockTier, number> = {
  stable: 0,
  semi_stable: 1,
  dynamic: 2,
};

export interface PromptBlock {
  tier: BlockTier;
  /** Short identifier for diagnostics, e.g. "system", "tool_schemas", "evidence". */
  label: string;
  text: string;
}

export class ContextOrderingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextOrderingError";
  }
}

export interface CompiledContext {
  /** Blocks in validated stable→dynamic order. */
  blocks: PromptBlock[];
  /** Concatenated stable + semi-stable text (the cacheable prefix). */
  stableText: string;
  /** Concatenated dynamic text (per-turn, never cached). */
  dynamicText: string;
  /** sha256 of the stable prefix — the cross-call/resume cache reuse key (§9.4). */
  stablePrefixHash: string;
  /** Index of the first dynamic block (the cache boundary), or blocks.length if none. */
  cacheBoundaryIndex: number;
}

/**
 * Validate ordering and compile. Blocks must be supplied already in intended
 * order; this does NOT reorder silently (that would hide an authoring bug) — it
 * asserts the tiers are non-decreasing and throws otherwise.
 */
export function compileContext(blocks: PromptBlock[]): CompiledContext {
  if (blocks.length === 0) {
    throw new ContextOrderingError("compileContext: no blocks provided.");
  }

  let maxRankSeen = -1;
  let maxLabelSeen = "";
  for (const block of blocks) {
    const rank = TIER_RANK[block.tier];
    if (rank === undefined) {
      throw new ContextOrderingError(
        `compileContext: block "${block.label}" has unknown tier "${block.tier}".`,
      );
    }
    if (rank < maxRankSeen) {
      throw new ContextOrderingError(
        `Stable-before-dynamic violation: "${block.tier}" block "${block.label}" ` +
          `appears after a higher-tier "${rankName(maxRankSeen)}" block "${maxLabelSeen}". ` +
          `Caching requires non-decreasing tiers (stable → semi_stable → dynamic).`,
      );
    }
    if (rank > maxRankSeen) {
      maxRankSeen = rank;
      maxLabelSeen = block.label;
    }
  }

  const cacheBoundaryIndex = blocks.findIndex((b) => b.tier === "dynamic");
  const stableBlocks = blocks.filter((b) => b.tier !== "dynamic");
  const dynamicBlocks = blocks.filter((b) => b.tier === "dynamic");

  const stableText = stableBlocks.map((b) => b.text).join("\n\n");
  const dynamicText = dynamicBlocks.map((b) => b.text).join("\n\n");
  const stablePrefixHash = createHash("sha256").update(stableText).digest("hex");

  return {
    blocks,
    stableText,
    dynamicText,
    stablePrefixHash,
    cacheBoundaryIndex: cacheBoundaryIndex === -1 ? blocks.length : cacheBoundaryIndex,
  };
}

function rankName(rank: number): BlockTier {
  return (Object.keys(TIER_RANK) as BlockTier[]).find((k) => TIER_RANK[k] === rank) ?? "stable";
}

/** Convenience builders so call sites read declaratively. */
export const block = {
  stable: (label: string, text: string): PromptBlock => ({ tier: "stable", label, text }),
  semiStable: (label: string, text: string): PromptBlock => ({ tier: "semi_stable", label, text }),
  dynamic: (label: string, text: string): PromptBlock => ({ tier: "dynamic", label, text }),
};
