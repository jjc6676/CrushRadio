// Crush Radio — Owner Studio
// Token-gated curation console at /studio?key=<config:owner_token>.
// Replaces the runbook SQL for the weekly cycle: audition the pool,
// select and order tracks, lock the setlist, work the notification
// outbox, watch certification. The token is the only auth — single
// owner by design, no accounts.

import {
  json,
  requireOwner,
  getStation,
  hydrateSetlist,
  lockSetlist,
} from "./api.js";
import { pendingNotifications, withheldCount } from "./notify.js";
import { escapeHtml } from "./pages.js";

const CT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function ct(ms) {
  return CT.format(new Date(ms));
}

// --- POST /api/studio/:action ---

export async function handleStudioApi(request, env, action) {
  if (!(await requireOwner(request, env))) {
    return json({ error: "Bad or missing studio key." }, 401);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    // Several actions take no body.
  }
  const now = Date.now();
  const station = await getStation(env, now);
  const t = station.transmission;

  if (action === "curate") {
    const trackId = String(body.track_id || "");
    if (!trackId) return json({ error: "track_id required." }, 400);
    if (t && t.setlist_json) return json({ error: "Setlist is locked — unlock first (pre-publish only)." }, 409);
    const track = await env.DB.prepare(
      "SELECT id, track_status FROM tracks WHERE id = ?"
    ).bind(trackId).first();
    if (!track) return json({ error: "Unknown track." }, 404);
    if (!["held", "selected"].includes(track.track_status)) {
      return json({ error: `Track is ${track.track_status} — only held/selected tracks can be curated.` }, 409);
    }
    const updates = [];
    if (typeof body.selected === "boolean") {
      updates.push(
        env.DB
          .prepare("UPDATE tracks SET track_status = ? WHERE id = ?")
          .bind(body.selected ? "selected" : "held", trackId)
      );
    }
    if (body.position !== undefined) {
      const pos = body.position === null ? null : parseInt(body.position, 10);
      if (pos !== null && (!Number.isFinite(pos) || pos < 1 || pos > 99)) {
        return json({ error: "Position must be 1–99." }, 400);
      }
      updates.push(
        env.DB
          .prepare("UPDATE tracks SET curation_position = ? WHERE id = ?")
          .bind(pos, trackId)
      );
    }
    if (updates.length) await env.DB.batch(updates);
    return json({ ok: true });
  }

  if (action === "lock") {
    if (!t) return json({ error: "No transmission scheduled." }, 409);
    const result = await lockSetlist(env, t.id, now);
    return json(result, result.error ? 409 : 200);
  }

  if (action === "unlock") {
    if (!t) return json({ error: "No transmission scheduled." }, 409);
    if (now >= t.setlist_publish_at) {
      return json({ error: "Setlist is public — no unlocking after publish. Use emergency remove for rights/abuse/tech failures." }, 409);
    }
    await env.DB.batch([
      env.DB
        .prepare("UPDATE transmissions SET setlist_json = NULL, updated_at = ? WHERE id = ?")
        .bind(now, t.id),
      env.DB
        .prepare(
          "DELETE FROM notifications WHERE transmission_id = ? AND sent_at IS NULL AND kind IN ('artist_selected','artist_held')"
        )
        .bind(t.id),
    ]);
    return json({ ok: true });
  }

  if (action === "remove") {
    // Emergency post-lock removal: rights violation, abuse, or technical
    // failure only. The track returns to held, never retired.
    const trackId = String(body.track_id || "");
    if (!t || !t.setlist_json) return json({ error: "No locked setlist." }, 409);
    if (now >= t.broadcast_end_at) return json({ error: "Broadcast is over." }, 409);
    let setlist;
    try {
      setlist = JSON.parse(t.setlist_json);
    } catch {
      return json({ error: "Corrupt setlist_json." }, 500);
    }
    if (!setlist.some((s) => s.track_id === trackId)) {
      return json({ error: "Track is not on the setlist." }, 404);
    }
    const pruned = setlist
      .filter((s) => s.track_id !== trackId)
      .map((s, i) => ({ position: i + 1, track_id: s.track_id }));
    await env.DB.batch([
      env.DB
        .prepare("UPDATE transmissions SET setlist_json = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(pruned), now, t.id),
      env.DB
        .prepare("UPDATE tracks SET track_status = 'held' WHERE id = ?")
        .bind(trackId),
    ]);
    // If we're mid-broadcast, push the pruned setlist to the Rotator now so
    // the removal takes effect in seconds instead of waiting for the cron.
    if (now >= t.broadcast_start_at && now < t.broadcast_end_at) {
      try {
        const setlistFull = await hydrateSetlist(env, { ...t, setlist_json: JSON.stringify(pruned) });
        const id = env.ROTATOR.idFromName("global");
        await env.ROTATOR.get(id).fetch("https://rotator.internal/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            transmission_id: t.id,
            broadcast_start_at: t.broadcast_start_at,
            broadcast_end_at: t.broadcast_end_at,
            setlist: setlistFull,
          }),
        });
      } catch {
        // The cron's ensureRotatorConducting re-kicks within a minute anyway.
      }
    }
    return json({ ok: true, setlist: pruned });
  }

  if (action === "notify") {
    // Mark a notification handled after sending it manually via mailto.
    const id = String(body.id || "");
    if (!id) return json({ error: "id required." }, 400);
    await env.DB.prepare(
      "UPDATE notifications SET sent_at = ?, channel = 'manual' WHERE id = ? AND sent_at IS NULL"
    )
      .bind(now, id)
      .run();
    return json({ ok: true });
  }

  return json({ error: "No such studio action." }, 404);
}

