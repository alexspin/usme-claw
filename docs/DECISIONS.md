# USME Architectural Decisions

_Distilled from design docs, session history, and the deployed codebase. Decisions are listed with what was chosen, why, and what was rejected._

---

## D1 — Active mode over shadow mode

**Decision:** USME runs in active mode — it injects context directly into every prompt.

**Rationale:** Shadow mode was a validation scaffold. It logged what USME *would* inject alongside LCM's actual output. Once the injection pipeline was validated and LCM was removed from the stack, shadow mode became meaningless. Active mode went live 2026-04-06 20:58 UTC.

**Rejected:** Keeping shadow mode as a permanent option. The data model (shadow_comparisons table) was entirely built around comparing against LCM output, which no longer exists. The table is retained in schema for historical queries but is no longer written to.

---

## D2 — OpenAI for embeddings throughout

**Decision:** All embedding operations use OpenAI `text-embedding-3-small` (1536 dims).

**Rationale:** Anthropic's SDK has no native embeddings API. Early code attempted to route embedding calls through `anthropic.ts` — this was a bug. OpenAI is the only viable option without building a local embedding server. The model is cost-effective (~$0.02/1M tokens) and the 1536-dim vectors are compatible with pgvector's HNSW indexes.

**Rejected:** Local Ollama embeddings (`nomic-embed-text`) — would save ~400ms/turn and eliminate costs, but adds operational complexity. Deferred to a later phase.

**Rejected:** Anthropic embeddings — not available in the SDK.

---

## D3 — tool_use + Zod over custom JSON parsing

**Decision:** All LLM-structured output uses Anthropic's `tool_use` feature, with Zod for schema validation and normalization.

**Rationale:** Custom JSON parsing (fence-stripping, `indexOf`/`lastIndexOf` bracket extraction, regex) was the original approach and was brittle. It failed silently on truncated output, malformed fences, and escaped characters. Replacing it with `tool_use` forces the model to produce valid structured output. Zod provides a typed schema contract with `.safeParse()` for graceful error handling.

**Rejected:** `robustJsonParse()` custom helper — had off-by-one errors, failed on markdown-fenced model output, and violated the preference for battle-tested libraries.

---

## D4 — Sonnet for reflection (not Haiku)

**Decision:** Claude Sonnet is the default model for the reflection service.

**Rationale:** The reflection service reads the full memory corpus (~69K tokens) and makes holistic judgments about concept merges, contradiction resolution, and skill identification. Haiku lacks the reasoning depth to do this reliably — early tests produced shallow, low-confidence skill candidates. Quality wins over cost here; a 500K-token Sonnet call is ~$1.50 and runs twice daily.

**Rejected:** Haiku as default — available as `--model haiku` CLI flag for fast/cheap runs.

**Available:** Opus as `--model opus` for the deepest analysis runs.

---

## D5 — Two-path skill creation

**Decision:** Skill creation has two independent paths: nightly `stepSkillDraft` and the reflection service.

**Rationale:** The nightly path is fast (SQL-gated, Sonnet-drafted from qualifying episodes) but depends on `importance_score >= 7`, which requires the Haiku scoring step to work correctly. The reflection service path is more expensive but uses Sonnet's holistic judgment, bypassing the `importance_score` gate entirely. Having both paths provides redundancy and catches skills the nightly path misses.

**Tradeoff:** The nightly path is currently blocked for all legacy episodes (pre-migration 010, all at `importance_score = 5`). The reflection path is the only working path today.

---

## D6 — importance_score decoupled from utility_score decay

**Decision:** Episode skill eligibility is gated on `importance_score` (assigned once at creation by Haiku), not `utility_score` (which decays continuously).

**Rationale:** The original gate used `utility_score >= 0.6`. All episodes initialize at `utility_score = 0.5`. A 0.95× decay multiplier runs every cycle. The score only decreases — it can never reach 0.6 from 0.5. The gate was permanently unreachable. Decoupling importance from decay means the skill gate reflects how valuable an episode was when it was created, not how recently it was accessed.

**Rejected:** Increasing initialization to 0.7+ — would break the semantic meaning of utility_score and cause all new episodes to qualify, defeating the quality filter.

**Rejected:** Lowering the gate to <= 0.5 — all episodes would qualify, producing low-quality skill candidates.

