# usme-claw

**USME — Utility-Shaped Memory Ecology**

> *A brain that selects beats a filing cabinet that shrinks.*

USME is a semantic memory system for LLM agents. It captures and consolidates knowledge across conversations — then, on every turn, assembles a context window of **what the model should know right now**, selected by relevance rather than recency.

It ships as an [OpenClaw](https://github.com/openclaw/openclaw) plugin. It currently runs alongside the default context engine in **shadow mode**, logging what it would inject without replacing anything. Flip one config flag to go live.

---

## Contents

- [The Problem](#the-problem)
- [How USME Works](#how-usme-works)
- [Memory Tiers](#memory-tiers)
- [The Hot Path](#the-hot-path)
- [Scoring Formula](#scoring-formula)
- [Assembly Modes](#assembly-modes)
- [Consolidation Pipeline](#consolidation-pipeline)
- [Skill Distillation](#skill-distillation)
- [Why USME over mem0](#why-usme-over-mem0)
- [How USME Works with LCM](#how-usme-works-with-lcm)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Setup](#setup)
- [OpenClaw Integration](#openclaw-integration)
- [Tuning](#tuning)
- [Observability](#observability)
- [TODO and Future Work](#todo-and-future-work)
- [Design Tenets](#design-tenets)

---

## The Problem

Most LLM context management is **compression-first, history-preserving**. The job of a system like LCM (or any summarisation-based context engine) is to fit the full conversation history into the context window. It compresses — it does not curate.

The core problem: every turn, the model gets a compressed version of *everything*, regardless of relevance.

- A joke from two weeks ago gets the same weight as an architectural decision made yesterday.
- There is no episodic memory, no concept layer, no stable-facts store — just compressed chat history.
- Nothing learns. Every session starts fresh on "what matters."

USME reframes the question: instead of *"how do we preserve history?"*, the question is *"what should the model know right now to do its best work?"*

That is a harder question — and a significantly more valuable one.

---

## How USME Works

At a high level, USME runs two concurrent pipelines:

**Per-turn (hot path, synchronous, P95 ≤150ms):**
```
User sends a message
  → embed the message (OpenAI text-embedding-3-small)
  → ANN search across all memory tiers (pgvector HNSW)
  → score candidates: similarity × recency × provenance × access frequency
  → critic filter: drop low-confidence, inactive, or redundant items
  → greedy pack into token budget
  → prepend <usme-context> block to system prompt
```

**Per-turn (extraction, fire-and-forget, async):**
```
After each turn
  → serialize last 4 messages (user + assistant)
  → send to claude-haiku-4-5 with extraction prompt
  → extract: facts, preferences, decisions, plans, insights, anomalies, ephemerals
  → embed each extracted item
  → dedup check (cosine similarity > 0.95 → skip)
  → insert into sensory_trace table
```

**Periodic (mini-consolidation, every 30 min):**
```
Cluster recent sensory traces → episode summaries (Sonnet)
Embed episodes → ready for retrieval
```

**Nightly (full consolidation, 3am UTC by default):**
```
Episodes → concepts (recurring pattern promotion)
Concepts → contradiction resolution
High-utility episodes → skill candidates
Utility score decay across all tiers
Expired trace pruning
```

---

## Memory Tiers

USME maintains five distinct memory tiers, each with different semantics, decay rates, and scoring weights:

### Sensory Traces
Raw extracted facts from every conversation turn. The write-heavy tier — each fact, preference, decision, plan, and insight from every message goes here first. Fast recency decay (half-life: 1 day). Think of these as short-term working memory.

```
memory_type: fact | preference | decision | plan | anomaly | ephemeral
utility_prior: high | medium | low | discard
provenance_kind: user | tool | model | web | file
tags: string[]
expires_at: optional TTL (set automatically for ephemeral items)
```

### Episodes
Compressed summaries of related sensory traces, clustered by session and time proximity. Created by the mini-consolidation job (Sonnet). Medium decay (half-life: 7 days). Think of these as daily notes — "here's what happened in this work session."

### Concepts
Stable, recurring facts and preferences extracted from episodes via the nightly promotion step. Concepts have explicit `confidence` scores (0–1), can be marked `is_active = false` when superseded, and decay very slowly (half-life: 90 days). Think of these as long-term memory — the things the agent can be reliably confident are true about you and your work.

```
concept_type: fact | preference | decision | relationship_summary
confidence: float (0.0–1.0)
supersedes_id: uuid (links to the concept this one replaced)
```

### Skills
Procedural patterns worth reusing, distilled from high-utility episodes by the nightly skill-drafting step. Skills do **not** decay — once a skill is active, it stays active until explicitly retired. Skills have a `teachability` score (0–10) that heavily weights their retrieval priority. See [Skill Distillation](#skill-distillation) for details.

```
status: candidate | active | retired
teachability: float (0–10)
use_count: int (incremented on retrieval)
```

### Entities
Named references — people, projects, codebases, systems. Extracted separately by the entity extractor and used to enrich retrieval context. Moderate decay (half-life: 30 days).

---

## The Hot Path

Assembly runs on every turn before the model sees the message. The pipeline is:

```
retrieve → score → critic → pack
```

**Retrieve** runs parallel ANN queries across all enabled tiers via pgvector HNSW indexes. Each tier query has an independent 80ms timeout — a slow tier is skipped gracefully, not blocking. Queries are raw SQL with `ORDER BY embedding <=> $1::vector LIMIT $2`.

**Score** applies a weighted composite formula to each candidate (see below). Each tier's metadata feeds into different weights.

**Critic** applies rule-based filtering: drop items below the confidence threshold, drop inactive concepts, drop items below the minimum inclusion score for the current mode.

**Pack** greedily fills the token budget from highest-score to lowest. Stops when the budget is exhausted. Returns both the selected items and a metadata struct (items considered, items selected, tiers queried, duration, tokens used).

Total target: **P95 ≤ 150ms** including embedding. Current measured latency: 40–73ms.

---

## Scoring Formula

Each candidate receives a composite score in [0, 1]:

```
score = w_sim × similarity
      + w_rec × recency_decay
      + w_prov × provenance_score
      + w_acc × access_frequency
```

**Default weights (all tiers except skills):**

| Component | Weight | Description |
|-----------|--------|-------------|
| `similarity` | 0.40 | Cosine similarity to query embedding |
| `recency` | 0.25 | Exponential decay with tier-specific half-life |
| `provenance` | 0.20 | Reliability of source (user > tool > file > web > model) |
| `accessFreq` | 0.15 | Log-scaled access count with recency bonus |

**Skill weights (skills tier only):**

| Component | Weight | Description |
|-----------|--------|-------------|
| `teachability` | 0.40 | How replicable/teachable the skill is (0–10, normalized) |
| `accessFreq` | 0.30 | Usage history |
| `similarity` | 0.20 | Semantic relevance |
| `provenance` | 0.10 | Source reliability |
| `recency` | 0.00 | Skills don't decay — age is not a penalty |

**Recency half-lives by tier:**

| Tier | Half-life |
|------|-----------|
| sensory_trace | 1 day |
| episodes | 7 days |
| entities | 30 days |
| concepts | 90 days |
| skills | ∞ (no decay) |

**Provenance reliability:**

| Source | Score |
|--------|-------|
| user | 1.00 |
| tool | 0.85 |
| file | 0.75 |
| web | 0.70 |
| model | 0.60 |

All weights and half-lives are configurable. See [Tuning](#tuning).

---

## Assembly Modes

Three named modes control how aggressively USME retrieves and how much of the context window it claims:

| Mode | Token budget fraction | Tiers | Candidates/tier | Min inclusion score | Use case |
|------|----------------------|-------|-----------------|--------------------:|----------|
| `psycho-genius` | 45% | All 5 | 30 | 0.15 | Deep research, complex multi-session projects |
| `brilliant` | 35% | sensory + episodes + concepts + skills | 20 | 0.30 | Default — balanced recall |
| `smart-efficient` | 25% | concepts + skills only | 10 | 0.50 | Lightweight tasks, cost-sensitive sessions |

`psycho-genius` also enables **speculative memory** (up to 10 items) — low-confidence candidates that might be relevant but didn't make the main cut. `smart-efficient` queries only the stable tiers, skipping sensory traces and episodes entirely for a faster, cheaper hot path.

Mode is set per-session via config and can be overridden at runtime by passing a mode hint in the request.

---

## Consolidation Pipeline

Consolidation is how USME converts raw observations (sensory traces) into durable knowledge (episodes → concepts → skills). It runs on two schedules:

### Mini-consolidation (every 30 minutes)
Runs Step 1 only: clusters recent sensory traces into episode summaries using Sonnet. Processes up to 100 traces per run. This keeps the episodic store fresh without the full overhead of a nightly job.

### Nightly consolidation (3am UTC, configurable)
Runs all 5 steps:

**Step 1 — Episodify**
Groups un-episodified sensory traces by session. Computes dynamic k (1 episode per ~15 traces, minimum 1). For each cluster, sends the traces to Sonnet with a summarization prompt and stores the resulting episode with a fresh embedding.

**Step 2 — Promote**
Finds recent episodes not yet analyzed for promotion. Sends them to Sonnet asking it to identify recurring facts, preferences, and decisions worth elevating to the concept layer. Each promoted concept gets a confidence score and is embedded immediately.

**Step 3 — Contradiction resolution**
Queries for concept pairs with pgvector distance < 0.10 (nearly identical embeddings, likely expressing conflicting statements). Sends each pair to Sonnet asking it to arbitrate. The loser is marked `is_active = false`; the winner's `supersedes_id` is updated.

**Step 4 — Skill drafting**
Finds high-utility episodes (score ≥ 0.6) not yet analyzed for skills. Sends them to Sonnet/Opus asking it to identify repeatable workflows and procedures. Each skill candidate gets a `teachability` score and is embedded. Candidates start with `status = 'candidate'` and require human promotion to `active`.

**Step 5 — Decay + prune**
Multiplies all episode and concept utility scores by `decayFactor` (default 0.95). Deletes sensory traces whose `expires_at` has passed. Skills are explicitly excluded from decay — a skill, once active, does not fade.

Each step is **idempotent** — safe to re-run if the job fails midway.

---

## Skill Distillation

Skill distillation is the flagship capability of USME.

The insight: if an agent repeatedly performs the same kind of task — debugging a specific system, deploying to a specific environment, following a specific workflow — the steps, gotchas, and decision points from those sessions contain everything needed to write a `SKILL.md` for that task. That skill can then be surfaced automatically in future sessions where the same task arises.

**How it works:**

1. During extraction, items tagged as `plan`, `decision`, or `fact` with high utility accumulate in sensory traces.
2. During episodification, related traces from the same session cluster into episode summaries capturing what happened.
3. During nightly consolidation, Sonnet/Opus analyzes high-utility episodes and identifies repeatable procedures. For each one, it generates:
   - A concise **name** (e.g. `deploy-usme-claw`, `debug-postgres-connection`)
   - A **description** of the procedure, with steps
   - A **teachability score** (0–10): how easily could another agent replicate this from the description alone?
4. Skills start as `candidate` status. A human reviews and promotes them to `active`.
5. Active skills are embedded and added to the retrieval index. The `skills` tier uses a scoring formula that heavily weights teachability and access frequency — the more useful a skill has proven, the more likely it is to surface.
6. When a future session involves a similar task, the skill is retrieved and prepended to the model's context — it effectively brings institutional memory into scope automatically.

**Tuning skill distillation:**
- `consolidation.candidatesPerNight`: max skills drafted per nightly run (default 5)
- `consolidation.skillDraftingModel`: which model drafts skill candidates (default Sonnet; Opus for higher quality)
- Episode `utility_score` threshold for skill candidacy is 0.6 (hardcoded in Step 4, tunable in code)
- Human review is required before a skill goes active — USME will never auto-promote to `active`

---

## Why USME over mem0

[mem0](https://github.com/mem0ai/mem0) is a good system. It solves a similar problem: intelligently compress conversation history into memory representations, then inject them into future prompts. Here's how they differ:

| Dimension | USME | mem0 |
|-----------|------|------|
| **Memory model** | Multi-tier (traces → episodes → concepts → skills → entities) with explicit tier semantics | Single-tier memory store |
| **Scoring** | Weighted formula: similarity + recency decay + provenance + access frequency, with tier-specific weights and half-lives | Similarity-based retrieval |
| **Skill distillation** | First-class: nightly job extracts repeatable procedures and writes SKILL.md candidates | Not present |
| **Decay** | Explicit per-tier half-lives; utility scores decay over time; ephemerals expire | Not documented |
| **Contradiction resolution** | Active: nightly job detects near-duplicate concepts, Sonnet arbitrates, loser is superseded | Not documented |
| **Storage** | Local Postgres + pgvector + TimescaleDB — fully self-hosted, no cloud dependency | Cloud hosted or self-hosted; multiple backends supported |
| **Context engine** | Drop-in replacement for LCM (OpenClaw contextEngine slot) — owns full context assembly | Inject-as-augmentation only |
| **Shadow mode** | Built-in: run alongside existing context engine with full comparison logging before going live | Not present |
| **Provenance** | Tracked per item: user, model, tool, file, web — feeds scoring | Not tracked |
| **Consolidation** | Full LLM-driven pipeline (Haiku extraction → Sonnet episodification → Sonnet promotion) | LLM-driven memory updates |
| **Assembly modes** | Three named modes with different tier subsets, token budgets, and score thresholds | Not applicable |
| **Openness** | Fully open-source, local-first | Open-source; hosted platform available |

**When to use mem0 instead:**
- You want a hosted, managed service with minimal ops
- You need multi-framework support (LangChain, LlamaIndex, etc.)
- You don't need skill distillation or multi-tier memory semantics
- You want a simpler integration path

**When USME is the right choice:**
- You want full control over what's in memory and why
- You want skill distillation — the agent gets durably better at repeated tasks
- You want a transparent, tunable scoring formula you can inspect and modify
- You're running OpenClaw and want a drop-in context engine replacement
- You want the full shadow mode evaluation workflow before committing to a switch

---

## How USME Works with LCM

LCM (Lossless Context Management, aka `lossless-claw`) and USME solve different but complementary problems:

| | LCM | USME |
|--|-----|------|
| **Question answered** | How do we fit conversation history into the context window? | What should the model know right now? |
| **Method** | Recency-based: protect fresh tail, fill remaining budget from newest items, compress rest | Relevance-based: ANN retrieval across multi-tier memory, weighted scoring, token-budget packing |
| **What it stores** | Conversation history as a DAG of summaries | Extracted facts, episodes, concepts, skills, entities |
| **Fresh tail** | Always included — last N messages never dropped | Not guaranteed — a recent low-relevance item may score below older high-relevance content |
| **Recall tooling** | `lcm_expand_query` for deep recall via sub-agent | Retrieval is automatic; no explicit recall call needed |

**Current architecture: USME augments LCM**

Right now, USME runs as a **transform plugin** — it appends a `<usme-context>` block to messages *after* LCM has assembled its context window. LCM owns the conversation history; USME adds semantic memory on top:

```
┌─────────────────────────────────────────────────────┐
│ System prompt                                       │
│   ┌─────────────────────────────────────────────┐  │
│   │ <usme-context>                              │  │  ← USME injects here
│   │ [high] Alex prefers TypeScript strict mode  │  │
│   │ [high] Decision: OpenAI embeddings only     │  │
│   │ [med]  USME has 216 sensory traces          │  │
│   │ </usme-context>                             │  │
│   └─────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│ Conversation history (LCM: fresh tail + summaries)  │
└─────────────────────────────────────────────────────┘
```

**Future: USME replaces LCM (contextEngine mode)**

USME is designed to eventually claim the `plugins.slots.contextEngine` slot — replacing LCM entirely. In that mode, USME would assemble the full context window: semantic memory injection + a recency floor (always include last N messages to preserve conversation continuity). The shadow mode evaluation workflow exists precisely to validate quality before making that switch.

The critical architectural difference to resolve for contextEngine mode: LCM's fresh-tail protection ensures recent messages are never dropped. USME's pure relevance scoring could (in theory) deprioritize a recent low-score message in favor of an older high-score one. The fix is a "recency floor" — always include the last N messages regardless of score, then fill remaining budget with scored items. This is designed but not yet implemented.

---

## Architecture

```
usme-claw/
├── packages/
│   ├── usme-core/                    # Core library — no OpenClaw dependency
│   │   └── src/
│   │       ├── assemble/
│   │       │   ├── index.ts          # Hot path orchestrator (retrieve→score→critic→pack)
│   │       │   ├── retrieve.ts       # Parallel ANN queries via pgvector (one per tier)
│   │       │   ├── score.ts          # Weighted scoring formula (tier-specific weights)
│   │       │   ├── critic.ts         # Rule-based filter (confidence, is_active, min score)
│   │       │   ├── pack.ts           # Greedy token-budget packing
│   │       │   └── modes.ts          # Mode profiles (psycho-genius / brilliant / smart-efficient)
│   │       ├── consolidate/
│   │       │   ├── nightly.ts        # 5-step nightly pipeline
│   │       │   └── scheduler.ts      # setTimeout-based cron + mini-consolidation interval
│   │       ├── db/
│   │       │   ├── pool.ts           # pg.Pool factory
│   │       │   ├── queries.ts        # All DB reads/writes (no ORM)
│   │       │   └── migrations/       # node-pg-migrate SQL files (001–008)
│   │       ├── embed/
│   │       │   └── index.ts          # embedText() + embedBatch() via OpenAI
│   │       ├── extract/
│   │       │   ├── extractor.ts      # Per-turn fact extraction (Haiku)
│   │       │   ├── entity-extractor.ts # Named entity extraction
│   │       │   ├── queue.ts          # In-process extraction queue
│   │       │   ├── utils.ts          # stripMetadataEnvelope, extractText helpers
│   │       │   └── prompts/
│   │       │       ├── fact-extraction-v1.ts  # Extraction prompt template
│   │       │       └── entity-extraction-v1.ts
│   │       └── schema/
│   │           └── types.ts          # TypeScript types for all 5 tiers
│   └── usme-openclaw/               # OpenClaw plugin adapter
│       └── src/
│           ├── index.ts              # Plugin entry point (before_prompt_build hook + scheduler init)
│           ├── shadow.ts             # Shadow mode harness + overlap scoring
│           ├── plugin.ts             # injectedToSystemAddition(), context formatting
│           └── config.ts             # Config schema, defaults, resolveConfig()
├── scripts/
│   ├── start-db.sh                  # Start Postgres Docker container
│   ├── stop-db.sh                   # Stop container
│   ├── db-init.sh                   # Run migrations
│   ├── shadow-report.ts             # Print shadow comparison stats
│   ├── shadow-tail.ts               # Tail live shadow log
│   ├── shadow-analyze.ts            # Deeper analysis of shadow comparisons
│   ├── dedup-corpus.ts              # Clean duplicate traces
│   └── usme-assess.mts              # Corpus quality assessment
├── docker-compose.yml               # Dev database (port 5432)
├── docker-compose.test.yml          # Test database (port 5433, tmpfs)
└── package.json                     # npm workspaces root
```

**Storage:** Postgres 16 + TimescaleDB (hypertables for episodic memory) + pgvector (HNSW indexes for ANN search). Single Docker container — `timescale/timescaledb-ha:pg16` bundles everything.

**Embeddings:** OpenAI `text-embedding-3-small` (1536 dimensions). Embeddings happen inline at insert time — no separate batch job, so every row is immediately searchable.

**Extraction:** `claude-haiku-4-5` — fast and cheap, fires after every turn. Uses a structured prompt that extracts into 7 categories (fact, preference, decision, plan, insight, anomaly, ephemeral) with provenance tagging and optional TTL.

**Consolidation:** `claude-sonnet-4-5` for episodification, promotion, and contradiction resolution. Sonnet or Opus for skill drafting (configurable). No LangChain, no orchestration framework — pure TypeScript with direct Anthropic SDK calls.

---

## Requirements

- Node.js ≥ 18
- Docker (for Postgres)
- OpenAI API key — embeddings (`text-embedding-3-small`)
- Anthropic API key — extraction (Haiku) and consolidation (Sonnet)

No cloud databases. No external vector stores. No remote dependencies in the storage layer. Everything runs locally.

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/alexspin/usme-claw.git
cd usme-claw
npm install
npm run build
```

### 2. Start the database

```bash
./scripts/start-db.sh
```

This starts a `timescale/timescaledb-ha:pg16` Docker container named `usme-db` on port 5432. The script is idempotent — it creates, starts, or restarts the container as needed, then polls until Postgres is ready.

Default credentials (override via `DATABASE_URL`):
```
host:     localhost
port:     5432
database: usme
user:     usme
password: usme_dev
```

### 3. Run migrations

```bash
./scripts/db-init.sh
```

Applies all 8 migrations in `packages/usme-core/src/db/migrations/`. Creates tables, HNSW indexes, shadow comparison table, and unique constraints.

Or with a custom database URL:
```bash
DATABASE_URL=postgres://usme:secret@localhost:5432/usme ./scripts/db-init.sh
```

### 4. Set environment variables

```bash
export OPENAI_API_KEY=sk-...           # Required: embeddings
export ANTHROPIC_API_KEY=sk-ant-...    # Required: extraction + consolidation
```

### 5. Build

```bash
npm run build
```

TypeScript compilation for all packages. Output goes to `dist/` in each package.

### 6. Verify

```bash
# Check shadow log (requires OpenClaw integration to be running)
npx tsx scripts/shadow-tail.ts

# Check corpus stats
npx tsx scripts/usme-assess.mts
```

---

## OpenClaw Integration

USME ships as an OpenClaw plugin. It hooks into the `before_prompt_build` event to run assembly and extraction on every turn.

### openclaw.json config

Add to your `plugins` section:

```json
{
  "plugins": {
    "allow": ["usme-claw"],
    "load": {
      "paths": [
        "/path/to/usme-claw/packages/usme-openclaw"
      ]
    },
    "entries": {
      "usme-claw": {
        "enabled": true,
        "config": {
          "mode": "shadow",
          "db": {
            "host": "localhost",
            "port": 5432,
            "database": "usme",
            "user": "usme",
            "password": "usme_dev"
          }
        }
      }
    }
  }
}
```

### Plugin modes

| Mode | Behaviour |
|------|-----------|
| `shadow` | Full pipeline runs; output is logged but not injected. LCM continues as context engine. Use this to evaluate quality before going live. |
| `active` | USME appends `<usme-context>` block to every turn's system prompt addition. LCM continues to own conversation history. |
| `disabled` | No hooks registered. Plugin is a no-op. |

### What the injection looks like (active mode)

```
<usme-context>
[high] Alex prefers TypeScript with strict mode. (concepts · score: 0.89)
[high] Decision: keep OpenAI embeddings throughout, not Anthropic. (concepts · score: 0.81)
[med]  USME consolidation runs every 30 min (mini) and 3am UTC (full). (episodes · score: 0.72)
[med]  deploy-usme-claw: build → restart gateway → check shadow log. (skills · score: 0.68)
</usme-context>
```

Score buckets: `≥0.75` → `[high]`, `≥0.50` → `[med]`, below → `[low]`.

### Going live

1. Run in `shadow` mode for at least a few days to accumulate corpus and validate retrieval quality.
2. Check shadow comparison stats: `npx tsx scripts/shadow-report.ts`
3. Confirm top-N retrieved items look relevant in the shadow log: `/tmp/usme-debug/shadow.log`
4. Change `"mode": "shadow"` to `"mode": "active"` in `openclaw.json`.
5. Restart OpenClaw.

---

## Tuning

### Assembly weights

The scoring formula weights are defined in `packages/usme-core/src/assemble/score.ts`. Edit directly to tune:

```typescript
const DEFAULT_WEIGHTS = {
  similarity: 0.40,  // Semantic relevance to current query
  recency: 0.25,     // How fresh the item is
  provenance: 0.20,  // Source reliability
  accessFreq: 0.15,  // Historical usage frequency
};
```

### Recency half-lives

Adjust how quickly each tier fades in `score.ts`:

```typescript
const HALF_LIFE_DAYS: Record<MemoryTier, number> = {
  sensory_trace: 1,    // Raw facts fade in 1 day
  episodes: 7,         // Session summaries persist a week
  concepts: 90,        // Stable facts last 3 months
  skills: Infinity,    // Skills never decay
  entities: 30,        // Named references last a month
};
```

### Assembly mode thresholds

In `packages/usme-core/src/assemble/modes.ts`, each mode has:
- `tokenBudgetFraction`: fraction of total token budget USME can claim
- `minInclusionScore`: minimum score for an item to make it into context
- `minConfidence`: critic filter threshold
- `candidatesPerTier`: how many candidates to retrieve per tier before scoring

### Consolidation config

Via `openclaw.json` plugin config:

```json
{
  "consolidation": {
    "cron": "0 3 * * *",
    "sonnetModel": "claude-sonnet-4-5",
    "skillDraftingModel": "claude-sonnet-4-5",
    "candidatesPerNight": 5
  }
}
```

Set `skillDraftingModel` to `claude-opus-4-5` for higher-quality skill candidates at the cost of more API spend.

### Extraction config

```json
{
  "extraction": {
    "enabled": true,
    "model": "claude-haiku-4-5"
  }
}
```

Swap to `claude-haiku-4-5-20251001` or a faster/cheaper model if extraction latency is a concern.

### Decay factor

In plugin config:

```json
{
  "consolidation": {
    "decayFactor": 0.95,
    "minUtilityScore": 0.01
  }
}
```

`decayFactor` of 0.95 means a concept loses 5% of its utility score per nightly run. At that rate, a concept at score 1.0 reaches the pruning floor (`minUtilityScore`) after ~90 days without being accessed. Reduce decay factor to make concepts persist longer; increase to make them fade faster.

---

## Observability

### Debug logs

When the plugin is running, debug logs are written to `/tmp/usme-debug/`:

| File | Contents |
|------|----------|
| `shadow.log` | Per-turn assembly: query, items selected, overlap score vs LCM |
| `extractor.log` | Per-turn extraction: what Haiku returned, dedup decisions, insert results |
| `queries.log` | DB query timing and row counts |

### Shadow comparison stats

```bash
npx tsx scripts/shadow-report.ts
```

Prints: total comparisons, hit rate (% of turns with any USME results), mean overlap score with LCM, latency distribution.

### Live tail

```bash
npx tsx scripts/shadow-tail.ts
```

Streams the shadow log in real time — useful for watching extraction and retrieval happen during an active session.

### Corpus assessment

```bash
npx tsx scripts/usme-assess.mts
```

Prints: tier row counts, embedding coverage, top tags, utility distribution, traces pending episodification.

### Direct DB queries

```bash
# Connect to the running container
docker exec -it usme-db psql -U usme -d usme

# Tier counts
SELECT 'sensory_trace' AS tier, COUNT(*) FROM sensory_trace
UNION ALL SELECT 'episodes', COUNT(*) FROM episodes
UNION ALL SELECT 'concepts', COUNT(*) FROM concepts
UNION ALL SELECT 'skills', COUNT(*) FROM skills
UNION ALL SELECT 'entities', COUNT(*) FROM entities;

# Recent extractions
SELECT session_id, turn_index, memory_type, utility_prior, content
FROM sensory_trace ORDER BY created_at DESC LIMIT 20;

# Active concepts
SELECT content, confidence, utility_score, access_count
FROM concepts WHERE is_active = true ORDER BY utility_score DESC;

# Skill candidates awaiting promotion
SELECT name, description, teachability FROM skills WHERE status = 'candidate';
```

---

## TODO and Future Work

### Immediate (before going live)

- [ ] **Relevance analysis job** — score shadow comparisons against ground truth; `relevance_analysis_done = false` for all rows currently
- [ ] **Model output extraction wiring** — currently only user messages and system events are extracted; assistant responses contain high-value analysis that should also feed the corpus
- [ ] **Active mode end-to-end test** — verify `<usme-context>` block is visible to the model in a real session
- [ ] **Skill promotion workflow** — UI or CLI to review `candidate` skills and promote to `active`
- [ ] **Entity extraction integration** — entity extractor is built but not wired into the main extraction queue
- [ ] **Recency floor for contextEngine mode** — always include last N messages regardless of score, to preserve conversation continuity

### Short-term (v1 stabilization)

- [ ] **Corpus quality dashboard** — extend rufus-plugin dashboard with USME-specific views: tier sizes, top concepts, recent skills, shadow comparison trends
- [ ] **Dedup at query time** — currently dedup happens at insert (cosine > 0.95); also add at retrieval to avoid redundant items in packed context
- [ ] **Access count increment on retrieval** — currently read-only hot path never updates `access_count`; add async access tracking
- [ ] **`.env.example`** — document required environment variables in a template file
- [ ] **Consolidate docker-compose.yml and start-db.sh** — currently two parallel ways to start the DB; pick one canonical path
- [ ] **Integration test suite** — test extraction → consolidation → retrieval round-trip against the test DB

### Medium-term (v2)

- [ ] **pgvectorscale DiskANN indexes** — upgrade from HNSW for large collections (>100k rows); pgvectorscale claims 28x lower P95 latency than Pinecone at scale
- [ ] **TimescaleDB hypertables** — episodic store is currently a standard table; migrate to hypertable partitioned by `created_at` for better time-range query performance and automatic chunking
- [ ] **TimescaleDB continuous aggregates** — automated temporal roll-ups for episodic memory (weekly, monthly summaries without full re-scan)
- [ ] **Hybrid search** — combine pgvector ANN with Postgres `tsvector` full-text search; blend vector score with BM25 score before passing to scoring formula
- [ ] **Memory audit UI** — `/rufus/memory` page showing what's in context on any given turn, with per-item score breakdowns

### Long-term (v3+)

- [ ] **Learning hooks** — feedback signal collection (which retrieved items were actually useful?), OPE/DR evaluation harness, formula weight update from evaluation results
- [ ] **Multi-user memory isolation** — permissions layer (separate episodic stores per user, shared concept layer for global facts)
- [ ] **Adam's agent integration** — cross-agent concept sharing (Adam's agent can benefit from facts accumulated in Rufus's sessions, and vice versa)
- [ ] **ClawHub skill publishing pipeline** — export promoted skills as SKILL.md bundles, publish to ClawHub for community reuse
- [ ] **Graph entity linking** — evaluate Neo4j or Memgraph for richer concept-entity relationships vs current JSONB links
- [ ] **Export/import** — memory portability across instances (backup + restore, cross-device sync)
- [ ] **Benchmark harness** — compare USME vs LCM on a held-out eval set with defined ground truth

### Icebox

- [ ] Fast refiner (Flash/Haiku) in hot path — condense packed context further before injection
- [ ] Speculative memory review — audit whether `psycho-genius` speculative items (low-confidence) actually help or hurt
- [ ] Memory "forget" tooling — ability to manually mark items as `is_active = false` or delete traces
- [ ] Online RL / bandit-based policy learning (v3+)

---

## Design Tenets

These are the principles that guide decisions when data is unavailable. They don't change without stepping back and revisiting explicitly.

**Curation over compression**
The right question is "what should the model know right now?" not "how do we fit everything in?" A brain that selects beats a filing cabinet that shrinks.

**Formula before learning**
Build a tunable, transparent scoring formula before building a learning system. You can't improve what you can't inspect. Ship deterministic first, then layer in feedback.

**Editorial, not adversarial**
The memory critic is a curating editor, not a security guard (in single-user context). Protect quality by asking "is this still true and relevant?" — not by assuming bad intent.

**Local services only**
No cloud databases, no remote vector stores, no external API dependencies in the storage layer. Local Postgres (Docker) is acceptable and appropriate. Remote services require explicit justification. Ops complexity is a real cost — but the right local stack pays for itself immediately.

**Skill distillation is the pitch**
The capability that justifies USME to a user or investor is skill distillation — the agent gets durably better at things it does often, automatically, without anyone writing a skill by hand. Everything else is infrastructure. This is the demo.

---

## License

MIT
