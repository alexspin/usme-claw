# USME Architecture Reference

_Last updated: 2026-04-09. Reflects deployed state after migrations 001–013._

---

## Package Structure

```
usme-claw/
├── packages/
│   ├── usme-core/                      ← Portable logic, no OpenClaw dependency
│   │   ├── src/
│   │   │   ├── schema/
│   │   │   │   └── types.ts            ← All DB interfaces (SensoryTrace, Episode, Concept, etc.)
│   │   │   ├── assemble/
│   │   │   │   ├── index.ts            ← assemble() entry point, orchestrates retrieve+score+pack
│   │   │   │   ├── retrieve.ts         ← ANN queries per tier, pgvector
│   │   │   │   ├── score.ts            ← Weighted scoring formula
│   │   │   │   ├── pack.ts             ← Greedy token-budget packing
│   │   │   │   └── types.ts            ← InjectedMemory, AssembleResult interfaces
│   │   │   ├── consolidate/
│   │   │   │   ├── nightly.ts          ← 5-step pipeline: episodify, promote, contradictions, skill draft, decay
│   │   │   │   ├── reflect.ts          ← Reflection service (Sonnet + tool_use + Zod)
│   │   │   │   ├── reconcile.ts        ← Concept merge/supersede logic
│   │   │   │   └── critic.ts           ← Deduplication (cosine threshold 0.95)
│   │   │   ├── extract/
│   │   │   │   ├── index.ts            ← Fact extraction orchestrator
│   │   │   │   ├── fact-extractor.ts   ← Haiku tool_use → sensory_trace rows
│   │   │   │   └── entity-extractor.ts ← Haiku tool_use → entity + relationship rows
│   │   │   ├── embed/
│   │   │   │   └── openai.ts           ← text-embedding-3-small wrapper, LRU cache
│   │   │   ├── db/
│   │   │   │   ├── pool.ts             ← pg Pool, singleton
│   │   │   │   ├── queries.ts          ← All DB read/write functions
│   │   │   │   └── migrations/         ← SQL files 001–013
│   │   │   ├── logger.ts               ← pino logger, child loggers per module
│   │   │   └── tokenize.ts             ← tiktoken cl100k_base token counting
│   │   └── db/migrations/
│   │       ├── 001_extensions.sql      ← pgvector, timescaledb
│   │       ├── 002_sensory_trace.sql
│   │       ├── 003_episodes.sql
│   │       ├── 004_concepts.sql
│   │       ├── 005_skills.sql
│   │       ├── 006_entities.sql
│   │       ├── 007_shadow_comparisons.sql
│   │       ├── 008_shadow_comparisons_unique.sql
│   │       ├── 009_memory_audit_log.sql
│   │       ├── 010_episode_importance.sql  ← importance_score column
│   │       ├── 011_reflection_log.sql      ← reflection_runs table
│   │       ├── 012_skill_candidates.sql    ← skill_candidates table
│   │       └── 013_exclude_flags.sql       ← exclude_from_reflection on all tiers
│   └── usme-openclaw/                  ← OpenClaw plugin adapter
│       └── src/
│           ├── index.ts                ← Hook registration, scheduler wiring, plugin entry point
│           ├── config.ts               ← UsmePluginConfig, DEFAULT_CONFIG, resolveConfig()
│           ├── spread.ts               ← Spreading activation (entity graph walk)
│           ├── telemetry.ts            ← writeInjectionLog(), InjectionLogEntry
│           └── commands/
│               └── reflect.ts          ← CLI: openclaw usme reflect
```

---

## Data Flow: Hot Path (per turn, synchronous)

```
Inbound message
      │
      ▼
[usme-openclaw/index.ts: before_prompt_build hook]
      │
      ├─1─► embedText(query)
      │      └── OpenAI text-embedding-3-small → float32[1536]
      │
      ├─2─► retrieve(embedding, config)          [usme-core/assemble/retrieve.ts]
      │      ├── ANN query: sensory_trace  (top 20)
      │      ├── ANN query: episodes       (top 20)
      │      ├── ANN query: concepts       (top 20)
      │      └── ANN query: skills         (top 20)
      │           └── 80 candidates total
      │
      ├─3─► spread(candidates, config)            [usme-openclaw/spread.ts]
      │      └── Walk entity_relationships graph
      │           maxDepth=2, pulls adjacent entities' episodes/concepts
      │           Metrics: entities_found, hops_walked, items_added
      │
      ├─4─► score(candidates)                     [usme-core/assemble/score.ts]
      │      └── Weighted formula per tier (see Scoring Formula)
      │
      ├─5─► pack(scored, tokenBudget)             [usme-core/assemble/pack.ts]
      │      └── Greedy sort-by-score, stop at budget
      │
      ├─6─► prependContext(packed)
      │      └── Injects <usme-context> block into system prompt
      │
      └─7─► writeInjectionLog(result)             [async, non-blocking]
             └── Appends JSON line to /tmp/usme/injection.jsonl
```

