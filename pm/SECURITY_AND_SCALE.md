# USME Security & Scalability Report

**Date:** 2026-04-20
**Classification:** Internal — Audit Output
**Status:** Final

---

## Overview

This report focuses on security vulnerabilities, credential handling, multi-tenant isolation risks, and horizontal scaling blockers identified across the USME system. It is a companion to `AUDIT_REPORT.md`.

The system is currently **single-user, single-machine** and was clearly built with that constraint in mind. The risk profile is low in isolation, but the credential and path issues create meaningful supply-chain and handoff risks. None of the items below require deep rewrites — they are largely configuration and structural fixes.

---

## 1. Secrets Management Audit

### 1.1 Private Key in Repository (CRITICAL)

**Files:**
- `rufus-plugin/remote-agent-docker/baked-device.json` — plaintext Ed25519 private key (PEM format)
- `rufus-plugin/remote-agent-docker/baked-device-auth.json` — pre-issued gateway bearer token

Both files are `COPY`'d into Docker images and committed to the repository. Per Dockerfile comments, this is intentional ("baked device" pattern). However:

- Anyone with repo read access has the private key and a valid bearer token.
- If the repo is ever made public or leaked, the remote agent gateway is permanently compromised until the key is rotated.
- There is no documented rotation procedure.

**Recommendation:** Move to a secrets injection pattern at container startup (Docker secrets, environment injection, or a secrets manager). Remove `baked-device.json` from version control and add to `.gitignore`. Document key rotation procedure.

---

### 1.2 Plaintext Fallback Credentials in Source (CRITICAL)

**File:** `usme-dashboard/src/server.ts:41–45`

```
// Fallback when DASHBOARD_USERS is not set
users = [
  { username: 'alex', password: 'claw-alex-26' },
  { username: 'adam', password: 'claw-adam-26' },
];
```

- Activated silently when `DASHBOARD_USERS` environment variable is absent.
- Passwords stored and compared as plaintext strings (line 316) — no bcrypt, no constant-time comparison.
- The `/login` route has no rate limiting.
- No audit log of authentication attempts.

**Recommendation:**
1. Delete the fallback block entirely. Add startup crash if `DASHBOARD_USERS` is absent.
2. Replace `===` comparison with `await bcrypt.compare()`.
3. Add `express-rate-limit` to `/login` (e.g., 10 attempts / 15 min per IP).
4. Log authentication attempts (success and failure) via pino.

---

### 1.3 Hardcoded Database Password (HIGH)

**Files:** `packages/usme-core/src/db/pool.ts:19`, `packages/usme-core/src/db/config.ts`, `packages/usme-core/run-consolidation.mts`

The fallback connection string embeds the plaintext password `usme_dev`. `run-consolidation.mts` has no env var override — it always uses the hardcoded connection string if `DATABASE_URL` is not set.

**Recommendation:** All DB connection strings must come from `DATABASE_URL` env var only. Remove all fallback strings with embedded credentials. Add startup crash if `DATABASE_URL` is absent.

---

### 1.4 Session Secret Default Value (HIGH)

**File:** `usme-dashboard/src/server.ts`

Session secret defaults to the publicly-known string `"rufus-dashboard-secret-change-me"`. No crash, warning, or validation fires on startup if `SESSION_SECRET` is not set.

**Recommendation:** Add startup validation:
```typescript
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'rufus-dashboard-secret-change-me') {
  throw new Error('SESSION_SECRET must be set to a strong random value');
}
```

---

### 1.5 .env File Audit

`.env` files exist and are excluded from version control (`.gitignore` present). However, the set of required env vars is not documented anywhere. A new developer has no way to know what is required without reading all source files.

**Recommendation:** Add `.env.example` to each repo listing all required and optional env vars with descriptions and safe example values.

---

## 2. Authentication & Session Security

