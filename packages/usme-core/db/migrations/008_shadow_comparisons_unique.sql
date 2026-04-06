-- Add unique constraint on (session_id, turn_index) to prevent duplicate shadow
-- comparison rows when multiple code paths (LCM transform + assemble()) both call
-- recordShadowComparison for the same turn.
--
-- Use INSERT ... ON CONFLICT DO NOTHING in application code.
ALTER TABLE shadow_comparisons
  ADD CONSTRAINT uq_shadow_session_turn UNIQUE (session_id, turn_index);
