/**
 * Canonical model constants for the USME consolidation pipeline.
 *
 * All model references in the pipeline should import from here.
 * Override via environment variables or openclaw.json plugin config.
 *
 * Precedence (highest → lowest):
 *   1. openclaw.json plugin config (e.g. consolidation.sonnetModel)
 *   2. Environment variables below
 *   3. Constants defined here (safe defaults)
 */

/** Primary reasoning model — used for episodification, skill drafting, reconciliation, reflection. */
export const DEFAULT_REASONING_MODEL =
  process.env.USME_REASONING_MODEL ?? "claude-sonnet-4-6";

/** Fast/cheap model — used for entity extraction, importance scoring. */
export const DEFAULT_FAST_MODEL =
  process.env.USME_FAST_MODEL ?? "claude-haiku-4-5";

/** OpenAI embedding model — must match EMBEDDING_DIMENSIONS. */
export const DEFAULT_EMBEDDING_MODEL =
  process.env.USME_EMBEDDING_MODEL ?? "text-embedding-3-small";

/** Embedding vector dimensions — must match DEFAULT_EMBEDDING_MODEL. */
export const EMBEDDING_DIMENSIONS =
  parseInt(process.env.USME_EMBEDDING_DIMENSIONS ?? "1536", 10);
