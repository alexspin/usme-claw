CREATE TABLE entities (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT        NOT NULL,
  entity_type     TEXT        NOT NULL,   -- 'person' | 'org' | 'project' | 'tool' | 'location' | 'concept'
  canonical       TEXT,
  embedding       VECTOR(1536),
  confidence      FLOAT       DEFAULT 1.0,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;
CREATE INDEX idx_entities_canonical ON entities (canonical);

CREATE TABLE entity_relationships (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       UUID        NOT NULL REFERENCES entities(id),
  target_id       UUID        NOT NULL REFERENCES entities(id),
  relationship    TEXT        NOT NULL,
  confidence      FLOAT       DEFAULT 1.0,
  source_item_id  UUID,
  valid_from      TIMESTAMPTZ DEFAULT now(),
  valid_until     TIMESTAMPTZ,
  metadata        JSONB       DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_entity_rel_source ON entity_relationships (source_id, valid_until NULLS LAST);
CREATE INDEX idx_entity_rel_target ON entity_relationships (target_id, valid_until NULLS LAST);
CREATE INDEX idx_entity_rel_type ON entity_relationships (relationship, valid_until NULLS LAST);
