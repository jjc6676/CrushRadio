-- Crush Radio — D1 Schema (canonical, for fresh databases)
-- Applied via: wrangler d1 execute crushradio --remote --file=infra/schema.sql
-- Existing databases created before the transmissions pivot should run
-- infra/migrations/0002-transmissions.sql instead (adds the new tables/columns).

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
  -- Transmission lifecycle: held | selected | crushed | retired | unjudged
  track_status TEXT NOT NULL DEFAULT 'held',
  rollover_count INTEGER NOT NULL DEFAULT 0,
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

-- One row per transmission. Schedule timestamps in UTC ms.
-- No state column: state is derived from these timestamps.
CREATE TABLE IF NOT EXISTS transmissions (
  id                   TEXT PRIMARY KEY,        -- e.g. "T001"
  number               INTEGER NOT NULL,
  submission_open_at   INTEGER NOT NULL,
  submission_close_at  INTEGER NOT NULL,
  setlist_publish_at   INTEGER NOT NULL,
  broadcast_start_at   INTEGER NOT NULL,
  broadcast_end_at     INTEGER NOT NULL,
  replay_close_at      INTEGER NOT NULL,
  setlist_json         TEXT,                    -- cached for fast rendering
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Normalized per-track result rows. Hall of Crush queries hit this table.
CREATE TABLE IF NOT EXISTS transmission_results (
  transmission_id      TEXT NOT NULL REFERENCES transmissions(id),
  track_id             TEXT NOT NULL REFERENCES tracks(id),
  status               TEXT NOT NULL,           -- crushed | retired | unjudged
  rank                 INTEGER,                 -- 1 = top crush rate
  crushes              INTEGER NOT NULL,
  unique_listeners     INTEGER NOT NULL,        -- those meeting minListenSeconds
  crush_rate           REAL NOT NULL,
  eligible             INTEGER NOT NULL,        -- 0 or 1
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (transmission_id, track_id)
);

-- One row per (transmission, track, listener) where the listener was connected
-- for at least the signal-floor minListenSeconds while the track aired.
-- Written by the Rotator at track advance and on socket close.
CREATE TABLE IF NOT EXISTS track_listens (
  transmission_id TEXT NOT NULL,
  track_id        TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  listen_seconds  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (transmission_id, track_id, fingerprint)
);

-- Indexes for hot queries
CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_tracks_track_status ON tracks(track_status);
CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played_at);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_last_played ON tracks(last_artist_played_at);
CREATE INDEX IF NOT EXISTS idx_plays_track_started ON plays(track_id, started_at);
CREATE INDEX IF NOT EXISTS idx_votes_track ON votes(track_id);
CREATE INDEX IF NOT EXISTS idx_votes_fingerprint ON votes(fingerprint, track_id);
CREATE INDEX IF NOT EXISTS idx_flags_track ON flags(track_id, flagged_at);
CREATE INDEX IF NOT EXISTS idx_transmissions_open ON transmissions(submission_open_at);
CREATE INDEX IF NOT EXISTS idx_tx_results_status ON transmission_results(status, crush_rate);
