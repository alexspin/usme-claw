CREATE TABLE shadow_comparisons (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      TEXT        NOT NULL,
  turn_index      INTEGER     NOT NULL,
  query_preview   TEXT,

  -- LCM output
  lcm_token_count INTEGER,
  lcm_latency_ms  INTEGER,

  -- USME output
  usme_token_count        INTEGER,
  usme_latency_ms         INTEGER,
  usme_mode               TEXT,
  usme_tiers_contributed  TEXT[],
  usme_items_selected     INTEGER,
  usme_items_considered   INTEGER,
  usme_system_addition_tokens INTEGER,

  -- Comparison
  token_delta     INTEGER,
  overlap_score   FLOAT,
  usme_only_preview TEXT,
  lcm_only_preview  TEXT,

  -- Relevance signal (populated by secondary analysis job)
  usme_relevance_score    FLOAT,
  usme_memory_cited       BOOLEAN,
  relevance_analysis_done BOOLEAN DEFAULT false,

  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_shadow_session ON shadow_comparisons (session_id, turn_index);
CREATE INDEX idx_shadow_created ON shadow_comparisons (created_at DESC);
CREATE INDEX idx_shadow_unanalyzed ON shadow_comparisons (relevance_analysis_done) WHERE NOT relevance_analysis_done;
