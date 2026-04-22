# USME Remediation Plan

**Date:** 2026-04-20
**Based on:** AUDIT_REPORT.md + SECURITY_AND_SCALE.md
**Status:** Draft — Awaiting Owner Review

---

## Definition of Handoff Readiness

The system is considered **handoff-ready** when all of the following are true:

- [ ] It can be installed and run on a machine that is not Alex's laptop, using only the documentation.
- [ ] No credentials or private keys are stored in source files or Docker images.
- [ ] All passwords are hashed and compared securely.
- [ ] All absolute paths are replaced by environment variables.
- [ ] All required environment variables are validated at startup with clear error messages.
- [ ] There is a README in every repo with setup instructions.
- [ ] The system runs under a process manager (not raw `tsx`).
- [ ] There is at least one CI workflow running on every PR.

---

## Phase 1 — Critical: Must Fix Before Handoff (~2.5 dev days)

These are blocking issues. The system cannot safely be handed to another developer until all Phase 1 items are resolved.

---

### P1-1: Rotate Compromised Key Material

**Severity:** CRITICAL
**Files:** `rufus-plugin/remote-agent-docker/baked-device.json`, `baked-device-auth.json`
**Issue:** Plaintext Ed25519 private key and bearer token committed to git history.

**Steps:**
1. Rotate the Ed25519 key pair at the gateway.
2. Issue a new bearer token.
3. Remove both files from the repo and add to `.gitignore`.
4. Rewrite git history to purge the files (or rotate again post-history-rewrite if you accept the key as compromised).
5. Document a new secrets injection pattern in the Dockerfile (e.g., `--secret` mount).

**Effort:** ~2 hours + key rotation coordination

---

### P1-2: Remove Hardcoded Fallback Credentials

**Severity:** CRITICAL
**File:** `usme-dashboard/src/server.ts:41–45`
**Issue:** Plaintext fallback users `alex:claw-alex-26`, `adam:claw-adam-26` activated silently when `DASHBOARD_USERS` is absent.

**Steps:**
1. Delete the hardcoded fallback user block entirely.
2. Add startup crash: `if (!process.env.DASHBOARD_USERS) throw new Error('DASHBOARD_USERS must be set')`.
3. Document `DASHBOARD_USERS` format in `.env.example`.

**Effort:** ~1 hour

---

### P1-3: Replace Plaintext Password Comparison with bcrypt

**Severity:** CRITICAL
**File:** `usme-dashboard/src/server.ts:316`
**Issue:** `password === storedPassword` — no hashing, no rate limiting.

**Steps:**
1. Add `bcrypt` to `usme-dashboard` package.json.
2. Replace equality check with `await bcrypt.compare(inputPassword, storedHash)`.
3. Update `DASHBOARD_USERS` format to store bcrypt hashes, not plaintext.
4. Add `express-rate-limit` to the `/login` route (10 attempts / 15 min / IP).

**Libraries to add:** `bcrypt`, `@types/bcrypt`, `express-rate-limit`
**Effort:** ~2 hours

---

### P1-4: Remove All Hardcoded `/home/alex/` Paths

**Severity:** CRITICAL
**Issue:** Multiple production files embed absolute paths to the developer's home directory. The system is unrunnable on any other machine.

**Specific changes:**

| File | Current Value | Replace With |
|---|---|---|
| `usme-dashboard/src/server.ts:21–22` | `/home/alex/ai/projects/...` | `process.env.SWARM_SERVER_DIR` (crash if absent) |
| `packages/usme-core/src/consolidate/promote.ts:277` | `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/` | `process.env.OPENCLAW_WORKSPACE_DIR + '/skills/'` |
| `packages/usme-core/src/scripts/promote-candidate.ts:129` | Same | Same env var |
| `packages/usme-core/run-consolidation.mts:3` | Absolute import | Relative import or env var |
| `packages/usme-openclaw/package.json` build script | `../../../../.openclaw/extensions/usme-claw/` | `OPENCLAW_EXTENSIONS_DIR` env var or computed relative path |

