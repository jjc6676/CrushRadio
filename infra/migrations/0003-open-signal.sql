-- Migration 0003 — Open Signal: studio curation, artist status links,
-- notifications outbox. Run ONCE per database:
--   npm run db:migrate:0003          (remote)
--   npm run db:migrate:0003:local    (local dev)
-- The ALTER TABLE statements fail harmlessly if re-run ("duplicate column name").

ALTER TABLE tracks ADD COLUMN access_token TEXT;
ALTER TABLE tracks ADD COLUMN artist_url TEXT;
ALTER TABLE tracks ADD COLUMN curation_position INTEGER;
-- DDEX-style AI provenance disclosure: human | ai_assisted | fully_ai
ALTER TABLE tracks ADD COLUMN ai_disclosure TEXT NOT NULL DEFAULT 'human';

-- Composed artist emails. Written idempotently at setlist lock and results
-- certification; delivered by Resend when config:resend_key exists in KV,
-- otherwise surfaced in /studio as one-click mailto links.
CREATE TABLE IF NOT EXISTS notifications (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,      -- artist_selected | artist_held | results_published
  transmission_id TEXT NOT NULL,
  track_id        TEXT NOT NULL,
  email           TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER,
  channel         TEXT                -- resend | manual
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedup
  ON notifications(kind, transmission_id, track_id);
CREATE INDEX IF NOT EXISTS idx_notifications_pending
  ON notifications(sent_at, created_at);
