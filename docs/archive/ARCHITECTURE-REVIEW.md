# USME-CLAW Architecture Review

**Date:** 2026-04-06
**Reviewer:** Architect Agent (USME Swarm)
**Scope:** Full source review of packages/usme-core and packages/usme-openclaw

---

## Part A: Full System Map

### What Exists

#### Package: `usme-core`

**DB layer** (`src/db/`)
- `pool.ts` — pg.Pool factory with connection string + pool config.
- `queries.ts` — All SQL mutations and one ANN search helper. Covers: `insertSensoryTrace`, `getUnepisodifiedTraces`, `markTracesEpisodified`, `insertEpisode`, `insertConcept`, `deactivateConcept`, `insertSkill`, `insertEntity`, `insertEntityRelationship`, `insertShadowComparison`, `searchByEmbedding`.

**Schema** (`src/schema/types.ts`)
- Six TypeScript interfaces mirroring DB tables: `SensoryTrace`, `Episode`, `Concept`, `Skill`, `Entity`, `EntityRelationship`, `ShadowComparison`.

**Extraction** (`src/extract/`)
- `extractor.ts` — `runFactExtraction()`: calls Haiku, parses JSON, embeds each item, inserts `sensory_trace` rows of `item_type='extracted'`. Robust JSON extraction (finds outermost `{}`). Debug logging to `/tmp/usme-debug/extractor.log`.
- `entity-extractor.ts` — `runEntityExtraction()`: parallel to fact extraction; extracts named entities + typed relationships; canonical-name dedup + optional cosine dedup; inserts into `entities` / `entity_relationships` tables.
- `queue.ts` — `ExtractionQueue`: FIFO async job queue, one job at a time, setImmediate-based scheduling, drain() support. Singleton `getExtractionQueue()`.
- `prompts/fact-extraction-v1.ts` — Versioned prompt template (`fact_extraction_v1`). Six item types, four utility levels, JSON-only output.
- `prompts/entity-extraction-v1.ts` — Entity/relationship extraction prompt.
- `index.ts` — Re-exports all of the above.

**Assemble** (`src/assemble/`)
- `types.ts` — All interfaces: `AssembleRequest`, `AssembleResult`, `AssembleMetadata`, `InjectedMemory`, `RetrievalCandidate`, `ScoredCandidate`, `AssemblyModeProfile`, `MemoryTier`.
- `retrieve.ts` — Parallel ANN queries across enabled tiers using pgvector `<=>` operator. 80ms per-tier timeout. Five tier queries defined (sensory_trace, episodes, concepts, skills, entities). Returns merged candidate pool.
- `score.ts` — Composite scoring: `similarity*0.40 + recency*0.25 + provenance*0.20 + accessFreq*0.15`. Skill-specific weights that replace recency with teachability. Exponential recency decay with per-tier half-lives. In-process cosine similarity as fallback.
- `critic.ts` — Rule-based filter: hard-discard `utility_prior='discard'`, low-confidence, inactive; soft-filter semantic deduplication (cosine >0.95) and low-confidence model provenance.
- `pack.ts` — Greedy token-budget packing, score-descending, continues scanning after first skip (smaller items may still fit).
- `modes.ts` — Three named mode profiles (`psycho-genius`, `brilliant`, `smart-efficient`) with full parameter sets. `resolveMode()` with optional overrides.
- `index.ts` — Orchestrates: retrieve → score → critic → pack. P95 target 150ms. Returns `AssembleResult` with items + metadata.

**Consolidation** (`src/consolidate/`)
- `nightly.ts` — Five-step pipeline: (1) Episodify: cluster unepisodified extracted traces into episode summaries via Sonnet; (2) Promote: identify recurring concepts from episodes; (3) Contradiction: cosine-similar active concept pairs resolved by Sonnet; (4) Skill Draft: identify reusable workflows from high-utility episodes; (5) Decay + Prune: multiplicative decay on episodes and concepts, delete expired sensory_traces and zero-access low-utility episodes.
- `scheduler.ts` — setTimeout-based cron (default `0 3 * * *` = 3am UTC). Mini-consolidation interval (default 30 min, runs only Step 1). Manual `runNow()` and `runMiniNow()` handles.

**Embed** (`src/embed/`)
- `openai.ts` — Wraps OpenAI `text-embedding-3-small` API. `embedText()` and `embedBatch()`.
- `index.ts` — Re-export.

