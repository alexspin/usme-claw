/**
 * OpenAI embedding helpers using text-embedding-3-small (1536 dimensions).
 */

import OpenAI from "openai";
import { LRUCache } from "lru-cache";
import { logger } from "../logger.js";

const log = logger.child({ module: "openai-embed" });

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;

const embeddingCache = new LRUCache<string, number[]>({ max: 5000 });

function getClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

/**
 * Embed a single text string. Returns a 1536-dimensional vector.
 */
export async function embedText(
  text: string,
  apiKey: string,
): Promise<number[]> {
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  try {
    const client = getClient(apiKey);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const vec = response.data[0].embedding;
    embeddingCache.set(text, vec);
    return vec;
  } catch (err) {
    log.error({ err }, "OpenAI embedding failed");
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[usme] OpenAI embedding failed: ${msg}`);
  }
}

/**
 * Embed a batch of texts. Returns an array of 1536-dimensional vectors.
 */
export async function embedBatch(
  texts: string[],
  apiKey: string,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  // Check cache for all, collect misses
  const results: (number[] | null)[] = texts.map(
    (t) => embeddingCache.get(t) ?? null,
  );
  const misses: { index: number; text: string }[] = [];
  for (let i = 0; i < results.length; i++) {
    if (results[i] === null) misses.push({ index: i, text: texts[i] });
  }

  if (misses.length > 0) {
    try {
      const client = getClient(apiKey);
      const response = await client.embeddings.create({
        model: EMBEDDING_MODEL,
        input: misses.map((m) => m.text),
        dimensions: EMBEDDING_DIMENSIONS,
      });
      for (let i = 0; i < response.data.length; i++) {
        const vec = response.data[i].embedding;
        const miss = misses[i];
        results[miss.index] = vec;
        embeddingCache.set(miss.text, vec);
      }
    } catch (err) {
      log.error({ err }, "OpenAI batch embedding failed");
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[usme] OpenAI batch embedding failed: ${msg}`);
    }
  }

  return results as number[][];
}