**Effort:** ~3 hours

---

### P1-5: Add Startup Environment Validation

**Severity:** HIGH
**Issue:** Missing env vars cause silent failures or fall back to insecure defaults.

**Required variables to validate (crash loudly if missing or insecure):**
- `DATABASE_URL` — no fallback with embedded credentials
- `SESSION_SECRET` — must not equal the known default string
- `DASHBOARD_USERS` — must be present and parseable
- `OPENAI_API_KEY` — must be present
- `OPENCLAW_WORKSPACE_DIR` — must be a valid directory
- `SWARM_SERVER_DIR` / `SWARM_UI_DIR` — must be valid directories

**Implementation:** Add an `src/config/validate-env.ts` module to both `usme-core` and `usme-dashboard`. Use Zod (already a dependency in `usme-core`) or `envalid`.

**Effort:** ~3 hours

---

### P1-6: Add .env.example Files to All Repos

**Severity:** HIGH
**Issue:** No documentation of required environment variables. New developers cannot set up the system without reading all source files.

**Action:** Add `.env.example` to `usme-claw/`, `usme-dashboard/`, and `rufus-plugin/` listing all env vars with descriptions and safe example values.

**Effort:** ~1 hour

---

### P1-7: Add README to usme-dashboard

**Severity:** HIGH
**Issue:** Zero documentation for the dashboard — the only entry point is 883 lines of `server.ts`.

**Cover:**
- Purpose and architecture overview
- Prerequisites (Node version, PostgreSQL, env vars)
- How to run (development and production)
- Available routes and their purpose
- Known limitations (single-user, in-memory sessions before P1-8)

**Effort:** ~2 hours

---

### P1-8: Replace In-Memory Session Store

**Severity:** HIGH
**File:** `usme-dashboard/src/server.ts`
**Issue:** `MemoryStore` — all sessions lost on every restart.

**Action:** Replace with `connect-pg-simple` (PostgreSQL-backed sessions using the existing `pg` connection pool). Run the session table migration as part of the existing `node-pg-migrate` setup.

**Library:** `connect-pg-simple`
**Effort:** ~1 hour

---

### P1-9: Add Process Manager for usme-dashboard

**Severity:** HIGH
**Issue:** Dashboard started with raw `tsx src/server.ts` — crashes are not recovered automatically.

**Action:** Add `ecosystem.config.cjs` for PM2 with:
- Restart policy (`max_restarts: 10`, `restart_delay: 5000`)
- Log rotation
- Environment variable injection
- Watch mode disabled in production

**Or:** Add a `systemd` service unit file for VPS/server deployments.

**Effort:** ~1 hour

---

**Phase 1 Total: ~17 hours (~2.5 dev days)**

---

## Phase 2 — High: Fix in First Sprint (~2.5 dev days)

These issues significantly affect security, maintainability, or developer experience. They should be resolved within the first sprint after handoff.

---

### P2-1: Add Retry Logic to embedText()

**File:** `packages/usme-core/src/embed/openai.ts`
**Issue:** Zero retry on transient OpenAI API failures — every turn fails hard on a hiccup.

**Action:** Wrap the OpenAI call with `p-retry` (3 attempts, exponential backoff). Log each retry via pino.
**Library:** `p-retry`
**Effort:** ~1 hour

---

### P2-2: Unify Model Name Configuration

**Issue:** `claude-sonnet-4-5` vs `claude-sonnet-4-6` used inconsistently. `claude-haiku-4-5` hardcoded in `nightly.ts:167` with no override. Embedding model and dimensions not env-configurable.

**Action:**
1. Create `packages/usme-core/src/config/models.ts` with named exports: `DEFAULT_REASONING_MODEL`, `DEFAULT_FAST_MODEL`, `DEFAULT_EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`.
2. Wire all model references to read from this file, with `process.env` overrides.
3. Remove the hardcoded `"claude-haiku-4-5"` in `nightly.ts:167`.

