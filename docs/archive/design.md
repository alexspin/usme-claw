# USME-CLAW Design Document

**Status:** Final design -- all decisions resolved
**Date:** 2026-04-05
**Source:** ARCHITECTURE.md (2026-04-04) with decisions D1-D27 resolved

---

## 1. Resolved Decisions

| # | Decision | Resolution | Rationale |
|---|----------|-----------|-----------|
| D1 | Docker image | `timescale/timescaledb-ha:pg16` | Bundles pgvector + TimescaleDB + pgvectorscale. No manual extension assembly. |
| D2 | sensory_trace hypertable? | No for v1 | Standard table with TTL index. Simpler, sufficient at v1 scale. Does not block future migration. |
| D3 | assemble() return type | `AssembleResult { messages, estimatedTokens, systemPromptAddition? }` | Locked by OpenClaw ContextEngine interface. Internally use `InjectedMemory[]`, adapter converts to `AgentMessage[]`. |
| D4 | Entity graph in hot path | Skip for v1 | Entities surface through concepts. Stays within 150ms P95 budget. |
| D5 | ANN top-K | 20 per tier (60 total candidates before scoring) | Balance between recall and scoring overhead. |
| D6 | Selection formula weights | sim=0.40, rec=0.25, prov=0.20, acc=0.15 | Tunable via config. Semantic similarity is strongest signal. |
| D7 | Tier-specific weights for skills? | Yes | Skills: sim=0.20, rec=0.0, prov=0.10, acc=0.30, teachability=0.40. Skills don't decay; teachability and access drive selection. |
| D8 | Task queue | In-process for v1 | Simple FIFO via `setImmediate`. Acceptable loss on crash since verbatim traces already persisted. |
| D9 | Single vs separate LLM calls | Separate | Easier to iterate prompts independently. Two parallel Haiku calls per turn. |
| D10 | Entity dedup threshold | 0.90 cosine similarity | Require canonical name match as precondition before embedding check. |
| D11 | Episodification tracking | `episodified_at TIMESTAMPTZ` column on sensory_trace | Simple, queryable. `WHERE episodified_at IS NULL` finds un-episodified traces. |
| D12 | Clustering approach | Option C: session + time proximity, then semantic within clusters | Handles the common case (one session = one work session). Practical for v1. |
| D13 | k (cluster count) | Dynamic: 1 episode per ~15 trace items, minimum 1 | Adapts to daily volume without config tuning. |
| D14 | Contradiction detection | Send any two concepts with cosine distance < 0.10 to Sonnet | Conservative. False positives are cheap (wasted Sonnet call). False negatives are expensive (stale data persists). |
| D15 | Monorepo tooling | npm workspaces | Simple, sufficient for 2 packages. No turborepo overhead. |
| D16 | Test runner | vitest | ESM-native, fast, modern. Better DX than Jest for new TypeScript. |
| D17 | Shadow relevance signal | Start with embedding similarity | Upgrade to model-based if noisy. Cheap, scalable for v1. |
| D18 | Migration tooling | node-pg-migrate | Works with raw SQL. Required for TimescaleDB/pgvector DDL that ORMs cannot generate. |
| D19 | Session history defaults | maxTurns: 20, tokenBudget: 30000 | Validate in shadow mode. Configurable from day one. |
| D20 | Token budget split | Per-mode ratios (see mode profiles below) | Dynamic adjustment is v2. |
| D21 | compact() interface | RESOLVED | `CompactResult` with `ownsCompaction: true`. Reinterprets /compact as on-demand episode flush. |
| D22 | Subagent hooks | RESOLVED | `prepareSubagentSpawn()` + `onSubagentEnded()`, scope by `childSessionKey`. |
| D23 | Per-mode parameter values | See Section 9 | Full parameter sets for all three modes. |
| D24 | Mode auto-detection | Explicit user control for v1 | Auto-detection is v2. Simplicity and predictability win. |
| D25 | Mode selection UX precedence | per-turn param > session override > config default | All programmatic for v1. No slash commands yet. |
| D26 | Tier weights per mode | Only inclusion threshold changes per mode | Tier weights stay constant. Simpler, less to tune. |
| D27 | psycho-genius over-budget | Sacrifice speculative items first, then lowest-scored items | Same greedy packing, just more candidates to start with. |

