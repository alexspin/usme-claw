CREATE TABLE skill_candidates (
  id                 SERIAL PRIMARY KEY,
  name               VARCHAR(255) NOT NULL,
  description        TEXT,
  trigger_pattern    TEXT,
  steps              JSONB,
  source_episode_ids INTEGER[],
  confidence         NUMERIC(4,3) NOT NULL,
  reflection_run_id  INTEGER REFERENCES reflection_runs(id),
  approval_status    VARCHAR(20) NOT NULL DEFAULT 'pending',
  accepted           BOOLEAN,
  accepted_at        TIMESTAMPTZ,
  rejected_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
