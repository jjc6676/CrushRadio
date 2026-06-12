// Crush Radio — Transmission pages (server-rendered)
// /transmissions/:number → pending page before setlist publish,
// setlist + promo anchors once published, results table after broadcast.

import { deriveState, pickActiveTransmission } from "./state.js";
import { hydrateSetlist } from "./api.js";

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "long",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function ct(ms) {
  return CT.format(new Date(ms));
}

function fmtDuration(s) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// --- GET /transmissions/:n.ics — add the broadcast to your calendar ---

function icsEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function icsUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Pure — exported for tests.
export function icsForTransmission(t, nowMs = Date.now()) {
  const padded = String(t.number).padStart(3, "0");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Crush Radio//Transmission//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${t.id.toLowerCase()}@crushradio.com`,
    `DTSTAMP:${icsUtc(nowMs)}`,
    `DTSTART:${icsUtc(t.broadcast_start_at)}`,
    `DTEND:${icsUtc(t.broadcast_end_at)}`,
    `SUMMARY:${icsEscape(`Crush Radio — Transmission ${padded} (live)`)}`,
    `DESCRIPTION:${icsEscape(
      "One shared broadcast. No skips. Tap CRUSHED IT on the tracks worth keeping — the top third survive.\nhttps://crushradio.com"
    )}`,
    "URL:https://crushradio.com",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape("Crush Radio goes live in 30 minutes")}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n") + "\r\n";
}