**Core index** (`src/index.ts`) — Re-exports everything from all sub-modules.

---

#### Package: `usme-openclaw`

**Plugin** (`src/plugin.ts`)
- Implements the `ContextEngine` interface for the OpenClaw framework.
- `bootstrap()`: verifies DB connectivity; registers `usme-inject` LCM transform on `globalThis.__rufus_lcm_context_transforms`. The transform fires on every LCM call, embeds the last user message, runs `coreAssemble()`, and appends a `<usme-context>` block as a new user message. 150ms hard timeout.
- `ingest()`: inserts verbatim `sensory_trace` rows; deferred embedding update via `setImmediate`.
- `afterTurn()`: currently only logs intent to extract — **does not actually call the extractor** (see Section B).
- `assemble()` (direct path): used when mode is `active`; falls through to `coreAssemble()` + `injectedToSystemAddition()`.
- `compact()`: stub — returns `compacted: false`, TODO comment referencing unconverted episodification.
- `prepareSubagentSpawn()` / `onSubagentEnded()`: minimal stubs, log only.
- `dispose()`: closes pool.
- LCM transform registration: idempotent via `__usme_transform_registered` guard. Transforms are stored as raw functions on `globalThis.__rufus_lcm_context_transforms` — removes `id` field after registration (bug, see Section B).

**Shadow** (`src/shadow.ts`)
- `runShadowAssemble()`: called from `plugin.assemble()` in shadow mode and from the LCM transform. Runs `coreAssemble()`, calls `recordShadowComparison()`, then fires `runFactExtraction()` via `setImmediate` (this is where extraction actually happens in shadow mode).
- `recordShadowComparison()`: inserts into `shadow_comparisons` with overlap score, token counts, and `usme_only_preview` (full formatted context block).
- `computeOverlapScore()`: Jaccard on whitespace tokens.

**Config** (`src/config.ts`)
- `UsmePluginConfig` with defaults: mode=`shadow`, extraction enabled with `claude-haiku-4-5`, consolidation at 3am, assembly default mode `brilliant`, shadow sampling 1.0, embedding from `OPENAI_API_KEY`.

---

### What Is Wired (End-to-End Active Paths)

1. **Shadow LCM inject path**: `bootstrap()` → `registerUsmeTransformOnce()` → on each LCM call: embed last user message → `coreAssemble()` → format `<usme-context>` → append as user message → `recordShadowComparison()` → `setImmediate runFactExtraction()`. **This is the only path delivering memory today.**

2. **Ingest verbatim**: `ingest()` → `insertSensoryTrace(item_type='verbatim')` → deferred embedding. These rows are NOT picked up by `getUnepisodifiedTraces()` (which filters `item_type='extracted'`), so verbatim traces never flow into consolidation.

3. **ANN assemble pipeline**: `retrieve()` → `score()` → `criticFilter()` → `pack()` → `injectedToSystemAddition()`. Fully wired. Returns empty results when tables have no embedded rows.

4. **Nightly consolidation**: Fully coded but **never scheduled**. `startScheduler()` is exported but never called from within the plugin. Must be manually invoked externally.

---

### What Is Dead Code / Disconnected

| Item | Location | Status |
|------|----------|--------|
| `afterTurn()` extraction | `plugin.ts:384-393` | Logs intent only, never calls extractor |
| `compact()` episodify flush | `plugin.ts:453-473` | Stub, always returns `compacted: false` |
| `ExtractionQueue` | `extract/queue.ts` | Defined, exported, never used by the plugin |
| `runEntityExtraction()` | `entity-extractor.ts` | Defined, exported, never called anywhere in the plugin |
| Entity tier in assemble | `retrieve.ts:95-107` | Query defined; `entities` table never populated via plugin |
| `consolidation` config block | `config.ts:24-29` | Schema exists, `candidatesPerNight` never consumed |
| `shadow.samplingRate` | `config.ts:42` | Field defined, never checked in `runShadowAssemble()` |
| `AssemblyModeProfile.slidingWindowTurns/Tokens` | `types.ts:86-87` | Profile fields defined, never read by retrieve/pack |
| `AssemblyModeProfile.includeSpeculative/speculativeMaxCount` | `types.ts:88-89` | Defined, never used |
| `annSearchK` in modes | `modes.ts` | Set (20/40/60), never passed to retrieve (uses `candidatesPerTier`) |
| `lcm_latency_ms` in shadow_comparisons | `shadow.ts:148` | Always null — LCM timing not measured |
| `usme_system_addition_tokens` | `shadow.ts:157` | Always null |
| `lcm_only_preview` | `shadow.ts:163` | Always null |
| `usme_relevance_score` / `usme_memory_cited` | `shadow.ts:164-165` | Always null |
| `relevance_analysis_done` | `shadow.ts:166` | Always false |
| `prompts/` at core root | `src/prompts/fact-extraction.ts`, `entity-extraction.ts` | Duplicates of `extract/prompts/`; not imported anywhere |
| Skill tier retrieval | `retrieve.ts:83-94` | Only returns `status='active'` skills; skills are only created as `status='candidate'` by nightly.ts, never promoted |
| Episode embedding | `nightly.ts:118` | `embedding: null` — episodes are never embedded, so the episode tier in ANN search always returns zero results |
| Concept embedding | `nightly.ts:198` | `embedding: null` — same problem; concept tier always returns zero results |
| Skill embedding | `nightly.ts:377` | `embedding: null` — same problem |

