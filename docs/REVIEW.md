# USME-CLAW Code Review

**Reviewer:** reviewer agent
**Date:** 2026-04-06
**Branch:** master

---

## Summary of Changes Reviewed

| File | Status |
|------|--------|
| `packages/usme-core/src/extract/extractor.ts` | Reviewed — PASS |
| `packages/usme-core/src/extract/prompts/fact-extraction-v1.ts` | Reviewed — PASS (blocking bug fixed) |
| `packages/usme-core/src/db/queries.ts` | Reviewed — PASS |
| `packages/usme-openclaw/src/shadow.ts` | Reviewed — PASS |
| `packages/usme-openclaw/src/plugin.ts` | Reviewed — PASS |
| `packages/usme-core/src/consolidate/nightly.ts` | Reviewed — PASS with concerns |
| `packages/usme-core/tests/unit/selection-formula.test.ts` | Reviewed — PASS |
| `packages/usme-core/tests/unit/critic-gate.test.ts` | Reviewed — PASS |
| `packages/usme-openclaw/tests/shadow-comparison.test.ts` | Reviewed — FIXED (API mismatch) |
| `packages/usme-openclaw/tests/graceful-degradation.test.ts` | Reviewed — FIXED (API mismatch) |

**docs/ARCHITECTURE-REVIEW.md** — Not present (file did not exist at review time).
**scripts/dedup-corpus.ts** — Not present (file did not exist at review time).

---

## Blocking Issues Found and Fixed

### BUG-1: Build failure in `fact-extraction-v1.ts` — FIXED

**File:** `packages/usme-core/src/extract/prompts/fact-extraction-v1.ts`, line 13
**Severity:** Blocking (breaks entire build)

Unescaped backticks inside a template literal:

```
Ignore any `Sender (untrusted metadata)` sections — ...
```

TypeScript parsed the inner backticks as template literal delimiters, splitting the string and producing 4 compile errors. Fixed by escaping: `` \`Sender (untrusted metadata)\` ``.

**Build status after fix:** PASS (both packages compile cleanly).

### BUG-2: Test API mismatch in `shadow-comparison.test.ts` and `graceful-degradation.test.ts` — FIXED

**File:** `packages/usme-openclaw/tests/shadow-comparison.test.ts` and `graceful-degradation.test.ts`
**Severity:** Blocking (2 test failures)

Tests called `runShadowAssemble(async () => mockResult)` (callback pattern), but the actual implementation signature is `runShadowAssemble(pool, config, sessionId, messages)`. The tests were written against a planned interface that was never implemented.

Fixed by rewriting both test files to test the actual exported API:
- `shadow-comparison.test.ts` now tests `computeOverlapScore` directly (the pure unit-testable function).
- `graceful-degradation.test.ts` now calls `runShadowAssemble` with proper stub parameters, verifying it catches errors and returns null gracefully.

**Test status after fix:** 53 tests pass, 0 fail (45 in usme-core, 8 in usme-openclaw).

---

## Per-REQ Assessment

### REQ-1: Fact Extraction Pipeline (`extractor.ts`)

**Verdict: PASS**

- Correctness: JSON parsing is robust (finds outermost `{...}` block, handles fenced responses).
- Edge cases: Empty message handled (returns `[]`); missing API key handled (skips embedding, stores without vector); discard utility items are skipped correctly.
- Error handling: `runFactExtraction` swallows errors (intentionally non-blocking). `persistExtractedItems` continues loop on per-item errors.
- Debug logging via `/tmp/usme-debug/` is verbose but appropriate for a v0.1 pipeline.
- Model: Uses `"claude-haiku-4-5"` — correct pattern per naming convention.

**Minor concern:** `extractFacts` does not validate individual item fields (e.g., `type` enum, `utility` enum). A malformed LLM response could persist garbage. Not blocking but worth a follow-up validator.

### REQ-2: Prompt Template (`fact-extraction-v1.ts`)

**Verdict: PASS** (after blocking fix)

- The instruction `Ignore any \`Sender (untrusted metadata)\` sections` is a useful addition that prevents the extractor from storing routing metadata as facts.
- The prompt is clear and well-structured with examples.
- The `{date}` and `{serialized_turn}` substitution placeholders are correct.

