CREATE TABLE skills (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL UNIQUE,
  description     TEXT,
  embedding       VECTOR(1536),
  status          TEXT        DEFAULT 'candidate',  -- 'candidate' | 'active' | 'retired'
  skill_path      TEXT        NOT NULL,
  source_episode_ids UUID[]   DEFAULT '{}',
  teachability    FLOAT,
  use_count       INTEGER     DEFAULT 0,
  last_used       TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_skills_embedding ON skills USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND status = 'active';
CREATE INDEX idx_skills_status ON skills (status, teachability DESC);
