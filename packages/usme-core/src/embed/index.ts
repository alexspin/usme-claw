export { embedText, embedBatch } from "./openai.js";

/**
 * Safely parse an embedding from DB (may come back as string JSON or number[]).
 * Returns null on invalid data rather than throwing.
 */
export function parseEmbeddingSafe(raw: unknown): number[] | null {
  if (Array.isArray(raw)) {
    // Validate it's actually numbers
    if (raw.length > 0 && typeof raw[0] !== 'number') {
      return null;
    }
    return raw as number[];
  }
  if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && (parsed.length === 0 || typeof parsed[0] === 'number')) {
        return parsed as number[];
      }
    } catch {
      // fall through
    }
  }
  return null;
}
