# Crush Radio — Open Signal

**Date:** 2026-06-11
**Owner:** J. Choplin (jason.choplin@gmail.com)
**Status:** Companion to [2026-05-17-transmissions-design.md](2026-05-17-transmissions-design.md) (which still governs the state machine and T001 parameters). This spec covers the automated pipeline around the human gate, and the research-grounded constitution for growing without dying.

## Why this exists

The transmissions pivot built the broadcast. Open Signal automates everything around the
one decision that must stay human — the owner's curation taste — and writes down, with
receipts, why Crush Radio's strange shape is the moat.

We researched the graveyard before building: Turntable.fm, plug.dj, JQBX, Clubhouse,
Stationhead, the Hangout revival, SubmitHub, Groover, BBC Introducing, NTS, SomaFM,
WFMU, songfight.org, and the 2026 AI-upload flood. The pattern is unambiguous:

- **Every always-on synced-listening platform died** of the same three wounds: empty
  rooms (Turntable needed 2+ DJs before a room even played), licensing costs that
  scale with catalog (all four majors signed, still dead; Spotify's 2024 API lockdown
  killed the JQBX category retroactively), and a 6–8 week novelty churn cliff hidden
  under signup growth.
- **Every scheduled, event-shaped ritual worked**: YouTube Premieres (150k reminders →
  ~1M concurrent for one video), Stationhead's scheduled fan parties (400k in one
  room), Bandcamp Listening Parties, Tim Burgess's 1,366 scheduled playbacks with
  *zero* sync technology — the ritual did the syncing.
- **Artists pay $1–2 per submission elsewhere** (SubmitHub, Groover) for what Crush
  Radio gives away: a guaranteed human listen, a decision deadline, and a real
  outcome. The free incumbents (BBC Introducing: 470k-track backlog) can no longer
  keep that promise. A weekly capped cohort is the only structure that can.

Crush Radio is the event-shaped, originals-only, free-pipeline thing. Everything below
either automates the weekly machine or defends that shape.

## The sacred constraints

These are load-bearing. Each one is a named failure mode of a dead platform.
Changing any of them requires a spec that argues against the body count.

1. **Originals only, forever.** Licensed catalog in any form — Spotify integration,
   covers, "play your favorites" — is the catalog trap that killed Turntable
   (majors deals + geo-blocking), plug.dj (YouTube dependence), and JQBX (API
   mercy). Originals-only is the entire economic moat under the ~$10/mo model.
2. **One room, one time.** No simultaneous channels, no 24/7 ambient stream, no
   "hang out anytime." Always-on re-imports the empty-room disease the schedule
   cures. Growth deepens the single transmission; it never fragments it.
3. **Positive-only voting.** A downvote/skip is Turntable's "Lame" button culture:
   gatekeeping, snark, artist performance anxiety. Silence retires; love survives.
4. **One attentive hour a week.** Daily-habit features re-enter the lean-back war
   against Spotify, which lean-forward products demonstrably lose. The dark week is
   anticipation, not absence.
5. **Money never touches the queue.** No priority review, no paid feedback, no
   tip-the-curator. The instant artist money enters the pipeline, Crush Radio reads
   as a SubmitHub clone and the identity is unrecoverable. (Listener donations fund
   infra via short, bounded, transparent drives — never the submission path.)
6. **Glory only in the Hall.** No tokens, payouts, transferable rep, or paid
   placement attached to crush rank — Audius shows bots arrive the instant trending
   pays. The Hall of Crush stays unmonetizable on purpose.
7. **The cadence never slips.** Friday 8:00pm CT, not 8:07. Drop culture's documented
   failure mode is broken trust. A skipped week breaks the covenant with both sides.
8. **The promise stays literally true.** Every submitted track gets a full human
   listen and a yes/no before Friday — which is exactly why intake is capped. A
   promise that quietly degrades (the BBC pattern) is worse than a smaller promise
   kept. Publish the funnel every week: X submitted, N aired, crush rates, Hall
   entrants.

## What ships in Open Signal (this change)

**The artist pipeline, gated and receipted:**
- Upload a file **or submit by URL** (the Worker fetches the artist's own hosted
  file server-side). Both paths are magic-byte sniffed — the extension allowlist
  says what the artist claims; the bytes say what it is.
- **One track per artist per window** (make it your best — songfight/FAWM cohort
  logic) and a **global window cap** (default 100, KV-configurable): the
  listen-everything promise, enforced by arithmetic.
- **AI disclosure at upload** (DDEX framing: human / AI-assisted / fully-AI).
  97% of listeners can't distinguish fully-AI tracks by ear (Deezer/Ipsos), and
  Deezer receives ~75k fully-AI tracks/day as of April 2026 — the owner's ear
  catches quality, not provenance. Disclosure plus the optional artist link give
  the curator a provenance check for the ~25 shortlisted tracks: verify a human
  exists behind each selected track. Curation policy, not auto-rejection.
