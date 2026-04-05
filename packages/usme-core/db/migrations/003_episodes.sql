CREATE TABLE episodes (
  id              UUID        DEFAULT gen_random_uuid(),
  session_ids     TEXT[]      NOT NULL,
  time_bucket     TIMESTAMPTZ NOT NULL,
  summary         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  source_trace_ids UUID[]     NOT NULL,
  token_count     INTEGER,
  utility_score   FLOAT       DEFAULT 0.5,
  access_count    INTEGER     DEFAULT 0,
  last_accessed   TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (id, created_at)
);

SELECT create_hypertable('episodes', 'created_at', chunk_time_interval => INTERVAL '7 days');

CREATE INDEX idx_episodes_embedding ON episodes USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_episodes_time_bucket ON episodes (time_bucket DESC);
