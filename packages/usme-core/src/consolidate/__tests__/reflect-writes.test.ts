import { describe, it, expect, vi, beforeEach } from "vitest";
import { tryParseArray, normalizeArrayFields, writeConstraints } from "../reflect-writes.js";
import type { SpCounter } from "../reflect-writes.js";

// ── tryParseArray ──────────────────────────────────────────

describe("tryParseArray", () => {
  it("parses a valid JSON array", () => {
    const result = tryParseArray('[{"a":1},{"b":2}]');
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("returns null for a valid JSON object (not array)", () => {
    const result = tryParseArray('{"key":"value"}');
    expect(result).toBeNull();
  });

  it("recovers malformed JSON with unescaped newlines via jsonrepair (strategy 2)", () => {
    // Real LLM output sometimes has literal newlines inside JSON strings
    const malformed = '[{"name":"foo","description":"line one\nline two"}]';
    const result = tryParseArray(malformed);
    expect(result).not.toBeNull();
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[])).toHaveLength(1);
  });

  it("recovers embedded [...] block via bracket extraction (strategy 3)", () => {
    const withPreamble = 'Some text before [{"x":1}] and after';
    const result = tryParseArray(withPreamble);
    expect(result).not.toBeNull();
    expect(result).toEqual([{ x: 1 }]);
  });

  it("returns null for completely unparseable input", () => {
    const result = tryParseArray("this is not json at all {{{{");
    expect(result).toBeNull();
  });

  it("returns null for a JSON string (not array)", () => {
    const result = tryParseArray('"just a string"');
    expect(result).toBeNull();
  });
});

// ── normalizeArrayFields ───────────────────────────────────

describe("normalizeArrayFields", () => {
  it("coerces null field to []", () => {
    const raw: Record<string, unknown> = {
      concept_updates: null,
      new_skills: [],
      contradictions: [],
      entity_updates: [],
    };
    normalizeArrayFields(raw);
    expect(raw.concept_updates).toEqual([]);
  });

  it("recovers string-encoded JSON array field", () => {
    const raw: Record<string, unknown> = {
      concept_updates: '[{"concept_id":"abc","action":"raise","reason":"test"}]',
      new_skills: [],
      contradictions: [],
      entity_updates: [],
    };
    normalizeArrayFields(raw);
    expect(Array.isArray(raw.concept_updates)).toBe(true);
    expect((raw.concept_updates as unknown[])).toHaveLength(1);
  });

  it("leaves already-array field untouched", () => {
    const arr = [{ concept_id: "x", action: "lower", reason: "stale" }];
    const raw: Record<string, unknown> = {
      concept_updates: arr,
      new_skills: [],
      contradictions: [],
      entity_updates: [],
    };
    normalizeArrayFields(raw);
    expect(raw.concept_updates).toBe(arr);
  });

  it("coerces undefined field to []", () => {
    const raw: Record<string, unknown> = {
      concept_updates: undefined,
      new_skills: [],
      contradictions: [],
      entity_updates: [],
    };
    normalizeArrayFields(raw);
    expect(raw.concept_updates).toEqual([]);
  });
});

// ── writeConstraints dedup ─────────────────────────────────

describe("writeConstraints", () => {
  function makeClient(similarityRows: unknown[]) {
    return {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (typeof sql === 'string' && sql.includes('similarity')) {
          return { rows: similarityRows };
        }
        return { rows: [] };
      }),
    };
  }

  it("skips INSERT when similarity check returns a row (dedup guard)", async () => {
    const client = makeClient([{ content: "Never restart gateway directly" }]);
    const sp: SpCounter = { count: 0 };
    await writeConstraints(
      client,
      [{ pattern: "NEVER", content: "Never restart the gateway process directly" }],
      sp,
    );
    // Should have called SAVEPOINT, similarity check, RELEASE — but NOT INSERT
    const calls = client.query.mock.calls.map((c: unknown[]) => (c[0] as string).trim().split(/\s+/)[0].toUpperCase());
    expect(calls).toContain("SAVEPOINT");
    const insertCalls = client.query.mock.calls.filter((c: unknown[]) => (c[0] as string).trim().toUpperCase().startsWith("INSERT"));
    expect(insertCalls).toHaveLength(0);
  });

  it("proceeds with INSERT when similarity check returns no rows", async () => {
    const client = makeClient([]);
    const sp: SpCounter = { count: 0 };
    await writeConstraints(
      client,
      [{ pattern: "PREFER", content: "Always run tests before committing" }],
      sp,
    );
    const insertCalls = client.query.mock.calls.filter((c: unknown[]) => (c[0] as string).trim().toUpperCase().startsWith("INSERT"));
    expect(insertCalls).toHaveLength(1);
  });

  it("does nothing when constraints array is empty", async () => {
    const client = makeClient([]);
    const sp: SpCounter = { count: 0 };
    await writeConstraints(client, [], sp);
    expect(client.query).not.toHaveBeenCalled();
  });
});