// --- GET /studio ---

export async function renderStudioPage(request, env) {
  if (!(await requireOwner(request, env))) {
    return new Response(
      "401 — studio key required. Open /studio?key=<owner token>.\n" +
        "The token lives in KV under config:owner_token.",
      { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } }
    );
  }

  const now = Date.now();
  const station = await getStation(env, now);
  const t = station.transmission;
  const key = new URL(request.url).searchParams.get("key");

  // Pool: everything curate-able, selected first.
  let pool = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT t.id, t.title, t.duration_s, t.track_status, t.curation_position,
              t.rollover_count, t.flag_count, t.uploaded_at, t.artist_url,
              t.access_token, t.ai_disclosure, a.name AS artist, a.email
       FROM tracks t JOIN artists a ON a.id = t.artist_id
       WHERE t.track_status IN ('held','selected')
       ORDER BY CASE t.track_status WHEN 'selected' THEN 0 ELSE 1 END,
                COALESCE(t.curation_position, 9999), t.uploaded_at`
    ).all();
    pool = results || [];
  } catch {}

  const setlist = t && t.setlist_json ? await hydrateSetlist(env, t) : [];
  const pending = await pendingNotifications(env, 100, now); // releasable only
  const withheld = await withheldCount(env, now); // selected/held, hold until publish
  const resendConfigured = !!(await env.KV.get("config:resend_key"));

  let results = [];
  if (t && now >= t.broadcast_end_at) {
    try {
      const { results: rows } = await env.DB.prepare(
        `SELECT r.*, tr.title, a.name AS artist
         FROM transmission_results r
         JOIN tracks tr ON tr.id = r.track_id
         JOIN artists a ON a.id = tr.artist_id
         WHERE r.transmission_id = ?
         ORDER BY CASE WHEN r.rank IS NULL THEN 1 ELSE 0 END, r.rank`
      )
        .bind(t.id)
        .all();
      results = rows || [];
    } catch {}
  }

  const selectedCount = pool.filter((p) => p.track_status === "selected").length;
  const locked = !!(t && t.setlist_json);

  const scheduleRows = t
    ? [
        ["Submissions open", t.submission_open_at],
        ["Submissions close", t.submission_close_at],
        ["Setlist publishes (auto-lock)", t.setlist_publish_at],
        ["Broadcast", t.broadcast_start_at],
        ["Broadcast ends (certification)", t.broadcast_end_at],
        ["Replay closes", t.replay_close_at],
      ]
        .map(
          ([label, ms]) =>
            `<tr class="${ms < now ? "past" : ""}"><td>${escapeHtml(label)}</td><td>${escapeHtml(ct(ms))}</td></tr>`
        )
        .join("")
    : "";

  const poolRows = pool
    .map((p) => {
      const sel = p.track_status === "selected";
      return `<tr data-track="${escapeHtml(p.id)}" class="${sel ? "sel" : ""}">
      <td><input type="checkbox" class="curate-sel" ${sel ? "checked" : ""} ${locked ? "disabled" : ""}></td>
      <td><input type="number" class="curate-pos" min="1" max="99" value="${p.curation_position ?? ""}" ${locked ? "disabled" : ""}></td>
      <td class="who"><b>${escapeHtml(p.artist)}</b> — ${escapeHtml(p.title)}
        ${p.artist_url ? `<a class="ext" href="${escapeHtml(p.artist_url)}" target="_blank" rel="noopener noreferrer nofollow">link↗</a>` : `<span class="flagged">no artist link</span>`}
        ${p.ai_disclosure && p.ai_disclosure !== "human" ? `<span class="flagged">${escapeHtml(p.ai_disclosure.replace("_", " "))}</span>` : ""}
        ${p.flag_count > 0 ? `<span class="flagged">⚑ ${p.flag_count} flag${p.flag_count === 1 ? "" : "s"}</span>` : ""}
        ${p.rollover_count > 0 ? `<span class="roll">rollover ×${p.rollover_count}</span>` : ""}
      </td>
      <td>${Math.floor(p.duration_s / 60)}:${String(p.duration_s % 60).padStart(2, "0")}${p.duration_s > 240 ? " <span class='roll'>fades 4:00</span>" : ""}</td>
      <td><audio controls preload="none" src="/audio/${escapeHtml(p.id)}?key=${encodeURIComponent(key)}"></audio></td>
      <td><a href="/track/${escapeHtml(p.id)}/${escapeHtml(p.access_token || "")}" target="_blank" rel="noreferrer">status</a></td>
    </tr>`;
    })
    .join("");

  const setlistRows = setlist
    .map(
      (s) => `<tr>
      <td>${String(s.position).padStart(2, "0")}</td>
      <td><b>${escapeHtml(s.artist)}</b> — ${escapeHtml(s.title)}</td>
      <td>${Math.floor(s.counted_s / 60)}:${String(s.counted_s % 60).padStart(2, "0")}</td>
      <td><button class="btn danger emergency-remove" data-track="${escapeHtml(s.track_id)}">remove (rights/abuse/tech only)</button></td>
    </tr>`
    )
    .join("");

  const outboxRows = pending
    .map((n) => {
      const mailto = `mailto:${encodeURIComponent(n.email)}?subject=${encodeURIComponent(n.subject)}&body=${encodeURIComponent(n.body)}`;
      return `<tr>
      <td>${escapeHtml(n.kind.replace(/_/g, " "))}</td>
      <td>${escapeHtml(n.email)}</td>
      <td class="who">${escapeHtml(n.subject)}</td>
      <td><a class="btn" href="${mailto}">open email</a></td>
      <td><button class="btn mark-sent" data-id="${escapeHtml(n.id)}">mark sent</button></td>
    </tr>`;
    })
    .join("");

  const resultRows = results
    .map(
      (r) => `<tr class="st-${escapeHtml(r.status)}">
      <td>${r.rank ?? "—"}</td>
      <td><b>${escapeHtml(r.artist)}</b> — ${escapeHtml(r.title)}</td>
      <td>${r.crushes}</td><td>${r.unique_listeners}</td>
      <td>${Math.round(r.crush_rate * 100)}%</td>
      <td class="verdict">${escapeHtml(r.status)}</td>
    </tr>`
    )
    .join("");

  const totalSeconds = setlist.reduce((acc, s) => acc + s.counted_s, 0);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Studio — Crush Radio</title>
<style>
  :root{--bg:#0a0a0a;--ink:#f3ece0;--dim:#8a8278;--red:#ef2b2b;--rule:#222}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:ui-monospace,monospace;font-size:13px;line-height:1.5;padding:clamp(16px,3vw,40px)}
  h1{font-size:22px;text-transform:uppercase;letter-spacing:.06em;color:var(--red);margin-bottom:4px}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.18em;color:var(--dim);margin:32px 0 10px}
  a{color:var(--red)}
  table{width:100%;border-collapse:collapse;border:1px solid var(--rule)}
  td,th{padding:8px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:middle}
  tr.past td{color:var(--dim)}
  tr.sel{background:rgba(239,43,43,.07)}
  .who{max-width:420px}
  .state{display:inline-block;padding:4px 10px;border:1px solid var(--red);color:var(--red);text-transform:uppercase;letter-spacing:.14em;font-size:11px;margin:8px 0 4px}
  .btn{display:inline-block;padding:6px 12px;background:var(--red);color:#0a0a0a;border:0;cursor:pointer;font-family:inherit;font-size:11px;text-transform:uppercase;letter-spacing:.1em;text-decoration:none}
  .btn:disabled{background:#3a3a3a;color:#777;cursor:not-allowed}
  .btn.danger{background:transparent;border:1px solid var(--red);color:var(--red)}
  .btn.big{font-size:13px;padding:10px 18px}
  .curate-pos{width:52px;background:#0f0f0f;border:1px solid var(--rule);color:var(--ink);padding:4px;font-family:inherit}
  .curate-sel{accent-color:var(--red);width:16px;height:16px}
  audio{height:30px;max-width:240px}
  .flagged{color:var(--red);font-size:11px;margin-left:8px}
  .roll{color:var(--dim);font-size:11px;margin-left:8px}
  .ext{font-size:11px;margin-left:8px}
  .bar{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin:14px 0}
  .dim{color:var(--dim)}
  .ok{color:#7dc97d}
  tr.st-crushed .verdict{color:var(--red);font-weight:700}
  #toast{position:fixed;bottom:16px;right:16px;background:#181818;border:1px solid var(--rule);padding:10px 14px;display:none}
</style>
</head>
<body data-key="${escapeHtml(key || "")}">
<h1>⏺ Studio</h1>
<div class="dim">Owner console — this URL is the key. Don't share it, don't screenshot it.</div>
<div class="state">${escapeHtml(station.state.replace(/_/g, " "))}${t ? " · " + escapeHtml(t.id) : ""}</div>

${t ? `<h2>Schedule</h2><table>${scheduleRows}</table>` : `<h2>No transmission scheduled</h2><div class="dim">Run: npm run tx:schedule (see the runbook).</div>`}

<h2>Pool — ${pool.length} track${pool.length === 1 ? "" : "s"}, ${selectedCount} selected${locked ? " · LOCKED" : ""}</h2>
<div class="bar">
  ${locked
    ? `<button class="btn big" id="unlock" ${t && now >= t.setlist_publish_at ? "disabled title='public — emergency remove only'" : ""}>Unlock setlist</button>`
    : `<button class="btn big" id="lock" ${selectedCount === 0 ? "disabled" : ""}>Lock setlist (${selectedCount})</button>`}
  <span class="dim">Target 20–25. Lock happens automatically at setlist publish if you forget — selected tracks, your order, upload order for ties.</span>
</div>
${pool.length ? `<table>
  <tr><th>sel</th><th>#</th><th>track</th><th>len</th><th>listen</th><th></th></tr>
  ${poolRows}
