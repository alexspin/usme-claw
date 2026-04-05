/**
 * OpenAI embedding helpers using text-embedding-3-small (1536 dimensions).
 */

import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const CACHE_MAX = 500;

// Simple LRU cache using Map insertion order
const cache = new Map<string, number[]>();

function cacheGet(key: string): number[] | undefined {
  const val = cache.get(key);
  if (val !== undefined) {
    // Move to end (most recently used)
    cache.delete(key);
    cache.set(key, val);
  }
  return val;
}

function cacheSet(key: string, val: number[]): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  if (cache.size > CACHE_MAX) {
    // Delete oldest (first) entry
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
  }
}

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
  const cached = cacheGet(text);
  if (cached) return cached;

  try {
    const client = getClient(apiKey);
    const response = await client.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    });
    const vec = response.data[0].embedding;
    cacheSet(text, vec);
    return vec;
  } catch (err) {
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
    (t) => cacheGet(t) ?? null,
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
        cacheSet(miss.text, vec);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[usme] OpenAI batch embedding failed: ${msg}`);
    }
  }

  return results as number[][];
}
