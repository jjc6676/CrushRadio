// Crush Radio — Rotator Durable Object
// One global instance keyed by idFromName("global"). Maintains shared
// "now playing" state, accepts hibernatable WebSocket connections, and
// uses DO Alarms to advance tracks when the current one ends.

import { pickNextTrack } from "./queue.js";

// Fallback tracks for cold-start / D1-unavailable paths.
// Real tracks come from D1 (seeded by infra/seed.sql; uploaded in Plan 2).
const SEED_TRACKS = [
  { id: "track-001", artist_id: "artist-001", title: "Midnight Drive",  duration_s: 197 },
  { id: "track-002", artist_id: "artist-001", title: "Voltage",         duration_s: 224 },
  { id: "track-003", artist_id: "artist-001", title: "Paper Lanterns",  duration_s: 183 },
];

export class Rotator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade → accept with hibernation
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);

      // Send current now-playing state immediately so the client can
      // sync currentTime = (Date.now() - started_at_ms) / 1000
      const nowPlaying = await this.getNowPlaying();
      server.send(JSON.stringify(nowPlaying));

      return new Response(null, { status: 101, webSocket: client });
    }

    // Debug endpoint — returns the current state as JSON
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
    // Plan 1: no client→server protocol. Echo current state so devs
    // can poke the socket from wscat without confusion.
    // Plan 2 will handle vote submissions here.
    const nowPlaying = await this.getNowPlaying();
    ws.send(JSON.stringify(nowPlaying));
  }

  async webSocketClose(ws, code, reason, wasClean) {
    // Runtime removes the socket from getWebSockets() automatically.
    ws.close(code, reason);
  }

  async webSocketError(ws, error) {
    ws.close(1011, "WebSocket error");
  }

  // --- Alarm: advance to the next track ---

  async alarm() {
    const current = await this.state.storage.get("current_track");
    const history = (await this.state.storage.get("play_history")) || [];

    const next = await this.selectNextTrack(current, history);
    if (!next) {
      // No eligible tracks — retry in 10s.
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

    // Keep the last 20 plays for cool-down checks.
    const updatedHistory = [
      { track_id: next.id, artist_id: next.artist_id, played_at: startedAt },
      ...history,
    ].slice(0, 20);

    await this.state.storage.put("current_track", nowPlaying);
    await this.state.storage.put("play_history", updatedHistory);

    // Best-effort play log — never block the broadcast on DB.
    this.recordPlay(next.id, startedAt);

    this.broadcast(nowPlaying);

    this.state.storage.setAlarm(startedAt + next.duration_s * 1000);
  }

  // --- Internal helpers ---

  async getNowPlaying() {
    const current = await this.state.storage.get("current_track");

    if (!current) {
      // Cold start — pick the first track right now.
      await this.alarm();
      return await this.state.storage.get("current_track");
    }

    // If the alarm missed (DO restart / clock skew), advance now.
    const elapsed = Date.now() - current.started_at_ms;
    if (elapsed >= current.duration_s * 1000) {
      await this.alarm();
      return await this.state.storage.get("current_track");
    }

    return current;
  }

  async selectNextTrack(current, history) {
    try {
      const db = this.env.DB;
      const eligible = await db
        .prepare(
          `SELECT id, artist_id, title, duration_s
           FROM tracks
           WHERE status IN ('trial', 'rotating', 'background')
           ORDER BY
             CASE status
               WHEN 'rotating'   THEN 1
               WHEN 'background' THEN 2
               WHEN 'trial'      THEN 3
             END,
             COALESCE(last_played_at, 0) ASC
           LIMIT 20`
        )
        .all();

      if (eligible.results && eligible.results.length > 0) {
        const picked = pickNextTrack(eligible.results, history, current);
        if (picked) return picked;
      }
    } catch (e) {
      // D1 unreachable or empty — fall through to seed tracks.
    }

    // Fallback: round-robin through hardcoded seed tracks.
    const currentId = current ? current.track_id : null;
    const currentIndex = SEED_TRACKS.findIndex((t) => t.id === currentId);
    const nextIndex = (currentIndex + 1) % SEED_TRACKS.length;
    return SEED_TRACKS[nextIndex];
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch (e) {
        // Closed socket — runtime will reap it.
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
      // Best-effort.
    }
  }
}
