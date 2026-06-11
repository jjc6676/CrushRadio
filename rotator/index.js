// Crush Radio — Rotator Durable Object
// The single conductor for the weekly live transmission. One global
// instance keyed by idFromName("global"). Awake only during the broadcast
// window: the Worker cron kicks /start at broadcast_start_at, the DO walks
// the published setlist in order via alarms, then goes back to sleep.
//
// While awake it also records the signal-floor inputs: one track_listens
// row per (transmission, track, fingerprint) where the listener was
// connected ≥ minListenSeconds while the track aired.

import { SIGNAL_FLOOR } from "../workers/main/state.js";

export class Rotator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // WebSocket upgrade → accept with hibernation. The Worker passes the
    // listener fingerprint as ?fp= (computed from IP+UA at the edge).
    if (request.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.state.acceptWebSocket(server);
      server.serializeAttachment({
        fp: url.searchParams.get("fp") || "anonymous",
        connected_at_ms: Date.now(),
      });

      server.send(JSON.stringify(await this.statusPayload()));
      return new Response(null, { status: 101, webSocket: client });
    }

    // Cron-driven kick: start (or resync) the broadcast. Idempotent —
    // safe to call every minute during the live window.
    if (url.pathname === "/start" && request.method === "POST") {
      const show = await request.json();
      await this.startShow(show);
      return Response.json(await this.statusPayload());
    }

    if (url.pathname === "/status") {
      return Response.json(await this.statusPayload());
    }

    return new Response("Rotator DO — connect via WebSocket at /ws", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  // --- Hibernatable WebSocket handlers ---

  async webSocketMessage(ws) {
    // No client→server protocol: votes go through POST /api/vote.
    // Echo current status so devs can poke the socket from wscat.
    ws.send(JSON.stringify(await this.statusPayload()));
  }

  async webSocketClose(ws, code, reason) {
    // Credit this listener's time against the currently airing track
    // before the runtime reaps the socket.
    await this.recordListen(ws, Date.now());
    ws.close(code, reason);
  }

  async webSocketError(ws) {
    await this.recordListen(ws, Date.now());
    ws.close(1011, "WebSocket error");
  }

  // --- Show control ---

  // show = { transmission_id, broadcast_start_at, broadcast_end_at,
  //          setlist: [{ track_id, title, artist, slug, position,
  //                      duration_s, counted_s }] }  (ordered)
  async startShow(show) {
    if (!show || !Array.isArray(show.setlist) || show.setlist.length === 0) return;

    const existing = await this.state.storage.get("show");
    if (!existing || existing.transmission_id !== show.transmission_id) {
      await this.state.storage.put("show", show);
    }
    await this.syncToSchedule();
  }

  // Derive which setlist slot should be airing right now from the wall
  // clock, so a DO restart mid-broadcast self-corrects without drift.
  async syncToSchedule() {
    const show = await this.state.storage.get("show");
    if (!show) return;

    const now = Date.now();
    if (now < show.broadcast_start_at) {
      this.state.storage.setAlarm(show.broadcast_start_at);
      return;
    }

    let cursor = show.broadcast_start_at;
    for (const slot of show.setlist) {
      const ends = cursor + slot.counted_s * 1000;
      if (now < ends && now < show.broadcast_end_at) {
        await this.airTrack(show, slot, cursor, ends);
        return;
      }
      cursor = ends;
    }
    await this.endShow(show);
  }

  async airTrack(show, slot, startedAtMs, endsAtMs) {
    const current = await this.state.storage.get("current_track");

    // Already airing this slot — just make sure the alarm is set.
    if (current && current.track_id === slot.track_id && current.started_at_ms === startedAtMs) {
      this.state.storage.setAlarm(endsAtMs);
      return;
    }

    // Close the book on whatever was airing before.
    if (current) await this.finalizeTrack(current, Math.min(Date.now(), startedAtMs));

    const nowPlaying = {
      type: "now_playing",
      transmission_id: show.transmission_id,
      track_id: slot.track_id,
      title: slot.title,
      artist: slot.artist,
      position: slot.position,
      total: show.setlist.length,
      started_at_ms: startedAtMs,
      duration_s: slot.counted_s,
    };
    await this.state.storage.put("current_track", nowPlaying);

    this.recordPlay(slot.track_id, startedAtMs); // best-effort, never blocks
    this.broadcast({ ...nowPlaying, listeners: this.state.getWebSockets().length });
    this.state.storage.setAlarm(Math.min(endsAtMs, show.broadcast_end_at));
  }

  async endShow(show) {
    const current = await this.state.storage.get("current_track");
    if (current) await this.finalizeTrack(current, Date.now());

    await this.state.storage.delete("current_track");
    await this.state.storage.delete("show");
    await this.state.storage.deleteAlarm();

    this.broadcast({
      type: "off_air",
      transmission_id: show ? show.transmission_id : null,
    });
    // No new alarm: the Rotator hibernates until the next cron kick.
  }

  async alarm() {
    // No show on the books (e.g. a stray alarm left over from an old
    // deployment) — clear any stale now-playing state and go to sleep.
    const show = await this.state.storage.get("show");
    if (!show) {
      await this.state.storage.delete("current_track");
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.syncToSchedule();
  }

  // --- Listener accounting (signal floor) ---

  // Credit every connected socket's overlap with the track that just
  // ended; rows below minListenSeconds are not written.
  async finalizeTrack(current, endedAtMs) {
    const rows = [];
    for (const ws of this.state.getWebSockets()) {
      const row = this.listenRow(ws, current, endedAtMs);
      if (row) rows.push(row);
    }
    await this.writeListens(rows);
  }

  // Credit one closing socket against the currently airing track.
  async recordListen(ws, atMs) {
    const current = await this.state.storage.get("current_track");
    if (!current) return;
    const row = this.listenRow(ws, current, atMs);
    if (row) await this.writeListens([row]);
  }

  listenRow(ws, current, endMs) {
    let att;
    try {
      att = ws.deserializeAttachment();
    } catch {
      return null;
    }
    if (!att || !att.fp) return null;

    const overlapMs =
      Math.min(endMs, current.started_at_ms + current.duration_s * 1000) -
      Math.max(current.started_at_ms, att.connected_at_ms);
    const seconds = Math.floor(overlapMs / 1000);
    if (seconds < SIGNAL_FLOOR.minListenSeconds) return null;

    return {
      transmission_id: current.transmission_id,
      track_id: current.track_id,
      fingerprint: att.fp,
      listen_seconds: seconds,
    };
  }

  async writeListens(rows) {
    if (rows.length === 0) return;
    try {
      const stmt = this.env.DB.prepare(
        `INSERT OR IGNORE INTO track_listens
         (transmission_id, track_id, fingerprint, listen_seconds, created_at)
         VALUES (?, ?, ?, ?, ?)`
      );
      await this.env.DB.batch(
        rows.map((r) =>
          stmt.bind(r.transmission_id, r.track_id, r.fingerprint, r.listen_seconds, Date.now())
        )
      );
    } catch {
      // Best-effort — never let accounting take down the broadcast.
    }
  }

  // --- Helpers ---

  async statusPayload() {
    // current_track only counts while a show is on the books — guards
    // against stale storage from older deployments reporting a phantom
    // now-playing forever.
    const [current, show] = await Promise.all([
      this.state.storage.get("current_track"),
      this.state.storage.get("show"),
    ]);
    const listeners = this.state.getWebSockets().length;
    if (!current || !show) return { type: "off_air", listeners };
    return { ...current, listeners };
  }

  broadcast(message) {
    const payload = JSON.stringify(message);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Closed socket — runtime will reap it.
      }
    }
  }

  async recordPlay(trackId, startedAt) {
    try {
      await this.env.DB.batch([
        this.env.DB
          .prepare("INSERT INTO plays (track_id, started_at) VALUES (?, ?)")
          .bind(trackId, startedAt),
        this.env.DB
          .prepare(
            "UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?"
          )
          .bind(startedAt, trackId),
      ]);
    } catch {
      // Best-effort.
    }
  }
}
