# Decisions: USME

Key decisions logged in ADR style.

---

## ADR-009: Storage — Postgres + TimescaleDB + pgvector + pgvectorscale (supersedes ADR-003 and ADR-008)

**Date:** 2026-04-04
**Status:** accepted
**Decided by:** Alex

**Context:**
ADR-003 (SQLite + sqlite-vec) was chosen for ops simplicity. The scope has since expanded to include: embedding-based clustering for nightly consolidation, hybrid vector + full-text search, fast-model (Haiku/Flash) per-turn extraction writing to the same store, and Sonnet/Opus nightly skill accrual. These requirements strain SQLite significantly — clustering is absent, hybrid search requires app-layer re-ranking, and HNSW indexing is unavailable.

**Options considered:**
1. SQLite + sqlite-vec (prior decision) — in-process, zero ops, insufficient for clustering + hybrid search
2. Postgres + pgvector — strong vector support, hybrid search via tsvector, HNSW indexing, ACID guarantees
3. Postgres + TimescaleDB + pgvector + pgvectorscale — adds time-series hypertables (auto-partitioned episodic store), DiskANN indexes via pgvectorscale (28x lower p95 latency than Pinecone at scale, 75% lower cost), continuous aggregates for temporal summarization

**Decision:**
Option 3 (B+C combined). Start with the full stack in v1 because:
- We have written zero storage code — switching cost is zero
- Hypertables are genuinely the right structure for episodic memory (time-range queries like "last 7 days of episodes" are first-class, not workarounds)
- pgvectorscale DiskANN is an extension on top of pgvector — minimal additional ops, significant performance benefit
- pgvectorscale + TimescaleDB are both from the same maintainer (Timescale/TigerData) — they're designed to coexist
- `time_bucket` + continuous aggregates make the nightly episode compression job elegant rather than painful
- Local Docker compose handles the entire stack: one service, one port

**Stack:**
- Postgres 16
- TimescaleDB extension (hypertables for episodic memory, continuous aggregates)
- pgvector extension (HNSW indexes for semantic search)
- pgvectorscale extension (DiskANN for scale; optional, can add later)
- `node-postgres` (`pg`) driver — mature, connection-pooled, non-blocking

**Consequences:**
- Docker compose required for dev (trivial; add to repo)
- Hot path adds ~1-5ms for Postgres round trip vs 0ms SQLite in-process — well within 150ms budget
- Schema must be designed for TimescaleDB hypertables from day one (episodic table needs `created_at` as partitioning column)
- Migration tooling: `node-pg-migrate` for schema versioning
- Design must be migration-friendly; don't bake extension assumptions into the ORM

---

## ADR-010: Deployment — standalone plugin + dedicated git repo

**Date:** 2026-04-04
**Status:** accepted
**Decided by:** Alex

**Context:**
ADR-006 put `usme-core` as a pure TS library with a thin OpenClaw adapter inside rufus-plugin. Alex now wants USME to be its own plugin with its own git repo — still a "rufus project" (Rufus orchestrates, Rufus owns), but deployed and versioned independently.

**Decision:**
- New git repo: `usme-claw` (or `usme` — naming TBD)
- Ships as a standalone OpenClaw plugin that claims `plugins.slots.contextEngine`
- No dependency on rufus-plugin internals
- The ports-and-adapters split (ADR-006) still holds: `usme-core` is the pure library, the OpenClaw adapter is in the same repo but in a separate package folder
- Repo lives at `~/ai/projects/rufus-projects/usme-claw/` (current `usme/` becomes the monorepo root)
- Future: publishable to ClawHub as a standalone skill/plugin

**Consequences:**
- Separate versioning from rufus-plugin — can ship USME updates independently
- Rufus orchestrates builds, reviews, and releases from his workspace as usual
- CI/CD config goes in the new repo
- rufus-plugin can still *call* usme-core as an npm dependency if it needs memory access (e.g., for the dashboard)

---

## ADR-011: Per-turn memory extraction — async Haiku/Flash assessor

**Date:** 2026-04-04
**Status:** accepted
**Decided by:** Alex

**Context:**
Each turn produces raw content that needs to be assessed for memory worthiness. Doing this synchronously in the hot path adds latency; doing it manually would never scale; not doing it means we rely on the nightly job alone (too slow for fast-moving sessions).

**Decision:**
After each turn completes and the model response is delivered, fire an async Haiku/Flash extraction job:
- Non-blocking — user sees no delay
- Input: completed turn (user message + tool calls + model response)
- Output: structured JSON with extracted memory items: `{type, content, provenance, utility_estimate, tags[]}`
- Types: `fact | preference | decision | question | plan | anomaly | ephemeral`
- Utility estimate: `high | medium | low | discard`
- Items tagged `discard` are not written; others go to sensory trace table
- Run async via a task queue (simple in-process queue for v1; separate worker queue for v2)

**Model choice:** Haiku (Anthropic) or Flash (Google) — cheapest frontier models capable of structured extraction. ~$0.0003/turn. Configuration-driven so it can be swapped.

**Consequences:**
- Sensory trace table fills from two sources: (1) verbatim turn record, (2) Haiku/Flash extracted items
- Extraction prompt is a first-class artifact — must be versioned, tested, iterable
- If extraction fails, sensory trace still has verbatim record — graceful degradation

