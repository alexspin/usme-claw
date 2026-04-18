# USME Reflect-Promote Pipeline: Known Issues

**Date:** 2026-04-10  
**Author:** Rufus (pre-swarm audit)  
**Status:** Awaiting swarm fix

---

## Context

The reflect-promote pipeline was implemented by the grand-seaslug swarm (commits 5660fef + 6eba839).
The architecture is correct and the code is mostly right, but three bugs are preventing the system
from functioning end-to-end. No skills have ever reached `skill_candidates` despite 4 reflection
runs completing successfully.

**Authoritative references for the swarm:**
- Architecture: `docs/ARCHITECTURE.md`
- Decisions: `docs/DECISIONS.md`
- Pipeline spec: `pm/REFLECT-PROMOTE.md`
- Current system status: `pm/STATUS.md`
- Schema: `packages/usme-core/db/migrations/` (especially 012, 014)
- Key source files: `packages/usme-core/src/consolidate/reflect.ts`, `promote.ts`, `scheduler.ts`
- Plugin entry: `packages/usme-openclaw/src/index.ts`, `src/commands/promote.ts`

---

## Bug 1: Grade extraction regex fails on markdown-wrapped assessments (CRITICAL)

**File:** `packages/usme-core/src/consolidate/promote.ts`, function `extractGrade()`

**What it does:** Parses the grade letter (A/B/C/D) out of the `overall_assessment` text returned
by Sonnet, so `isPassing()` can decide whether to write skill candidates to the DB.

**The bug:** The regex `^([A-Da-d][+\-]?)` anchors at the start of the string. Sonnet reliably
wraps its assessments in markdown bold: `"**Corpus Health: B+**\n\n..."`. The regex sees `**`
at position 0 and returns an empty string. `isPassing("")` returns false. `qualityPasses = false`.
The skill-candidate write block is skipped entirely.

**Evidence:**
- Run 1: starts with `**Memory Corpus Health: B+...` → extractGrade returns "" → 0 skills written
- Run 2: starts with `Memory corpus health: A-/B+...` (no markdown) → extractGrade returns "M"? 
  Actually "M" doesn't match [A-Da-d] either. Wait — run 2 DID write 5 skills.
  
Actually re-examining: run 2 starts with `"Memory corpus..."` — the `M` doesn't match `[A-Da-d]`
either. So extractGrade still returns "". But run 2 has `skills_created=5`. That means either
the code path was different at run 2 time (pre-swarm code wrote directly to `skills` table),
or there's another explanation. **Conclusion:** Runs 1, 2, 5 used pre-swarm code that wrote to
`skills` table directly. Only run 6 (scheduler-evening, 04:01 UTC Apr 10) used post-swarm code.
Run 6 had `skills_created=0` and the assessment starts with `**Corpus Health: B+**` — regex fails,
`qualityPasses=false`, zero writes.

**The fix:** Make `extractGrade()` search the full string for the first grade pattern, not just
the start. Change:
```ts
const m = overallAssessment.match(/^([A-Da-d][+\-]?)/i);
```
to:
```ts
const m = overallAssessment.match(/\b([A-D][+\-]?)\b/i);
```
Or more robustly: scan for the grade embedded in common patterns like `"B+"`, `"A-"`, `"Grade: B+"`,
`"Health: B+"`, `"**B+**"` etc.

---

## Bug 2: `skill_candidates` table UNIQUE index blocks all duplicate-named candidates (MEDIUM)

**File:** `packages/usme-core/db/migrations/014_skill_candidates_promote.sql`

**The bug:** The unique index is:
```sql
CREATE UNIQUE INDEX idx_skill_candidates_name ON skill_candidates(name) WHERE dismissed_at IS NULL;
```
The INSERT uses `ON CONFLICT (name) DO NOTHING`. But `ON CONFLICT` uses the column constraint,
not a partial index. The table has no standalone `UNIQUE(name)` column constraint — only the
partial index. This means `ON CONFLICT (name)` may not correctly resolve against the partial index
on all PostgreSQL versions, and could either fail silently or raise an error.

