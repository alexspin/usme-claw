/**
 * Assembly mode profiles.
 * Three named modes with full parameter sets.
 * Extensible: custom modes supported via config.
 */

import type { AssemblyMode, AssemblyModeProfile, MemoryTier } from "./types.js";

const ALL_TIERS: MemoryTier[] = ["sensory_trace", "episodes", "concepts", "skills", "entities"];
const CORE_TIERS: MemoryTier[] = ["sensory_trace", "episodes", "concepts", "skills"];
const MINIMAL_TIERS: MemoryTier[] = ["concepts", "skills"];

export const MODE_PROFILES: Record<AssemblyMode, AssemblyModeProfile> = {
  "psycho-genius": {
    tokenBudgetFraction: 0.45,
    sessionHistoryFraction: 0.55,
    minInclusionScore: 0.15,
    minConfidence: 0.3,
    candidatesPerTier: 30,
    annSearchK: 60,
    tiersEnabled: ALL_TIERS,
    slidingWindowTurns: 30,
    slidingWindowTokens: 50000,
    includeSpeculative: true,
    speculativeMaxCount: 10,
  },
  brilliant: {
    tokenBudgetFraction: 0.35,
    sessionHistoryFraction: 0.65,
    minInclusionScore: 0.30,
    minConfidence: 0.5,
    candidatesPerTier: 20,
    annSearchK: 40,
    tiersEnabled: CORE_TIERS,
    slidingWindowTurns: 20,
    slidingWindowTokens: 30000,
    includeSpeculative: false,
    speculativeMaxCount: 0,
  },
  "smart-efficient": {
    tokenBudgetFraction: 0.25,
    sessionHistoryFraction: 0.75,
    minInclusionScore: 0.50,
    minConfidence: 0.7,
    candidatesPerTier: 10,
    annSearchK: 20,
    tiersEnabled: MINIMAL_TIERS,
    slidingWindowTurns: 10,
    slidingWindowTokens: 15000,
    includeSpeculative: false,
    speculativeMaxCount: 0,
  },
};

/**
 * Resolve a mode profile by name, with optional custom overrides.
 */
export function resolveMode(
  mode: AssemblyMode,
  overrides?: Partial<AssemblyModeProfile>,
): AssemblyModeProfile {
  const base = MODE_PROFILES[mode];
  if (!base) {
    throw new Error(`Unknown assembly mode: ${mode}`);
  }
  return overrides ? { ...base, ...overrides } : base;
}
