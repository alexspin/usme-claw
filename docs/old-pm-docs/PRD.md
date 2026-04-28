# PRD: Utility-Shaped Memory Ecology (USME)

**Status:** draft
**Last updated:** 2026-04-01
**Owner:** Alex

---

## Problem

OpenClaw's current context engine (lossless-claw / LCM) is **compression-first, history-preserving**.
Its job is to fit the full conversation history into the context window. It compresses — it does not curate.

**The core problem:** every turn, the model gets a compressed version of *everything*, regardless of relevance.
- A joke from two weeks ago gets the same weight as an architectural decision made yesterday.
- There is no episodic memory, no concept layer, no stable-facts store — just compressed chat history.
- Nothing learns. Every session starts fresh on "what matters."

**USME reframes the question:** instead of *"how do we preserve history?"*, the question is *"what should the model know right now to do its best work?"*

That is a harder question — and a significantly more valuable one.

---

## Goals

- G1: Per-turn context window that reflects **what matters for this task**, not just what's most recent
- G2: A **selection policy** that improves over time — the agent gets better as it accumulates experience
- G3: **Skill distillation** — high-value recurring interactions automatically become SKILL.md bundles
- G4: A **memory critic / editorial layer** that keeps stale, superseded, and low-provenance items out of context
- G5: Ship as an OpenClaw Context Engine plugin — a drop-in replacement for lossless-claw

---

## Non-Goals (v1)

- Multi-tenant / multi-user memory isolation (single-user scope for v1)
- Online RL / bandit-based policy learning (formula-based scoring in v1; ML is v2)
- HIPAA/SOC2/compliance instrumentation
- Governance / permissions layer (SpiceDB, OPA)
- ClawHub skill publishing pipeline
- Graph DB (Neo4j/Memgraph) for concept entity linking — JSONB links in Postgres sufficient for v1
- pgvectorscale DiskANN index — standard pgvector HNSW in v1, pgvectorscale in v2 if needed

---

## Success Metrics

| Metric | Baseline | Target | How measured |
|---|---|---|---|
| Skill candidate pass rate | 0 (no distillation) | ≥50% of candidates worth promoting | Human review on each generated candidate |
| Skills promoted / week | 0 | ≥1 / week once steady-state | Count in skill staging folder |
| Memory priority audit | N/A | Periodic human review confirms top-N look right | Manual spot-check cadence (TBD) |
| Context tokens per turn | ~90K (post-distiller) | Measurable reduction vs LCM baseline | Token count logged per turn |
| Hot path latency | ~0ms (pass-through) | P95 ≤150ms local | Logged at assemble() |

---

## Scope

### In Scope (v1)
- Multi-timescale memory stores: sensory trace, episodic store, concept layer (FR-02)
- Per-turn context packaging (FR-01): returns ordered `messages` list + `estimatedTokens` + optional `systemPromptAddition`
- Multi-mode packaging: `tight` and `extended` modes (FR-04)
- Selection policy v1: weighted formula (semantic similarity + recency decay + provenance tier + access frequency) (FR-03)
- Memory critic v1: editorial scoring layer that filters and ranks candidate memory items (FR-05)
- Consolidation job: nightly summarize, dedupe, promote stable facts, decay stale items (FR-06)
- Overnight skill distillation: rank high-value interactions → promote to SKILL.md bundles (FR-08)
- OpenClaw plugin packaging in `plugins.slots.contextEngine` slot (FR-09)
- SQLite + sqlite-vec (or equivalent) as storage backend

