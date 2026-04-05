CREATE TABLE concepts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_type    TEXT        NOT NULL,   -- 'fact' | 'preference' | 'decision' | 'relationship_summary'
  content         TEXT        NOT NULL,
  embedding       VECTOR(1536),
  utility_score   FLOAT       DEFAULT 0.5,
  provenance_kind TEXT        NOT NULL,
  provenance_ref  TEXT,
  confidence      FLOAT       DEFAULT 1.0,
  access_count    INTEGER     DEFAULT 0,
  last_accessed   TIMESTAMPTZ,
  supersedes_id   UUID        REFERENCES concepts(id),
  superseded_by   UUID        REFERENCES concepts(id),
  is_active       BOOLEAN     DEFAULT true,
  tags            TEXT[]      DEFAULT '{}',
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_concepts_embedding ON concepts USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND is_active = true;
CREATE INDEX idx_concepts_type_score ON concepts (concept_type, is_active, utility_score DESC);
