# USME Shadow Injection — Architecture Design

**Status:** Draft
**Author:** Architect Agent
**Date:** 2026-04-06
**Scope:** Changes required to wire retrieved USME memory items into the LCM context pipeline as first-class injected context, with tags propagation, distiller awareness, and double-registration safety.

---

## 1. TypeScript Interface Changes

### 1.1 `RetrievalCandidate` — add `tags`

File: `packages/usme-core/src/assemble/types.ts`

Current interface ends at `teachability: number | null`. Add one field:

```typescript
export interface RetrievalCandidate {
  id: string;
  tier: MemoryTier;
  content: string;
  embedding: number[];
  tokenCount: number;
  createdAt: Date;
  provenanceKind: string;
  utilityPrior: 'high' | 'medium' | 'low' | 'discard';
  confidence: number;
  isActive: boolean;
  accessCount: number;
  lastAccessed: Date | null;
  teachability: number | null;
  /** Semantic labels attached to this memory item. Empty array when not available. */
  tags: string[];
}
```

Rationale: tags flow from the DB into candidates, survive scoring (ScoredCandidate extends RetrievalCandidate), and are forwarded into InjectedMemory so the distiller and logging layers can filter or annotate by tag.

### 1.2 `InjectedMemory` — add `createdAt`, `tags`, `score`

Current `InjectedMemory` holds only `{ id, tier, content, score, tokenCount }`. The pack step must propagate three additional fields:

```typescript
export interface InjectedMemory {
  id: string;
  tier: MemoryTier;
  content: string;
  score: number;
  tokenCount: number;
  /** When this memory item was originally stored. */
  createdAt: Date;
  /** Semantic tags from the source row. Empty array when none. */
  tags: string[];
}
```

Note: `score` already exists; it is listed here for completeness because `pack.ts` must explicitly copy it from `ScoredCandidate` (it already does — no change needed there). The new fields `createdAt` and `tags` do require a change to the `pack()` function body.

#### Required change in `pack.ts`

```typescript
// packages/usme-core/src/assemble/pack.ts  (inside the for-loop)
selected.push({
  id: item.id,
  tier: item.tier,
  content: item.content,
  score: item.score,
  tokenCount: item.tokenCount,
  createdAt: item.createdAt,   // NEW
  tags: item.tags,             // NEW
});
```

---

## 2. SQL Change in `retrieve.ts` for Tags on `sensory_trace`

File: `packages/usme-core/src/assemble/retrieve.ts`

### 2.1 Only `sensory_trace` has a `tags` column

The `sensory_trace` table schema (evidenced by the `insertSensoryTrace` call in `plugin.ts` which passes `tags: []`) has a `tags` column. The other tier tables (`episodes`, `concepts`, `skills`, `entities`) do not currently have a `tags` column and must receive a literal empty array.

### 2.2 SQL diff for `sensory_trace` query

```sql
-- BEFORE
SELECT id, 'sensory_trace' AS tier, content, embedding,
       length(content) / 4 AS token_count, created_at,
       provenance_kind, utility_prior, 1.0 AS confidence,
       true AS is_active, 0 AS access_count, NULL AS last_accessed,
       NULL AS teachability,
       1 - (embedding <=> $1::vector) AS similarity
FROM sensory_trace
...

-- AFTER  (add tags column)
SELECT id, 'sensory_trace' AS tier, content, embedding,
       length(content) / 4 AS token_count, created_at,
       provenance_kind, utility_prior, 1.0 AS confidence,
       true AS is_active, 0 AS access_count, NULL AS last_accessed,
       NULL AS teachability,
       COALESCE(tags, '{}') AS tags,
       1 - (embedding <=> $1::vector) AS similarity
FROM sensory_trace
...
```

`COALESCE(tags, '{}')` is defensive: if a legacy row has NULL in the column the query still returns an empty array rather than null.

### 2.3 Other tiers — literal empty array in the row mapper

For all four non-sensory tiers there is no tags column. Rather than adding the literal `ARRAY[]::text[]` to every SQL string (which requires a cast and complicates the query strings), the cleanest approach is to handle it in the TypeScript row mapper in `queryTier()`:

```typescript
// packages/usme-core/src/assemble/retrieve.ts  — inside rows.map()
tags: tier === 'sensory_trace'
  ? parseTagsArray(r.tags)
  : [],
```

Add a helper alongside `parseEmbedding`:

```typescript
function parseTagsArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw as string[];
  if (typeof raw === 'string' && raw.startsWith('{')) {
    // Postgres array literal: {a,b,c}
    return raw.slice(1, -1).split(',').filter(Boolean);
  }
  return [];
}
```

This keeps the SQL strings minimal and centralises the coercion logic.

---

## 3. Transform Function Signature in `plugin.ts`

