# USME Memory Innovation — Architecture Design
_Architect: Claude Sonnet 4.6 · April 9, 2026_

This document is the authoritative design spec for all agents implementing the USME memory innovation plan. Read it before touching any file. Every decision here was made after reading the full existing codebase.

---

## Table of Contents

1. [DB Schema Changes](#1-db-schema-changes)
2. [TypeScript Interface Changes](#2-typescript-interface-changes)
3. [Memory Reflection Service](#3-memory-reflection-service)
4. [Spreading Activation](#4-spreading-activation)
5. [CLI: openclaw usme reflect](#5-cli-openclaw-usme-reflect)
6. [Skill Candidate Delivery Cron](#6-skill-candidate-delivery-cron)
7. [usme-dashboard Project Structure](#7-usme-dashboard-project-structure)
8. [nightly.ts Changes](#8-nightlyts-changes)
9. [queries.ts Changes](#9-queriests-changes)
10. [Edge Cases and Risks](#10-edge-cases-and-risks)

---

## 1. DB Schema Changes

Migrations go in `packages/usme-core/db/migrations/`. The existing migrations are numbered 001–009. New migrations start at 010 and are applied in order by `npm run migrate`.

### Migration 010 — `010_episode_importance.sql`

Adds the `importance_score` column to `episodes`. This is the unblocking change for skill creation.

```sql
ALTER TABLE episodes
  ADD COLUMN importance_score INTEGER NOT NULL DEFAULT 5
    CHECK (importance_score >= 1 AND importance_score <= 10);

CREATE INDEX idx_episodes_importance ON episodes (importance_score DESC)
  WHERE importance_score >= 7;
```

**Notes:**
- Default 5 (middle of scale) means existing episodes are neither promoted nor excluded by the new gate.
- The CHECK constraint enforces the 1–10 scale at the DB layer, not just in application code.
- The partial index on `importance_score >= 7` directly supports the `stepSkillDraft` query.

### Migration 011 — `011_reflection_log.sql`

Reflection run log table. One row per `runReflection()` invocation, whether triggered by cron or CLI.

```sql
CREATE TABLE reflection_runs (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  trigger_source         TEXT        NOT NULL, -- 'cron' | 'cli' | 'api'
  model                  TEXT        NOT NULL,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  duration_ms            INTEGER,
  concepts_updated       INTEGER     NOT NULL DEFAULT 0,
  skills_created         INTEGER     NOT NULL DEFAULT 0,
  contradictions_resolved INTEGER    NOT NULL DEFAULT 0,
  entities_updated       INTEGER     NOT NULL DEFAULT 0,
  episodes_promoted      INTEGER     NOT NULL DEFAULT 0,
  overall_assessment     TEXT,
  status                 TEXT        NOT NULL DEFAULT 'running', -- 'running' | 'complete' | 'failed'
  rolled_back            BOOLEAN     NOT NULL DEFAULT false
);

CREATE INDEX idx_reflection_runs_triggered ON reflection_runs (triggered_at DESC);
CREATE INDEX idx_reflection_runs_status    ON reflection_runs (status);
```

**Column rationale:**
- `trigger_source`: distinguishes scheduled runs from manual CLI invocations for debugging.
- `input_tokens` / `output_tokens`: required for cost tracking and corpus-size observability.
- `duration_ms`: logged by each phase; total written at run completion.
- `rolled_back`: set true when the transaction was rolled back due to any step failure.
- `status`: starts as `'running'`, updated to `'complete'` or `'failed'` in the same transaction.

### Migration 012 — `012_skill_candidates.sql`

Stores LLM-proposed skills with confidence below 0.7 (high-confidence candidates are written directly to the `skills` table). Also stores any skill the reflection service proposes regardless of confidence, so the human review loop always has full visibility.

```sql
CREATE TABLE skill_candidates (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  description       TEXT        NOT NULL,
  trigger_pattern   TEXT        NOT NULL,
  steps             JSONB       NOT NULL DEFAULT '[]',
  source_episode_ids UUID[]     NOT NULL DEFAULT '{}',
  confidence        NUMERIC(4,3) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reflection_run_id UUID        REFERENCES reflection_runs(id),
  approval_status   TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
  accepted          BOOLEAN,
  accepted_at       TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_skill_candidates_status     ON skill_candidates (approval_status, created_at DESC);
CREATE INDEX idx_skill_candidates_confidence ON skill_candidates (confidence DESC);
CREATE INDEX idx_skill_candidates_run        ON skill_candidates (reflection_run_id);
```

**Notes:**
- `steps` is JSONB array of `{ step: number, action: string, notes?: string }` objects.
- `trigger_pattern` is a short phrase describing when to invoke the skill (e.g., "when setting up a new TypeScript project").
- `reflection_run_id` is a nullable FK — skill candidates can also be created by the daily cron outside of a reflection run.
- When `accepted = true`, the delivery cron copies the row into `skills` with `status = 'active'`.

### Migration 013 — `013_exclude_flags.sql`

Privacy scaffold. Adds `exclude_from_reflection` to all four content tables. Nothing is excluded by default.

```sql
ALTER TABLE sensory_trace ADD COLUMN exclude_from_reflection BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE episodes       ADD COLUMN exclude_from_reflection BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE concepts       ADD COLUMN exclude_from_reflection BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE entities       ADD COLUMN exclude_from_reflection BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial indexes to make corpus assembly queries efficient
CREATE INDEX idx_sensory_exclude ON sensory_trace (created_at DESC) WHERE exclude_from_reflection = FALSE;
CREATE INDEX idx_episodes_exclude ON episodes (access_count DESC, created_at DESC) WHERE exclude_from_reflection = FALSE;
CREATE INDEX idx_concepts_exclude ON concepts (created_at DESC) WHERE is_active = TRUE AND exclude_from_reflection = FALSE;
CREATE INDEX idx_entities_exclude ON entities (created_at DESC) WHERE exclude_from_reflection = FALSE;
```

**Migration order is critical.** Migration 012 references `reflection_runs(id)` — 011 must run first. 013 is independent and can run after 010.

---

## 2. TypeScript Interface Changes

### `packages/usme-core/src/schema/types.ts`

Add `importance_score` to the `Episode` interface:

```typescript
export interface Episode {
  id: string;
  session_ids: string[];
  time_bucket: Date;
  summary: string;
  embedding: number[] | null;
  source_trace_ids: string[];
  token_count: number | null;
  utility_score: number;
  importance_score: number;      // NEW — integer 1-10, default 5
  access_count: number;
  last_accessed: Date | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}
```

Add two new interfaces at the bottom of `schema/types.ts`:

```typescript
export interface ReflectionRun {
  id: string;
  triggered_at: Date;
  trigger_source: 'cron' | 'cli' | 'api';
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  concepts_updated: number;
  skills_created: number;
  contradictions_resolved: number;
  entities_updated: number;
  episodes_promoted: number;
  overall_assessment: string | null;
  status: 'running' | 'complete' | 'failed';
  rolled_back: boolean;
}

export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  trigger_pattern: string;
  steps: Array<{ step: number; action: string; notes?: string }>;
  source_episode_ids: string[];
  confidence: number;
  reflection_run_id: string | null;
  approval_status: 'pending' | 'accepted' | 'rejected';
  accepted: boolean | null;
  accepted_at: Date | null;
  rejected_at: Date | null;
  created_at: Date;
}
```

### `packages/usme-openclaw/src/index.ts`

Extend `InjectionLogEntry` with optional spreading fields. These fields are `undefined` (absent from the JSON) when spreading is disabled (depth=0):

```typescript
interface InjectionLogEntry {
  ts: string;
  sessionId: string;
  mode: string;
  itemsSelected: number;
  itemsConsidered: number;
  tiersQueried: string[];
  tokensInjected: number;
  durationMs: number;
  injected: boolean;
  contextBlock: string;
  // Spreading activation fields (present only when spreading.maxDepth > 0)
  spreadingDepth?: number;
  entitiesMatched?: number;
  episodesAdded?: number;
}
```

### `packages/usme-openclaw/src/config.ts`

Add a `SpreadingConfig` interface and wire it into `UsmePluginConfig`:

```typescript
export interface SpreadingConfig {
  maxDepth: number;     // 0 = disabled (no-op), default 2
  maxAdditional: number; // cap on extra episodes added, default 10
}

export interface UsmePluginConfig {
  // ... existing fields ...
  spreading: SpreadingConfig;
}

export const DEFAULT_CONFIG: UsmePluginConfig = {
  // ... existing defaults ...
  spreading: {
    maxDepth: 2,
    maxAdditional: 10,
  },
};
```

The `resolveConfig()` function must merge `spreading` with the same pattern as other nested configs.

---

## 3. Memory Reflection Service

### File: `packages/usme-core/src/consolidate/reflect.ts`

This is a new file. It exports one public function: `runReflection()`.

#### Public API

```typescript
export interface ReflectionOptions {
  model?: string;           // default: 'claude-sonnet-4-6' (matches nightly.ts)
  dryRun?: boolean;         // if true: assemble corpus, call LLM, log results, but skip all DB writes
  verbose?: boolean;        // if true: log full corpus assembly details via pino
  tier?: 'all' | 'concepts' | 'episodes'; // scope limiter (v1 only implements 'all')
  triggerSource: 'cron' | 'cli' | 'api';
}

export interface ReflectionResult {
  runId: string;
  conceptsUpdated: number;
  skillsCreated: number;
  contradictionsResolved: number;
  entitiesUpdated: number;
  episodesPromoted: number;
  overallAssessment: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  status: 'complete' | 'failed';
  rolledBack: boolean;
}

export async function runReflection(
  client: Anthropic,
  pool: pg.Pool,
  options: ReflectionOptions,
): Promise<ReflectionResult>
```

#### Phase 1: Corpus Assembly

Query the DB for all content, filtering `exclude_from_reflection = FALSE` on each table. The corpus assembly is a single async fetch across all tiers in parallel:

```sql
-- Active concepts
SELECT id, content, concept_type, confidence, tags
FROM concepts
WHERE is_active = TRUE AND exclude_from_reflection = FALSE
ORDER BY utility_score DESC;

-- Top 60 episodes by access_count + recency composite score
SELECT id, summary, importance_score, access_count, last_accessed, created_at
FROM episodes
WHERE exclude_from_reflection = FALSE
ORDER BY (access_count * 2 + EXTRACT(EPOCH FROM (now() - created_at)) / -86400.0) DESC
LIMIT 60;

-- Recent sensory traces (last 48h, up to 500 rows)
SELECT id, content, memory_type, created_at
FROM sensory_trace
WHERE exclude_from_reflection = FALSE
  AND created_at > now() - INTERVAL '48 hours'
ORDER BY created_at DESC
LIMIT 500;

-- All entities + relationships
SELECT e.id, e.name, e.entity_type, e.canonical,
       er.relationship, er.confidence as rel_confidence,
       er2.name as target_name
FROM entities e
LEFT JOIN entity_relationships er ON er.source_id = e.id AND er.valid_until IS NULL
LEFT JOIN entities er2 ON er.target_id = er2.id
WHERE e.exclude_from_reflection = FALSE
ORDER BY e.created_at ASC;
```

#### Token Estimation

Use the `countTokens()` utility already in `packages/usme-core/src/tokenize.ts` (which does `Math.ceil(text.length / 4)` as an approximation). Sum tokens across all corpus items.

Log the token count before every LLM call:

```typescript
const estimatedTokens = corpus.totalTokens;
log.info({
  estimatedTokens,
  threshold: 350_000,
  mode: estimatedTokens < 350_000 ? 'full-corpus' : 'tiered (NOT IMPLEMENTED — would skip)',
}, 'reflection corpus token estimate');

if (estimatedTokens >= 350_000) {
  log.warn('Corpus exceeds 350K token threshold. Tiered mode not yet implemented. Proceeding with full corpus — REVIEW COST.');
}
```

This satisfies the requirement that the threshold check is logged on every run so v2 tiered mode can be added without rearchitecting.

#### Phase 2: LLM Call

Use tool_use with a single tool (`reflect_on_memory`), consistent with the `nightly.ts` pattern. The tool schema accepts all output types in one call to minimize round-trips:

```typescript
const ReflectionOutputSchema = z.object({
  concept_updates: z.array(z.object({
    concept_id: z.string(),
    action: z.enum(['raise_importance', 'lower_importance', 'deprecate', 'merge']),
    merge_target_id: z.string().optional(),
    reasoning: z.string(),
  })),
  new_skills: z.array(z.object({
    name: z.string(),
    description: z.string(),
    trigger_pattern: z.string(),
    steps: z.array(z.object({ step: z.number(), action: z.string(), notes: z.string().optional() })),
    source_episode_ids: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  })),
  contradictions: z.array(z.object({
    concept_id_a: z.string(),
    concept_id_b: z.string(),
    keep: z.enum(['a', 'b', 'merge']),
    merged_content: z.string().optional(),
    reasoning: z.string(),
  })),
  promotion_candidates: z.array(z.object({
    episode_id: z.string(),
    proposed_concept_content: z.string(),
    concept_type: z.enum(['fact', 'preference', 'decision', 'relationship_summary']),
    reasoning: z.string(),
  })),
  entity_relationship_updates: z.array(z.object({
    action: z.enum(['add', 'soft_delete', 'reclassify']),
    source_entity_id: z.string(),
    target_entity_id: z.string(),
    relationship: z.string(),
    existing_rel_id: z.string().optional(),
    reasoning: z.string(),
  })),
  entity_corrections: z.array(z.object({
    entity_id: z.string(),
    field: z.enum(['entity_type', 'canonical']),
    new_value: z.string(),
    reasoning: z.string(),
  })),
  overall_assessment: z.string(),
});
```

The LLM prompt assembles all corpus items into a structured block and asks Sonnet to analyze memory health across all dimensions. The system prompt is:

> "You are a memory health analyst reviewing Alex's personal AI memory system. Your job is to identify patterns, contradictions, and opportunities for improvement across all stored memories. Be precise: reference specific concept IDs and episode IDs in your output. All IDs you reference must exist in the corpus provided."

#### Phase 3: Writes (Single Transaction)

All DB writes occur inside one `BEGIN / COMMIT` block. If any write fails, the entire transaction is rolled back and the run is logged as `status='failed', rolled_back=true`.

**Execution order within the transaction:**

1. Insert `reflection_runs` row with `status='running'` — get back the `run_id`.
2. Process `concept_updates`:
   - `raise_importance` / `lower_importance`: UPDATE `concepts SET utility_score = ...` (nudge by ±0.1, clamped 0–1).
   - `deprecate`: call `deactivateConcept()` from `queries.ts` (sets `is_active=false, superseded_by=concept_id`).
   - `merge`: call `insertConcept()` for the merged concept, then `deactivateConcept()` for both source IDs — identical pattern to `stepContradictions` in `nightly.ts`.
3. Process `contradictions`: same deactivation pattern as `stepContradictions`.
4. Process `promotion_candidates`: call `insertConcept()` for each, setting `metadata.promoted_by_reflection=run_id`.
5. Process `new_skills`:
   - If `confidence >= 0.7`: call `insertSkill()` from `queries.ts` with `status='candidate'`.
   - If `confidence < 0.7`: INSERT into `skill_candidates` table.
6. Process `entity_relationship_updates`:
   - `add`: call `insertEntityRelationship()` from `queries.ts`.
   - `soft_delete`: `UPDATE entity_relationships SET valid_until = now() WHERE id = $1`.
   - `reclassify`: UPDATE `entity_relationships SET relationship = $2 WHERE id = $1`.
7. Process `entity_corrections`: `UPDATE entities SET entity_type = $2 / canonical = $2 WHERE id = $1`.
8. UPDATE the `reflection_runs` row: set `status='complete'`, write all counts and `overall_assessment`.

**Transaction pseudocode:**

```typescript
const pgClient = await pool.connect();
try {
  await pgClient.query('BEGIN');
  // ... all writes ...
  await pgClient.query('COMMIT');
} catch (err) {
  await pgClient.query('ROLLBACK');
  // UPDATE reflection_runs SET status='failed', rolled_back=true WHERE id=$runId
  // (this UPDATE runs outside the failed transaction using pool directly)
  throw err;
} finally {
  pgClient.release();
}
```

Note: the `reflection_runs` insert (step 1) uses `pool.query()` directly so the run row exists even if the transaction is later rolled back. The status update to `'failed'` / `'complete'` is the final act.

#### Pino Logging (per phase)

```typescript
log.info({ phase: 'fetch', counts: { concepts, episodes, traces, entities }, durationMs }, 'reflection corpus assembled');
log.info({ phase: 'llm_call', model, inputTokens, outputTokens, durationMs }, 'reflection LLM complete');
log.info({ phase: 'consume', conceptsUpdated, skillsCreated, contradictionsResolved, entitiesUpdated, episodesPromoted }, 'reflection writes applied');
log.info({ phase: 'done', totalDurationMs, status, rolledBack }, 'reflection run complete');
```

#### Scheduler Integration

In `packages/usme-core/src/consolidate/scheduler.ts`, add two cron entries using `node-cron`'s built-in timezone support:

```typescript
// 08:00 Pacific = 16:00 UTC (summer) / 15:00 UTC (winter)
// node-cron supports IANA timezone names directly
const reflectionMorning = cron.schedule('0 8 * * *', async () => {
  await runReflection(client, pool, { triggerSource: 'cron', model: config.sonnetModel });
}, { timezone: 'America/Los_Angeles' });

const reflectionEvening = cron.schedule('0 20 * * *', async () => {
  await runReflection(client, pool, { triggerSource: 'cron', model: config.sonnetModel });
}, { timezone: 'America/Los_Angeles' });
```

Add `reflectionMorning.stop()` and `reflectionEvening.stop()` to the `stop()` function on `SchedulerHandle`.

The `SchedulerConfig` interface must be extended with an optional `reflectionModel?: string` field.

---

## 4. Spreading Activation

### File: `packages/usme-openclaw/src/spread.ts` (new file)

This module adds a second retrieval pass after `retrieve()` returns, walking the entity relationship graph.

#### Public API

```typescript
import type { Pool } from 'pg';
import type { RetrievalCandidate } from '@usme/core';

export interface SpreadingConfig {
  maxDepth: number;    // 0 = no-op
  maxAdditional: number; // cap on episodes added
}

export async function spreadingActivation(
  candidates: RetrievalCandidate[],
  pool: Pool,
  config: SpreadingConfig,
): Promise<{
  combined: RetrievalCandidate[];
  entitiesMatched: number;
  episodesAdded: number;
}>;
```

#### Algorithm

**Depth 0 (no-op):** If `config.maxDepth === 0`, return immediately with the input candidates unchanged, `entitiesMatched: 0, episodesAdded: 0`.

**Step 1 — Extract entity mentions from candidates:**

```sql
-- For each candidate item, find entity names/canonicals that appear in the content.
-- Batch query: find entities whose name or canonical is a substring of any candidate content.
SELECT id, name, canonical
FROM entities
WHERE name = ANY($1::text[])  -- $1 = array of words/phrases extracted from candidate content
   OR canonical = ANY($1::text[])
LIMIT 100
```

Content preprocessing: tokenize candidate `content` fields by splitting on whitespace and punctuation, deduplicate tokens, filter tokens shorter than 3 characters. This is a best-effort match — false positives are acceptable since the score() pass filters by relevance.

**Step 2 — Walk entity_relationships up to maxDepth hops:**

For each depth level, collect all entity IDs reachable from the current frontier:

```sql
-- One hop from entity set $1
SELECT DISTINCT
  CASE WHEN source_id = ANY($1) THEN target_id ELSE source_id END AS connected_id
FROM entity_relationships
WHERE (source_id = ANY($1) OR target_id = ANY($1))
  AND valid_until IS NULL
```

Repeat up to `maxDepth` times, accumulating a visited set to avoid cycles. The frontier for hop N is the new entity IDs discovered in hop N-1.

**Step 3 — Pull episodes referencing matched entities:**

USME does not have a direct `episode_entities` join table, so the approach is content-based: search the episodes table for summaries containing any matched entity name or canonical (using PostgreSQL `ILIKE ANY` or full-text search). Cap at `config.maxAdditional * 3` to allow the subsequent score() pass to cull:

```sql
SELECT id, 'episodes' AS tier, summary AS content, embedding, token_count,
       created_at, 'user' AS provenance_kind, 'medium' AS utility_prior,
       1.0 AS confidence, true AS is_active, access_count, last_accessed,
       NULL AS teachability, '{}' AS tags,
       0.5 AS similarity  -- placeholder; will be re-scored
FROM episodes
WHERE embedding IS NOT NULL
  AND (
    summary ILIKE ANY($1::text[])  -- $1 = array of '%entity_name%' patterns
  )
  AND id != ALL($2::uuid[])  -- exclude already-in-pool IDs
ORDER BY access_count DESC, created_at DESC
LIMIT $3
```

**Step 4 — Map SQL rows to RetrievalCandidate and return:**

The returned candidates are appended to the existing pool. The `similarity` field is set to 0.5 as a placeholder — `score()` in `score.ts` will recompute the final relevance ranking across the entire combined pool.

#### Integration in `index.ts`

In the `before_prompt_build` hook, after `coreAssemble()` returns, call spreading activation. `coreAssemble()` internally calls `retrieve()` then `score()` then `pack()`. The spreading pass must intercept between `retrieve()` and `score()`.

This requires either:
- Exporting `retrieve()` from `@usme/core` separately and calling it directly in `index.ts`, OR
- Adding an optional `spreadingActivation` hook parameter to `coreAssemble()` that is called between retrieve and score.

**Chosen approach:** Add an optional `onCandidatesRetrieved` callback to `AssembleRequest` (or as an additional option to `coreAssemble()`). The callback receives the raw candidate pool, calls `spreadingActivation()`, and returns the augmented pool. This keeps all spreading logic in `usme-openclaw` and avoids modifying `usme-core/src/assemble/retrieve.ts`.

In `index.ts`:

```typescript
const spreadingCfg = config.spreading;
let spreadDepth = 0, entitiesMatched = 0, episodesAdded = 0;

const result = await coreAssemble(
  { query, sessionId, conversationHistory: agentMessages, mode: assemblyMode, tokenBudget, turnIndex: ... },
  {
    pool,
    queryEmbedding,
    onCandidatesRetrieved: spreadingCfg.maxDepth > 0
      ? async (candidates) => {
          const t = performance.now();
          const spread = await spreadingActivation(candidates, pool, spreadingCfg);
          spreadDepth = spreadingCfg.maxDepth;
          entitiesMatched = spread.entitiesMatched;
          episodesAdded = spread.episodesAdded;
          dbg(`spreading: +${spread.episodesAdded} episodes from ${spread.entitiesMatched} entities in ${Math.round(performance.now()-t)}ms`);
          return spread.combined;
        }
      : undefined,
  },
);
```

Then when writing the injection log:

```typescript
writeInjectionLog({
  // ... existing fields ...
  ...(spreadingCfg.maxDepth > 0 && {
    spreadingDepth: spreadDepth,
    entitiesMatched,
    episodesAdded,
  }),
});
```

#### Performance Constraints

- The entire spreading activation must complete within 150ms on a warm DB. If it exceeds this, log a warning but do not fail the turn.
- `maxAdditional` hard cap: 10. Never add more than 10 episodes to the pool from spreading.
- Depth 0 is a strict no-op with zero latency overhead. Use this for A/B testing.
- If spreading throws any error, catch it, log the error, and return the original unmodified candidates. Never let spreading break the hot path.

---

## 5. CLI: `openclaw usme reflect`

### File: `packages/usme-openclaw/src/commands/reflect.ts` (new file)

```typescript
export async function reflectCommand(args: string[], config: UsmePluginConfig): Promise<void>
```

Parses flags from `args`:

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--model` | `haiku\|sonnet\|opus` | `sonnet` | Maps to Anthropic model alias |
| `--dry-run` | boolean | false | Assemble + call LLM but skip DB writes |
| `--verbose` | boolean | false | Log full corpus item counts per tier |
| `--tier` | `all\|concepts\|episodes` | `all` | Scope limiter (v1: all only) |
| `--status` | boolean | false | Query and display last reflection run |
| `--last` | integer | — | Show last N reflection runs |

Model alias resolution:
- `haiku` → `claude-haiku-4-5`
- `sonnet` → `claude-sonnet-4-6`
- `opus` → `claude-opus-4-5`

`--status` output format (table to stdout):
```
Last reflection run:
  ID:           <uuid>
  Triggered at: 2026-04-09 08:00:12 PDT
  Source:       cron
  Model:        claude-sonnet-4-6
  Status:       complete
  Tokens:       42,180 in / 3,210 out
  Duration:     18.4s
  Changes:
    Concepts updated:         3
    Skills created:           1
    Contradictions resolved:  0
    Entities updated:         2
    Episodes promoted:        1
  Assessment: <overall_assessment text>
```

### Registration in `index.ts`

The command is registered via an `openclaw` CLI extension point. Examine how OpenClaw registers subcommands (look for `registerCommand` or a `commands` export in the plugin API). If OpenClaw doesn't support CLI command registration via plugin API, the `reflect.ts` file is still built into the bundle and invoked by a thin shell wrapper.

---

## 6. Skill Candidate Delivery Cron

### Location: `packages/usme-core/src/consolidate/scheduler.ts`

Add a third cron job in `startScheduler()`:

```typescript
const skillDelivery = cron.schedule('0 9 * * *', async () => {
  await deliverPendingSkillCandidates(pool, client);
}, { timezone: 'America/Los_Angeles' });
```

### Function: `deliverPendingSkillCandidates(pool, client)`

**Query pending candidates:**

```sql
SELECT sc.*, array_agg(e.summary) AS episode_summaries
FROM skill_candidates sc
LEFT JOIN LATERAL unnest(sc.source_episode_ids) AS ep_id ON true
LEFT JOIN episodes e ON e.id = ep_id
WHERE sc.approval_status = 'pending'
GROUP BY sc.id
ORDER BY sc.confidence DESC
LIMIT 20
```

**Message format for each candidate:**

```
SKILL CANDIDATE — Review Required

Name: <name>
Confidence: <confidence> (0.0–1.0)
Trigger: <trigger_pattern>
Description: <description>

Steps:
  1. <step 1 action>
  2. <step 2 action>
  ...

Source episodes (count: N):
  - <episode summary 1 truncated to 100 chars>
  - <episode summary 2 truncated to 100 chars>

Reply "accept" or "reject" to this message.
Candidate ID: <id>
```

**Sending the message:**

In `usme-openclaw/src/index.ts`, messages are sent to Alex via `api.on('before_prompt_build', ...)` but the plugin API does not expose a direct message-send. The OpenClaw messaging API for sending proactive messages is accessed via `api.sendMessage()` or similar — **examine the OpenClaw plugin API docs or source to confirm the exact method name before implementing**.

As a safe fallback: write the pending candidates to `/tmp/usme/skill-candidates.json` and log a pino warning that lists them. This is observable via the dashboard and avoids a hard dependency on an unconfirmed API surface.

**Reply handling:**

OpenClaw will deliver Alex's reply as a new session turn. The reply handler is registered in `index.ts` on the `before_prompt_build` hook. If the last user message matches `^(accept|reject)\s+([0-9a-f-]{36})$` (case-insensitive), extract the candidate ID and update the DB:

```sql
-- On accept:
UPDATE skill_candidates
SET approval_status = 'accepted', accepted = true, accepted_at = now()
WHERE id = $1;

-- Then promote to skills:
INSERT INTO skills (name, description, skill_path, source_episode_ids, teachability, status, metadata)
SELECT name, description,
       'skills/' || lower(replace(name, ' ', '-')) || '.md',
       source_episode_ids,
       confidence::float,
       'active',
       jsonb_build_object('promoted_from_candidate', id, 'promoted_at', now())
FROM skill_candidates WHERE id = $1;

-- On reject:
UPDATE skill_candidates
SET approval_status = 'rejected', accepted = false, rejected_at = now()
WHERE id = $1;
```

---

## 7. usme-dashboard Project Structure

This is a **completely separate project** at `~/ai/projects/rufus-projects/usme-dashboard/`. It does not go inside `usme-claw/` and does not use the `usme-claw` build system.

### `package.json`

```json
{
  "name": "usme-dashboard",
  "version": "1.0.0",
  "description": "USME memory system monitoring dashboard",
  "type": "module",
  "main": "server.ts",
  "scripts": {
    "start": "npx tsx server.ts",
    "dev": "npx tsx --watch server.ts"
  },
  "dependencies": {
    "express": "^4.18.2",
    "pg": "^8.11.3",
    "cors": "^2.8.5"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/pg": "^8.10.9",
    "@types/cors": "^2.8.17",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

### `server.ts`

Express app connecting to the same PostgreSQL database. DB credentials match what the plugin uses (from `DEFAULT_CONFIG` in `config.ts`):

```typescript
import express from 'express';
import cors from 'cors';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'usme_dev',
  user: 'usme',
  password: 'usme_dev',
});

const INJECTION_LOG = process.env.USME_INJECTION_LOG ?? '/tmp/usme/injection.jsonl';
const PORT = process.env.PORT ?? 3456;

// Static files from public/
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, 'public')));
```

### API Endpoints

#### `GET /usme/api/health`

**SQL:**

```sql
SELECT
  (SELECT COUNT(*) FROM sensory_trace)::int            AS sensory_trace_count,
  (SELECT COUNT(*) FROM episodes)::int                 AS episode_count,
  (SELECT COALESCE(SUM(token_count), 0) FROM episodes)::int AS episode_tokens,
  (SELECT COUNT(*) FROM concepts WHERE is_active = TRUE)::int AS concept_count,
  (SELECT COALESCE(SUM(length(content) / 4), 0) FROM concepts WHERE is_active = TRUE)::int AS concept_tokens,
  (SELECT COUNT(*) FROM entities)::int                 AS entity_count,
  (SELECT COUNT(*) FROM skills WHERE status = 'active')::int AS skill_count
```

Last consolidation: query `memory_audit_log ORDER BY run_at DESC LIMIT 1` — surface `run_id` and `run_at`.

Last reflection: query `reflection_runs ORDER BY triggered_at DESC LIMIT 1` (handle table-not-exists with try/catch, return `null`).

Token progress bar: sum all token estimates, compare to 350,000.

**Response shape:**

```json
{
  "counts": { "sensory_trace": 0, "episodes": 0, "concepts": 0, "entities": 0, "skills": 0 },
  "tokenEstimate": 0,
  "tokenThreshold": 350000,
  "tokenPct": 0.0,
  "lastConsolidation": { "runId": "...", "runAt": "2026-04-09T03:00:00Z" },
  "lastReflection": null
}
```

#### `GET /usme/api/injection?limit=N`

Reads from `/tmp/usme/injection.jsonl`. Returns last N lines (default 50). Parse each line as JSON. Handle missing file by returning empty array.

```typescript
app.get('/usme/api/injection', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  try {
    const lines = fs.readFileSync(INJECTION_LOG, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map(l => JSON.parse(l));
    res.json({ entries: lines.reverse() }); // newest first
  } catch {
    res.json({ entries: [] });
  }
});
```

#### `GET /usme/api/reflections?limit=N`

```sql
SELECT id, triggered_at, trigger_source, model,
       input_tokens, output_tokens, duration_ms,
       concepts_updated, skills_created, contradictions_resolved,
       entities_updated, episodes_promoted,
       overall_assessment, status, rolled_back
FROM reflection_runs
ORDER BY triggered_at DESC
LIMIT $1
```

Handle `reflection_runs` table not existing with try/catch — return `{ runs: [], error: 'reflection_runs table not found' }`.

#### `GET /usme/api/skills`

```sql
-- Active skills
SELECT id, name, description, skill_path, teachability, created_at, use_count, last_used
FROM skills
WHERE status = 'active'
ORDER BY use_count DESC, created_at DESC;

-- Pending candidates
SELECT id, name, description, trigger_pattern, confidence,
       array_length(source_episode_ids, 1) AS source_count,
       created_at
FROM skill_candidates
WHERE approval_status = 'pending'
ORDER BY confidence DESC;

-- Approval rate summary
SELECT
  approval_status,
  COUNT(*)::int AS count,
  ROUND(AVG(confidence)::numeric, 3) AS avg_confidence
FROM skill_candidates
GROUP BY approval_status;
```

#### `GET /usme/api/entities/summary`

```sql
-- Count by type
SELECT entity_type, COUNT(*)::int AS count
FROM entities
GROUP BY entity_type
ORDER BY count DESC;

-- 10 most recently created
SELECT id, name, entity_type, canonical, created_at
FROM entities
ORDER BY created_at DESC
LIMIT 10;

-- 10 most connected
SELECT e.id, e.name, e.entity_type,
       COUNT(er.id)::int AS relationship_count
FROM entities e
JOIN entity_relationships er ON (er.source_id = e.id OR er.target_id = e.id)
  AND er.valid_until IS NULL
GROUP BY e.id, e.name, e.entity_type
ORDER BY relationship_count DESC
LIMIT 10;
```

#### `GET /usme/api/scoring`

Handle missing `importance_score` column with try/catch:

```typescript
app.get('/usme/api/scoring', async (req, res) => {
  let histogram: Record<string, number> = {};
  let importanceError: string | null = null;

  try {
    const { rows } = await pool.query(`
      SELECT importance_score, COUNT(*)::int AS count
      FROM episodes
      GROUP BY importance_score
      ORDER BY importance_score
    `);
    for (const row of rows) {
      histogram[String(row.importance_score)] = row.count;
    }
  } catch {
    importanceError = 'importance_score column not yet migrated';
  }

  const { rows: utilityRows } = await pool.query(`
    SELECT
      ROUND(AVG(utility_score)::numeric, 4) AS avg,
      ROUND(MAX(utility_score)::numeric, 4) AS max,
      ROUND(MIN(utility_score)::numeric, 4) AS min,
      COUNT(*)::int AS total
    FROM episodes
  `);

  let eligibilityCount = 0;
  if (!importanceError) {
    const { rows: eligRows } = await pool.query(`
      SELECT COUNT(*)::int AS count FROM episodes WHERE importance_score >= 7
    `);
    eligibilityCount = eligRows[0].count;
  }

  res.json({
    histogram,
    importanceError,
    utility: utilityRows[0],
    skillEligibilityCount: eligibilityCount,
  });
});
```

### `public/index.html`

Single-page app. Six panels using vanilla JS with `fetch()`. No frameworks, no build step.

**Layout:** CSS grid, 3 columns on desktop, 1 column on mobile. Sticky header with "USME Memory Dashboard" title and last-refreshed timestamp.

**Panel 1 — Memory Health** (auto-refresh: 60s)
- 5 count cards (sensory traces, episodes, concepts, entities, skills)
- Token progress bar: `estimatedTokens / 350,000 * 100%`, color: green <50%, yellow <80%, red ≥80%
- Last consolidation: exact Pacific timestamp + run ID
- Last reflection: exact Pacific timestamp + model + status badge (green = complete, red = failed, gray = never)

**Panel 2 — Live Injection Feed** (auto-refresh: 5s)
- Most recent 20 turns in a scrollable list
- Per turn: timestamp (Pacific), items injected, tokens, tiers, latency in ms
- If `spreadingDepth` present: show "ANN: N + Spread: M" for items breakdown
- Expandable row: `contextBlock` preview (first 300 chars, expandable to full)

**Panel 3 — Reflection History** (auto-refresh: 5 min)
- Table: triggered_at (Pacific), model, tokens (in/out), duration, changes, status badge
- Expandable row: full `overall_assessment` text
- If table empty: "No reflection runs yet — run `openclaw usme reflect` to start"

**Panel 4 — Skills** (auto-refresh: 5 min)
- Sub-section A: active skills table (name, trigger from `skill_path`, confidence from `teachability`, use count, created)
- Sub-section B: pending candidates table (name, confidence bar, source episode count, accept/reject buttons)
- Accept/reject buttons call `POST /usme/api/skills/:id/accept` and `/reject` endpoints
- Approval rate summary: 3 count badges (accepted / rejected / pending) with average confidence

**Panel 5 — Entity Graph** (auto-refresh: 5 min)
- Count by type: horizontal bar chart using CSS bar widths (no canvas required)
- 10 most recently created: name, type badge, created timestamp (Pacific)
- 10 most connected: name, type badge, relationship count

**Panel 6 — Importance Distribution** (auto-refresh: 5 min)
- If `importanceError` is set: show placeholder card "Run migration 010 to enable importance scoring"
- Histogram: CSS bar chart, score 1–10 on X axis, count on Y axis
- Utility stats card: avg / max / min
- Skill eligibility count: large number badge "N episodes eligible for skill creation (importance ≥ 7)"

**Pacific time formatting helper:**

```javascript
function toPacific(isoStr) {
  return new Date(isoStr).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}
```

**Skill candidate approval endpoints:**

```typescript
app.post('/usme/api/skills/:id/accept', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE skill_candidates SET approval_status='accepted', accepted=true, accepted_at=now() WHERE id=$1`,
      [id]
    );
    await client.query(
      `INSERT INTO skills (name, description, skill_path, source_episode_ids, teachability, status, metadata)
       SELECT name, description, 'skills/' || lower(replace(name, ' ', '-')) || '.md',
              source_episode_ids, confidence::float, 'active',
              jsonb_build_object('promoted_from_candidate', id::text, 'promoted_at', now()::text)
       FROM skill_candidates WHERE id=$1`,
      [id]
    );
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: String(err) });
  } finally {
    client.release();
  }
});

app.post('/usme/api/skills/:id/reject', async (req, res) => {
  await pool.query(
    `UPDATE skill_candidates SET approval_status='rejected', accepted=false, rejected_at=now() WHERE id=$1`,
    [req.params.id]
  );
  res.json({ ok: true });
});
```

---

## 8. `nightly.ts` Changes

### `stepEpisodify()` — Add Haiku importance scoring

After the episode summary is generated and before `insertEpisode()`, call Haiku via tool_use to score the episode 1–10:

```typescript
const ImportanceSchema = z.object({
  importance_score: z.number().int().min(1).max(10),
  reasoning: z.string(),
});

// After `const summary = ...` line:
const importanceResponse = await client.messages.create({
  model: 'claude-haiku-4-5',
  max_tokens: 256,
  tools: [{
    name: 'score_importance',
    description: 'Score the importance of this episode summary on a 1-10 scale.',
    input_schema: {
      type: 'object' as const,
      properties: {
        importance_score: {
          type: 'integer',
          description: '1=ephemeral noise, 5=moderately useful, 10=critical long-term memory',
          minimum: 1, maximum: 10,
        },
        reasoning: { type: 'string', description: 'One sentence explaining the score' },
      },
      required: ['importance_score', 'reasoning'],
    },
  }],
  tool_choice: { type: 'tool', name: 'score_importance' },
  messages: [{
    role: 'user',
    content: `Score the importance of this memory episode on a scale of 1-10.\n\nConsider:\n- Specificity: is this a concrete, memorable event?\n- Actionability: could this inform future decisions?\n- Uniqueness: is this information not easily re-derivable?\n- Future relevance: will Alex likely need this again?\n\nEpisode:\n${summary}`,
  }],
});

const importanceParsed = ImportanceSchema.safeParse(
  extractToolInput(importanceResponse, 'score_importance')
);
const importanceScore = importanceParsed.success ? importanceParsed.data.importance_score : 5;
log.info({ episodeImportance: importanceScore, reasoning: importanceParsed.success ? importanceParsed.data.reasoning : 'parse failed' }, 'episode importance scored');
```

Pass `importanceScore` into `insertEpisode()`. The `insertEpisode()` function in `queries.ts` must also be updated to accept and write `importance_score`.

### `stepSkillDraft()` — Change the skill gate

Change one line in the existing query:

```sql
-- OLD:
WHERE utility_score >= 0.6

-- NEW:
WHERE importance_score >= 7
```

---

## 9. `queries.ts` Changes

### `insertEpisode()` — Accept importance_score

The function signature changes from:

```typescript
episode: Omit<Episode, "id" | "created_at" | "access_count" | "last_accessed">
```

The `Episode` interface now includes `importance_score`, so the omit list and INSERT statement must include the new column:

```sql
INSERT INTO episodes
  (session_ids, time_bucket, summary, embedding, source_trace_ids,
   token_count, utility_score, importance_score, metadata)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING id
```

### `bumpAccessCounts()` — Write-back utility score for high-access episodes

After the existing episode access_count UPDATE, add a second UPDATE for the utility score write-back:

```sql
-- After the existing access_count bump:
UPDATE episodes
SET utility_score = LEAST(utility_score + 0.05, 1.0)
WHERE id = ANY($1::uuid[])
  AND access_count >= 10
```

The nudge of +0.05 per access beyond the threshold means an episode starting at 0.5 needs at minimum 2 bumps after crossing the threshold to exceed 0.6. Combined with the 0.95 decay multiplier, high-traffic episodes stabilize above 0.6 while low-traffic episodes continue to decay. This satisfies the requirement that high-access episodes "eventually score above 0.6."

---

## 10. Edge Cases and Risks

### `importance_score` column may not exist at dashboard query time

**Risk:** The dashboard starts before migrations run, causing a `column "importance_score" does not exist` PostgreSQL error.

**Mitigation:** All `/usme/api/scoring` queries that reference `importance_score` are wrapped in try/catch. On error, return `{ histogram: {}, importanceError: 'importance_score column not yet migrated', ... }`. The UI renders a placeholder card.

### Reflection service called before migrations run

**Risk:** `reflect.ts` attempts to INSERT into `reflection_runs` or `skill_candidates` before those tables exist.

**Mitigation:** In `runReflection()`, add a startup check:

```typescript
const { rows } = await pool.query(`
  SELECT to_regclass('public.reflection_runs') AS exists
`);
if (!rows[0].exists) {
  throw new Error('reflection_runs table does not exist — run migrations first (010_episode_importance.sql through 013_exclude_flags.sql)');
}
```

Log the error via pino and throw so the scheduler catches it without crashing.

### Spreading activation adds latency to every turn

**Risk:** Graph walking adds 50–200ms per turn at depth 2.

**Mitigations:**
- Hard cap: `maxAdditional = 10`. Never return more than 10 extra episodes.
- Depth 0 = strict no-op. Zero overhead.
- 150ms soft timeout: if spreading exceeds 150ms, log a warning and return original candidates.
- The entity name extraction uses a single batch query, not N queries.
- The hop expansion uses a single query per hop level, not per entity.
- Both hop and episode queries use the existing indexes (`idx_entity_rel_source`, `idx_entity_rel_target`, `idx_episodes_embedding`).

### `skill_candidates` FK to `reflection_runs`

**Risk:** Migration 012 (`skill_candidates`) references `reflection_runs(id)`. If 011 hasn't run, migration 012 fails.

**Mitigation:** Migration runner must apply files in strict alphabetical/numeric order. The file naming (`011_`, `012_`) enforces this. Document in the migration runner README that migrations are applied in sequence and must not be skipped.

Additionally: `reflection_run_id` in `skill_candidates` is nullable — skill candidates created by the skill delivery cron outside a reflection run have `reflection_run_id = NULL`, which does not violate the FK constraint.

### Entity merge strategy in reflection

**Risk:** The reflection service may identify entity duplicates ("Alex" and "Alex Spinelli" as separate entities). A hard delete would break FK constraints in `entity_relationships`.

**Resolution:** Never hard delete entities. The entity correction mechanism supports `entity_type` and `canonical` field updates only. For true merges, update `canonical` on the duplicate to point to the preferred entity name. The entity graph walk uses `canonical` for matching — so updated canonicals will be treated as equivalent in subsequent queries. True entity ID consolidation is deferred to v2.

### `reflection_runs` INSERT outside transaction

**Design decision:** The `reflection_runs` row is inserted via `pool.query()` (not inside the pg transaction client) before the transaction begins. This ensures a run record exists even if the transaction rolls back. The status column distinguishes running/complete/failed. The `rolled_back` flag is the authoritative indicator.

This means: if the server crashes mid-run, the run row will remain with `status='running'`. A recovery process or the next cron invocation should detect stale `running` rows (older than 1 hour) and mark them as `failed`.

### Dashboard accept/reject buttons and race conditions

**Risk:** Alex double-clicks accept, inserting a duplicate row into `skills`.

**Mitigation:** The `skills` table has a `UNIQUE` constraint on `name` (`name TEXT NOT NULL UNIQUE` from `005_skills.sql`). The duplicate INSERT will fail with a conflict error. The accept endpoint wraps in a transaction — the conflict causes a rollback. Return a 409 response; the UI shows "Already accepted."

---

## File Creation Checklist for Implementing Agents

| File | Action | Agent |
|------|--------|-------|
| `packages/usme-core/db/migrations/010_episode_importance.sql` | CREATE | DB Agent |
| `packages/usme-core/db/migrations/011_reflection_log.sql` | CREATE | DB Agent |
| `packages/usme-core/db/migrations/012_skill_candidates.sql` | CREATE | DB Agent |
| `packages/usme-core/db/migrations/013_exclude_flags.sql` | CREATE | DB Agent |
| `packages/usme-core/src/schema/types.ts` | EDIT (add importance_score, ReflectionRun, SkillCandidate) | Core Agent |
| `packages/usme-core/src/db/queries.ts` | EDIT (insertEpisode + bumpAccessCounts) | Core Agent |
| `packages/usme-core/src/consolidate/nightly.ts` | EDIT (stepEpisodify + stepSkillDraft) | Core Agent |
| `packages/usme-core/src/consolidate/reflect.ts` | CREATE | Core Agent |
| `packages/usme-core/src/consolidate/scheduler.ts` | EDIT (add 2 reflection crons + skill delivery cron) | Core Agent |
| `packages/usme-openclaw/src/config.ts` | EDIT (add SpreadingConfig) | Plugin Agent |
| `packages/usme-openclaw/src/spread.ts` | CREATE | Plugin Agent |
| `packages/usme-openclaw/src/index.ts` | EDIT (InjectionLogEntry + spread call) | Plugin Agent |
| `packages/usme-openclaw/src/commands/reflect.ts` | CREATE | Plugin Agent |
| `~/ai/projects/rufus-projects/usme-dashboard/package.json` | CREATE | Dashboard Agent |
| `~/ai/projects/rufus-projects/usme-dashboard/server.ts` | CREATE | Dashboard Agent |
| `~/ai/projects/rufus-projects/usme-dashboard/public/index.html` | CREATE | Dashboard Agent |

---

_Design complete. Reference this document before writing any code._
