CREATE TABLE IF NOT EXISTS user_preferences (
  preference_key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
