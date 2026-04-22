# USME Deep Architectural Audit Report

**Date:** 2026-04-20
**Swarm ID:** swarm-1776725049902-pfwaia
**Auditors:** Architect Agent · Principal Engineer Agent · DevOps Agent (parallel swarm review)
**Status:** Final

---

## Executive Summary

USME is a personal-scale AI memory and skill-consolidation system built around a PostgreSQL + pgvector backend, a TypeScript core (`usme-core`), a browser extension bridge (`usme-openclaw`), a web dashboard (`usme-dashboard`), and a plugin subsystem (`rufus-plugin`). The codebase demonstrates genuine engineering ambition — versioned migrations, Zod validation at LLM boundaries, pino structured logging in the core, and per-item SAVEPOINT transaction safety are all above average for a prototype.

However, the system carries significant **prototype debt** that makes it unmaintainable, non-portable, and unsafe for multi-user or production use. The dominant failure modes are:

1. **Machine-specific absolute paths** embedded in production code — the system cannot run on any machine other than the original developer's laptop without source code changes.
2. **Plaintext credentials** in source files and Docker images, including a private key.
3. **No multi-tenant isolation** — the entire architecture is single-user by design, undocumented, and not enforced.
4. **God files** — two critical files exceed 800 lines with no separation of concerns.
5. **Incomplete OSS migrations** — hand-rolled queue, cosine similarity, loggers, and no-retry embedding calls.

The system is **not ready for handoff** in its current state. With a focused 4–6 week remediation sprint it can be brought to handoff-ready.

**Overall Rating: C+ (Prototype-grade, not production-ready)**

---

## Scope

| Repository | Role | Reviewed |
|---|---|---|
| `usme-claw` | Core pipeline, DB, embeddings, consolidation, reflection | ✅ |
| `usme-dashboard` | Web dashboard (port 3456), SSE, auth | ✅ |
| `rufus-memtx-mgmt` | Tarantool memory management tooling | ✅ |
| `rufus-plugin` | Browser/agent plugin, context distillation | ✅ |

---

## Section 1: Architecture Review

### 1.1 Incomplete OSS Migrations

| Severity | Location | Issue |
|---|---|---|
| HIGH | `packages/usme-core/src/consolidate/reconcile.ts:96` | `JSON.parse(concept.embedding)` with no Zod schema — silent data corruption risk |
| HIGH | `packages/usme-core/src/assemble/retrieve.ts:141` | `JSON.parse(raw) as number[]` — unsafe cast, no validation |
| HIGH | `rufus-plugin/src/context-logger/config.ts:32` | Config parsed and cast unsafely; errors silently swallowed |
| HIGH | `packages/usme-core/src/embed/openai.ts` | `embedText()` has zero retry on transient API failures — every turn fails hard on an OpenAI hiccup |
| HIGH | `packages/usme-core/src/extract/queue.ts` | 120-line hand-rolled in-memory FIFO queue — no persistence, no job-level retry, no backpressure. Should use BullMQ or pg-boss. |
| MEDIUM | `packages/usme-core/src/assemble/score.ts:108–119` | Hand-rolled cosine similarity in a JS for-loop. pgvector is used in `retrieve.ts` but not extended to the critic/score pipeline. |
| MEDIUM | `packages/usme-openclaw/src/index.ts` | Two custom file loggers (`dbg()` → `/tmp/usme/debug.log`, `writeInjectionLog()` → `/tmp/usme/injection.jsonl`) bypass pino entirely |
| MEDIUM | `rufus-plugin/src/context-logger/logger.ts` | Custom `DistillationLogger` class writes JSONL; no structured logging framework |
| MEDIUM | `rufus-plugin/src/context-logger/flash-client.ts:109` | Raw `fetch()` to Gemini API, manually cast response, no retry on transient errors |

---

### 1.2 Global / Module-Level State Leaks (Multi-Tenant Isolation)

The system has **no tenant isolation** at any layer. This is not documented as a design constraint. If multiple users ever interact with the same running process, state will bleed between them.

