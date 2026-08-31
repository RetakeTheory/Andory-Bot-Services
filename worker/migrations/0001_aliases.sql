CREATE TABLE IF NOT EXISTS alias_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('music', 'character')),
  target_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at TEXT NOT NULL,
  submitted_by TEXT,
  reviewed_at TEXT
);

CREATE INDEX IF NOT EXISTS alias_proposals_status_submitted
  ON alias_proposals(status, submitted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS alias_proposals_pending_unique
  ON alias_proposals(kind, target_id, normalized_alias)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS approved_aliases (
  kind TEXT NOT NULL CHECK (kind IN ('music', 'character')),
  normalized_alias TEXT NOT NULL,
  target_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (kind, normalized_alias)
);

CREATE INDEX IF NOT EXISTS approved_aliases_target
  ON approved_aliases(kind, target_id);
