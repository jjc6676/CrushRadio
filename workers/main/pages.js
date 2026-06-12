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

// --- Shared chrome for static prose pages (/about, /copyright) ---

function pageShell(title, description, innerHtml) {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Crush Radio</title>
<meta name="description" content="${escapeHtml(description)}">
<meta property="og:title" content="${escapeHtml(title)} — Crush Radio">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:type" content="website">
<link rel="canonical" href="https://crushradio.com/${escapeHtml(title.toLowerCase())}">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0a0a;--ink:#f3ece0;--dim:#8a8278;--red:#ef2b2b;--rule:#222}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:'JetBrains Mono',ui-monospace,monospace;font-size:14px;line-height:1.65;padding:clamp(24px,5vw,64px)}
  main{max-width:760px;margin:0 auto}
  a{color:var(--red)}
  .top{display:flex;align-items:center;gap:10px;margin-bottom:36px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim)}
  .top a{color:var(--ink);text-decoration:none}
  .top .mark{width:11px;height:11px;background:var(--red);border-radius:50%;display:inline-block}
  h1{font-family:'Anton',sans-serif;font-size:clamp(40px,8vw,80px);text-transform:uppercase;color:var(--red);line-height:.92;margin-bottom:8px}
  .lede{font-size:clamp(15px,1.6vw,18px);color:var(--ink);margin:14px 0 8px;max-width:60ch}
  h2{font-family:'Anton',sans-serif;font-size:26px;text-transform:uppercase;margin:40px 0 12px;letter-spacing:.01em}
  h3{font-size:13px;text-transform:uppercase;letter-spacing:.16em;color:var(--dim);margin:24px 0 8px}
  p{margin:0 0 14px;max-width:66ch}
  b,strong{color:var(--red)}
  ul,ol{margin:0 0 16px;padding-left:22px}
  li{margin:0 0 8px;max-width:64ch}
  blockquote{margin:16px 0;padding:12px 18px;border-left:2px solid var(--red);color:var(--ink)}
  .cycle{width:100%;border-collapse:collapse;border:1px solid var(--rule);margin:16px 0;font-size:13px}
  .cycle th,.cycle td{padding:10px 12px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}
  .cycle th{color:var(--dim);font-size:10px;letter-spacing:.16em;text-transform:uppercase}
  .cycle td:first-child{white-space:nowrap;color:var(--red)}
  .attest{border:1px dashed var(--red);padding:14px 18px;margin:16px 0;color:var(--ink);user-select:all}
  footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);color:var(--dim);font-size:11px;letter-spacing:.12em;text-transform:uppercase;display:flex;gap:18px;flex-wrap:wrap}
  footer a{color:var(--ink);text-decoration:none}
</style>
</head>
<body>
<main>
<div class="top"><a href="/"><span class="mark"></span> Crush Radio</a> · ${escapeHtml(title)}</div>
${innerHtml}
<footer>
  <a href="/">← Station</a>
  <a href="/about">About</a>
  <a href="/copyright">Copyright</a>
  <a href="https://github.com/jjc6676/crushradio" rel="noopener">GitHub</a>
  <a href="mailto:hello@crushradio.com">Contact</a>
</footer>
</main>
</body>
</html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

