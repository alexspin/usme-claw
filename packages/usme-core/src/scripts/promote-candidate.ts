#!/usr/bin/env node
/**
 * Promotes a single skill candidate by DB id.
 * Runnable directly via: npx tsx packages/usme-core/src/scripts/promote-candidate.ts <id>
 *
 * Args:
 *   <id>        Numeric candidate ID shown as [id=N] in list-candidates.ts output
 *
 * The script writes a thin SKILL.md scaffold, computes an embedding, and updates
 * the DB. Full enrichment (real commands, failure modes) is added by Rufus in
 * conversation after promotion.
 */

import fs from "node:fs";
import path from "node:path";
import {
  getPool,
  closePool,
  getPromoteCandidates,
  getEnrichContext,
  embedText,
} from "../index.js";

// ── SKILL.md builder ───────────────────────────────────────────────────────

function buildSkillMd(ctx: Awaited<ReturnType<typeof getEnrichContext>>): string {
  // slug for frontmatter name field
  const slug = ctx.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  // Frontmatter description is the triggering mechanism — dense, specific
  const triggerClause = ctx.triggerPattern ? ` Triggers on: ${ctx.triggerPattern}.` : "";
  const fmDescription = `${(ctx.description ?? "Skill candidate awaiting enrichment.").replace(/"/g, "'")}${triggerClause}`;

  const episodesSection =
    ctx.sourceEpisodes.length > 0
      ? ctx.sourceEpisodes
          .map(
            (e) =>
              `- **Episode ${e.id}** (${String(e.createdAt).split("T")[0]}): ${e.summary}`,
          )
          .join("\n")
      : "_No source episodes recorded — enrichment will rely on LCM recall._";

  const conceptsSection =
    ctx.relatedConcepts.length > 0
      ? ctx.relatedConcepts.map((c) => `- **${c.name}**: ${c.summary ?? ""}`).join("\n")
      : "_No related concepts found._";

  return `---
name: ${slug}
description: "${fmDescription}"
---

# ${ctx.name}

> ⚠️ Thin scaffold — enrich by telling Rufus which skill to flesh out.
> Candidate ID: ${ctx.candidateId} | Confidence: ${Number(ctx.confidence).toFixed(2)} | Tier: ${ctx.qualityTier}

## When to Use

${ctx.description ?? "_Awaiting enrichment._"}

**Trigger pattern:** ${ctx.triggerPattern ?? "_Not specified._"}

## Prerequisites

${conceptsSection}

## Steps

_To be filled in during enrichment — see source episodes below for raw material._

## Failure Modes

_To be filled in during enrichment._

## Verification

_To be filled in during enrichment._

---

## Source Episodes

${episodesSection}
`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Resolve candidate id — only accepts bare integer id (from list-candidates output)
  const pool = getPool();
  let candidateId: number;

  try {
    {
      const idStr = args.find((a) => !a.startsWith("-"));
      if (!idStr || isNaN(Number(idStr))) {
        process.stderr.write(
          "Usage: promote-candidate.ts <numeric-candidate-id>\n" +
          "  Find ids via: npx tsx list-candidates.ts --force\n",
        );
        process.exit(1);
      }
      candidateId = parseInt(idStr, 10);
    }

    // Verify candidate exists
    const candidates = await getPromoteCandidates(
      { forceAll: true, includeDrafts: true, id: candidateId },
      pool,
    );
    if (candidates.length === 0) {
      process.stderr.write(`Candidate ${candidateId} not found.\n`);
      process.exit(1);
    }
    const candidate = candidates[0];

    const skillSlug = candidate.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const skillPath = `/home/alex/ai/projects/.openclaw/workspace-rufus/skills/${skillSlug}/SKILL.md`;

    // ── Transaction: INSERT skills + UPDATE skill_candidates ──────────────
    const client = await pool.connect();
    let skillId: string;

    try {
      await client.query("BEGIN");

      // Mark candidate accepted
      await client.query(
        `UPDATE skill_candidates
         SET approval_status = 'accepted', accepted = true, accepted_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [candidate.id],
      );

      // Insert into skills
      // Note: source_episode_ids omitted — skill_candidates stores integer IDs
      // but skills.source_episode_ids is UUID[]. Pass NULL; skill_path is the pointer.
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO skills
           (name, description, status, skill_path, teachability,
            promoted_at, source_candidate_id, generation_notes, metadata)
         VALUES ($1, $2, 'active', $3, $4, NOW(), $5, $6, $7)
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
        [
          candidate.name,
          candidate.description ?? null,
          skillPath,
          candidate.confidence,
          candidate.id,
          JSON.stringify({ from_candidate: candidate.id, quality_tier: candidate.quality_tier }),
          "{}",
        ],
      );

      if (rows.length === 0) {
        // ON CONFLICT DO NOTHING — check if this candidate already owns the skill
        const { rows: existingRows } = await client.query<{ id: string }>(
          `SELECT s.id FROM skills s
           JOIN skill_candidates sc ON sc.promoted_skill_id = s.id
           WHERE s.name = $1 AND sc.id = $2`,
          [candidate.name, candidate.id],
        );
        if (existingRows.length > 0) {
          // This candidate already owns the skill — safe to resume enrichment
          skillId = existingRows[0].id;
          await client.query("COMMIT");
        } else {
          // Genuine conflict: a different candidate owns a skill with this name
          await client.query("ROLLBACK");
          process.stderr.write(
            `A skill named "${candidate.name}" already exists and belongs to a different candidate.\n`,
          );
          process.exit(1);
        }
      } else {
        skillId = rows[0].id;

        // Link candidate to the new skill; mark enrichment pending-write
        await client.query(
          `UPDATE skill_candidates
           SET promoted_skill_id = $2, enrichment_status = 'pending', updated_at = NOW()
           WHERE id = $1`,
          [candidate.id, skillId],
        );

        await client.query("COMMIT");
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    // ── Enrichment (outside transaction — recoverable on re-run) ──────────

    // Build context and SKILL.md content
    const enrichCtx = await getEnrichContext(candidate.id, pool);
    const skillContent = buildSkillMd(enrichCtx);

    // Write SKILL.md to disk
    const skillDir = path.dirname(skillPath);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, skillContent, "utf-8");
    const lineCount = skillContent.split("\n").length;

    // Compute embedding
    let embeddingStored = false;
    const openaiKey = process.env.OPENAI_API_KEY ?? "";
    if (openaiKey) {
      try {
        const vec = await embedText(skillContent, openaiKey);
        // Store vector in pgvector format: '[x,x,x,...]'
        const vecLiteral = `[${vec.join(",")}]`;
        await pool.query(
          `UPDATE skills SET embedding = $2::vector WHERE id = $1`,
          [skillId, vecLiteral],
        );
        embeddingStored = true;
      } catch (embedErr) {
        const msg = embedErr instanceof Error ? embedErr.message : String(embedErr);
        process.stderr.write(`Warning: embedding failed (${msg}). Re-run to retry.\n`);
      }
    } else {
      process.stderr.write("Warning: OPENAI_API_KEY not set — embedding skipped.\n");
    }

    // Mark enrichment complete
    await pool.query(
      `UPDATE skill_candidates
       SET enrichment_status = 'complete', updated_at = NOW()
       WHERE id = $1`,
      [candidate.id],
    );

    process.stdout.write(
      `✓ Promoted "${candidate.name}"
  skill id   : ${skillId}
  file path  : ${skillPath}
  line count : ${lineCount}
  embedding  : ${embeddingStored ? "stored" : "skipped (no OPENAI_API_KEY)"}
`,
    );
  } finally {
    await closePool();
  }
}

main().catch((err) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