---

## D7 — Spreading activation over pure ANN retrieval

**Decision:** After ANN retrieval, USME walks the entity relationship graph up to N hops to surface adjacent context.

**Rationale:** Pure vector similarity misses related context that shares conceptual neighbors but differs in surface form. The Synapse (2026) paper reports +7.2 F1 improvement and 95% token reduction vs. naive retrieval using this pattern. Graph traversal is cheap (indexed FK lookups) compared to additional ANN queries.

**Config:** `spreading.maxDepth = 2` by default. Set to 0 to disable. The implementation checks depth=0 as a no-op, so disabling has zero cost.

**Current state:** Wired and running; sparse entity relationship graph (0–1 edges/entity) means minimal practical benefit today. Will improve as the reflection service accumulates relationship updates.

---

## D8 — 350K token corpus threshold for tiered reflection

**Decision:** Reflection uses the full corpus below 350K tokens; switches to tiered mode (recent + unseen) above.

**Rationale:** Sonnet's 200K context window can technically handle larger corpora, but quality degrades and cost scales linearly. 350K was chosen as a conservative threshold well below the window limit. Current corpus: ~69K tokens (~12% of threshold). The tiered mode is implemented but not yet triggered.

---

## D9 — PostgreSQL + TimescaleDB + pgvector over SQLite

**Decision:** Production storage uses PostgreSQL with TimescaleDB (time-series) and pgvector (ANN).

**Rationale:** Early design considered SQLite + sqlite-vec for zero-dependency simplicity. Rejected because HNSW indexing in pgvector is significantly faster at scale (20–100ms ANN vs 200ms+ sequential scan), TimescaleDB provides time-bucketing for sensory_trace, and the consolidated pipeline benefits from transactional writes across multiple tables.

**Rejected:** SQLite + sqlite-vec — fine for prototyping, insufficient for production ANN performance.

---

## D10 — In-process task queue over Redis/BullMQ

**Decision:** Background jobs (async extraction, access count write-back) use an in-process FIFO queue via `setImmediate`.

**Rationale:** At v1 scale (one session, one server), external job queues add operational complexity with no meaningful benefit. Verbatim sensory_trace rows are already persisted synchronously before the async queue drains, so crashes lose at most one extraction job per turn.

**Rejected:** Redis + BullMQ — appropriate for multi-server or high-reliability scenarios, deferred.

---

## D11 — Skill confidence gate: 0.7

**Decision:** Reflection-service skills with confidence >= 0.7 go directly to the `skills` table as `candidate`. Below 0.7 go to `skill_candidates` for manual approve/reject review.

**Rationale:** 0.7 was chosen as the threshold where Sonnet's confidence correlates with actual skill quality in testing. Below that threshold, candidates are often too project-specific, too granular, or poorly defined. The split avoids discarding potentially valuable but uncertain candidates — they surface in the dashboard for human review.

**Daily delivery:** Pending skill candidates are dispatched as an agent message at 17:00 UTC for approval.

---

## D12 — Two-layer model configuration (2026-04-23)

**Decision:** Environment variables (`USME_FAST_MODEL`, `USME_REASONING_MODEL`, `USME_EMBEDDING_MODEL`, `USME_EMBEDDING_DIMENSIONS`) take precedence over `openclaw.json` plugin config, which takes precedence over hardcoded defaults.

**Rationale:** Allows deployment-time model override without code changes. Useful for testing different models or switching to newer versions without touching source.

**Fallback pattern:** Missing env vars log a warning but the system continues with defaults — backward-compatible and supports gradual migration.

**Source of truth:** `packages/usme-core/src/config/models.ts`

---

## D13 — Process manager for usme-dashboard (2026-04-23)

**Decision:** PM2 `ecosystem.config.js` and a systemd unit (`usme-dashboard.service`) are provided in the usme-dashboard repo. The dashboard must not be run with bare `tsx src/server.ts` in production.

**Rationale:** Bare `tsx` provides no auto-restart on crash. The dashboard needs to survive gateway restarts, nightly consolidation disruptions, and unhandled rejections without manual intervention.

**Recommended:** PM2 for development/staging machines; systemd for production Linux servers. Both options provided to match operator environment.