| Issue | Severity | Location |
|---|---|---|
| Plaintext password comparison | CRITICAL | `server.ts:316` |
| No rate limiting on `/login` | HIGH | `server.ts` |
| Session store is in-memory (`MemoryStore`) | HIGH | `server.ts` |
| Session cookies not marked `secure: true` | MEDIUM | `server.ts` |
| No HTTPS enforcement | MEDIUM | All |
| No CSRF protection on state-mutating routes | MEDIUM | `server.ts` |

**In-memory session store** means all active sessions are destroyed on every server restart. Users must re-authenticate after any deployment. For a shared dashboard with multiple users this is a significant operational problem.

**Recommendation:** Replace `MemoryStore` with `connect-pg-simple` (stores sessions in PostgreSQL — already a dependency). Add `helmet` for security headers. Enforce `secure: true` on cookies.

---

## 3. Multi-Tenant Isolation Risks

The system is architecturally single-user. The following module-level singletons would cause **state bleed** if the system were adapted for multi-user use without refactoring:

### 3.1 Database Connection Pool Singleton (CRITICAL)

**File:** `packages/usme-core/src/db/pool.ts:5`

```typescript
let pool: pg.Pool | null = null;
```

First caller's connection string wins for the lifetime of the process. No mechanism for per-tenant or per-user connection pools.

### 3.2 Shared Extraction Queue (CRITICAL)

**File:** `packages/usme-core/src/extract/queue.ts:112`

```typescript
let defaultQueue: ExtractionQueue | null = null;
```

All sessions share one FIFO queue. No job ownership, no per-user queues, no priority lanes.

### 3.3 Shared Embedding Cache (MODERATE)

**File:** `packages/usme-core/src/embed/openai.ts:14`

```typescript
const embeddingCache = new LRUCache({ max: 5000 });
```

Cache key is text content only — not scoped to user or tenant. In a multi-user scenario, User A's cached embeddings would be returned for User B's identical text (acceptable for public content, problematic for private content).

### 3.4 Scheduler Singleton (MODERATE)

**File:** `packages/usme-openclaw/src/index.ts:161`

`_schedulerHandle` is a module-level singleton. Singleton guard was intentionally removed, creating race conditions on multi-instance startup.

**Current Design Contract:** The system is single-user by design. This constraint must be **explicitly documented** in READMEs and architecture docs, even if multi-tenancy is not a near-term goal.

---

## 4. Scaling Bottlenecks

### 4.1 In-Memory Queue — No Persistence

`extract/queue.ts` is entirely in-memory. Any process restart loses all queued items. No backpressure mechanism — queue grows unbounded under load.

**Scale path:** Replace with `pg-boss` (PostgreSQL-backed job queue) or BullMQ. `pg-boss` is lowest-friction given the existing PostgreSQL dependency.

### 4.2 No Retry on Embedding Hot Path

`embedText()` in `embed/openai.ts` is called synchronously with no retry and no circuit breaker. A single OpenAI API timeout blocks the entire extraction pipeline for that turn.

**Scale path:** Add `p-retry` with exponential backoff. The circuit breaker pattern in `rufus-plugin/src/context-logger/distiller.ts` is a good model to follow.

### 4.3 Hand-Rolled Cosine Similarity

`assemble/score.ts:108–119` computes cosine similarity in a JS for-loop. Acceptable for small post-retrieval re-ranking, but does not scale with corpus size. pgvector's `<=>` operator should handle all similarity computation.

### 4.4 node-cron with No Persistence

The nightly consolidation scheduler uses `node-cron` in-process with no state persistence. A process restart at the wrong moment drops the next scheduled run silently. No monitoring, alerting, or missed-run detection.

**Scale path:** Move scheduled jobs to `pg-boss` or a dedicated cron service with dead-letter queue semantics.

### 4.5 No Horizontal Scaling Path

The current architecture cannot be horizontally scaled:
- Module-level singletons (pool, queue, cache, scheduler) conflict across instances
- In-memory session store is not shared across instances
- `node-cron` would fire on every instance simultaneously

