// Crush Radio — Studio client wiring
// Buttons → POST /api/studio/<action>?key=… → reload. The key rides the
// query string, same as the page itself; requireOwner checks it server-side.

(() => {
  "use strict";

  const key = document.body.dataset.key || "";

  function api(action, body) {
    return fetch(`/api/studio/${action}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Request failed");
      return data;
    });
  }

  let toastTimer;
  function toast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.style.display = "none"), 4000);
  }

  document.querySelectorAll(".curate-sel").forEach((cb) =>
    cb.addEventListener("change", (e) => {
      const trackId = e.target.closest("tr").dataset.track;
      const checked = e.target.checked;
      api("curate", { track_id: trackId, selected: checked })
        .then(() => location.reload())
        .catch((err) => {
          toast(err.message);
          e.target.checked = !checked;
        });
    })
  );

  document.querySelectorAll(".curate-pos").forEach((inp) =>
    inp.addEventListener("change", (e) => {
      const trackId = e.target.closest("tr").dataset.track;
      const v = e.target.value.trim();
      api("curate", { track_id: trackId, position: v === "" ? null : parseInt(v, 10) })
        .then(() => toast("Position saved — applies at lock."))
        .catch((err) => toast(err.message));
    })
  );

  const lockBtn = document.getElementById("lock");
  if (lockBtn)
    lockBtn.addEventListener("click", () => {
      lockBtn.disabled = true;
      api("lock")
        .then(() => location.reload())
        .catch((err) => {
          toast(err.message);
          lockBtn.disabled = false;
        });
    });

  const unlockBtn = document.getElementById("unlock");
  if (unlockBtn)
    unlockBtn.addEventListener("click", () => {
      api("unlock")
        .then(() => location.reload())
        .catch((err) => toast(err.message));
    });

  document.querySelectorAll(".emergency-remove").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (
        !confirm(
          "Emergency removal is for rights violations, abuse, or technical failure ONLY — it is the one allowed post-lock edit. The track returns to held. Proceed?"
        )
      )
        return;
      api("remove", { track_id: btn.dataset.track })
        .then(() => location.reload())
        .catch((err) => toast(err.message));
    })
  );

  document.querySelectorAll(".mark-sent").forEach((btn) =>
    btn.addEventListener("click", () => {
      api("notify", { id: btn.dataset.id })
        .then(() => location.reload())
        .catch((err) => toast(err.message));
    })
  );
})();
