# USME Reflect + Promote: Architecture Specification
_Alex Spinelli · April 10, 2026 · v1_

> **Implementation status (updated 2026-04-28):** Partially implemented. See "Implementation Delta" section at the bottom for what diverged from this spec.


---

## Overview

This document specifies the two-process skill pipeline for USME. It supersedes the skill delivery section of `memory-innovation.md` and extends the existing reflect/nightly architecture.

---

## Two Processes

### Process 1 — REFLECT (exists, needs changes)

**Purpose:** Consolidate memory, improve quality, surface skill candidates.

**Triggers:**
- On-demand: `openclaw usme reflect`
- Scheduled: 08:00 Pacific (16:00 UTC) + 20:00 Pacific (04:00 UTC) — already in `scheduler.ts`

**Produces:** Thin skill candidates — `name`, `trigger_pattern`, `description`, `confidence` — stored in `skill_candidates` table.

**Quality gate:** Only reflect runs graded **B+ or above** (from `overall_assessment` in `reflection_runs`) write skill candidates. B or below → no candidates written for that run.

**Confidence floor:** Candidates below **0.5 confidence** are not written. 0.5–0.69 land in `skill_candidates` as `quality_tier='draft'`. 0.70+ land as `quality_tier='candidate'`.

**Post-run signal:**
- If the reflect run created any new candidates AND the current time is between 06:00–22:00 Pacific: schedule a one-shot OpenClaw system event `usme:candidates-ready:{runId}` to fire 10 minutes later.
- If outside that window: set a `pending_morning_notify` flag in DB; the morning cron picks it up.

**What REFLECT does NOT do:**
- Does not generate full SKILL.md content (no LCM access, would hallucinate procedural details)
- Does not write to the `skills` table (candidates live in `skill_candidates` only until promoted)
- Does not prompt the user directly

---

### Process 2 — PROMOTE (new)

**Purpose:** Turn user-approved candidates into full, installed, usable SKILL.md files.

**Triggers:**
- Morning cron: 08:00 Pacific — queries for any `prompted_at IS NULL` candidates, presents them if any exist
- Post-reflect signal: fired by Process 1 when conditions are met (daytime + new candidates)
- On-demand: `openclaw usme promote` (lists all pending candidates, user can pick)

**Morning notification format:**
```
☀️ N skill candidate(s) ready for review:
1. [Name] ([confidence]) — [one-line description]
2. [Name] ([confidence]) — [one-line description]
...

Reply with numbers to promote (e.g. "1 3"), "all", "skip", or "detail N" for more on any candidate.
```

**User interactions:**
- `1 3` or `all` — promote those candidates
- `skip` — defer all; they'll reappear tomorrow
- `detail 2` — show full description, source episodes, confidence, quality tier, age; wait for promote/skip decision on that one
- `dismiss N` — permanently discard a candidate

**Enrichment pipeline (runs when user approves a candidate):**

This runs as a full Rufus agent turn — not a background cron — so the user can observe progress.

1. Query `skill_candidates` + source episodes from USME DB for context
2. Call `lcm_expand_query` with the skill name and description as the prompt — retrieves actual procedural detail from LCM conversation history (exact commands used, failure modes encountered, recovery steps taken)
3. Call `web_search`: "[skill domain] best practices" + "[skill name] how to"
4. Read 1–2 existing SKILL.md files from `workspace-rufus/skills/` as format examples
5. Synthesize full SKILL.md covering: when-to-use triggers, when NOT to use, prerequisites, step-by-step commands with expected outputs, failure modes + recovery, verification steps
6. **Show the generated SKILL.md to the user before writing** — explicit approval gate
7. On approval: write to `workspace-rufus/skills/<slug>/SKILL.md`
8. Embed the full body text via OpenAI
9. Flip `skill_candidates.accepted = true`, `accepted_at = now()`
10. Insert into `skills` table with `status = 'active'`, full `skill_path`, `promoted_at`
11. Log to Rufus memory: "Skill '[name]' promoted and registered on [date]"

