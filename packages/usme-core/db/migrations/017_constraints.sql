-- 017: stop-rules / constraints memory type
-- Constraints are always injected ahead of scored memory; they are guardrails, not semantic context.

CREATE TABLE constraints (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern      TEXT        NOT NULL CHECK (pattern IN ('NEVER', 'STOP_DO', 'PREFER', 'WARN')),
  content      TEXT        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  dismissed_at TIMESTAMPTZ
);

CREATE INDEX constraints_active_idx ON constraints (created_at DESC) WHERE dismissed_at IS NULL;