**Total latency:** ~54ms P50, dominated by the OpenAI embedding call (~420ms).  
The embedding call runs first to hide latency behind LCM processing.

---

## Data Flow: Async Path (background)

```
After turn completes
      │
      ├─► insertSensoryTrace()       [async queue, FIFO via setImmediate]
      │    └── Haiku extracts facts → writes sensory_trace rows + embeddings
      │
      └─► bumpAccessCounts()
           └── Increments access_count on retrieved items
                If access_count >= 10: utility_score += 0.05 (write-back)
```

---

## Data Flow: Consolidation Pipeline (nightly 03:00 UTC + 30min mini)

```
scheduler.ts (node-cron)
      │
      └─► runNightlyConsolidation()   [usme-core/consolidate/nightly.ts]
           │
           ├─Step 1─► stepEpisodify()
           │           Sonnet clusters recent sensory_trace rows into episodes
           │           Haiku assigns importance_score (1–10) to each new episode
           │
           ├─Step 2─► stepPromote()
           │           Sonnet reviews episodes → promotes recurring themes to concepts
           │           tool_use + Zod schema validation
           │
           ├─Step 3─► stepContradictions()
           │           Finds concept pairs with cosine similarity < 0.10
           │           Sonnet arbitrates → one wins, loser marked superseded
           │
           ├─Step 4─► stepSkillDraft()
           │           Queries: WHERE importance_score >= 7 AND skill_checked_at IS NULL
           │           Sonnet drafts skill candidates (candidatesPerNight=5 max)
           │           ⚠️ Currently blocked: legacy episodes have importance_score=5
           │
           └─Step 5─► stepDecayPrune()
                       Applies 0.95× utility decay to all episodes
                       Prunes episodified sensory_trace rows past TTL
```

---

## Data Flow: Reflection Service (2× daily + on-demand)

```
scheduler.ts (node-cron) OR openclaw usme reflect CLI
      │
      └─► runReflection()             [usme-core/consolidate/reflect.ts]
           │
           ├─► fetchCorpus()
           │    Reads all concepts, episodes (capped), sensory_trace (capped), entities
           │    Token estimate: if > 350K → tiered mode (recent + unseen only)
           │
           ├─► buildPrompt(corpus)
           │    Full corpus serialized into Sonnet prompt
           │
           ├─► callSonnet(prompt)      tool_use structured output
           │    Returns: concept_updates[], new_skills[], contradictions[],
           │             entity_updates[], overall_assessment
           │
           ├─► validateWithZod(output)
           │    Strict schema validation + normalizers for edge cases
           │    (array coercion, source_episode_ids numeric extraction, JSON.parse fallback)
           │
           ├─► applyUpdates()          atomic transaction
           │    ├── Update/merge/deprecate concepts
           │    ├── Insert skills (confidence >= 0.7 → skills table as 'candidate')
           │    ├── Insert skill_candidates (confidence < 0.7 → manual review queue)
           │    ├── Resolve contradictions
           │    └── Add/remove/update entity relationships
           │
           └─► logRun()               outside transaction (survives rollback)
                INSERT INTO reflection_runs (status, counts, assessment, ...)
```

**Max tokens:** 16,000 output tokens (raised from 8,192 to prevent truncation).  
**Typical runtime:** 131–163 seconds for a ~69K token corpus.

---

## Database Schema

### `sensory_trace`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| session_id | text | OpenClaw session |
| turn_index | int | Turn within session |
| item_type | enum | `verbatim` \| `extracted` |
| memory_type | enum | `fact` \| `preference` \| `decision` \| `plan` \| `anomaly` \| `ephemeral` \| `insight` |
| content | text | The fact text |
| embedding | vector(1536) | HNSW indexed |
| provenance_kind | enum | `user` \| `tool` \| `model` \| `web` \| `file` |
| utility_prior | enum | `high` \| `medium` \| `low` \| `discard` |
| tags | text[] | |
| episodified_at | timestamptz | Set when included in an episode |
| expires_at | timestamptz | TTL for pruning |
| exclude_from_reflection | bool | Default false (migration 013) |

### `episodes`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| summary | text | LLM-generated narrative |
| embedding | vector(1536) | HNSW indexed |
| source_trace_ids | uuid[] | Which traces were clustered |
| utility_score | float | 0–1, decays at 0.95×/cycle |
| importance_score | int | 1–10, Haiku-assigned at creation (migration 010) |
| access_count | int | Retrieval hit count |
| exclude_from_reflection | bool | Default false (migration 013) |

