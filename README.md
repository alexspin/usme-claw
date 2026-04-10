# usme-claw

**USME — Utility-Shaped Memory Ecology**

> *A brain that selects beats a filing cabinet that shrinks.*

USME is a semantic memory system for LLM agents. It captures and consolidates knowledge across conversations, then assembles a context window of **what the model should know right now** on every turn — selected by relevance, not recency.

It ships as an [OpenClaw](https://github.com/openclaw/openclaw) plugin and runs in **active mode**: it injects 43–60 semantic memory items per turn at ~54ms latency.

---

## Contents

- [Memory Tiers](#memory-tiers)
- [The Hot Path](#the-hot-path)
- [Scoring Formula](#scoring-formula)
- [Assembly Modes](#assembly-modes)
- [Consolidation Pipeline](#consolidation-pipeline)
- [Reflection Service](#reflection-service)
- [Skill Creation](#skill-creation)
- [Dashboard](#dashboard)
- [Architecture](#architecture)
- [Setup](#setup)
- [OpenClaw Integration](#openclaw-integration)
- [Tuning](#tuning)
- [Observability](#observability)

---

## Memory Tiers

USME organizes memory into five tiers, each with a distinct lifecycle and retrieval role. All tiers participate in ANN retrieval using pgvector HNSW indexes.

### 1. `sensory_trace` — Raw Per-Turn Facts

The entry point for all new information. On every turn, the extraction pipeline (Claude Haiku) reads the conversation and writes individual facts, preferences, decisions, and anomalies as `sensory_trace` rows. These are high-volume and short-lived.

**Schema highlights:**
- `item_type`: `verbatim` | `extracted`
- `memory_type`: `fact` | `preference` | `decision` | `plan` | `anomaly` | `ephemeral` | `insight`
- `provenance_kind`: `user` | `tool` | `model` | `web` | `file` — drives provenance score in retrieval
- `utility_prior`: `high` | `medium` | `low` | `discard` — initial importance estimate
- `expires_at`: traces TTL out after roughly 7 days unless promoted
- `exclude_from_reflection`: privacy flag, default false

Traces are the raw material. They accumulate quickly and get pruned aggressively once episodified.

---

### 2. `episodes` — Clustered Summaries

The consolidation pipeline (Claude Sonnet) groups related sensory traces into episodes nightly. An episode is a narrative summary of a thematic cluster of traces — e.g., "Alex and Rufus debugged the USME embedding pipeline on April 7."

**Schema highlights:**
- `summary`: the LLM-generated narrative, the primary retrieval content
- `source_trace_ids`: which traces were clustered into this episode
- `utility_score`: float 0–1, starts at 0.5, decays at 0.95×/cycle, bumped +0.05 when `access_count >= 10`
- `importance_score`: integer 1–10, assigned by Haiku at creation time (migration 010). **The nightly skill gate requires `importance_score >= 7`.**
- `access_count`: incremented on each retrieval hit; feeds utility write-back
- `exclude_from_reflection`: privacy flag

Episodes are the primary memory unit for mid-term knowledge. The corpus currently holds ~160 episodes.

---

### 3. `concepts` — Stable Long-Term Knowledge

Concepts are promoted from episodes when the consolidation pipeline determines a theme recurs across multiple episodes. A concept might be "Alex's preferred library strategy: battle-tested over hand-rolled" — something that persists and compounds over time.

**Schema highlights:**
- `concept_type`: `fact` | `preference` | `decision` | `relationship_summary`
- `utility_score`: stable, decays slowly — concepts survive longer than episodes
- `confidence`: float 0–1, updated on each promotion or reflection update
- `supersedes_id` / `superseded_by`: chain when concepts are merged or updated
- `is_active`: inactive concepts are retained but excluded from retrieval
- `tags`: used for filtering and categorization
- `exclude_from_reflection`: privacy flag

Concepts use HNSW indexes for fast ANN retrieval. The corpus currently holds ~34 active concepts.

---

### 4. `entities` + `entity_relationships` — The Knowledge Graph

Entities are named things the system knows about: people, projects, tools, organizations, locations. They form a lightweight knowledge graph via `entity_relationships`, which records typed, timestamped edges between entities.

**Schema highlights (Entity):**
- `entity_type`: `person` | `org` | `project` | `tool` | `location` | `concept`
- `canonical`: normalized name for deduplication
- `confidence`: how certain the system is this entity is real and correctly typed
- `exclude_from_reflection`: privacy flag

**Schema highlights (EntityRelationship):**
- `relationship`: free-text label (e.g., "maintains", "uses", "reported_by")
- `valid_from` / `valid_until`: soft-delete / temporal range — relationships don't get hard-deleted
- `confidence`: edge-level certainty score

Entities power **spreading activation**: after initial ANN retrieval, the system walks the entity graph up to N hops to pull in adjacent context that shares conceptual neighbors. Default depth is 2 (configurable via `spreading.maxDepth`; set to 0 to disable).

The corpus currently holds ~298 entities with sparse relationship coverage (0–1 edges each). The reflection service adds relationship updates on each run.

---

### 5. `skills` + `skill_candidates` — Reusable Procedures

Skills are distilled from episodes when the system identifies a recurring, teachable pattern — e.g., "How to deploy the USME plugin." A skill has a name, description, trigger pattern, step-by-step procedure, and a teachability score.

**Schema highlights (Skill):**
- `status`: `candidate` | `active` | `retired`
- `skill_path`: semantic path for categorization
- `source_episode_ids`: which episodes the skill was distilled from
- `teachability`: float 0–1, drives retrieval weight for skill tier

**Schema highlights (SkillCandidate):**
- `approval_status`: `pending` | `accepted` | `rejected`
- `confidence`: reflection service confidence score (gate: >= 0.7)
- `reflection_run_id`: which reflection run produced this candidate

Skills are surfaced via two paths — see [Skill Creation](#skill-creation). There are currently 13 candidate skills pending (confidence 0.81–0.97) and 1 active skill promoted via the script-based workflow.

---

## The Hot Path

On every turn, USME runs the following pipeline synchronously before the LLM prompt is built:

```
1. embedText(query)          — OpenAI text-embedding-3-small, ~420ms
2. retrieve()                — ANN query across sensory_trace, episodes, concepts, skills
                               (top-20 per tier = 80 candidates)
3. spread()                  — walk entity graph from retrieved entities, maxDepth=2
4. score()                   — apply weighted scoring formula to all candidates
5. pack()                    — greedy token-budget fit, sorted by score
6. prependContext()          — inject result as <usme-context> block in system prompt
7. insertSensoryTrace()      — async: persist new facts from this turn
```

Total hot-path latency: ~54ms (dominated by the embedding call). Injection adds the `<usme-context>` block seen at the top of every turn's system prompt.

A `before_message_write` hook strips `<usme-context>` blocks before messages are written to the transcript, preventing the +10K token/turn accumulation that would otherwise occur as injected blocks compound across stored messages.

---

## Scoring Formula

All retrieved memory items are ranked using a weighted formula:

| Signal | Weight | Notes |
|---|---|---|
| Embedding similarity | 0.40 | pgvector cosine similarity, computed server-side |
| Recency | 0.25 | Exponential decay from `created_at` |
| Provenance | 0.20 | user=1.0, tool=0.85, file=0.75, web=0.70, model=0.60 |
| Access frequency | 0.15 | Normalized `access_count` |

**Skill tier uses a different formula:**

| Signal | Weight |
|---|---|
| Teachability | 0.40 |
| Access frequency | 0.30 |
| Embedding similarity | 0.20 |
| Provenance | 0.10 |
| Recency | 0.00 |

Skills don't decay. Teachability and how often they've been useful drive selection.

---

## Assembly Modes

Three token budget presets control how much context USME injects:

| Mode | Token Budget | Use case |
|---|---|---|
| `psycho-genius` | 50,000 | Maximum context, complex reasoning tasks |
| `brilliant` | 30,000 | Default — balanced context + space for conversation |
| `smart-efficient` | 15,000 | Tight token budgets, faster turns |

Configure via `assembly.defaultMode` in `openclaw.json`.

---

## Consolidation Pipeline

Runs nightly at 03:00 UTC plus a mini-consolidation every 30 minutes.

**5 steps in order:**

1. **Episodify** — Sonnet clusters recent `sensory_trace` rows into episodes. Haiku assigns `importance_score` (1–10) to each new episode at creation time.
2. **Promote** — Sonnet reviews episodes and promotes recurring themes to `concepts`.
3. **Contradictions** — Sonnet detects and resolves contradictions between concepts (cosine similarity < 0.10 triggers arbitration).
4. **Skill Draft** — Queries episodes where `importance_score >= 7` and `skill_checked_at IS NULL`. Sonnet drafts skill candidates. **Currently blocked for legacy episodes** (all 160 pre-migration episodes have `importance_score = 5` — see [Skill Creation](#skill-creation)).
5. **Decay / Prune** — Applies 0.95× utility decay to all episodes. Prunes sensory traces that have been episodified and are past TTL.

---

## Reflection Service

The reflection service is a separate LLM-based pipeline that reviews the full memory corpus holistically and makes updates mechanical clustering cannot detect.

### What it does

On each run, Claude Sonnet reads the full corpus (~69K tokens: all concepts, episodes, traces, entities) and produces:

- **Concept updates** — raises, lowers, deprecates, or merges concepts
- **Skill candidates** — drafts skills for patterns it identifies (confidence >= 0.7 → `skills` table as `candidate`; below 0.7 → `skill_candidates` for manual review)
- **Contradiction resolutions** — resolves conflicts between concepts
- **Entity relationship updates** — adds/removes/updates edges in the entity graph
- **Overall assessment** — corpus health grade and improvement recommendations

Results from each run are logged to the `reflection_runs` table.

### CLI

```bash
openclaw usme reflect                    # run with defaults (sonnet)
openclaw usme reflect --dry-run          # full run, no DB writes
openclaw usme reflect --verbose          # print full Sonnet output
openclaw usme reflect --model haiku      # use Haiku instead
openclaw usme reflect --model opus       # use Opus for deep review
openclaw usme reflect --status           # show last run status
openclaw usme reflect --last             # print last run's assessment
```

### Schedule

Two cron runs daily: **16:00 UTC** and **04:00 UTC**. On-demand via CLI.

### Corpus threshold

At 350K tokens, the reflection switches to tiered mode (recent + unseen content only). Current corpus: ~69K tokens (~12% of threshold).

### Run history

- Run 1 (2026-04-09, dry-run): 23 concept updates, 5 skill drafts, 3 contradictions, 10 entity updates
- Run 2 (2026-04-09 22:47 UTC, live): 22 concept updates, 5 skills created, 3 contradictions resolved, 10 entity relationship updates. Grade: A−/B+
- Run 3–6 (2026-04-10): Subsequent runs post-migration 014. Quality gate enforced (A/A-/B+ only → `skill_candidates` table). 13 candidates total with `source_episode_ids` populated. Grade: B+ or better on all runs.

---

## Skill Creation

There are two independent paths for creating skills:

### Path 1: Nightly `stepSkillDraft` (03:00 UTC)

Queries: `WHERE importance_score >= 7 AND skill_checked_at IS NULL`

**Status: currently blocked.** All 160 episodes created before migration 010 have `importance_score = 5` (hardcoded fallback). The gate requires >= 7. New episodes created after the migration will score correctly via Haiku at creation time.

Resolution options: (A) backfill scores via Haiku API calls (~$0.01 each), (B) bulk SQL update to 7+, (C) lower threshold temporarily.

### Path 2: Reflection Service

Sonnet reviews the corpus and drafts skills based on its own judgment. No `importance_score` dependency. Confidence >= 0.7 → written directly to `skills` table as `candidate`. Below 0.7 → `skill_candidates` table for manual approval.

**Status: working.** 13 candidates pending as of 2026-04-10 (confidence 0.81–0.97). Top candidates:
- Raise LLM Output Token Ceiling (0.97)
- Fix PostgreSQL Transaction Poisoning with Savepoints (0.95)
- Normalize LLM Array Fields Before Schema Validation (0.93)

1 active skill promoted: **Fix PostgreSQL Transaction Poisoning with Savepoints** — written to `workspace-rufus/skills/fix-postgresql-transaction-poisoning-with-savepoints/SKILL.md`.

Skill candidates are delivered daily at 17:00 UTC via system event when candidates are pending.

### Promoting candidates (script-based workflow)

```bash
# List pending candidates with confidence scores
npx tsx packages/usme-core/src/scripts/list-candidates.ts

# Promote candidate by position (1-based, sorted by confidence desc)
npx tsx packages/usme-core/src/scripts/promote-candidate.ts --pick 1

# Dismiss a candidate by ID
npx tsx packages/usme-core/src/scripts/dismiss-candidate.ts <id>
```

`promote-candidate.ts` is self-contained: it writes `SKILL.md` to the workspace skills directory, computes an embedding, and updates the DB — all in a single transaction. No Rufus session or external event required.

---

## Dashboard

Live at **https://collective7.spinelli5.com/usme/** (port 3456).

Six panels:

| Panel | What it shows |
|---|---|
| Memory Health | Corpus counts across all tiers, token estimate, last consolidation/reflection timestamps, progress toward 350K threshold |
| Live Injection Feed | Per-turn injection details: item counts, tokens, latency, retrieved items with relevance scores, ANN vs spreading activation breakdown |
| Reflection History | Table of past reflection runs: model, corpus tokens, changes made, expandable assessment text |
| Skills | Active skills with trigger patterns and confidence; pending candidates with approve/reject controls |
| Entity Graph Summary | Entity counts by type, recently added entities, most-connected entities by relationship count |
| Importance Distribution | Histogram of episode importance scores, utility score trend over time (diagnose scoring drift) |

API endpoints: `GET /usme/api/health`, `/usme/api/injection?limit=50`, `/usme/api/reflections?limit=20`, `/usme/api/skills`, `/usme/api/entities/summary`, `/usme/api/scoring`

---

## Architecture

### Package structure

```
usme-claw/
├── packages/
│   ├── usme-core/               ← All portable logic (no OpenClaw dependency)
│   │   ├── src/
│   │   │   ├── schema/types.ts  ← DB type interfaces
│   │   │   ├── assemble/        ← Hot path: retrieve, score, pack, spread
│   │   │   ├── consolidate/     ← Nightly pipeline + reflection service
│   │   │   ├── extract/         ← Fact + entity extraction (Haiku)
│   │   │   ├── embed/           ← OpenAI embedding wrapper
│   │   │   ├── db/              ← DB pool, queries, migrations
│   │   │   └── logger.ts        ← pino logger
│   │   └── db/migrations/       ← 001–013 SQL migration files
│   └── usme-openclaw/           ← OpenClaw plugin adapter
│       └── src/
│           ├── index.ts         ← Plugin entry point, hook registration, scheduler
│           ├── config.ts        ← Config schema + DEFAULT_CONFIG
│           ├── spread.ts        ← Spreading activation (entity graph walk)
│           ├── telemetry.ts     ← Injection log writer
│           └── commands/        ← CLI commands (reflect, etc.)
```

### Build

```bash
cd packages/usme-openclaw
npm run build
# → ~/.openclaw/extensions/usme-claw/dist/plugin.js (single 1.5MB bundle)
```

There is **one copy** of the built plugin. esbuild writes directly to the extensions directory. No intermediate `dist/` in the source repo.

### Migrations

```bash
npm run migrate    # from packages/usme-core
```

Migrations 001–014 are applied. Key additions:
- 010: `importance_score` on episodes
- 011: `reflection_runs` table
- 012: `skill_candidates` table
- 013: `exclude_from_reflection` on all 4 tiers
- 014: `quality_tier`, `prompted_at`, `defer_until`, `dismissed_at`, `source` on skill_candidates; `promoted_at`, `source_candidate_id`, `generation_notes` on skills; `pending_morning_notify` on reflection_runs

---

## Setup

### Requirements

- Node.js v18+
- PostgreSQL with TimescaleDB + pgvector (`timescale/timescaledb-ha:pg16` recommended)
- OpenAI API key (for embeddings)
- Anthropic API key (for extraction and consolidation)

### Database

```bash
# Docker Compose (recommended)
docker compose up -d

# Or standalone PostgreSQL with extensions
psql -c "CREATE EXTENSION IF NOT EXISTS vector;"
psql -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"

# Run migrations
cd packages/usme-core && npm run migrate
```

Default connection: `postgresql://usme:usme_dev@localhost:5432/usme`

### Build and install

```bash
npm install
cd packages/usme-openclaw && npm run build
```

---

## OpenClaw Integration

Add to `openclaw.json`:

```json
{
  "plugins": {
    "installs": {
      "usme-claw": {
        "sourcePath": "/path/to/.openclaw/extensions/usme-claw",
        "installPath": "/path/to/.openclaw/extensions/usme-claw"
      }
    }
  }
}
```

Plugin config (under `plugins.config.usme-claw`):

```json
{
  "mode": "active",
  "db": { "host": "localhost", "port": 5432, "database": "usme", "user": "usme", "password": "usme_dev" },
  "extraction": { "enabled": true, "model": "claude-haiku-4-5" },
  "assembly": { "defaultMode": "brilliant" },
  "spreading": { "maxDepth": 2 }
}
```

**Modes:**
- `active` — retrieval + injection live
- `log-only` — pipeline runs, nothing injected (safe testing mode)
- `off` — USME disabled entirely

---

## Tuning

| Parameter | Default | Effect |
|---|---|---|
| `assembly.defaultMode` | `brilliant` | Token budget for context injection |
| `spreading.maxDepth` | `2` | Entity graph hops after ANN retrieval. Set to `0` to disable. |
| `extraction.enabled` | `true` | Turn off to stop writing new sensory traces |
| `consolidation.candidatesPerNight` | `5` | Max skill candidates per nightly run |
| `consolidation.cron` | `0 3 * * *` | Nightly consolidation schedule |

---

## Observability

### Injection log

Written to `/tmp/usme/injection.jsonl` on every turn. Contains: items retrieved per tier, scores, latency, spreading activation stats.

### Reflection logs

`reflection_runs` table — every reflection run logged with input/output tokens, duration, counts of updates made, and the full `overall_assessment` text.

### Importance score distribution

```sql
SELECT importance_score, COUNT(*) 
FROM episodes 
GROUP BY importance_score 
ORDER BY importance_score;
```

### Utility score health

```sql
SELECT AVG(utility_score), MIN(utility_score), MAX(utility_score)
FROM episodes;
```

### Skill candidate queue

```sql
SELECT name, confidence, approval_status, created_at
FROM skill_candidates
ORDER BY created_at DESC;
```
