/**
 * Greedy token-budget packing.
 * Sorts candidates by score descending, fills until budget exhausted.
 * Does not break on first skip -- smaller items may still fit.
 */

import type { ScoredCandidate, InjectedMemory } from "./types.js";

/**
 * Pack scored candidates into the given token budget.
 * Returns selected items as InjectedMemory[].
 */
export function pack(candidates: ScoredCandidate[], budget: number): InjectedMemory[] {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const selected: InjectedMemory[] = [];
  let remaining = budget;

  for (const item of sorted) {
    if (item.tokenCount <= remaining) {
      selected.push({
        id: item.id,
        tier: item.tier,
        content: item.content,
        score: item.score,
        tokenCount: item.tokenCount,
        createdAt: item.createdAt,
        tags: item.tags,
      });
      remaining -= item.tokenCount;
    }
    // Continue scanning -- smaller items may still fit (D27)
  }

  return selected;
}
