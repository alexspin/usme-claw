# USME Shadow Injection — Review Notes

**Reviewer:** reviewer-agent
**Date:** 2026-04-06
**Build:** clean (no errors, no warnings)

---

## Check Results

| # | Check | File | Result |
|---|-------|------|--------|
| 1 | Types: InjectedMemory.createdAt/tags/score; RetrievalCandidate.tags | usme-core/src/assemble/types.ts | PASS |
| 2 | Retrieve: sensory_trace SQL includes tags; mapper parses tags; other tiers tags:[] | usme-core/src/assemble/retrieve.ts | PASS |
| 3 | Pack: InjectedMemory construction includes createdAt, tags, score | usme-core/src/assemble/pack.ts | PASS |
| 4 | Format: injectedToSystemAddition() produces rich `<usme-context>` block | usme-openclaw/src/plugin.ts | PASS |
| 5 | Transform registration: bootstrap() uses sentinel guard + ordering comment | usme-openclaw/src/plugin.ts | PASS |
| 6 | Timeout: transform has 150ms Promise.race returning null | usme-openclaw/src/plugin.ts | PASS |
| 7 | Memtx guard: extractContext() strips `<usme-context>` blocks | rufus-plugin/src/context-logger/distiller.ts | PASS |
| 8 | Build: `npm run build` passes cleanly | — | PASS |

---

## Check 4 Spot-check

Input: `score=0.80, date=2026-03-15, tags=["arch"], tier="concept"`

Expected output header: `[concept | 2026-03-15 | relevance:high | tags:arch]`

Logic in `injectedToSystemAddition()`:
- `score >= 0.75` → `relevance = "high"` ✓
- `createdAt.toISOString().slice(0, 10)` → `"2026-03-15"` ✓
- `tags.length > 0` → appends `| tags:arch` ✓
- Wrapped in `<usme-context>...</usme-context>` ✓

---

## Notable Implementation Details

- **sensory_trace** is the only tier with `tags` in its SQL (`COALESCE(tags, '{}') AS tags`). Other tiers return `tags: []` — by design, as those tables lack a tags column.
- The `parseTagsArray()` function handles both Postgres array literals (`{a,b,c}`) and JS arrays.
- The sentinel guard `globalThis.__usme_transform_registered` ensures the transform is registered once per process, not once per session bootstrap call. This prevents duplicate transform registrations if multiple sessions are bootstrapped.
- The ordering comment in plugin.ts documents that memtx registers at module init while USME registers at per-session bootstrap, ensuring USME always runs after memtx in the transform chain.
- The 150ms timeout in the LCM transform uses `Promise.race` — on timeout, returns `null` which causes the framework to fall back to original messages (no injection), keeping the agent loop unblocked.
- `extractContext()` in distiller.ts uses a regex (`/<usme-context>[\s\S]*?<\/usme-context>/g`) to strip USME injection blocks before distillation, preventing memtx from including injected memory context in its compression pass (avoiding memtx re-ingesting USME output).

---

## Files Reviewed

- `/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-core/src/assemble/types.ts`
- `/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-core/src/assemble/retrieve.ts`
- `/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-core/src/assemble/score.ts`
- `/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-core/src/assemble/pack.ts`
- `/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-openclaw/src/plugin.ts`
- `/home/alex/ai/projects/rufus-projects/rufus-plugin/src/context-logger/distiller.ts`
