// Crush Radio — Scheduled jobs
// One cron runs every minute (UTC). Transitions themselves are derived
// from timestamps, so the cron only performs the actions that need an
// actor:
//   setlist publish → auto-lock the selected tracks if the owner hasn't
//   live window     → make sure the Rotator is conducting (idempotent kick)
//   after end       → certify results once (eligibility, crush rate, survival)
//   every tick      → flush the notification outbox when Resend is configured

import {
  deriveState,
  pickActiveTransmission,
  certifyResults,
  SIGNAL_FLOOR,
} from "./state.js";
import { getTransmissions, hydrateSetlist, lockSetlist } from "./api.js";
import {
  composeResult,
  composeResubmitInvite,
  outboxStatements,
  flushOutbox,
} from "./notify.js";

export async function runScheduled(env, now = Date.now()) {
  const rows = await getTransmissions(env);
  const t = pickActiveTransmission(rows, now);
  if (t) {
    const { state } = deriveState(t, now);

    // The curation contract: the setlist locks at publish time whether or
    // not the owner clicked the button. lockSetlist no-ops when already
    // locked and errors harmlessly when nothing is selected.
    if (
      now >= t.setlist_publish_at &&
      now < t.broadcast_start_at &&
      !t.setlist_json
    ) {
      await lockSetlist(env, t.id, now).catch(() => {});
    }

    if (state === "live") {
      await ensureRotatorConducting(env, t);
    }

    if (now >= t.broadcast_end_at && t.setlist_json) {
      await certifyTransmission(env, t, now);
    }
  }

  // Deliver whatever the outbox holds — no-op without config:resend_key.
  await flushOutbox(env).catch(() => {});
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
      // Crushes count only votes from a fingerprint that ALSO qualified as a
      // listener (≥ minListenSeconds). Rotating the User-Agent mints fresh
      // fingerprints, but those have no qualifying listen, so they can't
      // stuff the survival rank — and crush_rate can never exceed 1.
      const crushesRow = await env.DB.prepare(
        `SELECT COUNT(DISTINCT v.fingerprint) AS n FROM votes v
         WHERE v.track_id = ? AND v.vote = 'crushed_it' AND v.voted_at BETWEEN ? AND ?
           AND EXISTS (
             SELECT 1 FROM track_listens tl
             WHERE tl.transmission_id = ? AND tl.track_id = v.track_id
               AND tl.fingerprint = v.fingerprint AND tl.listen_seconds >= ?
           )`
      )
        .bind(slot.track_id, windowStart, windowEnd, t.id, SIGNAL_FLOOR.minListenSeconds)
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

    // Tracks that will expire this cert: held, already rolled once, not yet
    // processed for this transmission. Gather with the artist join now so
    // the resubmit-invite email goes in the same atomic batch.
    const { results: expiring } = await env.DB.prepare(
      `SELECT tr.id, tr.title, tr.access_token, a.name AS artist_name, a.slug AS artist_slug, a.email
       FROM tracks tr JOIN artists a ON a.id = tr.artist_id
       WHERE tr.track_status = 'held' AND tr.uploaded_at < ?
         AND tr.rollover_count >= 1
         AND (tr.last_rollover_tx IS NULL OR tr.last_rollover_tx != ?)`
    )
      .bind(t.submission_close_at, t.id)
      .all();

    // Result emails (release immediately) + resubmit invites, composed
    // before the commit so a crash can't lose them.
    const ids = verdicts.map((v) => v.track_id);
    const byId = new Map();
    if (ids.length) {
      const ph = ids.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT tr.id, tr.title, tr.access_token, a.name AS artist_name, a.slug AS artist_slug, a.email
         FROM tracks tr JOIN artists a ON a.id = tr.artist_id WHERE tr.id IN (${ph})`
      )
        .bind(...ids)
        .all();
      for (const r of results || []) byId.set(r.id, r);
    }

    const notifRows = [];
    for (const v of verdicts) {
      const track = byId.get(v.track_id);
      if (!track || !track.email) continue;
      const msg = composeResult(track, t, v);
      notifRows.push({ ...msg, transmission_id: t.id, track_id: track.id, email: track.email, release_at: now });
    }
    for (const track of expiring || []) {
      if (!track.email) continue;
      const msg = composeResubmitInvite(track, t);
      notifRows.push({ ...msg, transmission_id: t.id, track_id: track.id, email: track.email, release_at: now });
    }

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
    // Roll-once-then-expire, idempotent via last_rollover_tx so overlapping
    // cron ticks can't double-process. Expire runs FIRST (catches the
    // already-rolled) so the roll step below can't bump them into it.
    writes.push(
      env.DB
        .prepare(
          `UPDATE tracks SET track_status = 'expired', last_rollover_tx = ?
           WHERE track_status = 'held' AND uploaded_at < ? AND rollover_count >= 1
             AND (last_rollover_tx IS NULL OR last_rollover_tx != ?)`
        )
        .bind(t.id, t.submission_close_at, t.id)
    );
    writes.push(
      env.DB
        .prepare(
          `UPDATE tracks SET rollover_count = rollover_count + 1, last_rollover_tx = ?
           WHERE track_status = 'held' AND uploaded_at < ? AND rollover_count = 0
             AND (last_rollover_tx IS NULL OR last_rollover_tx != ?)`
        )
        .bind(t.id, t.submission_close_at, t.id)
    );
    writes.push(...outboxStatements(env, notifRows));
    await env.DB.batch(writes);
  } catch {
    // Certification re-runs on the next cron tick; never crash the schedule.
    // INSERT OR IGNORE on results + last_rollover_tx guards make a re-run
    // idempotent, so a partial failure heals on the next tick.
  }
}
