# Crush Radio v1 — Plan 1: Infra + Rotator DO

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Cloudflare infrastructure and Rotator Durable Object so listeners can connect via WebSocket and receive synced now-playing broadcasts.

**Architecture:** Single Cloudflare Worker handles all routing. Rotator is a Durable Object with one global instance (keyed by a fixed "global" stub) — it maintains current track state in DO storage, accepts hibernatable WebSocket connections, and uses DO Alarms to advance tracks automatically. D1 stores tracks/artists/plays/votes/flags. KV handles vote dedup in Plan 2. R2 holds audio in Plan 2.

**Tech Stack:** Cloudflare Workers (ES modules), Durable Objects (hibernatable WebSockets + Alarms), D1 (SQLite), KV, R2, wrangler CLI

---

## Task 1: Project scaffolding and wrangler.toml

**Files:** `wrangler.toml`, `workers/main/index.js` (stub), `rotator/index.js` (stub), `rotator/queue.js` (stub), `infra/schema.sql`, `infra/seed.sql`

- [ ] Create directory structure: `workers/main/`, `rotator/`, `infra/`
- [ ] Create `wrangler.toml` with placeholder IDs (filled in Task 2)
- [ ] Create stub files so wrangler can parse the config without errors
- [ ] Commit: `feat: scaffold v1 project structure with wrangler.toml`

### wrangler.toml

```toml
name = "crushradio"
main = "workers/main/index.js"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding = "DB"
database_name = "crushradio"
database_id = "FILL_AFTER_CREATE"

[[kv_namespaces]]
binding = "KV"
id = "FILL_AFTER_CREATE"
preview_id = "FILL_AFTER_CREATE"

[[r2_buckets]]
binding = "AUDIO"
bucket_name = "crushradio-audio"

[durable_objects]
bindings = [
  { name = "ROTATOR", class_name = "Rotator" }
]

[[migrations]]
tag = "v1"
new_classes = ["Rotator"]
```

### workers/main/index.js (stub for now — full implementation in Task 5)

```js
// Crush Radio — Main Worker (stub)
// Full routing added in Task 5
export { Rotator } from "../../rotator/index.js";

export default {
  async fetch(request, env) {
    return new Response("Crush Radio v1 — scaffolding complete", {
      headers: { "content-type": "text/plain" },
    });
  },
};
```

### rotator/index.js (stub)

```js
// Rotator Durable Object (stub — implemented in Task 4)
export class Rotator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    return new Response("Rotator stub", { status: 200 });
  }
}
```

### rotator/queue.js (stub)

```js
// Queue management — pick next track, enforce cool-downs
// Implemented in Task 4
export function pickNextTrack(tracks, history) {
  return null;
}
```

---

## Task 2: Create Cloudflare resources (D1, KV, R2)

**Files:** `wrangler.toml` (update IDs)

- [ ] Run `wrangler d1 create crushradio` — copy the `database_id` from the output into `wrangler.toml` under `[[d1_databases]]`
- [ ] Run `wrangler kv:namespace create KV` — copy the `id` from the output into `wrangler.toml` under `[[kv_namespaces]]` → `id`
- [ ] Run `wrangler kv:namespace create KV --preview` — copy the `preview_id` from the output into `wrangler.toml` under `[[kv_namespaces]]` → `preview_id`
- [ ] Run `wrangler r2 bucket create crushradio-audio`
- [ ] Verify all IDs are filled in `wrangler.toml` (no remaining `FILL_AFTER_CREATE`)
- [ ] Commit: `infra: wire D1, KV, R2 resource IDs into wrangler.toml`

### Commands and expected output

```bash
# Create D1 database
wrangler d1 create crushradio
# Output will contain:
#   Created database 'crushradio'
#   database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
# Copy that UUID into wrangler.toml → [[d1_databases]] → database_id

# Create KV namespace (production)
wrangler kv:namespace create KV
# Output will contain:
#   Add the following to your configuration file:
#   kv_namespaces = [{ binding = "KV", id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }]
# Copy the id value into wrangler.toml → [[kv_namespaces]] → id

# Create KV namespace (preview/dev)
wrangler kv:namespace create KV --preview
# Output will contain a preview_id — copy into wrangler.toml → [[kv_namespaces]] → preview_id

# Create R2 bucket
wrangler r2 bucket create crushradio-audio
# Output: Created bucket 'crushradio-audio'
# No ID needed — R2 uses bucket_name directly
```

---

