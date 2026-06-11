// Crush Radio — API routes
// Every write route is gated on the derived station state:
//   POST /api/upload → 200 only when submissions_open, else 410 Gone
//   POST /api/vote   → 200 only when live,             else 410 Gone
//   POST /api/flag   → 200 in any state (abuse/rights reports never stop)

import {
  deriveState,
  pickActiveTransmission,
  parseSetlist,
  setlistVisible,
  MAX_COUNTED_SECONDS,
} from "./state.js";

const ATTESTATION_TEXT =
  "I own this recording or have the rights to submit it.";

const UPLOAD_LIMITS = {
  maxBytes: 50 * 1024 * 1024, // 50 MB
  minDurationS: 30,
  maxDurationS: 900, // 15 min hard cap at upload; fades at 4:00 on air
  perHour: 3, // uploads per fingerprint per hour
  extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg"],
};

const FLAG_LIMIT_PER_HOUR = 5;

// --- Shared helpers ---

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export async function fingerprint(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const ua = request.headers.get("User-Agent") || "unknown";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ip}|${ua}`)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The transmissions table may not exist yet on a database that hasn't run
// the migration — treat that exactly like "no transmission scheduled".
export async function getTransmissions(env) {
  try {
    const { results } = await env.DB.prepare(
      "SELECT * FROM transmissions ORDER BY submission_open_at ASC"
    ).all();
    return results || [];
  } catch {
    return [];
  }
}

export async function getStation(env, now = Date.now()) {
  const rows = await getTransmissions(env);
  const active = pickActiveTransmission(rows, now);
  return { transmission: active, ...deriveState(active, now) };
}

// setlist_json stores only the curated order (position + track_id); titles,
// artists, and durations are joined from D1 so they are always current.
export async function hydrateSetlist(env, t) {
  const entries = parseSetlist(t);
  if (entries.length === 0) return [];

  const ids = entries.map((e) => e.track_id);
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT t.id, t.title, t.duration_s, a.name AS artist, a.slug
     FROM tracks t JOIN artists a ON a.id = t.artist_id
     WHERE t.id IN (${placeholders})`
  )
    .bind(...ids)
    .all();
  const byId = new Map((results || []).map((r) => [r.id, r]));

  return entries
    .map((e, i) => {
      const row = byId.get(e.track_id);
      if (!row) return null;
      return {
        track_id: row.id,
        title: row.title,
        artist: row.artist,
        slug: row.slug,
        position: e.position || i + 1,
        duration_s: row.duration_s,
        counted_s: Math.min(row.duration_s, MAX_COUNTED_SECONDS),
      };
    })
    .filter(Boolean);
}

async function rateLimit(env, key, max, ttlSeconds) {
  const count = parseInt((await env.KV.get(key)) || "0", 10);
  if (count >= max) return false;
  await env.KV.put(key, String(count + 1), { expirationTtl: ttlSeconds });
  return true;
}

function slugify(name) {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "artist"
  );
}

// --- GET /api/state ---

export async function handleState(env, now = Date.now()) {
  const station = await getStation(env, now);
  const payload = {
    state: station.state,
    transmission_id: station.transmission_id,
    next_transition_at_utc_ms: station.next_transition_at_utc_ms,
    server_now_utc_ms: now,
  };
  if (station.state === "submissions_open") {
    try {
      const row = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM tracks WHERE track_status = 'held' AND uploaded_at >= ?"
      )
        .bind(station.transmission.submission_open_at)
        .first();
      payload.submission_count = row ? row.n : 0;
    } catch {
      payload.submission_count = 0;
    }
  }
  return json(payload, 200, { "cache-control": "no-store" });
}

// --- POST /api/upload ---

