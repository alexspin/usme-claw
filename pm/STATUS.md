# USME Project Status

**Stage:** SHIP (deployed, operational)  
**Last updated:** 2026-04-09  
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
| Skill creation (reflection path) | ✅ Working | 5 candidates created 2026-04-09 |
| Skill candidate delivery | ✅ Live | Daily cron at 17:00 UTC |
| Dashboard | ✅ Live | https://collective7.spinelli5.com/usme/ |
| Privacy flags (exclude_from_reflection) | ✅ Schema | Migration 013, nothing excluded by default |
| Migrations 001–013 | ✅ Applied | All live on production DB |

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

### Skill candidates not promoted to active

The 5 skills created 2026-04-09 have `status = 'candidate'` and `embedding = null`. They appear in the dashboard but are not injected into context. Promote to `active` and generate embeddings when ready.

### reconcile.ts model version drift

`reconcile.ts` hardcodes `claude-sonnet-4-6` rather than reading from the config object. Minor risk if the config's sonnet model version changes — reconcile won't follow.

---

## Next planned work

1. **Importance score backfill** — decide strategy (A/B/C) and execute
2. **Promote candidate skills to active** — generate embeddings, flip status
3. **Entity relationship graph density** — manual seeding or tune reflection prompts to produce more relationship updates
4. **Reflect prompt tuning** — current skill candidates are too operationally specific (project how-tos); tune toward generalizable cross-domain patterns
5. **reconcile.ts model config** — consolidate to single model config source
6. **Local embeddings** — Ollama nomic-embed-text would save ~400ms/turn; deferred from v1

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
