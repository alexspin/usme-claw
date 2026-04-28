# USME Architecture

**Status:** design draft — directional  
**Last updated:** 2026-04-04  
**Stage:** DESIGN (pre-build)  
**Owner:** Rufus / Alex

---

## How to Read This Document

This document is **directional**. It defines what the system must do, proposes likely approaches, identifies where we have genuine options, and marks open questions clearly. The build swarm is expected to evaluate the options, debate tradeoffs, and make final implementation decisions — especially on schema, selection formula tuning, and prompt design. Nothing here is frozen unless explicitly marked **LOCKED**.

Conventions:
- **LOCKED** — this decision is made; don't revisit without flagging
- **DIRECTIONAL** — preferred approach; swarm should evaluate before committing
- **OPEN** — we have options; swarm should benchmark, debate, and decide
- `[⚡ Swarm: evaluate X vs Y]` — a concrete decision the swarm should surface

---

## 1. System Overview

USME is a **context engine** — not a chat history store. Its job is to answer one question every turn:

> *"Given what this agent knows, what should go into the context window right now to maximize the quality of the next response?"*

This is a different job than LCM (lossless-claw), which preserves and compresses history. USME selects and assembles by relevance.

### Two planes

```
┌───────────────────────────────────────────────────────────────────┐
│  HOT PATH  (per-turn, <150ms P95)                                 │
│                                                                   │
│  turn arrives → assemble(query, budget, mode)                     │
│             ↓                                                     │
│  [retrieve candidates from all memory tiers]                      │
│             ↓                                                     │
│  [score: semantic + recency + provenance + access_frequency]      │
│             ↓                                                     │
│  [critic gate: filter low-quality / injection-risk]               │
│             ↓                                                     │
│  [pack into token budget: tight | extended | ephemeral]           │
│             ↓                                                     │
│  return { messages[], systemPromptAddition, estimatedTokens }     │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│  ASYNC PATH  (fires after turn completes, non-blocking)           │
│                                                                   │
│  response delivered → enqueue extraction job                      │
│             ↓                                                     │
│  [Haiku/Flash: extract typed items from completed turn]           │
│             ↓                                                     │
│  [write to sensory_trace table]                                   │
│             ↓                                                     │
│  [update entity graph: extract named entities + relationships]    │
└───────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────┐
│  NIGHTLY JOB  (cron, quality-critical, 2-10 min estimated)        │
│                                                                   │
│  [Step 1] cluster sensory traces → episode summaries (Sonnet)     │
│  [Step 2] identify recurring patterns → concept promotion (Sonnet)│
│  [Step 3] contradiction resolution + entity update (Sonnet)       │
│  [Step 4] rank skill candidates → draft SKILL.md (Sonnet/Opus)   │
│  [Step 5] decay utility scores + prune expired sensory traces     │
└───────────────────────────────────────────────────────────────────┘
```

**LOCKED:** These three planes are the architecture. They do not overlap. The hot path never writes to the DB. The nightly job never runs during a turn.

---

## 2. Storage

### 2.1 Stack

**LOCKED:** Postgres 16 + TimescaleDB + pgvector, running local Docker. One service, one port. `node-postgres` (`pg`) driver with connection pooling.

```yaml
# docker-compose.yml (directional — swarm can tune versions and settings)
services:
  db:
    image: timescale/timescaledb-ha:pg16
    # timescaledb-ha bundles: TimescaleDB + pgvector + pgvectorscale + pg_partman
    # Verify: does this image include pgvector out of the box? [⚡ Swarm: confirm]
    environment:
      POSTGRES_DB: usme
      POSTGRES_USER: usme
      POSTGRES_PASSWORD: usme_dev
    ports:
      - "5432:5432"
    volumes:
      - usme_data:/var/lib/postgresql/data
```

**OPEN:** `timescaledb-ha` vs `timescale/timescaledb` — the HA image includes pgvector/pgvectorscale bundled. Swarm should verify the image includes what we need vs assembling extensions manually. The bundled path is strongly preferred.

### 2.2 Schema Design

The schema must be designed from day one for TimescaleDB. The episodic table is a hypertable — `created_at` must be the partition column. This is not optional.

**Guiding principles:**
- Every table that grows unboundedly needs a retention / TTL strategy from day one
- Utility scoring lives on the item; the selection policy reads it, the nightly job updates it
- Provenance is not optional — every row must know where it came from
- JSONB for metadata; do not pre-schema fields that will evolve
- The entity graph is two tables (entities + entity_relationships) inside Postgres — no separate service

#### Core tables (directional — swarm evaluates and finalizes)

```sql
-- ─────────────────────────────────────────────────────────
-- Extensions (run once at init)
-- ─────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector
CREATE EXTENSION IF NOT EXISTS timescaledb;   -- TimescaleDB

-- ─────────────────────────────────────────────────────────
-- sensory_trace
-- Raw content + extracted items from each turn.
-- Short-lived: TTL 30 days (configurable).
-- ─────────────────────────────────────────────────────────
CREATE TABLE sensory_trace (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  item_type       TEXT        NOT NULL,  -- verbatim | extracted
  memory_type     TEXT,                  -- fact | preference | decision | plan | anomaly | ephemeral | null (for verbatim)
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  provenance_kind TEXT        NOT NULL,  -- user | tool | model | web | file
  provenance_ref  TEXT,                  -- session_id:turn_index, url, file path, etc.
  utility_prior   TEXT        DEFAULT 'medium', -- high | medium | low | discard
  tags            TEXT[]      DEFAULT '{}',
  extractor_ver   TEXT,                  -- prompt version that generated this item
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ            -- set at insert: now() + TTL
);

-- TTL index: nightly job deletes where expires_at < now()
CREATE INDEX ON sensory_trace (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX ON sensory_trace (session_id, turn_index);
CREATE INDEX ON sensory_trace USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

-- [⚡ Swarm: evaluate] Should sensory_trace be a TimescaleDB hypertable?
-- Pro: automatic time-partitioning makes TTL pruning faster at scale
-- Con: adds complexity, and sensory_trace is short-lived anyway
-- Recommendation to evaluate: probably not needed for v1 scale, but design should not block it

-- ─────────────────────────────────────────────────────────
-- episodes (TimescaleDB hypertable)
-- Nightly-compressed summaries of sensory trace clusters.
-- Time-partitioned: queries like "last 7 days of episodes" are first-class.
-- ─────────────────────────────────────────────────────────
CREATE TABLE episodes (
  id              UUID        DEFAULT gen_random_uuid(),
  session_ids     TEXT[]      NOT NULL,  -- sessions this episode spans
  time_bucket     TIMESTAMPTZ NOT NULL,  -- TimescaleDB time_bucket anchor
  summary         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  source_trace_ids UUID[]     NOT NULL,  -- sensory_trace rows this was built from
  token_count     INTEGER,
  utility_score   FLOAT       DEFAULT 0.5,
  access_count    INTEGER     DEFAULT 0,
  last_accessed   TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, created_at)  -- TimescaleDB requires partition col in PK
);

SELECT create_hypertable('episodes', 'created_at', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX ON episodes USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX ON episodes (time_bucket DESC);

-- [⚡ Swarm: evaluate] chunk_time_interval — 7 days is a guess.
-- With active daily use, 7-day chunks seem right.
-- Consider: continuous aggregate from episodes → weekly_summaries for long-term recall?

-- ─────────────────────────────────────────────────────────
-- concepts
-- Stable facts, preferences, decisions, persistent knowledge.
-- Indefinite lifetime. Updated/superseded, never hard-deleted (soft delete only).
-- ─────────────────────────────────────────────────────────
CREATE TABLE concepts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_type    TEXT        NOT NULL,  -- fact | preference | decision | relationship_summary
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  utility_score   FLOAT       DEFAULT 0.5,
  provenance_kind TEXT        NOT NULL,
  provenance_ref  TEXT,
  confidence      FLOAT       DEFAULT 1.0, -- decremented by contradiction evidence
  access_count    INTEGER     DEFAULT 0,
  last_accessed   TIMESTAMPTZ,
  supersedes_id   UUID        REFERENCES concepts(id),  -- chain of supersession
  superseded_by   UUID        REFERENCES concepts(id),
  is_active       BOOLEAN     DEFAULT true,  -- false = soft-deleted / superseded
  tags            TEXT[]      DEFAULT '{}',
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON concepts USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND is_active = true;
CREATE INDEX ON concepts (concept_type, is_active, utility_score DESC);

-- [⚡ Swarm: evaluate] Soft-delete vs hard delete for superseded concepts.
-- Keeping superseded rows gives us an audit trail and lets us undo mistakes.
-- Cost: table grows unboundedly. Mitigation: periodic archival job (v2).
-- Recommendation: soft delete in v1; revisit if table size becomes a concern.

-- ─────────────────────────────────────────────────────────
-- skills
-- Registry of skills known to USME. Points to file on disk.
-- The SKILL.md itself lives in ~/.openclaw/skills/[candidates|active]/
-- ─────────────────────────────────────────────────────────
CREATE TABLE skills (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL UNIQUE,
  description     TEXT,
  embedding       VECTOR(1536),  -- for "which skills are relevant to this turn?"
  status          TEXT        DEFAULT 'candidate',  -- candidate | active | retired
  skill_path      TEXT        NOT NULL,  -- relative path to SKILL.md file
  source_episode_ids UUID[]   DEFAULT '{}',  -- episodes that generated this skill
  teachability    FLOAT,      -- Sonnet-estimated teachability score (0-10)
  use_count       INTEGER     DEFAULT 0,
  last_used       TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON skills USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND status = 'active';
CREATE INDEX ON skills (status, teachability DESC);

-- ─────────────────────────────────────────────────────────
-- entities
-- Named things: people, orgs, projects, tools, concepts.
-- Deduplication via canonical name + embedding similarity.
-- ─────────────────────────────────────────────────────────
CREATE TABLE entities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL,  -- person | org | project | tool | location | concept
  canonical       TEXT,                  -- normalized/lowercased for dedup
  embedding       VECTOR(1536),
  confidence      FLOAT       DEFAULT 1.0,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON entities USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX ON entities (canonical);

-- ─────────────────────────────────────────────────────────
-- entity_relationships
-- Directed edges between entities.
-- Temporal validity: valid_until NULL = still active.
-- Supersession: set valid_until on old row, insert new row.
-- ─────────────────────────────────────────────────────────
CREATE TABLE entity_relationships (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID        NOT NULL REFERENCES entities(id),
  target_id       UUID        NOT NULL REFERENCES entities(id),
  relationship    TEXT        NOT NULL,  -- works_at | knows | manages | is_a | owns | uses | part_of | related_to
  confidence      FLOAT       DEFAULT 1.0,
  source_item_id  UUID,                  -- sensory_trace or concept that sourced this
  valid_from      TIMESTAMPTZ DEFAULT now(),
  valid_until     TIMESTAMPTZ,           -- NULL = currently valid
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON entity_relationships (source_id, valid_until NULLS LAST);
CREATE INDEX ON entity_relationships (target_id, valid_until NULLS LAST);
CREATE INDEX ON entity_relationships (relationship, valid_until NULLS LAST);

-- [⚡ Swarm: evaluate] Multi-hop traversal.
-- 1-hop and 2-hop are straightforward SQL joins.
-- 3+ hop requires WITH RECURSIVE. For a personal assistant, is depth-2 enough for v1?
-- Recommendation to evaluate: implement depth-1/2 lookups first; add recursive CTE only if there's a demonstrated use case.
```

