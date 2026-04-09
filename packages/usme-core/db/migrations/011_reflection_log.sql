CREATE TABLE reflection_runs (
  id                     SERIAL PRIMARY KEY,
  triggered_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_source         VARCHAR(50) NOT NULL,
  model                  VARCHAR(100) NOT NULL,
  input_tokens           INTEGER,
  output_tokens          INTEGER,
  duration_ms            INTEGER,
  concepts_updated       INTEGER DEFAULT 0,
  skills_created         INTEGER DEFAULT 0,
  contradictions_resolved INTEGER DEFAULT 0,
  entities_updated       INTEGER DEFAULT 0,
  episodes_promoted      INTEGER DEFAULT 0,
  overall_assessment     TEXT,
  status                 VARCHAR(20) NOT NULL DEFAULT 'running',
  rolled_back            BOOLEAN DEFAULT FALSE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