## Task 3: Apply D1 schema and seed data

**Files:** `infra/schema.sql`, `infra/seed.sql`

- [ ] Write the full schema to `infra/schema.sql`
- [ ] Write 3 test tracks + 1 test artist to `infra/seed.sql`
- [ ] Run `wrangler d1 execute crushradio --file=infra/schema.sql` to apply schema
- [ ] Run `wrangler d1 execute crushradio --file=infra/seed.sql` to insert seed data
- [ ] Verify with `wrangler d1 execute crushradio --command="SELECT * FROM tracks"` — expect 3 rows
- [ ] Commit: `infra: apply D1 schema and seed 3 test tracks`

### infra/schema.sql

```sql
-- Crush Radio v1 — D1 Schema
-- Applied via: wrangler d1 execute crushradio --file=infra/schema.sql

CREATE TABLE IF NOT EXISTS artists (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  artist_id TEXT NOT NULL REFERENCES artists(id),
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'trial',
  play_count INTEGER NOT NULL DEFAULT 0,
  crushed_it INTEGER NOT NULL DEFAULT 0,
  next_count INTEGER NOT NULL DEFAULT 0,
  flag_count INTEGER NOT NULL DEFAULT 0,
  uploaded_at INTEGER NOT NULL,
  last_played_at INTEGER,
  last_artist_played_at INTEGER
);

CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  started_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  vote TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  voted_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL REFERENCES tracks(id),
  reason TEXT,
  flagged_at INTEGER NOT NULL
);

-- Indexes for hot queries
CREATE INDEX IF NOT EXISTS idx_tracks_status ON tracks(status);
CREATE INDEX IF NOT EXISTS idx_tracks_last_played ON tracks(last_played_at);
CREATE INDEX IF NOT EXISTS idx_tracks_artist_last_played ON tracks(last_artist_played_at);
CREATE INDEX IF NOT EXISTS idx_plays_track_started ON plays(track_id, started_at);
CREATE INDEX IF NOT EXISTS idx_votes_track ON votes(track_id);
CREATE INDEX IF NOT EXISTS idx_votes_fingerprint ON votes(fingerprint, track_id);
CREATE INDEX IF NOT EXISTS idx_flags_track ON flags(track_id, flagged_at);
```

### infra/seed.sql

```sql
-- Crush Radio v1 — Seed data for dev testing
-- 1 test artist, 3 test tracks (these simulate uploaded songs)
-- Duration values are realistic MP3 lengths in seconds

INSERT OR IGNORE INTO artists (id, slug, name, email, created_at)
VALUES ('artist-001', 'test-artist', 'Test Artist', 'test@crushradio.com', 1716000000);

INSERT OR IGNORE INTO tracks (id, artist_id, title, filename, duration_s, status, play_count, uploaded_at)
VALUES
  ('track-001', 'artist-001', 'Midnight Drive',     'track-001.mp3', 197, 'trial', 0, 1716000000),
  ('track-002', 'artist-001', 'Voltage',            'track-002.mp3', 224, 'trial', 0, 1716000100),
  ('track-003', 'artist-001', 'Paper Lanterns',     'track-003.mp3', 183, 'trial', 0, 1716000200);
```

### Verification commands

```bash
# Apply schema
wrangler d1 execute crushradio --file=infra/schema.sql

# Seed data
wrangler d1 execute crushradio --file=infra/seed.sql

# Verify tracks exist
wrangler d1 execute crushradio --command="SELECT id, title, duration_s, status FROM tracks"
# Expected: 3 rows — track-001, track-002, track-003
```

---

## Task 4: Implement Rotator Durable Object

**Files:** `rotator/index.js`, `rotator/queue.js`

- [ ] Implement `Rotator` class with hibernatable WebSocket support
- [ ] Implement `alarm()` handler that advances to the next track and broadcasts
- [ ] Implement `pickNextTrack()` in `queue.js` with cool-down enforcement
- [ ] Add fallback to 3 hardcoded tracks when D1 has no eligible rows
- [ ] Verify the class exports correctly for wrangler
- [ ] Commit: `feat: implement Rotator DO with WebSocket broadcast and alarm-based advancement`

### rotator/index.js