#### Migration tooling

**DIRECTIONAL:** `node-pg-migrate`. Migrations live in `db/migrations/`. Each migration is reversible. The swarm should evaluate `node-pg-migrate` vs `kysely-migration` vs `drizzle-kit` — all are viable. Criterion: must work with raw SQL (not just ORM-generated DDL), because TimescaleDB and pgvector DDL is not supported by most ORMs.

---

## 3. Hot Path: `assemble()`

**LOCKED:** The hot path must be synchronous from the caller's perspective, non-blocking in practice, and complete in P95 ≤150ms. It never writes to the database.

### 3.1 API contract

```typescript
// DIRECTIONAL — exact types may evolve

interface AssembleRequest {
  query: string;              // the current turn's user message
  sessionId: string;
  conversationHistory: Message[];  // recent in-context messages (already in model's window)
  mode: 'tight' | 'extended';     // tight = minimal additions; extended = richer context
  tokenBudget: number;            // tokens available for memory injection
  turnIndex: number;
}

interface AssembleResponse {
  systemPromptAddition: string | null;   // prepended to system prompt (e.g., active skills)
  injectedContext: InjectedMemory[];     // ordered list of memory items to inject
  estimatedTokens: number;
  metadata: {
    itemsConsidered: number;
    itemsSelected: number;
    tiersContributed: MemoryTier[];      // which tiers contributed items
    selectionPolicyVersion: string;
    assemblyDurationMs: number;
  };
}

interface InjectedMemory {
  id: string;
  tier: 'episode' | 'concept' | 'skill' | 'entity_context';
  content: string;
  score: number;        // final ranked score (0-1)
  tokenCount: number;
}
```

**OPEN:** Should `assemble()` return a ready-to-use `messages[]` array (like LCM does) or a more structured `InjectedMemory[]` + `systemPromptAddition` that the OpenClaw adapter assembles into messages? The structured form gives the adapter more flexibility. The flat form is a simpler drop-in replacement.

`[⚡ Swarm: evaluate]` — understand what the `contextEngine` slot contract expects from LCM today before locking the return type.

### 3.2 Retrieval strategy

The hot path retrieves candidates from three tiers in parallel, then merges and scores:

```
┌──────────────────────────┐  ┌──────────────────────────┐  ┌──────────────────────────┐
│  episodes                │  │  concepts                 │  │  skills                   │
│  pgvector ANN search     │  │  pgvector ANN search      │  │  pgvector ANN search      │
│  top-K by similarity     │  │  + full-text tsvector     │  │  status = 'active' only   │
│  within last N days      │  │  hybrid re-rank           │  │                           │
└──────────────┬───────────┘  └──────────────┬────────────┘  └──────────────┬────────────┘
               └─────────────────────────────┴───────────────────────────────┘
                                             ↓
                                    merge candidate pool
                                             ↓
                                  score each candidate
                                   (formula in §3.3)
                                             ↓
                                     critic filter
                                             ↓
                              greedy token budget packing
```

**DIRECTIONAL:** Parallel retrieval via Promise.all across the three queries. Timeout each retrieval at 80ms individually; if one times out, exclude that tier's results rather than failing the whole assembly.

`[⚡ Swarm: evaluate]` — K for ANN search. Starting guess: top-20 per tier before scoring, then score+pack to budget. Too small = misses; too large = scoring overhead. Benchmark against real session data.

**OPEN:** Entity graph enrichment on the hot path. Options:
1. **Skip entities in hot path entirely** — entities get injected by the extraction pipeline and surfaced as concepts; no entity-specific hot-path logic
2. **Lightweight entity mention detection** — extract entity mentions from query, do 1-hop lookup, inject relevant relationships as a short context block
3. **Entity context block** — always add a "things relevant to this conversation" block from entity graph

Option 2 is probably right but adds latency. Option 1 is safe for v1. `[⚡ Swarm: evaluate]` given the 150ms budget, what's the P95 cost of a 1-hop entity lookup?

### 3.3 Selection policy (scoring formula)

**LOCKED:** The selection policy for v1 is a weighted formula. RL bandit is v2.

**DIRECTIONAL formula:**

```
score(item) = w_sim * similarity(item.embedding, query.embedding)
            + w_rec * recency_decay(item.created_at, now(), half_life)
            + w_pro * provenance_tier_score(item.provenance_kind)
            + w_acc * access_frequency_score(item.access_count, item.last_accessed)
```

**Proposed initial weights and functions (OPEN — swarm should validate):**

