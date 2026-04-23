# USME Project Status

**Stage:** SHIP (deployed, operational)
**Last updated:** 2026-04-23
**Owner:** Alex

---

## What is deployed and working

| Feature | Status | Notes |
|---|---|---|
| Active mode injection | ✅ Live | Since 2026-04-06 20:58 UTC. 43–60 items/turn, ~54ms latency |
| Fact extraction (Haiku) | ✅ Live | 3–4 facts/turn, async |
| Entity extraction (Haiku) | ✅ Live | Async, populating entity graph |
| Embeddings | ✅ Live | OpenAI text-embedding-3-small, 1536 dims |
| ANN retrieval (pgvector) | ✅ Live | HNSW indexes on all tiers |
| Spreading activation | ✅ Wired | Running but sparse (entity graph has 0–1 edges/entity) |
| Consolidation pipeline | ✅ Live | Nightly 03:00 UTC + 30min mini |
| importance_score at creation | ✅ Live | Migration 010, Haiku scores new episodes |
| Reflection service | ✅ Live | 2× daily (04:00 + 16:00 UTC), CLI available |
| Skill creation (reflection path) | ✅ Working | 137 candidates pending (confidence 0.81–0.97) |
| Skill promotion (script-based) | ✅ Live | CLI scripts: list-candidates, promote-candidate, dismiss-candidate |
| Skill candidate delivery | ✅ Live | Morning cron at 17:00 UTC fires when candidates pending |
| Dashboard | ✅ Live | https://collective7.spinelli5.com/usme/ (unified server, port 3456) |
| Privacy flags (exclude_from_reflection) | ✅ Schema | Migration 013, nothing excluded by default |
| Migrations 001–014 | ✅ Applied | All live on production DB |
| HEARTBEAT noise filter | ✅ Live | critic.ts + extraction guard in index.ts |
| before_message_write hook | ✅ Live | Strips <usme-context> blocks before transcript storage |
| **Phase 1 security hardening** | ✅ **Complete** | P1-1 through P1-9 shipped 2026-04-23 (see below) |

### Phase 1 security hardening (shipped 2026-04-23)

| Item | Status | Notes |
|---|---|---|
| P1-1: Ed25519 key rotation | ✅ Complete | Old device b24cd395 removed, new device fe829ba2 registered. Keys gitignored. **Git history rewrite deferred — requires explicit approval.** |
| P1-2: Remove hardcoded fallback credentials | ✅ Complete | users claw-alex-26 / claw-adam-26 removed. Server crashes fatally if DASHBOARD_USERS missing. |
| P1-3: bcrypt + rate limiting | ✅ Complete | bcrypt 12 rounds on /login; express-rate-limit 10 attempts / 15 min |
| P1-4: Hardcoded /home/alex/ paths (dashboard) | ✅ Complete | SWARM_SERVER_DIR / SWARM_UI_DIR env vars with warn-on-missing fallback |
| P1-5: Startup env validation | ✅ Complete | src/config/validate-env.ts: SESSION_SECRET presence/length/insecure-default, PORT range, PGPASSWORD dev warning |
| P1-6: .env.example files | ✅ Complete | usme-dashboard (9 vars) and usme-claw (7 vars) |
| P1-7: usme-dashboard README | ✅ Complete | Architecture, auth flow, setup, routes table, known limitations |
| P1-8: PostgreSQL session store | ✅ Complete | connect-pg-simple replaces MemoryStore |
| P1-9: CI workflow | ✅ Complete | .github/workflows/ci.yml added to usme-dashboard and usme-claw. **Process manager (PM2/systemd) deferred.** |

---

## Known issues / incomplete

### Nightly skill path blocked (importance_score backfill)

All 160 episodes created before migration 010 have `importance_score = 5` (hardcoded fallback). The `stepSkillDraft` gate requires `importance_score >= 7`. Zero legacy episodes qualify.

**Impact:** The nightly pipeline produces no skills. The reflection service path works fine and is the only active skill-creation path.

**Resolution options:**
- (A) Backfill via Haiku API calls — principled, ~$0.01/episode, ~$1.60 total
- (B) Bulk SQL update to importance_score = 7 for all unscored episodes — fast, heuristic
- (C) Lower gate threshold temporarily — risky, reduces quality filter

**Decision pending.**

### Entity graph sparse

298 entities extracted, 0–1 relationships each. Spreading activation runs but adds minimal items. Will improve gradually as the reflection service makes entity relationship updates on each run.

### Skill candidate source_episode_ids (pre-f17b306)

Candidates from reflect runs before commit f17b306 have `source_episode_ids = null`. Enrichment context will be limited for those candidates. New runs populate correctly.

### Item caps not yet implemented

`pack.ts`/`modes.ts` item caps not yet implemented — episodes can still dominate injection budget (~27 items at 300–400 tokens each).

### Orphaned rows in skills table

21 rows in `skills` table with `status='candidate'` from pre-migration reflect runs are invisible to the promotion flow (which reads `skill_candidates`). They don't block operation but represent stale data.

### reconcile.ts model version drift

`reconcile.ts` hardcodes `claude-sonnet-4-6` rather than reading from the config object. Minor risk if the config's sonnet model version changes — reconcile won't follow.

---

## Next planned work

### Outstanding Phase 1 items (deferred)

- **P1-1 git history rewrite** — Private key in commit 91ed5a2 still in git history. Requires explicit owner approval to proceed.
- **P1-9 process manager** — Server still runs via tsx. PM2 or systemd setup deferred.
- **Hardcoded paths in usme-core** — `promote.ts` and `promote-candidate.ts` still have `/home/alex/` paths. Only usme-dashboard was remediated in P1-4.
- **Port 3747** — Old rufus-plugin standalone dashboard (PID 1761055) still running. Decommission pending decision.
- **Parent workspace submodule pointer** — Ruflo-Claw-Swarm has uncommitted changes; usme submodule pointer not yet committed.

### Phase 2 items (next)

1. **Security headers** — helmet middleware, tighten SSE CORS, session cookie flags (P2-3)
2. **Importance score backfill** — decide strategy (A/B/C) and execute
3. **Promote remaining skill candidates** — 137 pending with confidence 0.81–0.97
4. **Entity relationship graph density** — manual seeding or tune reflection prompts to produce more relationship updates
5. **Item caps (pack.ts)** — prevent episode tier from dominating injection budget
6. **reconcile.ts model config** — consolidate to single model config source
7. **Decompose server.ts and reflect.ts** — God files (P2-4, P2-5)
8. **Unify model name configuration** — P2-2
9. **Local embeddings** — Ollama nomic-embed-text would save ~400ms/turn; deferred from v1

---

## Stage log

| Date | Stage | Notes |
|---|---|---|
| 2026-03-30 | IDEATION | Project initiated |
| 2026-04-01 | DISCOVERY | PRD written, 6 open questions answered |
| 2026-04-04 | DESIGN | Architecture complete, 27 decisions documented |
| 2026-04-06 | BUILD | Swarm executed, core pipeline live |
| 2026-04-06 | SHIP | Active mode deployed 20:58 UTC |
| 2026-04-08 | SHIP | Refactor: pino, node-cron, tool_use + Zod, tiktoken |
| 2026-04-09 | SHIP | Reflection service, spreading activation, dashboard, migrations 010–013 |
| 2026-04-10 | SHIP | Migration 014, reflect/promote pipeline, script-based promotion, unified dashboard, HEARTBEAT filter, before_message_write hook |
| 2026-04-23 | SHIP | Phase 1 security remediation complete (P1-1 through P1-9 shipped) |