**Effort:** ~2 hours

---

### P2-3: Add Security Headers to usme-dashboard

**Action:**
1. Add `helmet` middleware (secure defaults for CSP, HSTS, X-Frame-Options, etc.).
2. Tighten SSE CORS from `*` to an explicit allowlist.
3. Mark session cookies `secure: true` and `httpOnly: true`.

**Library:** `helmet`
**Effort:** ~1 hour

---

### P2-4: Decompose usme-dashboard/src/server.ts

**Issue:** 883-line God file containing auth, HTML templates, SSE logic, pg queries, file-system helpers, and CJS bridging.

**Target structure:**
```
src/
  routes/
    auth.ts       — login/logout routes
    api.ts        — data API routes
    sse.ts        — SSE streaming routes
  db/
    queries.ts    — all pg query functions
  middleware/
    auth.ts       — session auth middleware
  templates/
    html.ts       — HTML template strings
  server.ts       — Express setup only (~50 lines)
```

**Effort:** ~4 hours

---

### P2-5: Decompose consolidate/reflect.ts

**Issue:** 825-line God file mixing orchestration, prompt building, JSON repair (3-strategy), DB writes, and audit logging.

**Target structure:**
```
consolidate/
  reflect/
    orchestrate.ts   — top-level flow
    prompts.ts       — LLM prompt templates
    repair.ts        — JSON repair fallback strategies
    audit.ts         — audit log writes
  reflect.ts         — entry point only (~50 lines)
```

**Effort:** ~4 hours

---

### P2-6: Unify SkillCandidate Types

**Issue:** `schema/types.ts:SkillCandidate` and `consolidate/promote.ts:PromoteSkillCandidate` are near-identical structs.

**Action:** Define one canonical type in `schema/types.ts` and import it from `promote.ts`.
**Effort:** ~1 hour

---

### P2-7: Extract Slug Generation to a Shared Utility

**Issue:** Slug regex duplicated in 3 places: `promote.ts:276`, `promote-candidate.ts:126`, `promote-candidate.ts:28`.

**Action:** Extract to `packages/usme-core/src/utils/slug.ts` and import.
**Effort:** ~30 minutes

---

### P2-8: Extract SKILL.md Template to a Shared Module

**Issue:** SKILL.md markdown template duplicated between `promote.ts` and `promote-candidate.ts`.

**Action:** Extract to `packages/usme-core/src/templates/skill-md.ts`.
**Effort:** ~30 minutes

---

### P2-9: Fix Silent Error Swallowing in usme-openclaw

**Files:** `packages/usme-openclaw/src/index.ts:364` (`bumpAccessCounts`), `:103` (dir creation)

**Action:** Replace silent `.catch(() => {})` with pino error log calls. Non-fatal errors should be logged with context, not silently dropped.
**Effort:** ~30 minutes

---

### P2-10: Add Zod Validation to JSON.parse Call Sites

**Files:**
- `consolidate/reconcile.ts:96` — `JSON.parse(concept.embedding)`
- `assemble/retrieve.ts:141` — `JSON.parse(raw) as number[]`
- `rufus-plugin/src/context-logger/config.ts:32`

**Action:** Define Zod schemas and wrap each parse with `.safeParse()` + pino error logging on failure.
**Effort:** ~2 hours

---

### P2-11: Add CI Pipeline

**Action:** Add `.github/workflows/ci.yml` to `usme-claw` and `usme-dashboard` with:
- TypeScript type-check (`tsc --noEmit`)
- ESLint
- Build verification
- Test runner (even if no tests yet — fail gracefully)

**Effort:** ~2 hours

---

**Phase 2 Total: ~18 hours (~2.5 dev days)**

---

## Phase 3 — Medium: Next Quarter (~3 dev days)

These items improve long-term maintainability and scaling readiness. Not blocking for handoff but should be scheduled.

---

### P3-1: Replace In-Memory Queue with pg-boss

