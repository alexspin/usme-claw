# Changes: Context Accumulation Fix + HEARTBEAT Filter (2026-04-10)

## Fix 1 — HEARTBEAT noise filter in critic.ts (HIGH)

**File:** `packages/usme-core/src/assemble/critic.ts`

**Problem:** Heartbeat system events ("HEARTBEAT") were creating sensory traces and being scored for injection. These contain no useful memory content and polluted the candidate pool.

**Fix:** Added a mandatory hard-discard rule in `criticFilter()`:
```ts
if (/\bHEARTBEAT\b/i.test(c.content)) continue; // heartbeat_noise
```
This runs before dedup, after the confidence and isActive checks, on every candidate before injection.

---

## Fix 2 — Extraction guard for HEARTBEAT turns (HIGH)

**File:** `packages/usme-openclaw/src/index.ts`

**Problem:** Even with the critic filter, HEARTBEAT turns were still triggering Haiku fact and entity extraction, burning API calls and writing worthless sensory_trace rows.

**Fix:** Before enqueueing extractions in `before_prompt_build`, the plugin now checks `serializedTurn` for the HEARTBEAT pattern:
```ts
if (/\bHEARTBEAT\b/i.test(serializedTurn)) {
  // fall through to injection return below — skip extraction entirely
}
```
No extraction is enqueued for heartbeat turns. The retrieval + injection pipeline still runs (heartbeat turns still benefit from context).

---

## Fix 3 — before_message_write hook strips <usme-context> blocks (CRITICAL)

**File:** `packages/usme-openclaw/src/index.ts`

**Problem:** `prependContext` injects a `<usme-context>` block (~10K tokens) into the system prompt each turn. OpenClaw stores the full message — including the injected context — in the transcript/agentMessages array. On the next turn, the stored message is loaded, and `<usme-context>` blocks accumulate: turn 2 has 1×, turn 3 has 2×, etc. By turn 10, the context window grows by ~100K extra tokens, eventually causing truncation or OOM.

**Why `stripMetadataEnvelope` wasn't enough:** `stripMetadataEnvelope` runs in `before_prompt_build` and strips the current system prompt before the query is extracted. But it does not affect the `agentMessages` array, which is what gets stored in the transcript. Stored messages carry the full context block forward.

**Fix:** New `before_message_write` hook that strips `<usme-context>` blocks from any message before it is written to storage:
```ts
api.on("before_message_write", (event) => {
  // strips <usme-context>...</usme-context> from string and array-of-blocks content
});
```
Handles both `content: string` and `content: ContentBlock[]` (Anthropic SDK format).

---

## Fix 4 — reflect.ts source_episode_ids population (MEDIUM)

**File:** `packages/usme-core/src/consolidate/reflect.ts`

**Problem:** The Sonnet reflection prompt did not explicitly ask for `source_episode_ids` in skill candidates. The LLM omitted the field or set it to null. Without episode IDs, `promote-candidate.ts` cannot retrieve enrichment context from the source episodes.

**Fix:** Updated the reflect prompt to instruct the LLM:
> "Populate source_episode_ids with the numeric IDs of the episodes that most clearly demonstrate this pattern."

Candidates from runs before commit f17b306 still have null source_episode_ids — enrichment for those will use concept/entity context only.

---

# Changes: USME Promotion Pipeline Fixes

## Fix 1 — Concepts schema column names (CRITICAL)

**File:** `packages/usme-core/src/consolidate/promote.ts`

**Problem:** `getEnrichContext()` used `SELECT name, summary FROM concepts` but the table has no `name` or `summary` columns — the actual columns are `concept_type` and `content`. This caused a PostgreSQL error on every promotion attempt.

**Verified:** Queried `information_schema.columns WHERE table_name='concepts'` — confirmed columns are `id, concept_type, content, embedding, ...`

**Fix:** Changed query to `SELECT concept_type AS name, content AS summary` and narrowed the search to `WHERE content ILIKE ...` (avoiding the non-existent `name` column in the WHERE clause too).

**Why it failed silently until runtime:** TypeScript only checks types, not SQL string literals. The error is only visible when pg executes the query.