---

## Part B: Honest Assessment — Value vs. Zero-Value Paths

### Where USME Currently Delivers Value

**1. Shadow comparison telemetry**
The `shadow_comparisons` table is being populated on every LCM call (in shadow mode). The `usme_only_preview` column shows what USME would inject. The `overlap_score` tracks Jaccard similarity. This is real, measurable data that can inform whether memory injection would help.

**2. Fact extraction into sensory_trace**
When `ANTHROPIC_API_KEY` is set and `extraction.enabled=true`, `runFactExtraction()` fires after each turn. This produces `item_type='extracted'` rows with typed memory items (fact/preference/decision/etc.) and utility classifications. The extraction prompt (`fact-extraction-v1`) is well-designed.

**3. Verbatim trace storage**
Every `ingest()` call stores the raw message. Useful as audit trail but not retrieved (only `item_type='extracted'` rows enter the retrieval pipeline after episodification).

**4. Assembly pipeline correctness**
The assemble pipeline (retrieve → score → critic → pack) is well-architected and correct in isolation. The scoring weights, recency decay, and critic rules are reasonable. The 80ms per-tier timeout with `Promise.race` is production-grade.

**5. LCM transform injection**
The `<usme-context>` block format produced by `injectedToSystemAddition()` is clean and readable. The injection mechanism (appending as new user message) is functional.

### Where USME Currently Delivers Zero Value

**1. Memory retrieval returns nothing useful today**
The ANN queries in `retrieve.ts` filter `WHERE embedding IS NOT NULL`. But:
- Extracted sensory traces are never episodified (consolidation not running), so only raw `extracted` traces with embeddings are candidates. These have embeddings only if `embeddingApiKey` was set at extraction time.
- Episodes are created by nightly consolidation (never running) and are stored with `embedding: null` anyway.
- Concepts are stored with `embedding: null`.
- Skills are stored with `embedding: null` AND only `status='active'` is queried, but skills are only created as `status='candidate'`.
- Entities are never populated.

**Conclusion**: In a fresh deployment, the assemble pipeline queries five tiers and gets zero results from all of them. The LCM transform fires, runs `coreAssemble()`, gets zero items, returns `null`, and the context window is unmodified. USME is currently a no-op in terms of memory injection.

**2. `afterTurn()` does nothing**
`plugin.ts:384-393` logs "enqueued extraction" but does not actually call `runFactExtraction()`. The comment says "The extraction worker will pick up un-extracted verbatim traces from the DB" — but no such worker exists. In shadow mode, extraction is driven by `shadow.ts:100-114`; but in `active` mode there is no extraction path at all.

**3. `compact()` is a stub**
The framework calls `compact()` when context windows fill. USME declares `ownsCompaction: true` but never actually compacts. This means Claude Code's context management gets a `compacted: false` response and the window fills without any compression.

**4. Consolidation pipeline never runs**
`runNightlyConsolidation()` and `startScheduler()` are complete and correct but never invoked by the plugin. No episodes, concepts, or skills accumulate over time.

**5. Entity extraction never fires**
`runEntityExtraction()` is fully implemented with canonical deduplication, but is never called from `shadow.ts` or `plugin.ts`. The `entities` and `entity_relationships` tables stay empty.

