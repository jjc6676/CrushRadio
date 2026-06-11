// Crush Radio — client app
// Renders the transmission section of the home page from GET /api/state.
// Every view hangs off the derived station state. Demo mode for previewing
// any state without server data: append #demo=<state> to the URL, e.g.
//   /#demo=submissions_open  /#demo=live  /#demo=results  /#demo=dark
// Demo mode is purely client-side and clearly labeled.

(() => {
  "use strict";

  const root = document.getElementById("tx-root");
  const hallRoot = document.getElementById("hall-root");
  if (!root) return;

  const DEMO_STATES = [
    "dark", "submissions_open", "submissions_closed",
    "setlist_published", "live", "results",
  ];
  let skewMs = 0; // serverNow - clientNow
  let countdownTimer = null;
  let ws = null;
  let pollTimer = null;

  // --- tiny DOM helpers ---

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null) continue;
      node.append(c.nodeType ? c : document.createTextNode(c));
    }
    return node;
  }

  function now() {
    return Date.now() + skewMs;
  }

  function ct(ms, opts) {
    return new Intl.DateTimeFormat("en-US", Object.assign({
      timeZone: "America/Chicago",
      weekday: "long", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }, opts || {})).format(new Date(ms));
  }

  function remaining(targetMs) {
    let s = Math.max(0, Math.floor((targetMs - now()) / 1000));
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    const pad = (n) => String(n).padStart(2, "0");
    return (d > 0 ? d + "d " : "") + pad(h) + ":" + pad(m) + ":" + pad(s);
  }

  function countdown(label, targetMs, onZero) {
    const value = el("div", { class: "cd-value" }, remaining(targetMs));
    const box = el("div", { class: "cd" },
      el("div", { class: "cd-label" }, label),
      value,
      el("div", { class: "cd-when" }, ct(targetMs)));
    clearInterval(countdownTimer);
    countdownTimer = setInterval(() => {
      value.textContent = remaining(targetMs);
      if (targetMs - now() <= 0) {
        clearInterval(countdownTimer);
        if (onZero) setTimeout(onZero, 1500);
      }
    }, 1000);
    return box;
  }

  function kicker(text) {
    return el("div", { class: "tx-kicker" }, text);
  }

  function teardown() {
    clearInterval(countdownTimer);
    clearInterval(pollTimer);
    if (ws) { try { ws.close(); } catch {} ws = null; }
  }

  // --- entry ---

  async function boot() {
    teardown();
    const demo = (location.hash.match(/demo=([a-z_]+)/) || [])[1];
    if (demo && DEMO_STATES.includes(demo)) {
      renderDemo(demo);
      return;
    }
    let state;
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      state = await res.json();
    } catch {
      root.replaceChildren(kicker("Signal lost — refresh to retry."));
      return;
    }
    skewMs = (state.server_now_utc_ms || Date.now()) - Date.now();
    render(state);
    loadHall();
  }

  function render(state) {
    root.replaceChildren();
    const fn = {
      dark: renderDark,
      submissions_open: renderOpen,
      submissions_closed: renderClosed,
      setlist_published: renderPublished,
      live: renderLive,
      results: renderResults,
    }[state.state] || renderDark;
    fn(state);
  }

  // --- states ---

  function renderDark(state) {
    root.append(kicker("Station dark"));
    if (state.next_transition_at_utc_ms) {
      root.append(
        el("h2", { class: "tx-h" }, "The next transmission is coming."),
        countdown("Submissions open", state.next_transition_at_utc_ms, boot),
        el("p", { class: "tx-sub" },
          "Artists: get a track ready. One upload window, one curated setlist, one shared broadcast. ",
          el("b", {}, "The top third survive.")));
    } else {
      root.append(
        el("h2", { class: "tx-h" }, "Transmission 001 is being scheduled."),
        el("p", { class: "tx-sub" },
          "Weekly live broadcasts of original tracks. Between transmissions, the station goes dark. ",
          "Watch this space — or watch the commits below."));
    }
  }

  function renderOpen(state) {
    root.append(
      kicker("Submissions open — Transmission " + ((state.transmission_id || "T???").replace(/^T/, ""))),
      el("h2", { class: "tx-h" }, "Get on the setlist."),
      el("p", { class: "tx-sub" },
        el("b", {}, String(state.submission_count ?? 0)),
        " track" + ((state.submission_count === 1) ? "" : "s") + " in the pool. 20–25 make the broadcast. Originals only."),
      countdown("Submissions close", state.next_transition_at_utc_ms, boot),
      uploadForm());
  }

  function uploadForm() {
    const durationInput = el("input", { type: "hidden", name: "duration_s", value: "" });
    const status = el("p", { class: "form-status", role: "status" });
    const fileNote = el("span", { class: "file-note" }, "mp3 · m4a · aac · wav · flac · ogg — 50 MB max");

    const fileInput = el("input", {
      type: "file", name: "file", required: "",
      accept: ".mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*",
      onchange: (e) => {
        const f = e.target.files[0];
        if (!f) return;
        fileNote.textContent = f.name + " · probing duration…";
        const probe = new Audio();
        probe.preload = "metadata";
        probe.src = URL.createObjectURL(f);
        probe.onloadedmetadata = () => {
          durationInput.value = String(Math.round(probe.duration));
          fileNote.textContent = f.name + " · " + Math.floor(probe.duration / 60) + ":" +
            String(Math.round(probe.duration) % 60).padStart(2, "0") +
            (probe.duration > 240 ? " (fades at 4:00 on air)" : "");
          URL.revokeObjectURL(probe.src);
        };
        probe.onerror = () => {
          fileNote.textContent = f.name + " · could not read duration — is this an audio file?";
          durationInput.value = "";
        };
      },
    });

    const form = el("form", {
      class: "upload-form",
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector("button[type=submit]");
        if (!durationInput.value) {
          status.textContent = "Still reading the file — give it a second, or pick a different file.";
          return;
        }
        btn.disabled = true;
        btn.textContent = "Transmitting…";
        status.textContent = "";
        try {
          const res = await fetch("/api/upload", { method: "POST", body: new FormData(form) });
          const data = await res.json();
          if (res.ok && data.ok) {
            form.replaceChildren(
              el("p", { class: "form-success" }, "⏺ " + data.message),
              el("p", { class: "form-status" }, "Submit another? Refresh the page."));
          } else {
            status.textContent = data.error || "Upload failed — try again.";
            btn.disabled = false;
            btn.textContent = "Submit track";
          }
        } catch {
          status.textContent = "Network hiccup — try again.";
          btn.disabled = false;
          btn.textContent = "Submit track";
        }
      },
    },
      el("div", { class: "form-row" },
        field("Artist name", el("input", { type: "text", name: "artist_name", required: "", maxlength: "80", autocomplete: "name" })),
        field("Email (setlist notifications)", el("input", { type: "email", name: "email", required: "", maxlength: "254", autocomplete: "email" }))),
      el("div", { class: "form-row" },
        field("Track title", el("input", { type: "text", name: "title", required: "", maxlength: "120" })),
        field("Audio file", fileInput, fileNote)),
      durationInput,
      el("label", { class: "attest" },
        el("input", { type: "checkbox", name: "attestation", required: "" }),
        el("span", {}, "I own this recording or have the rights to submit it.")),
      el("button", { class: "btn-crush", type: "submit" }, "Submit track"),
      status);
    return form;

    function field(labelText, ...controls) {
      return el("label", { class: "field" }, el("span", { class: "field-label" }, labelText), ...controls);
    }
  }

  function renderClosed(state) {
    root.append(
      kicker("Submissions closed"),
      el("h2", { class: "tx-h" }, "Curation in progress."),
      el("p", { class: "tx-sub" }, "The pool is locked. The setlist is being cut — 20–25 tracks make the broadcast."),
      countdown("Setlist publishes", state.next_transition_at_utc_ms, boot));
  }

  async function renderPublished(state) {
    const num = (state.transmission_id || "").replace(/^T/, "");
    root.append(
      kicker("Setlist published — Transmission " + num),
      el("h2", { class: "tx-h" }, "Tonight. One broadcast. No skips."),
      countdown("Broadcast begins", state.next_transition_at_utc_ms, boot),
      el("p", { class: "tx-sub" },
        el("a", { class: "tx-link", href: "/transmissions/" + num.padStart(3, "0") },
          "See the full setlist →")));
    try {
      const res = await fetch("/api/transmissions/current");
      const data = await res.json();
      if (data.setlist && data.setlist.length) {
        root.append(setlistPreview(data.setlist));
      }
    } catch {}
  }

  function setlistPreview(setlist) {
    return el("ol", { class: "mini-setlist" },
      setlist.map((s) => el("li", {},
        el("span", { class: "pos" }, String(s.position).padStart(2, "0")),
        el("span", { class: "who" }, el("b", {}, s.artist), " — " + s.title))));
  }

  function renderLive(state, demoTrack) {
    const num = (state.transmission_id || "").replace(/^T/, "");
    const title = el("div", { class: "np-title" }, "Tuning…");
    const meta = el("div", { class: "np-meta" }, "");
    const listeners = el("span", { class: "np-listeners" }, "");
    const crushCount = el("span", { class: "crush-count" }, "");
    const audio = el("audio", { preload: "none" });
    const votedTracks = new Set();
    let currentTrack = null;

    const crushBtn = el("button", { class: "btn-crush big", disabled: "" }, "CRUSHED IT");
    crushBtn.addEventListener("click", async () => {
      if (!currentTrack || votedTracks.has(currentTrack)) return;
      crushBtn.disabled = true;
      try {
        const res = await fetch("/api/vote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ track_id: currentTrack }),
        });
        const data = await res.json();
        if (res.ok && data.ok) {
          votedTracks.add(currentTrack);
          crushBtn.textContent = "CRUSHED ⏺";
          crushCount.textContent = data.crushes + " crushes";
        } else {
          crushBtn.disabled = false;
        }
      } catch {
        crushBtn.disabled = false;
      }
    });

    const tuneBtn = el("button", { class: "btn-crush big" }, "▶ TUNE IN");
    const player = el("div", { class: "player" },
      el("div", { class: "np" }, title, meta),
      el("div", { class: "player-controls" }, tuneBtn, crushBtn, crushCount, listeners));

    tuneBtn.addEventListener("click", () => {
      audio.play().catch(() => {});
      tuneBtn.remove();
      crushBtn.disabled = !currentTrack;
    });

    root.append(
      kicker("● LIVE — Transmission " + num),
      el("h2", { class: "tx-h live" }, "On air now."),
      el("p", { class: "tx-sub" }, "Everyone is hearing this at the same moment. Tap CRUSHED IT on what deserves to survive — silence retires the rest."),
      player, audio);

    function applyNowPlaying(msg) {
      currentTrack = msg.track_id;
      title.textContent = msg.artist + " — " + msg.title;
      meta.textContent = "Track " + msg.position + " of " + msg.total;
      listeners.textContent = (msg.listeners || 1) + " tuned in";
      if (!votedTracks.has(currentTrack)) {
        crushBtn.textContent = "CRUSHED IT";
        crushBtn.disabled = !!tuneBtn.isConnected;
      } else {
        crushBtn.textContent = "CRUSHED ⏺";
        crushBtn.disabled = true;
      }
      const src = "/audio/" + msg.track_id;
      if (!audio.src.endsWith(src)) {
        audio.src = src;
        const sync = () => {
          audio.currentTime = Math.max(0, (now() - msg.started_at_ms) / 1000);
          audio.removeEventListener("loadedmetadata", sync);
        };
        audio.addEventListener("loadedmetadata", sync);
        if (!tuneBtn.isConnected) audio.play().catch(() => {});
      }
      pollVotes(msg.track_id);
    }

    function pollVotes(trackId) {
      clearInterval(pollTimer);
      const tick = async () => {
        try {
          const res = await fetch("/api/votes?track_id=" + encodeURIComponent(trackId));
          const data = await res.json();
          if (data.crushes != null) crushCount.textContent = data.crushes + " crushes";
        } catch {}
      };
      tick();
      pollTimer = setInterval(tick, 20000);
    }

    if (demoTrack) {
      applyNowPlaying(demoTrack);
      tuneBtn.disabled = true;
      crushBtn.disabled = true;
      return;
    }

    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    ws = new WebSocket(proto + location.host + "/ws");
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "now_playing") applyNowPlaying(msg);
      else if (msg.type === "off_air") boot();
      if (msg.listeners != null) listeners.textContent = msg.listeners + " tuned in";
    };
    ws.onclose = () => { setTimeout(() => { if (root.querySelector(".player")) boot(); }, 5000); };
  }

  async function renderResults(state, demoData) {
    const num = (state.transmission_id || "").replace(/^T/, "");
    root.append(
      kicker("Results — Transmission " + num),
      el("h2", { class: "tx-h" }, "The verdict is in."),
      el("p", { class: "tx-banner" }, "Voting closed. These are the live results from Friday."),
      countdown("Replay disappears", state.next_transition_at_utc_ms, boot));

    let data = demoData;
    if (!data) {
      try {
        const res = await fetch("/api/transmissions/current");
        data = await res.json();
      } catch { data = {}; }
    }
    const results = data.results || [];
    const setlist = data.setlist || [];

    if (results.length) {
      const label = { crushed: "CRUSHED", retired: "Retired", unjudged: "Unjudged" };
      root.append(el("table", { class: "results-table" },
        el("thead", {}, el("tr", {},
          ...["#", "Track", "Crushes", "Listeners", "Rate", "Verdict"].map((h) => el("th", {}, h)))),
        el("tbody", {},
          results.map((r) => el("tr", { class: "st-" + r.status },
            el("td", {}, r.rank == null ? "—" : String(r.rank)),
            el("td", {}, el("b", {}, r.artist), " — " + r.title),
            el("td", {}, String(r.crushes)),
            el("td", {}, String(r.unique_listeners)),
            el("td", {}, Math.round(r.crush_rate * 100) + "%"),
            el("td", { class: "verdict" }, label[r.status] || r.status))))));
    } else {
      root.append(el("p", { class: "tx-sub" }, "Results are being certified — check back in a minute."));
    }

    // On-demand replay: the full ordered playlist, voting dead, totals overlaid.
    if (setlist.length && !demoData) {
      const replayBtn = el("button", { class: "btn-crush" }, "▶ Play the replay");
      const replayStatus = el("span", { class: "np-meta" }, "");
      const audio = el("audio", { preload: "none" });
      let idx = -1;
      const byId = new Map(results.map((r) => [r.track_id, r]));
      const playNext = () => {
        idx += 1;
        if (idx >= setlist.length) { replayStatus.textContent = "Replay complete."; return; }
        const s = setlist[idx];
        const r = byId.get(s.track_id);
        audio.src = "/audio/" + s.track_id;
        audio.play().catch(() => {});
        replayStatus.textContent = String(s.position).padStart(2, "0") + " · " + s.artist + " — " + s.title +
          (r ? " · " + r.crushes + " crushes" : "");
      };
      audio.addEventListener("ended", playNext);
      audio.addEventListener("error", playNext);
      replayBtn.addEventListener("click", () => { replayBtn.disabled = true; playNext(); });
      root.append(el("div", { class: "replay" }, replayBtn, replayStatus, audio));
    }

    if (num) {
      root.append(el("p", { class: "tx-sub" },
        el("a", { class: "tx-link", href: "/transmissions/" + num.padStart(3, "0") }, "Full results page →")));
    }
  }

  // --- Hall of Crush ---

  async function loadHall() {
    if (!hallRoot) return;
    let hall = [];
    try {
      const res = await fetch("/api/hall");
      hall = (await res.json()).hall || [];
    } catch {}
    if (!hall.length) { hallRoot.replaceChildren(); return; }

    const audio = el("audio", { preload: "none" });
    hallRoot.replaceChildren(
      el("div", { class: "section-head" },
        el("div", { class: "h" }, "Hall of ", el("em", {}, "Crush")),
        el("div", { class: "id" }, hall.length + " survivor" + (hall.length === 1 ? "" : "s"))),
      el("ul", { class: "rows" },
        hall.map((h) => {
          const btn = el("button", { class: "hall-play", "aria-label": "Play " + h.title }, "▶");
          btn.addEventListener("click", () => {
            const src = "/audio/" + h.track_id;
            if (audio.src.endsWith(src) && !audio.paused) { audio.pause(); btn.textContent = "▶"; return; }
            hallRoot.querySelectorAll(".hall-play").forEach((b) => (b.textContent = "▶"));
            audio.src = src;
            audio.play().catch(() => {});
            btn.textContent = "⏸";
          });
          return el("li", { class: "row hall-row" },
            btn,
            el("span", { class: "row-msg" }, el("b", {}, h.artist), " — " + h.title),
            el("span", { class: "row-meta" }, h.transmission_id + " · " + h.crushes + " crushes"));
        })),
      audio);
  }

  // --- Demo mode ---

  function renderDemo(state) {
    const t = now();
    const banner = el("div", { class: "demo-banner" },
      "DEMO MODE — simulated ", el("b", {}, state.replace(/_/g, " ")),
      " · real data untouched · ",
      ...DEMO_STATES.map((s, i) => [
        i ? " " : "",
        el("a", { href: "#demo=" + s, class: s === state ? "demo-on" : "" }, s.replace(/_/g, " ")),
      ]),
      " · ", el("a", { href: "#", onclick: () => setTimeout(boot, 50) }, "exit"));
    root.replaceChildren(banner);

    const fake = {
      dark: { state: "dark", transmission_id: "T001", next_transition_at_utc_ms: t + 36e5 * 60 },
      submissions_open: { state: "submissions_open", transmission_id: "T001", submission_count: 17, next_transition_at_utc_ms: t + 36e5 * 30 },
      submissions_closed: { state: "submissions_closed", transmission_id: "T001", next_transition_at_utc_ms: t + 36e5 * 12 },
      setlist_published: { state: "setlist_published", transmission_id: "T001", next_transition_at_utc_ms: t + 36e5 * 6 },
      live: { state: "live", transmission_id: "T001", next_transition_at_utc_ms: t + 36e5 * 1.5 },
      results: { state: "results", transmission_id: "T001", next_transition_at_utc_ms: t + 36e5 * 10 },
    }[state];

    if (state === "live") {
      renderLive(fake, {
        track_id: "demo", artist: "Static Bloom", title: "Copper Wires",
        position: 7, total: 22, listeners: 143, started_at_ms: t - 45000, duration_s: 240,
      });
    } else if (state === "results") {
      renderResults(fake, {
        results: [
          { rank: 1, artist: "Static Bloom", title: "Copper Wires", crushes: 61, unique_listeners: 122, crush_rate: 0.5, status: "crushed", track_id: "d1" },
          { rank: 2, artist: "Vel Mara", title: "Glasshouse", crushes: 44, unique_listeners: 117, crush_rate: 0.376, status: "crushed", track_id: "d2" },
          { rank: 3, artist: "Crowtalk", title: "Night Shift", crushes: 30, unique_listeners: 109, crush_rate: 0.275, status: "retired", track_id: "d3" },
          { rank: null, artist: "Hollow Pines", title: "Driveway", crushes: 2, unique_listeners: 8, crush_rate: 0.25, status: "unjudged", track_id: "d4" },
        ],
      });
    } else if (state === "setlist_published") {
      renderPublished(fake);
      root.append(setlistPreview([
        { position: 1, artist: "Static Bloom", title: "Copper Wires" },
        { position: 2, artist: "Vel Mara", title: "Glasshouse" },
        { position: 3, artist: "Crowtalk", title: "Night Shift" },
      ]));
    } else {
      ({ dark: renderDark, submissions_open: renderOpen, submissions_closed: renderClosed })[state](fake);
    }
    root.prepend(banner);
  }

  window.addEventListener("hashchange", boot);
  boot();
})();
