# Crush Radio — Transmissions Pivot

**Date:** 2026-05-17
**Owner:** J. Choplin (jason.choplin@gmail.com)
**Status:** Supersedes the v1 "24/7 open jukebox" launch scope in [2026-05-17-crush-radio-design.md](2026-05-17-crush-radio-design.md). 24/7 rotation is deferred to v2+.

## Why this exists

The original v1 design assumed always-on rotation: artists upload whenever, the Rotator plays whatever, listeners drift in and tap CRUSHED IT. That design has a cold-start problem — without simultaneous density of artists, listeners, and votes, the survival mechanic feels empty.

This pivot reframes Crush Radio as **scheduled live transmissions**: weekly events with scarcity, appointment viewing, and curated taste. Between transmissions, the station goes dark. 24/7 is something the station earns once the ritual is proven.

## Doctrine

> Early transmissions are hand-curated to establish signal. As the community grows, the protocol opens.

> If nobody shows up live, the track has not truly been judged.

The first line frames T001's curation as intentional, not a bottleneck. The second line gives "unjudged" its meaning: airing a track to an empty room is not a verdict.

## The state machine (the backbone)

The site has six states. Every page, every API, every Worker route hangs off `current_state`. The user-facing narrative collapses `submissions_closed` and `setlist_published` into one "curation in progress" beat — internally they're distinct because one shows the setlist publicly and one doesn't.

| State | Window (presentation: CT) | Site shows | Writes accepted |
|---|---|---|---|
| **Submissions open** | Mon 12pm → Thu 8pm | Upload page, live submission counter, Hall of Crush, countdown to setlist publish | Track uploads, abuse/rights flags |
| **Submissions closed** | Thu 8pm → Fri 12pm | "Setlist pending" message, Hall of Crush, countdown to setlist publish | Abuse/rights flags only |
| **Setlist published** | Fri 12pm → Fri 8pm | Public setlist (artist + title, no audio yet), per-artist promo cards, countdown to broadcast | Abuse/rights flags only |
| **Live transmission** | Fri 8pm → ~10pm | Synced broadcast, CRUSHED IT button, live Hall counter ticking up | Votes, abuse/rights flags |
| **Results / replay** | Fri 10pm → Sat 12pm | Final tallies, four-status results table, on-demand replay of the transmission | Abuse/rights flags only |
| **Dark / countdown** | Sat 12pm → Mon 12pm | Hero + countdown to next submission window. Hall of Crush is the only other content. | Abuse/rights flags only |

**Transitions are time-driven and derived from UTC schedule timestamps.** No stored state is authoritative. Owner actions can select tracks, publish assets, or certify results, but they do not transition the station.

## Time handling

**All schedule timestamps are stored in UTC. CT (or any other zone) is presentation only.** This avoids DST pain and keeps the broadcast clock unambiguous when the Worker, the Rotator, and the client are all running in different runtimes.

Public copy can say "Friday 8pm CT" freely. Internally, every timestamp in D1 is UTC, every comparison in code is UTC, every cron is UTC.

## Transmission 001 parameters

| Field | Value |
|---|---|
| Setlist size | **20–25 tracks** (cap 25) |
| Per-track length | **Max 4 minutes counted toward broadcast** (longer tracks fade at 4:00) |
| Broadcast duration | ~100 minutes of music + intro/outro buffer ≈ 2 hours |
| Curation | **Owner-curated.** Owner picks the setlist between Thu 8pm and Fri 12pm CT. |
| Setlist publish | Fri 12pm CT — gives selected artists ~8 hours to promote |
| Artist notifications | Selected artists get an email at setlist publish; non-selected get a "held for future transmission" email |
| Promo cards | Each selected artist gets a shareable URL: `crushradio.com/transmissions/001#<artist-slug>` deep-links to their slot on the setlist page. T001 promo card text: *"I'm transmitting on Crush Radio tonight. Friday 8pm CT."* This is the one growth feature in T001. |

### Emergency setlist edits

The setlist is locked at Fri 12pm CT. **Owner may remove a selected track after lock only for rights violations, abuse, or technical failure.** A removed track returns to status `held`, not `retired`. No other post-lock edits are permitted; this preserves trust in the curation contract.

