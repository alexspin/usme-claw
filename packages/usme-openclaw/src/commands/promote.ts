/**
 * CLI: openclaw usme promote
 *
 * Presents pending skill candidates to the user for review and promotion.
 * Candidates are produced by the reflect pipeline and stored in skill_candidates.
 *
 * Usage:
 *   usme promote                  — show top candidates (quality_tier=candidate only)
 *   usme promote --include-drafts — also show draft-tier (0.50–0.69 confidence)
 *   usme promote --force          — show all candidates, ignoring prompted_at/defer filters
 *   usme promote --id <N>         — show a specific candidate by id
 *
 * Interactive session:
 *   "1 3"       — promote candidates 1 and 3 (by list position)
 *   "all"       — promote all listed candidates
 *   "skip"      — dismiss the session without promoting or marking anything
 *   "detail N"  — show full detail card for candidate at position N
 *   "defer N"   — defer candidate N for 24 hours
 *   "dismiss N" — permanently dismiss candidate N
 */

import readline from "node:readline";
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
  const episodesSection = ctx.sourceEpisodes.length > 0
    ? ctx.sourceEpisodes
        .map(e => `  - Episode ${e.id} (${String(e.createdAt).split('T')[0]}): ${e.summary}`)
        .join('\n')
    : '  (no source episodes recorded)';

  const conceptsSection = ctx.relatedConcepts.length > 0
    ? ctx.relatedConcepts
        .map(c => `  - ${c.name}: ${c.summary ?? ''}`)
        .join('\n')
    : '  (no related concepts found)';

  return `
🔨 USME Skill Enrichment Task — candidate ID: ${ctx.candidateId}

Skill to build: "${ctx.name}"
Description: ${ctx.description}
Trigger pattern: ${ctx.triggerPattern ?? 'not specified'}
Confidence: ${ctx.confidence} (${ctx.qualityTier})
Output file: ${ctx.skillPath}

Source episodes from USME memory (grounding material):
${episodesSection}

Related concepts:
${conceptsSection}

Instructions:
Use all available tools to build a complete, grounded SKILL.md for "${ctx.name}".
Do NOT invent procedural steps. Every command, flag, and failure mode must come from
real evidence — LCM conversation history, USME episodes, or verified documentation.

Required research steps:
1. Call lcm_expand_query with query="${ctx.name}" and a focused prompt asking for
   exact steps, commands, failure modes, and recovery paths from past conversations.
2. Call lcm_grep to find specific relevant messages (error messages, exact CLI flags,
   config values) related to this skill topic.
3. Search USME episodes table for any additional episodes related to "${ctx.name}"
   beyond the source episodes listed above.
4. If the skill involves external tools or APIs, call web_search for current best
   practices and known failure modes.

Once research is complete, synthesize a complete SKILL.md following the OpenClaw skill
format (read /home/alex/ai/projects/.openclaw/workspace-rufus/skills/debugging/SKILL.md
as the format reference). Every section must be grounded in real evidence. Use:
  <!-- insufficient grounding: add detail after first use -->
for any section where you cannot find specific evidence.

After writing the file:
1. Write the SKILL.md to: ${ctx.skillPath}
2. Run this SQL to mark the skill active in the DB:
   PGPASSWORD=usme_dev psql -h localhost -U usme -d usme -c "
     INSERT INTO skills (name, description, status, skill_path, teachability, metadata)
     VALUES ('${ctx.name.replace(/'/g, "''")}', '${ctx.description.replace(/'/g, "''")}', 'active', '${ctx.skillPath}',
             ${ctx.confidence}, '{}')
     ON CONFLICT (name) DO UPDATE SET
       status = 'active', skill_path = EXCLUDED.skill_path, updated_at = NOW()
     RETURNING id;"
   Then: UPDATE skill_candidates SET enrichment_status='complete', accepted=true,
     accepted_at=NOW() WHERE id=${ctx.candidateId};
3. Report: what you found in LCM, what you wrote, what was left underspecified.

This is a high-quality task. Take the time to do it properly.
`.trim();
}

// ── Promotion (insert to skills table) ──────────────────────

async function promoteToSkill(
  candidate: PromoteSkillCandidate,
): Promise<string | null> {
  const pool = getPool();

  // Mark candidate as accepted first
  await markCandidatePendingWrite(candidate.id, pool);

  const skillPath = `skills/${candidate.name.replace(/\s+/g, "-").toLowerCase()}.md`;

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
    // Conflict — name already exists
    log.warn({ name: candidate.name }, "skill name conflict on insert — skipping");
    return null;
  }

  const skillId = rows[0].id;

  // Update candidate with promoted_skill_id
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

  // Get enrichment context and fire system event to wake Rufus for SKILL.md synthesis
  try {
    const enrichCtx = await getEnrichContext(candidate.id, pool);
    const eventText = buildEnrichEventText(enrichCtx);

    // Mark enrichment as pending before firing
    await pool.query(
      "UPDATE skill_candidates SET enrichment_status='pending', updated_at=NOW() WHERE id=$1",
      [candidate.id],
    );

    // Fire system event — this wakes Rufus's main session with full tool access
    const { execSync } = await import("node:child_process");
    execSync(
      `openclaw system event --text ${JSON.stringify(eventText)} --mode now`,
      { stdio: 'inherit' },
    );

    console.log(`\n🔨 Enrichment task fired for "${candidate.name}".`);
    console.log(`   Rufus will synthesize the SKILL.md using LCM history and USME memories.`);
    console.log(`   Output: ${enrichCtx.skillPath}`);
  } catch (err) {
    log.warn({ err, candidateId: candidate.id }, "enrichment event fire failed — skill promoted but enrichment not triggered");
  }

  return skillId;
}