| Severity | File | Issue |
|---|---|---|
| CRITICAL | `packages/usme-core/src/db/pool.ts:5` | `let pool: pg.Pool \| null = null` — singleton pool; first caller's connection string wins for all subsequent callers. Cannot support multiple DB connections. |
| CRITICAL | `packages/usme-core/src/extract/queue.ts:112` | `let defaultQueue: ExtractionQueue \| null = null` — all sessions share one FIFO queue with zero isolation |
| MODERATE | `packages/usme-core/src/embed/openai.ts:14` | `embeddingCache = new LRUCache({max:5000})` — module-level cache with no user/tenant key. User A's embeddings could be served to User B. |
| MODERATE | `packages/usme-openclaw/src/index.ts:161` | `let _schedulerHandle` — singleton guard intentionally removed, creating race conditions on multi-instance startup |

---

### 1.3 Scattered Model Names & Hardcoded Config

| Severity | Location | Issue |
|---|---|---|
| CRITICAL | `packages/usme-core/src/consolidate/promote.ts:277` | Hardcoded: `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/${slug}/SKILL.md` |
| CRITICAL | `packages/usme-core/src/scripts/promote-candidate.ts:129` | Same `/home/alex/...` path hardcoded |
| CRITICAL | `packages/usme-core/run-consolidation.mts:3` | Absolute import path to developer's home directory — will not run on any other machine |
| HIGH | `packages/usme-core/src/consolidate/nightly.ts:167` | `model: "claude-haiku-4-5"` hardcoded with no config override path at all |
| HIGH | `nightly.ts`, `reconcile.ts`, `reflect.ts` | Model version inconsistency: `claude-sonnet-4-5` vs `claude-sonnet-4-6` across 3 files — silent version drift |
| HIGH | `packages/usme-core/src/embed/openai.ts` | `text-embedding-3-small` and `EMBEDDING_DIMENSIONS = 1536` are module-level constants, not env-configurable |
| MEDIUM | `packages/usme-openclaw/package.json` | Build script hardcodes `../../../../.openclaw/extensions/usme-claw/` — breaks on any directory restructure |
| MEDIUM | Various | `/tmp/usme/` prefix for 3 different log/flag files — not configurable per-environment |

---

### 1.4 Architectural Fragility & DRY Violations

| Severity | Location | Issue |
|---|---|---|
| HIGH | `packages/usme-core/src/consolidate/reflect.ts` (825 lines) | God file: orchestration, LLM prompt building, JSON repair fallback (3-strategy), DB writes, and audit logging all co-located |
| HIGH | `packages/usme-core/src/consolidate/nightly.ts` (620 lines) | God file: episodification, importance scoring, promotion, contradiction resolution in one file |
| HIGH | `packages/usme-openclaw/src/index.ts:364` | `bumpAccessCounts` errors silently dropped permanently |
| HIGH | `packages/usme-openclaw/src/index.ts:103` | Dir creation errors swallowed; subsequent writes also fail silently |
| MEDIUM | `promote.ts:276`, `promote-candidate.ts:126`, `promote-candidate.ts:28` | Slug generation regex duplicated 3 times |
| MEDIUM | `promote.ts` + `promote-candidate.ts` | SKILL.md markdown template duplicated across both files |
| MEDIUM | All | `node-cron` scheduler has no persistence — a process restart drops the next scheduled run silently |
| LOW | `reflect.ts` | `getPool()` called directly (tight coupling to singleton) rather than accepting pool as a parameter |

**No circular dependencies detected.** The import graph is clean.

---

## Section 2: Code Quality & Maintainability

**Overall Grade: B-**

| Dimension | Grade | Notes |
|---|---|---|
| Code Organization | B | Clean domain layering in `usme-core`; `usme-dashboard/server.ts` is an 883-line God file |
| Documentation | B+ | Strong inline design rationale in `reflect.ts` and `usme-core/docs/`; no README for `usme-dashboard` |
| Error Handling | B | Good in the core pipeline; silent swallows in `openclaw` and `config.ts` |
| Type Safety | C+ | `rufus-plugin` near-zero `any` (1 occurrence); several unsafe casts in core; missing return types in some files |
| Test Coverage | C | No tests in `rufus-plugin`; no tests for `usme-dashboard`; `usme-core` has limited coverage |

### Priority Code Quality Issues

1. **`usme-dashboard/src/server.ts` (883 lines)** — auth, HTML templates, SSE logic, pg queries, file-system helpers, and CJS bridging are all co-located. Requires decomposition into router modules, a query layer, and an auth module.

2. **Duplicate `SkillCandidate` types** — `schema/types.ts:SkillCandidate` and `consolidate/promote.ts:PromoteSkillCandidate` are near-identical structs; should be unified in `schema/types.ts`.

