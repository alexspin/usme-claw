-- Add entity_ids array column to episodes for fast spreading activation lookup
-- Replaces ILIKE ANY full-table scan with GIN-indexed array overlap check

ALTER TABLE episodes ADD COLUMN IF NOT EXISTS entity_ids UUID[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_episodes_entity_ids
  ON episodes USING GIN (entity_ids);

-- Backfill: for each episode, find entities whose canonical or name appears in the summary
-- This is a one-time operation; going forward, insertEpisode will populate entity_ids
UPDATE episodes e
SET entity_ids = (
  SELECT COALESCE(ARRAY_AGG(DISTINCT ent.id), '{}')
  FROM entities ent
  WHERE ent.canonical IS NOT NULL
    AND e.summary ILIKE '%' || LOWER(ent.canonical) || '%'
);
