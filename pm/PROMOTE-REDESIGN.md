# PROMOTE Redesign — Spec & Work Plan

**Date:** 2026-04-10  
**Status:** Approved for implementation  
**Author:** Rufus (PM)  
**Stage:** DESIGN → BUILD

---

## Problem Statement

The `/usme-promote` plugin command was architected for terminal execution — it uses `readline.createInterface` to interactively present candidates and accept input. OpenClaw plugin commands run inside the gateway process with no stdin/stdout access: `console.log` is swallowed, readline blocks indefinitely waiting for input that never arrives, and the command silently times out. The result: nothing happens.

Beyond the immediate bug, the command tried to do too much in one place — data queries, UI presentation, DB writes, LLM enrichment event firing — making it untestable, fragile, and hard to reason about.

---

## Design Decisions

### Decision 1: Plugin commands are thin callers, not logic owners

Plugin commands exist to relay output back to the user via OpenClaw's API. They must not contain business logic, readline loops, or multi-step workflows. All domain logic lives in independently runnable scripts.

### Decision 2: Scripts layer as the foundation

All promotion logic is extracted into `packages/usme-core/src/scripts/`. These scripts are:
- Runnable directly via `npx tsx` from any shell, cron, or Rufus `exec` call
- Independently testable with no OpenClaw dependency
- Composable — Rufus can call them as tool invocations and show you the output

### Decision 3: Rufus is the conversational UI for promotion

The promotion review loop (show candidates → receive approval → trigger enrichment) happens through normal Rufus conversation. Rufus queries the DB, displays the candidate table, you respond in chat with which to approve, Rufus runs the promote script. This is what already worked ad-hoc in the previous turn — we're now institutionalizing it.

The `/usme-promote` plugin command becomes a thin convenience wrapper that calls `list-candidates.ts` and returns output via `api.sendReply()`. Subcommands (`/usme-promote approve 1 3`, `/usme-promote dismiss 2`) call the corresponding scripts.

### Decision 4: Enrichment runs as a Rufus agent turn, not a subprocess

On approval, a system event fires → Rufus wakes in the main session with full tool access. This is correct. The enrichment prompt is what needs to be substantially improved (see Decision 5).

### Decision 5: Four-source evidence gathering for enrichment

When writing a SKILL.md, Rufus gathers evidence from four sources in this order:

1. **USME DB** — candidate metadata: name, description, trigger_pattern, confidence, source_episode_ids. The seed. Establishes what the skill is about.

2. **LCM conversation history** (`lcm_expand_query`) — *what we actually did*: real commands, real errors, real recovery paths from past sessions. This is the anchor. Highest trust — grounded in our environment. Used for all commands, failure modes, and exact syntax in the SKILL.md.

3. **Web search** — *what the field recommends*: best practices, current library versions, known gotchas, alternative approaches. Additive only. Used to fill gaps LCM doesn't cover and to surface better practices we may have missed. Where web conflicts with LCM, prefer LCM but note the discrepancy.

4. **Existing skill file** (format exemplar) — read one well-formed SKILL.md from `workspace-rufus/skills/` before writing, to ensure consistent structure and completeness.

**Synthesis rule:** "Ground commands and failure modes in what we actually did. Use best practices to fill gaps and add warnings. Never invent — if evidence is absent, say so explicitly in the skill file."

---

## Deliverables

### D1 — Scripts (usme-core)

**File:** `packages/usme-core/src/scripts/list-candidates.ts`
- Queries `skill_candidates` where `approval_status = 'pending'`
- Outputs a formatted table (numbered, name, confidence, quality_tier, created date)
- Also outputs raw JSON to stderr or a `--json` flag for machine consumption
- Accepts `--include-drafts` flag (show confidence < 0.7)
- Accepts `--force` flag (show already-prompted candidates)

**File:** `packages/usme-core/src/scripts/promote-candidate.ts`
- Accepts `<id>` as argument (numeric candidate ID)
- Marks candidate `acceptance_status = 'accepted'`, `accepted_at = NOW()`
- Inserts row into `skills` table (status=`active`, skill_path, source_candidate_id)
- Updates `skill_candidates.promoted_skill_id`
- Calls `getEnrichContext(candidateId)` to build enrichment bundle
- Fires `openclaw system event --text <enrichment_prompt> --mode now`
- Sets `enrichment_status = 'pending'`
- Prints confirmation: candidate name, skill ID, enrichment event fired

