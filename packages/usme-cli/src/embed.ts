/**
 * Query embedding for semantic commands (search, assemble).
 * Reuses @usme/core's embedText (OpenAI text-embedding-3-small, 1536-dim).
 */

import { embedText } from "@usme/core";

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "OPENAI_API_KEY is not set. `search` and `assemble` need it to embed the query. " +
        "`grep`, `constraints`, `inspect`, and `stats` work without it.",
    );
    this.name = "MissingApiKeyError";
  }
}

export async function embedQuery(query: string): Promise<number[]> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new MissingApiKeyError();
  return embedText(query, key);
}
