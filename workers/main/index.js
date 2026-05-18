// Crush Radio — Main Worker
// Routes:
//   /           → home page (HOME_HTML inlined at build time) with the
//                 live GitHub feed injected in place of the <!--FEED--> marker
//   /code       → 301 redirect to / (kept for legacy inbound links)
//   /ws         → WebSocket upgrade → Rotator Durable Object
//   /api/status → Rotator now-playing JSON (debug / Plan 2 prep)
//   /api/*      → 404 stub until Plan 2 wires upload/vote/flag/takedown
//   /robots.txt → robots
//
// HOME_HTML is replaced at build time by scripts/build.mjs. Do not hand-edit.

export { Rotator } from "../../rotator/index.js";

const HOME_HTML = `__HTML__`;

const REPO_OWNER = "jjc6676";
const REPO_NAME = "crushradio";
const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const id = env.ROTATOR.idFromName("global");
      return env.ROTATOR.get(id).fetch(request);
    }

    if (path === "/api/status") {
      const id = env.ROTATOR.idFromName("global");
      const statusUrl = new URL("/status", request.url);
      return env.ROTATOR.get(id).fetch(new Request(statusUrl, request));
    }

    if (path.startsWith("/api/")) {
      return new Response(
        JSON.stringify({ error: "Not implemented — coming in Plan 2" }),
        { status: 404, headers: { "content-type": "application/json" } }
      );
    }

    if (path === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    // /code now lives under / — keep the old URL working for inbound links.
    if (path === "/code") {
      return Response.redirect(new URL("/", request.url).toString(), 301);
    }

    if (path === "/") {
      return renderHomePage();
    }

    return new Response("Not Found — try / or /ws", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

async function renderHomePage() {
  const feedHtml = await renderFeed();
  const page = HOME_HTML.replace("<!--FEED-->", feedHtml);
  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300, s-maxage=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "SAMEORIGIN",
      "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
      "content-security-policy":
        "default-src 'self'; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com data:; " +
        "img-src 'self' data:; " +
        "media-src 'self' https://audio.crushradio.com; " +
        "connect-src 'self' wss://crushradio.com wss://www.crushradio.com; " +
        "script-src 'self'; " +
        "frame-ancestors 'self'; " +
        "base-uri 'self'; " +
        "form-action 'self'",
    },
  });
}

async function renderFeed() {
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

  return feedMarkup({ repo, commits, pulls, issues });
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

function feedMarkup(data) {
  const { repo, commits, pulls, issues } = data;
  const repoExists = !!repo && !repo.message;
  const stars = repoExists ? repo.stargazers_count : 0;
  const forks = repoExists ? repo.forks_count : 0;
  const watchers = repoExists ? repo.subscribers_count : 0;
  const license = repoExists && repo.license
    ? escapeHtml(repo.license.spdx_id || repo.license.name)
    : "MIT";
  const defaultBranch = repoExists ? escapeHtml(repo.default_branch) : "main";
  const lastPush = repoExists ? timeAgo(repo.pushed_at) : "—";
  const openIssuesCount = repoExists
    ? Math.max(0, (repo.open_issues_count || 0) - pulls.length)
    : issues.length;

  const commitRows = (commits && commits.length)
    ? commits.map(c => {
        const msg = c.commit && c.commit.message ? c.commit.message.split("\n")[0] : "";
        const author = c.author && c.author.login
          ? c.author.login
          : (c.commit && c.commit.author ? c.commit.author.name : "—");
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
      }).join("")
    : `<li class="row empty">No commits yet — repo is still warming up.</li>`;

  const prRows = (pulls && pulls.length)
    ? pulls.map(pr => `
      <li class="row">
        <a class="row-link" href="${escapeHtml(pr.html_url)}" target="_blank" rel="noopener">
          <span class="row-sha">#${pr.number}</span>
          <span class="row-msg">${escapeHtml(pr.title)}</span>
          <span class="row-meta">${escapeHtml(pr.user && pr.user.login ? pr.user.login : "")} · opened ${escapeHtml(timeAgo(pr.created_at))}</span>
        </a>
      </li>`).join("")
    : `<li class="row empty">No open pull requests. <a href="${REPO_URL}/compare" target="_blank" rel="noopener" style="color:var(--red)">Open one →</a></li>`;

  const issueRows = (issues && issues.length)
    ? issues.map(it => `
      <li class="row">
        <a class="row-link" href="${escapeHtml(it.html_url)}" target="_blank" rel="noopener">
          <span class="row-sha">#${it.number}</span>
          <span class="row-msg">${escapeHtml(it.title)}</span>
          <span class="row-meta">${escapeHtml(it.user && it.user.login ? it.user.login : "")} · opened ${escapeHtml(timeAgo(it.created_at))}</span>
        </a>
      </li>`).join("")
    : `<li class="row empty">No open issues. <a href="${REPO_URL}/issues/new" target="_blank" rel="noopener" style="color:var(--red)">File one →</a></li>`;

  return `
<div class="stats">
  <div class="stat"><div class="v red">${stars}</div><div class="l">Stars</div></div>
  <div class="stat"><div class="v">${forks}</div><div class="l">Forks</div></div>
  <div class="stat"><div class="v">${watchers}</div><div class="l">Watchers</div></div>
  <div class="stat"><div class="v">${pulls.length}</div><div class="l">Open PRs</div></div>
  <div class="stat"><div class="v">${openIssuesCount}</div><div class="l">Open Issues</div></div>
  <div class="stat"><div class="v small">${license}</div><div class="l">License</div></div>
  <div class="stat"><div class="v small">${defaultBranch}</div><div class="l">Branch</div></div>
  <div class="stat"><div class="v small">${lastPush}</div><div class="l">Last push</div></div>
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
</div>`;
}
