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
    updateNav(state.state);
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

  // The jump-nav "Listen" link adapts to what's actually happening, so on a
  // long mobile scroll the top link always names the current action.
  function updateNav(stateName) {
    const txLink = document.querySelector('.jump a[data-nav="tx"]');
    if (!txLink) return;
    const label = {
      submissions_open: "Submit",
      submissions_closed: "Listen",
      setlist_published: "Setlist",
      live: "Tune in",
      results: "Results",
      dark: "Listen",
    }[stateName] || "Listen";
    txLink.textContent = label;
    txLink.classList.toggle("is-live", stateName === "live");
  }

  // --- states ---

  function renderDark(state) {
    root.append(kicker("Station dark"));
    if (state.next_transition_at_utc_ms) {
      const num = (state.transmission_id || "").replace(/^T/, "");
      root.append(
        el("h2", { class: "tx-h" }, "The next transmission is coming."),
        countdown("Submissions open", state.next_transition_at_utc_ms, boot),
        el("p", { class: "tx-sub" },
          "Artists: get a track ready. One upload window, one curated setlist, one shared broadcast. ",
          el("b", {}, "The top third survive.")),
        num
          ? el("p", { class: "tx-sub" },
              el("a", { class: "tx-link", href: "/transmissions/" + num.padStart(3, "0") + ".ics" },
                "+ Put the broadcast on your calendar"))
          : null);
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
    const manualDuration = el("input", {
      type: "text", placeholder: "track length, e.g. 3:42", maxlength: "8",
      oninput: (e) => {
        const m = /^(\d{1,2}):([0-5]\d)$/.exec(e.target.value.trim());
        durationInput.value = m ? String(parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : "";
      },
    });
    const manualWrap = el("div", { class: "field", style: "display:none" },
      el("span", { class: "field-label" }, "Duration (for linked tracks)"), manualDuration);

    const fileInput = el("input", {
      type: "file", name: "file",
      accept: ".mp3,.m4a,.aac,.wav,.flac,.ogg,audio/*",
      onchange: (e) => {
        const f = e.target.files[0];
        if (!f) return;
        urlInput.value = "";
        manualWrap.style.display = "none";
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

    // Submit-by-link: the Worker fetches the file server-side. The browser
    // can't probe a cross-origin file's duration, so the artist types it.
    const urlInput = el("input", {
      type: "url", name: "track_url", maxlength: "300",
      placeholder: "https://… direct link to the audio file",
      oninput: (e) => {
        const has = e.target.value.trim() !== "";
        manualWrap.style.display = has ? "" : "none";
        if (has) { fileInput.value = ""; durationInput.value = ""; manualDuration.dispatchEvent(new Event("input")); }
      },
    });

    const form = el("form", {
      class: "upload-form",
      onsubmit: async (e) => {
        e.preventDefault();
        const btn = form.querySelector("button[type=submit]");
        const usingUrl = urlInput.value.trim() !== "";
        if (!usingUrl && !(fileInput.files && fileInput.files[0])) {
          status.textContent = "Attach an audio file or paste a direct link to one.";
          return;
        }
        if (!durationInput.value) {
          status.textContent = usingUrl
            ? "Enter the track length (like 3:42) so the broadcast clock works."
            : "Still reading the file — give it a second, or pick a different file.";
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
              data.status_url
                ? el("p", { class: "form-status" },
                    "Your private status link — bookmark it: ",
                    el("a", { class: "tx-link", href: data.status_url }, location.origin + data.status_url))
                : null,
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
        field("Artist link (optional — shown on the setlist)", el("input", { type: "url", name: "artist_url", maxlength: "200", placeholder: "https://yourname.bandcamp.com" }))),
      el("div", { class: "form-row" },
        field("Audio file", fileInput, fileNote),
        field("…or link the file directly", urlInput,
          el("span", { class: "file-note" }, "your own hosting — we fetch and store a copy"))),
      el("div", { class: "form-row" },
        manualWrap,
        field("Made by", el("select", { name: "ai_disclosure" },
          el("option", { value: "human" }, "Humans — performed and produced"),
          el("option", { value: "ai_assisted" }, "Humans, with AI assistance"),
          el("option", { value: "fully_ai" }, "Fully AI-generated")))),
      durationInput,
      // Honeypot — humans never see it, bots autofill it.
      el("input", { type: "text", name: "website", value: "", tabindex: "-1", autocomplete: "off", "aria-hidden": "true", style: "position:absolute;left:-5000px;height:0;width:0;opacity:0" }),
      el("label", { class: "attest" },
        el("input", { type: "checkbox", name: "attestation", required: "" }),
        el("span", {}, "I own this recording or have the rights to submit it.")),
      el("p", { class: "file-note", style: "margin:-8px 0 14px" },
        "Originals only. By submitting you agree to the ",
        el("a", { href: "/copyright", target: "_blank", rel: "noopener", style: "color:var(--ink-dim)" }, "rights terms"),
        "."),
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
          "See the full setlist →"),
        "  ·  ",
        el("a", { class: "tx-link", href: "/transmissions/" + num.padStart(3, "0") + ".ics" },
          "+ Add to calendar")));
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

  // The live player self-advances from the wall clock and the published
  // timed setlist — iOS suspends WebSockets and timers when the screen
  // locks, so the socket is only a listener counter and a drift check.
  // The schedule, not the connection, is the source of truth.
  async function renderLive(state, demoTrack) {
    const num = (state.transmission_id || "").replace(/^T/, "");
    const title = el("div", { class: "np-title" }, "Tuning…");
    const meta = el("div", { class: "np-meta" }, "");
    const listeners = el("span", { class: "np-listeners" }, "");
    const crushCount = el("span", { class: "crush-count" }, "");
    const audio = el("audio", { preload: "none" });
    const votedTracks = new Set();
    let currentTrack = null;
    let timeline = null; // [{track_id,title,artist,position,total,start_ms,end_ms}]
    let broadcastEnd = null;
    let endHandled = false;
    let liveTick = 0;

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
      syncToSchedule(true);
    });

    root.append(
      kicker("● LIVE — Transmission " + num),
      el("h2", { class: "tx-h live" }, "On air now."),
      el("p", { class: "tx-sub" }, "Everyone is hearing this at the same moment. Tap CRUSHED IT on what deserves to survive — silence retires the rest."),
      player, audio);

    function applySlot(slot) {
      currentTrack = slot.track_id;
      title.textContent = slot.artist + " — " + slot.title;
      meta.textContent = "Track " + slot.position + " of " + slot.total;
      if (!votedTracks.has(currentTrack)) {
        crushBtn.textContent = "CRUSHED IT";
        crushBtn.disabled = !!tuneBtn.isConnected;
      } else {
        crushBtn.textContent = "CRUSHED ⏺";
        crushBtn.disabled = true;
      }
      if ("mediaSession" in navigator) {
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: slot.title,
            artist: slot.artist,
            album: "Crush Radio — Transmission " + num,
          });
        } catch {}
      }
      pollVotes(slot.track_id);
    }

    // force=true re-seeks even within the same slot (tune-in, wake-up).
    function syncToSchedule(force) {
      if (!timeline) return;
      const t = now();
      const slot = timeline.find((s) => t >= s.start_ms && t < s.end_ms);
      if (!slot) {
        // Past the last track but the broadcast window is still open = dead
        // air (setlist music < 2h). Show a wrap-up card and wait for the
        // window to actually close — do NOT boot() in a tight loop (that was
        // every listener hammering /api/state at end of every broadcast).
        if (t >= timeline[timeline.length - 1].end_ms && !endHandled) {
          endHandled = true;
          clearInterval(countdownTimer);
          clearInterval(pollTimer);
          try { audio.pause(); } catch {}
          currentTrack = null;
          crushBtn.disabled = true;
          title.textContent = "That was the last track.";
          meta.textContent = "Results post when the window closes.";
          setTimeout(boot, Math.max(0, (broadcastEnd || t) - now()) + 1500);
        }
        return;
      }
      const slotChanged = slot.track_id !== currentTrack;
      if (slotChanged) applySlot(slot);
      const src = "/audio/" + slot.track_id;
      if (!audio.src.endsWith(src)) {
        audio.src = src;
        const seek = () => {
          audio.currentTime = Math.max(0, (now() - slot.start_ms) / 1000);
          audio.removeEventListener("loadedmetadata", seek);
        };
        audio.addEventListener("loadedmetadata", seek);
        if (!tuneBtn.isConnected) audio.play().catch(() => {});
      } else if (force || Math.abs(audio.currentTime - (t - slot.start_ms) / 1000) > 3) {
        // Drifted (tab slept, buffer stall) — snap back to the broadcast.
        audio.currentTime = Math.max(0, (t - slot.start_ms) / 1000);
        if (!tuneBtn.isConnected) audio.play().catch(() => {});
      }
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
      timeline = [{
        track_id: demoTrack.track_id, title: demoTrack.title, artist: demoTrack.artist,
        position: demoTrack.position, total: demoTrack.total,
        start_ms: demoTrack.started_at_ms, end_ms: demoTrack.started_at_ms + demoTrack.duration_s * 1000,
      }];
      applySlot(timeline[0]);
      listeners.textContent = (demoTrack.listeners || 1) + " tuned in";
      tuneBtn.disabled = true;
      crushBtn.disabled = true;
      return;
    }

    // Build the timed setlist from the published schedule.
    if (!(await rebuildTimeline())) {
      title.textContent = "Setlist unavailable — refresh to retry.";
      return;
    }

    // Re-fetch the schedule and rebuild if the setlist changed underneath us
    // (an emergency removal mid-broadcast). Returns false if nothing usable.
    async function rebuildTimeline() {
      try {
        const res = await fetch("/api/transmissions/current", { cache: "no-store" });
        const data = await res.json();
        const setlist = data.setlist || [];
        if (!setlist.length || !data.transmission) return false;
        broadcastEnd = data.transmission.broadcast_end_at;
        const sig = setlist.map((s) => s.track_id).join(",");
        const oldSig = timeline ? timeline.map((s) => s.track_id).join(",") : null;
        if (sig === oldSig) return true;
        let cursor = data.transmission.broadcast_start_at;
        timeline = setlist.map((s) => {
          const start_ms = cursor;
          const end_ms = Math.min(cursor + s.duration_s * 1000, broadcastEnd);
          cursor = end_ms;
          return { ...s, total: setlist.length, start_ms, end_ms };
        });
        endHandled = false;
        return true;
      } catch {
        return !!(timeline && timeline.length);
      }
    }

    const liveTimer = setInterval(() => {
      syncToSchedule(false);
      if (++liveTick % 45 === 0) rebuildTimeline().then((ok) => ok && syncToSchedule(true));
    }, 1000);
    countdownTimer = liveTimer; // teardown handle (teardown clears countdownTimer)
    syncToSchedule(false);

    // Self-removing wake-up resync, bound to THIS player node (a stale
    // listener from a re-render would otherwise never detach).
    const playerNode = player;
    document.addEventListener("visibilitychange", function onVis() {
      if (!playerNode.isConnected) {
        document.removeEventListener("visibilitychange", onVis);
        return;
      }
      if (!document.hidden) syncToSchedule(true);
    });

    // The socket is presence + a second opinion, not the clock.
    const proto = location.protocol === "https:" ? "wss://" : "ws://";
    try {
      ws = new WebSocket(proto + location.host + "/ws");
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.listeners != null) listeners.textContent = msg.listeners + " tuned in";
      };
    } catch {}
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
    const hallLink = document.querySelector('.jump a[data-nav="hall"]');
    if (hallLink) hallLink.hidden = !hall.length; // nav link only when there are survivors
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
            el("span", { class: "row-msg" },
              el("b", {}, h.artist), " — " + h.title,
              h.artist_url
                ? el("a", { href: h.artist_url, target: "_blank", rel: "noopener noreferrer nofollow", style: "margin-left:10px;font-size:11px" }, "artist↗")
                : null),
            el("span", { class: "row-meta" }, h.transmission_id + " · " + h.crushes + " crushes"));
        })),
      audio);
  }

  // --- Demo mode ---

  function renderDemo(state) {
    const t = now();
    updateNav(state);
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

  // Re-render only for demo toggles / exit — NOT for the jump-nav section
  // anchors (#tx-root, #hall-root, #code), which the browser scrolls to.
  window.addEventListener("hashchange", () => {
    const h = location.hash;
    if (h === "" || h === "#" || /demo=/.test(h)) boot();
  });
  boot();
})();
