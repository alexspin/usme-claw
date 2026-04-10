/**
 * Plugin command: /usme-promote
 *
 * Stateless subcommand dispatch — all output via sendReply, no readline, no console.log.
 *
 * Usage:
 *   /usme-promote                     → lists candidates
 *   /usme-promote approve 1 3         → promotes candidates at positions 1 and 3
 *   /usme-promote dismiss 2           → dismisses candidate at position 2
 *   /usme-promote defer 2             → defers candidate at position 2 for 24h
 *   /usme-promote detail 4            → returns detail card for candidate at position 4
 *   /usme-promote --force             → lists all candidates ignoring filters
 *   /usme-promote --include-drafts    → includes draft-tier
 */

import {
  getPool,
  getPromoteCandidates,
  buildPromoteCard,
  getDetailCard,
  markCandidatesPrompted,
  markCandidateDismissed,
  deferCandidate,
  markCandidatePendingWrite,
  getEnrichContext,
} from "@usme/core";
import type { PromoteSkillCandidate, EnrichContext } from "@usme/core";
import { logger } from "@usme/core";

const log = logger.child({ module: "promote-command" });

// ── Enrichment event builder ─────────────────────────────────

function buildEnrichEventText(ctx: EnrichContext): string {
  const episodesSection =
    ctx.sourceEpisodes.length > 0
      ? ctx.sourceEpisodes
          .map((e) => `  - Episode ${e.id} (${String(e.createdAt).split("T")[0]}): ${e.summary}`)
          .join("\n")
      : "  (no source episodes recorded)";

  const conceptsSection =
    ctx.relatedConcepts.length > 0
      ? ctx.relatedConcepts.map((c) => `  - ${c.name}: ${c.summary ?? ""}`).join("\n")
      : "  (no related concepts found)";

  return `
🔨 USME Skill Enrichment Task — candidate ID: ${ctx.candidateId}

Skill to build: "${ctx.name}"
Description: ${ctx.description}
Trigger pattern: ${ctx.triggerPattern ?? "not specified"}
Confidence: ${ctx.confidence} (${ctx.qualityTier})
Output file: ${ctx.skillPath}

Source episodes from USME memory (grounding material):
${episodesSection}

Related concepts:
${conceptsSection}

Instructions — four-source evidence gathering:

1. Call lcm_expand_query with query="${ctx.name}" and prompt:
   "What specific commands, error messages, and recovery steps did we use for ${ctx.name}?
    Include exact command syntax, flags, error text, and what worked."

2. Call web_search twice:
   a) "${ctx.name} best practices site:docs.anthropic.com OR site:postgresql.org OR site:nginx.org"
      (adapt domain to the skill topic)
   b) "${ctx.name} common mistakes pitfalls"

3. Read one existing SKILL.md from /home/alex/ai/projects/.openclaw/workspace-rufus/skills/ as a format
   reference before writing, to ensure consistent structure.

4. Synthesize a complete SKILL.md at: ${ctx.skillPath}
   The SKILL.md must contain:
   - YAML frontmatter: name, description, when-to-use, when-NOT-to-use
   - ## Prerequisites — tools, env vars, config required
   - ## Steps — numbered, with exact commands, flags, and expected outputs (grounded in LCM evidence)
   - ## Failure Modes — specific errors and recovery paths (grounded in LCM evidence)
   - ## Best Practices — from web search, clearly marked as "per documentation"
   - ## Verification — how to confirm the skill worked

5. After writing the file:
   a) Run this DB update:
      node -e "const {Pool}=require('pg'); const p=new Pool({host:'localhost',port:5432,database:'usme',user:'usme',password:'usme_dev'}); p.query('UPDATE skills SET enrichment_status=\\'complete\\' WHERE source_candidate_id=$1',[${ctx.candidateId}]).then(()=>p.end())"
   b) And update skill_candidates:
      node -e "const {Pool}=require('pg'); const p=new Pool({host:'localhost',port:5432,database:'usme',user:'usme',password:'usme_dev'}); p.query('UPDATE skill_candidates SET enrichment_status=\\'complete\\' WHERE id=$1',[${ctx.candidateId}]).then(()=>p.end())"
   c) TODO: compute embedding of full SKILL.md body and store in skills.skill_embedding

6. Report back: what LCM evidence was found, what web results added,
   what was left underspecified (mark those sections with <!-- insufficient grounding --> in the SKILL.md).

Synthesis rule: Ground all commands and failure modes in what we actually did — use LCM conversation
history as the primary source and anchor. Use web search to fill gaps, add warnings, and surface better
practices we may have missed. Where they conflict, prefer our lived experience but note the discrepancy
with a ⚠️ marker. Never invent commands or options not evidenced in LCM or official documentation.

This is a high-quality task. Take the time to do it properly.
`.trim();
}