export async function renderTransmissionIcs(env, numberRaw) {
  const number = parseInt(String(numberRaw).replace(/^t/i, ""), 10);
  if (!Number.isFinite(number)) return notFound();
  let t;
  try {
    t = await env.DB.prepare("SELECT * FROM transmissions WHERE number = ?").bind(number).first();
  } catch {
    t = null;
  }
  if (!t) return notFound();
  return new Response(icsForTransmission(t), {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="crush-radio-t${String(t.number).padStart(3, "0")}.ics"`,
      "cache-control": "public, max-age=300",
    },
  });
}

// --- GET /track/:id/:token — the artist's private status page ---

export async function renderTrackStatusPage(env, trackId, token, now = Date.now()) {
  let track;
  try {
    track = await env.DB.prepare(
      `SELECT t.*, a.name AS artist_name, a.slug AS artist_slug
       FROM tracks t JOIN artists a ON a.id = t.artist_id WHERE t.id = ?`
    )
      .bind(trackId)
      .first();
  } catch {
    track = null;
  }
  if (!track || !track.access_token || !token || track.access_token !== token) {
    return notFound();
  }

  let t = null;
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM transmissions ORDER BY submission_open_at ASC"
    ).all();
    t = pickActiveTransmission(results || [], now);
  } catch {}

  let result = null;
  if (["crushed", "retired", "unjudged"].includes(track.track_status)) {
    try {
      result = await env.DB.prepare(
        "SELECT * FROM transmission_results WHERE track_id = ? ORDER BY created_at DESC LIMIT 1"
      )
        .bind(trackId)
        .first();
    } catch {}
  }

  // Selection is secret until the setlist publishes — the email and the
  // public setlist drop at the same moment for everyone.
  const revealSelection = !t || now >= t.setlist_publish_at;
  const effectiveStatus =
    track.track_status === "selected" && !revealSelection ? "held" : track.track_status;

  let kickerText, headline, detail;
  if (effectiveStatus === "selected") {
    const padded = t ? String(t.number).padStart(3, "0") : "???";
    kickerText = "SELECTED";
    headline = `You're on the ${t ? t.id : ""} setlist.`;
    detail = `
      <p class="lead">"<b>${escapeHtml(track.title)}</b>" airs ${t ? escapeHtml(ct(t.broadcast_start_at)) : "soon"}.
      One shared stream — bring your people.</p>
      <p class="lead">Your slot deep-links: <a href="/transmissions/${padded}#${escapeHtml(track.artist_slug)}">crushradio.com/transmissions/${padded}#${escapeHtml(track.artist_slug)}</a></p>
      <p class="dim">Voting is live-only. The top third of the setlist survive into the Hall of Crush.</p>
      ${t ? `<p><a class="btn" href="/transmissions/${padded}.ics">+ Add the broadcast to your calendar</a></p>` : ""}`;
  } else if (effectiveStatus === "held") {
    kickerText = "IN THE POOL";
    headline = "Held — awaiting curation.";
    detail = `
      <p class="lead">"<b>${escapeHtml(track.title)}</b>" is in the pool${t ? ` for ${escapeHtml(t.id)}` : ""}.
      Setlists are 20–25 tracks, hand-picked. ${t && now < t.setlist_publish_at ? `The setlist publishes ${escapeHtml(ct(t.setlist_publish_at))}.` : ""}</p>
      <p class="dim">Not selected this week? The track rolls into the next window automatically, once
      (current rollovers: ${track.rollover_count}). Held is not a verdict — unaired tracks are never judged.</p>`;
  } else if (effectiveStatus === "expired") {
    kickerText = "ROLLED OVER";
    headline = "Out of the auto-queue.";
    detail = `
      <p class="lead">"<b>${escapeHtml(track.title)}</b>" waited through two submission windows without being selected, so it's out of the automatic pool — no track sits in limbo forever.</p>
      <p class="dim">Nothing's wrong with it. Resubmit during any open window (Monday noon → Thursday 8pm CT) whenever you want it back in the running.</p>`;
  } else if (effectiveStatus === "crushed") {
    kickerText = "CRUSHED";
    headline = "It survived.";
    detail = `
      <p class="lead">"<b>${escapeHtml(track.title)}</b>" ${result ? `ranked <b>#${result.rank}</b> with <b>${result.crushes}</b> crushes from ${result.unique_listeners} listeners (${Math.round(result.crush_rate * 100)}%)` : "survived the broadcast"}.
      It lives permanently in the <a href="/">Hall of Crush</a>.</p>`;
  } else if (effectiveStatus === "retired") {
    kickerText = "RETIRED";
    headline = "Played. Judged. Retired.";
    detail = `
      <p class="lead">"<b>${escapeHtml(track.title)}</b>" aired and was judged live${result ? ` — ${result.crushes} crushes from ${result.unique_listeners} listeners (${Math.round(result.crush_rate * 100)}%), outside the surviving third` : ""}.
      It keeps its place in the archive${result ? ` of ${escapeHtml(result.transmission_id)}` : ""}.</p>
      <p class="dim">New track, next window — submissions reopen Monday noon CT.</p>`;
  } else {
    kickerText = "UNJUDGED";
    headline = "Not enough signal.";
    detail = `
      <p class="lead">"<b>${escapeHtml(track.title)}</b>" aired but didn't reach enough listeners to be judged${result ? ` (${result.unique_listeners} qualified listeners)` : ""}.
      Per the rules it is <b>not</b> retired — you can resubmit it to a future transmission.</p>`;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(track.title)} — status — Crush Radio</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link href="https://fonts.googleapis.com/css2?family=Anton&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0a0a;--ink:#f3ece0;--dim:#8a8278;--red:#ef2b2b;--rule:#222}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:14px;line-height:1.6;padding:clamp(24px,5vw,64px)}
  main{max-width:720px;margin:0 auto}
  a{color:var(--red)}
  .kicker{display:inline-block;padding:4px 12px;border:1px solid var(--red);color:var(--red);font-size:11px;letter-spacing:.22em;text-transform:uppercase;margin-bottom:18px}
  h1{font-family:'Anton',sans-serif;font-size:clamp(36px,8vw,72px);text-transform:uppercase;line-height:.95;margin-bottom:20px}
  .lead{margin-bottom:12px}
  .lead b{color:var(--red)}
  .dim{color:var(--dim);font-size:12px;margin-bottom:10px}
  .btn{display:inline-block;margin-top:8px;padding:11px 16px;background:var(--red);color:#0a0a0a;text-decoration:none;text-transform:uppercase;font-size:12px;letter-spacing:.12em}
  .meta{margin-top:32px;padding-top:14px;border-top:1px solid var(--rule);color:var(--dim);font-size:11px}
  footer{margin-top:44px;color:var(--dim);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
</style>
</head>
<body>
<main>
<div class="kicker">${escapeHtml(kickerText)}</div>
<h1>${headline}</h1>
${detail}
<div class="meta">${escapeHtml(track.artist_name)} · submitted ${escapeHtml(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).format(new Date(track.uploaded_at))
  )} · ${Math.floor(track.duration_s / 60)}:${String(track.duration_s % 60).padStart(2, "0")}${track.duration_s > 240 ? " (fades at 4:00 on air)" : ""}
  · this link is private to you</div>
<footer><a href="/" style="color:var(--ink);text-decoration:none">⏺ Crush Radio</a> · one shared broadcast</footer>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function renderTransmissionPage(env, numberRaw, now = Date.now()) {
  const number = parseInt(String(numberRaw).replace(/^t/i, ""), 10);
  if (!Number.isFinite(number)) return notFound();

  let t;
  try {
    t = await env.DB.prepare("SELECT * FROM transmissions WHERE number = ?")
      .bind(number)
      .first();
  } catch {
    t = null;
  }
  if (!t) return notFound();

  const { state } = deriveState(t, now);
  const padded = String(t.number).padStart(3, "0");
  const title = `Transmission ${padded}`;

  // Before the setlist is public, the page exists but holds its tongue.
  if (now < t.setlist_publish_at) {
    return page(t, title, `
      <p class="kicker">Curation in progress</p>
      <h1>${title}</h1>
      <p class="lead">The setlist locks and publishes <b>${escapeHtml(ct(t.setlist_publish_at))}</b>.
      Broadcast is <b>${escapeHtml(ct(t.broadcast_start_at))}</b>.</p>
      <p class="dim">Selected artists get an email at publish. Everyone else: the pool rolls forward.</p>
      <p><a class="btn" href="/">← Back to the station</a></p>
    `);
  }

  const setlist = await hydrateSetlist(env, t);
  let results = [];
  if (now >= t.broadcast_end_at) {
    try {
      const { results: rows } = await env.DB.prepare(
        `SELECT r.track_id, r.status, r.rank, r.crushes, r.unique_listeners, r.crush_rate,
                t.title, a.name AS artist, a.slug
         FROM transmission_results r
         JOIN tracks t ON t.id = r.track_id
         JOIN artists a ON a.id = t.artist_id
         WHERE r.transmission_id = ?
         ORDER BY CASE WHEN r.rank IS NULL THEN 1 ELSE 0 END, r.rank ASC, t.title ASC`
      )
        .bind(t.id)
        .all();
      results = rows || [];
    } catch {
      results = [];
    }
  }

  let body = `<p class="kicker">${
    state === "live"
      ? "● LIVE NOW"
      : now >= t.broadcast_end_at
        ? "Broadcast complete"
        : "Setlist locked"
  }</p>
  <h1>${title}</h1>`;

  if (state === "live") {
    body += `<p class="lead live-link"><a href="/">The transmission is live — tune in on the station →</a></p>`;
  } else if (now < t.broadcast_start_at) {
    body += `<p class="lead">Broadcast <b>${escapeHtml(ct(t.broadcast_start_at))}</b>.
      One shared stream. No skips. <a href="/">Tune in at the station.</a></p>
    <p><a class="btn" href="/transmissions/${padded}.ics">+ Add to calendar</a></p>`;
  }

  if (results.length > 0) {
    const statusLabel = { crushed: "CRUSHED", retired: "Retired", unjudged: "Unjudged" };
    body += `
    <h2>Results</h2>
    <p class="dim">The top third survive. Tracks with too few listeners go back into the pool.</p>
    <table class="results">
      <thead><tr><th>#</th><th>Track</th><th>Crushes</th><th>Listeners</th><th>Rate</th><th>Verdict</th></tr></thead>
      <tbody>
      ${results
        .map(
          (r) => `<tr class="st-${escapeHtml(r.status)}">
        <td>${r.rank ?? "—"}</td>
        <td><span id="${escapeHtml(r.slug)}"></span><b>${escapeHtml(r.artist)}</b> — ${escapeHtml(r.title)}</td>
        <td>${r.crushes}</td>
        <td>${r.unique_listeners}</td>
        <td>${(r.crush_rate * 100).toFixed(0)}%</td>
        <td class="verdict">${statusLabel[r.status] || escapeHtml(r.status)}</td>
      </tr>`
        )
        .join("")}
      </tbody>
    </table>`;
  } else if (setlist.length > 0) {
    body += `
    <h2>The setlist</h2>
    <ol class="setlist">
      ${setlist
        .map(
          (s) => `<li id="${escapeHtml(s.slug)}">
        <span class="pos">${String(s.position).padStart(2, "0")}</span>
        <span class="who"><b>${escapeHtml(s.artist)}</b> — ${escapeHtml(s.title)}${
          s.artist_url
            ? ` <a class="ext" href="${escapeHtml(s.artist_url)}" target="_blank" rel="noopener noreferrer nofollow ugc">artist↗</a>`
            : ""
        }</span>
        <span class="len">${fmtDuration(Math.min(s.duration_s || 0, 240))}</span>
      </li>`
        )
        .join("")}
    </ol>
    <div class="promo">
      <p class="kicker">Selected artist? Spread the signal</p>
      <blockquote>"I'm transmitting on Crush Radio tonight. ${escapeHtml(
        new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "long" }).format(
          new Date(t.broadcast_start_at)
        )
      )} 8pm CT."<br>crushradio.com/transmissions/${padded}#your-artist-slug</blockquote>
      <p class="dim">Your slot deep-links: share this page's URL with <b>#${escapeHtml(
        setlist[0] ? setlist[0].slug : "artist-slug"
      )}</b>-style anchors.</p>
    </div>`;
  } else {
    body += `<p class="lead">Setlist data is unavailable. <a href="/">Back to the station.</a></p>`;
  }

  return page(t, title, body);
}

function notFound() {
  return new Response("No such transmission — try crushradio.com", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function page(t, title, inner) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Crush Radio</title>
<meta name="description" content="Crush Radio ${escapeHtml(title)} — one shared broadcast, ${escapeHtml(ct(t.broadcast_start_at))}.">
<meta property="og:title" content="${escapeHtml(title)} — Crush Radio">
<meta property="og:description" content="One shared broadcast. Tap CRUSHED IT on the tracks worth keeping. The top third survive.">
<meta property="og:type" content="website">
<link rel="canonical" href="https://crushradio.com/transmissions/${String(t.number).padStart(3, "0")}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0a0a;--ink:#f3ece0;--dim:#8a8278;--red:#ef2b2b;--rule:#222}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:14px;line-height:1.6;padding:clamp(24px,5vw,64px)}
  main{max-width:880px;margin:0 auto}
  a{color:var(--red)}
  .kicker{color:var(--dim);font-size:11px;letter-spacing:.22em;text-transform:uppercase;margin-bottom:14px}
  h1{font-family:'Anton',sans-serif;font-size:clamp(44px,9vw,96px);text-transform:uppercase;color:var(--red);line-height:.9;margin-bottom:24px}
  h2{font-family:'Anton',sans-serif;font-size:28px;text-transform:uppercase;margin:40px 0 12px}
  .lead{max-width:64ch;margin-bottom:12px}
  .lead b{color:var(--red)}
  .dim{color:var(--dim);font-size:12px;margin-bottom:8px}
  .btn{display:inline-block;margin-top:18px;padding:12px 18px;border:1px solid var(--rule);color:var(--ink);text-decoration:none;text-transform:uppercase;font-size:12px;letter-spacing:.14em}
  .btn:hover{border-color:var(--red)}
  ol.setlist{list-style:none;border:1px solid var(--rule);margin-top:10px}
  ol.setlist li{display:flex;gap:16px;align-items:baseline;padding:13px 18px;border-bottom:1px solid var(--rule)}
  ol.setlist li:last-child{border-bottom:0}
  ol.setlist li:target{background:rgba(239,43,43,.12);outline:1px solid var(--red)}
  .ext{font-size:11px;letter-spacing:.04em}
  .pos{color:var(--red);font-weight:700}
  .who{flex:1;min-width:0}
  .len{color:var(--dim);font-size:12px}
  .promo{margin-top:28px;border:1px dashed var(--rule);padding:18px}
  .promo blockquote{margin:8px 0 12px;color:var(--ink);font-size:15px;user-select:all}
  table.results{width:100%;border-collapse:collapse;border:1px solid var(--rule);margin-top:10px}
  table.results th,table.results td{padding:11px 12px;border-bottom:1px solid var(--rule);text-align:left;font-size:13px}
  table.results th{color:var(--dim);font-size:10px;letter-spacing:.18em;text-transform:uppercase}
  tr.st-crushed .verdict{color:var(--red);font-weight:700}
  tr.st-retired .verdict,tr.st-unjudged .verdict{color:var(--dim)}
  .live-link a{font-weight:700}
  footer{margin-top:56px;color:var(--dim);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
</style>
</head>
<body>
<main>
${inner}
<footer><a href="/" style="color:var(--ink);text-decoration:none">⏺ Crush Radio</a> · one shared broadcast · MIT licensed</footer>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=60",
      "x-content-type-options": "nosniff",
    },
  });
}