**6. `ExtractionQueue` is unused**
A proper FIFO async queue exists in `queue.ts` but the plugin uses bare `setImmediate` calls instead. Multiple concurrent extraction jobs can fire without backpressure.

---

## Part C: mem0 Comparison

### Where USME Beats mem0 (When Working)

| Dimension | USME Advantage |
|-----------|----------------|
| **Memory taxonomy** | Six typed memory categories (fact/preference/decision/plan/anomaly/ephemeral) with utility scoring and TTL. mem0 stores undifferentiated memories. |
| **Tiered retrieval** | Five tiers (sensory→episode→concept→skill→entity) with tier-specific decay rates and weights. mem0 has a single flat memory store. |
| **Composite scoring** | Weighted formula combining semantic similarity, recency decay, provenance reliability, and access frequency. mem0 is similarity-only. |
| **Skill abstraction** | Explicit skill tier for reusable procedures with teachability scoring. mem0 has no equivalent. |
| **Entity graph** | Entity/relationship extraction with canonical deduplication. mem0 has no graph layer. |
| **Contradiction resolution** | Nightly step finds semantically similar concepts and resolves via LLM judgment. mem0 has no dedup/merge. |
| **Shadow comparison harness** | Purpose-built telemetry for measuring memory quality before going live. mem0 has nothing equivalent. |
| **Token budget control** | Mode profiles with fraction-based budgets and per-tier candidate limits. mem0 injects all memories without a budget. |
| **Ephemeral TTL** | Memory items can expire automatically (e.g., "currently debugging X"). mem0 has no TTL concept. |

### Where mem0 Beats USME (Currently)

| Dimension | mem0 Advantage |
|-----------|----------------|
| **Actually works today** | mem0 injects real memories into context. USME retrieves zero items from empty/unembedded tables. |
| **No infrastructure dependency** | mem0 can run with minimal setup. USME requires PostgreSQL + pgvector + OpenAI API key + Anthropic API key. |
| **Extraction is synchronous** | mem0 extracts before the next turn. USME's extraction is fire-and-forget; if the process restarts, extractions are lost. |
| **Cross-session memory** | mem0's memories are user-scoped and available across all sessions immediately. USME's session_id-based storage means cross-session retrieval only works after episodification (which never runs). |
| **Maturity** | mem0 is production-tested. USME has zero production miles. |

### What Would Close the Gap

1. **Embedded rows on ingest**: embed extracted items at extraction time (already done when `embeddingApiKey` present) — but also embed episodes, concepts, skills at creation time.
2. **Run consolidation**: start the scheduler from within the plugin bootstrap.
3. **Promote skill candidates**: add a step or threshold to auto-promote skills from `candidate` → `active` when they meet a teachability threshold.
4. **Cross-session query**: the ANN query in `retrieve.ts` does not filter by `session_id`, so once the tables have content, cross-session retrieval works automatically. No code change needed.
5. **Wire `afterTurn()` to extraction**: replace the log statement with an actual `runFactExtraction()` call for `active` mode.

---

## Part D: Ordered Fix List

Priority is ordered by **immediate impact on delivered value** — fixes that unblock memory injection first.

### Fix 1 — Embed episodes, concepts, and skills at creation time (CRITICAL)
**Files**: `nightly.ts:118`, `nightly.ts:198`, `nightly.ts:377`
**Problem**: All three use `embedding: null`. The ANN queries in `retrieve.ts` filter `WHERE embedding IS NOT NULL`, so the episode, concept, and skill tiers always return zero results regardless of how much content is consolidated.
**Fix**: After each `insertEpisode/Concept/Skill`, fire an async embed call and update the row. Pass the embedding API key through `NightlyConfig`.
**Impact**: Unlocks the episode, concept, and skill tiers for retrieval — the difference between zero memory and rich memory.

### Fix 2 — Wire `afterTurn()` to actually call `runFactExtraction()` (CRITICAL)
**File**: `plugin.ts:384-393`
**Problem**: In `active` mode, `afterTurn()` logs intent but never calls the extractor. Sensory traces are never populated with `item_type='extracted'` rows in active mode.
**Fix**: Call `runFactExtraction()` (or enqueue via `ExtractionQueue`) from `afterTurn()` with the last few serialized turns.
**Impact**: Without this, the sensory_trace tier in active mode is also empty. USME in active mode is a complete no-op.