3. **Magic number duplication** — the `350_000` token threshold is hardcoded in both `reflect.ts` and `server.ts`; should be a single named export from `usme-core`.

4. **IIFE inside a function call** — `reflect.ts:650–674` (slug remap logic) should be extracted to a named helper.

5. **Zero test coverage in `rufus-plugin`** — `context-logger/distiller.ts` (circuit breaker, Gemini Flash API, fallback logic) is complex stateful code with no tests at all.

6. **No README for `usme-dashboard`** — a new developer has no entry point without reading all 883 lines of `server.ts`.

---

## Section 3: DevOps, Security & Deployment

### 3.1 Secrets & Credentials

| Severity | Location | Issue |
|---|---|---|
| CRITICAL | `rufus-plugin/remote-agent-docker/baked-device.json` | Plaintext Ed25519 private key (PEM) baked into Docker image and committed to repo |
| CRITICAL | `rufus-plugin/remote-agent-docker/baked-device-auth.json` | Pre-issued gateway bearer token committed to repo |
| CRITICAL | `usme-dashboard/src/server.ts:41–45` | Fallback users `alex:claw-alex-26` and `adam:claw-adam-26` in plaintext; activated silently when `DASHBOARD_USERS` is absent |
| CRITICAL | `usme-dashboard/src/server.ts:316` | Password comparison is plaintext string equality — no bcrypt, no rate limiting on `/login` |
| CRITICAL | `usme-dashboard/src/server.ts:21–22` | `SWARM_SERVER_DIR` and `SWARM_UI_DIR` hardcoded to `/home/alex/...` with no env var override |
| HIGH | Multiple | Session secret defaults to `"rufus-dashboard-secret-change-me"` — no crash on missing `SESSION_SECRET` |
| HIGH | `db/pool.ts`, `config.ts`, `run-consolidation.mts` | DB password `usme_dev` hardcoded in multiple files; `run-consolidation.mts` has no env var override at all |

### 3.2 Operational Risks

| Severity | Issue |
|---|---|
| HIGH | No CI/CD pipeline in any repo |
| HIGH | No process manager — dashboard started with raw `tsx`, will not auto-restart on crash |
| HIGH | Session store is in-memory (`MemoryStore`) — all sessions lost on every restart |
| MEDIUM | Session cookies not marked `secure: true`; no HTTPS enforced |
| MEDIUM | No NGINX or reverse proxy — dashboard directly exposed, no rate limiting, no CSP/HSTS, no `helmet` |
| MEDIUM | SSE endpoints use `Access-Control-Allow-Origin: *` |
| LOW | `/tmp/debug/reflect-*.json` debug dump path is hardcoded |
| INFO | `exec-approvals-seed.json` sets `security: "full", ask: "off"` — remote container runs all commands without approval prompts (by design) |

### 3.3 Deployment Readiness

The project is **not deployable** to any machine other than the original developer's laptop without code changes, due to hardcoded `/home/alex/` paths in `run-consolidation.mts`, `server.ts`, `promote.ts`, and `promote-candidate.ts`. There are no Dockerfiles for `usme-claw` or `usme-dashboard`, no CI pipeline, and no environment separation (dev/staging/prod).

**What works well in this area:**
- 14 numbered SQL migrations using `node-pg-migrate` — schema versioning is properly handled
- All DB queries in `usme-dashboard` use parameterized queries — no SQL injection risk found
- `.env` files appear excluded from version control via `.gitignore`

---

## Strengths (What's Working Well)

- `usme-core` core pipeline: clean domain layering (`db` → `embed` → `extract`/`assemble` → `consolidate`)
- Zod validation at every LLM output boundary in `usme-core`
- Pino structured logging used consistently throughout `usme-core`
- 14 versioned SQL migrations — schema changes are properly tracked
- Per-item SAVEPOINT transaction safety in the reflection pipeline
- `rufus-plugin` has excellent separation of concerns and near-zero `any` usage (1 occurrence)
- No circular dependencies detected across the import graph
- All dashboard DB queries use parameterized queries — no SQL injection risk
- Strong inline design rationale in `reflect.ts` and `usme-core/docs/`

---

## Finding Counts

| Severity | Count |
|---|---|
| CRITICAL | 9 |
| HIGH | 17 |
| MEDIUM | 13 |
| LOW / INFO | 5 |
| **Total** | **44** |