---

## 2. Architecture Overview

Three non-overlapping planes:

```
HOT PATH   (<150ms P95, per turn, read-only)
  assemble() -> retrieve candidates -> score -> critic gate -> pack -> return

ASYNC PATH  (after turn, non-blocking)
  afterTurn() -> enqueue extraction -> Haiku: facts + entities -> write to DB

NIGHTLY JOB (cron, idempotent)
  episodify -> promote facts to concepts -> resolve contradictions -> draft skills -> decay/prune
```

---

## 3. Monorepo Directory Tree

```
usme-claw/
  packages/
    usme-core/                    # Framework-agnostic TypeScript library
      src/
        assemble/
          retrieve.ts             # Parallel ANN queries across tiers
          score.ts                # Selection formula + weights
          critic.ts               # Rule-based filter gate
          pack.ts                 # Greedy token budget packing
          index.ts                # assemble() orchestrator
        extract/
          fact-extractor.ts       # Job A: fact/item extraction
          entity-extractor.ts     # Job B: entity extraction + dedup
          queue.ts                # In-process FIFO task queue
          index.ts
        consolidate/
          episodify.ts            # Step 1: cluster traces -> episodes
          promote.ts              # Step 2: fact -> concept promotion
          contradict.ts           # Step 3: contradiction resolution
          skill-draft.ts          # Step 4: skill candidate drafting
          decay.ts                # Step 5: decay + prune
          index.ts                # Nightly job orchestrator
        schema/
          types.ts                # All TypeScript types
          config.ts               # Configuration types + defaults
        prompts/
          fact-extraction.ts      # FACT_EXTRACTION_PROMPT_V1
          entity-extraction.ts    # ENTITY_EXTRACTION_PROMPT_V1
        db/
          pool.ts                 # pg Pool wrapper
          queries.ts              # Parameterized SQL queries
      db/
        migrations/
          001_extensions.sql
          002_sensory_trace.sql
          003_episodes.sql
          004_concepts.sql
          005_skills.sql
          006_entities.sql
          007_entity_relationships.sql
          008_shadow_comparisons.sql
        seeds/
          dev-seed.sql
      package.json
      tsconfig.json
      vitest.config.ts
    usme-openclaw/                # OpenClaw adapter plugin
      src/
        plugin.ts                 # ContextEngine interface implementation
        config.ts                 # OpenClaw config schema mapping
        shadow.ts                 # Shadow mode harness + LCM comparison
        adapter.ts                # InjectedMemory[] -> AgentMessage[] conversion
      package.json
      tsconfig.json
  docker-compose.yml              # Dev DB (timescaledb-ha:pg16)
  docker-compose.test.yml         # Ephemeral DB for tests
  scripts/
    db-init.sh
    shadow-report.ts
    shadow-tail.ts
    shadow-analyze.ts
    shadow-ready.ts
  package.json                    # Root workspace config
  tsconfig.base.json
```

---

## 4. Package Configuration

### Root package.json

```json
{
  "name": "usme-claw",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "test": "npm run test --workspaces",
    "test:integration": "npm run test:integration --workspaces",
    "migrate": "npm run migrate --workspace=packages/usme-core",
    "migrate:test": "DATABASE_URL=postgres://usme:usme_test@localhost:5433/usme_test npm run migrate --workspace=packages/usme-core"
  },
  "devDependencies": {
    "typescript": "^5.4",
    "vitest": "^2.0"
  }
}
```

### packages/usme-core/package.json

