// Crush Radio — Schedule a transmission
// Prints the SQL to insert (or reschedule) a transmission following the
// standard weekly cycle, with all timestamps converted from CT to UTC ms:
//   Mon 12:00 CT submissions open → Thu 20:00 close → Fri 12:00 publish
//   → Fri 20:00 broadcast → Fri 22:00 end → Sat 12:00 replay close
//
// Usage:
//   node scripts/schedule-transmission.mjs            # next upcoming cycle, T001
//   node scripts/schedule-transmission.mjs T002 2026-06-26   # explicit broadcast Friday
//
// Pipe the output to wrangler to apply:
//   node scripts/schedule-transmission.mjs | npx wrangler d1 execute crushradio --remote --command -

const TZ = "America/Chicago";

// UTC ms for a wall-clock time in TZ on a given calendar date.
function zonedUtcMs(year, month, day, hour, minute = 0) {
  // Two-pass: guess UTC, read back the wall clock in TZ, correct the diff.
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", hourCycle: "h23",
    }).formatToParts(new Date(guess));
    const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
    const actual = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
    const want = Date.UTC(year, month - 1, day, hour, minute);
    guess += want - actual;
  }
  return guess;
}

function nextFriday(from = new Date()) {
  const d = new Date(from);
  do {
    d.setUTCDate(d.getUTCDate() + 1);
  } while (d.getUTCDay() !== 5);
  return d;
}

// All slots derive from the broadcast Friday's CALENDAR date — Date.UTC
// normalizes d-4 / d+1 across month boundaries. Never subtract epoch ms:
// Fri 8pm CT is already Saturday in UTC, which skews day arithmetic.
function scheduleForFriday(y, m, d) {
  return {
    submission_open_at: zonedUtcMs(y, m, d - 4, 12), // Mon 12pm CT
    submission_close_at: zonedUtcMs(y, m, d - 1, 20), // Thu 8pm CT
    setlist_publish_at: zonedUtcMs(y, m, d, 12), // Fri 12pm CT
    broadcast_start_at: zonedUtcMs(y, m, d, 20), // Fri 8pm CT
    broadcast_end_at: zonedUtcMs(y, m, d, 22), // Fri 10pm CT
    replay_close_at: zonedUtcMs(y, m, d + 1, 12), // Sat 12pm CT
  };
}

const idArg = process.argv[2] || "T001";
const dateArg = process.argv[3];

let friday;
let schedule;
if (dateArg) {
  const [yy, mm, dd] = dateArg.split("-").map(Number);
  friday = new Date(Date.UTC(yy, mm - 1, dd));
  if (friday.getUTCDay() !== 5) {
    console.error(`-- WARNING: ${dateArg} is not a Friday; proceeding anyway.`);
  }
  schedule = scheduleForFriday(yy, mm, dd);
  if (schedule.submission_open_at <= Date.now()) {
    console.error(`-- WARNING: this cycle's submission window already opened; the site may skip states.`);
  }
} else {
  // Default to the next FULL cycle: a Friday whose Monday-noon submission
  // open is still in the future. (The nearest Friday often is not — its
  // window opened last Monday.)
  friday = nextFriday();
  for (;;) {
    schedule = scheduleForFriday(friday.getUTCFullYear(), friday.getUTCMonth() + 1, friday.getUTCDate());
    if (schedule.submission_open_at > Date.now()) break;
    friday = nextFriday(friday);
  }
}

const number = parseInt(idArg.replace(/^T/i, ""), 10) || 1;
const id = "T" + String(number).padStart(3, "0");
const nowMs = Date.now();

const ct = (ms) => new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "short", month: "short", day: "numeric",
  hour: "numeric", minute: "2-digit", timeZoneName: "short",
}).format(new Date(ms));

console.log(`-- ${id} schedule (presentation CT, stored UTC ms):`);
for (const [k, v] of Object.entries(schedule)) {
  console.log(`--   ${k.padEnd(20)} ${ct(v)}  (${v})`);
}
console.log(`INSERT INTO transmissions
  (id, number, submission_open_at, submission_close_at, setlist_publish_at,
   broadcast_start_at, broadcast_end_at, replay_close_at, setlist_json, created_at, updated_at)
VALUES ('${id}', ${number}, ${schedule.submission_open_at}, ${schedule.submission_close_at},
        ${schedule.setlist_publish_at}, ${schedule.broadcast_start_at}, ${schedule.broadcast_end_at},
        ${schedule.replay_close_at}, NULL, ${nowMs}, ${nowMs})
ON CONFLICT(id) DO UPDATE SET
  submission_open_at=excluded.submission_open_at,
  submission_close_at=excluded.submission_close_at,
  setlist_publish_at=excluded.setlist_publish_at,
  broadcast_start_at=excluded.broadcast_start_at,
  broadcast_end_at=excluded.broadcast_end_at,
  replay_close_at=excluded.replay_close_at,
  updated_at=excluded.updated_at;`);
