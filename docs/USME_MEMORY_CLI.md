# USME Memory CLI / Workbench

A read-only command-line workbench for inspecting USME memory: what is semantically
relevant to a query, **why** it scores the way it does, and what the runtime injection
path would actually select for a turn.

> **Read-only by design.** No command mutates the database. `assemble` deliberately does
> **not** call `bumpAccessCounts` (the access-count bump the live plugin performs), so a
> dry-run never perturbs recency/access signals. Every other command is SELECT-only.

## Why this exists

The live USME OpenClaw plugin injects per-turn context by: embedding the latest user
message → ANN search across memory tiers → optional spreading activation → scoring →
critic filter → greedy token-budget packing → injecting selected memories **plus active
constraints** (constraints are injected separately, outside the token budget). Recent
runs selected 44–66 items per turn. This CLI makes that pipeline inspectable so humans
and agents can answer:

- *What memories are relevant to this query, and why?* → `search`, `assemble --show-scores`
- *What would runtime injection actually include?* → `assemble`
- *Where does this exact string/path/command/version appear?* → `grep`
- *Which constraints are active and always injected?* → `constraints`
- *What's the shape/health of the store?* → `stats`, `inspect`

## Install / run

The CLI runs from TypeScript source via `tsx` (already available in the monorepo).

```bash
# from repo root
npx tsx packages/usme-cli/src/cli.ts <command> [args] [flags]
# or, after `npm install` wires the bin:
usme memory <command> ...
```

Command surface is `usme memory <subcommand>`; the leading `memory` is optional when
invoking the binary directly (the dispatcher accepts both `usme assemble ...` and
`usme memory assemble ...`).

## Configuration

- **Database:** connection string precedence is `--database-url` → `DATABASE_URL` env →
  default `postgres://usme:usme_dev@localhost:5432/usme` (the same default the core pool
  and the plugin use). The resolved source is printed on stderr (and in `--json` meta).
- **Embeddings:** `search` and `assemble` embed the query with OpenAI
  `text-embedding-3-small` (1536-dim) via `@usme/core`'s `embedText`, using
  `OPENAI_API_KEY`. `grep`, `constraints`, `inspect`, and `stats` need **no** API key.
- **Debug:** `--debug` or `USME_CLI_DEBUG=1`/`true` writes lightweight timing/count logs to
  stderr only. This includes DB source, embedding duration, per-tier semantic retrieval
  counts/timeouts, scoring/filtering/packing counts, constraints fetch counts, and
  `grep`/`stats` query counts. Stdout is untouched, so `--json` stays machine-parseable.
- **Semantic retrieval timeout:** `search` and `assemble` use `--tier-timeout-ms N` for the
  per-tier retrieval timeout (CLI default: 500ms). This is intentionally CLI-only and does
  not change the OpenClaw runtime plugin's faster default.

## Commands

### `assemble "query"`
Simulates the runtime injection path as closely as practical, reusing the real
`coreAssemble` pipeline (retrieve → spreading → score → critic → minInclusionScore → pack)
and the same separate constraints query.

```
usme memory assemble "deploy gateway" --mode brilliant --include-constraints --show-scores
```

- `--mode brilliant|smart-efficient|psycho-genius` — preset profile (default: `brilliant`,
  matching the plugin default).
- `--token-budget N` — request token budget (default per mode: brilliant 30000,
  psycho-genius 50000, smart-efficient 15000). The effective *memory* budget is
  `tokenBudget × tokenBudgetFraction` (reported in output), exactly as runtime computes it.
- `--spreading-depth 0|1|2` — entity-graph spreading activation (default 2, matching
  runtime). 0 disables.
- `--show-scores` — per-item composite score + breakdown (similarity/recency/provenance/
  accessFrequency/reflectionQuality|teachability).
- `--show-rejected` — also list candidates dropped by the **pipeline** (critic-filtered,
  below `minInclusionScore`, or budget-exceeded), with the reason. Note: items removed only
  by the display-time caps `--tier-limit`/`--limit` are not counted as rejected (those caps
  are CLI viewing aids with no runtime analog).
- `--include-constraints` — show active constraints as a separate section (always injected
  at runtime, outside the budget).
- Override flags (override the mode preset): `--tiers`, `--top-k-per-tier`, `--min-score`
  (minInclusionScore), `--min-confidence`, `--min-similarity`, `--tier-limit tier=N`,
  `--limit`, `--tier-timeout-ms N`, `--preview N`, `--full`, `--json`, `--debug`.

### `search "query"`
Semantic ANN search across tiers with transparent relevance metadata. Unlike `assemble`,
it does **not** apply the critic or token packing — it is a ranked relevance view.