```typescript
// Starting point. Treat these as hypotheses, not truths.
const WEIGHTS = {
  similarity:  0.40,
  recency:     0.25,
  provenance:  0.20,
  access_freq: 0.15,
};

// Recency decay: exponential with configurable half-life per tier
// episodes: half_life = 7 days  (recent episodes matter most)
// concepts: half_life = 90 days (stable facts decay slowly)
// skills:   half_life = ∞       (skills don't decay; access_count drives their score)
function recency_decay(created_at: Date, now: Date, half_life_days: number): number {
  const age_days = (now.getTime() - created_at.getTime()) / 86_400_000;
  return Math.pow(0.5, age_days / half_life_days);
}

// Provenance tier: explicit > inferred > tool_output > model_generated
const PROVENANCE_SCORES = {
  user:       1.0,   // user said it explicitly
  tool:       0.85,  // came from a tool result
  web:        0.70,  // fetched from external source
  file:       0.75,  // read from a file
  model:      0.60,  // model-generated / inferred
};

// Access frequency: log-scaled to prevent runaway dominance
function access_frequency_score(access_count: number, last_accessed: Date | null): number {
  if (!last_accessed) return 0;
  const recency_bonus = recency_decay(last_accessed, new Date(), 14);
  return Math.min(1.0, Math.log(1 + access_count) / Math.log(50)) * recency_bonus;
}
```

`[⚡ Swarm: evaluate]` — These weights are the first thing to benchmark once we have real session data in shadow mode. The similarity weight being highest (0.40) reflects a strong prior that semantic match is the best signal. The swarm should consider: is this right for skills? Skills are often relevant even when not semantically similar to the query (e.g., a coding skill is relevant for any coding turn). Should skills use a different formula or tier-specific weights?

**DIRECTIONAL:** Implement a weight configuration object stored in the DB (or a config file) so weights can be tuned without code changes.

### 3.4 Critic gate

The critic is a **filter**, not a scorer. It runs after scoring, before packing. Items that fail the critic are excluded regardless of score.

**Mandatory critic rules (LOCKED):**
- Discard items where `utility_prior = 'discard'`
- Discard items where `confidence < 0.3`
- Discard items marked `is_active = false` (soft-deleted concepts)

**Soft critic rules (DIRECTIONAL):**
- Flag items with duplicate semantic content already in the window (cosine distance < 0.05 to an already-selected item) — prefer the higher-scored version
- Flag items from model provenance with confidence < 0.6

**OPEN:** Should the critic be a set of rules (fast, deterministic) or should it call a model to evaluate candidates? The answer for v1 is clearly rules — the hot path budget doesn't allow a model call. But worth naming: a model-based critic is architecturally possible in the async path, not the hot path.

### 3.5 Token budget packing

```typescript
// DIRECTIONAL — greedy packing is probably right for v1
// [⚡ Swarm: evaluate] knapsack vs greedy; at K~60 items, greedy is fast enough and close-enough-optimal

function pack(candidates: ScoredItem[], budget: number): InjectedMemory[] {
  const selected: InjectedMemory[] = [];
  let remaining = budget;
  
  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);
  
  for (const item of candidates) {
    if (item.tokenCount <= remaining) {
      selected.push(item);
      remaining -= item.tokenCount;
    }
    // Don't break on first skip — smaller items might still fit
    // [⚡ Swarm: evaluate] at what K does this become too slow? Consider a smarter stopping condition.
  }
  
  return selected;
}
```

**Mode differences — see §3.5 for full mode specifications.**

`[⚡ Swarm: decide]` whether `mode` should be caller-provided, user-configurable, or auto-detected from conversation context (e.g., infer from available token headroom + session state).

---

## 3.5 Context Assembly Modes

USME supports three named modes with distinct philosophies for how much context to include and how aggressively to select. These modes affect token budget, selection score thresholds, recall depth, tier weights, sliding window size, and the treatment of uncertain or low-confidence items. The names are intentional — they communicate the tradeoff to users clearly.

### The three modes

**`psycho-genius`** — Include everything with signal. Skew inclusive when uncertain.
> *"I'd rather give the model too much relevant context than miss something important. Tokens are cheap compared to a wrong answer."*

- Maximises token budget (large fraction of available window)
- Low inclusion threshold — if it might be relevant, include it
- Deep recall across all tiers
- Speculative / low-confidence items included with provenance markers
- All tier contributions maximised; no tier starved
- Sliding window: longer current session history
- For: long research sessions, complex multi-topic conversations, creative work, anything where missing context is costly

**`brilliant`** — The standard mode. Highly relevant context, well-selected.
> *"Include what's genuinely useful. Don't pad. Don't miss the important things."*

- Balanced token budget (the default split)
- Moderate inclusion threshold — items must clear a relevance bar
- Standard recall depth
- Low-confidence items excluded unless provenance is strong
- Tier contributions balanced by relevance score
- Sliding window: last N turns (default)
- For: most conversations, day-to-day assistant use, the mode users get by default

**`smart-efficient`** — Minimal context. Only what is absolutely critical.
> *"Every token in context should earn its place. If it's not clearly needed, leave it out."*

- Small token budget
- High inclusion threshold — only high-confidence, high-utility, high-similarity items
- Shallow recall depth
- Speculative and low-confidence items excluded
- Tier contributions: skills and concepts only (skip episodes unless very high score)
- Sliding window: shorter, recent turns only
- For: API/embedded use, latency-sensitive deployments, long-running sessions with depleted budgets, subagent contexts, cost-constrained environments

### Design requirements — for the swarm

The mode system must be:

**Tunable.** Each mode is a named configuration profile, not hardcoded constants. All thresholds, budget fractions, tier weights, and recall depths are configurable per mode. Operators can override defaults for their deployment. Example: a deployment running expensive models may want a tighter `brilliant` mode by default.

**Extensible.** Custom modes must be supported without forking. A mode is a named set of assembly parameters; adding a fourth mode (`ultra-lean`, `deep-research`, `skill-focused`) should require no code changes — only configuration.

**Observable.** Every assembly must log which mode was used, how many candidates were considered per tier, how many were selected, and the effective token budget. Shadow mode comparisons should include mode-level breakdowns.

**Composable with session history.** Mode affects not just cross-session memory selection but also the sliding window size for current session history. `psycho-genius` carries more session history; `smart-efficient` carries less. The budget arithmetic (§6.4) must reflect this — mode drives the split, not just the thresholds.

**Auto-detectable (optional, v2 or swarm decides).** The mode could be inferred rather than configured: detect available token headroom, session age and size, and conversation topic complexity, then select the appropriate mode automatically. This is an open decision — the swarm should evaluate whether auto-detection is worth the complexity or whether explicit user control is simpler and more predictable.

### Open design questions — for the swarm

`[⚡ Swarm: design]` **The core question:** How do the selection algorithm parameters actually differ across modes? The swarm must design the per-mode parameter sets. Questions to answer:

- What is the right inclusion score threshold for each mode? (The formula in §3.3 produces a 0–1 score. What cutoff separates "include" from "exclude" in each mode?)
- How deep is "deep recall" vs. "shallow recall"? (Candidates per tier? Top-K before scoring? ANN search parameters?)
- How does `psycho-genius` handle the tension between "include everything with signal" and the token budget cap — what gets sacrificed when over budget?
- Should tier weights change per mode, or only the inclusion threshold? (e.g., should `smart-efficient` skip the episodes tier entirely below a high-confidence threshold, or just set a higher bar?)
- What is the right sliding window size for each mode (in turns and tokens)?
- How does mode interact with the budget split (§6.4)? Should the split ratio be fixed per mode, or derived from how much cross-session material is actually available?

`[⚡ Swarm: research]` **Competitive patterns (competitive intelligence agent).** Before designing the algorithms, the competitive intelligence agent should survey how existing systems handle tiered retrieval aggressiveness:
- Mem0, LangMem, Zep, MemGPT/Cognee — do any expose retrieval depth or inclusion threshold knobs?
- RAG systems (LlamaIndex, LangChain retrievers) — how do they handle recall depth vs. precision tradeoffs?
- Search systems — how do precision-at-K vs. recall tradeoffs translate to context assembly?
- Use patterns as inspiration; do not reuse code. The goal is to understand what has been proven to work at the algorithm level, then design USME's approach independently.

