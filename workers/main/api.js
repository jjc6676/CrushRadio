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
import { composeSelected, composeHeld, outboxStatements } from "./notify.js";

const ATTESTATION_TEXT =
  "I own this recording or have the rights to submit it.";

const UPLOAD_LIMITS = {
  maxBytes: 50 * 1024 * 1024, // 50 MB
  minDurationS: 30,
  maxDurationS: 900, // 15 min hard cap at upload; fades at 4:00 on air
  perHour: 3, // upload attempts per fingerprint per hour
  perArtistPerWindow: 1, // one track per artist per window — make it your best
  windowCapDefault: 100, // valid submissions per window (KV config:max_submissions_per_window)
  extensions: ["mp3", "m4a", "aac", "wav", "flac", "ogg"],
};

const AI_DISCLOSURES = ["human", "ai_assisted", "fully_ai"];

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

// Owner gate for /studio and the studio API: token lives in KV
// (config:owner_token), supplied via Authorization: Bearer or ?key=.
export async function requireOwner(request, env) {
  const url = new URL(request.url);
  const supplied =
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "") ||
    url.searchParams.get("key") ||
    "";
  if (!supplied) return false;
  const expected = await env.KV.get("config:owner_token");
  if (!expected) return false;
  const a = new TextEncoder().encode(supplied);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Magic-byte sniff — the extension allowlist says what the artist CLAIMS,
