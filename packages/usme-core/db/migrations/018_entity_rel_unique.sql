-- 018: unique constraint on active entity relationships to prevent duplicate edges across reflection runs
-- NULLS NOT DISTINCT so two rows with valid_until = NULL are treated as equal (both "active")

ALTER TABLE entity_relationships
  ADD CONSTRAINT uq_entity_rel_active
  UNIQUE NULLS NOT DISTINCT (source_id, target_id, relationship, valid_until);
