PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS catalog_entries (
  kind TEXT NOT NULL CHECK (kind IN ('product', 'build', 'offer')),
  position INTEGER NOT NULL CHECK (position >= 0),
  row_json TEXT NOT NULL,
  PRIMARY KEY (kind, position)
);

CREATE TABLE IF NOT EXISTS catalog_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS visitor_sessions (
  owner_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_builds (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES visitor_sessions(owner_id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  parts_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  UNIQUE (owner_id, request_id)
);

CREATE INDEX IF NOT EXISTS saved_builds_owner_updated
  ON saved_builds (owner_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS visitor_sessions_expiry
  ON visitor_sessions (expires_at);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE REFERENCES visitor_sessions(owner_id),
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS account_sessions_expiry ON account_sessions(expires_at);
CREATE INDEX IF NOT EXISTS account_sessions_account ON account_sessions(account_id);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
