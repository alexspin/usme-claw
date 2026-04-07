# USME Code Review
**Date:** 2026-04-07  
**Scope:** Full codebase review — bugs, anti-patterns, design issues, latency analysis  
**State at review:** Active mode. 503 sensory traces (all embedded), 38 episodes (all embedded), 10 concepts (all embedded, 0 reconciled), 0 entities, 0 skills, 0 shadow_comparisons.

> **Note:** `ARCHITECTURE-REVIEW.md` was written ~2026-04-06 before several major fixes. Items marked ~~strikethrough~~ in that doc are now resolved. This document supersedes it.

---

## What Changed Since Architecture Review

These items from ARCHITECTURE-REVIEW.md are **now fixed**:

| Item | Status |
|------|--------|
| Fix 1: embed episodes/concepts/skills at creation | ✅ Done — nightly.ts embeds after insert |
| Fix 2: afterTurn() calls extractor | ✅ Done — runFactExtraction + runEntityExtraction wired |
| Fix 3: start scheduler from bootstrap() | ✅ Done — startScheduler() called in bootstrap() |
| Fix 6: entity extraction never called | ✅ Done — wired into afterTurn() |
| Fix 4: LCM transform registration bug | ✅ Moot — plugin is now pure ContextEngine, no LCM transform path |
| bumpAccessCounts | ✅ Added — fire-and-forget after assemble() |
| Pre-warm embedding cache | ✅ Done — warmCache Map, keyed by sessionId |
| USME context moved to synthetic user message | ✅ Done — preserves Anthropic prefix cache |
| stripMetadataEnvelope unified | ✅ Done — both shadow.ts and plugin.ts use extractText |

---

## Active Bugs

### 🔴 Critical

**1. `turnCounter` is module-level and shared across sessions**  
Location: `plugin.ts:187` — `let turnCounter = 0`  
Problem: `turn_index` in `sensory_trace` is supposed to be per-session but uses a global monotonic counter. With 5 concurrent sessions, session B's traces get turn_index 100 when it's actually turn 3. Breaks time-ordering assumptions in episodification clustering.  
Fix: Derive turn_index from `messages.filter(m => m.role === 'user').length` (already computed as `turnIndexFromMessages` in assemble — use that pattern) or maintain a per-sessionId counter in a Map.

**2. `compact()` stub with `ownsCompaction: true`**  
Location: `plugin.ts:410-430`  
Problem: Plugin declares it owns compaction but always returns `{ compacted: false }`. If OpenClaw defers its own compaction strategy when `ownsCompaction: true`, sessions that fill their context window get no relief. Long coding sessions will hit context limits silently.  
Fix (immediate): Set `ownsCompaction: false` until properly implemented.  
Fix (full): Call `stepEpisodify()` on the current session's traces and return a summary string.

**3. `updateConceptContent` doesn't re-embed**  
Location: `queries.ts:updateConceptContent`, called from `reconcile.ts`  
Problem: When reconciliation updates a concept's content, the embedding column stays as the old content's vector. All future ANN searches will use stale vectors. The concept's text says one thing; its position in embedding space says another.  
Fix: After `UPDATE concepts SET content = $2`, call `embedText(newContent)` and update the embedding in the same transaction or immediately after.

**4. Pre-warm cache memory leak**  
Location: `plugin.ts:warmCache`  
Problem: `warmCache` is a module-level Map that lives for the process lifetime. If `ingest()` fires for a session but `assemble()` never runs (aborted turns, heartbeat-only sessions, subagent spawns), the pre-warmed embedding Promise stays in the map forever.  
Fix: Add a max TTL or max size. Simplest: on each `ingest()`, evict entries older than 60 seconds, or cap the map at 100 entries.

---

### 🟡 Medium

**5. `insight` type in prompt but not in TypeScript union**  
Location: `extractor.ts:ExtractedItem.type`, `fact-extraction-v1.ts` prompt  
Problem: The extraction prompt template lists `insight` as a valid type (line: `"type": "fact|preference|decision|plan|insight|anomaly|ephemeral"`). The DB has 13 rows with `memory_type='insight'`. But `ExtractedItem.type` is typed as `"fact" | "preference" | "decision" | "plan" | "anomaly" | "ephemeral"` — `insight` is missing. TypeScript silently allows this because the JSON response is cast with `as FactExtractionResult`. The `insight` values pass through fine at runtime, but the type system gives no coverage.  
Fix: Add `"insight"` to the `ExtractedItem.type` union. Also add it to `SensoryTrace.memory_type`.

