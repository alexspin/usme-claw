# usme-claw Build & Deployment Guide

## Single-Copy Architecture

There is ONE copy of the built plugin. esbuild writes directly to the extensions dir. No intermediate dist/ in the source repo.

```
Source code:    packages/usme-openclaw/src/         ← edit here
Built output:   .openclaw/extensions/usme-claw/dist/plugin.js  ← what OpenClaw runs
```

`openclaw.json` has `sourcePath` = `installPath` = `/home/alex/ai/projects/.openclaw/extensions/usme-claw`.

There is no `packages/usme-openclaw/dist/` directory. If one appears (e.g. from a stale build), delete it — it is not used.

---

## How OpenClaw Loads This Plugin

OpenClaw uses an install record in `openclaw.json` (`plugins.installs.usme-claw`):

```json
{
  "source": "path",
  "sourcePath": "/home/alex/ai/projects/.openclaw/extensions/usme-claw",
  "installPath": "/home/alex/ai/projects/.openclaw/extensions/usme-claw"
}
```

Both `sourcePath` and `installPath` are the same directory. OpenClaw:
1. **Discovers** the plugin by scanning `installPath` for `package.json` with `openclaw.extensions` field
2. **Loads** the plugin from `sourcePath` + `main` field = `extensions/usme-claw/dist/plugin.js`

Since both point to the same dir, they always agree.

---

## Build Process

```bash
cd packages/usme-openclaw
npm run build
```

### What the build does

1. **`tsc --noEmit`** — type-checks TypeScript source, no output
2. **esbuild** — bundles `src/index.ts` into `.openclaw/extensions/usme-claw/dist/plugin.js` (~1.5MB)
   - All dependencies (including `@usme/core`) are bundled in
   - No external imports at runtime
3. **postbuild:**
   - Copies `openclaw.plugin.json` → extensions dir (keeps metadata in sync)
   - Writes discovery `package.json` with `openclaw.extensions` field → extensions dir
   - Runs `patch-lcm-sqlite.mjs` (SQLite performance patch)

### Why esbuild, not tsc?

OpenClaw loads the plugin as a standalone file. If tsc compiled it, the output would contain `import { ... } from "@usme/core"` — which fails at runtime because the extensions dir has no access to the monorepo's `node_modules`. esbuild bundles everything into one file.

---

## Diagnosing Load Problems

**Step 1 — Check the install record:**
```bash
cat /home/alex/ai/projects/.openclaw/openclaw.json | python3 -c "
import json,sys; d=json.load(sys.stdin)
print(json.dumps(d['plugins']['installs']['usme-claw'], indent=2))
"
```
Both `sourcePath` and `installPath` should be `.openclaw/extensions/usme-claw`.

**Step 2 — Confirm the built file exists:**
```bash
ls -la /home/alex/ai/projects/.openclaw/extensions/usme-claw/dist/plugin.js
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

If you see `plugin not found: usme-claw`, re-run `npm run build`.

---

## Common Failure Modes

| Symptom | Cause | Fix |
|---|---|---|
| `plugin not found: usme-claw` | Discovery `package.json` missing `openclaw.extensions` field | Run `npm run build` |
| Plugin loads but embeddings fail (401) | `OPENAI_API_KEY` not set in env | Add to `env-secrets.sh` |
| Old behavior after a code change | Forgot to rebuild | Run `npm run build` |
| `packages/usme-openclaw/dist/` exists | Stale from old build system | Delete it — it is not used |

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

---

## File Structure

```
packages/usme-openclaw/
  src/
    index.ts          ← plugin entry point (usmePlugin export default)
    config.ts         ← config resolution + defaults
    telemetry.ts      ← telemetry helpers
  scripts/
    patch-lcm-sqlite.mjs  ← SQLite perf patch for lossless-claw
  openclaw.plugin.json    ← plugin metadata (id, name, configSchema)
  package.json            ← build scripts, dependencies
  tsconfig.json           ← extends ../../tsconfig.base.json, noEmit only
  NOTE: no dist/ here — esbuild writes directly to extensions dir

.openclaw/extensions/usme-claw/   ← THE only built output location
  dist/
    plugin.js         ← esbuild bundle (what OpenClaw runs)
  openclaw.plugin.json  ← copied from source by postbuild
  package.json          ← written by postbuild; MUST have openclaw.extensions field
```
