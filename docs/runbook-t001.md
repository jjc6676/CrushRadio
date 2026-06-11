# T001 Owner Runbook

Everything the owner does by hand for Transmission 001. Curation is
CLI/SQL by design — a real admin UI is deferred until this is painful.
All SQL runs through `npx wrangler d1 execute crushradio --remote --command "<sql>"`
(drop `--remote` for local dev).

## 1. Schedule the transmission

```bash
npm run tx:schedule                       # next upcoming Friday cycle, T001
npm run tx:schedule -- T002 2026-06-26    # explicit transmission + broadcast Friday
```

The script prints the schedule in CT for sanity plus an idempotent
`INSERT ... ON CONFLICT` statement. Apply it:

```bash
node scripts/schedule-transmission.mjs | npx wrangler d1 execute crushradio --remote --command -
```

The site flips to `submissions_open` automatically at Mon 12pm CT — state
is derived from the timestamps, nothing else to turn on.

## 2. Curate (Thu 8pm → Fri 12pm CT)

See the pool:

```sql
SELECT t.id, a.name, t.title, t.duration_s, t.flag_count, t.rollover_count
FROM tracks t JOIN artists a ON a.id = t.artist_id
WHERE t.track_status = 'held'
ORDER BY t.uploaded_at;
```

Listen to a candidate: tracks are in R2 at the `filename` key —
`npx wrangler r2 object get crushradio-audio/tracks/<id>.mp3 --file out.mp3`.
Review the rights attestation issues: anything with `flag_count > 0` gets a
look before selection.

Select 20–25 tracks (max 4 min each counts toward air time):

```sql
UPDATE tracks SET track_status = 'selected' WHERE id IN ('<id1>', '<id2>', ...);
```

## 3. Lock the setlist (before Fri 12pm CT)

Write the curated order into `setlist_json`. Order the array exactly as
the broadcast should run:

```sql
UPDATE transmissions SET setlist_json = (
  SELECT json_group_array(json_object('position', rn, 'track_id', id))
  FROM (
    SELECT t.id, ROW_NUMBER() OVER (ORDER BY t.uploaded_at) AS rn
    FROM tracks t WHERE t.track_status = 'selected'
  )
), updated_at = strftime('%s','now') * 1000
WHERE id = 'T001';
```

(Or hand-write the JSON for a deliberate order: `[{"position":1,"track_id":"..."}, ...]` —
titles/artists/durations are joined from D1 at broadcast time, so only
`position` and `track_id` matter here.)

The setlist page goes public at Fri 12pm CT automatically:
`crushradio.com/transmissions/001`, with `#artist-slug` deep links per slot.

## 4. Notify artists (Fri 12pm CT — manual Gmail for T001)

```sql
-- Selected
SELECT a.name, a.email, t.title FROM tracks t JOIN artists a ON a.id = t.artist_id
WHERE t.track_status = 'selected';
-- Held for a future transmission
SELECT a.name, a.email, t.title FROM tracks t JOIN artists a ON a.id = t.artist_id
WHERE t.track_status = 'held';
```

Selected artists get their promo line:
*"I'm transmitting on Crush Radio tonight. Friday 8pm CT."* plus their
deep link `crushradio.com/transmissions/001#<artist-slug>`.

## 5. Broadcast night (Fri 8pm CT) — touch nothing

The cron kicks the Rotator at 8:00pm, the setlist plays in order, votes
land via `/api/vote`. If the DO restarts it re-syncs from the wall clock.
Owner's job: tune in like everyone else.

**Emergency setlist removal** (rights violation / abuse / technical
failure only — the only post-lock edit allowed):

```sql
UPDATE tracks SET track_status = 'held' WHERE id = '<track-id>';
-- then remove its entry from transmissions.setlist_json and renumber positions
```

## 6. Certification (Fri 10pm CT — automatic)

Within a minute of `broadcast_end_at` the cron computes eligibility and
crush rate, writes `transmission_results`, and flips each track to
`crushed` / `retired` / `unjudged`. Verify:

```sql
SELECT track_id, status, rank, crushes, unique_listeners,
       ROUND(crush_rate * 100) AS pct
FROM transmission_results WHERE transmission_id = 'T001' ORDER BY rank;
```

**Escape valve** — if attendance was too small and everything came back
`unjudged`, the owner may manually certify winners (T001 only):

```sql
UPDATE transmission_results SET status = 'crushed', rank = 1
WHERE transmission_id = 'T001' AND track_id = '<track-id>';
UPDATE tracks SET track_status = 'crushed', status = 'crushed' WHERE id = '<track-id>';
```

## 7. After (Sat 12pm CT)

Replay disappears and the station goes dark on its own. The Hall of Crush
stays up forever. Schedule T002 (step 1) whenever ready.

## Testing states locally

```bash
npm run db:schema:local && npm run db:seed:local && npm run dev
```

The seed opens T001 submissions one hour in the past. Time-travel by
shifting the row, e.g. jump to the live window:

```sql
UPDATE transmissions SET
  submission_open_at  = strftime('%s','now')*1000 - 96*3600000,
  submission_close_at = strftime('%s','now')*1000 - 24*3600000,
  setlist_publish_at  = strftime('%s','now')*1000 -  8*3600000,
  broadcast_start_at  = strftime('%s','now')*1000 -      60000,
  broadcast_end_at    = strftime('%s','now')*1000 + 2*3600000,
  replay_close_at     = strftime('%s','now')*1000 + 16*3600000
WHERE id = 'T001';
```

(Local cron doesn't fire on a timer — trigger it once with
`curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"` after starting
`wrangler dev --test-scheduled`.)

The six UI states can also be previewed with zero data via demo mode:
`/#demo=dark`, `/#demo=submissions_open`, `/#demo=submissions_closed`,
`/#demo=setlist_published`, `/#demo=live`, `/#demo=results`.