```json
{
  "name": "@usme/core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "migrate": "node-pg-migrate up --migrations-dir db/migrations --database-url-var DATABASE_URL",
    "migrate:down": "node-pg-migrate down --migrations-dir db/migrations --database-url-var DATABASE_URL"
  },
  "dependencies": {
    "pg": "^8.12",
    "node-pg-migrate": "^7.0"
  },
  "devDependencies": {
    "vitest": "^2.0",
    "@types/pg": "^8.11"
  }
}
```

### packages/usme-openclaw/package.json

```json
{
  "name": "@usme/openclaw",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/plugin.js",
  "types": "dist/plugin.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@usme/core": "workspace:*"
  }
}
```

### tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

---

## 5. Database Schema (Final DDL)

```sql
-- ============================================================
-- Migration 001: Extensions
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ============================================================
-- Migration 002: sensory_trace
-- ============================================================
CREATE TABLE sensory_trace (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  item_type       TEXT        NOT NULL,   -- 'verbatim' | 'extracted'
  memory_type     TEXT,                   -- 'fact' | 'preference' | 'decision' | 'plan' | 'anomaly' | 'ephemeral' | null
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  provenance_kind TEXT        NOT NULL,   -- 'user' | 'tool' | 'model' | 'web' | 'file'
  provenance_ref  TEXT,
  utility_prior   TEXT        DEFAULT 'medium',  -- 'high' | 'medium' | 'low' | 'discard'
  tags            TEXT[]      DEFAULT '{}',
  extractor_ver   TEXT,
  metadata        JSONB       DEFAULT '{}',
  episodified_at  TIMESTAMPTZ,            -- D11: set when trace is consumed by episodification
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ             -- now() + TTL at insert time
);

-- D2: NOT a hypertable. Standard table with TTL index.
CREATE INDEX idx_sensory_trace_expires ON sensory_trace (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_sensory_trace_session ON sensory_trace (session_id, turn_index);
CREATE INDEX idx_sensory_trace_embedding ON sensory_trace USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_sensory_trace_unepisodified ON sensory_trace (created_at)
  WHERE episodified_at IS NULL AND item_type = 'extracted';

-- ============================================================
-- Migration 003: episodes (hypertable)
-- ============================================================
CREATE TABLE episodes (
  id              UUID        DEFAULT gen_random_uuid(),
  session_ids     TEXT[]      NOT NULL,
  time_bucket     TIMESTAMPTZ NOT NULL,
  summary         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  source_trace_ids UUID[]     NOT NULL,
  token_count     INTEGER,
  utility_score   FLOAT       DEFAULT 0.5,
  access_count    INTEGER     DEFAULT 0,
  last_accessed   TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, created_at)
);

SELECT create_hypertable('episodes', 'created_at', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX idx_episodes_embedding ON episodes USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_episodes_time_bucket ON episodes (time_bucket DESC);

-- ============================================================
-- Migration 004: concepts
-- ============================================================
CREATE TABLE concepts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_type    TEXT        NOT NULL,   -- 'fact' | 'preference' | 'decision' | 'relationship_summary'
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  utility_score   FLOAT       DEFAULT 0.5,
  provenance_kind TEXT        NOT NULL,
  provenance_ref  TEXT,
  confidence      FLOAT       DEFAULT 1.0,
  access_count    INTEGER     DEFAULT 0,
  last_accessed   TIMESTAMPTZ,
  supersedes_id   UUID        REFERENCES concepts(id),
  superseded_by   UUID        REFERENCES concepts(id),
  is_active       BOOLEAN     DEFAULT true,
  tags            TEXT[]      DEFAULT '{}',
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_concepts_embedding ON concepts USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND is_active = true;
CREATE INDEX idx_concepts_type_score ON concepts (concept_type, is_active, utility_score DESC);

-- ============================================================
-- Migration 005: skills
-- ============================================================
CREATE TABLE skills (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL UNIQUE,
  description     TEXT,
  embedding       VECTOR(1536),
  status          TEXT        DEFAULT 'candidate',  -- 'candidate' | 'active' | 'retired'
  skill_path      TEXT        NOT NULL,
  source_episode_ids UUID[]   DEFAULT '{}',
  teachability    FLOAT,
  use_count       INTEGER     DEFAULT 0,
  last_used       TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_skills_embedding ON skills USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND status = 'active';
CREATE INDEX idx_skills_status ON skills (status, teachability DESC);

-- ============================================================
-- Migration 006: entities
-- ============================================================
CREATE TABLE entities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL,   -- 'person' | 'org' | 'project' | 'tool' | 'location' | 'concept'
  canonical       TEXT,
  embedding       VECTOR(1536),
  confidence      FLOAT       DEFAULT 1.0,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_entities_canonical ON entities (canonical);

-- ============================================================
-- Migration 007: entity_relationships
-- ============================================================
CREATE TABLE entity_relationships (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID        NOT NULL REFERENCES entities(id),
  target_id       UUID        NOT NULL REFERENCES entities(id),
  relationship    TEXT        NOT NULL,
  confidence      FLOAT       DEFAULT 1.0,
  source_item_id  UUID,
  valid_from      TIMESTAMPTZ DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entity_rel_source ON entity_relationships (source_id, valid_until NULLS LAST);
CREATE INDEX idx_entity_rel_target ON entity_relationships (target_id, valid_until NULLS LAST);
CREATE INDEX idx_entity_rel_type ON entity_relationships (relationship, valid_until NULLS LAST);

-- ============================================================
-- Migration 008: shadow_comparisons
-- ============================================================
CREATE TABLE shadow_comparisons (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  query_preview   TEXT,

  -- LCM output
  lcm_token_count INTEGER,
  lcm_latency_ms  INTEGER,

  -- USME output
  usme_token_count        INTEGER,
  usme_latency_ms         INTEGER,
  usme_mode               TEXT,
  usme_tiers_contributed  TEXT[],
  usme_items_selected     INTEGER,
  usme_items_considered   INTEGER,
  usme_system_addition_tokens INTEGER,

  -- Comparison
  token_delta     INTEGER,
  overlap_score   FLOAT,
  usme_only_preview TEXT,
  lcm_only_preview  TEXT,

  -- Relevance signal (populated by secondary analysis job)
  usme_relevance_score    FLOAT,          -- embedding similarity between injected items and response
  usme_memory_cited       BOOLEAN,
  relevance_analysis_done BOOLEAN DEFAULT false,

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_shadow_session ON shadow_comparisons (session_id, turn_index);
CREATE INDEX idx_shadow_created ON shadow_comparisons (created_at DESC);
CREATE INDEX idx_shadow_unanalyzed ON shadow_comparisons (relevance_analysis_done) WHERE NOT relevance_analysis_done;
```

