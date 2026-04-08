# REFACTOR REVIEW — USME Claw
**Date:** 2026-04-08
**Reviewer:** automated reviewer agent (claude-sonnet-4-6)

---

## TSC Results

### usme-core (`packages/usme-core/tsconfig.json`)

```
PASS — zero errors, exit code 0
```

### usme-openclaw (`packages/usme-openclaw/tsconfig.json`)

```
PASS — zero errors, exit code 0
```

Both packages compile cleanly with no TypeScript errors.

---

## Audit Findings Verification

The audit flagged 7 issues (3 critical/must-fix, 2 medium/should-fix, 2 low/minor).

### ISSUE-1 — entity-extractor.ts: Wrong model name (CRITICAL)
**Flagged:** `model: config?.model ?? "claude-haiku-4-20250414"` at line 66.
**File checked:** `packages/usme-core/src/extract/entity-extractor.ts`
**Verdict: OK — FIXED**
Line 136 now reads: `model: config?.model ?? "claude-haiku-4-5"` — correct model name.

### ISSUE-2 — entity-extractor.ts: JSON.parse on raw LLM text, no tool_use, no zod schema (CRITICAL)
**Flagged:** `client.messages.create()` without tools, then `JSON.parse(text)` at line 74; no `EntityExtractionResultSchema` defined.
**File checked:** `packages/usme-core/src/extract/entity-extractor.ts`
**Verdict: OK — FIXED**
The file now:
- Defines `ExtractedEntitySchema`, `ExtractedRelationshipSchema`, and `EntityExtractionResultSchema` using zod (lines 50–74).
- Defines `EXTRACT_ENTITIES_TOOL` as an `Anthropic.Tool` with a full input schema (lines 78–114).
- Calls `messages.create()` with `tools: [EXTRACT_ENTITIES_TOOL]` and `tool_choice: { type: "tool", name: "extract_entities" }` (lines 138–139).
- Finds `toolBlock` via `response.content.find((b) => b.type === "tool_use")` (line 143).
- Validates with `EntityExtractionResultSchema.safeParse(destr(JSON.stringify(toolBlock.input)))` (line 148).
- No `JSON.parse` on raw text anywhere.

### ISSUE-3 — extractor.ts: Wrong model name (CRITICAL)
**Flagged:** `model: config?.model ?? "claude-haiku-4-20250414"` at line 73.
**File checked:** `packages/usme-core/src/extract/extractor.ts`
**Verdict: OK — FIXED**
Line 73 now reads: `model: config?.model ?? "claude-haiku-4-5"` — correct model name.

### ISSUE-4 — destr dependency missing from package.json (MEDIUM)
**Flagged:** `destr` not listed in `packages/usme-core/package.json` despite being used by spec.
**File checked:** `packages/usme-core/package.json`
**Verdict: OK — FIXED**
`package.json` dependencies now include `"destr": "^2.0.5"`. The `entity-extractor.ts` file also imports and uses it (`import { destr } from "destr"`, line 3).

### ISSUE-5 — nightly.ts: `Schema.parse()` instead of `safeParse()` in stepPromote and stepSkillDraft (MEDIUM)
**Flagged:** `PromoteOutputSchema.parse(...)` at line 265 and `SkillDraftOutputSchema.parse(...)` at line 495 throw on failure instead of gracefully failing.
**File checked:** `packages/usme-core/src/consolidate/nightly.ts`
**Verdict: STILL PRESENT — NOT FIXED**
Both lines continue to use `.parse()` (throwing) rather than `.safeParse()`. This is an operational risk: a malformed LLM response during a nightly consolidation run will propagate an exception and abort the step rather than handling it gracefully. Since tsc passes and the audit categorised this as MEDIUM, it does not block a PASS verdict but is noted as a remaining issue.

### ISSUE-6 — shadow.ts: Creates own pino instance instead of shared logger (LOW)
**Flagged:** `import pino from "pino"` + `const log = pino({ name: "usme" }).child(...)` instead of the shared `logger` from `@usme/core`.
**File checked:** `packages/usme-openclaw/src/shadow.ts`
**Verdict: OK — FIXED**
`shadow.ts` now imports `logger` directly from `@usme/core` (line 17: `logger,` in the destructured import) and uses `const log = logger.child({ module: "shadow" })` (line 23). The local pino instantiation has been removed.

### ISSUE-7 — retrieve.ts: SQL uses `length(content)/4` for most tiers; tiktoken path never fires (LOW)
**Flagged:** TIER_QUERIES for episodes/concepts/skills/entities compute `token_count` as `length(content)/4` in SQL, meaning the JS-side `countTokens()` fallback never activates for those tiers.
**File checked:** `packages/usme-core/src/assemble/retrieve.ts`
**Verdict: STILL PRESENT — NOT FIXED (pre-existing, acceptable)**
This was categorised low/minor and was explicitly noted as a pre-existing design choice, not a regression introduced by the refactor. The SQL queries were not changed. The JS-side mapping correctly calls `countTokens()` as a fallback, and the behaviour is consistent with how it was before the refactor.

---

## Remaining Issues

### NOT FIXED — MEDIUM (operational risk)

**nightly.ts: `.parse()` instead of `.safeParse()` in stepPromote and stepSkillDraft**
- `packages/usme-core/src/consolidate/nightly.ts`, lines 265 and 495.
- `PromoteOutputSchema.parse(...)` and `SkillDraftOutputSchema.parse(...)` will throw uncaught exceptions on malformed LLM tool output. The nightly consolidation job runs these steps in sequence; an exception in stepPromote will skip stepContradictions and stepSkillDraft entirely for that run.
- Recommended fix: convert to `safeParse()` with an error log and early return, matching the pattern already used in `reconcile.ts`.

### NOT FIXED — LOW (minor, pre-existing)

**retrieve.ts: SQL-level `length(content)/4` token estimation for episodes/concepts/skills/entities tiers**
- `packages/usme-core/src/assemble/retrieve.ts`
- Token counts for these tiers are still derived from SQL `length(content)/4`. The tiktoken-based `countTokens()` path in JS is only reachable if the SQL expression returns 0 or null (which it never does for non-empty content). This is a pre-existing limitation, not introduced by this refactor.

---

## Final Verdict

**PASS**

Rationale:
- Both `usme-core` and `usme-openclaw` compile with zero TypeScript errors.
- All three CRITICAL audit issues (ISSUE-1, ISSUE-2, ISSUE-3) are fully resolved: model names corrected to `claude-haiku-4-5`, `entity-extractor.ts` converted from raw `JSON.parse` to full `tool_use` + zod `safeParse` pattern, `EntityExtractionResultSchema` added.
- The MEDIUM dependency gap (ISSUE-4: `destr` missing from `package.json`) is resolved.
- The LOW shadow.ts logger inconsistency (ISSUE-6) is resolved.
- Two issues remain (ISSUE-5: `.parse()` vs `.safeParse()` in nightly.ts; ISSUE-7: SQL token estimation in retrieve.ts), but both are below the bar that would block a PASS:
  - ISSUE-5 is medium-severity operational risk with no type safety impact; it does not cause tsc failures and was not in the critical path.
  - ISSUE-7 is a pre-existing design choice explicitly acknowledged in the audit.
- Recommend addressing ISSUE-5 in a follow-up PR before the next production nightly run.