</table>` : `<div class="dim">Pool is empty. It fills while submissions are open.</div>`}

${locked ? `<h2>Locked setlist — ${setlist.length} tracks · ~${Math.round(totalSeconds / 60)} min of music</h2>
<table><tr><th>#</th><th>track</th><th>counted</th><th></th></tr>${setlistRows}</table>` : ""}

<h2>Notification outbox — ${pending.length} ready · delivery: ${resendConfigured ? '<span class="ok">Resend auto-send ON</span>' : 'manual (set config:resend_key in KV to automate)'}</h2>
${withheld > 0 ? `<div class="dim">${withheld} selected/held email${withheld === 1 ? "" : "s"} composed and holding until the setlist publishes — the artist email and the public reveal drop together.</div>` : ""}
${pending.length ? `<table><tr><th>kind</th><th>to</th><th>subject</th><th></th><th></th></tr>${outboxRows}</table>`
  : `<div class="dim">Nothing ready to send. Selected/held emails hold until publish; results emails queue at certification.</div>`}

${results.length ? `<h2>Certified results</h2>
<table><tr><th>#</th><th>track</th><th>crushes</th><th>listeners</th><th>rate</th><th>verdict</th></tr>${resultRows}</table>` : ""}

<div id="toast"></div>
<script src="/assets/studio.js" defer></script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy":
        "default-src 'self'; style-src 'unsafe-inline'; script-src 'self'; media-src 'self'; img-src 'self' data:",
    },
  });
}