### Fix 3 — Start the consolidation scheduler from `bootstrap()` (CRITICAL)
**File**: `plugin.ts:237-320`, `scheduler.ts`
**Problem**: `startScheduler()` is never called. Episodes, concepts, and skills never accumulate.
**Fix**: Call `startScheduler(client, pool, config.consolidation)` in `bootstrap()`, store the handle, and call `handle.stop()` in `dispose()`.
**Impact**: Enables the nightly pipeline. Without this, the only populated tier is `sensory_trace` (extracted items). Memory never advances to the more durable tiers.

### Fix 4 — Fix LCM transform registration bug: `id` field stripped
**File**: `plugin.ts:192`
**Problem**: `registerLcmTransform()` builds a `transforms` array of `{id, fn}` objects, then on line 192 replaces `g[LCM_TRANSFORM_KEY]` with `transforms.map((t) => t.fn)` — an array of bare functions, discarding the `id` field. On the next call, `transforms.findIndex((t) => t.id === id)` searches for `id` on plain functions, which always returns -1, so re-registrations always append rather than replace.
**Impact**: In long-running processes or rebootstrapped sessions, duplicate transform entries accumulate, causing the USME context block to be appended multiple times per LCM call.
**Fix**: Keep the array as `{id, fn}[]` and only spread the function into the consumer format, or maintain two arrays.

### Fix 5 — Replace bare `setImmediate` extraction with `ExtractionQueue`
**File**: `shadow.ts:100`, `plugin.ts:385`
**Problem**: Each LCM call can fire an independent `setImmediate` extraction. Under load (many turns, slow API), extraction jobs pile up without backpressure. A process restart loses all queued work.
**Fix**: Enqueue via `getExtractionQueue()`. This serializes extraction, provides a `drain()` hook for graceful shutdown, and exposes `stats()` for monitoring.
**Impact**: Correctness under load; prevents Anthropic API rate-limit cascades.

### Fix 6 — Wire entity extraction into the shadow/extraction path
**File**: `shadow.ts:107`
**Problem**: `runEntityExtraction()` is implemented but never called. The `entities` tier in assemble always returns zero results.
**Fix**: Call `runEntityExtraction()` from the same `setImmediate` block as `runFactExtraction()`, passing the serialized turn.
**Impact**: Enables the entity tier. Low immediate value but unlocks relationship-aware retrieval over time.

### Fix 7 — Implement `compact()` or disable `ownsCompaction`
**File**: `plugin.ts:453-473`
**Problem**: Plugin declares `ownsCompaction: true` but always returns `compacted: false`. The framework may defer its own compaction strategy, leaving context windows unmanaged.
**Fix (minimal)**: Set `ownsCompaction: false` so the framework handles compaction natively. Fix (full): call `stepEpisodify()` synchronously in `compact()` to flush the current session's traces to an episode, then return a summary.
**Impact**: Prevents context window runaway in long sessions.

### Fix 8 — Respect `shadow.samplingRate` in `runShadowAssemble()`
**File**: `shadow.ts:65`, `config.ts:43`
**Problem**: `samplingRate: 1.0` is in config but never checked. Cannot reduce shadow overhead in high-volume scenarios.
**Fix**: Add `if (Math.random() > config.shadow.samplingRate) return null;` at the top of `runShadowAssemble()`.
**Impact**: Low immediate impact (only matters at scale), but required before any load testing.

### Fix 9 — Remove duplicate prompts at `src/prompts/`
**Files**: `packages/usme-core/src/prompts/fact-extraction.ts`, `entity-extraction.ts`
**Problem**: These appear to be earlier versions of the prompts now living at `src/extract/prompts/`. They are not imported anywhere. They create confusion about which prompt version is canonical.
**Fix**: Delete or clearly mark as legacy.
**Impact**: Code hygiene only.

### Fix 10 — Populate `usme_system_addition_tokens`, `lcm_latency_ms` in shadow comparisons
**File**: `shadow.ts:155-157`
**Problem**: Three shadow_comparisons fields are always null: `usme_system_addition_tokens`, `lcm_latency_ms`, `lcm_only_preview`. This degrades the analytical value of the shadow harness.
**Fix**: Calculate `usme_system_addition_tokens` from `contextBlock.length / 4` after formatting. `lcm_latency_ms` requires the framework to pass timing — may need interface change.
**Impact**: Improves shadow telemetry quality for go/no-go decisions.

---

## Part E: Forward Roadmap