// this says what the bytes ARE. Returns a format family or null.
export function sniffAudio(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const ascii = (off, len) =>
    String.fromCharCode(...bytes.slice(off, off + len));
  if (ascii(0, 3) === "ID3") return "mp3";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "mp3"; // MPEG/ADTS sync
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(4, 4) === "ftyp") return "m4a";
  return null;
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
    `SELECT t.id, t.title, t.duration_s, t.artist_url, a.name AS artist, a.slug
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
        artist_url: row.artist_url || null,
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

// --- Setlist locking (shared by /studio and the auto-lock cron) ---

// Order: owner-set curation_position ascending (unset goes last), then
// upload order. Caps at 25 per the spec.
export function buildSetlistOrder(tracks) {
  return tracks
    .slice()
    .sort((a, b) => {
      const pa = a.curation_position == null ? Infinity : a.curation_position;
      const pb = b.curation_position == null ? Infinity : b.curation_position;
      return pa - pb || a.uploaded_at - b.uploaded_at;
    })
    .slice(0, 25)
    .map((t, i) => ({ position: i + 1, track_id: t.id }));
}

// Idempotent: no-ops if the setlist is already locked. In one atomic batch
// it writes setlist_json, flips cap-overflow back to held, and queues the
// selected/held notifications — composed here (not after the commit) so a
// crash can't lock the setlist yet lose every artist's email. The emails
// carry release_at = setlist_publish_at, so they hold until the public
// reveal even if the owner locks days early.
export async function lockSetlist(env, transmissionId, now = Date.now()) {
  const t = await env.DB.prepare("SELECT * FROM transmissions WHERE id = ?")
    .bind(transmissionId)
    .first();
  if (!t) return { error: "No such transmission." };
  if (t.setlist_json) return { ok: true, already_locked: true };
  if (now >= t.broadcast_start_at) return { error: "Broadcast already started." };

  const { results: selected } = await env.DB.prepare(
    `SELECT tr.id, tr.uploaded_at, tr.curation_position, tr.title, tr.access_token,
            a.name AS artist_name, a.slug AS artist_slug, a.email
     FROM tracks tr JOIN artists a ON a.id = tr.artist_id
     WHERE tr.track_status = 'selected'`
  ).all();
  if (!selected || selected.length === 0) {
    return { error: "Nothing selected — pick tracks before locking." };
  }

  const setlist = buildSetlistOrder(selected);
  const chosen = new Set(setlist.map((s) => s.track_id));
  const overflow = selected.filter((s) => !chosen.has(s.id));
  const selById = new Map(selected.map((s) => [s.id, s]));
  const tFull = { ...t, setlist_json: JSON.stringify(setlist) };
  const release = t.setlist_publish_at;

  // Pre-existing held tracks from this window (overflow is added below).
  const { results: held } = await env.DB.prepare(
    `SELECT tr.id, tr.title, tr.access_token, a.name AS artist_name, a.slug AS artist_slug, a.email
     FROM tracks tr JOIN artists a ON a.id = tr.artist_id
     WHERE tr.track_status = 'held' AND tr.uploaded_at >= ? AND tr.uploaded_at < ?`
  )
    .bind(t.submission_open_at, t.submission_close_at)
    .all();

  const notifRows = [];
  for (const s of setlist) {
    const track = selById.get(s.track_id);
    if (track && track.email) {
      const msg = composeSelected(track, tFull, s.position);
      notifRows.push({ ...msg, transmission_id: t.id, track_id: track.id, email: track.email, release_at: release });
    }
  }
  for (const track of [...(held || []), ...overflow]) {
    if (!track.email) continue;
    const msg = composeHeld(track, tFull);
    notifRows.push({ ...msg, transmission_id: t.id, track_id: track.id, email: track.email, release_at: release });
  }

  const writes = [
    env.DB
      .prepare("UPDATE transmissions SET setlist_json = ?, updated_at = ? WHERE id = ?")
      .bind(JSON.stringify(setlist), now, t.id),
  ];
  for (const o of overflow) {
    writes.push(
      env.DB.prepare("UPDATE tracks SET track_status = 'held' WHERE id = ?").bind(o.id)
    );
  }
  writes.push(...outboxStatements(env, notifRows));
  await env.DB.batch(writes);

  return { ok: true, setlist };
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
// Two ingestion paths, one validation pipeline: a direct file upload, or
// submit-by-URL (the Worker fetches the artist's own hosted file). Either
// way the bytes get magic-sniffed before they enter the pool.

// SSRF guard: reject hosts that are obviously internal. Workers can't
// resolve DNS pre-connect, so this blocks literal private/loopback/
// link-local IPs and internal-looking names; combined with https-only,
// manual-redirect revalidation, and the fact that this Worker exposes no
// internal HTTP services or metadata endpoint, it's adequate at this scale.
export function isSafePublicHost(hostname) {
  const h = (hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return false;
  // IPv6 loopback / unique-local / link-local
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false;
  // IPv4 literal?
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10 || a === 127 || a === 0) return false;
    if (a === 169 && b === 254) return false; // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast / reserved
  }
  return true;
}

export function validTrackUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!isSafePublicHost(parsed.hostname)) return null;
  return parsed;
}

async function fetchTrackByUrl(trackUrl) {
  // Generic failure string — never reflect the upstream status/reachability
  // back to the caller (no SSRF status oracle).
  const fail = { error: "Couldn't fetch a usable audio file from that link." };

  let parsed = validTrackUrl(trackUrl);
  if (!parsed) return { error: "Track links must be a public https:// URL to the audio file." };

  // Follow redirects manually, re-validating each hop's host.
  let res;
  try {
    let url = parsed.toString();
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        headers: { "User-Agent": "crushradio-ingest", Accept: "audio/*,*/*" },
        signal: AbortSignal.timeout(10000),
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return fail;
        const next = validTrackUrl(new URL(loc, url).toString());
        if (!next) return fail;
        url = next.toString();
        continue;
      }
      break;
    }
  } catch {
    return fail;
  }
  if (!res || !res.ok || !res.body) return fail;

  const declared = parseInt(res.headers.get("content-length") || "0", 10);
  if (declared > UPLOAD_LIMITS.maxBytes) return { error: "File too large. 50 MB max." };

  // Stream with a hard cap — content-length can lie or be absent.
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > UPLOAD_LIMITS.maxBytes) {
      try { reader.cancel(); } catch {}
      return { error: "File too large. 50 MB max." };
    }
    chunks.push(value);
  }
  if (total < 1024) return fail;

  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  const urlExt = (parsed.pathname.split(".").pop() || "").toLowerCase();
  return {
    bytes,
    contentType: res.headers.get("content-type") || "application/octet-stream",
    ext: UPLOAD_LIMITS.extensions.includes(urlExt) ? urlExt : null,
  };
}

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

  // Honeypot: real users never see this field. Bots that fill it get a
  // convincing yes and nothing else.
  if (String(form.get("website") || "").trim() !== "") {
    return json({
      ok: true,
      track_id: crypto.randomUUID(),
      message: "Track received.",
    });
  }

  const artistName = String(form.get("artist_name") || "").trim();
  const email = String(form.get("email") || "").trim();
  const title = String(form.get("title") || "").trim();
  const durationS = parseInt(form.get("duration_s"), 10);
  const attestation = String(form.get("attestation") || "").toLowerCase();
  const artistUrl = String(form.get("artist_url") || "").trim();
  const trackUrl = String(form.get("track_url") || "").trim();
  const aiDisclosure = String(form.get("ai_disclosure") || "human").trim();
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
  if (artistUrl && !/^https?:\/\/\S{4,200}$/.test(artistUrl)) {
    return json({ error: "Artist link must be a normal http(s) URL." }, 400);
  }
  if (!AI_DISCLOSURES.includes(aiDisclosure)) {
    return json({ error: "AI disclosure must be one of: human, ai_assisted, fully_ai." }, 400);
  }

  const hasFile = file instanceof File && file.size > 0;
  if (!hasFile && !trackUrl) {
    return json({ error: "Attach an audio file or paste a direct link to one." }, 400);
  }
  // Validate the link before any network call (no fetch on a bad/internal host).
  if (!hasFile && !validTrackUrl(trackUrl)) {
    return json({ error: "Track links must be a public https:// URL to the audio file." }, 400);
  }

  const fp = await fingerprint(request);
  if (!(await rateLimit(env, `rl:upload:${fp}`, UPLOAD_LIMITS.perHour, 3600))) {
    return json({ error: "Upload limit reached — try again in an hour." }, 429);
  }

  // Intake caps — the listen-everything promise only stays true if the
  // pool stays the size one human can actually hear before Friday noon.
  // Checked BEFORE the (possibly remote) fetch to bound amplification; the
  // per-artist cap is additionally enforced by a UNIQUE(artist_id,
  // submission_window) index at insert, so parallel uploads can't slip past.
  const windowId = station.transmission_id;
  const windowCap = parseInt(
    (await env.KV.get("config:max_submissions_per_window")) || "",
    10
  ) || UPLOAD_LIMITS.windowCapDefault;
  const poolRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tracks WHERE submission_window = ?"
  )
    .bind(windowId)
    .first();
  if (poolRow && poolRow.n >= windowCap) {
    return json(
      {
        error: `This window is full (${windowCap} tracks — every one gets a real listen). Submissions reopen Monday noon CT.`,
      },
      409
    );
  }
  const existingArtist = await env.DB.prepare("SELECT id FROM artists WHERE email = ?")
    .bind(email)
    .first();
  if (existingArtist) {
    const mine = await env.DB.prepare(
      "SELECT 1 FROM tracks WHERE artist_id = ? AND submission_window = ? LIMIT 1"
    )
      .bind(existingArtist.id, windowId)
      .first();
    if (mine) {
      return json(
        { error: "One track per artist per window — make it your best. The next window opens Monday noon CT." },
        409
      );
    }
  }

  // Resolve the audio bytes from whichever path the artist used.
  let audio; // { body, size, contentType, ext, head: Uint8Array }
  if (hasFile) {
    if (file.size > UPLOAD_LIMITS.maxBytes) {
      return json({ error: "File too large. 50 MB max." }, 413);
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!UPLOAD_LIMITS.extensions.includes(ext)) {
      return json({ error: `Unsupported format. Use: ${UPLOAD_LIMITS.extensions.join(", ")}.` }, 400);
    }
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    audio = {
      body: file.stream(),
      contentType: file.type || "application/octet-stream",
      ext,
      head,
    };
  } else {
    const fetched = await fetchTrackByUrl(trackUrl);
    if (fetched.error) return json({ error: fetched.error }, 400);
    audio = {
      body: fetched.bytes,
      contentType: fetched.contentType,
      ext: fetched.ext, // may be null — fall back to the sniffed format
      head: fetched.bytes.slice(0, 16),
    };
  }

  const sniffed = sniffAudio(audio.head);
  if (!sniffed) {
    return json({ error: "That doesn't look like an audio file (mp3, m4a, aac, wav, flac, ogg)." }, 400);
  }
  const ext = audio.ext || sniffed;

  // Find or create the artist (keyed by email).
  let artist = existingArtist;
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
  const accessToken = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const key = `tracks/${trackId}.${ext}`;
  await env.AUDIO.put(key, audio.body, {
    httpMetadata: { contentType: audio.contentType },
  });

  try {
    await env.DB.prepare(
      `INSERT INTO tracks
       (id, artist_id, title, filename, duration_s, status, track_status,
        access_token, artist_url, ai_disclosure, submission_window, uploaded_at)
       VALUES (?, ?, ?, ?, ?, 'held', 'held', ?, ?, ?, ?, ?)`
    )
      .bind(trackId, artist.id, title, key, durationS, accessToken, artistUrl || null, aiDisclosure, windowId, now)
      .run();
  } catch (e) {
    // Loser of a one-per-window race (UNIQUE artist_id+submission_window).
    // Clean up the orphaned R2 object and report the cap.
    try { await env.AUDIO.delete(key); } catch {}
    if (String(e).includes("UNIQUE") || String(e).includes("constraint")) {
      return json(
        { error: "One track per artist per window — make it your best. The next window opens Monday noon CT." },
        409
      );
    }
    throw e;
  }

  return json({
    ok: true,
    track_id: trackId,
    status_url: `/track/${trackId}/${accessToken}`,
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

  // INSERT OR IGNORE against UNIQUE(track_id, fingerprint): the live
  // crushed_it counter is best-effort display; survival math cross-checks
  // votes against qualified listens at certification (UA rotation makes new
  // fingerprints, which have no listen, so they don't count toward survival).
  await env.DB.batch([
    env.DB
      .prepare("INSERT OR IGNORE INTO votes (track_id, vote, fingerprint, voted_at) VALUES (?, 'crushed_it', ?, ?)")
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
              t.title, t.duration_s, t.artist_url, a.name AS artist, a.slug
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
    // The owner can audition any track from /studio.
    allowed = await requireOwner(request, env);
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
