# USME Memory System: Innovation Plan
_Alex Spinelli · April 9, 2026 · v8_

> **Note (April 10, 2026):** The skill candidate delivery and promotion sections below have been superseded by the full Reflect + Promote architecture spec at `pm/REFLECT-PROMOTE.md`. That document is the authoritative source for skill pipeline design. Everything else in this document remains current.

---

## Before You Write a Single Line of Code

**Read these files first.** Every decision in this plan was made knowing the existing structures. Build on them — don't duplicate or replace them.

| File | What to understand |
|---|---|
| `packages/usme-core/src/schema/types.ts` | All existing TypeScript types: `Episode`, `Concept`, `Skill`, `Entity`, `SensoryTrace`, `EntityRelationship` |
| `packages/usme-core/db/migrations/` (all 9 files) | Exact DB schema: column names, types, constraints, indexes. New migrations must follow the same naming convention (010_, 011_, etc.) |
| `packages/usme-core/src/assemble/types.ts` | `RetrievalCandidate`, `InjectedMemory`, `AssembleResult`, `MemoryTier` — the shapes the entire hot path uses |
| `packages/usme-core/src/assemble/retrieve.ts` | The `retrieve()` function and per-tier SQL queries. Spreading activation adds a second pass after this — don't modify the existing queries |
| `packages/usme-core/src/consolidate/nightly.ts` | `stepEpisodify()` (where importance scoring goes), `stepSkillDraft()` (where the gate changes), decay queries |
| `packages/usme-core/src/db/queries.ts` | `bumpAccessCounts()` (where write-back goes), all existing insert/update patterns |
| `packages/usme-openclaw/src/index.ts` | The `before_prompt_build` hook, `InjectionLogEntry` type, `writeInjectionLog()`, injection log path (`/tmp/usme/injection.jsonl`). Spreading activation metadata must extend the existing log entry — not replace it |

---

## Executive Summary

USME's current architecture collects and retrieves memories well but is missing two critical capabilities: a feedback loop that lets memories grow in importance over time (blocking skill creation permanently), and a reflective intelligence layer that reasons about the memory corpus holistically. This document defines the full improvement plan — scoring fixes, a Memory Reflection Service, entity graph retrieval, skill creation, and a rebuilt dashboard — with a prioritized implementation path.

Local compute optimization (Ollama embeddings, local reflection LLMs) is deliberately deferred. The goal is to build an excellent system first, then optimize cost.

---

## Current State: What's Broken

### 1. Skills are permanently blocked

All episodes are initialized with `utility_score = 0.5` (see `nightly.ts` lines 174, 278, 400). The nightly pipeline applies a 0.95 decay multiplier each cycle (`nightly.ts` ~line 566), so scores only go down. The skill drafting gate in `stepSkillDraft()` requires `utility_score >= 0.6` (line 456). **This threshold is permanently unreachable.** No episode can ever qualify.

Root cause: `bumpAccessCounts()` in `queries.ts` increments `access_count` but never writes back to `utility_score`. The two scoring systems are completely disconnected.

### 2. Memories don't reflect on themselves

The nightly pipeline is mechanical: cluster traces, promote episodes, resolve contradictions. It doesn't ask "what does this collection of memories mean?" or "what patterns are worth surfacing as skills?" A smart LLM reviewing the whole corpus finds things mechanical clustering misses entirely — subtle contradictions, recurring workflows, redundant concepts.

### 3. Retrieval doesn't use the entity graph

The `entities` and `entity_relationships` tables exist and are being populated. The `retrieve()` function in `retrieve.ts` queries them as one of the five ANN tiers (the `entities` TIER_QUERY is already defined). But no code walks the relationship graph after retrieval — USME only finds directly similar items, not connected ones.

---

## Plan: Full Improvement Set

---

### Fix 1 — Unblock Skills

#### What to add to the `episodes` table

Add an `importance_score` column (integer 1–10, default 5) to the existing `episodes` table via a new migration (`010_episode_importance.sql`). The `Episode` type in `schema/types.ts` must be updated to include this field.

#### What to change in `nightly.ts`