---

## ADR-012: Nightly consolidation — Sonnet for compression, Sonnet/Opus for skill drafting

**Date:** 2026-04-04
**Status:** accepted
**Decided by:** Alex

**Context:**
The overnight job moves memory up the stack: sensory → episodic → semantic → procedural (skills). This is quality-critical, not latency-critical. A stronger model should do it.

**Decision:**
Nightly cron (using OpenClaw cron infrastructure — already operational):

**Step 1 — Episode compression (Sonnet):**
- Cluster today's sensory traces using embedding k-means (native SQL via pgvector's cosine distance clustering)
- Sonnet reads each cluster + writes a compressed episode summary (200-500 tokens)
- Summaries written to episodic hypertable with TimescaleDB `time_bucket` alignment

**Step 2 — Fact promotion (Sonnet):**
- Identify recurring patterns across episodes (same fact appears in 3+ episodes → candidate for semantic layer)
- Sonnet adjudicates contradictions between new candidate facts and existing concept layer items
- Winner replaces or supersedes loser with `supersedes_ref` link

**Step 3 — Skill candidate identification (formula + Sonnet):**
- Score all episodes: novelty × frequency × user-engagement-signals × teachability-estimate
- Top N candidates → Sonnet: "Is this a generalizable, teachable workflow? If yes, rate teachability 1-10."
- Candidates scoring ≥7 proceed to drafting

**Step 4 — Skill drafting (Sonnet or Opus):**
- Sonnet/Opus writes a draft SKILL.md from the interaction history
- Validates against AgentSkills SKILL.md spec
- Staged to `~/.openclaw/skills/candidates/` for user review
- User notified; promotes on confirmation

**Step 5 — Decay + prune:**
- Decay utility scores on sensory traces older than 7 days
- Hard-delete sensory traces older than 30 days (or configurable TTL)
- Alert if memory DB total size exceeds threshold

**Consequences:**
- Nightly job is the primary driver of long-term memory quality — must be observable (log all decisions)
- Job duration scales with activity; estimate 2-10 minutes for active daily use
- Must be idempotent — safe to re-run if interrupted
- Sonnet vs Opus for skill drafting: configurable; default Sonnet, Opus available for higher quality

---

## ADR-006 (revised): Ports and adapters — usme-core library + openclaw adapter (same repo)

**Date revised:** 2026-04-04
**Original:** 2026-04-01
**Status:** revised (superseded partially by ADR-010)

**Revision:** Both `usme-core` and the OpenClaw adapter now live in the same standalone repo (`usme-claw`), not inside rufus-plugin. The ports-and-adapters separation still holds — core has no OpenClaw imports. But the adapter is now a peer package in the same monorepo, not a guest in rufus-plugin.

---

## ADR-007: Transition — shadow mode is a hard v1 requirement (revised)

**Date:** 2026-04-04 (revised from 2026-04-01)
**Status:** accepted — strengthened

**Original:** shadow mode before hard cutover.

**Revision:** Shadow mode is not a nice-to-have transition step — it is a **hard v1 requirement**. USME ships in shadow mode and stays there until promotion criteria are met. There is no path to active mode without evidence from shadow evaluation.

**What shadow mode does:** USME runs its full pipeline (ingest, assemble, afterTurn, nightly consolidation) on every turn. The model receives LCM's context. USME's assembly is computed, logged to `shadow_comparisons`, and compared against LCM's output. The memory store is populated during shadow mode so it is ready when we switch to active.

**Tooling is part of v1 (not optional):**
- `usme shadow report` — per-session and global metrics
- `usme shadow tail` — live comparison feed
- `usme shadow analyze` — run relevance analysis pass
- `usme shadow ready` — promotion readiness check with explicit criteria

**Promotion criteria (minimum, all must pass):**
- ≥ 500 real shadow turns collected
- P95 assembly latency ≤ 150ms under real load
- Extraction success rate ≥ 95%
- ≥ 60% of extracted items rated medium/high utility
- ≥ 50% of USME-injected memories cited in model responses (relevance proxy)
- Zero unhandled exceptions in hot path

**Compaction clarification:** USME does not compact in the traditional sense. It assembles within a fixed token budget on every turn — no accumulation problem exists. `compact()` is implemented per the interface contract but redefines the action as on-demand episode compression. `ownsCompaction: true` is set to prevent OpenClaw from triggering legacy auto-compaction events.

---

## ADR-002: Memory critic framing — editorial layer, not security guard

**Date:** 2026-03-30
**Status:** accepted
*(Unchanged.)*

---

## ADR-004: V1 selection policy — weighted formula, not RL bandit

**Date:** 2026-03-30
**Status:** accepted
*(Unchanged.)*

---

## ADR-005: Build slim v1 — FR-03 + FR-04 + FR-08 first

**Date:** 2026-03-30
**Status:** accepted
*(Unchanged. Now also includes ADR-011 async extractor as part of the v1 core.)*

---

## ADR-001: Integration point is the contextEngine slot

**Date:** 2026-03-30
**Status:** accepted
*(Unchanged.)*
