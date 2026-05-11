const DEFAULT_PREVIEW_CHARS = 120;

export function safePreview(value: unknown, max = DEFAULT_PREVIEW_CHARS): { length: number; preview: string } {
  const text = typeof value === "string" ? value : String(value ?? "");
  return {
    length: text.length,
    preview: text.replace(/\s+/g, " ").slice(0, max),
  };
}

export function keyMeta(value: string | undefined | null): { present: boolean; length: number } {
  return {
    present: !!value,
    length: value?.length ?? 0,
  };
}

export function errMeta(err: unknown): { err: unknown; errMessage: string; errName?: string; phase?: string } {
  if (err instanceof Error) {
    return { err, errMessage: err.message, errName: err.name };
  }
  return { err, errMessage: String(err) };
}
