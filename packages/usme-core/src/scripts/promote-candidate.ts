#!/usr/bin/env node
/**
 * Promotes a single skill candidate by DB id.
 * Runnable directly via: npx tsx packages/usme-core/src/scripts/promote-candidate.ts <id>
 *
 * Args:
 *   <id>   Numeric candidate ID (required)
 */

import { execSync } from "node:child_process";
import {
  getPool,
  closePool,
  getPromoteCandidates,
  markCandidatePendingWrite,
  getEnrichContext,
} from "../index.js";

function buildEnrichEventText(ctx: Awaited<ReturnType<typeof getEnrichContext>>): string {
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

async function main() {
  const args = process.argv.slice(2);
  const idStr = args[0];

  if (!idStr || isNaN(Number(idStr))) {
    process.stderr.write("Usage: promote-candidate.ts <numeric-candidate-id>\n");
    process.exit(1);
  }

  const candidateId = parseInt(idStr, 10);
  const pool = getPool();

  try {
    // Fetch the candidate
    const candidates = await getPromoteCandidates({ forceAll: true, includeDrafts: true, id: candidateId }, pool);
    if (candidates.length === 0) {
      process.stderr.write(`Candidate ${candidateId} not found.\n`);
      process.exit(1);
    }
    const candidate = candidates[0];

    // Mark accepted
    await markCandidatePendingWrite(candidate.id, pool);

    const skillPath = `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/${candidate.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/, "")}/SKILL.md`;

    // Insert into skills table
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
      process.stderr.write(`A skill named "${candidate.name}" already exists — skipping insert.\n`);
      process.exit(1);
    }

    const skillId = rows[0].id;

    // Update candidate with promoted_skill_id
    await pool.query(
      `UPDATE skill_candidates SET promoted_skill_id = $2, updated_at = NOW() WHERE id = $1`,
      [candidate.id, skillId],
    );

    // Mark enrichment pending
    await pool.query(
      `UPDATE skill_candidates SET enrichment_status='pending', updated_at=NOW() WHERE id=$1`,
      [candidate.id],
    );

    // Build enrichment event text
    const enrichCtx = await getEnrichContext(candidate.id, pool);
    const eventText = buildEnrichEventText(enrichCtx);

    // Fire system event
    execSync(`openclaw system event --text ${JSON.stringify(eventText)} --mode now`, {
      stdio: "inherit",
    });

    process.stdout.write(
      `✓ Promoted "${candidate.name}" (skill id=${skillId}). Enrichment event fired.\n`,
    );
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