---

## 6. Selection Formula

### Types

```typescript
// Memory tiers
type MemoryTier = 'episodes' | 'concepts' | 'skills' | 'entities';

// A candidate retrieved from any tier before scoring
interface RetrievalCandidate {
  id: string;
  tier: MemoryTier;
  content: string;
  embedding: number[];       // 1536-dim vector
  tokenCount: number;
  createdAt: Date;
  accessCount: number;
  lastAccessed: Date | null;
  provenanceKind: 'user' | 'tool' | 'model' | 'web' | 'file';
  confidence: number;
  utilityScore: number;
  utilityPrior?: 'high' | 'medium' | 'low' | 'discard';
  isActive?: boolean;
  // Skill-specific
  teachability?: number;     // 0-10, only for skills tier
  status?: string;           // only for skills tier
}

// After scoring
interface ScoredCandidate extends RetrievalCandidate {
  score: number;             // 0-1 final composite score
  scoreBreakdown: {
    similarity: number;
    recency: number;
    provenance: number;
    accessFrequency: number;
    teachability?: number;   // skills only
  };
}

// After packing into budget
interface InjectedMemory {
  id: string;
  tier: MemoryTier;
  content: string;
  score: number;
  tokenCount: number;
}

// What assemble() returns (locked by OpenClaw interface)
interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}
```