Expected for a personal-scale tool, but must be resolved before multi-user deployment.

---

## 5. Hardcoded Values Inventory

### Absolute Paths (Will Break on Any Other Machine)

| File | Hardcoded Path |
|---|---|
| `packages/usme-core/src/consolidate/promote.ts:277` | `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/` |
| `packages/usme-core/src/scripts/promote-candidate.ts:129` | `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/` |
| `packages/usme-core/run-consolidation.mts:3` | Absolute import to developer's home directory |
| `usme-dashboard/src/server.ts:21–22` | `SWARM_SERVER_DIR`, `SWARM_UI_DIR` default to `/home/alex/...` |
| `packages/usme-openclaw/package.json` | Build output to `../../../../.openclaw/extensions/usme-claw/` |
| Various | `/tmp/usme/` log files (not configurable per-environment) |

### Hardcoded Port Numbers

| File | Port | Purpose |
|---|---|---|
| `usme-dashboard/src/server.ts` | 3456 | Dashboard HTTP |
| Various | 3747 | Secondary service |
| Various | 5432 | PostgreSQL (standard, acceptable) |

### Hardcoded Model Names

| File | Model | Has Override? |
|---|---|---|
| `nightly.ts` | `claude-sonnet-4-5` | Yes (env var) |
| `reconcile.ts` | `claude-sonnet-4-6` | Yes (env var) |
| `reflect.ts` | `claude-sonnet-4-5` | Yes (env var) |
| `nightly.ts:167` | `claude-haiku-4-5` | **No** — fully hardcoded |
| `embed/openai.ts` | `text-embedding-3-small` | **No** — module constant |
| `embed/openai.ts` | `EMBEDDING_DIMENSIONS = 1536` | **No** — module constant |

---

## 6. Network & Infrastructure Security

| Issue | Severity | Detail |
|---|---|---|
| No TLS/HTTPS | HIGH | Dashboard exposed over plain HTTP |
| No reverse proxy | HIGH | No NGINX, no Caddy — dashboard directly exposed |
| No rate limiting | HIGH | No middleware limiting requests per IP |
| No security headers | MEDIUM | No `helmet`, no CSP, no HSTS, no X-Frame-Options |
| Overly broad CORS | MEDIUM | SSE endpoints use `Access-Control-Allow-Origin: *` |
| No SSL on PostgreSQL | LOW | Connections use `ssl: false` |
| Remote agent runs without approvals | INFO | `exec-approvals-seed.json` sets `ask: "off"` — by design, noted for threat model |

---

## 7. Recommendations Summary

### Immediate (Before Any Handoff)

1. **Rotate** the Ed25519 private key in `baked-device.json` — treat as compromised.
2. **Remove** fallback credentials from `server.ts`. Crash loudly on missing `DASHBOARD_USERS`.
3. **Replace** plaintext password comparison with bcrypt.
4. **Remove** all hardcoded `/home/alex/` paths — replace with `OPENCLAW_WORKSPACE_DIR` and `SWARM_SERVER_DIR` env vars.
5. **Add** `SESSION_SECRET` startup crash — refuse known default value.
6. **Replace** in-memory session store with `connect-pg-simple`.
7. **Add** `.env.example` files to all repos.

### Short-Term (First Sprint After Handoff)

8. Add `helmet` middleware for security headers.
9. Add `express-rate-limit` to `/login`.
10. Add env var schema validation on startup (Zod or `envalid`).
11. Unify all model name defaults into `config/models.ts`.
12. Add `p-retry` to `embedText()`.
13. Document the single-user constraint explicitly in all READMEs.

### Medium-Term (Next Quarter)

14. Replace in-memory extraction queue with `pg-boss`.
15. Replace `node-cron` with `pg-boss` scheduled jobs.
16. Add NGINX/Caddy reverse proxy with TLS termination.
17. Add CI/CD pipeline (GitHub Actions).
18. Add Dockerfile + docker-compose for `usme-claw` and `usme-dashboard`.