---

## Schema Changes Required

### `skill_candidates` table — add columns

```sql
-- Migration: 014_skill_candidates_promote.sql
ALTER TABLE skill_candidates
  ADD COLUMN IF NOT EXISTS prompted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_tier      TEXT NOT NULL DEFAULT 'candidate'
                           CHECK (quality_tier IN ('draft', 'candidate')),
  ADD COLUMN IF NOT EXISTS defer_until       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promoted_skill_id INTEGER REFERENCES skills(id),
  ADD COLUMN IF NOT EXISTS source            TEXT NOT NULL DEFAULT 'reflect'
                           CHECK (source IN ('reflect', 'nightly'));
```

### `skills` table — add columns

```sql
-- Part of same migration
ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS promoted_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_candidate_id  INTEGER REFERENCES skill_candidates(id),
  ADD COLUMN IF NOT EXISTS generation_notes     JSONB;
```

---

## Code Changes

| File | Change |
|---|---|
| `nightly.ts → stepSkillDraft()` | **Retire this function.** All skill candidate production moves to `reflect.ts`. Delete or stub with a no-op. |
| `reflect.ts → runReflection()` | After writing candidates: check grade. If B+ or above and count > 0, check time window. If daytime, dispatch system event. If nighttime, set `pending_morning_notify` flag. Add `quality_tier` and `source='reflect'` to all candidate inserts. |
| `scheduler.ts` | Add morning promote-check cron at 09:00 Pacific (17:00 UTC). Queries `skill_candidates WHERE prompted_at IS NULL AND dismissed_at IS NULL AND (defer_until IS NULL OR defer_until < now())`. If any found: fire `usme:candidates-ready:morning` system event. |
| **NEW** `promote.ts` (usme-core) | `getPromoteCandidates()`, `markCandidatesPrompted()`, `markCandidateAccepted()`, `markCandidateDismissed()`, `deferCandidate()`, `buildPromoteCard()` — pure DB + formatting functions |
| **NEW** `promote.ts` (usme-openclaw commands) | CLI: `openclaw usme promote [--force] [--id <uuid>]`. Lists pending candidates, handles user responses |
| `index.ts` (usme-openclaw) | Register `command:usme:promote` handler. Register system event handler for `usme:candidates-ready:*` — fires the promote notification via `api.sendMessage()` or equivalent OpenClaw API |

---

## Corner Cases & Decisions Made

| Case | Decision |
|---|---|
| Post-reflect cron fires at 2am | System event is only scheduled if time is 06:00–22:00 Pacific. Outside window: `pending_morning_notify` flag set; morning cron picks it up. |
| Morning cron + post-reflect both fire for same candidates | Morning cron uses `prompted_at IS NULL` — if post-reflect already set it, morning finds nothing. Natural de-dupe. |
| Candidate accumulation | Cap promote view at 10 per session, ordered by confidence desc. Auto-expire candidates older than 30 days (`dismissed_at = now()` via nightly cleanup). |
| Two candidate quality tiers | `draft` (0.5–0.69) shown separately or suppressed unless user runs `openclaw usme promote --include-drafts`. Default view shows `candidate` tier only. |
| Generated SKILL.md quality | Always show to user before writing. Require at least 1 LCM hit OR 2 web sources; otherwise show warning "low source confidence" with option to proceed or defer. |
| Skill name collision | Before writing, check for slug collision in `workspace-rufus/skills/`. If found: append `-v2` suffix, warn user. |
| Skills versioning | User chose versioned (OQ-2). Prior version kept. New version gets `-v2`, `-v3` suffix. |
| Confidence floor | 0.5 minimum (OQ-5). Sub-0.5 not written at all. |
| Reflect quality gate | B+ and above only create candidates (OQ-4). `overall_assessment` field in `reflection_runs` drives this. |
| Timezone | Pacific throughout (OQ-1). All cron times in Pacific. |
| Coverage gap detection | Out of scope for this build. Planned for v2. |