### Scoring Function

```typescript
// Default weights (D6)
const DEFAULT_WEIGHTS = {
  similarity:  0.40,
  recency:     0.25,
  provenance:  0.20,
  accessFreq:  0.15,
} as const;

// Skill-specific weights (D7)
const SKILL_WEIGHTS = {
  similarity:   0.20,
  recency:      0.00,  // skills don't decay
  provenance:   0.10,
  accessFreq:   0.30,
  teachability:  0.40,
} as const;

// Recency half-lives per tier
const HALF_LIFE_DAYS: Record<MemoryTier, number> = {
  episodes: 7,
  concepts: 90,
  skills:   Infinity,  // no decay
  entities: 30,
};

const PROVENANCE_SCORES: Record<string, number> = {
  user:  1.0,
  tool:  0.85,
  file:  0.75,
  web:   0.70,
  model: 0.60,
};

function scoreCandidate(
  candidate: RetrievalCandidate,
  queryEmbedding: number[],
  now: Date,
): ScoredCandidate {
  const sim = cosineSimilarity(candidate.embedding, queryEmbedding);
  const rec = recencyDecay(candidate.createdAt, now, HALF_LIFE_DAYS[candidate.tier]);
  const prov = PROVENANCE_SCORES[candidate.provenanceKind] ?? 0.5;
  const acc = accessFrequencyScore(candidate.accessCount, candidate.lastAccessed, now);

  let score: number;
  let breakdown: ScoredCandidate['scoreBreakdown'];

  if (candidate.tier === 'skills' && candidate.teachability != null) {
    const teach = candidate.teachability / 10; // normalize 0-10 to 0-1
    score =
      SKILL_WEIGHTS.similarity * sim +
      SKILL_WEIGHTS.recency * rec +
      SKILL_WEIGHTS.provenance * prov +
      SKILL_WEIGHTS.accessFreq * acc +
      SKILL_WEIGHTS.teachability * teach;
    breakdown = { similarity: sim, recency: rec, provenance: prov, accessFrequency: acc, teachability: teach };
  } else {
    score =
      DEFAULT_WEIGHTS.similarity * sim +
      DEFAULT_WEIGHTS.recency * rec +
      DEFAULT_WEIGHTS.provenance * prov +
      DEFAULT_WEIGHTS.accessFreq * acc;
    breakdown = { similarity: sim, recency: rec, provenance: prov, accessFrequency: acc };
  }

  return { ...candidate, score, scoreBreakdown: breakdown };
}

function recencyDecay(createdAt: Date, now: Date, halfLifeDays: number): number {
  if (!isFinite(halfLifeDays)) return 1.0;
  const ageDays = (now.getTime() - createdAt.getTime()) / 86_400_000;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

function accessFrequencyScore(accessCount: number, lastAccessed: Date | null, now: Date): number {
  if (!lastAccessed) return 0;
  const recencyBonus = recencyDecay(lastAccessed, now, 14);
  return Math.min(1.0, Math.log(1 + accessCount) / Math.log(50)) * recencyBonus;
}

function cosineSimilarity(a: number[], b: number[]): number {
  // Computed in pgvector via `1 - (a <=> b)` for ANN queries.
  // In-process fallback for re-scoring if needed.
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

### Critic Gate

```typescript
function criticFilter(candidates: ScoredCandidate[], alreadySelected: ScoredCandidate[]): ScoredCandidate[] {
  return candidates.filter(c => {
    // Hard rules (LOCKED)
    if (c.utilityPrior === 'discard') return false;
    if (c.confidence < 0.3) return false;
    if (c.isActive === false) return false;

    // Soft rules
    // Deduplicate: skip if cosine distance < 0.05 to already-selected item
    for (const selected of alreadySelected) {
      if (cosineSimilarity(c.embedding, selected.embedding) > 0.95) return false;
    }
    // Flag low-confidence model-provenance items
    if (c.provenanceKind === 'model' && c.confidence < 0.6) return false;

    return true;
  });
}
```

### Greedy Packing

```typescript
function pack(candidates: ScoredCandidate[], budget: number, mode: AssemblyMode): InjectedMemory[] {
  // Sort by score descending
  const sorted = [...candidates].sort((a, b) => b.score - a.score);

  // D27: psycho-genius over-budget strategy
  // If mode is psycho-genius and speculative items present, they are at the end
  // (lower scored), so they naturally get sacrificed first by greedy packing.

  const selected: InjectedMemory[] = [];
  let remaining = budget;

  for (const item of sorted) {
    if (item.tokenCount <= remaining) {
      selected.push({
        id: item.id,
        tier: item.tier,
        content: item.content,
        score: item.score,
        tokenCount: item.tokenCount,
      });
      remaining -= item.tokenCount;
    }
    // Continue scanning -- smaller items may still fit
  }

  return selected;
}
```

---

## 7. Extraction Prompt Structure

### TypeScript Types

```typescript
// Fact extraction output
interface FactExtractionResult {
  items: ExtractedItem[];
}

