# QA Report: reflect-dedup

## Migration

PASS. File `packages/usme-core/db/migrations/016_pg_trgm.sql` exists and is numbered correctly (016, after 015). Both DDL statements are idempotent:
- `CREATE EXTENSION IF NOT EXISTS pg_trgm;`
- `CREATE INDEX IF NOT EXISTS idx_skill_candidates_name_trgm ON skill_candidates USING gin (name gin_trgm_ops) WHERE dismissed_at IS NULL;`

The partial index on `dismissed_at IS NULL` matches the trgm guard query predicate exactly.

## Corpus fetch

PASS. A 6th `pool.query` call fetches from `skill_candidates WHERE dismissed_at IS NULL ORDER BY created_at DESC` (lines 176–178 of reflect.ts). It comes after the 5th query (existing skills, line 171) and does not replace it. Both queries are present and distinct.

## Prompt injection

PASS. The prompt contains two distinct labeled sections:

1. Active skills section (line 319–320): `"Active skills (already promoted — do NOT reproduce these):"` followed by skill names or `(none yet)`.
2. Pending candidates section (line 322–323): `"Pending review queue (already in the candidate backlog — do NOT propose near-duplicates of these):"` followed by candidate entries or `(none yet)`.

Empty candidates produces `(none yet)` (verified by Test 3). Both sections have clear labels and are present in the prompt sent to the LLM.

## Zod schema

PASS. `candidate_dismissals` is in `ReflectionOutputSchema` at lines 105–108:

```ts
candidate_dismissals: z.array(z.object({
  candidate_id: z.number(),
  reason: z.string(),
})).default([]),
```

Uses `.default([])` — guaranteed to never be undefined regardless of LLM output. The field is also not listed in the tool schema's `required` array (line 445), so an absent field from the LLM will flow through Zod's default cleanly.

## Dismissals handler

PASS.

- Dismissals handler runs at lines 655–673, which is BEFORE the `new_skills` processing block starting at line 681. Ordering is correct.
- Uses `SAVEPOINT candidate_dismissals` / `RELEASE SAVEPOINT candidate_dismissals` / `ROLLBACK TO SAVEPOINT candidate_dismissals` — matching the existing SAVEPOINT pattern used throughout the transaction.
- `dismissalsProcessed` is incremented for each dismissed candidate and returned in the result object at line 871 (`dismissalsProcessed`).

## trgm guard

PASS. The guard (lines 691–697) satisfies all requirements:

- Uses `similarity(name, $1)` function (requires pg_trgm).
- Checks `dismissed_at IS NULL` in the WHERE clause.
- Threshold is `> 0.5` (correct — similarity values range 0–1, 0.5 is the threshold).
- Runs BEFORE each candidate INSERT (the `continue` on line 697 skips the SAVEPOINT and INSERT entirely).
- Skipped candidates are logged via `log.info(...)` — not silent.

## Test results

3 test files, 20 tests total — all pass.

- `reflect.test.ts`: 4 tests passed
- `reflect.quality-gate.test.ts`: 7 tests passed
- `reflect.dedup.test.ts`: 9 tests passed

Duration: 1.55s

## Dead code / TODOs

No dead code, commented-out blocks, or leftover TODOs found in reflect.ts. The file is clean. The `mode === 'tiered'` branch at line 197 emits a `log.warn` noting it is not yet implemented — this is intentional scaffolding, not dead code, and is clearly labeled.

## Final verdict

PASS — All 8 checks passed. Migration is idempotent and correctly numbered. Corpus fetch includes candidates as the 6th query without displacing the skills query. Prompt clearly labels both the active skills and pending candidates sections with `(none yet)` fallback. Zod schema has `candidate_dismissals` with `.default([])`. Dismissals handler runs before new_skills, uses SAVEPOINT pattern, and reports `dismissalsProcessed`. trgm guard checks `dismissed_at IS NULL`, uses `similarity()`, threshold 0.5, logs skips. All 20 tests pass with no failures.