```js
// Crush Radio — Rotator Durable Object
// Manages the shared "now playing" state. One global instance.
// Accepts WebSocket connections, broadcasts track changes via DO Alarms.

import { pickNextTrack } from "./queue.js";

// Fallback tracks for Plan 1 testing (used when D1 has no eligible tracks)
const SEED_TRACKS = [
  { id: "track-001", title: "Midnight Drive", duration_s: 197 },
  { id: "track-002", title: "Voltage", duration_s: 224 },
  { id: "track-003", title: "Paper Lanterns", duration_s: 183 },
];

export class Rotator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Accept with hibernation — DO will wake on messages/close
      this.state.acceptWebSocket(server);

      // Send current now-playing state immediately
      const nowPlaying = await this.getNowPlaying();
      server.send(JSON.stringify(nowPlaying));

      return new Response(null, { status: 101, webSocket: client });
    }

    // Non-WebSocket: return current state as JSON (useful for debugging)
    if (url.pathname === "/status") {
      const nowPlaying = await this.getNowPlaying();
      return new Response(JSON.stringify(nowPlaying, null, 2), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Rotator DO — connect via WebSocket at /ws", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // --- Hibernatable WebSocket handlers ---

  async webSocketMessage(ws, message) {
    // Plan 1: no client→server messages expected.
    // In Plan 2, this handles vote submissions.
    // For now, echo back current state if they send anything.
    const nowPlaying = await this.getNowPlaying();
    ws.send(JSON.stringify(nowPlaying));
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Hibernation handles cleanup automatically.
    // Nothing to do — the runtime removes closed sockets from getWebSockets().
    ws.close(code, reason);
  }

  async webSocketError(ws, error) {
    ws.close(1011, "WebSocket error");
  }

  // --- Alarm: track advancement ---

  async alarm() {
    // Advance to the next track
    const current = await this.state.storage.get("current_track");
    const history = (await this.state.storage.get("play_history")) || [];

    // Pick next track (tries D1 first, falls back to seed tracks)
    const next = await this.selectNextTrack(current, history);

    if (!next) {
      // No tracks available — retry in 10 seconds
      this.state.storage.setAlarm(Date.now() + 10_000);
      return;
    }

    const startedAt = Date.now();
    const nowPlaying = {
      track_id: next.id,
      title: next.title,
      started_at_ms: startedAt,
      duration_s: next.duration_s,
    };

    // Update play history (keep last 20 entries for cool-down checks)
    const updatedHistory = [
      { track_id: next.id, artist_id: next.artist_id, played_at: startedAt },
      ...history,
    ].slice(0, 20);

    // Persist state
    await this.state.storage.put("current_track", nowPlaying);
    await this.state.storage.put("play_history", updatedHistory);

    // Record the play in D1 (best-effort — don't block broadcast on DB write)
    this.recordPlay(next.id, startedAt);

    // Broadcast to all connected listeners
    this.broadcast(nowPlaying);

    // Set alarm for when this track ends
    this.state.storage.setAlarm(startedAt + next.duration_s * 1000);
  }

  // --- Internal helpers ---

  async getNowPlaying() {
    const current = await this.state.storage.get("current_track");

    if (!current) {
      // First ever request — start playback
      await this.alarm();
      return await this.state.storage.get("current_track");
    }

    // Check if the track should have ended (alarm missed or DO restarted)
    const elapsed = Date.now() - current.started_at_ms;
    if (elapsed >= current.duration_s * 1000) {
      await this.alarm();
      return await this.state.storage.get("current_track");
    }

    return current;
  }

  async selectNextTrack(current, history) {
    // Try D1 first
    try {
      const db = this.env.DB;
      const eligible = await db
        .prepare(
          `SELECT id, artist_id, title, duration_s
           FROM tracks
           WHERE status IN ('trial', 'rotating', 'background')
           ORDER BY
             CASE status
               WHEN 'rotating' THEN 1
               WHEN 'background' THEN 2
               WHEN 'trial' THEN 3
             END,
             last_played_at ASC NULLS FIRST
           LIMIT 20`
        )
        .all();

      if (eligible.results && eligible.results.length > 0) {
        const picked = pickNextTrack(eligible.results, history, current);
        if (picked) return picked;
      }
    } catch (e) {
      // D1 unavailable or empty — fall through to seed tracks
    }

    // Fallback: cycle through hardcoded seed tracks
    const currentId = current ? current.track_id : null;
    const currentIndex = SEED_TRACKS.findIndex((t) => t.id === currentId);
    const nextIndex = (currentIndex + 1) % SEED_TRACKS.length;
    return SEED_TRACKS[nextIndex];
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    const sockets = this.state.getWebSockets();
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch (e) {
        // Socket already closed — runtime will clean it up
      }
    }
  }

  async recordPlay(trackId, startedAt) {
    try {
      const db = this.env.DB;
      await db
        .prepare("INSERT INTO plays (track_id, started_at) VALUES (?, ?)")
        .bind(trackId, startedAt)
        .run();
      await db
        .prepare(
          "UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?"
        )
        .bind(startedAt, trackId)
        .run();
    } catch (e) {
      // Non-fatal — play recording is best-effort in Plan 1
    }
  }
}
```

