-- Migration 019: reflection quality score
-- Adds reflection_quality_score (0-1, NULL = never reviewed) and reflection_last_reviewed_at
-- to the three retrievable memory tiers. NULL is intentional: unreviewed memories are
-- treated as neutral, not penalized (avoids cold-start bias).

ALTER TABLE sensory_trace
  ADD COLUMN IF NOT EXISTS reflection_quality_score REAL,
  ADD COLUMN IF NOT EXISTS reflection_last_reviewed_at TIMESTAMPTZ;

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS reflection_quality_score REAL,
  ADD COLUMN IF NOT EXISTS reflection_last_reviewed_at TIMESTAMPTZ;

ALTER TABLE concepts
  ADD COLUMN IF NOT EXISTS reflection_quality_score REAL,
  ADD COLUMN IF NOT EXISTS reflection_last_reviewed_at TIMESTAMPTZ;

-- Indexes for retrieval ordering (NULL values sort last)
CREATE INDEX IF NOT EXISTS idx_concepts_rqs ON concepts (reflection_quality_score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_episodes_rqs ON episodes (reflection_quality_score DESC NULLS LAST);
