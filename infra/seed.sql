-- Crush Radio — Seed data for LOCAL dev testing only
-- 1 test artist, 3 test tracks, and a T001 transmission whose submission
-- window opened an hour ago — so a fresh `wrangler dev` lands in
-- submissions_open. Shift the timestamps to walk the other states
-- (see docs/runbook-t001.md "Testing states locally").

INSERT OR IGNORE INTO artists (id, slug, name, email, created_at)
VALUES ('artist-001', 'test-artist', 'Test Artist', 'test@crushradio.com', 1716000000);

INSERT OR IGNORE INTO tracks (id, artist_id, title, filename, duration_s, status, track_status, play_count, uploaded_at)
VALUES
  ('track-001', 'artist-001', 'Midnight Drive',  'track-001.mp3', 197, 'held', 'held', 0, 1716000000),
  ('track-002', 'artist-001', 'Voltage',         'track-002.mp3', 224, 'held', 'held', 0, 1716000100),
  ('track-003', 'artist-001', 'Paper Lanterns',  'track-003.mp3', 183, 'held', 'held', 0, 1716000200);

-- T001 relative to "now": submissions opened 1h ago, close in 71h,
-- setlist publishes in 87h, broadcast 95h–97h out, replay closes at 111h.
INSERT OR IGNORE INTO transmissions
  (id, number, submission_open_at, submission_close_at, setlist_publish_at,
   broadcast_start_at, broadcast_end_at, replay_close_at, setlist_json, created_at, updated_at)
VALUES (
  'T001', 1,
  (strftime('%s','now') - 3600)   * 1000,
  (strftime('%s','now') + 255600) * 1000,
  (strftime('%s','now') + 313200) * 1000,
  (strftime('%s','now') + 342000) * 1000,
  (strftime('%s','now') + 349200) * 1000,
  (strftime('%s','now') + 399600) * 1000,
  NULL,
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
);