export async function handleUpload(request, env) {
  const now = Date.now();
  const station = await getStation(env, now);
  if (station.state !== "submissions_open") {
    return json(
      {
        error: "Submissions are closed.",
        state: station.state,
        next_transition_at_utc_ms: station.next_transition_at_utc_ms,
      },
      410
    );
  }

  const declared = parseInt(request.headers.get("content-length") || "0", 10);
  if (declared > UPLOAD_LIMITS.maxBytes + 1024 * 1024) {
    return json({ error: "File too large. 50 MB max." }, 413);
  }

  let form;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data." }, 400);
  }

  const artistName = String(form.get("artist_name") || "").trim();
  const email = String(form.get("email") || "").trim();
  const title = String(form.get("title") || "").trim();
  const durationS = parseInt(form.get("duration_s"), 10);
  const attestation = String(form.get("attestation") || "").toLowerCase();
  const file = form.get("file");

  if (!["on", "true", "yes", "1"].includes(attestation)) {
    // No attestation, no upload.
    return json({ error: `Attestation required: "${ATTESTATION_TEXT}"` }, 400);
  }
  if (!artistName || artistName.length > 80) {
    return json({ error: "Artist name required (80 chars max)." }, 400);
  }
  if (!title || title.length > 120) {
    return json({ error: "Track title required (120 chars max)." }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "A valid email is required — it's how we tell you if you made the setlist." }, 400);
  }
  if (!Number.isFinite(durationS) || durationS < UPLOAD_LIMITS.minDurationS || durationS > UPLOAD_LIMITS.maxDurationS) {
    return json({ error: "Track must be between 30 seconds and 15 minutes." }, 400);
  }
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: "Audio file required." }, 400);
  }
  if (file.size > UPLOAD_LIMITS.maxBytes) {
    return json({ error: "File too large. 50 MB max." }, 413);
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!UPLOAD_LIMITS.extensions.includes(ext)) {
    return json({ error: `Unsupported format. Use: ${UPLOAD_LIMITS.extensions.join(", ")}.` }, 400);
  }

  const fp = await fingerprint(request);
  if (!(await rateLimit(env, `rl:upload:${fp}`, UPLOAD_LIMITS.perHour, 3600))) {
    return json({ error: "Upload limit reached — try again in an hour." }, 429);
  }

  // Find or create the artist (keyed by email).
  let artist = await env.DB.prepare("SELECT * FROM artists WHERE email = ?")
    .bind(email)
    .first();
  if (!artist) {
    const id = crypto.randomUUID();
    let slug = slugify(artistName);
    const taken = await env.DB.prepare("SELECT 1 FROM artists WHERE slug = ?").bind(slug).first();
    if (taken) slug = `${slug}-${id.slice(0, 4)}`;
    await env.DB.prepare(
      "INSERT INTO artists (id, slug, name, email, created_at) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, slug, artistName, email, now)
      .run();
    artist = { id, slug, name: artistName };
  }

  const trackId = crypto.randomUUID();
  const key = `tracks/${trackId}.${ext}`;
  await env.AUDIO.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
  });

  await env.DB.prepare(
    `INSERT INTO tracks
     (id, artist_id, title, filename, duration_s, status, track_status, uploaded_at)
     VALUES (?, ?, ?, ?, ?, 'held', 'held', ?)`
  )
    .bind(trackId, artist.id, title, key, durationS, now)
    .run();

  return json({
    ok: true,
    track_id: trackId,
    message: `"${title}" is in the pool for ${station.transmission_id}. Setlist drops Friday noon CT — watch your inbox.`,
  });
}

// --- POST /api/vote ---

export async function handleVote(request, env) {
  const now = Date.now();
  const station = await getStation(env, now);
  if (station.state !== "live") {
    return json({ error: "Voting is only open during the live transmission.", state: station.state }, 410);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON body with track_id." }, 400);
  }
  const trackId = String(body.track_id || "");
  const setlist = parseSetlist(station.transmission);
  if (!setlist.some((s) => s.track_id === trackId)) {
    return json({ error: "That track is not on tonight's setlist." }, 400);
  }

  const fp = await fingerprint(request);
  const dedupKey = `vote:${station.transmission_id}:${trackId}:${fp}`;
  const crushes = async () => {
    const row = await env.DB.prepare("SELECT crushed_it FROM tracks WHERE id = ?").bind(trackId).first();
    return row ? row.crushed_it : 0;
  };

  if (await env.KV.get(dedupKey)) {
    return json({ ok: true, duplicate: true, crushes: await crushes() });
  }
  await env.KV.put(dedupKey, "1", { expirationTtl: 7 * 24 * 3600 });

  await env.DB.batch([
    env.DB
      .prepare("INSERT INTO votes (track_id, vote, fingerprint, voted_at) VALUES (?, 'crushed_it', ?, ?)")
      .bind(trackId, fp, now),
    env.DB.prepare("UPDATE tracks SET crushed_it = crushed_it + 1 WHERE id = ?").bind(trackId),
  ]);

  return json({ ok: true, duplicate: false, crushes: await crushes() });
}

// --- GET /api/votes?track_id= (live counter polling) ---

export async function handleVoteCount(url, env) {
  const trackId = url.searchParams.get("track_id") || "";
  const row = await env.DB.prepare("SELECT crushed_it FROM tracks WHERE id = ?").bind(trackId).first();
  if (!row) return json({ error: "Unknown track." }, 404);
  return json({ track_id: trackId, crushes: row.crushed_it }, 200, {
    "cache-control": "public, max-age=10",
  });
}

// --- POST /api/flag ---

export async function handleFlag(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON body with track_id and reason." }, 400);
  }
  const trackId = String(body.track_id || "");
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!trackId || !reason) {
    return json({ error: "track_id and reason are required." }, 400);
  }
  const track = await env.DB.prepare("SELECT id FROM tracks WHERE id = ?").bind(trackId).first();
  if (!track) return json({ error: "Unknown track." }, 404);

  const fp = await fingerprint(request);
  if (!(await rateLimit(env, `rl:flag:${fp}`, FLAG_LIMIT_PER_HOUR, 3600))) {
    return json({ error: "Flag limit reached — try again in an hour." }, 429);
  }

  await env.DB.batch([
    env.DB.prepare("INSERT INTO flags (track_id, reason, flagged_at) VALUES (?, ?, ?)").bind(trackId, reason, Date.now()),
    env.DB.prepare("UPDATE tracks SET flag_count = flag_count + 1 WHERE id = ?").bind(trackId),
  ]);
  return json({ ok: true, message: "Flag received. Rights and abuse reports are reviewed before each broadcast." });
}

