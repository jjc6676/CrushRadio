// Crush Radio — Transmission state machine
// Pure functions. No stored state is authoritative: the site state is
// derived from the UTC schedule timestamps on the transmissions row.
// See docs/specs/2026-05-17-transmissions-design.md.

export const STATES = [
  "submissions_open",
  "submissions_closed",
  "setlist_published",
  "live",
  "results",
  "dark",
];

// T001 signal floor — configurable per the spec, constants for now.
export const SIGNAL_FLOOR = {
  minPlays: 1, // track aired at least once during the broadcast
  minListenSeconds: 20, // listener connected ≥20s while the track aired
  minListeners: 10, // unique fingerprints meeting minListenSeconds
  minCrushes: 3, // CRUSHED IT votes recorded
  survivalPercentile: 0.33, // top third by crush rate among eligible tracks
};

// Longer tracks fade at 4:00 — only this much counts toward the broadcast.
export const MAX_COUNTED_SECONDS = 240;

/**
 * Derive the station state for one transmission at time `now`.
 * @param {object|null} t transmissions row (UTC ms timestamps)
 * @param {number} now UTC ms
 * @returns {{state: string, transmission_id: string|null, next_transition_at_utc_ms: number|null}}
 */
export function deriveState(t, now) {
  if (!t) {
    return { state: "dark", transmission_id: null, next_transition_at_utc_ms: null };
  }
  const id = t.id;
  if (now < t.submission_open_at) {
    return { state: "dark", transmission_id: id, next_transition_at_utc_ms: t.submission_open_at };
  }
  if (now < t.submission_close_at) {
    return { state: "submissions_open", transmission_id: id, next_transition_at_utc_ms: t.submission_close_at };
  }
  if (now < t.setlist_publish_at) {
    return { state: "submissions_closed", transmission_id: id, next_transition_at_utc_ms: t.setlist_publish_at };
  }
  if (now < t.broadcast_start_at) {
    return { state: "setlist_published", transmission_id: id, next_transition_at_utc_ms: t.broadcast_start_at };
  }
  if (now < t.broadcast_end_at) {
    return { state: "live", transmission_id: id, next_transition_at_utc_ms: t.broadcast_end_at };
  }
  if (now < t.replay_close_at) {
    return { state: "results", transmission_id: id, next_transition_at_utc_ms: t.replay_close_at };
  }
  return { state: "dark", transmission_id: id, next_transition_at_utc_ms: null };
}

/**
 * Pick the transmission that governs the station right now: the earliest
 * one that hasn't finished its replay window. Rows must be sorted by
 * submission_open_at ascending. Falls back to the most recent finished
 * transmission (state derives to dark) or null.
 */
export function pickActiveTransmission(rows, now) {
  if (!rows || rows.length === 0) return null;
  for (const row of rows) {
    if (now < row.replay_close_at) return row;
  }
  return rows[rows.length - 1];
}

/** Setlist page visibility: published, live, results, and the archive after. */
export function setlistVisible(t, now) {
  return !!t && now >= t.setlist_publish_at;
}

/** Parse setlist_json into an ordered array. Returns [] when unset/invalid. */
export function parseSetlist(t) {
  if (!t || !t.setlist_json) return [];
  try {
    const parsed = JSON.parse(t.setlist_json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Wilson score lower bound (95% CI by default) on the crush fraction.
 * The survival ranking metric: a track loved by a big room outranks a
 * lucky spike in a small one, and bringing 30 real friends tightens the
 * bound rather than gaming it. Zero surveillance, zero friction.
 */
export function wilsonLowerBound(positives, n, z = 1.96) {
  if (n <= 0) return 0;
  const phat = positives / n;
  const z2 = z * z;
  return (
    (phat + z2 / (2 * n) - z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) /
    (1 + z2 / n)
  );
}

/**
 * Certify post-broadcast results per the survival rule. The signal floor
 * gates eligibility; among eligible tracks, survival rank is the Wilson
 * lower bound of the crush fraction (not the raw rate — raw rate lets a
 * 6/10 fluke beat a 40/100 favorite).
 * @param {Array<{track_id: string, position: number, played: boolean,
 *   crushes: number, unique_listeners: number}>} stats one entry per setlist track
 * @param {object} floor SIGNAL_FLOOR-shaped config
 * @returns {Array<{track_id: string, status: string, rank: number|null,
 *   crushes: number, unique_listeners: number, crush_rate: number, eligible: boolean}>}
 */
export function certifyResults(stats, floor = SIGNAL_FLOOR) {
  const judged = stats.map((s) => {
    const eligible =
      (s.played ? 1 : 0) >= floor.minPlays &&
      s.unique_listeners >= floor.minListeners &&
      s.crushes >= floor.minCrushes;
    const crush_rate = s.unique_listeners > 0 ? s.crushes / s.unique_listeners : 0;
    const score = wilsonLowerBound(s.crushes, s.unique_listeners);
    return { ...s, eligible, crush_rate, score };
  });

  const eligible = judged
    .filter((s) => s.eligible)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.crushes - a.crushes ||
        a.position - b.position
    );
  const surviveCount = Math.ceil(eligible.length * floor.survivalPercentile);

  return judged.map((s) => {
    if (!s.eligible) {
      return result(s, "unjudged", null);
    }
    const rank = eligible.indexOf(s) + 1;
    return result(s, rank <= surviveCount ? "crushed" : "retired", rank);
  });

  function result(s, status, rank) {
    return {
      track_id: s.track_id,
      status,
      rank,
      crushes: s.crushes,
      unique_listeners: s.unique_listeners,
      crush_rate: s.crush_rate,
      eligible: s.eligible,
    };
  }
}