**Status:** This fix was already applied in the working tree diff (M promote.ts). Confirmed correct.

---

## Fix 2 — Transaction safety for promote operation (CRITICAL)

**File:** `packages/usme-core/src/scripts/promote-candidate.ts`

**Problem:** The original script used `pool.query()` for each DB operation independently. If `UPDATE skill_candidates` or anything after `INSERT INTO skills` failed, the skills row was committed as a ghost. On re-run, `ON CONFLICT DO NOTHING` would silently skip the insert, and the script would exit with an error requiring manual DELETE.

**Operations now atomic (inside BEGIN/COMMIT):**
1. `UPDATE skill_candidates SET approval_status='accepted'` — mark accepted
2. `INSERT INTO skills ... RETURNING id` — create the skill row
3. `UPDATE skill_candidates SET promoted_skill_id=..., enrichment_status='pending'` — link back

**On ROLLBACK:** The skills row is never committed; skill_candidate remains unchanged. Clean re-run possible immediately.

**Implementation:** Acquired a dedicated `pool.connect()` client, wrapped the three writes in `BEGIN/COMMIT`, with `ROLLBACK` in the catch block. The `client.release()` is in `finally` to prevent connection leaks.

---

## Fix 3 — Self-contained enrichment (HIGH)

**File:** `packages/usme-core/src/scripts/promote-candidate.ts`

**Problem:** The script fired `execSync('openclaw system event --text ...')` to trigger enrichment. There was no handler in index.ts for `[USME-ENRICH]` events, so enrichment never happened.

**Fix:** After the transaction commits, the script now:
1. Calls `getEnrichContext(candidateId)` to get source episodes and related concepts.
2. Builds a structured `SKILL.md` from a template populated with actual episode data.
3. Determines the slug (lowercase name, hyphens) and writes the file to `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/<slug>/SKILL.md`, creating the directory if needed.
4. Computes an embedding via `embedText(content, OPENAI_API_KEY)` (text-embedding-3-small, 1536d).
5. Stores the vector in `skills.embedding` via `UPDATE skills SET embedding = $2::vector`.
6. Updates `skill_candidates SET enrichment_status='complete'`.
7. Prints skill name, file path, line count, embedding stored y/n.

**Recoverability:** If SKILL.md write fails after the transaction commits, `enrichment_status` remains `'pending'` — the script can be re-run. If embedding fails, the script prints a warning and exits non-zero; re-run will retry.

**Removed:** The `execSync('openclaw system event ...')` void event call has been deleted.

---

## Fix 4 — `--pick N` flag for 1-based candidate selection (MEDIUM)

**File:** `packages/usme-core/src/scripts/promote-candidate.ts`

**Problem:** The script took a raw DB id. `list-candidates.ts` output a numbered list, but the numbers were 1-based list positions — they don't match DB ids.

**Fix:** Added `--pick N` flag that:
1. Fetches all candidates sorted `confidence DESC` (same as list-candidates.ts).
2. Takes the Nth result (1-based).
3. Uses that candidate's DB id internally.

The existing positional raw id argument still works. If `--pick` is out of range, exits with a clear error showing the available range.

**Also:** Updated `buildPromoteCard()` in `promote.ts` to print `[id=N]` next to each entry so the DB id is always visible even when using the raw id path.

---

## Fix 5 — Morning notification delivery (MEDIUM)

**File:** `packages/usme-core/src/consolidate/scheduler.ts`

**Problem:** `deliverSkillCandidates()` fell back to `console.log()` when no `sendFn` was provided. Inside the gateway process, stdout is swallowed — nothing reached the user.

**Fix:** The fallback now fires a system event via:
```
execSync(`openclaw system event --text "[USME-MORNING] N skill candidates ready..." --mode now`)
```

Wrapped in `try/catch` — if `openclaw` is not on PATH or fails, it falls back to `console.log()` with a warning log entry.

**Import added:** `import { execSync } from "node:child_process"` at the top of scheduler.ts.

---

## Build

Build clean (`npm run build` from `packages/usme-openclaw`).
Output: `1.5mb` bundle written directly to `.openclaw/extensions/usme-claw/dist/plugin.js` via the postbuild script.

No TypeScript errors.