### rotator/queue.js

```js
// Crush Radio — Queue management
// Picks the next track respecting cool-down rules:
//   - No track within 90 min of its last play
//   - No artist within 20 min of their last play
// Priority: rotating > background > trial

const TRACK_COOLDOWN_MS = 90 * 60 * 1000; // 90 minutes
const ARTIST_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Pick the next eligible track from candidates, respecting cool-downs.
 *
 * @param {Array} candidates - Tracks from D1 (pre-sorted by priority + staleness)
 * @param {Array} history - Recent play history [{track_id, artist_id, played_at}]
 * @param {Object|null} current - Current now-playing state (to avoid repeat)
 * @returns {Object|null} The next track to play, or null if none eligible
 */
export function pickNextTrack(candidates, history, current) {
  const now = Date.now();

  // Build lookup maps from history
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
    // Skip the currently playing track
    if (current && track.id === current.track_id) continue;

    // Check track cool-down (90 min)
    const trackLastPlayed = lastTrackPlay.get(track.id);
    if (trackLastPlayed && now - trackLastPlayed < TRACK_COOLDOWN_MS) continue;

    // Check artist cool-down (20 min)
    const artistLastPlayed = lastArtistPlay.get(track.artist_id);
    if (artistLastPlayed && now - artistLastPlayed < ARTIST_COOLDOWN_MS) continue;

    // This track is eligible
    return track;
  }

  // No track passes cool-down — relax and pick the least-recently-played
  // (This handles the cold-start case where all 3 seed tracks were just played)
  const fallback = candidates.find(
    (t) => !current || t.id !== current.track_id
  );
  return fallback || null;
}
```

---

## Task 5: Main Worker routing (absorb existing worker.js)

**Files:** `workers/main/index.js`

- [ ] Port the existing `worker.js` logic (HOME_HTML, `/code` route, `/robots.txt`) into the new main worker
- [ ] Add `/ws` route that proxies to the Rotator DO (fixed "global" stub ID)
- [ ] Add `/api/status` route that fetches Rotator status (for debugging)
- [ ] Add stub `/api/*` 404 for future API routes (Plan 2)
- [ ] Verify the worker exports the `Rotator` class (required by wrangler for DO binding)
- [ ] Commit: `feat: main worker routing with /ws → Rotator DO proxy`

### workers/main/index.js (complete)