interface ExtractedItem {
  type: 'fact' | 'preference' | 'decision' | 'plan' | 'anomaly' | 'ephemeral';
  content: string;
  utility: 'high' | 'medium' | 'low' | 'discard';
  provenance_kind: 'user' | 'tool' | 'model';
  tags: string[];
  ephemeral_ttl_hours: number | null;
}

// Entity extraction output
interface EntityExtractionResult {
  entities: ExtractedEntity[];
  relationships: ExtractedRelationship[];
}

interface ExtractedEntity {
  name: string;
  type: 'person' | 'org' | 'project' | 'tool' | 'location' | 'concept';
  canonical: string;
}

interface ExtractedRelationship {
  source: string;      // canonical name of source entity
  target: string;      // canonical name of target entity
  relationship: 'works_at' | 'knows' | 'manages' | 'is_a' | 'owns' | 'uses' | 'part_of' | 'related_to';
}

// Prompt template type
interface PromptTemplate {
  version: string;      // e.g. "fact_extraction_v1"
  template: string;     // prompt text with {date} and {serialized_turn} placeholders
}
```

### Prompt Versioning

Prompts live in `packages/usme-core/src/prompts/`. Each prompt exports a `PromptTemplate` object. The `version` string is written to `sensory_trace.extractor_ver` on every extracted item, enabling evaluation of prompt changes over time.

Two prompts ship with v1:
- `fact-extraction.ts` -- `FACT_EXTRACTION_V1`
- `entity-extraction.ts` -- `ENTITY_EXTRACTION_V1`

Both prompts run as separate parallel Haiku calls (D9). The serialized turn strips system messages and includes only user message + tool calls + model response.

---

## 8. Shadow Mode Harness Design

### Architecture

```
                    OpenClaw turn
                         |
                    +----+----+
                    |         |
               LCM serves    USME assembles (parallel)
               (model sees)  (logged, discarded)
                    |         |
                    v         v
              model response  shadow_comparisons row
```

### Shadow Harness (usme-openclaw/src/shadow.ts)

```typescript
interface ShadowHarness {
  // Called on every turn when mode='shadow'
  compareAssembly(params: {
    sessionId: string;
    turnIndex: number;
    queryPreview: string;
    lcmResult: { messages: AgentMessage[]; tokenCount: number; latencyMs: number };
    usmeResult: { messages: AgentMessage[]; tokenCount: number; latencyMs: number; metadata: AssembleMetadata };
  }): Promise<void>;

