-- Idempotent migration: move qualifying non-HEARTBEAT candidates from skills → skill_candidates
INSERT INTO skill_candidates
  (name, description, confidence, quality_tier, source, created_at, updated_at)
SELECT
  name,
  description,
  COALESCE(teachability, 0.75)::numeric(4,3),
  CASE WHEN COALESCE(teachability, 0.75) >= 0.70 THEN 'candidate' ELSE 'draft' END,
  'reflect',
  COALESCE(created_at, NOW()),
  NOW()
FROM skills
WHERE status = 'candidate'
  AND source_candidate_id IS NULL
  AND name NOT IN (
    'HEARTBEAT.md Session Check-In Protocol',
    'Deploy USME Plugin with Build Verification',
    'Design and Launch Swarm for USME Features',
    'Deploy Multi-Tier Memory System with Reflection Service',
    'Execute Memory Reflection Service',
    'Diagnose USME Memory System Health',
    'Update USME Dashboard Configuration',
    'Optimize SQLite-backed Context Assembly Pipeline'
  )
ON CONFLICT (name) DO NOTHING;

-- Delete all pre-swarm candidates from skills (both migrated + HEARTBEAT)
DELETE FROM skills
WHERE status = 'candidate'
  AND source_candidate_id IS NULL;