**6. Dead inline extraction function in `shadow.ts`**  
Location: `shadow.ts:113-137` — the large `extractBlocks` function nested inside the `setImmediate` callback  
Problem: `extractText()` is imported from `plugin.ts` and used correctly for `cleanQuery` derivation. But the message serialization block still has a hand-rolled inline block extractor. Duplication. Any fix to `extractText` won't affect the shadow path.  
Fix: Use `extractText(m.content)` in the serialized messages map, same as plugin.ts afterTurn().

**7. `stepPromote` marks episodes as `promoted_at` even when LLM returned no concepts**  
Location: `nightly.ts:stepPromote:207`  
Problem: After the Sonnet call, episodes are batch-marked `promoted_at` regardless of whether any concepts were extracted. If the model returns `{ "concepts": [] }` (empty result due to noise or error), those episodes are permanently locked out of future promotion attempts.  
Fix: Only mark `promoted_at` if at least one concept was successfully inserted. Or add a separate `promotion_attempted_at` field to allow retries.

**8. N+1 queries in `stepReconcile`**  
Location: `reconcile.ts:stepReconcile`  
Problem: For each unreconciled concept: 1 ANN query + 1 tag-overlap query + 1 Sonnet call = serial round trips. With 10 concepts = 20 DB queries + 10 LLM calls. With 1000 concepts = 2000 DB queries + 1000 LLM calls (hours of nightly runtime).  
Fix (medium-term): Batch the ANN queries. Run one large query to find all concept neighborhoods at once, then distribute to LLM calls. Or add a `reconciledCount` cap per run.

**9. `ExtractionQueue` is completely unused**  
Location: `extract/queue.ts` exists; `afterTurn()` and `shadow.ts` use bare `setImmediate`  
Problem: If multiple turns complete in rapid succession (batch import, fast-typing user, tool call bursts), multiple concurrent Haiku API calls fire simultaneously. No backpressure. Can trigger rate-limit cascades.  
Fix: Route `runFactExtraction` and `runEntityExtraction` calls through `getExtractionQueue().enqueue(...)`.

**10. Model ID inconsistency**  
Location: `config.ts:DEFAULT_CONFIG`  
Problem: `extraction.model: "claude-haiku-4-5"` and `entityExtraction.model: "claude-haiku-4-20250414"` — two different strings for Haiku. One is likely wrong or both are wrong (Anthropic model IDs have a specific date format like `claude-haiku-4-5-20250714`). This may be silently falling back to a default model.  
Fix: Validate model IDs against the Anthropic API. Unify to a single haiku alias or correct date-stamped ID.

**11. Debug `/tmp/usme-debug` logging left in production**  
Location: `queries.ts`, `extractor.ts`, `shadow.ts` — all have `dbg()` functions writing to `/tmp/usme-debug/*.log`  
Problem: Every production run appends to `/tmp` files. On a server running for weeks, these grow unbounded. Not appropriate for production.  
Fix: Gate on `process.env.USME_DEBUG === '1'`. Or remove entirely — the structured `console.log/error` calls are sufficient.

---

### 🟢 Low / Design

**12. Verbatim traces pollute ANN retrieval**  
`item_type='verbatim'` rows are stored in `sensory_trace` with embeddings (deferred via setImmediate). The ANN query in `retrieve.ts` doesn't filter by `item_type`, so raw unstructured messages compete with extracted semantic facts. Verbatim traces tend to be long, noisy, context-specific, and redundant with extracted facts from the same message. They'll lower precision.  
Options: (a) exclude verbatim from ANN retrieval by adding `AND item_type = 'extracted'` to the sensory_trace query, or (b) keep but lower their relevance with a lower `utility_prior`. Option (a) is cleaner.