// ── Promotion (insert to skills table) ──────────────────────

async function promoteToSkill(
  candidate: PromoteSkillCandidate,
  reply: (msg: string) => void | Promise<void>,
): Promise<string | null> {
  const pool = getPool();

  await markCandidatePendingWrite(candidate.id, pool);

  const skillPath = `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/${candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/, "")}/SKILL.md`;

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO skills
       (name, description, status, skill_path, source_episode_ids, teachability,
        promoted_at, source_candidate_id, generation_notes, metadata)
     VALUES ($1, $2, 'active', $3, $4, $5, NOW(), $6, $7, $8)
     ON CONFLICT (name) DO NOTHING
     RETURNING id`,
    [
      candidate.name,
      candidate.description ?? null,
      skillPath,
      candidate.source_episode_ids ?? null,
      candidate.confidence,
      candidate.id,
      JSON.stringify({ from_candidate: candidate.id, quality_tier: candidate.quality_tier }),
      "{}",
    ],
  );

  if (rows.length === 0) {
    log.warn({ name: candidate.name }, "skill name conflict on insert — skipping");
    return null;
  }

  const skillId = rows[0].id;

  await pool.query(
    `UPDATE skill_candidates SET promoted_skill_id = $2, updated_at = NOW() WHERE id = $1`,
    [candidate.id, skillId],
  );

  log.info(
    {
      event: "usme:promote-approved",
      candidateId: candidate.id,
      candidateName: candidate.name,
      approvedAt: new Date().toISOString(),
      skillPath,
      skillId,
    },
    "skill candidate promoted to active skill",
  );

  try {
    const enrichCtx = await getEnrichContext(candidate.id, pool);
    const eventText = buildEnrichEventText(enrichCtx);

    await pool.query(
      "UPDATE skill_candidates SET enrichment_status='pending', updated_at=NOW() WHERE id=$1",
      [candidate.id],
    );

    const { execSync } = await import("node:child_process");
    execSync(
      `openclaw system event --text ${JSON.stringify(eventText)} --mode now`,
      { stdio: "inherit" },
    );

    await reply(`🔨 Enrichment task fired for "${candidate.name}". Rufus will synthesize SKILL.md using LCM history and USME memories.\n   Output: ${enrichCtx.skillPath}`);
  } catch (err) {
    log.warn(
      { err, candidateId: candidate.id },
      "enrichment event fire failed — skill promoted but enrichment not triggered",
    );
  }

  return skillId;
}

// ── Main command ─────────────────────────────────────────────

export async function promoteCommand(
  args: string[],
  sendReply?: (msg: string) => void | Promise<void>,
): Promise<void> {
  const reply = sendReply ?? ((msg: string) => console.log(msg));

  let includeDrafts = false;
  let forceAll = false;

  // Parse flags
  const filteredArgs = args.filter((a) => {
    if (a === "--include-drafts") { includeDrafts = true; return false; }
    if (a === "--force") { forceAll = true; return false; }
    return true;
  });

  const subcommand = filteredArgs[0]?.toLowerCase();
  const pool = getPool();

  // ── List (default) ──
  if (!subcommand || subcommand === "list") {
    const candidates = await getPromoteCandidates({ includeDrafts, forceAll }, pool);
    if (candidates.length === 0) {
      await reply(
        "No skill candidates ready for review.\n(Use --force to see previously prompted candidates, --include-drafts for lower-confidence items.)",
      );
      return;
    }
    await markCandidatesPrompted(candidates.map((c) => c.id), pool);
    await reply(buildPromoteCard(candidates));
    return;
  }

  // ── Detail N ──
  if (subcommand === "detail") {
    const pos = parseInt(filteredArgs[1] ?? "", 10);
    if (isNaN(pos) || pos < 1) {
      await reply("Usage: /usme-promote detail <position>");
      return;
    }
    const candidates = await getPromoteCandidates({ includeDrafts, forceAll }, pool);
    const idx = pos - 1;
    if (idx >= candidates.length) {
      await reply(`Position ${pos} out of range (1–${candidates.length}).`);
      return;
    }
    const detail = await getDetailCard(candidates[idx].id, pool);
    await reply(detail);
    return;
  }

  // ── Defer N ──
  if (subcommand === "defer") {
    const pos = parseInt(filteredArgs[1] ?? "", 10);
    if (isNaN(pos) || pos < 1) {
      await reply("Usage: /usme-promote defer <position>");
      return;
    }
    const candidates = await getPromoteCandidates({ includeDrafts, forceAll }, pool);
    const idx = pos - 1;
    if (idx >= candidates.length) {
      await reply(`Position ${pos} out of range (1–${candidates.length}).`);
      return;
    }
    await deferCandidate(candidates[idx].id, pool);
    await reply(`Candidate "${candidates[idx].name}" deferred 24 hours.`);
    return;
  }

  // ── Dismiss N ──
  if (subcommand === "dismiss") {
    const pos = parseInt(filteredArgs[1] ?? "", 10);
    if (isNaN(pos) || pos < 1) {
      await reply("Usage: /usme-promote dismiss <position>");
      return;
    }
    const candidates = await getPromoteCandidates({ includeDrafts, forceAll }, pool);
    const idx = pos - 1;
    if (idx >= candidates.length) {
      await reply(`Position ${pos} out of range (1–${candidates.length}).`);
      return;
    }
    await markCandidateDismissed(candidates[idx].id, pool);
    await reply(`Candidate "${candidates[idx].name}" permanently dismissed.`);
    return;
  }

  // ── Approve N M ... ──
  if (subcommand === "approve") {
    const posArgs = filteredArgs.slice(1).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
    if (posArgs.length === 0) {
      await reply("Usage: /usme-promote approve <position> [position ...]");
      return;
    }

    const candidates = await getPromoteCandidates({ includeDrafts, forceAll }, pool);
    if (candidates.length === 0) {
      await reply("No candidates available to approve.");
      return;
    }

    const toPromote: PromoteSkillCandidate[] = [];
    for (const pos of posArgs) {
      const idx = pos - 1;
      if (idx < 0 || idx >= candidates.length) {
        await reply(`Position ${pos} out of range (1–${candidates.length}).`);
      } else {
        toPromote.push(candidates[idx]);
      }
    }

    if (toPromote.length === 0) return;

    let promoted = 0;
    for (const c of toPromote) {
      await reply(`Promoting "${c.name}"...`);
      const skillId = await promoteToSkill(c, reply);
      if (skillId) {
        await reply(`  ✓ Promoted to active skill (id=${skillId})`);
        promoted++;
      } else {
        await reply(`  ✗ Skipped — a skill named "${c.name}" already exists.`);
      }
    }

    await reply(`\n${promoted}/${toPromote.length} candidate(s) promoted.`);
    return;
  }

  // ── Unknown subcommand ──
  await reply(
    `Unknown subcommand: "${subcommand}"\n` +
    `Usage:\n` +
    `  /usme-promote                  — list candidates\n` +
    `  /usme-promote approve 1 3      — promote positions 1 and 3\n` +
    `  /usme-promote dismiss 2        — dismiss position 2\n` +
    `  /usme-promote defer 2          — defer position 2 for 24h\n` +
    `  /usme-promote detail 4         — show detail for position 4\n` +
    `  /usme-promote --force          — list all ignoring filters\n` +
    `  /usme-promote --include-drafts — include draft-tier candidates`,
  );
}