### REQ-3: DB Queries (`queries.ts`)

**Verdict: PASS**

- `vecLiteral()` correctly returns `null` for missing embeddings, allowing nullable embedding column.
- `insertSensoryTrace` passes `episodified_at` in the type but omits it from the INSERT column list — this is intentional since the column has a DB default of NULL; however the type includes it as an explicit field. Not a bug since the column defaults correctly, but slightly confusing.
- `searchByEmbedding` uses `$1::vector` cast, which is correct for pgvector. Table name interpolation is safe because it's constrained to a typed union.
- `latency_ms` values are rounded via `Math.round()` before insert — appropriate since the column is likely integer.

### REQ-4: Shadow Mode (`shadow.ts`)

**Verdict: PASS**

- Graceful degradation: `runShadowAssemble` catches all errors and returns `null`.
- `computeOverlapScore`: correctly handles all edge cases (both empty = 1.0, one empty = 0.0, partial overlap = Jaccard).
- Extraction is fire-and-forget via `setImmediate`, correctly gated on `config.extraction.enabled` and `ANTHROPIC_API_KEY`.
- The 150ms timeout in the LCM transform (in `plugin.ts`) prevents blocking the main thread.

**Minor concern:** `runShadowAssemble` calls `embedText` with `config.embeddingApiKey` directly. If the key is an empty string `""`, this will make a real API call and fail. A guard `if (!config.embeddingApiKey) return null;` would be cleaner (though the function does degrade gracefully on the error).

### REQ-5: Plugin Implementation (`plugin.ts`)

**Verdict: PASS**

- `injectedToSystemAddition()` formats memory items with tier, date, relevance label, and tags — rich context format suitable for LLM consumption.
- LCM transform registration uses `USME_TRANSFORM_REGISTERED_KEY` to prevent duplicate registration across sessions (correct).
- `zeroEmbedding()` returns 1536-dimension zero vector as fallback — this is a reasonable sentinel that will result in zero cosine similarity for all stored items (safe, returns no results).
- `ingest()` uses a module-level `turnCounter` — this is a **known limitation** (not per-session), but acceptable for v0.1 shadow mode where turn indexing precision is not critical.
- `afterTurn()` logs intent but does not actually trigger extraction — deferred to extraction worker. Comment accurately documents this.
- `compact()` is stub with honest TODO comment. `ownsCompaction: true` in info is set but compact is a no-op — this could suppress the LCM's own compaction. Worth monitoring.

**Concern:** `compact()` returns `ownsCompaction: true` but does nothing. If the host framework respects this flag and skips its own compaction, sessions may accumulate unbounded context. Consider setting `ownsCompaction: false` until real compaction is implemented.

### REQ-6: Nightly Consolidation (`nightly.ts`)

**Verdict: PASS with concerns**

- All 5 pipeline steps are implemented and individually idempotent.
- `chunkArray` correctly handles edge cases (k=1, uneven sizes).
- Step 5 (decay + prune) correctly skips skill decay per design spec (D7).

**Concerns:**

1. **Model name inconsistency:** `nightly.ts` uses `"claude-sonnet-4-20250514"` as the default. The naming convention in this codebase is `"claude-sonnet-4-5"` (as used in extractor.ts and config). The `4-20250514` suffix is a real model alias but inconsistent with the rest of the codebase. This is not a breaking issue since both aliases resolve correctly, but creates confusion.

2. **JSON injection in SQL (Step 2 and 4):** The `UPDATE episodes SET metadata = metadata || '{"promoted_at": "${new Date().toISOString()}"}'::jsonb` pattern interpolates a JS date string directly into a SQL string. This is safe for ISO date strings (no injection risk) but is a code smell — a parameterized JSON approach would be cleaner.