File: `packages/usme-openclaw/src/plugin.ts`

The `injectedToSystemAddition` helper already wraps items in `<usme-context>` tags. To register a LCM transform (using the same `__rufus_lcm_context_transforms` bus used by rufus-plugin), the transform must conform to the type:

```typescript
type LcmTransformFn = (sessionId: string, msgs: unknown[]) => Promise<unknown[] | null>;
```

The exact signature for the USME inject transform:

```typescript
async function usmeInjectTransform(
  sessionId: string,
  msgs: unknown[],
): Promise<unknown[] | null>
```

**Behaviour contract:**
- Run `assemble()` for the given `sessionId` against the live DB pool.
- If `assemble()` returns no items, return `null` (no modification to message array).
- If items are returned, prepend a synthetic `system`-role message (or append to the existing system prompt) containing the `<usme-context>...</usme-context>` block produced by `injectedToSystemAddition()`.
- Return the modified message array.
- Never throw — catch all errors and return `null` (graceful degradation).

**Return value shape:**

```typescript
// On success with retrieved items:
return [
  { role: "system", content: injectedToSystemAddition(result.items) },
  ...msgs,
];

// On failure or empty retrieval:
return null;
```

Returning `null` signals to the LCM transform bus that this transform has no opinion and the original message array should be used as-is.

---

## 4. Sentinel Pattern for Double-Registration Guard

File: `packages/usme-openclaw/src/plugin.ts`

The rufus-plugin context-logger uses a dedup-by-id approach (`transforms.findIndex((t) => t.id === id)`). For USME, we need an additional module-level sentinel on `globalThis` to prevent the registration call from being made more than once, which is important if `createUsmeEngine()` is called multiple times (e.g. during hot reload or test setup):

```typescript
const USME_TRANSFORM_REGISTERED_KEY = '__usme_transform_registered';

function registerUsmeTransformOnce(fn: LcmTransformFn): void {
  const g = globalThis as Record<string, unknown>;
  if (g[USME_TRANSFORM_REGISTERED_KEY]) return;
  g[USME_TRANSFORM_REGISTERED_KEY] = true;
  registerLcmTransform('usme-inject', fn);
}
```

The key `__usme_transform_registered` is the sentinel. It is set to `true` on first registration and the function returns early on any subsequent call.

**Why this is needed in addition to the id-based dedup:** The rufus-plugin dedup removes and re-adds on the same call, meaning calling `registerLcmTransform` N times results in the transform array being rebuilt N times. The sentinel prevents even reaching `registerLcmTransform` on the second call, which is cheaper and also avoids any side-effects from the array rebuild (e.g. if LCM has already taken a reference to the array, rebuilding it may leave stale references).

**Full pattern:**

```typescript
// At module scope in plugin.ts:
const LCM_TRANSFORM_KEY = '__rufus_lcm_context_transforms';
const USME_TRANSFORM_REGISTERED_KEY = '__usme_transform_registered';

type LcmTransformFn = (sessionId: string, msgs: unknown[]) => Promise<unknown[] | null>;

function registerLcmTransform(id: string, fn: LcmTransformFn): void {
  const g = globalThis as Record<string, unknown>;
  if (!Array.isArray(g[LCM_TRANSFORM_KEY])) {
    g[LCM_TRANSFORM_KEY] = [];
  }
  const transforms = g[LCM_TRANSFORM_KEY] as Array<{ id: string; fn: LcmTransformFn }>;
  const idx = transforms.findIndex((t) => t.id === id);
  if (idx >= 0) transforms.splice(idx, 1);
  transforms.push({ id, fn });
  g[LCM_TRANSFORM_KEY] = transforms.map((t) => t.fn);
}

function registerUsmeTransformOnce(fn: LcmTransformFn): void {
  const g = globalThis as Record<string, unknown>;
  if (g[USME_TRANSFORM_REGISTERED_KEY]) return;
  g[USME_TRANSFORM_REGISTERED_KEY] = true;
  registerLcmTransform('usme-inject', fn);
}
```

Call `registerUsmeTransformOnce(usmeInjectTransform)` from `createUsmeEngine()` after the pool is ready (e.g. at the end of `bootstrap()`).

---

## 5. `<usme-context>` Filter in `distiller.ts` `extractContext()`

File: `/home/alex/ai/projects/rufus-projects/rufus-plugin/src/context-logger/distiller.ts`

### 5.1 The problem

`injectedToSystemAddition()` in `plugin.ts` wraps USME-retrieved memory in a `<usme-context>` block and injects it as a system prompt addition. When the distiller's `extractContext()` iterates over messages, it will encounter these injected blocks inside `system`-role messages (or whichever message carries the system prompt addition).

Sending USME-injected memory to Flash for distillation is counterproductive: the content is already semantically compressed memory, not raw conversational context. Distilling it again would degrade quality and waste Flash tokens.

