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
} from "@usme/core";
import type { PromoteSkillCandidate } from "@usme/core";
import { logger } from "@usme/core";

const log = logger.child({ module: "promote-command" });

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
