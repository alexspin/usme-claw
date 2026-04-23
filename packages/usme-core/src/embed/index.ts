export { embedText, embedBatch } from "./openai.js";

import { z } from 'zod';
import { logger as log } from '../logger.js';

const EmbeddingVectorSchema = z.array(z.number());

/**
 * Safely parse an embedding from DB (may come back as string JSON or number[]).
 * Returns null on invalid data rather than throwing.
 */
export function parseEmbeddingSafe(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    const result = EmbeddingVectorSchema.safeParse(raw);
    if (!result.success) {
      log.warn({ err: result.error }, 'parseEmbeddingSafe: array failed Zod validation');
      return null;
    }
    return result.data;
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      const result = EmbeddingVectorSchema.safeParse(parsed);
      if (!result.success) {
        log.warn({ err: result.error }, 'parseEmbeddingSafe: parsed JSON failed Zod validation');
        return null;
      }
      return result.data;
    } catch {
      // fall through
    }
  }
  return null;
}