```
usme memory search "postgres port" --tier-limit concepts=10 --tier-limit episodes=5 --json
```

- `--tiers sensory_trace,episodes,concepts,skills,entities` — tiers to search
  (default: all five).
- `--top-k-per-tier N` — ANN depth per tier before scoring (default 20).
- `--tier-timeout-ms N` — per-tier retrieval timeout (default 500ms).
- `--tier-limit tier=N` (repeatable) — final cap per tier.
- `--limit N` — global final cap.
- `--min-score`, `--min-similarity` — composite-score / raw-similarity thresholds.
- `--show-scores`, `--preview N`, `--full`, `--json`.
- `--debug` — write per-tier retrieval timing/counts to stderr; useful when default
  multi-tier searches return unexpectedly few or zero results.

### `grep "literal phrase"`
Literal `ILIKE '%phrase%'` text search across memory rows. Useful for paths, commands,
version strings, config keys, and exact phrases. No embeddings required.

```
usme memory grep "DATABASE_URL" --tiers concepts,skills --full
```

- `--tiers ...`, `--limit N`, `--preview N`, `--full`, `--json`. Searches the content
  column(s) of each tier plus the constraints table. **grep is always case-insensitive**
  (ILIKE), so it matches paths/commands/versions regardless of case; `-i`/`--ignore-case`
  are accepted as explicit no-ops.

### `constraints list | search "term"`
Lists or searches active constraints separately from normal tiers (they are guardrails,
always injected ahead of scored memory).

```
usme memory constraints list
usme memory constraints search "gateway" --all --json
```

- `--all` — include dismissed constraints. `--json`, `--limit N`.

### `inspect <id>`
Full detail for one memory item, located by UUID across all tiers + constraints.

```
usme memory inspect 1f2e... --json
```

### `stats`
Per-tier counts (total / embedded / active), constraint count, freshness (newest/oldest,
last-24h/7d), embedding health (rows missing embeddings), and — if present — a summary of
the most recent runtime injections parsed from the injection log
(`USME_INJECTION_LOG` or `/tmp/usme/injection.jsonl`).

```
usme memory stats --json
```

## Option semantics (summary)

| Flag | Meaning |
|------|---------|
| `--mode` | Preset profile; explicit flags below override it. |
| `--tiers` | Which tiers are searched. |
| `--top-k-per-tier` | DB retrieval depth per tier *before* scoring. |
| `--tier-timeout-ms` | Per-tier retrieval timeout for CLI semantic commands (default 500ms). |
| `--tier-limit tier=N` | Final cap for a tier (post-scoring). |
| `--limit` | Global final result count. |
| `--min-score` | Composite-score threshold (`minInclusionScore`). |
| `--min-similarity` | Raw embedding-similarity threshold. |
| `--min-confidence` | Critic confidence threshold. |
| `--token-budget` | Request token budget for `assemble` packing. |
| `--spreading-depth` | Spreading-activation depth (assemble). |
| `--include-constraints` | Show constraints as a separate section. |
| `--show-scores` | Include score breakdowns. |
| `--show-rejected` | Include filtered/rejected candidates with reason. |
| `--preview N` / `--full` | Content preview length / full content. |
| `--json` | Stable machine-readable output. |
| `--debug` | Debug timing/count logs to stderr only; can also be enabled with `USME_CLI_DEBUG=1`/`true`. |

## LCM boundary (intentional separation)

USME (semantic relevance) and LCM (exact transcript recall / source evidence) remain
**conceptually distinct**. This CLI is USME-only. An LCM bridge is deliberately **not**
implemented in v1 because no clear, low-risk local LCM API surface was confirmed during
design. A future `usme memory recall` (or `--with-lcm` evidence column on `grep`/`inspect`)
could surface exact transcript provenance *alongside* — never merged into — USME semantic
results. See `docs/DECISIONS.md` if/when that interface is defined.

## Architecture / reuse

- Reuses `@usme/core`: `assemble`, `retrieve`, `scoreCandidates`, `criticFilter`, `pack`,
  `resolveMode`, `MODE_PROFILES`, `getPool`, `embedText`, `searchByEmbedding`, tier types.
- Reuses the real `spreadingActivation` from the plugin package via its new `./spread`
  subpath export — no duplicated graph-walk logic. That export points at TypeScript source
  (`./src/spread.ts`), so it resolves under `tsx` (how this CLI runs); a plain-`node` or
  bundled consumer would need a built `dist/spread.js` target instead.
- New SQL is added only for `grep`, `inspect`, `stats`, and `constraints` (capabilities the
  core pipeline does not provide); the relevance path duplicates no scoring/retrieval logic.
```
