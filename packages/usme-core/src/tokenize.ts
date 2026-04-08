import { get_encoding, type Tiktoken } from "tiktoken";

let enc: Tiktoken | null = null;

/** Count tokens using cl100k_base (close enough to Claude's tokenizer for budget purposes). */
export function countTokens(text: string): number {
  if (!enc) enc = get_encoding("cl100k_base");
  return enc.encode(text).length;
}