In `stepEpisodify()`, after the episode summary is generated and before the DB insert, call Haiku via tool_use to assign an importance score. The prompt should ask Haiku to score the episode 1–10 considering: specificity, actionability, uniqueness, and likely future relevance. The resulting score goes into the DB insert alongside the existing fields.

In `stepSkillDraft()`, change the WHERE clause from `utility_score >= 0.6` to `importance_score >= 7`. Everything else in that function stays the same.

#### What to change in `queries.ts`

In `bumpAccessCounts()`, after the existing `access_count` UPDATE, add a second UPDATE that writes a utility bump to episodes that have been retrieved frequently. Episodes with `access_count >= 10` should see their `utility_score` nudge upward (how much and how is the architect's call — the requirement is that high-access episodes eventually score above 0.6).

---

### Fix 2 — Memory Reflection Service

#### What it does

A new service — a new file in `packages/usme-core/src/consolidate/` — that assembles the full memory corpus, sends it to Claude Sonnet via the Anthropic SDK (already a dependency), and receives structured feedback. The service must use tool_use + Zod validation for the LLM response, consistent with the pattern already established in `nightly.ts` for `stepPromote`, `stepContradictions`, and `stepSkillDraft`.

The service produces updates across all memory tiers:
- **Concept updates**: raise/lower importance, deprecate, or merge concepts. Merges must respect the existing `supersedes_id` / `superseded_by` fields in the `concepts` table.
- **New skills**: recurring patterns worth capturing. Written to the existing `skills` table with `status = 'candidate'` if confidence >= 0.7; below that, stored in a new `skill_candidates` table.
- **Contradictions**: conflicting concepts. The resolution writes to `superseded_by` on the loser, consistent with how `stepContradictions` / `reconcile.ts` handles them.
- **Promotion candidates**: episodes worth elevating to concepts. Queue them for the next `stepEpisodify` cycle, or promote directly — architect decides.
- **Entity relationship updates**: add, soft-delete (set `valid_until`), or reclassify relationships in `entity_relationships`. Use the existing `valid_from` / `valid_until` pattern for soft deletes — don't hard delete.
- **Entity corrections**: fix `entity_type`, `canonical`, or merge duplicates via a redirect in metadata or a new canonical pointer — architect decides the merge strategy, but it must be consistent with how `entity_extractor.ts` writes entities.
- **Overall assessment**: a plain-text summary of memory health.

All writes from one reflection run must be atomic — one transaction. If any step fails, roll back and log the run as failed.

#### Model and schedule

- **Default model**: Claude Sonnet (`claude-sonnet-4-5` — the same model alias used in `nightly.ts` for `stepEpisodify`)
- **Schedule**: 08:00 and 20:00 Pacific. Wire into the existing `scheduler.ts` using `node-cron` (already a dependency and already used there)
- **CLI**: register `openclaw usme reflect` as a new CLI command in `usme-openclaw`. Flags: `--model [haiku|sonnet|opus]`, `--dry-run`, `--verbose`, `--tier [all|concepts|episodes]`, `--status`, `--last`

#### Corpus scope

- **Below 350K tokens**: send full corpus — all active concepts, top 60 episodes by `access_count + recency`, recent sensory traces (last 48h up to 500 rows), all entities + relationships
- **Above 350K tokens**: log which mode would be used, but v1 only needs to implement full-corpus mode. The threshold check must be logged on every run so tiered mode can be added later without rearchitecting.
- **Privacy scaffold**: add `exclude_from_reflection BOOLEAN DEFAULT FALSE` to `sensory_trace`, `episodes`, `concepts`, and `entities` tables via migration. Filter these rows out before assembling the corpus. Nothing is excluded by default.

#### Persistence

New migrations are required for:
- A reflection run log table (timestamp, trigger, model, token counts, duration, change counts per type, overall assessment text)
- A `skill_candidates` table (name, description, trigger pattern, steps, source episode IDs, confidence score, reflection run reference, approval status, timestamps)

The architect decides exact column names and types, but the data requirements above are fixed.

#### Skill candidate delivery

A separate daily cron (separate from the reflection schedule) queries `skill_candidates` where approval is pending and sends an agent message to Alex via the OpenClaw messaging API. The message includes skill name, description, trigger pattern, and source episodes. Alex replies to approve or reject — the reply updates `skill_candidates.accepted` and, on approval, moves the skill to the `skills` table with `status = 'active'`.

---

### Fix 3 — Spreading Activation via Entity Graph

#### What it does

After `retrieve()` returns its initial ANN candidate pool, perform a second-pass graph walk before scoring. The goal: find episodes connected to the retrieved items through entity relationships, and pull them into the candidate pool.

This is validated by the Synapse paper (2026): **+7.2 F1 on multi-hop reasoning, 95% token reduction** vs full-context retrieval.

#### Where it goes

In `assemble/retrieve.ts` (or a new `assemble/spread.ts` imported there), add a function that runs after `retrieve()`. The existing `retrieve()` function and its tier queries must not be modified.

#### Requirements

- Extract entity mentions from the initial candidate items (look for entity names/canonicals from the `entities` table that appear in item content)
- Walk `entity_relationships` up to N hops — default 2, configurable via a new `spreading.maxDepth` key in the USME config (which goes through `config.ts` in `usme-openclaw`)
- Pull additional episodes that reference any matched entities, excluding items already in the pool
- Cap additional items (architect decides the cap — enough to enrich without bloating)
- Re-rank the combined pool using the existing `score()` function in `score.ts` — don't bypass or duplicate it
- Depth 0 must be a no-op (pure ANN, identical to current behavior) — use this for A/B testing
- The spreading activation metrics (initial item count, entities matched, connected entities, episodes added, spread depth, duration) must be added to the existing `InjectionLogEntry` type and written to `/tmp/usme/injection.jsonl` via the existing `writeInjectionLog()` function

---

### Fix 4 — Importance Scoring at Write Time

Covered under Fix 1. The key requirement repeated here for clarity: Haiku is called inside `stepEpisodify()` in `nightly.ts` before the DB insert. The call must use tool_use + Zod validation (consistent with the rest of `nightly.ts`). The result populates `importance_score` on the episode row.

---

## Implementation Priority

| # | Feature | Touches existing code | Notes |
|---|---|---|---|
| 1 | `importance_score` migration + `stepEpisodify` Haiku call | `nightly.ts`, `queries.ts`, `schema/types.ts` | Unblocks skills immediately |
| 2 | Skill gate change in `stepSkillDraft` | `nightly.ts` | One line once migration is done |
| 3 | Access-count write-back in `bumpAccessCounts` | `queries.ts` | Completes the feedback loop |
| 4 | Reflection service (new file) | `scheduler.ts` (add cron), CLI | Main innovation |
| 5 | Reflection persistence migrations | New migration files | Required for #4 |
| 6 | Spreading activation | `retrieve.ts` or new `spread.ts`, `index.ts` (log entry) | Synapse pattern |
| 7 | Exclude flag migrations | 4 table ALTERs | Privacy scaffold |
| 8 | Skill candidate delivery cron | New cron job | Quality control loop |
| 9 | Dashboard (new project) | None — standalone server | Reads existing DB + injection log |

---

## What This Looks Like When Working

**Per turn** (existing, unchanged):
- Embed query → `retrieve()` ANN across tiers → `score()` → `pack()` → inject via `prependContext`

**Per turn** (after Fix 3):
- Embed query → `retrieve()` ANN → spreading activation second pass → `score()` → `pack()` → inject
- Injection log entry includes spreading metrics

**Every turn (background)**:
- Fact extraction (haiku) + entity extraction (haiku) — unchanged
- New episodes get `importance_score` assigned at creation

**2x/day** (08:00 + 20:00 Pacific, via `scheduler.ts`):
- Sonnet reviews full corpus
- Updates concepts, drafts skills, resolves contradictions, updates entity graph
- Reflection run logged; skill candidates queued for delivery

**Daily cron**:
- Pending skill candidates delivered as agent messages

**Nightly 03:00 UTC** (existing pipeline, improved):
- `stepEpisodify` now also assigns `importance_score`
- `stepSkillDraft` now gates on `importance_score >= 7`
- Decay + prune unchanged

---

## Observability & Instrumentation

Every feature ships with logging from day one. Use pino (already imported as `logger.ts` in `usme-core`) for all structured logs.

### Reflection runs

Log one pino entry per phase: fetch (item counts, duration), llm_call (token counts, model, duration), consume (change counts by type), done (total duration, status, rolled_back flag on failure). The same data must be written to the reflection run log table.

### Spreading activation

Extend `InjectionLogEntry` in `usme-openclaw/src/index.ts` with optional spreading fields: `spreadingDepth`, `entitiesMatched`, `episodesAdded`. These are `undefined` when spreading is disabled (depth=0). The `writeInjectionLog()` function writes them alongside existing fields.

### Importance scoring

Log each new episode's `importance_score` and Haiku call duration via pino at the `stepEpisodify` level. The score distribution is queryable via the `episodes` table — the dashboard uses this directly.

### Skill candidate tracking

Log each dispatch (cron message sent) and each direct DB write (confidence >= 0.7) via pino. The `skill_candidates` table must support: count by approval status, average confidence by status.

### Corpus size

Before each reflection run, compute total token estimate across all corpus items and log it alongside the 350K threshold and which mode was selected (full/tiered).

---

## Open Questions

All resolved:

| Decision | Answer |
|---|---|
| Reflection schedule | 08:00 + 20:00 Pacific via `scheduler.ts` + on-demand CLI |
| Corpus threshold | 350K tokens — full below, tiered above (tiered mode deferred to v2) |
| Skill candidate review | Agent message via daily cron — Alex replies to approve/reject |
| Entity graph depth | 2 hops default, configurable via `spreading.maxDepth` in USME config |
| Reflection model | Sonnet default; `--model` flag on CLI |

---

## Dashboard Redesign

### Why the old dashboard is obsolete

The existing dashboard at `https://collective7.spinelli5.com/usme/` reads from `shadow_comparisons` — a table that compared hypothetical USME injection against LCM output. That comparison model is gone. USME is in active mode; `shadow_comparisons` is dead data.

**This is a new standalone project** at `~/ai/projects/rufus-projects/usme-dashboard/`. Do not modify `rufus-plugin/dashboard/`. The new server connects to the same PostgreSQL database (same credentials) and reads `/tmp/usme/injection.jsonl`.

---

### Panel Requirements

#### Panel 1 — Memory Health (top, always visible)

- Count of rows in: `sensory_trace`, `episodes`, `concepts`, `entities`, `skills`
- Estimated total token count (can use `token_count` column on `episodes`, `length(content)/4` approximation on others)
- Progress toward 350K token threshold (bar or %)
- Last consolidation run: timestamp + what it produced (query the existing consolidation scheduler's log or the nightly run output — architect decides where this is best sourced)
- Last reflection run: timestamp, model, change counts (query the new reflection run log table)

---

#### Panel 2 — Live Injection Feed (auto-refresh every 5s)

Read from `/tmp/usme/injection.jsonl`. The existing fields on `InjectionLogEntry` are: `ts`, `sessionId`, `mode`, `itemsSelected`, `itemsConsidered`, `tiersQueried`, `tokensInjected`, `durationMs`, `injected`, `contextBlock`.

Show per-turn:
- Timestamp (exact Pacific time), items injected, tokens, tiers queried, latency
- Items from spreading activation vs direct ANN (from new spreading fields added in Fix 3)
- Expandable: the full `contextBlock` showing tier, relevance score, content preview per item

---

#### Panel 3 — Reflection History

Read from the reflection run log table (new, from Fix 2).

Table, newest first:
- Timestamp, model, corpus tokens used
- Change counts: concepts updated, skills created, contradictions resolved, entities updated
- Expandable row: full `overall_assessment` text

---

#### Panel 4 — Skills

Two sub-sections:

**Active skills** — query `skills` table where `status = 'active'`:
- Name, trigger pattern (from `skill_path` or `metadata` — architect decides), confidence (from `teachability`), created date

**Pending candidates** — query `skill_candidates` table where not yet reviewed:
- Name, confidence score, source episode count, approve/reject buttons
- Approval rate summary (accepted/rejected/pending counts + average confidence per bucket)

---

#### Panel 5 — Entity Graph Summary

Read from `entities` and `entity_relationships` tables.

- Count of rows by `entity_type` (person, org, project, tool, concept, location)
- 10 most recently created entities (`created_at DESC`)
- 10 most connected entities (join `entity_relationships` on source_id or target_id, count, order by count DESC)

---

#### Panel 6 — Importance Distribution

Read from `episodes` table.

- Histogram: count of episodes per `importance_score` value (1–10). Note: `importance_score` column does not exist yet — it will be added by Fix 1's migration. The dashboard should handle the case where the column doesn't exist yet (display a placeholder or empty state).
- Utility score: `AVG(utility_score)`, `MAX(utility_score)`, `MIN(utility_score)` from episodes
- Skill eligibility count: `COUNT(*) WHERE importance_score >= 7`

---

### API Endpoints

Six read-only JSON endpoints. Architects and coders decide exact response schemas — these are the data requirements:

- `GET /usme/api/health` — all Panel 1 data
- `GET /usme/api/injection?limit=N` — most recent N entries from injection.jsonl
- `GET /usme/api/reflections?limit=N` — reflection run history
- `GET /usme/api/skills` — active skills + pending candidates + approval rate
- `GET /usme/api/entities/summary` — counts by type + most connected + most recent
- `GET /usme/api/scoring` — importance histogram + utility stats + eligibility count

Refresh cadences: injection feed every 5s, health every 60s, everything else every 5min.
Timestamps: always exact local Pacific time. Never relative (no "2h ago").

---

## Build System Rules (Mandatory for All Agents)

The `usme-claw` build system has a specific structure that must be preserved exactly. Do not create alternative build outputs, parallel dist directories, or copies of compiled files.

**Repository structure:**

```
usme-claw/
  packages/
    usme-core/
      src/               ← all business logic: TypeScript, no compilation step
      db/migrations/     ← migration files, numbered sequentially
      package.json       ← main: "./src/index.ts" (loaded directly by usme-openclaw)
    usme-openclaw/
      src/
        index.ts         ← ENTRY POINT — this is what esbuild bundles
      package.json       ← contains the build script
      openclaw.plugin.json
```

**The build command** (run from `packages/usme-openclaw/`):

```bash
npm run build
# which runs:
# esbuild src/index.ts --bundle --platform=node --format=esm \
#   --outfile=~/.openclaw/extensions/usme-claw/dist/plugin.js
```

This produces **one file**: `~/.openclaw/extensions/usme-claw/dist/plugin.js`. That is what OpenClaw loads at runtime.

**Rules:**
1. All new TypeScript goes in `usme-core/src/` (business logic) or `usme-openclaw/src/` (plugin wiring only)
2. Never create a `dist/` directory inside the source repo packages
3. Never create a second copy of `plugin.js` anywhere other than the extensions dir
4. After any code change, run `npm run build` from `usme-openclaw/` and verify the extensions dir `plugin.js` timestamp updated
5. Do not modify `openclaw.plugin.json` or `package.json` in the extensions dir — the postbuild script regenerates them
6. New DB migrations go in `usme-core/db/migrations/` numbered sequentially (next is `010_`). Run via `npm run migrate` in `usme-core`
7. The dashboard (`usme-dashboard/`) is a completely separate project — it does not go inside `usme-claw`

---

## Deferred to Later

- **Local embeddings** (Ollama / nomic-embed-text): saves ~400ms/turn — defer until system quality is validated
- **Local reflection LLM** (phi-4-mini / qwen2.5-7B): free but slower — defer until Sonnet cost becomes a concern
- **MoE-gated retrieval weights**: learned/adaptive weights instead of fixed 40/25/20/15 — future v2 feature
- **Tiered corpus** (date/diff filtering above 350K): architecture supports it via the threshold check — implement in v2

---

_Research sources: Generative Agents (Park et al 2023), A-MEM (Xu et al 2025), Synapse spreading activation (2026), Memory for Autonomous LLM Agents survey (2026)_