More importantly: once a skill with name "Deploy USME Plugin" exists in `skills` (from pre-swarm
runs), any future attempt to insert it into `skill_candidates` won't conflict with `skill_candidates`
at all (different table), but the 21 existing rows in `skills` with `status='candidate'` mean
there's a naming collision risk when promote.ts tries to INSERT into `skills` at promotion time.

**The fix:** Verify that `ON CONFLICT (name) DO NOTHING` works correctly with a partial index
in PostgreSQL 15+. If not, add a full `UNIQUE(name)` constraint to the table (accepting that
dismissed candidates block future same-named skills — which is the intended behavior per the
spec in pm/REFLECT-PROMOTE.md).

---

## Bug 3: 21 pre-swarm skills in `skills` table bypass the promote flow (MEDIUM)

**What happened:** Reflection runs 1, 2, and 5 used pre-swarm code that wrote skills directly
to the `skills` table with `status='candidate'`. These 21 rows exist outside the new promote
workflow. They have no `skill_candidates` counterpart, no `quality_tier`, no `prompted_at`,
and cannot be surfaced by `/usme-promote` or the morning cron.

**The fix (two parts):**
1. Migrate the 21 `skills` rows into `skill_candidates` so the promote flow can surface them.
   Map `teachability` → `confidence`, set `quality_tier='candidate'` for all (all score > 0.70),
   set `source='reflect'`, leave `prompted_at=NULL` so morning cron picks them up.
2. Clear the `skills` table of these pre-swarm candidates (they should not be in `skills` until
   actually promoted).

Migration SQL:
```sql
-- Move pre-swarm skills into skill_candidates
INSERT INTO skill_candidates (name, description, confidence, quality_tier, source, created_at)
SELECT name, description, teachability::numeric(4,3), 'candidate', 'reflect', created_at
FROM skills
WHERE status = 'candidate' AND source_candidate_id IS NULL
ON CONFLICT (name) DO NOTHING;

-- Remove them from skills table
DELETE FROM skills WHERE status = 'candidate' AND source_candidate_id IS NULL;
```

---

## Bug 4: Morning notification `deliverSkillCandidates` prints to stdout only (LOW)

**File:** `packages/usme-core/src/consolidate/scheduler.ts`, function `deliverSkillCandidates()`
**File:** `packages/usme-openclaw/src/index.ts` (the morning cron handler)

**The issue:** `deliverSkillCandidates()` builds the promote card and calls `console.log()` or
prints to stdout. Inside the OpenClaw plugin, stdout isn't routed to the user's chat session.
The morning cron fires at 17:00 UTC but the card never reaches the user.

**The fix:** The scheduler's morning cron should call the OpenClaw message delivery API to send
the card to the active session. In `index.ts`, the morning cron handler should use `api.emit`
or equivalent to deliver the formatted card text as a user-facing message.

Check `deliverSkillCandidates` in `usme-core/src/consolidate/scheduler.ts` — confirm how it
currently delivers the card and what the correct mechanism is for routing a message to the
user's session via the openclaw plugin API.

---

## Non-bugs confirmed working

- ✅ Reflection runs correctly (4 runs, B+ or better)
- ✅ Scheduler fires morning/evening crons
- ✅ `/usme-reflect` registered correctly (post today's fix)
- ✅ `/usme-promote` registered correctly (post today's fix)
- ✅ `skill_candidates` schema is correct (migration 014 ran cleanly)
- ✅ `promote.ts` DB functions are complete and correct
- ✅ `promote` command in `usme-openclaw/src/commands/promote.ts` is complete
- ✅ `reflect.ts` INSERT into `skill_candidates` is correct — just never reached due to Bug 1

---

## Test coverage needed

- [ ] `extractGrade()` with markdown-wrapped input: `"**Corpus Health: B+**"` → `"B+"`
- [ ] `extractGrade()` with plain input: `"B+ — memory health..."` → `"B+"`
- [ ] `isPassing()` with all passing grades (A+, A, A-, B+)
- [ ] `isPassing()` with failing grades (B, B-, C, D)
- [ ] Migration: 21 skills moved to skill_candidates, skills table cleared
- [ ] End-to-end: reflect run with B+ grade produces rows in `skill_candidates`
- [ ] `/usme-promote` with candidates present returns formatted card

