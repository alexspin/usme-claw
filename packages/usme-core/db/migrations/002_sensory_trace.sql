CREATE TABLE sensory_trace (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  item_type       TEXT        NOT NULL,   -- 'verbatim' | 'extracted'
  memory_type     TEXT,                   -- 'fact' | 'preference' | 'decision' | 'plan' | 'anomaly' | 'ephemeral' | null
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  provenance_kind TEXT        NOT NULL,   -- 'user' | 'tool' | 'model' | 'web' | 'file'
  provenance_ref  TEXT,
  utility_prior   TEXT        DEFAULT 'medium',  -- 'high' | 'medium' | 'low' | 'discard'
  tags            TEXT[]      DEFAULT '{}',
  extractor_ver   TEXT,
  metadata        JSONB       DEFAULT '{}',
  episodified_at  TIMESTAMPTZ,            -- set when trace is consumed by episodification
  created_at      TIMESTAMPTZ DEFAULT now(),
  expires_at      TIMESTAMPTZ             -- now() + TTL at insert time
);

-- NOT a hypertable. Standard table with TTL index.
CREATE INDEX idx_sensory_trace_expires ON sensory_trace (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_sensory_trace_session ON sensory_trace (session_id, turn_index);
CREATE INDEX idx_sensory_trace_embedding ON sensory_trace USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_sensory_trace_unepisodified ON sensory_trace (created_at)
  WHERE episodified_at IS NULL AND item_type = 'extracted';
