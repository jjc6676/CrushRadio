// Crush Radio — Artist notifications
// Composition is automatic; delivery is pluggable. Outbox rows are written
// idempotently (unique on kind+transmission+track) at setlist lock and at
// results certification. If KV holds config:resend_key, the cron flushes
// the outbox through Resend; otherwise /studio surfaces each pending row
// as a prefilled mailto link the owner clicks through.

const SITE = "https://crushradio.com";

const CT_LONG = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function ct(ms) {
  return CT_LONG.format(new Date(ms));
}

function statusLink(track) {
  return `${SITE}/track/${track.id}/${track.access_token}`;
}

function txPath(t) {
  return `${SITE}/transmissions/${String(t.number).padStart(3, "0")}`;
}

// --- Composition ---

export function composeSelected(track, t, position) {
  const subject = `You're on the ${t.id} setlist — broadcast ${ct(t.broadcast_start_at)}`;
  const body = [
    `${track.artist_name},`,
    ``,
    `"${track.title}" made the cut. It airs in slot ${position} of Transmission ${String(t.number).padStart(3, "0")}.`,
    ``,
    `Broadcast: ${ct(t.broadcast_start_at)} — one shared stream, no skips, everyone hears it together.`,
    `Voting is live only: listeners tap CRUSHED IT while your track airs. The top third of the setlist survive into the Hall of Crush. The rest retire. If too few people are listening, the track is unjudged and can come back.`,
    ``,
    `Bring your people. Your slot deep-links here:`,
    `${txPath(t)}#${track.artist_slug}`,
    ``,
    `Promo line, if you want it: "I'm transmitting on Crush Radio tonight. ${new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long" }).format(new Date(t.broadcast_start_at))} 8pm CT."`,
    ``,
    `Track your status anytime (private link, don't share):`,
    `${statusLink(track)}`,
    ``,
    `— Crush Radio`,
  ].join("\n");
  return { kind: "artist_selected", subject, body };
}

export function composeHeld(track, t) {
  const subject = `"${track.title}" is held for a future transmission`;
  const body = [
    `${track.artist_name},`,
    ``,
    `"${track.title}" wasn't selected for ${t.id} — it stays in the pool and rolls into the next submission window automatically, once. After that we'll ask you to resubmit so nothing sits in purgatory.`,
    ``,
    `Setlists are 20–25 tracks, hand-picked while the community is small. Held is not a verdict; unaired tracks are never judged.`,
    ``,
    `Track your status anytime (private link, don't share):`,
    `${statusLink(track)}`,
    ``,
    `— Crush Radio`,
  ].join("\n");
  return { kind: "artist_held", subject, body };
}

export function composeResubmitInvite(track, t) {
  const subject = `"${track.title}" rolled over once — resubmit when you're ready`;
  const body = [
    `${track.artist_name},`,
    ``,
    `"${track.title}" stayed in the pool through two submission windows without being selected, so we've taken it out of the automatic queue — that's the rule, no track sits in limbo forever.`,
    ``,
    `Nothing's wrong with it. Setlists are 20–25 tracks while the community is small, and a lot of good work waits. When you want it considered again, just resubmit during any open window (Monday noon → Thursday 8pm CT).`,
    ``,
    `— Crush Radio`,
  ].join("\n");
  return { kind: "artist_resubmit_invite", subject, body };
}

