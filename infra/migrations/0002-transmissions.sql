-- Migration 0002 — Transmissions pivot
-- For databases created from the pre-pivot schema (artists/tracks/plays/votes/flags).
-- Run ONCE per database:
--   npm run db:migrate         (remote)
--   npm run db:migrate:local   (local dev)
-- The ALTER TABLE statements fail harmlessly if re-run ("duplicate column name").

ALTER TABLE tracks ADD COLUMN track_status TEXT NOT NULL DEFAULT 'held';
ALTER TABLE tracks ADD COLUMN rollover_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS transmissions (
  id                   TEXT PRIMARY KEY,
  number               INTEGER NOT NULL,
  submission_open_at   INTEGER NOT NULL,
  submission_close_at  INTEGER NOT NULL,
  setlist_publish_at   INTEGER NOT NULL,
  broadcast_start_at   INTEGER NOT NULL,
  broadcast_end_at     INTEGER NOT NULL,
  replay_close_at      INTEGER NOT NULL,
  setlist_json         TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transmission_results (
  transmission_id      TEXT NOT NULL REFERENCES transmissions(id),
  track_id             TEXT NOT NULL REFERENCES tracks(id),
  status               TEXT NOT NULL,
  rank                 INTEGER,
  crushes              INTEGER NOT NULL,
  unique_listeners     INTEGER NOT NULL,
  crush_rate           REAL NOT NULL,
  eligible             INTEGER NOT NULL,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (transmission_id, track_id)
);

CREATE TABLE IF NOT EXISTS track_listens (
  transmission_id TEXT NOT NULL,
  track_id        TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  listen_seconds  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (transmission_id, track_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS idx_tracks_track_status ON tracks(track_status);
CREATE INDEX IF NOT EXISTS idx_transmissions_open ON transmissions(submission_open_at);
CREATE INDEX IF NOT EXISTS idx_tx_results_status ON transmission_results(status, crush_rate);