  // Secondary analysis: run on completed turns to assess relevance
  analyzeRelevance(params: {
    comparisonId: string;
    usmeItems: InjectedMemory[];
    modelResponse: string;
  }): Promise<void>;
}
```

### Relevance Signal (D17)

V1 uses embedding similarity only (no model call):
1. For each USME-injected memory item, compute cosine similarity against model response embedding
2. If any item similarity > 0.65, mark `usme_memory_cited = true`
3. Store max similarity as `usme_relevance_score`

### Promotion Criteria

All must pass before `mode: shadow` to `mode: active`:

| Criterion | Threshold |
|-----------|-----------|
| Shadow turns collected | >= 500 |
| P95 assembly latency | <= 150ms |
| Extraction success rate | >= 95% |
| Extraction quality (medium/high utility) | >= 60% |
| Relevance signal (memories cited) | >= 50% |
| Critical errors in hot path | 0 |

---

## 9. Per-Mode Parameter Sets (D23)

```typescript
type AssemblyMode = 'psycho-genius' | 'brilliant' | 'smart-efficient';

interface AssemblyModeProfile {
  tokenBudgetFraction: number;
  sessionHistoryFraction: number;
  minInclusionScore: number;
  minConfidence: number;
  candidatesPerTier: number;
  tiersEnabled: MemoryTier[];
  slidingWindowTurns: number;
  slidingWindowTokens: number;
  includeSpeculative: boolean;
  speculativeMaxCount: number;
}

const MODE_PROFILES: Record<AssemblyMode, AssemblyModeProfile> = {
  'psycho-genius': {
    tokenBudgetFraction: 0.45,
    sessionHistoryFraction: 0.55,
    minInclusionScore: 0.15,
    minConfidence: 0.3,
    candidatesPerTier: 30,
    tiersEnabled: ['episodes', 'concepts', 'skills', 'entities'],
    slidingWindowTurns: 30,
    slidingWindowTokens: 50000,
    includeSpeculative: true,
    speculativeMaxCount: 10,
  },
  'brilliant': {
    tokenBudgetFraction: 0.35,
    sessionHistoryFraction: 0.65,
    minInclusionScore: 0.30,
    minConfidence: 0.5,
    candidatesPerTier: 20,
    tiersEnabled: ['episodes', 'concepts', 'skills'],
    slidingWindowTurns: 20,
    slidingWindowTokens: 30000,
    includeSpeculative: false,
    speculativeMaxCount: 0,
  },
  'smart-efficient': {
    tokenBudgetFraction: 0.25,
    sessionHistoryFraction: 0.75,
    minInclusionScore: 0.50,
    minConfidence: 0.7,
    candidatesPerTier: 10,
    tiersEnabled: ['concepts', 'skills'],
    slidingWindowTurns: 10,
    slidingWindowTokens: 15000,
    includeSpeculative: false,
    speculativeMaxCount: 0,
  },
};
```

Mode selection precedence (D25): `per-turn param > session override > config default`. All programmatic for v1.

D26 resolved: Only inclusion threshold and candidatesPerTier vary per mode. The scoring formula weights (D6, D7) remain constant across modes.

D27 resolved: When psycho-genius exceeds budget, greedy packing naturally drops lowest-scored items. Speculative items (low confidence, low score) are dropped first because they score lowest.

---

## 10. Test Setup

### vitest.config.ts (unit tests)

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.integration.test.ts'],
  },
});
```

### vitest.integration.config.ts (integration tests)

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    setupFiles: ['./test/setup-db.ts'],
    testTimeout: 30000,
  },
});
```

### docker-compose.test.yml

```yaml
services:
  db-test:
    image: timescale/timescaledb-ha:pg16
    environment:
      POSTGRES_DB: usme_test
      POSTGRES_USER: usme
      POSTGRES_PASSWORD: usme_test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data
