# @usme/cli — USME memory workbench

Read-only CLI for inspecting USME memory: what is relevant to a query and **why**,
and what the runtime would inject. Full docs: [`docs/USME_MEMORY_CLI.md`](../../docs/USME_MEMORY_CLI.md).

```bash
# from repo root (tsx is available in the monorepo)
npx tsx packages/usme-cli/src/cli.ts <command> [flags]
```

Commands: `assemble`, `search`, `grep`, `constraints`, `inspect`, `stats`.

```bash
npx tsx packages/usme-cli/src/cli.ts assemble "deploy gateway" --include-constraints --show-scores
npx tsx packages/usme-cli/src/cli.ts search "postgres port" --tier-limit concepts=10 --json
npx tsx packages/usme-cli/src/cli.ts grep "DATABASE_URL"
npx tsx packages/usme-cli/src/cli.ts constraints list
npx tsx packages/usme-cli/src/cli.ts stats
```

- **Read-only:** no command writes to the DB; `assemble` is a pure dry-run (no access-count bump).
- **DB:** `--database-url` → `DATABASE_URL` → `postgres://usme:usme_dev@localhost:5432/usme`.
- **Embeddings:** `search`/`assemble` need `OPENAI_API_KEY`; `grep`/`constraints`/`inspect`/`stats` do not.
- **Debug:** `--debug` or `USME_CLI_DEBUG=1`/`true` writes timing/count logs to stderr only,
  so `--json` stdout remains parseable.
- **Semantic timeout:** `--tier-timeout-ms N` controls per-tier retrieval timeout for
  `search`/`assemble` (CLI default 500ms; runtime plugin config is unchanged).
