# usme-claw Build & Deployment Guide

## How OpenClaw Loads This Plugin

OpenClaw uses an install record in `openclaw.json` (`plugins.installs.usme-claw`) to track where the plugin lives:

```json
{
  "source": "path",
  "sourcePath": "/home/alex/ai/projects/rufus-projects/usme-claw/packages/usme-openclaw",
  "installPath": "/home/alex/ai/projects/.openclaw/extensions/usme-claw"
}
```

**Critical:** OpenClaw loads from `sourcePath`, not `installPath`. The plugin entry point is:
```
sourcePath + package.json "main" field
= packages/usme-openclaw/dist/plugin.js
```

However, OpenClaw **discovers** the plugin by scanning `installPath` (the extensions dir) for a `package.json` with an `"openclaw": { "extensions": [...] }` field. Both locations matter:

| Path | Purpose |
|---|---|
| `packages/usme-openclaw/dist/plugin.js` | **What OpenClaw runs** |
| `.openclaw/extensions/usme-claw/package.json` | **What OpenClaw scans for discovery** |
| `.openclaw/extensions/usme-claw/openclaw.plugin.json` | Plugin metadata (name, configSchema) |

---

## Build Process

The build lives in `packages/usme-openclaw/`:

```bash
cd packages/usme-openclaw
npm run build
```

### What the build does

1. **`tsc --noEmit`** — type-checks the TypeScript source only, no output
2. **esbuild** — bundles `src/index.ts` into a single self-contained `dist/plugin.js` (~1.5MB)
   - All dependencies (including `@usme/core`) are bundled in
   - Output: `packages/usme-openclaw/dist/plugin.js` ← **this is what OpenClaw runs**
3. **postbuild:**
   - Copies `openclaw.plugin.json` → extensions dir (keeps metadata in sync)
   - Writes `package.json` with `openclaw.extensions` field → extensions dir (required for discovery)
   - Runs `patch-lcm-sqlite.mjs` (SQLite performance patch)

### Why esbuild, not tsc?

OpenClaw loads the plugin as a standalone file. If `tsc` compiled it, the output would contain `import { ... } from "@usme/core"` — which would fail at runtime because the extensions dir has no access to the monorepo's `node_modules`. esbuild bundles everything into a single file with no external imports.

---

## Diagnosing Load Problems

Before debugging any plugin behavior, always verify which file is actually being loaded:

**Step 1 — Check the install record:**
```bash
cat /home/alex/ai/projects/.openclaw/openclaw.json | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(json.dumps(d['plugins']['installs']['usme-claw'], indent=2))
"
```

**Step 2 — Confirm the file OpenClaw runs:**
```
sourcePath + "/" + main = packages/usme-openclaw/dist/plugin.js
```
```bash
ls -la packages/usme-openclaw/dist/plugin.js
```

**Step 3 — Confirm the discovery file exists:**
```bash
cat /home/alex/ai/projects/.openclaw/extensions/usme-claw/package.json
# Must contain: "openclaw": { "extensions": ["./dist/plugin.js"] }
```

**Step 4 — Check the gateway log for load confirmation:**
```bash
tail -100 /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log | grep usme
# Should see: [usme] mode=active | injectionLog=...
#             [usme] registering hook (mode=active)
```

If you see `plugin not found: usme-claw` in the startup output, the `openclaw.extensions` field is missing from the extensions dir `package.json`. Re-run `npm run build` from `packages/usme-openclaw/`.

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| `plugin not found: usme-claw` warning | Extensions dir `package.json` missing `openclaw.extensions` field | Run `npm run build` |
| Plugin loads but embeddings fail (401) | `OPENAI_API_KEY` not set in env | Add to `env-secrets.sh` |
| Old behavior after a code change | Built to wrong path or stale file loaded | Check Step 1-3 above |
| `@usme/core` import error | tsc output (not esbuild bundle) was loaded | Delete `dist/` and rebuild |

---

## File Structure

```
packages/usme-openclaw/
  src/
    index.ts          ← plugin entry point (usmePlugin export default)
    plugin.ts         ← ContextEngine implementation (createUsmeEngine)
    config.ts         ← config resolution + defaults
    telemetry.ts      ← telemetry helpers
  dist/
    plugin.js         ← esbuild bundle (what OpenClaw runs) — gitignored
    plugin.js.map     ← source map — gitignored
  scripts/
    patch-lcm-sqlite.mjs  ← SQLite perf patch for lossless-claw
  openclaw.plugin.json    ← plugin metadata (id, name, configSchema)
  package.json            ← build scripts, dependencies
  tsconfig.json           ← extends ../../tsconfig.base.json, noEmit only

.openclaw/extensions/usme-claw/   ← gitignored, rebuilt by postbuild
  dist/
    plugin.js         ← symlink/copy not used; OpenClaw loads from sourcePath
  openclaw.plugin.json  ← copied from source by postbuild
  package.json          ← written by postbuild; MUST have openclaw.extensions field
```

---

## openclaw.json Config Reference

```json
"usme-claw": {
  "enabled": true,
  "config": {
    "mode": "active",        // "active" | "log-only" | "off"
    "db.host": "localhost",
    "db.port": 5432,
    "db.database": "usme",
    "db.user": "usme",
    "db.password": "usme_dev",
    "db.poolMax": 10,
    "embeddingApiKey": ""    // falls back to OPENAI_API_KEY env var
  }
}
```

**Modes:**
- `active` — retrieves memories and injects context into every prompt
- `log-only` — runs the pipeline and logs to `/tmp/usme/injection.jsonl` but does not inject
- `off` — plugin does nothing, no DB connections opened
