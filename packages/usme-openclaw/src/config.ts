/**
 * Configuration schema for the USME OpenClaw plugin.
 */

import type { AssemblyMode } from "@usme/core";

/**
 * Plugin operating mode.
 *
 *   active    — retrieval + assembly pipeline runs; context injected into prompt via prependContext.
 *   log-only  — same pipeline as active, but nothing injected; writes identical log entry.
 *   off       — USME does nothing; no hooks, no DB connections, no scheduler.
 *
 * Legacy values: "shadow" (treated as "log-only"), "disabled" (treated as "off").
 */
export type PluginMode = "active" | "log-only" | "off" | "shadow" | "disabled";

export interface DbConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax: number;
  idleTimeoutMs: number;
}

export interface EntityExtractionConfig {
  enabled: boolean;
  model: string;
}

export interface ExtractionConfig {
  enabled: boolean;
  model: string;
  entityExtraction: EntityExtractionConfig;
}

export interface ConsolidationConfig {
  cron: string;
  sonnetModel: string;
  skillDraftingModel: string;
  reconciliationModel: string;
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

export interface SpreadingConfig {
  maxDepth: number;
}

export interface UsmePluginConfig {
  mode: PluginMode;
  db: DbConfig;
  extraction: ExtractionConfig;
  consolidation: ConsolidationConfig;
  assembly: AssemblyConfig;
  embeddingApiKey: string;
  spreading: SpreadingConfig;
}

export const DEFAULT_CONFIG: UsmePluginConfig = {
  mode: "log-only",
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
    model: "claude-haiku-4-5",
    entityExtraction: {
      enabled: true,
      model: "claude-haiku-4-5",
    },
  },
  consolidation: {
    cron: "0 3 * * *",
    sonnetModel: "claude-sonnet-4-6",
    skillDraftingModel: "claude-sonnet-4-6",
    reconciliationModel: "claude-sonnet-4-6",
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
  embeddingApiKey: process.env.OPENAI_API_KEY ?? "",
  spreading: {
    maxDepth: 2,
  },
};

export function resolveConfig(
  partial?: Partial<UsmePluginConfig>,
): UsmePluginConfig {
  if (!partial) return { ...DEFAULT_CONFIG };
  return {
    mode: partial.mode ?? DEFAULT_CONFIG.mode,
    db: { ...DEFAULT_CONFIG.db, ...partial.db },
    extraction: {
      ...DEFAULT_CONFIG.extraction,
      ...partial.extraction,
      entityExtraction: {
        ...DEFAULT_CONFIG.extraction.entityExtraction,
        ...partial.extraction?.entityExtraction,
      },
    },
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
    embeddingApiKey: process.env.OPENAI_API_KEY || partial.embeddingApiKey || "",
    spreading: {
      maxDepth: partial.spreading?.maxDepth ?? DEFAULT_CONFIG.spreading.maxDepth,
    },
  };
}
