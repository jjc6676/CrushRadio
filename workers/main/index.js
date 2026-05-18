// Crush Radio — Main Worker
// Routes:
//   /           → coming-soon page (HOME_HTML inlined at build time)
//   /code       → live GitHub feed (commits + PRs + issues)
//   /ws         → WebSocket upgrade → Rotator Durable Object
//   /api/status → Rotator now-playing JSON (for debugging / Plan 2 prep)
//   /api/*      → 404 stub (real endpoints land in Plan 2)
//   /robots.txt → robots
//
// HOME_HTML is replaced at build time by the build script. Do not hand-edit.

export { Rotator } from "../../rotator/index.js";

const HOME_HTML = `__HTML__`;

const REPO_OWNER = "jjc6676";
const REPO_NAME = "crushradio";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    // --- WebSocket → Rotator DO ---
    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const id = env.ROTATOR.idFromName("global");
      const stub = env.ROTATOR.get(id);
      return stub.fetch(request);
    }

    // --- API: now-playing debug ---
    if (path === "/api/status") {
      const id = env.ROTATOR.idFromName("global");
      const stub = env.ROTATOR.get(id);
      const statusUrl = new URL("/status", request.url);
      return stub.fetch(new Request(statusUrl, request));
    }

    if (path.startsWith("/api/")) {
      return new Response(
        JSON.stringify({ error: "Not implemented — coming in Plan 2" }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }

    // --- Static / page routes ---
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

// --- /code page (ported verbatim from legacy worker.js) ---

async function renderCodePage() {
  const headers = {
    "User-Agent": "crushradio-site",
    "Accept": "application/vnd.github+json",
  };
  const cf = { cacheTtl: 300, cacheEverything: true };

  const [repoRes, commitsRes, pullsRes, issuesRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`, { headers, cf }),
    fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits?per_page=10`, { headers, cf }),
    fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/pulls?state=open&per_page=10`, { headers, cf }),
    fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/issues?state=open&per_page=10`, { headers, cf }),
  ]);

  const repo = repoRes.ok ? await repoRes.json() : null;
  const commits = commitsRes.ok ? await commitsRes.json() : [];
  const pullsRaw = pullsRes.ok ? await pullsRes.json() : [];
  const issuesRaw = issuesRes.ok ? await issuesRes.json() : [];
  const issues = Array.isArray(issuesRaw) ? issuesRaw.filter(i => !i.pull_request) : [];
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
  const desc = repoExists ? escapeHtml(repo.description || "An open-source community radio station.") : "Repo is being initialized. Check back in a sec.";
  const stars = repoExists ? repo.stargazers_count : 0;
  const forks = repoExists ? repo.forks_count : 0;
  const watchers = repoExists ? repo.subscribers_count : 0;
  const license = repoExists && repo.license ? escapeHtml(repo.license.spdx_id || repo.license.name) : "MIT";
  const defaultBranch = repoExists ? escapeHtml(repo.default_branch) : "main";
  const lastPush = repoExists ? timeAgo(repo.pushed_at) : "—";
  const openIssuesCount = repoExists ? Math.max(0, (repo.open_issues_count || 0) - pulls.length) : issues.length;

  const commitRows = (commits && commits.length) ? commits.map(c => {
    const msg = (c.commit && c.commit.message ? c.commit.message.split("\n")[0] : "");
    const author = c.author && c.author.login ? c.author.login : (c.commit && c.commit.author ? c.commit.author.name : "—");
    const when = c.commit && c.commit.author ? timeAgo(c.commit.author.date) : "";
    const sha = c.sha ? c.sha.slice(0, 7) : "";
    const url = c.html_url || "#";
    return `
      <li class="row">
        <a class="row-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">
          <span class="row-sha">${escapeHtml(sha)}</span>
          <span class="row-msg">${escapeHtml(msg)}</span>
          <span class="row-meta">${escapeHtml(author)} · ${escapeHtml(when)}</span>
        </a>
      </li>`;
  }).join("") : `<li class="row empty">No commits yet — repo is still warming up.</li>`;

  const prRows = (pulls && pulls.length) ? pulls.map(pr => `
      <li class="row">
        <a class="row-link" href="${escapeHtml(pr.html_url)}" target="_blank" rel="noopener">
          <span class="row-sha">#${pr.number}</span>
          <span class="row-msg">${escapeHtml(pr.title)}</span>
          <span class="row-meta">${escapeHtml(pr.user && pr.user.login ? pr.user.login : "")} · opened ${escapeHtml(timeAgo(pr.created_at))}</span>
        </a>
      </li>`).join("") : `<li class="row empty">No open pull requests. <a href="${REPO_URL}/compare" target="_blank" rel="noopener" style="color:var(--red)">Open one →</a></li>`;

  const issueRows = (issues && issues.length) ? issues.map(it => `
      <li class="row">
        <a class="row-link" href="${escapeHtml(it.html_url)}" target="_blank" rel="noopener">
          <span class="row-sha">#${it.number}</span>
          <span class="row-msg">${escapeHtml(it.title)}</span>
          <span class="row-meta">${escapeHtml(it.user && it.user.login ? it.user.login : "")} · opened ${escapeHtml(timeAgo(it.created_at))}</span>
        </a>
      </li>`).join("") : `<li class="row empty">No open issues. <a href="${REPO_URL}/issues/new" target="_blank" rel="noopener" style="color:var(--red)">File one →</a></li>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Crush Radio — the code</title>
<meta name="description" content="Crush Radio is built in the open on GitHub. Live feed of recent commits, open pull requests, and issues.">
<meta name="theme-color" content="#0a0a0a">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Anton&family=Archivo+Black&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root{--bg:#0a0a0a;--ink:#f3ece0;--ink-dim:#8a8278;--red:#ef2b2b;--red-deep:#b81818;--rule:#222;--gutter:clamp(20px,4vw,56px)}
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;background:var(--bg);color:var(--ink);-webkit-font-smoothing:antialiased}
  body{font-family:'JetBrains Mono',ui-monospace,monospace;font-size:14px;line-height:1.5;overflow-x:hidden;background:radial-gradient(ellipse 80% 60% at 70% 30%,rgba(239,43,43,0.10),transparent 70%),radial-gradient(ellipse 60% 50% at 10% 90%,rgba(239,43,43,0.06),transparent 70%),var(--bg)}
  body::before{content:"";position:fixed;inset:0;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,0.018) 0 1px,transparent 1px 3px);pointer-events:none;z-index:100;mix-blend-mode:overlay}
  a{color:inherit}

  .ticker{position:relative;z-index:5;background:var(--red);color:#0a0a0a;border-bottom:1px solid #0a0a0a;overflow:hidden;font-family:'Archivo Black',sans-serif;letter-spacing:0.04em;font-size:14px;text-transform:uppercase;height:38px;display:flex;align-items:center}
  .ticker-track{display:flex;gap:48px;white-space:nowrap;animation:ticker 28s linear infinite;padding-left:48px}
  .ticker span{display:inline-flex;align-items:center;gap:18px}
  .ticker .dot{width:8px;height:8px;background:#0a0a0a;border-radius:50%;display:inline-block}
  @keyframes ticker{from{transform:translateX(0)}to{transform:translateX(-50%)}}

  .topbar{position:relative;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:22px var(--gutter);border-bottom:1px solid var(--rule)}
  .brand{font-family:'Archivo Black',sans-serif;font-size:18px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink);display:inline-flex;align-items:center;gap:10px;text-decoration:none}
  .brand .mark{width:14px;height:14px;background:var(--red);border-radius:50%;box-shadow:0 0 0 3px rgba(239,43,43,0.18);animation:pulse 1.6s ease-in-out infinite}
  @keyframes pulse{0%,100%{box-shadow:0 0 0 3px rgba(239,43,43,0.18);transform:scale(1)}50%{box-shadow:0 0 0 8px rgba(239,43,43,0.04);transform:scale(0.92)}}
  .nav-links{display:flex;align-items:center;gap:24px}
  .nav-links a{color:var(--ink-dim);text-decoration:none;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-family:'JetBrains Mono',monospace;transition:color .15s}
  .nav-links a:hover,.nav-links a.active{color:var(--red)}
  .nav-cta{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border:1px solid var(--rule);color:var(--ink);text-decoration:none;font-family:'JetBrains Mono',monospace;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;transition:border-color .15s,background .15s}
  .nav-cta:hover{border-color:var(--red);background:rgba(239,43,43,0.06)}
  .nav-cta svg{width:14px;height:14px;fill:currentColor}

  .hero{position:relative;z-index:4;padding:clamp(40px,7vw,72px) var(--gutter) clamp(28px,4vw,40px)}
  .eyebrow{color:var(--ink-dim);font-size:12px;letter-spacing:0.22em;text-transform:uppercase;margin-bottom:clamp(20px,3vw,28px);display:flex;align-items:center;gap:14px}
  .eyebrow::before{content:"";width:36px;height:1px;background:var(--ink-dim)}
  .wordmark{font-family:'Anton',sans-serif;font-weight:400;line-height:0.82;letter-spacing:-0.01em;text-transform:uppercase;font-size:clamp(64px,12vw,176px);max-width:14ch}
  .wordmark .a{color:var(--red);display:block;text-shadow:6px 6px 0 #0a0a0a,6px 6px 0 1px rgba(239,43,43,0.4)}
  .wordmark .b{color:transparent;-webkit-text-stroke:2px var(--ink);display:block;margin-top:-0.04em}
  .sub{margin-top:clamp(20px,3vw,32px);max-width:62ch;color:var(--ink);font-size:clamp(15px,1.3vw,17px);line-height:1.6}
  .sub b{color:var(--red);font-weight:700}
  .hero-ctas{margin-top:clamp(20px,3vw,28px);display:flex;flex-wrap:wrap;gap:14px}
  .btn-red{display:inline-flex;align-items:center;gap:10px;padding:14px 22px;background:var(--red);color:#0a0a0a;text-decoration:none;font-family:'Archivo Black',sans-serif;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;transition:background .15s,transform .05s}
  .btn-red:hover{background:#ff3838}
  .btn-red:active{transform:translateY(1px)}
  .btn-red svg{width:16px;height:16px;fill:currentColor}
  .btn-ghost{display:inline-flex;align-items:center;gap:10px;padding:13px 22px;border:1px solid var(--rule);color:var(--ink);text-decoration:none;font-family:'Archivo Black',sans-serif;font-size:13px;letter-spacing:0.14em;text-transform:uppercase;transition:border-color .15s,background .15s}
  .btn-ghost:hover{border-color:var(--red);background:rgba(239,43,43,0.06)}

  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);margin:0 var(--gutter) clamp(28px,4vw,40px)}
  .stat{background:#0f0f0f;padding:18px 20px}
  .stat .v{font-family:'Anton',sans-serif;font-size:38px;line-height:1;color:var(--ink)}
  .stat .v.red{color:var(--red)}
  .stat .l{margin-top:8px;color:var(--ink-dim);font-size:10px;letter-spacing:0.22em;text-transform:uppercase}

  .grid{display:grid;grid-template-columns:1fr 1fr;gap:clamp(20px,3vw,32px);padding:0 var(--gutter) clamp(60px,8vw,96px)}
  @media (max-width:880px){.grid{grid-template-columns:1fr}}
  .section{border:1px solid var(--rule);background:rgba(20,20,20,0.6);display:flex;flex-direction:column}
  .section-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:20px 22px;border-bottom:1px solid var(--rule)}
  .section-head .h{font-family:'Anton',sans-serif;font-size:26px;line-height:0.95;text-transform:uppercase;letter-spacing:0.01em;color:var(--ink)}
  .section-head .h em{font-style:normal;color:var(--red)}
  .section-head .id{color:var(--ink-dim);font-size:10px;letter-spacing:0.22em;text-transform:uppercase}
  .section.wide{grid-column:1/-1}
  ul.rows{list-style:none}
  .row{border-bottom:1px solid var(--rule)}
  .row:last-child{border-bottom:0}
  .row-link{display:grid;grid-template-columns:80px 1fr auto;align-items:center;gap:14px;padding:14px 22px;text-decoration:none;color:var(--ink);transition:background .12s}
  .row-link:hover{background:rgba(239,43,43,0.04)}
  .row-sha{color:var(--red);font-family:'JetBrains Mono',monospace;font-size:12px;font-weight:700;letter-spacing:0.04em}
  .row-msg{font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.4;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row-meta{color:var(--ink-dim);font-size:11px;letter-spacing:0.06em;white-space:nowrap}
  .row.empty{padding:18px 22px;color:var(--ink-dim);font-size:13px}
  @media (max-width:560px){
    .row-link{grid-template-columns:60px 1fr;gap:10px;padding:12px 18px}
    .row-meta{grid-column:1/-1;margin-top:2px}
    .topbar{padding:18px var(--gutter)}
    .nav-links{gap:14px}
    .wordmark{font-size:clamp(48px,16vw,96px)}
    .stat .v{font-size:30px}
  }

  .foot{position:relative;z-index:5;border-top:1px solid var(--rule);padding:22px var(--gutter);display:flex;align-items:center;justify-content:space-between;color:var(--ink-dim);font-size:11px;letter-spacing:0.18em;text-transform:uppercase;gap:18px;flex-wrap:wrap}
  .foot a{color:var(--ink);text-decoration:none;border-bottom:1px solid transparent;transition:border-color .15s}
  .foot a:hover{border-color:var(--red)}
  .foot .social{display:flex;gap:22px;flex-wrap:wrap}
</style>
</head>
<body>

<div class="ticker" aria-hidden="true">
  <div class="ticker-track">
    <span>Built In The Open <i class="dot"></i></span>
    <span>Open Mic <i class="dot"></i></span>
    <span>PR Welcome <i class="dot"></i></span>
    <span>Fork It <i class="dot"></i></span>
    <span>Ship It <i class="dot"></i></span>
    <span>Built In The Open <i class="dot"></i></span>
    <span>Open Mic <i class="dot"></i></span>
    <span>PR Welcome <i class="dot"></i></span>
    <span>Fork It <i class="dot"></i></span>
    <span>Ship It <i class="dot"></i></span>
  </div>
</div>

<header class="topbar">
  <a class="brand" href="/"><span class="mark"></span>Crush Radio</a>
  <div class="nav-links">
    <a href="/">Home</a>
    <a href="/code" class="active">Code</a>
    <a class="nav-cta" href="${REPO_URL}" rel="noopener" aria-label="View the repo on GitHub">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      <span>Repo</span>
    </a>
  </div>
</header>

<section class="hero">
  <div class="eyebrow">The Code // Built in the open</div>
  <h1 class="wordmark">
    <span class="a">The</span>
    <span class="b">Code</span>
  </h1>
  <p class="sub">
    Crush Radio is <b>built in public on GitHub</b>. ${escapeHtml(desc)} Every change is a pull request. Every decision is in an issue or a commit message. No closed doors.
  </p>
  <div class="hero-ctas">
    <a class="btn-red" href="${REPO_URL}" rel="noopener">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      Open the repo
    </a>
    <a class="btn-ghost" href="${REPO_URL}/issues/new" rel="noopener">File an issue →</a>
    <a class="btn-ghost" href="${REPO_URL}/fork" rel="noopener">Fork it →</a>
  </div>
</section>

<div class="stats">
  <div class="stat"><div class="v red">${stars}</div><div class="l">Stars</div></div>
  <div class="stat"><div class="v">${forks}</div><div class="l">Forks</div></div>
  <div class="stat"><div class="v">${watchers}</div><div class="l">Watchers</div></div>
  <div class="stat"><div class="v">${pulls.length}</div><div class="l">Open PRs</div></div>
  <div class="stat"><div class="v">${openIssuesCount}</div><div class="l">Open Issues</div></div>
  <div class="stat"><div class="v" style="font-size:18px;font-family:'JetBrains Mono',monospace;line-height:1.3">${escapeHtml(license)}</div><div class="l">License</div></div>
  <div class="stat"><div class="v" style="font-size:18px;font-family:'JetBrains Mono',monospace;line-height:1.3">${escapeHtml(defaultBranch)}</div><div class="l">Branch</div></div>
  <div class="stat"><div class="v" style="font-size:18px;font-family:'JetBrains Mono',monospace;line-height:1.3">${escapeHtml(lastPush)}</div><div class="l">Last push</div></div>
</div>

<div class="grid">
  <section class="section wide">
    <div class="section-head">
      <div class="h">Recent <em>commits</em></div>
      <div class="id">Live feed · cached 5 min</div>
    </div>
    <ul class="rows">${commitRows}</ul>
  </section>

  <section class="section">
    <div class="section-head">
      <div class="h">Open <em>pull requests</em></div>
      <div class="id">${pulls.length} open</div>
    </div>
    <ul class="rows">${prRows}</ul>
  </section>

  <section class="section">
    <div class="section-head">
      <div class="h">Open <em>issues</em></div>
      <div class="id">${issues.length} open</div>
    </div>
    <ul class="rows">${issueRows}</ul>
  </section>
</div>

<footer class="foot">
  <div>© Crush Radio · Community-built · MIT licensed</div>
  <div class="social">
    <a href="${REPO_URL}" rel="noopener">GitHub</a>
    <a href="/">Home</a>
    <a href="mailto:hello@crushradio.com">Contact</a>
  </div>
</footer>

</body>
</html>`;
}
