// Crush Radio — Queue management
// Picks the next track respecting cool-down rules:
//   - No track within 90 min of its last play
//   - No artist within 20 min of their last play
// Candidates arrive pre-sorted by priority (rotating > background > trial)
// and staleness (least-recently-played first).

const TRACK_COOLDOWN_MS = 90 * 60 * 1000;
const ARTIST_COOLDOWN_MS = 20 * 60 * 1000;

/**
 * @param {Array<{id: string, artist_id: string, title: string, duration_s: number}>} candidates
 * @param {Array<{track_id: string, artist_id: string, played_at: number}>} history
 * @param {{track_id: string}|null} current
 * @returns {Object|null}
 */
export function pickNextTrack(candidates, history, current) {
  const now = Date.now();

  const lastTrackPlay = new Map();
  const lastArtistPlay = new Map();
  for (const entry of history) {
    if (!lastTrackPlay.has(entry.track_id)) {
      lastTrackPlay.set(entry.track_id, entry.played_at);
    }
    if (!lastArtistPlay.has(entry.artist_id)) {
      lastArtistPlay.set(entry.artist_id, entry.played_at);
    }
  }

  for (const track of candidates) {
    if (current && track.id === current.track_id) continue;

    const trackLastPlayed = lastTrackPlay.get(track.id);
    if (trackLastPlayed && now - trackLastPlayed < TRACK_COOLDOWN_MS) continue;

    const artistLastPlayed = lastArtistPlay.get(track.artist_id);
    if (artistLastPlayed && now - artistLastPlayed < ARTIST_COOLDOWN_MS) continue;

    return track;
  }

  // Everything in cool-down — fall back to the least-recently-played
  // candidate that isn't the currently playing track. Prevents dead air
  // when the library is smaller than the cool-down window allows.
  const fallback = candidates.find(
    (t) => !current || t.id !== current.track_id
  );
  return fallback || null;
}