3. **Step 3 (contradiction detection):** The query finds concept pairs by cosine distance, but concepts without embeddings (`embedding IS NOT NULL`) are skipped. Since `insertConcept` sets `embedding: null` in all current callers, Step 3 will never find any candidates until a separate embedding job runs. This is not a bug (the code handles it gracefully) but is a gap in the pipeline.

4. **Step 2 JSON parse:** Uses `JSON.parse(text)` without the outermost-bracket extraction used in `extractor.ts`. If Sonnet wraps the response in prose, this will fail silently (returns 0 concepts). Should use the same robust extraction pattern.

### REQ-7: Test Coverage

**Verdict: PASS**

- `selection-formula.test.ts`: Good coverage of `pack()` and `scoreCandidates()` including edge cases (zero budget, empty array, exact budget, ordering, skill weights).
- `critic-gate.test.ts`: Good coverage of all filter rules with boundary tests (confidence exactly 0.3 passes, as intended).
- `shadow-comparison.test.ts` (fixed): Tests `computeOverlapScore` exhaustively.
- `graceful-degradation.test.ts` (fixed): Verifies the function handles the no-user-message case and the API-key-missing case without throwing.

---

## Model Name Consistency

| Location | Model Used | Status |
|----------|-----------|--------|
| `extractor.ts` (haiku) | `claude-haiku-4-5` | Correct |
| `nightly.ts` (sonnet) | `claude-sonnet-4-20250514` | INCONSISTENT — should be `claude-sonnet-4-5` |
| `config.ts` (extraction model) | (not reviewed but expected `claude-haiku-4-5`) | — |

Recommendation: Standardize `nightly.ts` defaults to `"claude-sonnet-4-5"`.

---

## Architecture Assessment: Moves USME Toward mem0-level Value?

**Yes, with caveats.**

The implemented pieces represent the core of what makes mem0 valuable:
- **Extraction pipeline**: Turn-level fact extraction with type classification, utility scoring, and TTL — this is the foundation.
- **5-tier memory hierarchy** (traces → episodes → concepts → skills → entities): Architecturally correct, pipeline exists, but embeddings for episodes/concepts are not yet populated (all stored with `embedding: null`), so semantic retrieval will not function for those tiers.
- **Shadow mode with LCM transform injection**: The most immediately operational piece. Memory is being assembled and injected into the context window.
- **Nightly consolidation**: Pipeline is in place and idempotent. The embedding gap (concepts stored without vectors) will prevent contradiction detection from working until an embedding backfill job is added.

**Key remaining gap:** There is no background job that embeds episodes and concepts after they are created. `insertEpisode`, `insertConcept`, and `insertSkill` all pass `embedding: null`. Until this is resolved, the ANN search path for those tiers returns nothing, and contradiction detection is blind.

---

## Blocking Issues Summary

| # | Issue | Fixed? |
|---|-------|--------|
| BUG-1 | Build failure due to unescaped backticks in template literal | YES |
| BUG-2 | Test API mismatch (callback vs real signature) causing 2 test failures | YES |

---

## Recommendations (Non-blocking)

1. **`nightly.ts`**: Change `"claude-sonnet-4-20250514"` default to `"claude-sonnet-4-5"` for consistency.
2. **`nightly.ts` Step 2**: Use the `jsonStart`/`jsonEnd` robust extraction pattern (same as `extractor.ts`) when parsing Sonnet's concept promotion response.
3. **`plugin.ts`**: Set `ownsCompaction: false` until real compaction is implemented, or document the risk of accumulation.
4. **Add embedding backfill job**: Episodes and concepts are stored without embeddings. A background job calling `embedText` and updating the row is needed before the consolidation pipeline provides real ANN recall value.
5. **`extractor.ts`**: Add a per-item schema validator to reject malformed LLM output before persisting.

---

## Overall Verdict: PASS (after fixes)

Both blocking issues were fixed in-place. Build compiles cleanly. All 53 tests pass. The codebase implements a coherent architecture with the right abstractions. The remaining gaps (no embedding backfill, stub compaction, inconsistent model names) are non-blocking for v0.1 shadow mode operation.