`[⚡ Swarm: decide]` **Mode selection UX.** How does a user or operator select a mode?
- Config default (`assembly.defaultMode: brilliant`)
- Per-session override (`/usme mode psycho-genius`)
- Per-turn hint (inline directive)
- Programmatic (passed in `assemble()` params by the OpenClaw adapter)
- Auto-detected (inferred from context)
All of the above could be layered — swarm should propose a precedence order.

`[⚡ Swarm: decide]` **Naming in the config and interface.** `psycho-genius` | `brilliant` | `smart-efficient` are the user-facing names. The internal enum can match or alias. Swarm should decide on the internal identifier (`PSYCHO_GENIUS` | `psycho_genius` | `psycho-genius` etc.) and whether the display names are localizable.

### Config surface (DIRECTIONAL — swarm to finalise)

```typescript
// Each mode is a named profile — all fields overridable
interface AssemblyModeProfile {
  // Token budget
  tokenBudgetFraction: number;          // fraction of available tokens for cross-session memory
  sessionHistoryFraction: number;       // fraction for current session history

  // Inclusion thresholds
  minInclusionScore: number;            // 0-1; items below this score are excluded
  minConfidence: number;                // minimum provenance confidence to include

  // Recall depth
  candidatesPerTier: number;            // how many candidates to retrieve per memory tier
  annSearchK: number;                   // ANN search parameter (pgvector ef_search equivalent)

  // Tier participation
  tiersEnabled: ('episodes' | 'concepts' | 'skills' | 'entities')[];
  tierInclusionThresholds: Partial<Record<MemoryTier, number>>; // per-tier overrides

  // Session history
  slidingWindowTurns: number;           // max turns in current session history
  slidingWindowTokens: number;          // max tokens in current session history

  // Speculative items
  includeSpeculative: boolean;          // include low-confidence / low-utility items
  speculativeMaxCount: number;          // cap on speculative items even when enabled
}

// Named presets (initial values — swarm designs the actual numbers)
const MODES: Record<string, AssemblyModeProfile> = {
  'psycho-genius':    { /* ⚡ Swarm designs */ },
  'brilliant':        { /* ⚡ Swarm designs — this is the default */ },
  'smart-efficient':  { /* ⚡ Swarm designs */ },
};

// Extensible: operators can define custom modes
// usme.assembly.customModes: { 'my-mode': { ...overrides } }
```

---

## 4. Async Extraction Pipeline

**LOCKED:** Fires after each turn completes, non-blocking. The user sees no delay.

### 4.1 Task queue

**DIRECTIONAL:** In-process task queue for v1 (Node.js `setImmediate` or `queueMicrotask` + a simple in-memory FIFO). No external queue service. If the process restarts mid-extraction, the sensory_trace verbatim record already exists — only the extracted items are lost, which is acceptable.

`[⚡ Swarm: evaluate]` — Is a persistent in-process queue (backed by a table in Postgres) worth it for v1? It would allow recovery after crash. Cost: complexity. Benefit: no lost extractions on restart. Probably v2 unless the swarm finds a clean, low-cost implementation.

### 4.2 Extraction jobs per turn

Two parallel extraction jobs fire after each turn:

**Job A: Fact/item extraction**
- Input: full turn (system context stripped; user message + tool calls + model response)
- Model: Haiku or Flash (configured; default Haiku)
- Output: `{ items: ExtractedItem[] }` where each item is a typed, utility-rated memory candidate
- Write location: `sensory_trace` table

**Job B: Entity extraction**
- Input: same turn content
- Model: same as Job A (or optionally a separate cheaper call)
- Output: `{ entities: ExtractedEntity[], relationships: ExtractedRelationship[] }`
- Write location: `entities` + `entity_relationships` tables after deduplication

`[⚡ Swarm: evaluate]` — Run Jobs A and B in a single LLM call (combined prompt, combined output) or separate calls? Combined is cheaper and faster. Separate is easier to iterate prompts independently. Given prompt engineering will be ongoing, separate calls are probably right for v1 — easier to test and tune each prompt independently.

### 4.3 Prompt design (first-class artifacts)

**LOCKED:** Extraction prompts are versioned artifacts stored in `src/prompts/`. Every prompt has a version string written into extracted items (`extractor_ver` field). This enables us to evaluate the effect of prompt changes over time.