**13. `annSearchK` in mode profiles is silently ignored**  
Location: `modes.ts:annSearchK`, `retrieve.ts`  
`MODE_PROFILES` defines `annSearchK: 40` (brilliant), `60` (psycho-genius), `20` (smart-efficient), but `retrieve.ts` only uses `candidatesPerTier`. `annSearchK` is never read. Either remove the field or pass it to retrieve as the HNSW ef_search parameter (pgvector SET `hnsw.ef_search`).

**14. `ingestBatch` is serial**  
`ingestBatch` calls `engine.ingest()` in a for loop. Fine for small batches (session history import), wasteful for large ones. Could use `Promise.all` or a bulk SQL INSERT.

**15. Skill promotion path is missing**  
Skills are created as `status='candidate'` by `stepSkillDraft()`. The ANN query in `retrieve.ts` filters `WHERE status = 'active'`. There is no code that ever promotes a skill from `candidate` → `active`. Skills will accumulate in the DB but never appear in retrieval.  
Fix: Add a `stepPromoteSkills` function that auto-promotes candidates with `teachability >= config threshold` (e.g., 0.7) and reasonable `use_count`.

---

## Latency Analysis

### Hot Path (per turn, synchronous)

```
ingest() — called when user message arrives
  insertSensoryTrace:        ~5ms   (DB write)
  setImmediate embed-after-insert:  async (hidden)
  warmCache.set(embedText()):       async Promise started, not awaited

assemble() — called before model sees context
  warmCache lookup:           ~0ms
  
  ── Case A: pre-warm HIT (normal case, same turn as ingest) ──
  await warmedEmbeddingPromise:   ~0ms (already resolved, OAI was ~420ms but hidden)
  ANN queries (5 tiers parallel):  ~20-80ms
  score + critic + pack:           ~1ms (in-process)
  Total assemble():                ~25-85ms ✅ within 150ms budget

  ── Case B: pre-warm MISS ──
  embedText() fresh call:          ~420ms (OpenAI text-embedding-3-small)
  ANN queries:                     ~25ms
  Total assemble():                ~445ms ❌ 3x over budget
```

**Pre-warm miss triggers:**
- First turn of a session (no prior ingest)
- Heartbeat turns (isHeartbeat=true skips ingest, clears warmCache path)
- Sub-agent spawns (fresh session, no ingest yet)
- `ingestBatch` with multiple messages — only the last user message gets pre-warmed; if assemble is called with the same session after ingest already happened, warmCache has the right key; but if assemble fires for a different session or message, miss

**ANN query breakdown:**
- Per tier: `embedding <=> $1::vector ORDER BY ... LIMIT 20` with HNSW index
- Postgres HNSW with `ef_search=40` (default): ~5-15ms per query on warm cache
- 5 tiers in parallel: dominated by slowest tier ~15-25ms
- 80ms per-tier timeout via `withTimeout` is generous — actual queries should be 5-25ms

**Realistic P95 (warm path):** ~50-80ms including pre-warm  
**Realistic P95 (cold/miss path):** ~440-500ms — **exceeds budget**

### Async Path (fire-and-forget, afterTurn)

```
afterTurn() — fires after model responds
  setImmediate:                     ~0ms (schedules, returns)
  
  Inside setImmediate:
    serialized turn preparation:   ~1ms
    runFactExtraction:
      Haiku API call:               ~300-600ms
      parse + embed N items:        ~420ms × N (parallel via setImmediate per item... actually serial in persistExtractedItems)
      dedup check per item:         ~5ms × N (DB query)
      insertSensoryTrace × N:       ~5ms × N
      Total for 5 extracted facts:  ~1.5-2.5s

    runEntityExtraction (parallel):
      Haiku API call:               ~300-600ms
      embed × M entities:           ~420ms × M (serial in persistEntities)
      dedup check × M:              ~10ms × M
      insert × M:                   ~5ms × M
      Total for 3 entities:         ~1.8-2.5s
```

**Total async overhead per turn: 2-5 seconds** (completely hidden from user — fire-and-forget)

**Issue:** `persistExtractedItems` embeds items serially (one `await embedText()` per item). 5 extracted facts = 5 sequential API calls. Use `embedBatch()` for a single batched call.

### Nightly Consolidation