```js
// Crush Radio — Main Worker
// Routes:
//   /           → coming-soon page (HOME_HTML)
//   /code       → live GitHub feed (server-rendered)
//   /ws         → WebSocket upgrade → Rotator Durable Object
//   /api/status → Rotator now-playing state (JSON, for debugging)
//   /robots.txt → robots
//   /api/*      → 404 stub (endpoints added in Plan 2)

// Re-export the Rotator DO class so wrangler can find it
export { Rotator } from "../../rotator/index.js";

// HOME_HTML is replaced at build time by the build script.
const HOME_HTML = `__HTML__`;

const REPO_OWNER = "jjc6676";
const REPO_NAME = "crushradio";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- WebSocket route → Rotator DO ---
    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const id = env.ROTATOR.idFromName("global");
      const stub = env.ROTATOR.get(id);
      return stub.fetch(request);
    }

    // --- API routes ---
    if (path === "/api/status") {
      const id = env.ROTATOR.idFromName("global");
      const stub = env.ROTATOR.get(id);
      const statusUrl = new URL("/status", request.url);
      return stub.fetch(new Request(statusUrl));
    }

    if (path.startsWith("/api/")) {
      return new Response(
        JSON.stringify({ error: "Not implemented — coming in Plan 2" }),
        {
          status: 404,
          headers: { "content-type": "application/json" },
        }
      );
    }

    // --- Static routes (ported from existing worker.js) ---
    if (path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (path === "/code") {
      return renderCodePage();
    }

    if (path === "/") {
      return new Response(HOME_HTML, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300, s-maxage=300",
          "x-content-type-options": "nosniff",
          "referrer-policy": "strict-origin-when-cross-origin",
          "x-frame-options": "SAMEORIGIN",
        },
      });
    }

    return new Response("Not Found — try / or /code or /ws", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

// --- /code page (identical to existing worker.js) ---

async function renderCodePage() {
  const headers = {
    "User-Agent": "crushradio-site",
    Accept: "application/vnd.github+json",
  };
  const cf = { cacheTtl: 300, cacheEverything: true };

  const [repoRes, commitsRes, pullsRes, issuesRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`, {
      headers,
      cf,
    }),
    fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits?per_page=10`,
      { headers, cf }
    ),
    fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=10`,
      { headers, cf }
    ),
    fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=open&per_page=10`,
      { headers, cf }
    ),
  ]);

  const repo = repoRes.ok ? await repoRes.json() : null;
  const commits = commitsRes.ok ? await commitsRes.json() : [];
  const pullsRaw = pullsRes.ok ? await pullsRes.json() : [];
  const issuesRaw = issuesRes.ok ? await issuesRes.json() : [];
  const issues = Array.isArray(issuesRaw)
    ? issuesRaw.filter((i) => !i.pull_request)
    : [];
  const pulls = Array.isArray(pullsRaw) ? pullsRaw : [];

  const html = codeHtml({ repo, commits, pulls, issues });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "SAMEORIGIN",
    },
  });
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function timeAgo(iso) {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  if (d < 30) return d + "d ago";
  const mo = Math.floor(d / 30);
  if (mo < 12) return mo + "mo ago";
  return Math.floor(mo / 12) + "y ago";
}

function codeHtml(data) {
  const { repo, commits, pulls, issues } = data;
  const repoExists = !!repo && !repo.message;
  const desc = repoExists
    ? escapeHtml(repo.description || "An open-source community radio station.")
    : "Repo is being initialized. Check back in a sec.";
  const stars = repoExists ? repo.stargazers_count : 0;
  const forks = repoExists ? repo.forks_count : 0;
  const watchers = repoExists ? repo.subscribers_count : 0;
  const license =
    repoExists && repo.license
      ? escapeHtml(repo.license.spdx_id || repo.license.name)
      : "MIT";
  const defaultBranch = repoExists ? escapeHtml(repo.default_branch) : "main";
  const lastPush = repoExists ? timeAgo(repo.pushed_at) : "—";
  const openIssuesCount = repoExists
    ? Math.max(0, (repo.open_issues_count || 0) - pulls.length)
    : issues.length;

  // NOTE: The full /code HTML template is identical to the existing worker.js codeHtml().
  // It's omitted here for brevity — copy from the existing worker.js codeHtml() function.
  // The only change is this file uses ES module syntax instead of being a standalone script.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Crush Radio — the code</title></head><body><p>Code page placeholder — port full template from worker.js</p></body></html>`;
}
```

**IMPORTANT:** The actual `codeHtml()` function body should be copied verbatim from the existing `worker.js` (lines 109-341). The stub above is shortened for plan readability. The executor MUST copy the full template.

---

## Task 6: Wire up `wrangler dev` and verify local operation

**Files:** `package.json` (add wrangler dev script)

- [ ] Add `"dev": "wrangler dev"` to `package.json` scripts
- [ ] Add `wrangler` as a devDependency: `npm install -D wrangler`
- [ ] Run `wrangler dev` and confirm the worker starts without errors
- [ ] Visit `http://localhost:8787/` — expect the coming-soon page (or placeholder text)
- [ ] Visit `http://localhost:8787/api/status` — expect JSON with now-playing state
- [ ] Commit: `chore: add wrangler dev script and devDependency`

### package.json changes

Add to `"scripts"`:
```json
{
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "db:schema": "wrangler d1 execute crushradio --file=infra/schema.sql",
    "db:seed": "wrangler d1 execute crushradio --file=infra/seed.sql",
    "test": "echo \"Error: no test specified\" && exit 1"
  }
}
```

Add to `"devDependencies"`:
```json
{
  "devDependencies": {
    "wrangler": "^3.99.0"
  }
}
```

### Verification

```bash
# Install wrangler
npm install -D wrangler

# Start local dev server
npx wrangler dev

# In another terminal:
# Test home route
curl http://localhost:8787/
# Expected: HTML page or "Crush Radio v1" text

# Test status endpoint (triggers first alarm → picks track)
curl http://localhost:8787/api/status
# Expected: {"track_id":"track-001","title":"Midnight Drive","started_at_ms":...,"duration_s":197}
```

