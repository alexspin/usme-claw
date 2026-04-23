/**
 * CLI: openclaw usme reflect
 * Runs the Memory Reflection Service on demand.
 */

import { runReflection } from "@usme/core";
import { getPool } from "@usme/core";
import { DEFAULT_FAST_MODEL, DEFAULT_REASONING_MODEL } from "@usme/core/config/models";

export async function reflectCommand(args: string[]): Promise<void> {
  // Parse flags
  let model: string | undefined;
  let dryRun = false;
  let verbose = false;
  let tier: 'all' | 'concepts' | 'episodes' = 'all';
  let statusMode = false;
  let lastN: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--model' && args[i + 1]) {
      const modelArg = args[++i];
      if (modelArg === 'haiku') model = DEFAULT_FAST_MODEL;
      else if (modelArg === 'sonnet') model = DEFAULT_REASONING_MODEL;
      else if (modelArg === 'opus') model = 'claude-opus-4-5';
      else model = modelArg;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--verbose') {
      verbose = true;
    } else if (arg === '--tier' && args[i + 1]) {
      const t = args[++i];
      if (t === 'all' || t === 'concepts' || t === 'episodes') {
        tier = t;
      }
    } else if (arg === '--status') {
      statusMode = true;
    } else if (arg === '--last' && args[i + 1]) {
      lastN = parseInt(args[++i], 10);
    }
  }

  const pool = getPool();

  // --status: show last reflection run
  if (statusMode) {
    const { rows } = await pool.query(
      `SELECT * FROM reflection_runs ORDER BY triggered_at DESC LIMIT 1`,
    );
    if (rows.length === 0) {
      console.log('No reflection runs found.');
    } else {
      const run = rows[0];
      console.log('Last reflection run:');
      console.log(`  ID: ${run.id}`);
      console.log(`  Status: ${run.status}`);
      console.log(`  Triggered: ${new Date(run.triggered_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })}`);
      console.log(`  Model: ${run.model}`);
      console.log(`  Duration: ${run.duration_ms}ms`);
      console.log(`  Concepts updated: ${run.concepts_updated}`);
      console.log(`  Skills created: ${run.skills_created}`);
      console.log(`  Contradictions resolved: ${run.contradictions_resolved}`);
      console.log(`  Entities updated: ${run.entities_updated}`);
      if (run.overall_assessment) {
        console.log(`  Assessment: ${run.overall_assessment}`);
      }
    }
    return;
  }

  // --last N: show last N reflection runs
  if (lastN !== undefined) {
    const { rows } = await pool.query(
      `SELECT * FROM reflection_runs ORDER BY triggered_at DESC LIMIT $1`,
      [lastN],
    );
    if (rows.length === 0) {
      console.log('No reflection runs found.');
    } else {
      console.log(`Last ${rows.length} reflection run(s):`);
      for (const run of rows) {
        const ts = new Date(run.triggered_at).toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
        console.log(`  [${run.id}] ${ts} | ${run.status} | model=${run.model} | concepts=${run.concepts_updated} skills=${run.skills_created} contradictions=${run.contradictions_resolved}`);
      }
    }
    return;
  }

  // Run reflection
  console.log(`Running memory reflection${dryRun ? ' (dry run)' : ''}...`);
  const start = Date.now();

  const result = await runReflection({
    model,
    dryRun,
    verbose,
    tier,
    triggerSource: 'cli',
  });

  const elapsed = Date.now() - start;
  console.log(`Reflection complete in ${elapsed}ms`);
  console.log(`  Run ID: ${result.runId}`);
  console.log(`  Concepts updated: ${result.changes.conceptsUpdated}`);
  console.log(`  Skills created: ${result.changes.skillsCreated}`);
  console.log(`  Contradictions resolved: ${result.changes.contradictionsResolved}`);
  console.log(`  Entities updated: ${result.changes.entitiesUpdated}`);
  console.log(`  Overall assessment: ${result.overallAssessment}`);
}