export function composeResult(track, t, result) {
  const padded = String(t.number).padStart(3, "0");
  let verdictLines;
  if (result.status === "crushed") {
    verdictLines = [
      `CRUSHED. "${track.title}" ranked #${result.rank} with ${result.crushes} crushes from ${result.unique_listeners} listeners (${Math.round(result.crush_rate * 100)}%).`,
      ``,
      `It now lives permanently in the Hall of Crush: ${SITE}/#hall`,
    ];
  } else if (result.status === "retired") {
    verdictLines = [
      `"${track.title}" was judged live and retired — ${result.crushes} crushes from ${result.unique_listeners} listeners (${Math.round(result.crush_rate * 100)}%), outside the surviving third.`,
      ``,
      `Retired means it aired, it was heard, and the room decided. It keeps its place in the ${t.id} archive: ${txPath(t)}`,
      `New track, next window — the pool reopens Monday noon CT.`,
    ];
  } else {
    verdictLines = [
      `"${track.title}" aired but didn't reach enough listeners to be judged (${result.unique_listeners} qualified listeners). Per the rules, an unjudged track is NOT retired — you can resubmit it to a future transmission.`,
    ];
  }
  const subject = `${t.id} results: "${track.title}" — ${result.status.toUpperCase()}`;
  const body = [
    `${track.artist_name},`,
    ``,
    ...verdictLines,
    ``,
    `Full results: ${txPath(t)}`,
    `Your status page: ${statusLink(track)}`,
    ``,
    `— Crush Radio`,
  ].join("\n");
  return { kind: "results_published", subject, body };
}

// --- Outbox ---

// Bound INSERT statements for a batch — lets callers fold notification
// writes into the SAME atomic batch as the state change that earned them,
// so a crash between commit and queue can't lose an artist's email.
// rows: [{kind, transmission_id, track_id, email, subject, body, release_at}]
export function outboxStatements(env, rows) {
  const stmt = env.DB.prepare(
    `INSERT OR IGNORE INTO notifications
     (id, kind, transmission_id, track_id, email, subject, body, release_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  return rows.map((r) =>
    stmt.bind(
      crypto.randomUUID(),
      r.kind,
      r.transmission_id,
      r.track_id,
      r.email,
      r.subject,
      r.body,
      r.release_at || 0,
      Date.now()
    )
  );
}

export async function writeOutbox(env, rows) {
  if (!rows.length) return;
  await env.DB.batch(outboxStatements(env, rows));
}

// Only rows whose hold has elapsed. Selected/held emails carry
// release_at = setlist_publish_at, so neither the Resend flush nor the
// studio mailto surface can leak a selection before the public reveal.
export async function pendingNotifications(env, limit = 100, now = Date.now()) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM notifications
       WHERE sent_at IS NULL AND release_at <= ?
       ORDER BY created_at ASC LIMIT ?`
    )
      .bind(now, limit)
      .all();
    return results || [];
  } catch {
    return [];
  }
}

// Selected/held emails composed but not yet releasable — shown in the
// studio as "holds until publish", never as a sendable link.
export async function withheldCount(env, now = Date.now()) {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE sent_at IS NULL AND release_at > ?"
    )
      .bind(now)
      .first();
    return row ? row.n : 0;
  } catch {
    return 0;
  }
}

// --- Delivery (Resend when configured, otherwise rows wait for /studio) ---

export async function flushOutbox(env, batchSize = 20, now = Date.now()) {
  const key = await env.KV.get("config:resend_key");
  if (!key) return { sent: 0, channel: "none" };

  const pending = await pendingNotifications(env, batchSize, now);
  if (pending.length === 0) return { sent: 0, channel: "resend" };

  const from =
    (await env.KV.get("config:mail_from")) ||
    "Crush Radio <transmissions@crushradio.com>";

  let sent = 0;
  for (const n of pending) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
          // Outbox row id — a retry after a crashed tick can never
          // double-email an artist.
          "Idempotency-Key": `outbox/${n.id}`,
        },
        body: JSON.stringify({
          from,
          to: [n.email],
          subject: n.subject,
          text: n.body,
        }),
      });
      if (res.ok) {
        await env.DB.prepare(
          "UPDATE notifications SET sent_at = ?, channel = 'resend' WHERE id = ?"
        )
          .bind(Date.now(), n.id)
          .run();
        sent += 1;
      } else if (res.status === 429) {
        break; // rate limited — the next cron tick continues
      }
      // Other failures stay pending and retry next tick.
    } catch {
      break;
    }
  }
  return { sent, channel: "resend" };
}