// --- GET /api/transmissions/current — public payload for the home page ---

export async function handleCurrentTransmission(env, now = Date.now()) {
  const station = await getStation(env, now);
  const t = station.transmission;
  if (!t) return json({ state: "dark", transmission: null }, 200, { "cache-control": "no-store" });

  const payload = {
    state: station.state,
    next_transition_at_utc_ms: station.next_transition_at_utc_ms,
    server_now_utc_ms: now,
    transmission: {
      id: t.id,
      number: t.number,
      submission_open_at: t.submission_open_at,
      submission_close_at: t.submission_close_at,
      setlist_publish_at: t.setlist_publish_at,
      broadcast_start_at: t.broadcast_start_at,
      broadcast_end_at: t.broadcast_end_at,
      replay_close_at: t.replay_close_at,
    },
  };

  if (setlistVisible(t, now)) {
    payload.setlist = (await hydrateSetlist(env, t)).map((s) => ({
      position: s.position,
      track_id: s.track_id,
      title: s.title,
      artist: s.artist,
      slug: s.slug,
      duration_s: s.counted_s,
    }));
  }

  if (station.state === "results" || (station.state === "dark" && now >= t.broadcast_end_at)) {
    try {
      const { results } = await env.DB.prepare(
        `SELECT r.track_id, r.status, r.rank, r.crushes, r.unique_listeners, r.crush_rate,
                t.title, a.name AS artist, a.slug
         FROM transmission_results r
         JOIN tracks t ON t.id = r.track_id
         JOIN artists a ON a.id = t.artist_id
         WHERE r.transmission_id = ?
         ORDER BY CASE WHEN r.rank IS NULL THEN 1 ELSE 0 END, r.rank ASC`
      )
        .bind(t.id)
        .all();
      payload.results = results || [];
    } catch {
      payload.results = [];
    }
  }

  return json(payload, 200, { "cache-control": "no-store" });
}

// --- GET /api/hall — the Hall of Crush, permanently accessible ---

export async function handleHall(env) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT r.transmission_id, r.track_id, r.rank, r.crushes, r.crush_rate,
              t.title, t.duration_s, a.name AS artist, a.slug
       FROM transmission_results r
       JOIN tracks t ON t.id = r.track_id
       JOIN artists a ON a.id = t.artist_id
       WHERE r.status = 'crushed'
       ORDER BY r.created_at DESC, r.rank ASC
       LIMIT 100`
    ).all();
    return json({ hall: results || [] }, 200, { "cache-control": "public, max-age=60" });
  } catch {
    return json({ hall: [] }, 200, { "cache-control": "public, max-age=60" });
  }
}

// --- GET /audio/:track_id — stream from R2, Range-aware ---
// Allowed: tracks on the active setlist during live + replay, and
// Hall of Crush tracks forever.

export async function handleAudio(request, env, trackId) {
  const track = await env.DB.prepare(
    "SELECT id, filename, track_status FROM tracks WHERE id = ?"
  )
    .bind(trackId)
    .first();
  if (!track) return new Response("Not found", { status: 404 });

  let allowed = track.track_status === "crushed";
  if (!allowed) {
    const station = await getStation(env);
    if (station.state === "live" || station.state === "results") {
      allowed = parseSetlist(station.transmission).some((s) => s.track_id === trackId);
    }
  }
  if (!allowed) {
    return new Response("This track is not currently airing.", { status: 403 });
  }

  const rangeHeader = request.headers.get("Range");
  let object;
  let status = 200;
  const headers = {
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
  };

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m && (m[1] || m[2])) {
      const head = await env.AUDIO.head(track.filename);
      if (!head) return new Response("Not found", { status: 404 });
      const size = head.size;
      const start = m[1] ? parseInt(m[1], 10) : size - parseInt(m[2], 10);
      const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start < 0 || start > end) {
        return new Response("Range not satisfiable", {
          status: 416,
          headers: { "content-range": `bytes */${size}` },
        });
      }
      object = await env.AUDIO.get(track.filename, {
        range: { offset: start, length: end - start + 1 },
      });
      if (!object) return new Response("Not found", { status: 404 });
      status = 206;
      headers["content-range"] = `bytes ${start}-${end}/${size}`;
      headers["content-length"] = String(end - start + 1);
    }
  }

  if (!object) {
    object = await env.AUDIO.get(track.filename);
    if (!object) return new Response("Not found", { status: 404 });
    headers["content-length"] = String(object.size);
  }

  headers["content-type"] =
    (object.httpMetadata && object.httpMetadata.contentType) || "audio/mpeg";
  return new Response(object.body, { status, headers });
}