## Survival rule

Public language:

> The top third survive. Tracks with too few listeners go back into the pool.

Internal definition. A track has one of four post-broadcast statuses:

| Status | Meaning |
|---|---|
| **Crushed** | Eligible (met signal floor) AND in the top 33% by crush rate. Enters Hall of Crush. |
| **Retired** | Eligible AND outside the top 33%. Played, judged, did not survive. Archived on artist profile, not aired again. |
| **Unjudged** | Did not meet signal floor. Not retired — eligible for resubmission to a future transmission. |
| **Held** | Submitted but not selected for this transmission. Rolls over to the next submission window once. After one rollover, the artist is invited to explicitly resubmit; the track does not auto-roll a second time. This prevents an unbounded purgatory queue. |

### Signal floor (T001 — configurable)

- `minPlays: 1` — track aired at least once during the broadcast
- `minListenSeconds: 20` — only listeners connected for ≥20 seconds while the track was airing count as impressions
- `minListeners: 10` — at least 10 unique fingerprints met `minListenSeconds`
- `minCrushes: 3` — at least 3 CRUSHED IT votes recorded
- `survivalPercentile: 0.33` — top third by crush rate among eligible tracks

`unique_listeners_during_play` is defined precisely as: *unique listener fingerprints connected for at least `minListenSeconds` while the track was airing*. A drive-by 1-second page load does not count.

`crush_rate = crushed_it_votes / unique_listeners_during_play` (over eligible listeners only).

If overall attendance is small enough that no track clears the floor, the owner can manually certify winners post-broadcast. This is an explicit T001 escape valve, not a permanent fixture.

## Replay window

- Fri 10pm → Sat 12pm CT: **on-demand replay** of the T001 broadcast — full ordered playlist, voting closed, running CRUSHED IT totals overlaid as each track plays so the result is dramatized.
- Sat 12pm onward: replay disappears. Station goes dark. Hall of Crush remains permanently accessible.

**Replay is on-demand, not synced.** Choosing on-demand keeps the Rotator out of replay duty entirely and respects that listeners arriving Saturday morning aren't part of the live ritual. The synced broadcast is the live ritual; the replay is a bone, not a re-enactment.

UI for replay must visually flag voting as dead: *"Voting closed. These are the live results from Friday."*

## Architecture changes from the original v1

The synced-jukebox mechanic, Rotator Durable Object, R2 audio hosting, D1 schema, and KV vote-dedup all carry over unchanged. What changes is **when the Rotator is active**, **how state is derived**, and **what tables exist for transmission results**.

### Data model additions

```sql
-- One row per transmission. Schedule timestamps in UTC.
-- No `state` column: state is derived from these timestamps.
CREATE TABLE transmissions (
  id                   TEXT PRIMARY KEY,        -- e.g. "T001"
  number               INTEGER NOT NULL,
  submission_open_at   INTEGER NOT NULL,        -- UTC ms
  submission_close_at  INTEGER NOT NULL,
  setlist_publish_at   INTEGER NOT NULL,
  broadcast_start_at   INTEGER NOT NULL,
  broadcast_end_at     INTEGER NOT NULL,
  replay_close_at      INTEGER NOT NULL,
  setlist_json         TEXT,                    -- cached for fast rendering
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Normalized per-track result rows. Hall of Crush queries hit this table,
-- not the JSON blob. Results are queryable, sortable, and joinable.
CREATE TABLE transmission_results (
  transmission_id      TEXT NOT NULL REFERENCES transmissions(id),
  track_id             TEXT NOT NULL REFERENCES tracks(id),
  status               TEXT NOT NULL,           -- crushed | retired | unjudged
  rank                 INTEGER,                 -- 1 = top crush rate
  crushes              INTEGER NOT NULL,
  unique_listeners     INTEGER NOT NULL,        -- those meeting minListenSeconds
  crush_rate           REAL NOT NULL,
  eligible             INTEGER NOT NULL,        -- 0 or 1
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (transmission_id, track_id)
);

-- Tracks table gains a track_status column:
--   held | selected | crushed | retired | unjudged
-- Owner curation flips held → selected during the curation window.
-- Post-broadcast certification flips selected → crushed/retired/unjudged.
ALTER TABLE tracks ADD COLUMN track_status TEXT NOT NULL DEFAULT 'held';
ALTER TABLE tracks ADD COLUMN rollover_count INTEGER NOT NULL DEFAULT 0;
```

