// Crush Radio — Scheduled jobs
// One cron runs every minute (UTC). Transitions themselves are derived
// from timestamps, so the cron only performs the two actions that need
// an actor:
//   live window  → make sure the Rotator is conducting (idempotent kick)
//   after end    → certify results once (eligibility, crush rate, survival)

import {
  deriveState,
  pickActiveTransmission,
  certifyResults,
  SIGNAL_FLOOR,
} from "./state.js";
import { getTransmissions, hydrateSetlist } from "./api.js";

export async function runScheduled(env, now = Date.now()) {
  const rows = await getTransmissions(env);
  const t = pickActiveTransmission(rows, now);
  if (!t) return;

  const { state } = deriveState(t, now);

  if (state === "live") {
    await ensureRotatorConducting(env, t);
  }

  if (now >= t.broadcast_end_at && t.setlist_json) {
    await certifyTransmission(env, t, now);
  }
}

// Idempotent: the Rotator no-ops if it is already mid-show for this
// transmission, and self-corrects its position from the wall clock if the
// DO restarted. Called every minute of the live window.
async function ensureRotatorConducting(env, t) {
  const setlist = await hydrateSetlist(env, t);
  if (setlist.length === 0) return;

  const id = env.ROTATOR.idFromName("global");
  await env.ROTATOR.get(id).fetch("https://rotator.internal/start", {
    method: "POST",
    body: JSON.stringify({
      transmission_id: t.id,
      broadcast_start_at: t.broadcast_start_at,
      broadcast_end_at: t.broadcast_end_at,
      setlist,
    }),
    headers: { "content-type": "application/json" },
  });
}

// Runs once: gated on "no transmission_results rows exist yet".
async function certifyTransmission(env, t, now) {
  try {
    const existing = await env.DB.prepare(
      "SELECT 1 FROM transmission_results WHERE transmission_id = ? LIMIT 1"
    )
      .bind(t.id)
      .first();
    if (existing) return;

    const setlist = await hydrateSetlist(env, t);
    if (setlist.length === 0) return;

    // Gather per-track signal: votes and qualified listeners inside the
    // broadcast window (with a 10-minute grace tail for clock slop).
    const windowStart = t.broadcast_start_at - 5 * 60 * 1000;
    const windowEnd = t.broadcast_end_at + 10 * 60 * 1000;

    const stats = [];
    for (const slot of setlist) {
      const crushesRow = await env.DB.prepare(
        `SELECT COUNT(DISTINCT fingerprint) AS n FROM votes
         WHERE track_id = ? AND vote = 'crushed_it' AND voted_at BETWEEN ? AND ?`
      )
        .bind(slot.track_id, windowStart, windowEnd)
        .first();
      const listenersRow = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM track_listens
         WHERE transmission_id = ? AND track_id = ? AND listen_seconds >= ?`
      )
        .bind(t.id, slot.track_id, SIGNAL_FLOOR.minListenSeconds)
        .first();
      const playedRow = await env.DB.prepare(
        `SELECT 1 FROM plays WHERE track_id = ? AND started_at BETWEEN ? AND ? LIMIT 1`
      )
        .bind(slot.track_id, windowStart, windowEnd)
        .first();

      stats.push({
        track_id: slot.track_id,
        position: slot.position,
        played: !!playedRow,
        crushes: crushesRow ? crushesRow.n : 0,
        unique_listeners: listenersRow ? listenersRow.n : 0,
      });
    }

    const verdicts = certifyResults(stats, SIGNAL_FLOOR);

    const writes = [];
    const insert = env.DB.prepare(
      `INSERT OR IGNORE INTO transmission_results
       (transmission_id, track_id, status, rank, crushes, unique_listeners, crush_rate, eligible, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const flip = env.DB.prepare(
      "UPDATE tracks SET track_status = ?, status = ? WHERE id = ?"
    );
    for (const v of verdicts) {
      writes.push(
        insert.bind(t.id, v.track_id, v.status, v.rank, v.crushes, v.unique_listeners, v.crush_rate, v.eligible ? 1 : 0, now)
      );
      writes.push(flip.bind(v.status, v.status, v.track_id));
    }
    // Held tracks submitted for this window roll over once; after one
    // rollover the artist must explicitly resubmit (T001: manual email).
    writes.push(
      env.DB
        .prepare(
          `UPDATE tracks SET rollover_count = rollover_count + 1
           WHERE track_status = 'held' AND uploaded_at < ?`
        )
        .bind(t.submission_close_at)
    );
    await env.DB.batch(writes);
  } catch {
    // Certification re-runs on the next cron tick; never crash the schedule.
  }
}