```
stepEpisodify (1 episode per 15 traces):
  500 traces → 33 episodes
  33 × Sonnet call:    ~33 × 2s = 66s
  33 × embedText:      ~33 × 0.42s = 14s
  Total:               ~80s

stepPromote:
  1 Sonnet call:       ~3s
  N × embedText (new concepts): ~N × 0.42s
  Total:               ~5s (for ~10 new concepts)

stepReconcile:
  10 concepts × (1 ANN + 1 tag + 1 Sonnet):  ~10 × 3s = 30s
  Total:               ~30s

stepContradictions:
  1 DB query
  K × Sonnet calls:   ~K × 3s
  Total:               ~0-30s

stepSkillDraft:
  1 Sonnet call:       ~3s
  Total:               ~5s

stepDecayAndPrune:
  3 DB UPDATE/DELETE:  ~10ms
  Total:               ~0s

Full nightly (500 traces): ~120-150s (2-3 minutes) ✅
At 5000 traces:            ~1200s (20 minutes) — approaching problematic
```

### Optimization Opportunities (Priority Order)

1. **Use `embedBatch()` in `persistExtractedItems`** — 5 serial embeds → 1 batched call. Saves ~1.5s per turn.
2. **Local embedding model (Ollama)** — eliminate 420ms OpenAI round-trip entirely. Olama `nomic-embed-text` runs in ~5ms locally. Most impactful latency change possible.
3. **Set `hnsw.ef_search`** per mode — brilliant/smart-efficient can use lower ef_search (faster ANN, slightly lower recall).
4. **Batch stepReconcile DB queries** — single ANN query for all concepts instead of N individual queries.
5. **Limit stepEpisodify batches** — cap at 200 traces per night to keep nightly under 60s.

---

## Doc vs Code Drift

### `docs/design.md`
- **Directory tree (Section 3)** is stale. Actual structure:
  - `consolidate/` is a single `nightly.ts` (not `episodify.ts`, `promote.ts`, `contradict.ts`, `skill-draft.ts`, `decay.ts`)
  - No `adapter.ts` — adapter logic is inline in plugin.ts (`injectedToSystemAddition`)
  - `schema/config.ts` doesn't exist — config is in `extract/prompts/types.ts` and each package's `config.ts`
  - Migration 007 is `shadow_comparisons.sql` (not `entity_relationships.sql` — that's 006/007)
- **Section 12 (ContextEngine Implementation)** is pseudocode that differs from actual implementation.
- The `assemble()` description says "prepend `<usme-context>` block to system prompt" but actual implementation prepends as synthetic user message.
- D4 says "Entities surface through concepts" — now entities have their own tier in retrieval.

### `docs/ARCHITECTURE-REVIEW.md`
Many items in "What Is Dead Code / Disconnected" and "Part D: Ordered Fix List" are now resolved. The doc is misleading. See the resolution table at the top of this file.

### `README.md`
- TODO section may reference already-completed items.
- "Hot path" description says system prompt injection — it's actually synthetic user message injection now.

---

## Summary Table

| Component | State | Notes |
|-----------|-------|-------|
| Verbatim ingest | Working but wasteful | Pollutes ANN retrieval; consider filtering |
| Fact extraction (afterTurn) | Working | Serial embeds; use embedBatch |
| Entity extraction | Working (just wired) | No production data yet |
| ExtractionQueue | Complete, unused | Use it for backpressure |
| ANN retrieve | Working | All tiers populated. Pre-warm miss = 440ms |
| Scoring/critic/pack | Correct | annSearchK ignored |
| Pre-warm cache | Working | Memory leak on miss; needs TTL/eviction |
| Shadow comparisons | 0 rows (active mode) | recordShadowComparison fires but no turns yet |
| Nightly consolidation | Scheduled, working | stepPromote marks episodes too aggressively |
| Concept reconciliation | Built, scheduled | Not run yet; updateConceptContent doesn't re-embed |
| compact() | Stub | ownsCompaction=true is dangerous |
| Skill promotion | Missing | Skills accumulate as candidate, never activated |
| turnCounter | Bug | Module-level, breaks multi-session correctness |
| Debug logging | In production | /tmp/usme-debug writes everywhere |
| Model IDs | Inconsistent | haiku-4-5 vs haiku-4-20250414 |