- Honeypot field, hourly fingerprint rate limit, rights attestation (no checkbox,
  no upload) — unchanged from the transmissions spec, now with teeth behind them.
- **Private status link** per track (`/track/:id/:token`): pool → selected (revealed
  only at publish — the email and the public setlist drop simultaneously) →
  crushed/retired/unjudged, with stats. No accounts; the link is the identity.

**The owner studio (`/studio?key=…`):**
- Audition players, select/order controls, one-click setlist lock, unlock
  (pre-publish only), emergency remove (rights/abuse/tech only — the one post-lock
  edit), notification outbox, certified results. Token in KV (`config:owner_token`);
  no accounts, no admin framework.
- **Auto-lock at Friday noon**: the cron locks whatever is selected if the owner
  hasn't. The curation contract holds even through an overslept alarm.

**Notifications (composition automated, delivery pluggable):**
- Selected / held / results emails composed into an idempotent outbox
  (unique per kind+transmission+track) at lock and certification.
- Delivery: Resend (free tier ≈3.5× worst-case volume) when `config:resend_key`
  exists in KV — with per-row `Idempotency-Key` so a crashed tick can never
  double-email an artist — otherwise one-click prefilled `mailto:` links in the
  studio. Manual is the *designed* degraded mode, not a hack.
- Send from a dedicated subdomain (`transmissions@` / `signal.crushradio.com`) once
  Resend is configured; never from a personal address (2025–26 DMARC enforcement).
  Keep these emails pure signal — no donation asks, no marketing — or they legally
  become bulk mail with unsubscribe obligations.

**The listener spine (first slice):**
- `.ics` add-to-calendar per transmission (UTC times, 30-minute VALARM) on the
  dark countdown, the published state, and the setlist page.
- Outbound **artist links** on the setlist, results, Hall of Crush, and studio —
  crush a track, find its maker. (`rel="noopener noreferrer nofollow ugc"`.)
- **Lock-screen-proof live player**: iOS suspends WebSockets and timers in pockets,
  so the client now self-advances from the wall clock and the published timed
  setlist; the socket is demoted to listener-counter and drift second-opinion;
  `visibilitychange` resyncs on wake; Media Session metadata puts the current
  artist/title on the lock screen. The schedule, not the connection, is the truth.

**The survival rule, hardened (internal change only):**
- Eligibility still gates on the signal floor (min plays/listeners/crushes).
- Among eligible tracks, survival rank is now the **Wilson score lower bound**
  (95% CI) of the crush fraction, not the raw rate. Raw rate lets a lucky 6-of-10
  beat a loved 40-of-100; Wilson defuses small-N flukes with zero surveillance and
  zero friction — and *embraces* the artist who brings 30 real friends, because 30
  genuine crushes tighten the bound. Public language is unchanged: "the top third
  survive."

## The roadmap (in dependency order, not calendar order)

**Before T001 airs (operational, owner):**
- Register the DMCA designated agent (copyright.gov, $6, expires every 3 years —
  calendar it), publish `/copyright` with the takedown + counter-notice process and
  the two-strike repeat-infringer policy. *An unenforced written policy is worse at
  trial than none (BMG v. Cox) — if a strike happens, follow the letter.*
- Note: the hand-picked Friday setlist is the operator's own publication, not
  user-directed storage (Mavrix v. LiveJournal) — verify the ~25 like a publisher.
  The studio's provenance check is that verification.
- Supply-side outreach: original-music communities are listening-starved, not
  scarce (r/ThisIsOurMusic 85k+ asking to be heard; r/IndieMusicFeedback enforces
  5:1 feedback ratios; Tiny Desk pulls 7,500 entries). The pitch is the unmet need:
  *"every track gets a full human listen and a yes/no by Friday; selected tracks
  air live to a synced room."* Post within each community's reciprocity rules.
  The intake cap makes a front-page accident survivable.

**T002 — the audio pipeline (the biggest unbuilt thing):**
- Client-side ffmpeg-wasm at upload (~3MB gzipped, in a web worker): transcode to a
  normalized mp3, two-pass loudness normalization to ~-14 LUFS (EBU R128 s2 —
  20–25 bedroom masters back-to-back is otherwise a volume rollercoaster),
  **extract true duration from the encoded file** (self-reported duration drives
  the sync clock; a lie desyncs every listener), and pre-render the 4:00 fade.
  Degraded mode: an owner-side script over the shortlist Thu–Fri.

**T002–T003 — the reminder spine, completed:**
- Recurring `webcal://` subscription feed (every Friday) — must use
  `DTSTART;TZID=America/Chicago` + `VTIMEZONE` + `RRULE`, never UTC Z times, or
  DST silently moves the station to 7pm for its most committed subscribers.
  (One-off per-transmission ICS files, like this change ships, are correctly UTC.)