**File:** `packages/usme-core/src/extract/queue.ts`
**Benefit:** Persistent jobs, per-job retry, backpressure, dead-letter queue, missed-run detection.
**Library:** `pg-boss`
**Effort:** ~1–2 days

---

### P3-2: Replace node-cron Scheduler with pg-boss Scheduled Jobs

**Benefit:** Persistent schedule, missed-run detection, no duplicate fires on multi-instance.
**Note:** Implement after P3-1.
**Effort:** ~1 day

---

### P3-3: Migrate usme-openclaw Custom Loggers to pino

**Files:** `packages/usme-openclaw/src/index.ts` (custom `dbg()`, `writeInjectionLog()`)
**Benefit:** Consistent structured logging across the entire system, configurable transports, log level filtering.
**Effort:** ~2 hours

---

### P3-4: Add Tests for rufus-plugin/context-logger

**File:** `rufus-plugin/src/context-logger/distiller.ts`
**Issue:** Circuit breaker, Gemini Flash API, and fallback logic — the highest-complexity, highest-risk untested code in the codebase.
**Action:** Add unit tests for circuit breaker state transitions and API fallback behavior using `vitest` + mocked fetch.
**Effort:** ~4 hours

---

### P3-5: Add NGINX/Caddy Reverse Proxy

**Benefit:** TLS termination, rate limiting, security headers, port unification (no more 3456/3747 confusion), gzip.
**Action:** Add `nginx.conf` or `Caddyfile` to `usme-dashboard/deploy/`.
**Effort:** ~2 hours

---

### P3-6: Add Dockerfile for usme-claw and usme-dashboard

**Benefit:** Reproducible builds, portability, easier deployment to VPS/cloud.
**Action:** Write multi-stage Dockerfiles for both. Add `docker-compose.yml` for local development (app + postgres).
**Effort:** ~4 hours

---

### P3-7: Document Single-User Constraint

**Action:** Add an explicit architecture note to all READMEs and `usme-core/docs/` stating:
- The system is single-user by design
- The specific singletons that enforce this (pool, queue, embedding cache, scheduler)
- What would need to change to support multi-tenancy

**Effort:** ~1 hour

---

### P3-8: Extend pgvector to Score Pipeline

**File:** `packages/usme-core/src/assemble/score.ts:108–119`
**Action:** Replace the JS cosine similarity for-loop with pgvector `<=>` operator in the SQL query.
**Effort:** ~2 hours

---

**Phase 3 Total: ~3 dev days**

---

## Effort Summary

| Phase | Items | Estimated Effort |
|---|---|---|
| Phase 1 — Critical (pre-handoff) | 9 items | ~17 hours (~2.5 dev days) |
| Phase 2 — High (first sprint) | 11 items | ~18 hours (~2.5 dev days) |
| Phase 3 — Medium (next quarter) | 8 items | ~3 dev days |
| **Total** | **28 items** | **~8–9 dev days** |

---

## Handoff Checklist

### Security Gate
- [ ] P1-1: Key material rotated and removed from repo history
- [ ] P1-2: Fallback credentials removed; startup crashes on missing `DASHBOARD_USERS`
- [ ] P1-3: bcrypt password hashing in place; rate limiting on `/login`
- [ ] P1-5: Startup validation crashes on insecure env vars

### Portability Gate
- [ ] P1-4: No `/home/alex/` paths in any source file
- [ ] P1-6: `.env.example` files in all repos
- [ ] P1-7: README in `usme-dashboard`
- [ ] System verified to start cleanly on a fresh machine using only the README

### Operational Gate
- [ ] P1-8: Persistent session store (connect-pg-simple)
- [ ] P1-9: Process manager configured (PM2 or systemd)
- [ ] P2-11: CI pipeline running on PRs

### Code Quality Gate (Recommended)
- [ ] P2-4: `server.ts` decomposed (or at minimum fully documented)
- [ ] P2-9: Silent error swallows fixed in `usme-openclaw`
- [ ] P2-2: Model names unified in `config/models.ts`
