-- Crush Radio v1 — Seed data for dev testing
-- 1 test artist, 3 test tracks (simulating uploaded songs)
-- Real uploads land in Plan 2; these exist so the Rotator has something to spin.

INSERT OR IGNORE INTO artists (id, slug, name, email, created_at)
VALUES ('artist-001', 'test-artist', 'Test Artist', 'test@crushradio.com', 1716000000);

INSERT OR IGNORE INTO tracks (id, artist_id, title, filename, duration_s, status, play_count, uploaded_at)
VALUES
  ('track-001', 'artist-001', 'Midnight Drive',  'track-001.mp3', 197, 'trial', 0, 1716000000),
  ('track-002', 'artist-001', 'Voltage',         'track-002.mp3', 224, 'trial', 0, 1716000100),
  ('track-003', 'artist-001', 'Paper Lanterns',  'track-003.mp3', 183, 'trial', 0, 1716000200);
