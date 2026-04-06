# usme-claw

**USME — Utility-Shaped Memory Ecology**

A semantic memory system for LLM agents. USME captures, consolidates, and retrieves information across conversations — injecting what the model *should* know right now, not just what happened most recently.

---

## Overview

Most LLM context management is recency-based: keep the last N messages, drop the rest. USME is relevance-based: it builds a multi-tier memory corpus from every conversation turn, scores items by utility, and assembles a context window optimised for the current moment.

```
Every turn
  ↓
Extraction (Haiku) — pull facts, decisions, preferences, plans from user + model messages
  ↓
Sensory Trace Store (Postgres + pgvector)
  ↓
Nightly Consolidation (Sonnet) — cluster traces → episodes → concepts → skill candidates
  ↓
Retrieval (ANN + scoring) — similarity × recency decay × provenance × frequency
  ↓
Assembly — pack scored items into a token-budgeted context block
  ↓
Injection — prepended to system prompt as <usme-context> block
```

### Memory Tiers

| Tier | What's stored | Decay |
|------|--------------|-------|
| **Sensory traces** | Raw extracted facts per turn | Fast (expires after N days) |
| **Episodes** | Clustered summaries of related traces | Medium |
| **Concepts** | Stable, recurring facts and preferences | Slow |
| **Skills** | Procedural patterns worth reusing | Manual retirement |
| **Entities** | Named references (people, projects, etc.) | Confidence-weighted |

### Assembly Modes

| Mode | Token budget | Use case |
|------|-------------|----------|
| `psycho-genius` | 50 000 | Deep research, complex projects |
| `brilliant` | 30 000 | Default — balanced recall |
| `smart-efficient` | 15 000 | Lightweight tasks, cost-sensitive |

---

## Architecture

```
usme-claw/
├── packages/
│   ├── usme-core/          # Core library (DB, extraction, consolidation, retrieval, embeddings)
│   │   └── src/
│   │       ├── assemble/   # Context assembly pipeline
│   │       ├── consolidate/# Nightly consolidation (episodify → promote → decay)
│   │       ├── db/         # Postgres pool + queries + migrations
│   │       ├── embed/      # OpenAI embeddings (text-embedding-3-small)
│   │       ├── extract/    # Per-turn extraction via Haiku
│   │       ├── prompts/    # Extraction + consolidation LLM prompts
│   │       └── schema/     # TypeScript types for all memory tiers
│   └── usme-openclaw/      # OpenClaw plugin adapter
│       └── src/
│           ├── index.ts    # Plugin entry point (before_prompt_build hook)
│           ├── shadow.ts   # Shadow mode: compare USME vs LCM without going live
│           ├── plugin.ts   # (Future) ContextEngine adapter for active mode
│           └── config.ts   # Config schema + defaults
└── scripts/
    ├── db-init.sh          # Run migrations
    ├── start-db.sh         # Start Postgres via Docker
    ├── stop-db.sh          # Stop Postgres
    ├── shadow-report.ts    # Print shadow comparison stats
    ├── shadow-tail.ts      # Tail live shadow log
    └── dedup-corpus.ts     # Clean duplicate traces from corpus
```

---

## Requirements

- Node.js ≥ 18
- Docker (for Postgres)
- OpenAI API key (embeddings via `text-embedding-3-small`)
- Anthropic API key (extraction via Haiku, consolidation via Sonnet)

---

## Setup

### 1. Install dependencies

```bash
npm install
npm run build
```

### 2. Start the database

```bash
./scripts/start-db.sh
```

This starts a `timescale/timescaledb-ha:pg16` container with pgvector enabled on port 5432.

Default credentials (override via `DATABASE_URL` env var):
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

Or with a custom database URL:

```bash
DATABASE_URL=postgres://usme:secret@localhost:5432/usme ./scripts/db-init.sh
```

### 4. Set environment variables

```bash
export OPENAI_API_KEY=sk-...       # Required: embeddings
export ANTHROPIC_API_KEY=sk-ant-... # Required: extraction + consolidation
```

---

## Integration with OpenClaw

USME ships as an OpenClaw plugin. It currently runs in **shadow mode**: it processes every turn and logs what it *would* inject, without replacing your active context engine (LCM by default). This lets you evaluate quality before going live.

### openclaw.json config

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

### Shadow mode

In shadow mode, USME runs its full extraction and assembly pipeline on every turn, then logs a comparison against the active context engine's output. Check progress:

```bash
npx tsx scripts/shadow-report.ts
npx tsx scripts/shadow-tail.ts   # live log
```

Shadow comparisons are stored in the `shadow_comparisons` table. Once quality looks good (overlap scores rising, relevant facts appearing), flip `"mode": "active"` to go live.

### Active mode (transform plugin)

With `"mode": "active"`, USME appends a `<usme-context>` block to every message before it reaches the model:

```
<usme-context>
[high] Alex prefers TypeScript with strict mode. (concepts · score: 0.89)
[high] usme-claw consolidation runs every 30 min (mini) and 3am UTC (full). (episodes · score: 0.81)
[med]  Decision: keep OpenAI embeddings throughout, not Anthropic. (concepts · score: 0.72)
</usme-context>
```

This sits on top of your existing context engine — USME adds relevant memory, LCM handles conversation history.

---

## Consolidation

Consolidation runs on two schedules:

| Schedule | Trigger | What it does |
|----------|---------|--------------|
| **Mini** | Every 30 min | Clusters recent traces into episodes |
| **Full nightly** | 3am UTC (cron) | Episodes → concepts, concept dedup, skill drafting, utility decay + prune |

The nightly pipeline has five steps:
1. **Episodify** — cluster traces by session + time proximity, summarise with Sonnet
2. **Promote** — detect recurring patterns, promote to concepts
3. **Contradiction resolution** — find conflicting concepts (cosine similarity < 0.10), resolve with Sonnet
4. **Skill drafting** — promote high-utility episodes to skill candidates
5. **Decay + prune** — apply utility score decay (0.95×/cycle), expire old traces

---

## Development

```bash
# Build all packages
npm run build

# Run tests
npm test

# Integration tests (requires running DB)
npm run test:integration

# Run migrations against test DB
npm run migrate:test
```

---

## Status

USME is in active development. Current state:

- ✅ Extraction pipeline (per-turn, Haiku)
- ✅ Postgres schema with pgvector HNSW indexes
- ✅ OpenAI embeddings (inline at creation time)
- ✅ ANN retrieval across all memory tiers
- ✅ Shadow mode with comparison logging
- ✅ Consolidation scheduler (mini + nightly)
- ✅ OpenClaw transform plugin (shadow + active modes)
- 🔄 Dashboard (shadow comparison viewer, in `rufus-plugin`)
- 🔄 Active mode quality evaluation
- ⬜ Relevance scoring analysis tooling
- ⬜ ContextEngine adapter (drop-in LCM replacement)

---

## License

MIT