### Out of Scope (v1)
- Online learning hooks / OPE evaluation (FR-07) — v2
- Postgres + pgvector migration — deferred to v2 or until SQLite hits limits
- Memory permissions / governance layer — deferred
- Multi-agent memory sharing (Adam's agent, other agents) — deferred

---

## Constraints

- **Tech:** must integrate via `plugins.slots.contextEngine` — lossless-claw is the incumbent to replace
- **Latency:** hot path must be non-blocking; async work happens in the background; P95 assembly ≤150ms
- **Ops:** local Postgres only — no remote services, no cloud databases; Docker compose for dev
- **Compatibility:** graceful degradation — always fall back to full LCM context if USME fails
- **Deployment:** standalone plugin in its own git repo (not part of rufus-plugin)

---

## Architecture Summary

USME is a **two-plane system**:

**Hot path (per turn, low latency):**
```
query → retrieve candidates → score (similarity + decay + provenance) → critic gate → package (tight/extended) → model
```

**Async path (overnight):**
```
consolidate → dedupe → promote facts → decay stale → distill skills → update utility stats
```

Integration point: `plugins.slots.contextEngine` — replaces lossless-claw.
See DECISIONS.md ADR-001 for rationale.

### Storage Stack
- **Postgres 16** (local Docker) — unified store for all memory tiers
- **TimescaleDB** — hypertables for episodic memory (time-partitioned, `time_bucket` aggregation)
- **pgvector** — HNSW vector indexes for semantic similarity search
- **`node-postgres`** — connection-pooled driver, non-blocking

### Memory Store Layers
| Layer | What it holds | Timescale | Postgres Implementation |
|---|---|---|---|
| Sensory trace | Raw turn content + Haiku/Flash extracted items | Hours → 30 days | Standard table with TTL |
| Episodic store | Compressed episode summaries (Sonnet) | Days → weeks | TimescaleDB hypertable |
| Concept layer | Stable facts, preferences, decisions | Indefinite | pgvector table (HNSW indexed) |
| Skill registry | Procedural workflows, SKILL.md index | Indefinite | Standard table + disk |
| Working-set constructor | Per-turn assembly from above layers | Per turn | In-memory assembly only |

### Model Roles
| Model | Role | When | Latency |
|---|---|---|---|
| Haiku / Flash | Per-turn memory extraction | Async, after each turn | ~1-3s, non-blocking |
| Sonnet | Episode compression, fact promotion, contradiction resolution | Nightly | 2-10 min job |
| Sonnet / Opus | Skill candidate drafting | Nightly (top candidates only) | Part of nightly job |

### Memory Item (key fields)
- `type`: sensory_trace | episode | fact | preference | plan | skill_candidate | tool_result
- `provenance`: source_kind (user | tool | web | file | model), source_ref, extractor_version
- `safety.prompt_injection_risk_score` — critic uses this (multi-user contexts)
- `utility`: prior, posterior_mean, decay_half_life — updated by async path
- `links`: graph edges (causes, supports, contradicts, refines, supersedes)

---

## Open Questions

See OPEN_QUESTIONS.md for the live list.

---

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-04-01 | Rufus | Initial draft from spec PDF + transcript analysis |
| 2026-04-04 | Rufus | Storage upgraded to Postgres + TimescaleDB + pgvector (supersedes SQLite ADRs). Plugin moved to standalone git repo. Async Haiku/Flash extractor added. Nightly Sonnet/Opus skill accrual formalized. |

---

## What Actually Shipped (v1 — 2026-04-09)

*This section supersedes the Scope and Architecture sections above, which reflect the original spec.*

**Scope changes from original:**

| Original spec | What shipped |
|---|---|
| SQLite + sqlite-vec | PostgreSQL 16 + TimescaleDB + pgvector (HNSW) |
| LCM slot contextEngine replacement | OpenClaw plugin (active mode injection, not slot replacement) |
| Shadow mode first, then cutover | Shadow mode built and validated, cutover to active 2026-04-06 |
| Skill drafting via Opus | Skill drafting via Sonnet (Opus deferred) |
| Online RL / bandit learning (v2) | Still v2 |

**Features beyond original scope (added during build):**

- `importance_score` (1–10) on episodes, Haiku-assigned at creation — gating signal for skill drafting
- Memory Reflection Service — holistic LLM review of full corpus 2× daily, produces concept merges, contradiction resolution, entity relationship updates, skill candidates
- Spreading activation — entity graph walk (up to N hops) after ANN retrieval
- `exclude_from_reflection` privacy flags on all 4 tiers
- `skill_candidates` table + daily delivery cron (17:00 UTC)
- Dashboard — 6-panel live view at https://collective7.spinelli5.com/usme/
- `openclaw usme reflect` CLI

**Deployed state as of 2026-04-09:**

- Active mode since 2026-04-06 20:58 UTC — 43–60 items/turn, ~54ms P50 latency
- Migrations 001–013 applied
- 5 candidate skills created via reflection service (nightly path blocked pending importance_score backfill)
- 2 reflection runs complete (runId 1 and 2)

**Success metric status:**

| Metric | Target | Actual |
|---|---|---|
| Skill candidate pass rate | ≥50% worth promoting | 5 candidates created; human review pending |
| Skills promoted/week | ≥1/week steady-state | 0 active yet (awaiting promotion) |
| Hot path latency P95 | ≤150ms | ~54ms P50 (embedding dominates) |
| Context tokens/turn | Measurable reduction vs LCM | 43–60 items/~3K tokens injected |
