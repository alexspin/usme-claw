CREATE TABLE memory_audit_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID        NOT NULL,
  operation       TEXT        NOT NULL, -- noop | update | supersede | merge | delete_new | low_confidence_skip | parse_error
  concept_type    TEXT,
  new_concept_id  UUID,
  target_id       UUID,
  merged_id       UUID,
  before_content  TEXT,
  after_content   TEXT,
  reasoning       TEXT,
  confidence      FLOAT,
  temporal_note   TEXT,
  model_used      TEXT,
  run_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_run_id ON memory_audit_log (run_id);
CREATE INDEX idx_audit_run_at ON memory_audit_log (run_at DESC);
CREATE INDEX idx_audit_operation ON memory_audit_log (operation);