### `concepts`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| concept_type | enum | `fact` \| `preference` \| `decision` \| `relationship_summary` |
| content | text | |
| embedding | vector(1536) | HNSW indexed |
| utility_score | float | |
| confidence | float | |
| supersedes_id | uuid | Chain for merges |
| superseded_by | uuid | |
| is_active | bool | Inactive excluded from retrieval |
| exclude_from_reflection | bool | Default false (migration 013) |

### `skills`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| name | text | UNIQUE constraint |
| status | enum | `candidate` \| `active` \| `retired` |
| skill_path | text | Semantic path |
| source_episode_ids | uuid[] | |
| teachability | float | 0–1, drives skill tier scoring |
| use_count | int | |

### `entities`
| Column | Type | Notes |
|---|---|---|
| id | uuid | PK |
| name | text | |
| entity_type | enum | `person` \| `org` \| `project` \| `tool` \| `location` \| `concept` |
| canonical | text | Normalized name |
| embedding | vector(1536) | HNSW indexed |
| confidence | float | |
| exclude_from_reflection | bool | Default false (migration 013) |

### `entity_relationships`
| Column | Type | Notes |
|---|---|---|
| source_id | uuid | FK → entities |
| target_id | uuid | FK → entities |
| relationship | text | Free-text label |
| valid_from | timestamptz | Soft-delete pattern |
| valid_until | timestamptz | Null = still active |
| confidence | float | |

### `reflection_runs` (migration 011)
| Column | Type | Notes |
|---|---|---|
| id | serial | PK |
| triggered_at | timestamptz | |
| trigger_source | text | `cron` \| `cli` |
| model | text | e.g. `claude-sonnet-4-6` |
| input_tokens | int | |
| output_tokens | int | |
| duration_ms | int | |
| concepts_updated | int | |
| skills_created | int | |
| contradictions_resolved | int | |
| entities_updated | int | |
| overall_assessment | text | Full Sonnet assessment text |
| status | text | `success` \| `error` \| `rolled_back` |

### `skill_candidates` (migration 012)
| Column | Type | Notes |
|---|---|---|
| id | serial | PK |
| name | text | |
| confidence | float | Gate: >= 0.7 → skills table, < 0.7 → here |
| approval_status | enum | `pending` \| `accepted` \| `rejected` |
| reflection_run_id | int | FK → reflection_runs |

---

## Spreading Activation

After ANN retrieval returns initial candidates, `spread.ts` walks the entity relationship graph to surface adjacent context.

**Algorithm:**
1. Extract entity references from retrieved items
2. For each entity, query `entity_relationships` for connected entities (up to `maxDepth` hops)
3. For each connected entity, retrieve its associated episodes and concepts
4. Merge into candidate pool, deduplicate, re-score

**Config:** `spreading.maxDepth` (default: 2). Set to 0 to disable entirely.

**Metrics logged per turn** (in injection log):
- `entities_found`: entities matched in initial retrieval
- `hops_walked`: total graph hops taken
- `items_added`: net new candidates from spreading

Current status: wired and running but sparse (entity graph has 0–1 relationships per entity, so spreading adds minimal items today). Will improve as reflection service accumulates relationship updates.

---

## Model Assignments

| Task | Model | Notes |
|---|---|---|
| Fact extraction | claude-haiku-4-5 | Per-turn, ~3–4 facts/turn |
| Entity extraction | claude-haiku-4-5 | Per-turn, async |
| Importance scoring | claude-haiku-4-5 | At episode creation in stepEpisodify |
| Episodify | claude-sonnet-4-6 | Nightly, clusters traces into episodes |
| Concept promotion | claude-sonnet-4-6 | Nightly |
| Contradiction resolution | claude-sonnet-4-6 | Nightly |
| Skill drafting (nightly) | claude-sonnet-4-6 | Nightly (currently blocked) |
| Reflection service | claude-sonnet-4-6 | 2× daily + on-demand |
| Embeddings | text-embedding-3-small | All tiers, 1536 dims |

> Note: reconcile.ts hardcodes `claude-sonnet-4-6` directly rather than reading from config — minor model drift risk if sonnet version changes.

---

## Build System

```bash
# From usme-openclaw
npm run build
```

esbuild bundles `packages/usme-openclaw/src/index.ts` + all usme-core dependencies into a single file:

```
~/.openclaw/extensions/usme-claw/dist/plugin.js   ← what OpenClaw runs (1.5MB)
```

**There is no `dist/` inside the source repo.** If one appears, delete it — it is not used.

OpenClaw loads the plugin via `main: dist/plugin.js` in the extensions directory's `package.json`. The `sourcePath` and `installPath` in `openclaw.json` both point to `~/.openclaw/extensions/usme-claw`.

Postbuild script copies `openclaw.plugin.json` and regenerates `package.json` in the extensions directory.