---

## What Stays The Same

- Reflect's core pipeline (episodify, promote, contradictions, entities, decay) — unchanged
- The `skills` table as the authoritative active skill store
- The `skill_candidates` table (just extended)
- The nightly 03:00 UTC consolidation pipeline
- The morning/evening reflection schedule (08:00 + 20:00 Pacific)
- Build system rules (single esbuild bundle, no parallel dist)

---

## Dashboard Panel 4 — Skills (updated requirement)

**Active skills section** — unchanged from `memory-innovation.md`.

**Pending candidates section** — updated:
- Show `quality_tier` badge (draft / candidate)
- Show `prompted_at` (last time user was notified)
- Show source episode count (how many episodes produced this candidate)
- Show age (days since `created_at`)
- "Promote", "Dismiss", "Detail" buttons per row
- Approval rate summary: accepted / dismissed / pending counts + avg confidence per bucket

---

## Deferred to v2

- Coverage gap detection ("patterns without candidates")
- Per-skill usage analytics (how often a promoted skill is retrieved and used)
- Batch promotion via CLI (`openclaw usme promote --all`)
- Hot-loading vs gateway restart on skill registration (spike required before Stage 2 implementation)

---

## Implementation Delta (as of 2026-04-28)

What was built diverges from this spec in the following ways:

### Implemented as specified ✓
- `skill_candidates` schema columns (`quality_tier`, `prompted_at`, `dismissed_at`, `promoted_skill_id`, `source`, `defer_until`) — all present
- `skills` schema columns (`promoted_at`, `source_candidate_id`, `generation_notes`) — all present
- `stepSkillDraft()` retired — no reference in nightly/scheduler
- Grade quality gate (B+ or above) — implemented in reflect.ts; `isPassing()` in promote.ts
- Confidence floor (0.5 minimum, 0.5–0.69 = draft, 0.70+ = candidate)
- `pending_morning_notify` flag set on nighttime reflect runs
- Morning delivery cron at 17:00 UTC (09:00 Pacific) via `usme-skill-delivery` pg-boss job
- `pg_trgm` similarity guard (>0.5) for near-duplicate blocking on insert

### Not implemented / diverged ✗

**Enrichment pipeline (the big gap):**
The enrichment turn specified in steps 1–11 was never built. `promote-candidate.ts` writes a **thin scaffold** SKILL.md directly (with placeholder sections: "To be filled in during enrichment") rather than firing a system event that triggers a full Rufus agent turn with 4-source evidence gathering.

`buildEnrichEventText()` in promote.ts does not exist. The script instead calls `getEnrichContext()` to pull DB metadata and uses that to populate a scaffold template only.

**Post-reflect daytime signal:**
Spec says: fire `usme:candidates-ready:{runId}` system event immediately when daytime + new candidates.
Reality: reflect.ts logs "daytime — caller will deliver candidates-ready notification" but does NOT fire the event. The `sendFn` path in `deliverSkillCandidates()` is what actually fires the notification — but that runs at 17:00 UTC on the `usme-skill-delivery` cron, not immediately post-reflect.

**`/usme-promote` plugin command:**
Spec says: register `usme:promote` command handler + `usme:candidates-ready:*` system event handler.
Reality: only `/usme-reflect` is registered. No `/usme-promote` command exists in the plugin.

**`commands/promote.ts`:**
The `usme-openclaw` package has `commands/reflect.ts` only. The promote command file was never created.

### What to do about it
The enrichment gap is deliberate (confirmed 2026-04-28): Rufus manually enriches candidates in conversation using the four-source method described in the usme-ops SKILL.md. The `promote-candidate.ts` script handles the DB/file scaffolding; Rufus handles the content enrichment. This is the current operational workflow.

The `/usme-promote` command and daytime post-reflect signal are genuine P2 items — useful but not blocking.