export function renderAboutPage() {
  return pageShell(
    "About",
    "Crush Radio is open-source community radio run as weekly live transmissions. Artists upload originals, everyone hears one shared broadcast, and the tracks listeners love survive.",
    `
    <h1>About</h1>
    <p class="lede">Crush Radio is open-source community radio for songs algorithms would bury — run as <b>weekly live transmissions</b>, not 24/7 background noise.</p>

    <p>Each week a curated setlist of original tracks airs as <b>one shared broadcast</b>. Everyone hears the same song at the same moment. Listeners tap CRUSHED IT on what's worth keeping. The top third survive into the <a href="/#hall-root">Hall of Crush</a>. The rest disappear. Between transmissions, the station goes dark.</p>

    <blockquote>Built by the people who'd actually listen. Voted on by the people actually listening.</blockquote>

    <h2>Three rules</h2>
    <ol>
      <li><b>One shared broadcast.</b> Every listener hears the same track at the same moment. No personalized streams, no skip button. Tuning in means tuning in <em>with</em> people.</li>
      <li><b>Positive-only voting.</b> You tap CRUSHED IT on what you love; silence retires the rest. Tracks earn their place or they're gone. There is no downvote.</li>
      <li><b>Built in public.</b> No labels, no algorithm, no closed doors. Every change is a pull request; every decision is in an issue or a commit message.</li>
    </ol>

    <h2>The weekly cycle</h2>
    <p>All times Central. Submissions are free, originals only, one track per artist per window.</p>
    <table class="cycle">
      <tr><th>When</th><th>What's happening</th></tr>
      <tr><td>Mon 12pm → Thu 8pm</td><td><b>Submissions open.</b> Artists upload original tracks. A live counter shows the pool filling.</td></tr>
      <tr><td>Thu 8pm → Fri 12pm</td><td><b>Curation.</b> 20–25 tracks are hand-picked. The setlist locks Friday noon.</td></tr>
      <tr><td>Fri 12pm → Fri 8pm</td><td><b>Setlist published.</b> Selected artists get a shareable promo link. The site shows the lineup and counts down.</td></tr>
      <tr><td>Fri 8pm → ~10pm</td><td><b>Live transmission.</b> Everyone tunes into the same broadcast. CRUSHED IT on the player. The Hall counter ticks up live.</td></tr>
      <tr><td>Fri 10pm → Sat 12pm</td><td><b>Results &amp; replay.</b> Final tallies posted; on-demand replay with voting closed.</td></tr>
      <tr><td>Sat 12pm → Mon 12pm</td><td><b>Dark.</b> A countdown to the next window. The Hall of Crush is the only thing still lit.</td></tr>
    </table>

    <h2>How a track is judged</h2>
    <p>The top third survive. A track that too few people heard isn't retired — it's <b>unjudged</b>, and the artist can resubmit. Survival is ranked by crush rate among the people who were actually listening, so a track loved by a full room beats a lucky spike in an empty one, and bringing your real fans only helps.</p>
    <blockquote>Early transmissions are hand-curated to establish signal. As the community grows, the protocol opens.<br>If nobody shows up live, the track has not truly been judged.</blockquote>

    <h2>What this is not</h2>
    <ul>
      <li><b>Not 24/7.</b> Going dark between transmissions is the point — the broadcast is an event, not a faucet.</li>
      <li><b>Not for covers or rips.</b> Originals only. You must own what you submit.</li>
      <li><b>No accounts.</b> Voting is anonymous; artists are identified by a private link, not a login.</li>
      <li><b>No pay-to-play.</b> Money never touches the submission queue. Donations cover the (small) hosting bill, nothing more.</li>
    </ul>

    <h2>Get involved</h2>
    <p>Artists: submit when the window is open. Listeners: <a href="/">tune in Friday</a> and add the next broadcast to your calendar. Builders: it's <a href="https://github.com/jjc6676/crushradio" rel="noopener">all on GitHub</a> — open a PR or an issue with anything. Rights questions and takedowns: see <a href="/copyright">copyright</a>.</p>
    `
  );
}

export function renderCopyrightPage() {
  return pageShell(
    "Copyright",
    "Crush Radio is originals-only. Submitting requires you own the recording. How rights, AI disclosure, takedowns, and repeat infringement are handled.",
    `
    <h1>Copyright</h1>
    <p class="lede">Crush Radio airs <b>original music only</b>. Submitting a track requires that you own it. This page covers the rights you grant, AI disclosure, and how to report or remove infringing material.</p>

    <h2>The attestation</h2>
    <p>Every upload requires you to affirm, in these exact words:</p>
    <div class="attest">"I own this recording or have the rights to submit it."</div>
    <p>No attestation, no upload. By submitting you confirm you hold the rights to both the composition and the master, that the track contains no uncleared samples, and that you grant Crush Radio a non-exclusive, royalty-free license to broadcast it during a transmission and to keep it streaming in the Hall of Crush if it survives.</p>

    <h2>AI disclosure</h2>
    <p>At upload you declare whether the track is human-made, human-made with AI assistance, or fully AI-generated. Misrepresenting this is grounds for removal. Disclosure is about honesty with listeners, not exclusion — but undisclosed AI passed off as human work will be pulled.</p>

    <h2>Reporting infringement (takedown)</h2>
    <p>If you believe a track on Crush Radio infringes your copyright, email <a href="mailto:hello@crushradio.com">hello@crushradio.com</a> with:</p>
    <ul>
      <li>The track and transmission (a link to the setlist or Hall entry).</li>
      <li>Identification of the work you say it infringes.</li>
      <li>Your contact information.</li>
      <li>A statement, under penalty of perjury, that you have a good-faith belief the use is unauthorized and that you are the rights holder or authorized to act for them.</li>
      <li>Your physical or electronic signature.</li>
    </ul>
    <p>Valid notices are acted on promptly — a flagged or infringing track is removed from any pending setlist and from the Hall. Reports can be filed at any time, in any state of the cycle; they are never gated by the broadcast schedule.</p>

    <h3>Designated agent</h3>
    <p>Send formal DMCA notices to the designated agent at <a href="mailto:hello@crushradio.com">hello@crushradio.com</a>. (A registered DMCA agent on file with the U.S. Copyright Office will be listed here once registration is complete.)</p>

    <h2>Counter-notice</h2>
    <p>If your track was removed and you believe that was a mistake or misidentification, reply to the removal notice with a counter-notice: identify the track, state under penalty of perjury that you have a good-faith belief it was removed in error, and consent to jurisdiction. Validly counter-noticed material may be restored.</p>

    <h2>Repeat infringers</h2>
    <p>Accounts are by email. An artist who submits infringing material twice is barred from future submissions. A single confirmed commercial rip is enough to bar immediately. This policy is enforced, not decorative.</p>

    <h2>The station's own license</h2>
    <p>Crush Radio's <b>code</b> is MIT-licensed — fork it, run your own station. Artists retain all rights to their <b>music</b>; the only license you grant is the non-exclusive broadcast/archive license above, and you can request removal of your own track at any time.</p>
    `
  );
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
