-- Migration 0004 — hardening from the Open Signal adversarial review.
-- Run ONCE per database:
--   npm run db:migrate:0004          (remote)
--   npm run db:migrate:0004:local    (local dev)
-- ALTER statements fail harmlessly if re-run ("duplicate column name").

-- Notifications hold until release_at: selected/held rows are composed at
-- lock but must not deliver (Resend OR manual mailto) until the setlist
-- publishes — the email and the public reveal drop together. Results rows
-- release immediately (release_at = now at compose).
ALTER TABLE notifications ADD COLUMN release_at INTEGER NOT NULL DEFAULT 0;

-- Idempotent rollover + roll-once-then-expire. last_rollover_tx records the
-- transmission a held track was last processed for, so a re-run (overlapping
-- cron ticks) can't double-increment or expire a track twice.
ALTER TABLE tracks ADD COLUMN last_rollover_tx TEXT;

-- Which submission window a track belongs to (the transmission open at
-- upload time). Backs a race-proof one-track-per-artist-per-window rule.
ALTER TABLE tracks ADD COLUMN submission_window TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracks_one_per_window
  ON tracks(artist_id, submission_window);

-- The live crush counter can't double-count one fingerprint, and a vote
-- row is unique per (track, fingerprint). Survival math additionally
-- cross-checks votes against qualified listens at certification.
CREATE UNIQUE INDEX IF NOT EXISTS idx_votes_one_per_fingerprint
  ON votes(track_id, fingerprint);

CREATE INDEX IF NOT EXISTS idx_notifications_release
  ON notifications(sent_at, release_at, created_at);