**File:** `packages/usme-core/src/scripts/dismiss-candidate.ts`
- Accepts `<id>` as argument
- Sets `approval_status = 'dismissed'`, `dismissed_at = NOW()`
- Prints confirmation

All three scripts: no OpenClaw imports, no readline, no side effects beyond DB + stdout.

---

### D2 — Plugin command rewrite (usme-openclaw)

**File:** `packages/usme-openclaw/src/commands/promote.ts`

Remove: `readline.createInterface`, all interactive loop code, `console.log` usage.

Replace with stateless subcommand dispatch:

```
/usme-promote              → calls list-candidates logic, api.sendReply(formatted table)
/usme-promote approve 1 3  → calls promote-candidate for IDs at positions 1 and 3
/usme-promote dismiss 2    → calls dismiss-candidate for ID at position 2
/usme-promote detail 4     → returns full description + trigger + source episodes for candidate 4
```

Output always via `api.sendReply()`. No business logic in the command — it calls script functions and formats output.

---

### D3 — Enrichment prompt rewrite (usme-openclaw)

**File:** `packages/usme-core/src/consolidate/promote.ts` — `buildEnrichEventText()`

Current prompt fires a system event with candidate name + description + thin context. Rewrite to instruct Rufus to:

1. Call `lcm_expand_query` with the skill topic to retrieve procedural conversation history
2. Call `web_search` for: `"<skill topic> best practices"` and `"<skill topic> common mistakes"`
3. Read an existing SKILL.md from `workspace-rufus/skills/` as format reference
4. Call USME DB (via exec) to fetch source episodes if `source_episode_ids` is populated
5. Synthesize a complete SKILL.md at `workspace-rufus/skills/<slug>/SKILL.md` containing:
   - `when-to-use` and `when-NOT-to-use` triggers
   - Prerequisites (tools, env vars, config)
   - Step-by-step commands with flags and expected outputs (sourced from LCM)
   - Failure modes and recovery paths (sourced from LCM)
   - Best practices and warnings (sourced from web)
   - Verification steps
6. Write the file to disk
7. Update `skills` table: set `skill_path`, compute embedding on full body, set `enrichment_status = 'complete'`
8. Report back: what was found in LCM, what web added, what was left underspecified

---

### D4 — Build, deploy, verify

- `npm run build` from `packages/usme-openclaw/`
- Restart gateway
- Rufus runs `list-candidates.ts` via exec — verifies table output
- Rufus runs `promote-candidate.ts 2` (Fix PostgreSQL Transaction Poisoning) as first real test
- Confirm system event fires and enrichment turn executes
- Confirm SKILL.md written to `workspace-rufus/skills/fix-postgresql-transaction-poisoning-with-savepoints/SKILL.md`
- Confirm `skills` row updated with embedding and `enrichment_status = 'complete'`

---

## Sequencing

```
D1 (scripts)         → no dependency, can start immediately
D2 (plugin rewrite)  → depends on D1 exports being defined
D3 (enrich prompt)   → no code dependency, can write in parallel with D1/D2
D4 (build + verify)  → depends on D1 + D2 + D3 complete
```

D1, D2, D3 can all go to Claude Code in a single task. D4 is Rufus-driven verification.

---

## What Is Not Changing

- `reflect.ts` — no changes needed
- Database schema — no migrations needed (all columns already exist)
- `getEnrichContext()` function — keep as-is, it already pulls the right data
- The system event → Rufus turn pattern — this is correct and stays
- Morning delivery / daily cron — not in scope for this change

---

## Success Criteria

- `/usme-promote` typed in TUI returns a candidate table immediately (no hang)
- `approve 2` promotes "Fix PostgreSQL Transaction Poisoning" and triggers a visible enrichment turn
- Enrichment turn cites specific LCM evidence and web sources in its output
- Final SKILL.md is present on disk, readable, and follows standard format
- All future approvals go through the same repeatable path with no special-casing

---

## Open Questions

None — all design decisions resolved in session 2026-04-10.
