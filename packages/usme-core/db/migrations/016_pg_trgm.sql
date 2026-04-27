-- Migration 016: Enable pg_trgm extension for trigram similarity search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_skill_candidates_name_trgm
    ON skill_candidates USING gin (name gin_trgm_ops)
    WHERE dismissed_at IS NULL;