### 5.2 The filter

In `extractContext()`, after computing `text` for a message, strip any `<usme-context>...</usme-context>` block before including the text in `parts`:

```typescript
// packages/rufus-plugin/src/context-logger/distiller.ts
// Inside extractContext(), after: const text = this.contentToString(m.content);

const cleanedText = text
  ? text.replace(/<usme-context>[\s\S]*?<\/usme-context>/g, '').trim()
  : null;
if (!cleanedText) continue;

const role = m.role === 'tool' || m.role === 'toolResult' ? 'tool_result' : m.role;
parts.push(`[${role}]: ${this.redact(cleanedText)}`);
```

Replace the existing:
```typescript
const role = m.role === "tool" || m.role === "toolResult" ? "tool_result" : m.role;
parts.push(`[${role}]: ${this.redact(text)}`);
```

With:
```typescript
const cleanedText = text.replace(/<usme-context>[\s\S]*?<\/usme-context>/g, '').trim();
if (!cleanedText) continue;
const role = m.role === "tool" || m.role === "toolResult" ? "tool_result" : m.role;
parts.push(`[${role}]: ${this.redact(cleanedText)}`);
```

### 5.3 Why regex and not XML parsing

The `<usme-context>` tag is machine-generated by `injectedToSystemAddition()` in a deterministic format — it is not user input and cannot be malformed. A simple `[\s\S]*?` non-greedy regex is correct and has no ambiguity. A full XML parser is not warranted.

### 5.4 Edge case: message is only the usme-context block

If after stripping the `<usme-context>` block the remaining text is empty or whitespace, the `continue` guard (already present in the existing code as `if (!text) continue`) will correctly skip the message. The additional `.trim()` and the `if (!cleanedText) continue` handle this.

---

## 6. Build Order Dependencies

### 6.1 Package dependency graph

```
usme-core  (packages/usme-core)
    ^
    |  (peer/runtime dep)
usme-openclaw  (packages/usme-openclaw)
    ^
    |  (runtime dep, same process)
rufus-plugin  (packages/rufus-plugin)  [context-logger]
```

### 6.2 Build order requirement

1. **`usme-core` must be built first.** `usme-openclaw` imports from `@usme/core` (see plugin.ts and shadow.ts). Any interface changes to `InjectedMemory` or `RetrievalCandidate` in `usme-core/src/assemble/types.ts` must be compiled before `usme-openclaw` TypeScript compilation runs.

2. **`usme-openclaw` must be built before `rufus-plugin`** is restarted/hot-reloaded in the gateway process, because the LCM transform registration happens at `createUsmeEngine()` call time. If `rufus-plugin` starts first and the `__rufus_lcm_context_transforms` array is already populated from a stale USME build, the distiller may encounter old `InjectedMemory` shapes.

3. **`rufus-plugin` (distiller.ts change) is independent of the TypeScript build chain** — it only needs the string pattern `<usme-context>` to be stable, which it is (defined in `injectedToSystemAddition()` in plugin.ts).

### 6.3 Workspace build command

If using a monorepo workspace (pnpm/npm workspaces or turborepo):

```
usme-core → usme-openclaw → gateway restart
```

The rufus-plugin distiller change can be deployed independently at any time after the `<usme-context>` tag format is finalised.

### 6.4 No circular dependencies

- `usme-core` has no imports from `usme-openclaw` or `rufus-plugin`.
- `usme-openclaw` imports from `usme-core` only.
- `rufus-plugin` does not import from either usme package — it communicates only via the `globalThis.__rufus_lcm_context_transforms` bus and the `<usme-context>` string convention.

---

## 7. Summary of All File Changes

| File | Change |
|------|--------|
| `packages/usme-core/src/assemble/types.ts` | Add `tags: string[]` to `RetrievalCandidate`; add `createdAt: Date`, `tags: string[]` to `InjectedMemory` |
| `packages/usme-core/src/assemble/retrieve.ts` | Add `COALESCE(tags, '{}') AS tags` to `sensory_trace` SQL; add `tags` field to row mapper; add `parseTagsArray()` helper; return `tags: []` for all other tiers |
| `packages/usme-core/src/assemble/pack.ts` | Copy `createdAt` and `tags` from `ScoredCandidate` into `InjectedMemory` in the push call |
| `packages/usme-openclaw/src/plugin.ts` | Add `LcmTransformFn` type, `registerLcmTransform()`, `registerUsmeTransformOnce()` with `__usme_transform_registered` sentinel, `usmeInjectTransform()` implementation; call `registerUsmeTransformOnce` from `bootstrap()` |
| `packages/rufus-plugin/src/context-logger/distiller.ts` | Strip `<usme-context>...</usme-context>` blocks in `extractContext()` before adding to `parts` |
