import pg from 'pg';

const pool = new pg.Pool({
  host: 'localhost',
  user: 'usme',
  password: 'usme_dev',
  database: 'usme',
  port: 5432,
});

const skillNames = [
  'Fix LLM Episode Slug Citation Failures via Short Indexed Labels',
  'Resolve nginx Routing Loops via proxy_redirect Configuration',
  'Architect Multi-Agent Swarm Workflows with Explicit Context Passing',
  'Test Plugin Commands in TUI Before Considering Them Live',
  'Use OpenClaw System Events for Rich Agent Enrichment Turns',
  'Prevent LLM JSON Encoding Failures with Control Character Sanitization'
];

async function checkSkills() {
  const client = await pool.connect();
  try {
    // Check skills table
    const skillsQuery = `SELECT id, name, status FROM skills WHERE name = ANY($1);`;
    const skillsResult = await client.query(skillsQuery, [skillNames]);
    console.log('Skills table:');
    console.table(skillsResult.rows);

    // Check skill_candidates table
    const candidatesQuery = `SELECT id, skill_name, status, confidence FROM skill_candidates WHERE skill_name = ANY($1);`;
    const candidatesResult = await client.query(candidatesQuery, [skillNames]);
    console.log('Skill candidates table:');
    console.table(candidatesResult.rows);
  } finally {
    client.release();
    await pool.end();
  }
}

checkSkills().catch(console.error);