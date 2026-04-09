ALTER TABLE episodes ADD COLUMN importance_score INTEGER NOT NULL DEFAULT 5 CHECK (importance_score >= 1 AND importance_score <= 10);
