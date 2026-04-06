import pg from 'pg';
const pool = new pg.Pool({ connectionString: 'postgres://usme:usme_dev@localhost:5432/usme' });

async function main() {
  // Sample of actual sensory_trace content
  const { rows } = await pool.query(`
    SELECT 
      provenance_kind,
      tags,
      utility_prior,
      created_at,
      LEFT(content, 200) as preview
    FROM sensory_trace
    ORDER BY created_at DESC
    LIMIT 25
  `);

  console.log('=== SENSORY TRACES (latest 25) ===');
  for (const r of rows) {
    console.log(`[${r.provenance_kind}] tags=${JSON.stringify(r.tags)} utility=${r.utility_prior} ${r.created_at?.toISOString().slice(0,16)}`);
    console.log(`  ${r.preview}`);
    console.log();
  }

  // Count by provenance kind
  const { rows: kinds } = await pool.query(`
    SELECT provenance_kind, COUNT(*)::int as n 
    FROM sensory_trace GROUP BY provenance_kind ORDER BY n DESC
  `);
  console.log('=== BY PROVENANCE KIND ===');
  for (const r of kinds) console.log(`  ${r.provenance_kind}: ${r.n}`);

  // Tags distribution
  const { rows: tagRows } = await pool.query(`
    SELECT unnest(tags) as tag, COUNT(*)::int as n
    FROM sensory_trace
    WHERE tags IS NOT NULL AND array_length(tags, 1) > 0
    GROUP BY tag ORDER BY n DESC LIMIT 20
  `);
  console.log('\n=== TOP TAGS ===');
  for (const r of tagRows) console.log(`  ${r.tag}: ${r.n}`);

  // Total counts across all tiers
  const { rows: counts } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM sensory_trace)::int as traces,
      (SELECT COUNT(*) FROM episodes)::int as episodes,
      (SELECT COUNT(*) FROM concepts)::int as concepts,
      (SELECT COUNT(*) FROM skills)::int as skills,
      (SELECT COUNT(*) FROM entities)::int as entities
  `);
  console.log('\n=== TIER COUNTS ===');
  console.log(counts[0]);

  // Sample shadow_comparisons — latest usme_only_preview
  const { rows: recent } = await pool.query(`
    SELECT query_preview, usme_items_selected, usme_only_preview, created_at
    FROM shadow_comparisons
    WHERE usme_items_selected > 0
    ORDER BY created_at DESC
    LIMIT 5
  `);
  console.log('\n=== RECENT SHADOW COMPARISONS (with items) ===');
  for (const r of recent) {
    console.log(`[${r.created_at?.toISOString().slice(0,16)}] items=${r.usme_items_selected} query="${r.query_preview?.slice(0,80)}"`);
    console.log(r.usme_only_preview?.slice(0, 400));
    console.log();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
