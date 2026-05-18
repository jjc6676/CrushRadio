-- Crush Radio v1 — D1 Schema
-- Applied via: wrangler d1 execute crushradio --remote --file=infra/schema.sql

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'trial',
  play_count INTEGER NOT NULL DEFAULT 0,
  crushed_it INTEGER NOT NULL DEFAULT 0,
  next_count INTEGER NOT NULL DEFAULT 0,
  flag_count INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  last_played_at INTEGER,
  last_artist_played_at INTEGER
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  vote TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  voted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  reason TEXT,
  flagged_at INTEGER NOT NULL
);

-- Indexes for hot queries
CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played_at);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_last_played ON tracks(last_artist_played_at);
CREATE INDEX IF NOT EXISTS idx_plays_track_started ON plays(track_id, started_at);
CREATE INDEX IF NOT EXISTS idx_votes_track ON votes(track_id);
CREATE INDEX IF NOT EXISTS idx_votes_fingerprint ON votes(fingerprint, track_id);
CREATE INDEX IF NOT EXISTS idx_flags_track ON flags(track_id, flagged_at);