- Opt-in listener email list (separate stream from artist transactional mail, with
  its own one-click unsubscribe): max three touches per cycle — setlist reveal,
  T-1h, T-0. Two-step soft-prompt web push at T-30/T-0. Never auto-prompt
  (~41% permanent-block rate kills the channel for the whole origin).
- "Get the signal" block as one unit with the countdown in every site state.

**T003+ — broadcast-moment community:**
- Ephemeral live chat on the player during the transmission only (WFMU's
  playlist-page model, curator present, transcript archived with the setlist).
  No persistent Discord until live chat visibly overflows — a 24/7 room around a
  weekly station feels dead six days a week.
- Turnstile on `/api/vote` (free, in-stack) as the one proportionate bot guard.
  Defer fingerprinting/vote-ring detection until the protocol opens or crush rank
  becomes extractable — at <500 listeners it's premature optimization. Never IP
  bans (carrier-grade NAT collateral).
- AcoustID/Chromaprint check on the ~25 shortlisted tracks pre-air (free
  non-commercial API, ~1,300 lookups/yr). Every hit gets a logged disposition —
  once a match is in front of you, ignoring it is red-flag knowledge. No
  enterprise fingerprinting; no scanning the whole pool (platform-thinking).

**T004+ — the protocol opens (scheduled, not aspirational):**
- The 6–8 week novelty cliff and single-curator burnout (Burgess quit after 3
  years of nightly hosting; balamii is one founder) are predictable. Plan the
  variation arc *before* transmission 6: themed transmissions, the first **guest
  curator** slot, a Hall of Crush retrospective opening each broadcast (the Hall
  needs scheduled life or "permanent" becomes "forgotten").
- A weekly one-line curator note ("what I'm listening for") keeps the human
  filter legible — opaque taste-gatekeeping is the #1 trust complaint against
  curation platforms.
- Health metric: repeat transmission attendance per listener cohort. Not signups —
  churn hides under signup growth (Fred Wilson's Turntable autopsy).
- Funding: one short "Signal Drive" per year with the real Cloudflare bill
  published on the page. plug.dj's 60k daily users yielding 2,900 payers is the
  cautionary tale: donations are bonus, never runway; perks deepen the ritual
  (name in the station's story) rather than discount anything.

## Review hardening (post-build adversarial pass)

A multi-agent review (bugs / security / races / spec) ran against the diff;
14 findings confirmed, all fixed and regression-tested before ship:

- **Selection secrecy is enforced at delivery, not just composition.**
  Selected/held emails carry `release_at = setlist_publish_at`; neither the
  Resend flush nor the studio mailto surface can release them early, so an
  owner who locks days before publish doesn't leak the setlist. The studio
  shows them as "holds until publish."
- **The live player can't loop on dead air.** When the setlist music ends
  before the broadcast window closes, the player shows a wrap-up card and
  waits for the window to close once — it no longer re-boots every tick
  (which would have been every listener hammering the server at the end of
  every broadcast).
- **Emergency removals reach the broadcast.** The Rotator replaces its
  stored show when the setlist content changes (not just the transmission
  id), the studio kicks it directly for sub-minute effect, and connected
  clients rebuild their timeline on a periodic refetch.
- **Survival math resists ballot-stuffing.** Crushes count only votes from a
  fingerprint that also qualified as a listener (≥ minListenSeconds), so
  rotating the User-Agent to mint fingerprints can't inflate the rank, and
  `crush_rate` can't exceed 1.
- **Notifications are crash-safe and idempotent.** Composed into the same
  atomic batch as the lock / certification they belong to; the outbox's
  unique index plus per-row idempotency key prevent double-sends.
- **Certification is re-run safe.** `last_rollover_tx` guards make the
  rollover/expire idempotent across overlapping cron ticks; held tracks roll
  once then expire (with a resubmit-invite email) instead of looping forever.
- **Intake caps and votes have constraint backstops.** One-track-per-artist
  is a `UNIQUE(artist_id, submission_window)` index, and votes a
  `UNIQUE(track_id, fingerprint)` — parallel requests can't slip the gates.
- **Submit-by-URL is SSRF-guarded.** https-only, private/loopback/link-local/
  CGNAT hosts rejected before any fetch, redirects followed manually and
  re-validated, a 10s timeout, and a generic error (no status oracle).

## Open questions (acknowledged, not blocking)

- **License grant wording** for the permanent Hall: the upload attestation should
  grow into an explicit perpetual non-exclusive grant covering the transmission +
  archive, plus the voluntary-removal path for an artist who later signs — decide
  the wording with the /copyright page work.
- **Listener accounting under the timeline player:** locked phones drop the socket,
  undercounting `unique_listeners` (denominator) — conservative, and locked phones
  can't vote either, so the bias is roughly symmetric. Revisit with T002 telemetry.
- **The 8pm thundering herd:** one Worker + one DO at the drop moment is the single
  load spike worth rehearsing before a big transmission. R2-egress-per-listener is
  already ~free; the DO socket fan-out is the thing to watch.