```

### Test categories

**Unit tests** (no DB required):
- `score.test.ts` -- selection formula, recency decay at t=0/half_life/3x, provenance scoring
- `pack.test.ts` -- greedy packing, budget enforcement, skip-and-continue behavior
- `critic.test.ts` -- discard/low-confidence/soft-deleted filtering, dedup detection
- `queue.test.ts` -- in-process FIFO ordering, error handling

**Integration tests** (ephemeral Postgres via docker-compose.test.yml):
- `assemble.integration.test.ts` -- insert test data, call assemble(), verify AssembleResult structure
- `extract.integration.test.ts` -- run extraction on test turn, verify sensory_trace rows
- `entity-dedup.integration.test.ts` -- insert entity, re-extract, verify no duplicate
- `consolidate.integration.test.ts` -- episode compression, idempotency

**Shadow mode tests**:
- `shadow.test.ts` -- comparison logging, graceful degradation (assemble() throws -> LCM fallback)

---

## 11. Docker Compose (Dev)

```yaml
# docker-compose.yml
services:
  db:
    image: timescale/timescaledb-ha:pg16
    environment:
      POSTGRES_DB: usme
      POSTGRES_USER: usme
      POSTGRES_PASSWORD: usme_dev
    ports:
      - "5432:5432"
    volumes:
      - usme_data:/var/lib/postgresql/data

volumes:
  usme_data:
```

---

## 12. OpenClaw Integration Summary

### ContextEngine Implementation

```typescript
// packages/usme-openclaw/src/plugin.ts

const usmeContextEngine: ContextEngine = {
  info: {
    id: 'usme-claw',
    name: 'USME Context Engine',
    version: '0.1.0',
    ownsCompaction: true,
  },

  async bootstrap({ sessionId, sessionFile }) {
    // Initialize session in USME. Import existing history if migrating.
    // Returns BootstrapResult.
  },

  async ingest({ sessionId, message, isHeartbeat }) {
    // Write verbatim message to sensory_trace (fast, synchronous write).
    // Skip heartbeats.
  },

  async ingestBatch({ sessionId, messages, isHeartbeat }) {
    // Batch write to sensory_trace.
  },

  async afterTurn({ sessionId, sessionFile, messages, prePromptMessageCount }) {
    // Enqueue async extraction jobs (fact + entity) via in-process queue.
    // Return immediately (non-blocking).
  },

  async assemble({ sessionId, messages, tokenBudget }) {
    // HOT PATH (<150ms P95):
    // 1. Determine mode (per-turn > session > config default)
    // 2. Compute budget split (session history vs cross-session)
    // 3. Build sliding window from messages[] (mode-dependent turns/tokens)
    // 4. Parallel ANN retrieval across enabled tiers
    // 5. Score all candidates
    // 6. Critic filter
    // 7. Greedy pack into cross-session budget
    // 8. Convert InjectedMemory[] + sliding window to AgentMessage[]
    // 9. Return { messages, estimatedTokens, systemPromptAddition }
  },

  async compact({ sessionId, sessionFile, tokenBudget, force }) {
    // Reinterpret as on-demand episode flush.
    await triggerOnDemandEpisodeCompression(sessionId);
    return {
      ok: true,
      compacted: false,
      reason: 'USME assembles within token budget by design. Triggered on-demand episode compression.',
      result: { tokensBefore: 0, tokensAfter: 0 },
    };
  },

  async prepareSubagentSpawn({ parentSessionKey, childSessionKey, ttlMs }) {
    // Scope memory access to childSessionKey.
    // Optionally inherit parent's top concepts as initial context.
  },

  async onSubagentEnded({ childSessionKey, reason }) {
    // Merge any valuable subagent traces back into parent scope.
  },

  async dispose() {
    // Drain extraction queue, close DB pool.
  },
};
```