A `results_json` blob may be cached alongside the normalized rows for fast rendering, but it is not authoritative.

### Route behavior

```
GET  /api/state    → computed live from UTC schedule. Returns:
                       { state, transmission_id, next_transition_at_utc_ms }
                     where state ∈ submissions_open | submissions_closed |
                                   setlist_published | live | results | dark

POST /api/upload   → 200 only when state == submissions_open. Else 410 Gone.
                     Required attestation field: "I own this recording or
                     have the rights to submit it." No checkbox, no upload.

POST /api/vote     → 200 only when state == live. Else 410 Gone.
POST /api/flag     → 200 in any state (abuse/rights reports never stop).

GET  /transmissions/001  → setlist page once state ≥ setlist_published.
                            Before that: 404 or "pending" page.
```

### Rotator activation

```
Fri 8pm CT  (broadcast_start_at):  Rotator plays the published setlist in order.
Fri 10pm CT (broadcast_end_at):    Rotator hibernates. /api/vote starts returning 410.
                                    Replay served as on-demand audio from R2 — no DO involvement.
Sat 12pm CT (replay_close_at):     Replay UI disappears. Station enters dark state.
```

The Rotator is awake exactly two hours per week.

### Scheduled jobs

Cloudflare Cron Triggers (UTC):

- `submission_open_at`: ensure upload route is open; nothing else to do.
- `submission_close_at`: snapshot held submissions; notify owner curation is open.
- `setlist_publish_at`: lock setlist; fire `artist_selected` + `artist_held` events; render setlist page.
- `broadcast_start_at`: kick the Rotator.
- `broadcast_end_at`: certify results — compute eligibility and crush_rate per track, write `transmission_results` rows, flip `track_status` on each track, fire `transmission_results_published` event.
- `replay_close_at`: nothing to do (state derivation handles the transition).

### Notification events (logical, not implementation)

Define the data events now, even if delivery is manual Gmail for T001:

- `artist_selected(transmission_id, artist_id, track_id, setlist_position)`
- `artist_held(transmission_id, artist_id, track_id, rollover_count)`
- `transmission_results_published(transmission_id, crushed_count, retired_count, unjudged_count)`

Implementation path: manual email for T001 → Resend or MailChannels by T003 or so.

## What does NOT ship in this pivot

Explicitly out of scope, even though some appear in the prior v1 spec:

- 24/7 rotation of any kind (deferred entirely)
- Listener accounts / OAuth (votes remain anonymous, fingerprint+IP)
- Tipping, supporter tiers, sponsored transmissions
- Live chat during broadcast
- Federation
- Recommendations / personalization
- Mobile app (PWA only)
- Curation admin UI (CLI/SQL is fine for T001)

## Open questions (acknowledged, not blocking T001)

- **Notification delivery:** Resend, MailChannels, or owner's Gmail via script? T001 = manual Gmail.
- **DMCA workflow during curation:** Owner reviews originals attestation at curation time. Reactive takedown lives at `/takedown`. Required attestation at upload (no checkbox, no upload).
- **Owner-curator UI:** T001 = CLI/SQL queries against D1. Real UI deferred until painful.
- **What if the broadcast loses sync mid-transmission?** Rotator already broadcasts `started_at_ms` — clients self-correct. If the DO crashes, an apology card replaces the player; live listeners are sent to the replay page once Fri 10pm hits.
- **Fingerprint composition:** for vote dedup. Currently IP+UA hash. May tighten with browser fingerprint later if abuse appears.

## Success criteria for T001

Not metrics — vibes:

- The transmission feels like an event people are slightly annoyed they missed.
- At least one selected artist tells someone "I was on Crush Radio Friday."
- The Hall of Crush has between 5 and 8 tracks (top third of ~20–25).
- The owner does not have to touch infra during the live broadcast.
- The site is dark and feels intentional from Saturday noon onward, not broken.

If those land, T002 can open with confidence.