**DIRECTIONAL prompt structure for fact extraction** (adapt, don't copy from Mem0):

```
# FACT_EXTRACTION_PROMPT_V1

You are a memory extraction specialist for an AI agent system.
Your job is to identify information from this conversation turn that is worth remembering for future use.

## What to extract

Extract items that fall into these types:
- fact: a stated truth about the user, their context, or their work
- preference: a like, dislike, or working style preference  
- decision: a choice that was made and should be remembered
- plan: an upcoming action or intention
- anomaly: something surprising or unexpected that might affect future behavior
- ephemeral: time-sensitive information (expires soon — tag with estimated shelf life)

## What NOT to extract
- Conversational filler ("thanks", "ok", "sounds good")
- Information that is general knowledge (not specific to this user or context)
- Content from system messages
- Anything the model said (unless it's recording something the USER stated)

## Utility rating
Rate each item's long-term utility:
- high: should almost always be in context when relevant
- medium: useful context when the topic comes up
- low: marginally useful, keep if space allows
- discard: not worth storing

## Output format
Return ONLY valid JSON. No explanation outside the JSON.

{
  "items": [
    {
      "type": "fact | preference | decision | plan | anomaly | ephemeral",
      "content": "a concise, standalone statement (not a quote — restate it clearly)",
      "utility": "high | medium | low | discard",
      "provenance_kind": "user | tool | model",
      "tags": ["tag1", "tag2"],
      "ephemeral_ttl_hours": null  // set for ephemeral type only
    }
  ]
}

## Examples
[few-shot examples here — swarm designs these based on actual session data]

## Rules
- Extract facts ONLY from user messages. Do not extract from assistant responses.
- Return [] for items if nothing is worth extracting. This is correct and expected.
- Be conservative. A smaller set of high-quality items beats a large set of noise.
- Today's date: {date}
- Detect the user's language and write content in that language.

## Turn to analyze:
{serialized_turn}
```

**DIRECTIONAL prompt structure for entity extraction:**

```
# ENTITY_EXTRACTION_PROMPT_V1

Extract named entities and their relationships from this conversation turn.

Entity types: person | org | project | tool | location | concept

Relationship types (choose the most specific):
- works_at (person → org)
- knows (person → person)
- manages (person → person or project)
- is_a (entity → type)
- owns (person or org → project or tool)
- uses (person or agent → tool)
- part_of (project or thing → larger entity)
- related_to (generic, use only if none above fit)

## Output format
{
  "entities": [
    { "name": "Alex", "type": "person", "canonical": "alex" },
    { "name": "OpenClaw", "type": "tool", "canonical": "openclaw" }
  ],
  "relationships": [
    { "source": "alex", "target": "openclaw", "relationship": "uses" }
  ]
}

Return empty arrays if nothing relevant. Only extract entities with clear identity — not vague references.

## Turn to analyze:
{serialized_turn}
```

`[⚡ Swarm: design]` — The few-shot examples in both prompts are the most important prompt engineering work. Use real session data from shadow mode phase to develop them. Examples of "here's noisy content that should produce []" are as important as positive examples.

### 4.4 Entity deduplication

Before writing new entities to the DB, the extraction pipeline must deduplicate:

```
for each extracted_entity:
  1. Search by canonical name exact match
  2. If not found: search by embedding cosine similarity > threshold (OPEN: 0.92?)
  3. If match found: merge (update metadata, do not create duplicate)
  4. If no match: insert new entity

for each extracted_relationship:
  1. Check if an active relationship (valid_until IS NULL) with same source/target/type exists
  2. If yes and content is the same: no-op
  3. If yes and content contradicts: set valid_until = now() on old, insert new
  4. If no: insert new
```

`[⚡ Swarm: decide]` — The 0.92 cosine similarity threshold for entity deduplication is a guess. Too high = duplicate entities; too low = incorrect merges. Test with names that are similar but different ("Tim Cook" vs "Tim Cooke" vs "Timothy Cook"). Consider: always require canonical name match as a precondition before embedding similarity check?

---

## 5. Nightly Consolidation Job

**LOCKED:** Runs via OpenClaw cron infrastructure. Idempotent — safe to re-run if interrupted. Logs every decision (episode created, fact promoted, contradiction resolved, skill drafted). Completion/error is announced to the configured channel.

### 5.1 Step 1 — Episode compression

**Desired outcome:** Today's sensory_trace rows are compressed into 10-50 episode summaries, each representing a meaningful chunk of work or conversation. Episodes live in the `episodes` hypertable.

**Directional approach:**
1. Pull all sensory_trace rows from the last 24h that haven't yet been episodified (need a `episodified_at` marker on sensory_trace, or a join against `episodes.source_trace_ids`)
2. Cluster them by embedding similarity — k-means or agglomerative clustering
3. For each cluster: send to Sonnet with: cluster content + instruction to write a compressed episode summary (200-500 tokens)
4. Write episode row with `source_trace_ids`, embedding of the summary, `time_bucket` aligned to the day

`[⚡ Swarm: evaluate]` clustering approach:
- **Option A:** pgvector cosine distance clustering — do it in SQL using a recursive CTE or a simple distance-to-centroid approach. Avoids shipping data out of the DB for clustering.
- **Option B:** Pull embeddings into the Node process, cluster with a pure-JS k-means library.
- **Option C:** Cluster by session + time proximity first (coarse), then semantic similarity within coarse clusters.
- Option C is probably most practical for v1 and handles the common case (one session = one work session = a few coherent topics).

**OPEN:** k (number of clusters / episodes per day). Too few = over-compressed, lose detail. Too many = redundant episodes, bad retrieval. Approach: let k float based on total sensory trace volume? A rough heuristic: 1 episode per ~15-20 trace items seems reasonable.

### 5.2 Step 2 — Fact promotion

**Desired outcome:** Facts that appear consistently across multiple episodes become concepts (stable, long-term knowledge). The concept layer reflects things that are durably true about the user and their context.

**Directional approach:**
1. For each concept candidate (a fact that appeared in 3+ episodes in the last 14 days):
   - Search `concepts` table for semantic near-duplicates (cosine < 0.15 distance = likely same fact)
   - If near-duplicate found: is the new version more specific/complete? If yes, Sonnet adjudicates; winner becomes the active concept, loser is soft-deleted with `superseded_by` link
   - If no near-duplicate: insert as new concept
2. Promotion threshold (3 episodes in 14 days) is configurable and is likely wrong on first deploy — log what gets promoted and tune

`[⚡ Swarm: evaluate]` — Should Sonnet adjudication happen inline (blocks the nightly job) or as a batch at the end? Inline is simpler. Batch could be parallelized. Likely doesn't matter for v1 volumes.

### 5.3 Step 3 — Contradiction resolution

**Desired outcome:** When two active concepts contradict each other (e.g., "Alex works at Acme" and "Alex works at BetaCo"), one wins and the other is soft-deleted. Entity relationships that have been superseded are marked `valid_until = now()`.

**Directional approach:**
1. For each newly promoted concept, search for active concepts with high cosine similarity (cosine distance < 0.10) that are of the same `concept_type`
2. If two such concepts exist and their content is contradictory (heuristic: same subject, same predicate, different object), send to Sonnet: "given these two memory items, which is more likely to be current? Cite your reasoning."
3. Apply Sonnet's decision: demote the loser (set `is_active = false`, `superseded_by = winner.id`)
4. Same logic for entity_relationships: scan for multiple active `works_at` relationships for the same entity — flag for resolution

`[⚡ Swarm: decide]` — Contradiction detection is the hardest part of this step. The heuristic "same subject, same predicate, different object" is a start. Better approach might be: send any two concepts with cosine distance < 0.10 to Sonnet and ask "do these contradict each other? If yes, which is more current?" This is conservative and may over-fire, but false positives (asking Sonnet about non-contradictions) are cheap; false negatives (missing a real contradiction) are expensive.

### 5.4 Step 4 — Skill candidate ranking and drafting

**Desired outcome:** High-value recurring workflows are identified and drafted as SKILL.md candidates. The user is notified and can promote them to active skills.

**LOCKED:** The nightly job does NOT auto-promote skills. It drafts candidates for human review.

**Candidate scoring formula (DIRECTIONAL):**

```
skill_score(cluster_of_episodes) =
    w_nov * novelty_score         // how different is this from existing skills?
  + w_frq * frequency_score       // how often does this pattern appear?
  + w_eng * engagement_score      // did the user seem satisfied? (proxy signals)
  + w_tch * teachability_estimate // Sonnet estimate: is this generalizable?
```

Proxy signals for engagement (OPEN — these are guesses):
- Turn count in the cluster (longer = more engaged)
- User messages per cluster (more user messages = more active engagement)
- Absence of short/dismissive responses from user ("ok", "nevermind", "not like that")
- Tool calls that succeeded (indicates productive work)

Top N candidates (N = configurable, default 3 per night) go to Sonnet for teachability evaluation:
1. "Is this interaction pattern a generalizable, teachable workflow? Could it be documented as a reusable skill?"
2. "If yes, rate teachability 1-10 and explain why."
3. Candidates scoring ≥7: proceed to SKILL.md drafting.

**Drafting (Sonnet or Opus, configurable):**
- Input: interaction history for the cluster + teachability evaluation
- Output: a draft SKILL.md following the AgentSkills spec
- Written to `~/.openclaw/skills/candidates/usme-draft-{name}-{date}.md`
- DB row in `skills` table with `status = 'candidate'`
- User notified via OpenClaw cron announce

`[⚡ Swarm: evaluate]` — What's the AgentSkills SKILL.md spec exactly? Read the skill-creator skill before writing the drafting prompt. The output must validate against that spec or it's useless.

### 5.5 Step 5 — Decay and pruning

**Desired outcome:** The DB does not grow unboundedly. Stale items are penalized, expired items are deleted.

**Directional approach:**
- **Sensory trace TTL:** Hard delete rows where `expires_at < now()` (or `created_at < now() - INTERVAL '30 days'` if no explicit expires_at)
- **Utility decay:** For concepts not accessed in the last 30 days: multiply `utility_score` by 0.95 (5% decay per nightly run). Concepts accessed recently: decay is skipped.
- **Episode decay:** Episodes older than 90 days with no access in 30 days: similar decay
- **Size alert:** If `pg_total_relation_size('sensory_trace') + pg_total_relation_size('episodes') > threshold`, log warning and optionally notify user

`[⚡ Swarm: decide]` — The decay rate (0.95 per night) and thresholds (30 days, 90 days) are guesses. These need to be configurable from day one. They will be tuned in shadow mode.

---

## 6. Current Session History Strategy

**LOCKED context:** When USME occupies the `contextEngine` slot, it owns the **full context assembly** — not just cross-session memory injection. Per OpenClaw docs, the slot delegates "context assembly, `/compact`, and related subagent context lifecycle hooks." LCM is out entirely.

This means USME is responsible for:
1. **Current session conversation history** — what to include from this session
2. **Cross-session memory** — what to inject from past sessions and accumulated knowledge
3. **`/compact` handling** — manual compaction requests
4. **Subagent context lifecycle hooks** — context management for spawned sub-agents

**Note:** `plugins.slots.memory` (Markdown files, `memory_search`, `memory_get`) is a **separate slot** and is unaffected. USME does not replace it.

### 6.1 Full context assembly layout

```
[system prompt]           ← OpenClaw builds this (tools, skills list, workspace files)
[systemPromptAddition]    ← USME injects: active skills, key concepts (§3)
[cross-session memory]    ← USME: episodes + concepts + entities (§3)
[current session history] ← USME: this section (§6.2)
[current turn]            ← passed in by OpenClaw
```

### 6.2 Current session history — three modes (configurable)

**LOCKED:** v1 implements Mode A. Modes B and C are config-stubbed for future implementation.

```typescript
// Config (directional)
sessionHistory: {
  mode: 'sliding-window' | 'mid-session-compress' | 'unified-selection',
  slidingWindow: {
    maxTurns: 20,        // last N turns verbatim
    tokenBudget: 30000,  // cap in tokens; truncate from oldest if exceeded
  },
  midSessionCompress: {
    // Mode B stub — not implemented in v1
    // Trigger Sonnet compression when session exceeds threshold
    triggerTokens: 60000,
    targetTokens: 20000,
  },
  unifiedSelection: {
    // Mode C stub — not implemented in v1
    // Score and select in-session turns same as cross-session memory
    // Fully unified selection policy across all memory sources
  }
}
```

**Mode A — Sliding window (v1 implementation):**
- Keep the last N turns verbatim (default: last 20 turns or last 30K tokens, whichever is smaller)
- Simple, predictable, fast — zero model calls
- Truncation from oldest-first when budget exceeded
- Budget split: `total_available - cross_session_memory_budget - reserve_for_response`

**Mode B — Mid-session compression (v2, stubbed):**
- When in-session history exceeds a token threshold, trigger on-demand Sonnet compression
- Compresses the oldest portion of the session into an episode summary
- Uses the same compression logic as the nightly job — consistent memory format
- The compressed summary is also written to the `episodes` table (session memory benefits from within-session work)

**Mode C — Unified selection (v3, stubbed):**
- In-session turns are scored and selected using the same formula as cross-session memory
- Most relevant turns from the current session win slots regardless of recency
- Fully coherent memory model — no architectural distinction between "current" and "past" sessions
- High complexity; only worth it once selection policy is proven on cross-session data

`[⚡ Swarm: validate]` — Mode A's `maxTurns: 20` and `tokenBudget: 30000` are initial guesses. Validate against real session data in shadow mode. What's the P95 turn count before compaction triggers in typical sessions?

### 6.3 Compaction — a different concept

**LOCKED:** USME does not have a compaction problem. The legacy engine accumulates a growing transcript until the context window fills, then must summarize-and-discard. USME never accumulates — `assemble()` is always within budget by construction:

```
Every turn:
  system prompt          bounded (static-ish, measured by OpenClaw)
  systemPromptAddition   bounded (active skills + top concepts, USME controls size)
  cross-session memory   bounded (token budget split, USME enforces)
  last N turns           bounded (sliding window, USME enforces)
  current turn           measured before assembly
  ─────────────────────────────────────────────────────
  total                  ≤ contextWindow by construction
```

Old turns drop off the sliding window automatically. They've already been ingested into `sensory_trace` via `ingest()`. Tonight's consolidation job turns them into episodes. There is nothing to compact — the window is always bounded.

**`compact()` implementation:** USME implements `compact()` because the interface requires it, but redefines what it does:

```typescript
async compact(params): Promise<CompactResult> {
  // USME doesn't need compaction — the window is always bounded.
  // A /compact request is reinterpreted as:
  //   "force-flush today's sensory traces to episodes now,
  //    don't wait for the nightly job."
  // This gives the user a useful action with meaningful side effects
  // while being honest that no in-context compaction occurred.

  await triggerOnDemandEpisodeCompression(params.sessionId);

  return {
    ok: true,
    compacted: false,  // nothing was removed from context
    reason: "USME assembles within token budget by design. " +
            "Triggered on-demand episode compression for today's traces.",
    result: {
      tokensBefore: params.currentTokenCount ?? 0,
      tokensAfter:  params.currentTokenCount ?? 0,  // unchanged
    }
  };
}
```

`ownsCompaction: true` is set in `info` — this tells OpenClaw not to trigger auto-compaction events. Auto-compaction in the legacy engine fires when `contextWindow - usedTokens < threshold`. In USME, that threshold is never approached.

**Note for `/compact` UX:** The user calling `/compact` should receive a clear message explaining that USME manages context differently and that their session traces have been compressed into episodes on demand. Surfacing this is the adapter layer's responsibility.

### 6.4 Token budget arithmetic

```typescript
// Directional — swarm should validate against real session data

function computeBudgets(
  contextWindowTokens: number,   // model's total context window
  systemPromptTokens: number,    // OpenClaw-built system prompt (measured)
  currentTurnTokens: number,     // user's current message
  responseReserveTokens: number, // reserved for model's response
  mode: 'tight' | 'extended'
): { sessionHistoryBudget: number; crossSessionBudget: number } {

  const available = contextWindowTokens
    - systemPromptTokens
    - currentTurnTokens
    - responseReserveTokens;

  // Mode-dependent split
  const splits = {
    tight:    { session: 0.70, crossSession: 0.30 },
    extended: { session: 0.50, crossSession: 0.50 },
  };

  const split = splits[mode];
  return {
    sessionHistoryBudget: Math.floor(available * split.session),
    crossSessionBudget:   Math.floor(available * split.crossSession),
  };
}
```

`[⚡ Swarm: evaluate]` — The split ratios (70/30 tight, 50/50 extended) are hypotheses. The right ratio likely depends on session age and activity level — a fresh session with no cross-session memory has nothing to inject anyway. Consider: dynamic split that adjusts based on how much cross-session memory is actually available to inject?

---

## 7. OpenClaw Integration

### 7.1 Plugin slot + interface contract

**LOCKED:** USME integrates via `plugins.slots.contextEngine` with `kind: "context-engine"` in its manifest. It replaces lossless-claw.

**LOCKED:** The full `ContextEngine` interface is known — pulled from `dist/plugin-sdk/context-engine/types.d.ts`. USME must implement all required methods:

```typescript
interface ContextEngine {
  // Required
  readonly info: ContextEngineInfo;   // { id, name, version, ownsCompaction }
  ingest(params): Promise<IngestResult>;     // store a single message
  assemble(params): Promise<AssembleResult>; // build context under token budget
  compact(params): Promise<CompactResult>;   // handle /compact

  // Optional but important
  bootstrap?(params): Promise<BootstrapResult>;     // init session, import history
  ingestBatch?(params): Promise<IngestBatchResult>; // store a completed turn batch
  afterTurn?(params): Promise<void>;                // post-turn hooks (trigger async extraction)
  prepareSubagentSpawn?(params): Promise<...>;      // subagent context prep
  onSubagentEnded?(params): Promise<void>;          // subagent cleanup
  dispose?(): Promise<void>;                        // teardown
}

// AssembleResult — what assemble() must return (LOCKED by interface)
type AssembleResult = {
  messages: AgentMessage[];        // ordered messages for the model
  estimatedTokens: number;
  systemPromptAddition?: string;   // prepended to runtime system prompt
};
```

**Key observations from the interface:**

1. **`assemble()` receives `messages: AgentMessage[]`** — OpenClaw passes in the raw session messages. USME decides what to include, trim, summarise. This is the current session history selection problem (§6).

2. **`afterTurn()` is the hook for async extraction** — this is where we fire the Haiku/Flash extraction job. Non-blocking; return immediately after enqueuing.

3. **`ingest()` and `ingestBatch()`** — USME must store each message as it arrives (for the sensory trace). These are write operations; keep fast.

4. **`compact()` with `ownsCompaction: true`** — set `ownsCompaction: true` in `info`. This tells OpenClaw that USME manages its own compaction lifecycle. `/compact` calls will route to USME's `compact()` method.

5. **`prepareSubagentSpawn()` / `onSubagentEnded()`** — context lifecycle hooks for sub-agents. USME should implement these to scope memory correctly per sub-agent session. Minimal v1 implementation: scope by `childSessionKey`.

**D21 and D22 are now resolved.** Remove from open decisions — the interface is clear.

**DIRECTIONAL config:**

```yaml
# In OpenClaw config
plugins:
  slots:
    contextEngine: usme-claw

# usme-claw plugin config (separate config section)
usme:
  mode: shadow      # shadow | active | disabled
  db:
    host: localhost
    port: 5432
    database: usme
    user: usme
    password: usme_dev
    pool:
      min: 2
      max: 10
  extraction:
    model: haiku        # haiku | flash | gpt-4o-mini
    enabled: true
  consolidation:
    cron: "0 3 * * *"  # 3am UTC nightly
    sonnetModel: sonnet
    skillDraftingModel: sonnet  # sonnet | opus
    candidatesPerNight: 3
  assembly:
    defaultMode: brilliant        # brilliant | psycho-genius | smart-efficient | custom
    modes:
      psycho-genius:  {}          # ⚡ Swarm designs parameter values
      brilliant:      {}          # ⚡ Swarm designs parameter values (default)
      smart-efficient: {}         # ⚡ Swarm designs parameter values
    # customModes:                # operator-defined extensions
    #   my-mode: { minInclusionScore: 0.5, ... }
  shadow:
    logComparison: true
    samplingRate: 1.0   # 1.0 = compare every turn; 0.1 = 10% sample
```

`[⚡ Swarm: validate]` — Check the OpenClaw contextEngine slot contract (`/home/alex/ai/projects/node_modules/openclaw/docs`). Understand what interface `lossless-claw` exports. USME must implement the same interface.

### 7.2 Shadow mode — hard v1 requirement

**LOCKED:** Shadow mode is not optional. USME v1 ships in shadow mode and stays there until there is enough evidence to justify switching to active. There is no path from "build done" to "active" without a shadow evaluation phase. This is a hard requirement.

**What shadow mode means:** USME runs its full pipeline on every turn — `ingest()`, `assemble()`, `afterTurn()` — but the model receives LCM's context, not USME's. USME's assembly is computed, logged, and compared against LCM's, but never delivered. The user experiences no change. The data accumulates.

```
Each turn (shadow mode):
  LCM assembles → model receives this
  USME assembles in parallel → logged, compared, discarded
  USME ingest() → sensory_trace is written (extraction still runs)
  USME afterTurn() → async extraction fires (builds up the memory store)

Nightly:
  USME consolidation job runs regardless of mode
  (we want a populated memory store when we switch to active)
```

**Why this matters:** We cannot know in advance whether USME's context selection is better than LCM's for real sessions. Shadow mode gives us the evidence. We need to be able to answer:

1. Is USME's assembled context more token-efficient?
2. Does USME surface memories that are actually useful (vs. LCM's recent-biased history)?
3. What is USME selecting that LCM doesn't include? Is that a win or noise?
4. What is LCM including that USME omits? Is that a loss?
5. Is the hot path within the P95 ≤150ms budget?
6. Does the extraction pipeline produce quality items or garbage?

Without tooling to answer these questions, shadow mode produces useless log files. The tooling is part of the v1 requirement.

### 7.3 Shadow mode infrastructure

#### Storage — `shadow_comparisons` table

```sql
CREATE TABLE shadow_comparisons (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  query_preview   TEXT,                    -- first 200 chars of user message (for human inspection)

  -- LCM output
  lcm_token_count INTEGER,
  lcm_latency_ms  INTEGER,

  -- USME output
  usme_token_count        INTEGER,
  usme_latency_ms         INTEGER,
  usme_tiers_contributed  TEXT[],          -- which tiers had items selected
  usme_items_selected     INTEGER,
  usme_items_considered   INTEGER,
  usme_system_addition_tokens INTEGER,

  -- Comparison
  token_delta     INTEGER,                 -- usme_token_count - lcm_token_count (negative = more efficient)
  overlap_score   FLOAT,                   -- 0-1: how much of USME's content appears in LCM output
  usme_only_preview TEXT,                  -- preview of what USME selected that LCM didn't
  lcm_only_preview  TEXT,                  -- preview of what LCM included that USME omitted

  -- Relevance signal (populated by secondary analysis job, not hot path)
  usme_memory_cited       BOOLEAN,         -- did USME-injected memory appear in model's response?
  relevance_analysis_done BOOLEAN DEFAULT false,

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX ON shadow_comparisons (session_id, turn_index);
CREATE INDEX ON shadow_comparisons (created_at DESC);
CREATE INDEX ON shadow_comparisons (relevance_analysis_done) WHERE NOT relevance_analysis_done;
```

`[⚡ Swarm: evaluate]` — `overlap_score` is the hardest field to compute. LCM returns raw messages (conversation history); USME returns selected memory items. They're structurally different — LCM carries verbatim turns, USME carries extracted/compressed knowledge. Simple text overlap will be low by design even when USME is doing a good job. The metric we actually want is: "does USME's injection contain information that is relevant to the current turn?" Consider: run a lightweight embedding similarity between each USME-injected item and the current query at comparison time.

#### Relevance signal — secondary analysis job

**The hardest metric:** Did USME's injected memories actually help?

**Directional approach:** A secondary cron job (runs hourly or on-demand) analyzes completed turns:

```
For each shadow_comparison where relevance_analysis_done = false:
  1. Pull the USME assembly items for that turn
  2. Pull the model's actual response for that turn (from session transcript)
  3. For each USME-injected memory item:
     - Compute embedding similarity between item.content and model_response
     - If similarity > 0.65: mark as "cited" (proxy for "was useful")
  4. Set usme_memory_cited = (any item cited)
  5. Set relevance_analysis_done = true
```

This is a proxy, not ground truth. A memory item being semantically similar to the response doesn't prove it caused the response. But at scale across many turns, the signal is meaningful.

`[⚡ Swarm: decide]` — Model for relevance analysis. Options:
- **Embedding similarity only** (no model call) — cheap, scalable, weak signal
- **Small model (Haiku/Flash)** — ask "did the assistant use this information in its response?" — stronger signal, costs per turn
- **Start with embedding, upgrade to model-based if the data is noisy** — pragmatic

#### CLI tooling — hard requirement

The swarm must ship these commands as part of v1. They are not optional.

```bash
# Per-session report: what has USME been doing?
usme shadow report --session <session_id>

# Global report: aggregate metrics across all shadow sessions
usme shadow report --global --since "7 days ago"

# Live tail: watch shadow comparisons as they come in
usme shadow tail [--session <session_id>]

# Promotion check: are we ready to go active?
usme shadow ready
# Output: pass/fail with evidence:
#   ✅ P95 assembly latency: 89ms (budget: 150ms)
#   ✅ Extraction quality: 78% items rated high/medium utility
#   ✅ Relevance signal: 62% of USME-injected memories cited in responses
#   ⚠️  Token efficiency: USME uses 12% more tokens than LCM on average
#   ❌ Min shadow turns required: 500 (current: 234)

# Force a relevance analysis pass
usme shadow analyze [--session <session_id>]

# Export shadow data for external analysis
usme shadow export --format csv --since "30 days ago" > shadow_data.csv
```

`[⚡ Swarm: decide]` — CLI implementation: standalone `usme` binary vs. OpenClaw slash commands vs. scripts. Given USME ships as an OpenClaw plugin, slash commands (`/usme shadow report`) are probably the right delivery mechanism for day-to-day inspection. The underlying data should be queryable directly from Postgres too.

#### Promotion criteria — what evidence is required before going active?

**LOCKED:** The following must all pass before switching `mode: shadow → active`. These are minimums, not recommendations.

| Criterion | Minimum threshold | Notes |
|---|---|---|
| Shadow turns collected | ≥ 500 real turns | Not heartbeats or sub-agent turns |
| P95 assembly latency | ≤ 150ms | Measured under real load, not synthetic |
| Extraction success rate | ≥ 95% | Async jobs completed without error |
| Extraction quality | ≥ 60% items rated medium/high utility | Based on `utility_prior` from extractor |
| Relevance signal | ≥ 50% of USME-injected memories cited | Secondary analysis proxy |
| Zero critical errors | 0 unhandled exceptions in hot path | Any exception = not ready |

`[⚡ Swarm: evaluate]` — These thresholds are first drafts. The relevance signal threshold (50%) is especially uncertain — we don't know what "good" looks like until we have real data. The `usme shadow ready` command should display current values vs. thresholds so the human can make a judgment call, not just a binary pass/fail.

#### Promotion is one-way

**LOCKED:** Once USME goes active, LCM is done. There is no "LCM shadow" phase after cutover. The transition is:

```
shadow (USME observes, LCM serves) → active (USME serves, LCM disabled)
```

LCM remains wired as a runtime fallback **only for error recovery** — if USME's `assemble()` throws or times out, the adapter falls back to LCM for that single turn. This is not a shadow phase; it's a circuit breaker. Once USME is stable, the fallback path becomes dead code.

No validation shadow phase on the LCM side is needed. We collect evidence in the USME-shadow phase, make the call, and cut over. Done.

#### What shadow mode does NOT do

- Does not degrade the user's experience in any way
- Does not add latency to the user-visible turn (USME assembly runs concurrently or is deferred — implementation detail for swarm)
- Does not require the user to do anything differently
- Does not change what the model sees or how it responds

### 7.3 Graceful degradation

**LOCKED:** If USME's `assemble()` throws or exceeds timeout, fall back to LCM output. This must be in the adapter layer, not the core library. USME failing must never cause a turn to fail.

---

## 8. Repository Structure

**DIRECTIONAL:** Monorepo with two packages. One repo, independent versioning for each package.

```
usme-claw/
├── packages/
│   ├── usme-core/           # framework-agnostic TypeScript library
│   │   ├── src/
│   │   │   ├── assemble/    # hot path: retrieve, score, pack
│   │   │   ├── extract/     # async extraction pipeline + prompts
│   │   │   ├── consolidate/ # nightly job
│   │   │   ├── schema/      # TypeScript types (not Postgres DDL)
│   │   │   └── prompts/     # versioned extraction + update prompts
│   │   ├── db/
│   │   │   ├── migrations/  # node-pg-migrate SQL files
│   │   │   └── seeds/       # dev seed data
│   │   └── package.json
│   └── usme-openclaw/       # OpenClaw adapter
│       ├── src/
│       │   ├── plugin.ts    # contextEngine slot implementation
│       │   ├── config.ts    # OpenClaw config schema
│       │   └── shadow.ts    # shadow mode harness
│       └── package.json
├── docker-compose.yml
├── docker-compose.test.yml  # ephemeral DB for tests
├── scripts/
│   ├── db-init.sh           # run migrations + seed
│   ├── shadow-report.ts     # generate shadow comparison report  (backs `usme shadow report`)
│   ├── shadow-tail.ts       # live tail shadow comparisons       (backs `usme shadow tail`)
│   ├── shadow-analyze.ts    # run relevance analysis pass        (backs `usme shadow analyze`)
│   └── shadow-ready.ts      # promotion readiness check          (backs `usme shadow ready`)
└── pm/                      # all PM docs (this folder)
```

`[⚡ Swarm: evaluate]` — Monorepo tooling: `npm workspaces` vs `pnpm workspaces` vs `turborepo`. For two packages with no complex build pipeline, `npm workspaces` is probably sufficient. Don't over-engineer the monorepo setup.

---

## 9. Testing Strategy

**Desired outcome:** The build swarm should design the test suite. These are the requirements it must satisfy:

**Unit tests (must have):**
- Selection formula: given a set of scored items and a token budget, the packing algorithm selects the correct items in the correct order
- Recency decay function: correct behavior at t=0, t=half_life, t=3*half_life
- Entity deduplication: correct merge behavior for exact canonical match vs near-miss vs false positive
- Critic gate: correct exclusion of discard/low-confidence/soft-deleted items

**Integration tests (must have):**
- `assemble()` round-trip: insert test data into a real Postgres instance (docker-compose.test.yml), call assemble(), verify output structure
- Extraction pipeline: given a test turn, verify extracted items are written to sensory_trace with correct types
- Entity deduplication against live DB: insert entity, re-extract same entity, verify no duplicate row

**Shadow mode tests (should have):**
- Compare USME output vs a known reference output; verify token delta is within expected range
- Verify graceful degradation: if `assemble()` throws, verify the adapter returns LCM's output

**Nightly job tests (should have):**
- Episode compression: given N test trace rows, verify episode rows are created
- Idempotency: running the nightly job twice on the same data produces the same result

`[⚡ Swarm: decide]` — Test runner: `vitest` (ESM-native, fast) vs `jest` (widely known). For a new TypeScript project, vitest is preferred.

---

## 10. Open Decisions Summary

A consolidated list for the swarm to track:

| # | Decision | Section | Status |
|---|---|---|---|
| D1 | `timescaledb-ha` image vs manual extension assembly | §2.1 | OPEN |
| D2 | Should `sensory_trace` be a TimescaleDB hypertable? | §2.2 | OPEN |
| D3 | `assemble()` return type: structured `InjectedMemory[]` vs flat `messages[]` | §3.1 | OPEN |
| D4 | Entity graph enrichment in hot path (none vs 1-hop lookup) | §3.2 | OPEN |
| D5 | ANN top-K value before scoring | §3.2 | OPEN |
| D6 | Selection formula weight tuning | §3.3 | OPEN — benchmark in shadow mode |
| D7 | Should skills use tier-specific formula weights? | §3.3 | OPEN |
| D8 | In-process vs persistent task queue for async extraction | §4.1 | OPEN |
| D9 | Single vs separate LLM calls for fact + entity extraction | §4.2 | OPEN |
| D10 | Entity deduplication cosine similarity threshold | §4.4 | OPEN |
| D11 | Sensory trace episodification tracking mechanism | §5.1 | OPEN |
| D12 | Clustering approach for episode compression | §5.1 | OPEN |
| D13 | k (cluster count) strategy | §5.1 | OPEN |
| D14 | Contradiction detection heuristic | §5.3 | OPEN |
| D15 | Monorepo tooling (npm vs pnpm workspaces) | §7 | OPEN |
| D16 | Test runner (vitest vs jest) | §8 | OPEN |
| D17 | Shadow relevance signal: embedding similarity vs. model-based analysis | §7.3 | OPEN — start with embedding, upgrade if noisy |
| D18 | Migration tooling (node-pg-migrate vs kysely vs drizzle-kit) | §2.2 | OPEN |
| D19 | Session history sliding window defaults (maxTurns, tokenBudget) | §6.2 | OPEN — validate in shadow mode |
| D20 | Token budget split ratio (session vs cross-session) | §6.4 | OPEN — hypotheses given; dynamic split worth evaluating |
| D21 | ~~`/compact` interface~~ | §7.1 | **RESOLVED** — `compact()` method, set `ownsCompaction: true` in info |
| D22 | ~~Subagent context lifecycle hooks~~ | §7.1 | **RESOLVED** — `prepareSubagentSpawn()` + `onSubagentEnded()`, scope by `childSessionKey` |
| D23 | Per-mode parameter values (`psycho-genius`, `brilliant`, `smart-efficient`) | §3.5 | OPEN — swarm designs, algo expert + comp intel input required |
| D24 | Mode auto-detection: infer from context vs. explicit user control | §3.5 | OPEN — swarm evaluates complexity vs. predictability |
| D25 | Mode selection UX: config / slash command / per-turn / programmatic / auto — precedence order | §3.5 | OPEN |
| D26 | Should tier weights change per mode, or only inclusion threshold? | §3.5 | OPEN |
| D27 | How does `psycho-genius` handle over-budget: what gets sacrificed? | §3.5 | OPEN — prioritisation order needed |

---

## 11. What Is NOT in This Document

These are in scope but deferred to build phase decisions:
- Final prompt text (few-shot examples especially — written once real data exists)
- Connection pool sizing
- Logging / observability tooling choice (Pino? Winston? OpenTelemetry?)
- Error handling and retry strategy for Haiku/Flash API calls
- Specific nightly job timing and cron expression
- Specific package.json dependencies and versions

---

## Revision History

| Date | Author | Change |
|---|---|---|
| 2026-04-04 | Rufus | Initial architecture draft — full system design across all three planes, entity layer, shadow mode, open decisions |
| 2026-04-04 | Rufus | Added §6 current session history (modes A/B/C), §6.3 compaction redefined, §6.4 token budget arithmetic, §7.1 ContextEngine interface contract (locked from source), §7.2–7.3 shadow mode as hard v1 requirement with full infrastructure spec |
| 2026-04-05 | Rufus | Clarified promotion path: one-way shadow→active, LCM never runs in shadow, LCM retained only as single-turn error fallback/circuit breaker |
| 2026-04-04 | Rufus | Added §3.5 context assembly modes: `psycho-genius`, `brilliant`, `smart-efficient` — named profiles with tunable/extensible design, 5 new open decisions (D23–D27), competitive intelligence agent added to swarm composition |