---

## Task 7: WebSocket integration test with wscat

**Files:** none (verification only)

- [ ] Install wscat: `npm install -g wscat` (or use `npx wscat`)
- [ ] Start `wrangler dev` in one terminal
- [ ] In a second terminal, connect: `npx wscat -c ws://localhost:8787/ws`
- [ ] Verify immediate receipt of now-playing JSON: `{"track_id":"track-001","started_at_ms":...,"duration_s":197}`
- [ ] Open a THIRD wscat connection in parallel — verify it receives the same track state
- [ ] Wait for the track duration to elapse (or use `wrangler dev --test-scheduled` to trigger alarm manually) — verify both connections receive the next track broadcast
- [ ] Confirm track advances through all 3 seed tracks and loops back
- [ ] Document any issues in a `TESTING.md` or inline comments

### Expected WebSocket session

```
$ npx wscat -c ws://localhost:8787/ws
Connected (press CTRL+C to quit)
< {"track_id":"track-001","title":"Midnight Drive","started_at_ms":1716000000000,"duration_s":197}

# After 197 seconds (or alarm trigger):
< {"track_id":"track-002","title":"Voltage","started_at_ms":1716000197000,"duration_s":224}

# After 224 more seconds:
< {"track_id":"track-003","title":"Paper Lanterns","started_at_ms":1716000421000,"duration_s":183}

# After 183 more seconds (loops):
< {"track_id":"track-001","title":"Midnight Drive","started_at_ms":1716000604000,"duration_s":197}
```

### Quick-test tip

For faster iteration, temporarily change `SEED_TRACKS` durations to 10 seconds each:
```js
const SEED_TRACKS = [
  { id: "track-001", title: "Midnight Drive", duration_s: 10 },
  { id: "track-002", title: "Voltage", duration_s: 10 },
  { id: "track-003", title: "Paper Lanterns", duration_s: 10 },
];
```
Then revert before committing.

---

## Task 8: Clean up legacy worker.js and finalize

**Files:** `worker.js` (delete or archive), `workers/main/index.js` (finalize codeHtml), build script updates

- [ ] Copy the full `codeHtml()` template from `worker.js` into `workers/main/index.js` (if not done in Task 5)
- [ ] Update any build script that references `worker.js` to point to `workers/main/index.js` instead
- [ ] Move `worker.js` to `legacy/worker.js` (or delete if confident — git history preserves it)
- [ ] If a build script inlines `HOME_HTML` from `index.html`, verify it still works with the new path in `wrangler.toml` (`main = "workers/main/index.js"`)
- [ ] Run `wrangler dev` one final time — test `/`, `/code`, `/ws`, `/api/status` all work
- [ ] Commit: `chore: retire legacy worker.js, finalize main worker entry point`
- [ ] Tag the commit: `git tag v1-plan1-complete`

### Final verification checklist

```bash
# All routes working:
curl http://localhost:8787/                  # → coming-soon HTML
curl http://localhost:8787/code              # → GitHub feed page
curl http://localhost:8787/robots.txt        # → robots.txt
curl http://localhost:8787/api/status        # → now-playing JSON
npx wscat -c ws://localhost:8787/ws          # → receives now-playing, advances on alarm

# D1 has schema:
npx wrangler d1 execute crushradio --command="SELECT name FROM sqlite_master WHERE type='table'"
# Expected: artists, tracks, plays, votes, flags

# D1 has seed data:
npx wrangler d1 execute crushradio --command="SELECT id, title FROM tracks"
# Expected: 3 rows
```

---

## Success criteria (all must pass before moving to Plan 2)

1. `wrangler dev` starts without errors
2. `GET /` returns the coming-soon page HTML
3. `GET /code` returns the GitHub live feed
4. `GET /api/status` returns valid JSON with `track_id`, `started_at_ms`, `duration_s`
5. WebSocket connection to `/ws` immediately receives now-playing payload
6. Multiple simultaneous WebSocket connections all receive the same state
7. After track duration elapses, all connections receive the next track broadcast
8. Tracks cycle through all 3 seed entries and loop
9. D1 schema is applied with all 5 tables + indexes
10. D1 seed data contains 3 tracks and 1 artist
11. KV namespace exists (unused until Plan 2)
12. R2 bucket exists (unused until Plan 2)
13. No errors in `wrangler dev` console during normal operation