### Phase 1 — Fix Correctness (1–2 weeks)
Goal: USME injects non-zero memory on every turn.

Tasks:
1. Apply Fix 2 (`afterTurn()` calls extractor) — active mode extraction.
2. Apply Fix 4 (LCM transform registration de-duplication) — prevent context block duplication.
3. Apply Fix 5 (use `ExtractionQueue`) — backpressure for extraction jobs.
4. Apply Fix 7 (disable `ownsCompaction`) — stop false-claiming context management.
5. Verify embedding pipeline end-to-end: confirm `OPENAI_API_KEY` flows to `persistExtractedItems`, and that `sensory_trace.embedding` is non-null for extracted items.
6. Validate shadow_comparisons rows show `usme_items_selected > 0` after several turns.

Acceptance: Shadow comparison dashboard shows `usme_items_selected >= 1` on at least 50% of turns after 20+ turns in a session.

---

### Phase 2 — Activate Consolidation (2–4 weeks)
Goal: Episodes, concepts, and skills accumulate and are retrievable.

Tasks:
1. Apply Fix 1 (embed episodes/concepts/skills at creation) — the single most impactful change.
2. Apply Fix 3 (start scheduler from `bootstrap()`) — wire consolidation into the plugin lifecycle.
3. Apply Fix 6 (wire entity extraction) — populate the entity tier.
4. Add skill promotion: a cron-triggered step (or threshold in `stepSkillDraft`) to auto-promote skills from `candidate` → `active` based on teachability score >= configurable threshold.
5. Apply Fix 10 (shadow telemetry completeness) — `usme_system_addition_tokens` calculation.
6. Validate: after running for 24+ hours, confirm `episodes`, `concepts` tables are non-empty and `usme_tiers_contributed` in shadow_comparisons includes `episodes` and `concepts`.

Acceptance: All five tiers contribute to retrieval. `usme_items_selected` averages >= 3 per turn. Token delta is negative (USME uses fewer tokens than LCM for equivalent context).

---

### Phase 3 — Go Live (4–8 weeks)
Goal: Switch from `shadow` to `active` mode with confidence.

Tasks:
1. Apply Fix 7 fully: implement `compact()` as episode flush (call `stepEpisodify()` for current session, return summary string).
2. Apply Fix 8 (sampling rate enforcement) — allows gradual rollout (e.g., `samplingRate: 0.1` for canary).
3. Tune scoring weights based on accumulated shadow data: analyze `overlap_score` distribution and `usme_relevance_score` (once populated) to calibrate `minInclusionScore` per mode.
4. Add `usme_relevance_score` computation: a post-hoc Haiku call on shadow_comparisons rows to score whether injected memory was actually cited in the assistant response. Flip `relevance_analysis_done=true` after scoring.
5. Set `mode: 'active'` in config for a canary population.
6. Monitor: watch for latency regressions (LCM transform has 150ms timeout — verify P99 is within budget), memory relevance scores, and error rates.
7. Gradual rollout: 5% → 20% → 50% → 100%.

Acceptance criteria for full rollout:
- P95 assembly latency < 100ms (within 150ms LCM transform budget with margin).
- Memory relevance score (from Haiku post-hoc analysis) >= 0.6 on average.
- Zero `compact()` failures causing context overflow.
- No duplicate `<usme-context>` blocks observed.

---

## Summary Table

| Component | State | Blocking Issue |
|-----------|-------|----------------|
| Verbatim ingest | Working | Rows not retrievable (item_type filter) |
| Fact extraction | Working in shadow mode | Not wired in active mode (Fix 2) |
| Entity extraction | Complete | Never called (Fix 6) |
| ExtractionQueue | Complete | Not used (Fix 5) |
| ANN retrieve | Working | All tiers return 0 rows (Fix 1) |
| Scoring/critic/pack | Working | N/A (correct) |
| LCM transform inject | Working | Dedup bug accumulates entries (Fix 4) |
| Shadow comparisons | Partially working | Several fields always null (Fix 10) |
| Nightly consolidation | Complete | Never scheduled (Fix 3) |
| Episode/concept/skill embedding | Broken | embedding=null at creation (Fix 1) |
| compact() | Stub | ownsCompaction=true but no-op (Fix 7) |
| Skill promotion (candidate→active) | Missing | Skills never retrievable |
| Consolidation scheduler | Complete | Not started from bootstrap (Fix 3) |
