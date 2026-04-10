-- Migration 014: skill_candidates promote columns + pending_morning_notify on reflection_runs
-- Adds columns required for the reflect+promote pipeline.

-- ── skill_candidates table extensions ────────────────────────────────────────

ALTER TABLE skill_candidates
  ADD COLUMN IF NOT EXISTS prompted_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quality_tier      TEXT NOT NULL DEFAULT 'candidate'
                           CHECK (quality_tier IN ('draft', 'candidate')),
  ADD COLUMN IF NOT EXISTS defer_until       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS promoted_skill_id TEXT REFERENCES skills(id),
  ADD COLUMN IF NOT EXISTS source            TEXT NOT NULL DEFAULT 'reflect'
                           CHECK (source IN ('reflect', 'nightly'));

-- ── skills table extensions ───────────────────────────────────────────────────

ALTER TABLE skills
  ADD COLUMN IF NOT EXISTS promoted_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_candidate_id  INTEGER REFERENCES skill_candidates(id),
  ADD COLUMN IF NOT EXISTS generation_notes     JSONB;

-- ── reflection_runs table extension ──────────────────────────────────────────

ALTER TABLE reflection_runs
  ADD COLUMN IF NOT EXISTS pending_morning_notify BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Unique index on skill_candidates(name) (required for ON CONFLICT (name)) ─
-- Must be a non-partial index so ON CONFLICT (name) can use it as a conflict target.

CREATE UNIQUE INDEX IF NOT EXISTS skill_candidates_name_unique
  ON skill_candidates (name);

-- ── Indexes for promote query patterns ───────────────────────────────────────

-- Morning cron query: pending candidates not yet prompted, not dismissed
-- (defer_until < NOW() is checked in query WHERE clause, not index predicate)
CREATE INDEX IF NOT EXISTS idx_skill_candidates_promotable
  ON skill_candidates (confidence DESC, created_at DESC)
  WHERE dismissed_at IS NULL AND prompted_at IS NULL;

-- Quality tier filter (candidate vs draft)
CREATE INDEX IF NOT EXISTS idx_skill_candidates_tier
  ON skill_candidates (quality_tier, confidence DESC)
  WHERE dismissed_at IS NULL;

-- Morning notify flag on reflection_runs
CREATE INDEX IF NOT EXISTS idx_reflection_runs_morning_notify
  ON reflection_runs (created_at DESC)
  WHERE pending_morning_notify = TRUE;