// ── Interactive prompt helper ────────────────────────────────

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── Main command ─────────────────────────────────────────────

export async function promoteCommand(args: string[]): Promise<void> {
  let includeDrafts = false;
  let forceAll = false;
  let specificId: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--include-drafts") {
      includeDrafts = true;
    } else if (arg === "--force") {
      forceAll = true;
    } else if (arg === "--id" && args[i + 1]) {
      specificId = parseInt(args[++i], 10);
      if (isNaN(specificId)) {
        console.error("--id requires a numeric value");
        return;
      }
    }
  }

  const pool = getPool();

  const candidates = await getPromoteCandidates(
    { includeDrafts, forceAll, id: specificId },
    pool,
  );

  if (candidates.length === 0) {
    console.log("No skill candidates ready for review.");
    console.log("(Use --force to see previously prompted candidates, --include-drafts for lower-confidence items.)");
    return;
  }

  // Mark all fetched candidates as prompted
  await markCandidatesPrompted(candidates.map((c) => c.id), pool);

  // Print the card
  const card = buildPromoteCard(candidates);
  console.log(card);

  // Interactive session
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      const input = (await prompt(rl, "\n> ")).trim().toLowerCase();

      if (!input || input === "skip" || input === "q" || input === "quit") {
        console.log("Skipped. Candidates will reappear tomorrow.");
        break;
      }

      // "detail N"
      const detailMatch = input.match(/^detail\s+(\d+)$/);
      if (detailMatch) {
        const pos = parseInt(detailMatch[1], 10) - 1;
        if (pos < 0 || pos >= candidates.length) {
          console.log(`Invalid position. Enter 1–${candidates.length}.`);
          continue;
        }
        const detail = await getDetailCard(candidates[pos].id, pool);
        console.log(detail);
        continue;
      }

      // "defer N"
      const deferMatch = input.match(/^defer\s+(\d+)$/);
      if (deferMatch) {
        const pos = parseInt(deferMatch[1], 10) - 1;
        if (pos < 0 || pos >= candidates.length) {
          console.log(`Invalid position. Enter 1–${candidates.length}.`);
          continue;
        }
        await deferCandidate(candidates[pos].id, pool);
        console.log(`Candidate "${candidates[pos].name}" deferred 24 hours.`);
        continue;
      }

      // "dismiss N"
      const dismissMatch = input.match(/^dismiss\s+(\d+)$/);
      if (dismissMatch) {
        const pos = parseInt(dismissMatch[1], 10) - 1;
        if (pos < 0 || pos >= candidates.length) {
          console.log(`Invalid position. Enter 1–${candidates.length}.`);
          continue;
        }
        await markCandidateDismissed(candidates[pos].id, pool);
        console.log(`Candidate "${candidates[pos].name}" permanently dismissed.`);
        continue;
      }

      // "all" or "1 3 2" — promotion
      let toPromote: PromoteSkillCandidate[] = [];

      if (input === "all") {
        toPromote = [...candidates];
      } else {
        const positions = input
          .split(/\s+/)
          .map((s) => parseInt(s, 10))
          .filter((n) => !isNaN(n));

        if (positions.length === 0) {
          console.log('Enter numbers (e.g. "1 3"), "all", "skip", "detail N", "defer N", or "dismiss N".');
          continue;
        }

        for (const pos of positions) {
          const idx = pos - 1;
          if (idx < 0 || idx >= candidates.length) {
            console.log(`Position ${pos} out of range (1–${candidates.length}).`);
          } else {
            toPromote.push(candidates[idx]);
          }
        }
      }

      if (toPromote.length === 0) continue;

      // Promote each selected candidate
      let promoted = 0;
      for (const c of toPromote) {
        console.log(`\nPromoting "${c.name}"...`);
        const skillId = await promoteToSkill(c);
        if (skillId) {
          console.log(`  ✓ Promoted to active skill (id=${skillId})`);
          promoted++;
        } else {
          console.log(`  ✗ Skipped — a skill named "${c.name}" already exists.`);
        }
      }

      console.log(`\n${promoted}/${toPromote.length} candidate(s) promoted.`);

      if (promoted > 0) {
        console.log(
          "Skills are now active and will be injected into future context windows.",
        );
      }

      break;
    }
  } finally {
    rl.close();
  }
}
