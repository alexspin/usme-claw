/**
 * Configuration schema for the USME OpenClaw plugin.
 */

import type { AssemblyMode } from "@usme/core/assemble/types.js";

export type PluginMode = "shadow" | "active" | "disabled";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax: number;
  idleTimeoutMs: number;
}

export interface ExtractionConfig {
  enabled: boolean;
  model: string;
}

export interface ConsolidationConfig {
  cron: string;
  sonnetModel: string;
  skillDraftingModel: string;
  candidatesPerNight: number;
}

export interface AssemblyConfig {
  defaultMode: AssemblyMode;
  modes: {
    "psycho-genius": { tokenBudget: number };
    brilliant: { tokenBudget: number };
    "smart-efficient": { tokenBudget: number };
  };
}

export interface ShadowConfig {
  logComparison: boolean;
  samplingRate: number;
}

export interface UsmePluginConfig {
  mode: PluginMode;
  db: DbConfig;
  extraction: ExtractionConfig;
  consolidation: ConsolidationConfig;
  assembly: AssemblyConfig;
  shadow: ShadowConfig;
}

export const DEFAULT_CONFIG: UsmePluginConfig = {
  mode: "shadow",
  db: {
    host: "localhost",
    port: 5432,
    database: "usme",
    user: "usme",
    password: "usme_dev",
    poolMax: 10,
    idleTimeoutMs: 30_000,
  },
  extraction: {
    enabled: true,
    model: "claude-haiku",
  },
  consolidation: {
    cron: "0 3 * * *",
    sonnetModel: "claude-sonnet",
    skillDraftingModel: "claude-sonnet",
    candidatesPerNight: 5,
  },
  assembly: {
    defaultMode: "brilliant",
    modes: {
      "psycho-genius": { tokenBudget: 50_000 },
      brilliant: { tokenBudget: 30_000 },
      "smart-efficient": { tokenBudget: 15_000 },
    },
  },
  shadow: {
    logComparison: true,
    samplingRate: 1.0,
  },
};

export function resolveConfig(
  partial?: Partial<UsmePluginConfig>,
): UsmePluginConfig {
  if (!partial) return { ...DEFAULT_CONFIG };
  return {
    mode: partial.mode ?? DEFAULT_CONFIG.mode,
    db: { ...DEFAULT_CONFIG.db, ...partial.db },
    extraction: { ...DEFAULT_CONFIG.extraction, ...partial.extraction },
    consolidation: {
      ...DEFAULT_CONFIG.consolidation,
      ...partial.consolidation,
    },
    assembly: {
      defaultMode:
        partial.assembly?.defaultMode ?? DEFAULT_CONFIG.assembly.defaultMode,
      modes: {
        ...DEFAULT_CONFIG.assembly.modes,
        ...partial.assembly?.modes,
      },
    },
    shadow: { ...DEFAULT_CONFIG.shadow, ...partial.shadow },
  };
}
