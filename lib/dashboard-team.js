'use strict';

// Team hub for the dashboard: per-team hub page (activity feed + members +
// projects), member drill-down pages, team project pages, invite panel and
// team settings. Composed into lib/dashboard.js's single self-contained page —
// same rules apply: no build step, no external assets, ES5-style client JS.
//
// Three hash routes, following the app's #project= idiom (browser-back exits):
//   #team                              — hub for the selected team
//   #team-member=<teamId>/<userId>     — one member: their projects + activity
//   #team-project=<teamId>/<projectId> — one team project: contributors + activity

const teamCss = `
/* ---------- team hub ---------- */
.hub-head { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
.hub-head .grow { min-width: 0; }
.hub-switch {
  max-width: 420px; padding: 2px 26px 2px 0; border: none; outline: none; cursor: pointer;
  background: transparent; color: var(--text);
  font: 400 30px/1.15 var(--display); letter-spacing: -.03em;
  appearance: none; -webkit-appearance: none;
  background-image: url("data:image/svg+xml;charset=utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2.4'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 2px center;
}
.hub-stat-line { display: flex; align-items: center; gap: 9px; margin-top: 5px; color: var(--muted); font-size: 12.5px; flex-wrap: wrap; }
.role-badge {
  display: inline-block; padding: 4px 10px; border-radius: 999px;
  border: 1px solid rgba(0,82,255,.18); color: var(--accent); background: rgba(0,82,255,.07);
  font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase;
}
.hub-grid { display: grid; grid-template-columns: 1.55fr 1fr; gap: 14px; align-items: start; }
.hub-col { display: grid; gap: 14px; }
.hub-grid .card, .hub-panel.card { margin: 0; }
.hub-panel { margin-bottom: 14px !important; }
.filter-bar { display: flex; gap: 8px; flex-wrap: wrap; margin: 2px 0 14px; }
.filter-bar select {
  flex: 1; min-width: 118px; min-height: 38px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: 10px; background: #fff;
  color: var(--text); font: 12.5px/1.4 inherit; outline: none;
}
.feed-day { margin: 16px 0 4px; color: var(--muted); font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase; }
.feed-day:first-child { margin-top: 0; }
.fentry { display: flex; gap: 12px; padding: 12px 2px; border-bottom: 1px solid var(--border); }
.fentry:last-child { border-bottom: none; }
.fentry .avatar { flex: none; width: 34px; height: 34px; border-radius: 11px; font-size: 13px; box-shadow: none; }
.fentry .grow { min-width: 0; }
.fhead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
.fhead strong { color: var(--text); font-size: 13.5px; }
.fask { margin-top: 3px; font-size: 13.5px; line-height: 1.5; overflow-wrap: break-word; }
.proj-pill {
  display: inline-block; padding: 2px 9px; border: 1px solid rgba(0,82,255,.16); border-radius: 999px;
  color: var(--accent); background: rgba(0,82,255,.05); font: 600 10px/1.6 var(--mono); cursor: pointer;
}
.proj-pill:hover { border-color: rgba(0,82,255,.4); }
.mem-row { display: flex; align-items: center; gap: 11px; padding: 9px 8px; border-radius: 11px; }
.mem-row.click { cursor: pointer; }
.mem-row.click:hover { background: #f1f5f9; }
.mem-row .avatar { flex: none; width: 34px; height: 34px; border-radius: 11px; font-size: 13px; box-shadow: none; }
.mem-row .grow { min-width: 0; }
.mem-row strong { display: block; font-size: 13.5px; }
.mem-row small { display: block; color: var(--muted); font-size: 11.5px; }
.mem-row .meta { margin: 0; flex: none; text-align: right; font-size: 11.5px; }
.hub-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.hub-card-head h2 { font-size: 15px; }
.hub-card-head .path { flex: none; }
.member-head .avatar { width: 56px; height: 56px; border-radius: 17px; font-size: 22px; }
.inline-form { display: flex; gap: 9px; align-items: end; flex-wrap: wrap; }
.inline-form label { display: grid; gap: 6px; color: var(--muted); font: 600 10px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
.inline-form input, .inline-form select {
  min-height: 42px; padding: 0 12px; border: 1px solid var(--border); border-radius: 11px;
  background: #fff; color: var(--text); font: 13.5px/1.4 inherit; outline: none; width: auto;
}
.inline-form input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(0,82,255,.1); }
.role-select { min-height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: #fff; color: var(--text); font: 12.5px/1.4 inherit; outline: none; }
@media (max-width: 900px) { .hub-grid { grid-template-columns: 1fr; } }
`;

const teamHtml = `
<div id="view-team">
  <div class="inner">
    <div id="teamRoot"><div class="empty">Loading your workspace&hellip;</div></div>
  </div>
</div>`;

const teamJs = `
/* ================= team hub ================= */
var teamRoot = document.getElementById('teamRoot');
var authRoot = document.getElementById('authRoot');
var teamAuthMode = 'login';
var teamNoticeText = '';
var teamNoticeKind = '';
var teamState = null;      // last /api/team payload
var curTeam = null;        // team object currently rendered
var curSub = { kind: 'hub' };
var teamSelId = '';
try { teamSelId = localStorage.getItem('mb-team') || ''; } catch (err) {}
var hubPanel = '';         // '' | 'invite' | 'settings' | 'create' | 'join'
var hubFilters = { author: '', project: '', source: '' };
var hubMembers = [];
var hubProjects = [];
var hubFeed = [];
var hubFeedDone = true;
var hubInvites = {};       // teamId -> invite links created this session
var teamSeq = 0;           // stale-response guard across navigations

function teamRequest(path, body) {
  return fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error(d.error || 'Request failed');
      return d;
    });
  });
}
function apiGet(path) {
  return fetch(path).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (d) {
      if (!r.ok) throw new Error(d.error || 'Request failed');
      return d;
    });
  });
}
function setTeamNotice(message, kind) {
  teamNoticeText = message || '';
  teamNoticeKind = kind || '';
}
function teamNoticeHtml() {
  return teamNoticeText ? '<div class="notice ' + esc(teamNoticeKind) + '" style="margin-bottom:14px">' + esc(teamNoticeText) + '</div>' : '';
}
function rememberTeam(id) {
  teamSelId = id;
  try { localStorage.setItem('mb-team', id); } catch (err) {}
}

/* ---- routing inside the Team tab ---- */
function teamSubView() {
  var m = location.hash.match(/^#team-member=([^/]+)\\/(.+)$/);
  if (m) return { kind: 'member', teamId: decodeURIComponent(m[1]), userId: decodeURIComponent(m[2]) };
  m = location.hash.match(/^#team-project=([^/]+)\\/(.+)$/);
  if (m) return { kind: 'project', teamId: decodeURIComponent(m[1]), projectId: decodeURIComponent(m[2]) };
  return { kind: 'hub' };
}

/* ---- avatars: stable per-person color from the user id ---- */
var AV_COLORS = ['#0052ff', '#7c3aed', '#0e9f6e', '#d97706', '#dc2626', '#0891b2', '#4d7cff'];
function avColor(id) {
  var s = String(id || '');
  var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}
function avatarHtml(id, name, cls) {
  var initial = ((name || '?').charAt(0) || '?').toUpperCase();
  return '<div class="avatar ' + (cls || '') + '" style="background:' + avColor(id) + '">' + esc(initial) + '</div>';
}

function loadTeam() {
  var seq = ++teamSeq;
  fetch('/api/team').then(function (r) {
    if (!r.ok) throw new Error('Team workspace unavailable');
    return r.json();
  }).then(function (d) {
    if (seq !== teamSeq) return;
    setPill(true);
    renderTeam(d);
  }).catch(function (err) {
    if (seq !== teamSeq) return;
    document.body.className = 'session-ready signed-out';
    authRoot.innerHTML = '<div class="notice error">' + esc(err.message) + '</div>';
    applyTab();
    setPill(false);
  });
}

function renderTeam(d) {
  teamState = d;
  var wasSignedIn = document.body.className.indexOf('signed-in') !== -1;
  if (!d.configured) {
    document.body.className = 'session-ready signed-out';
    authRoot.innerHTML = '<div class="card"><span class="section-label">Backend needed</span>' +
      '<h2 style="font-family:var(--display);font-size:28px;font-weight:400;margin:16px 0 8px">Team sync is not configured in this build.</h2>' +
      '<p class="m-help">Official builds include the hosted MemBridge backend. Self-hosted builds can configure a Supabase backend with the existing CLI setup command.</p></div>';
    applyTab();
    return;
  }
  if (!d.authenticated) {
    document.body.className = 'session-ready signed-out';
    var signup = teamAuthMode === 'signup';
    authRoot.innerHTML = '<span class="section-label">Account access</span>' +
      '<h2>' + (signup ? 'Start building together.' : 'Welcome back.') + '</h2>' +
      '<p>' + (signup ? 'Create your MemBridge workspace in under a minute.' : 'Sign in to open your shared memory workspace.') + '</p>' +
      '<div class="auth-switch">' +
      '<button class="btn ' + (!signup ? 'primary' : 'ghost') + '" data-team-action="auth-mode" data-mode="login">Log in</button>' +
      '<button class="btn ' + (signup ? 'primary' : 'ghost') + '" data-team-action="auth-mode" data-mode="signup">Create account</button></div>' +
      '<form class="team-form" data-team-form="' + (signup ? 'signup' : 'login') + '">' +
      (signup ? '<label>Display name<input name="displayName" autocomplete="name" placeholder="How teammates see you" required></label>' : '') +
      '<label>Email<input name="email" type="email" autocomplete="email" placeholder="you@company.com" required></label>' +
      '<label>Password<input name="password" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" placeholder="At least 6 characters" required></label>' +
      teamNoticeHtml() + '<button class="btn primary" type="submit">' + (signup ? 'Create my workspace' : 'Open MemBridge') + '</button></form>' +
      '<div class="auth-security">Your account unlocks projects, the neural map, team memory, and settings. Credentials stay in MemBridge\\'s protected local store.</div>';
    applyTab();
    return;
  }
  document.body.className = 'session-ready signed-in';
  authRoot.innerHTML = '';
  if (!wasSignedIn) applyTab();
  if (currentTab() !== 'team') return; // boot call from another tab: gate only
  var teams = d.teams || [];
  if (!teams.length) { curTeam = null; renderNoTeam(d); return; }
  var sub = teamSubView();
  if (sub.teamId && !teams.some(function (t) { return t.team_id === sub.teamId; })) {
    location.hash = '#team';
    return;
  }
  var selId = sub.teamId || teamSelId;
  var sel = null;
  for (var i = 0; i < teams.length; i++) if (teams[i].team_id === selId) sel = teams[i];
  if (!sel) sel = teams[0];
  rememberTeam(sel.team_id);
  loadTeamSub(d, sel, sub);
}

/* ---- data for the current sub-view: members + projects + a filtered feed ---- */
function feedQuery(sub) {
  if (sub.kind === 'member') return '&author=' + encodeURIComponent(sub.userId);
  if (sub.kind === 'project') return '&project=' + encodeURIComponent(sub.projectId);
  var q = '';
  if (hubFilters.author) q += '&author=' + encodeURIComponent(hubFilters.author);
  if (hubFilters.project) q += '&project=' + encodeURIComponent(hubFilters.project);
  if (hubFilters.source) q += '&source=' + encodeURIComponent(hubFilters.source);
  return q;
}
function loadTeamSub(d, team, sub) {
  var seq = teamSeq;
  var tid = team.team_id;
  teamRoot.innerHTML = '<div class="empty">Loading team&hellip;</div>';
  Promise.all([
    apiGet('/api/team/members?teamId=' + encodeURIComponent(tid)),
    apiGet('/api/team/projects?teamId=' + encodeURIComponent(tid)),
    apiGet('/api/team/feed?teamId=' + encodeURIComponent(tid) + feedQuery(sub)),
  ]).then(function (res) {
    if (seq !== teamSeq) return;
    curTeam = team;
    curSub = sub;
    hubMembers = res[0].members || [];
    hubProjects = res[1].projects || [];
    hubFeed = res[2].entries || [];
    hubFeedDone = hubFeed.length < 50;
    renderCurrent();
  }).catch(function (err) {
    if (seq !== teamSeq) return;
    curTeam = team;
    curSub = sub;
    teamRoot.innerHTML = '<div class="card"><div class="notice error">' + esc(err.message) + '</div>' +
      '<p class="m-help" style="margin-top:12px">The team workspace could not be reached. Local sync keeps working; this view recovers as soon as the backend is reachable.</p>' +
      '<div class="st-btns"><button class="btn" data-team-action="retry">Retry</button></div></div>';
  });
}
function renderCurrent() {
  if (!teamState || !curTeam) return;
  if (curSub.kind === 'member') renderMemberPage(teamState, curTeam, curSub);
  else if (curSub.kind === 'project') renderProjectPage(teamState, curTeam, curSub);
  else renderHub(teamState, curTeam);
}
function reloadFeedOnly() {
  if (!curTeam) return;
  var seq = teamSeq;
  apiGet('/api/team/feed?teamId=' + encodeURIComponent(curTeam.team_id) + feedQuery(curSub)).then(function (res) {
    if (seq !== teamSeq) return;
    hubFeed = res.entries || [];
    hubFeedDone = hubFeed.length < 50;
    renderCurrent();
  }).catch(function (err) {
    if (seq !== teamSeq) return;
    setTeamNotice(err.message, 'error');
    renderCurrent();
  });
}

/* ---- shared feed rendering, grouped by day ---- */
function dayLabel(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return 'Earlier';
  var now = new Date();
  var diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
    new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  var label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.getFullYear() === now.getFullYear() ? label : label + ', ' + d.getFullYear();
}
function feedListHtml(rows, opts) {
  opts = opts || {};
  if (!rows.length) {
    return '<div class="empty">' + esc(opts.empty || 'No shared activity yet. It appears here after teammates\\u2019 tools sync.') + '</div>';
  }
  // Pages arrive ordered by created_at (server insert time), but the reader
  // cares about ts (when the work happened). A late-synced entry would repeat
  // day headers, so order the visible list by ts before grouping.
  rows = rows.slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  var h = '';
  var lastDay = '';
  for (var i = 0; i < rows.length; i++) {
    var e = rows[i];
    var day = dayLabel(e.ts);
    if (day !== lastDay) { h += '<div class="feed-day">' + esc(day) + '</div>'; lastDay = day; }
    var files = (e.files || []).slice(0, 6);
    h += '<div class="fentry">' + avatarHtml(e.author_id, e.author_name) +
      '<div class="grow"><div class="fhead">' +
      '<strong>' + (opts.noAuthorLink ? esc(e.author_name)
        : '<a class="mlink" style="cursor:pointer" data-team-action="open-member" data-user-id="' + esc(e.author_id) + '">' + esc(e.author_name) + '</a>') + '</strong>' +
      badgeHtml(e.source) +
      (opts.noProject ? '' : '<span class="proj-pill" data-team-action="open-project" data-project-id="' + esc(e.project_id) + '">' + esc(e.project_name || 'project') + '</span>') +
      '<span data-ago="' + esc(e.ts || '') + '">' + esc(ago(e.ts)) + '</span></div>' +
      '<div class="fask">' + esc(e.ask || '(prompt not shared)') + '</div>' +
      (files.length ? '<div class="afiles">' + esc(files.join(', ')) + '</div>' : '') +
      '</div></div>';
  }
  if (!hubFeedDone) {
    h += '<div class="st-btns" style="justify-content:center;margin-top:14px"><button class="btn" data-team-action="feed-more">Load more</button></div>';
  }
  return h;
}
function lastActiveByAuthor() {
  var map = {};
  for (var i = 0; i < hubFeed.length; i++) {
    var e = hubFeed[i];
    if (!map[e.author_id] || e.ts > map[e.author_id]) map[e.author_id] = e.ts;
  }
  return map;
}

/* ---- hub building blocks ---- */
function hubHeaderHtml(d, team) {
  var teams = d.teams || [];
  var options = teams.map(function (t) {
    return '<option value="' + esc(t.team_id) + '"' + (t.team_id === team.team_id ? ' selected' : '') + '>' + esc(t.team_name) + '</option>';
  }).join('') +
    '<option disabled>&#9472;&#9472;&#9472;&#9472;&#9472;&#9472;</option>' +
    '<option value="__create">+ New team</option>' +
    '<option value="__join">Join with invite</option>';
  return '<div class="hub-head"><div class="grow">' +
    '<select class="hub-switch" data-team-change="switch" aria-label="Switch team">' + options + '</select>' +
    '<div class="hub-stat-line"><span class="role-badge">' + esc(team.role) + '</span>' +
    '<span>' + hubMembers.length + ' member' + (hubMembers.length === 1 ? '' : 's') + ' &middot; ' +
    hubProjects.length + ' project' + (hubProjects.length === 1 ? '' : 's') + '</span></div></div>' +
    '<button class="btn" data-team-action="sync">Sync now</button>' +
    '<button class="btn" data-team-action="panel-settings">Team settings</button>' +
    '<button class="btn primary" data-team-action="panel-invite">+ Invite</button></div>';
}
function panelHtml(d, team) {
  if (!hubPanel) return '';
  if (hubPanel === 'invite') return invitePanelHtml(d, team);
  if (hubPanel === 'settings') return settingsPanelHtml(d, team);
  if (hubPanel === 'create' || hubPanel === 'join') return createJoinPanelHtml(hubPanel);
  return '';
}
function invitePanelHtml(d, team) {
  var manager = team.role === 'owner' || team.role === 'admin';
  var h = '<div class="card hub-panel"><div class="hub-card-head"><h2>Invite people to ' + esc(team.team_name) + '</h2>' +
    '<button class="btn ghost" data-team-action="panel-close">Close</button></div>';
  if (!manager) {
    return h + '<p class="m-help">Only the team owner or an admin can create invite links. Ask them for one.</p></div>';
  }
  h += '<p class="m-help">Anyone with the link joins as a member. Leave the fields blank for a link that never expires.</p>' +
    '<form class="inline-form" data-team-form="invite-create">' +
    '<label>Expires in (days)<input name="expiresDays" type="number" min="1" step="1" placeholder="never" style="width:120px"></label>' +
    '<label>Max uses<input name="maxUses" type="number" min="1" step="1" placeholder="unlimited" style="width:120px"></label>' +
    '<button class="btn primary" type="submit">Create &amp; copy link</button></form>';
  var invs = hubInvites[team.team_id] || [];
  if (invs.length) {
    h += '<div class="team-list" style="margin-top:14px">' + invs.map(function (inv) {
      return '<div class="team-row"><div class="grow"><strong class="invite" style="font-size:12px">' + esc(inv.url || inv.token) + '</strong>' +
        '<small>' + (inv.expires_at ? 'expires ' + esc(String(inv.expires_at).slice(0, 10)) : 'no expiry') +
        ' &middot; ' + (inv.max_uses ? inv.max_uses + ' use' + (inv.max_uses === 1 ? '' : 's') + ' max' : 'unlimited uses') + '</small></div>' +
        '<button class="btn" data-team-action="copy-invite" data-code="' + esc(inv.url || ('membridge join ' + inv.token)) + '">Copy</button>' +
        '<button class="btn del" data-team-action="revoke-invite" data-token="' + esc(inv.token) + '">Revoke</button></div>';
    }).join('') + '</div>';
  }
  if (team.role === 'owner') {
    h += '<div class="st-row" style="margin-top:16px"><label style="width:auto">Legacy code</label>' +
      '<span class="invite">' + esc(team.invite_code) + '</span>' +
      '<button class="btn" data-team-action="copy-invite" data-code="' + esc(team.invite_code) + '">Copy code</button>' +
      '<button class="btn del" data-team-action="rotate-code" title="Mints a new legacy code and revokes every outstanding invite link.">Rotate</button></div>';
  }
  return h + '</div>';
}
function settingsPanelHtml(d, team) {
  var manager = team.role === 'owner' || team.role === 'admin';
  var h = '<div class="card hub-panel"><div class="hub-card-head"><h2>Team settings</h2>' +
    '<button class="btn ghost" data-team-action="panel-close">Close</button></div>';
  if (manager) {
    h += '<form class="inline-form" data-team-form="team-rename" style="margin-bottom:16px">' +
      '<label>Team name<input name="name" value="' + esc(team.team_name) + '" required style="width:220px"></label>' +
      '<button class="btn" type="submit">Rename</button></form>';
  }
  if (team.role !== 'owner') {
    h += '<div class="st-row"><label style="width:auto">Leave this team</label>' +
      '<button class="btn del" data-team-action="leave">Leave team</button></div>';
  }
  h += '<div class="profile" style="margin-top:18px;padding-top:16px;border-top:1px solid var(--border)">' +
    avatarHtml(d.user.userId, d.user.displayName) +
    '<div class="grow"><strong>' + esc(d.user.displayName) + '</strong><div class="path">' + esc(d.user.email) + '</div></div>' +
    (d.webUrl ? '<a class="btn" href="' + esc(d.webUrl) + '" target="_blank" rel="noopener" style="text-decoration:none">Open web workspace &nearr;</a>' : '') +
    '<button class="btn ghost" data-team-action="logout">Log out</button></div>';
  return h + '</div>';
}
function createJoinPanelHtml(which) {
  var create = which === 'create';
  return '<div class="card hub-panel"><div class="hub-card-head"><h2>' + (create ? 'Create a new team' : 'Join a team') + '</h2>' +
    '<button class="btn ghost" data-team-action="panel-close">Close</button></div>' +
    (create
      ? '<form class="inline-form" data-team-form="team-create"><label>Team name<input name="teamName" placeholder="Acme design" required style="width:220px"></label><button class="btn primary" type="submit">Create team</button></form>'
      : '<form class="inline-form" data-team-form="team-join"><label>Invite link or code<input name="inviteCode" placeholder="Paste an invite link or code" required style="width:300px"></label><button class="btn primary" type="submit">Join team</button></form>') +
    '</div>';
}
function suggestionsHtml(d) {
  var rows = (d.suggestions || []).map(function (s) {
    return '<div class="team-row"><div class="grow"><strong>' + esc(s.name) + '</strong><small class="path">' + esc(s.path) + '</small>' +
      '<small>Same git remote as a project your team &ldquo;' + esc(s.teamName) + '&rdquo; already shares (' + esc(s.repoUrl) + ')</small></div>' +
      '<button class="btn primary" data-team-action="suggest-accept" data-path="' + esc(s.path) + '">Link &amp; share</button>' +
      '<button class="btn ghost" data-team-action="suggest-dismiss" data-path="' + esc(s.path) + '">Keep local</button></div>';
  }).join('');
  return rows ? '<div class="card hub-panel"><div class="hub-card-head"><h2>Suggested links</h2><span class="path">Nothing is shared until you confirm.</span></div><div class="team-list">' + rows + '</div></div>' : '';
}
function filterBarHtml() {
  var authorOpts = '<option value="">Everyone</option>' + hubMembers.map(function (m) {
    return '<option value="' + esc(m.user_id) + '"' + (hubFilters.author === m.user_id ? ' selected' : '') + '>' + esc(m.display_name) + '</option>';
  }).join('');
  var projectOpts = '<option value="">All projects</option>' + hubProjects.map(function (p) {
    return '<option value="' + esc(p.project_id) + '"' + (hubFilters.project === p.project_id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
  }).join('');
  var tools = [];
  for (var i = 0; i < hubFeed.length; i++) if (tools.indexOf(hubFeed[i].source) === -1) tools.push(hubFeed[i].source);
  if (hubFilters.source && tools.indexOf(hubFilters.source) === -1) tools.push(hubFilters.source);
  var toolOpts = '<option value="">All tools</option>' + tools.map(function (t) {
    return '<option value="' + esc(t) + '"' + (hubFilters.source === t ? ' selected' : '') + '>' + esc(t) + '</option>';
  }).join('');
  return '<div class="filter-bar">' +
    '<select data-team-change="filter" data-filter="author" aria-label="Filter by member">' + authorOpts + '</select>' +
    '<select data-team-change="filter" data-filter="project" aria-label="Filter by project">' + projectOpts + '</select>' +
    '<select data-team-change="filter" data-filter="source" aria-label="Filter by tool">' + toolOpts + '</select></div>';
}
function membersCardHtml(d, team) {
  var lastMap = lastActiveByAuthor();
  var rows = hubMembers.map(function (m) {
    var last = lastMap[m.user_id];
    var self = d.user && d.user.userId === m.user_id;
    return '<div class="mem-row click" data-team-action="open-member" data-user-id="' + esc(m.user_id) + '">' +
      avatarHtml(m.user_id, m.display_name) +
      '<div class="grow"><strong>' + esc(m.display_name) + (self ? ' <span style="color:var(--muted);font-weight:400">(you)</span>' : '') + '</strong>' +
      '<small class="role-badge" style="border:none;padding:0;background:none">' + esc(m.role) + '</small></div>' +
      '<div class="meta">' + (last ? '<span data-ago="' + esc(last) + '">' + esc(ago(last)) + '</span>' : '&mdash;') + '</div></div>';
  }).join('');
  var solo = hubMembers.length === 1;
  return '<div class="card"><div class="hub-card-head"><h2>Members</h2><span class="path">' + hubMembers.length + '</span></div>' +
    rows +
    (solo ? '<p class="m-help" style="margin:10px 0 4px">It&rsquo;s just you so far. Invite a teammate and their AI activity shows up here.</p><button class="btn primary" data-team-action="panel-invite" style="width:100%">+ Invite someone</button>' : '') +
    '</div>';
}
function projectsCardHtml(d, team) {
  var rows = hubProjects.map(function (p) {
    return '<div class="mem-row click" data-team-action="open-project" data-project-id="' + esc(p.project_id) + '">' +
      '<div class="grow"><strong>' + esc(p.name) + '</strong>' +
      '<small>' + p.contributors + ' ' + (p.contributors === 1 ? 'person' : 'people') + ' &middot; ' + p.entries + ' entries' +
      (p.last_activity ? ' &middot; <span data-ago="' + esc(p.last_activity) + '">' + esc(ago(p.last_activity)) + '</span>' : '') + '</small></div>' +
      (p.localPath ? '<span class="team-chip" style="margin:0">on this Mac</span>' : '') + '</div>';
  }).join('');
  return '<div class="card"><div class="hub-card-head"><h2>Projects</h2><span class="path">' + hubProjects.length + '</span></div>' +
    (rows || '<p class="m-help">No shared projects yet. Share one below and its redacted activity reaches the whole team.</p>') +
    '</div>';
}
function shareCardHtml(d, team) {
  var locals = (d.projects || []).filter(function (p) { return !p.team; });
  if (!locals.length) return '';
  var rows = locals.map(function (p) {
    return '<div class="mem-row"><div class="grow"><strong>' + esc(p.name) + '</strong><small class="path">' + esc(p.path) + '</small></div>' +
      '<button class="btn" data-team-action="link" data-path="' + esc(p.path) + '">Share</button></div>';
  }).join('');
  return '<div class="card"><div class="hub-card-head"><h2>Share a local project</h2></div>' +
    '<p class="m-help" style="margin-bottom:8px">Linking shares redacted prompts, tool names, timestamps and relative file paths with ' + esc(team.team_name) + ' &mdash; never source files or secrets.</p>' +
    rows + '</div>';
}

function renderHub(d, team) {
  teamRoot.innerHTML = hubHeaderHtml(d, team) + teamNoticeHtml() + panelHtml(d, team) + suggestionsHtml(d) +
    '<div class="hub-grid"><div class="hub-col">' +
    '<div class="card"><div class="hub-card-head"><h2>Activity</h2><span class="path">who did what</span></div>' +
    filterBarHtml() +
    feedListHtml(hubFeed, {}) +
    '</div></div><div class="hub-col">' +
    membersCardHtml(d, team) + projectsCardHtml(d, team) + shareCardHtml(d, team) +
    '</div></div>';
}

function renderNoTeam(d) {
  teamRoot.innerHTML = '<div class="hub-head"><div class="grow">' +
    '<h1 class="page-title" style="font-size:34px;margin:0">Your team</h1>' +
    '<div class="hub-stat-line">Shared AI memory for the people you build with.</div></div>' +
    '<button class="btn ghost" data-team-action="logout">Log out</button></div>' +
    teamNoticeHtml() +
    '<div class="hub-grid" style="grid-template-columns:1fr 1fr">' +
    '<div class="card"><h2 style="font-size:15px">Create a team</h2><p class="m-help" style="margin:6px 0 14px">Start a workspace and invite the people you build with.</p>' +
    '<form class="team-form" data-team-form="team-create"><label>Team name<input name="teamName" placeholder="Acme design" required></label><button class="btn primary" type="submit">Create team</button></form></div>' +
    '<div class="card"><h2 style="font-size:15px">Join a team</h2><p class="m-help" style="margin:6px 0 14px">Paste the invite link or code a teammate sent you.</p>' +
    '<form class="team-form" data-team-form="team-join"><label>Invite link or code<input name="inviteCode" placeholder="https://&hellip;/join/&hellip; or a code" required></label><button class="btn" type="submit">Join team</button></form></div></div>';
}

/* ---- member page ---- */
function renderMemberPage(d, team, sub) {
  var member = null;
  for (var i = 0; i < hubMembers.length; i++) if (hubMembers[i].user_id === sub.userId) member = hubMembers[i];
  if (!member) {
    teamRoot.innerHTML = '<div class="pj-head"><div class="grow"><h2>Not a member anymore</h2></div>' +
      '<button class="pj-close" data-team-action="back" title="Back to team">&times;</button></div>' +
      '<div class="empty">This person is no longer in ' + esc(team.team_name) + '.</div>';
    return;
  }
  var isSelf = d.user && d.user.userId === member.user_id;
  var controls = '';
  if (team.role === 'owner' && member.role !== 'owner' && !isSelf) {
    controls += '<select class="role-select" data-team-change="set-role" data-user-id="' + esc(member.user_id) + '" aria-label="Role">' +
      '<option value="member"' + (member.role === 'member' ? ' selected' : '') + '>member</option>' +
      '<option value="admin"' + (member.role === 'admin' ? ' selected' : '') + '>admin</option></select>';
  }
  if ((team.role === 'owner' || team.role === 'admin') && member.role !== 'owner' && !isSelf) {
    controls += '<button class="btn del" data-team-action="remove-member" data-user-id="' + esc(member.user_id) + '">Remove</button>';
  }
  if (isSelf && member.role !== 'owner') {
    controls += '<button class="btn del" data-team-action="leave">Leave team</button>';
  }
  // Recent projects: aggregated from this member's loaded feed window.
  var agg = {};
  var order = [];
  for (var j = 0; j < hubFeed.length; j++) {
    var e = hubFeed[j];
    if (!agg[e.project_id]) { agg[e.project_id] = { name: e.project_name, count: 0, last: e.ts }; order.push(e.project_id); }
    agg[e.project_id].count++;
    if (e.ts > agg[e.project_id].last) agg[e.project_id].last = e.ts;
  }
  var projRows = order.map(function (pid) {
    var p = agg[pid];
    return '<div class="mem-row click" data-team-action="open-project" data-project-id="' + esc(pid) + '">' +
      '<div class="grow"><strong>' + esc(p.name || 'project') + '</strong>' +
      '<small>' + p.count + ' recent entr' + (p.count === 1 ? 'y' : 'ies') + ' &middot; <span data-ago="' + esc(p.last) + '">' + esc(ago(p.last)) + '</span></small></div></div>';
  }).join('');
  teamRoot.innerHTML = '<div class="pj-head member-head">' +
    avatarHtml(member.user_id, member.display_name) +
    '<div class="grow"><h2>' + esc(member.display_name) + (isSelf ? ' <span style="color:var(--muted);font-weight:400;font-size:20px">(you)</span>' : '') + '</h2>' +
    '<div class="hub-stat-line"><span class="role-badge">' + esc(member.role) + '</span>' +
    '<span>' + esc(team.team_name) + ' &middot; joined <span data-ago="' + esc(member.joined_at || '') + '">' + esc(ago(member.joined_at)) + '</span></span></div></div>' +
    controls +
    '<button class="pj-close" data-team-action="back" title="Back to team">&times;</button></div>' +
    teamNoticeHtml() +
    '<div class="hub-grid" style="margin-top:20px"><div class="hub-col">' +
    '<div class="card"><div class="hub-card-head"><h2>Recent work</h2></div>' +
    feedListHtml(hubFeed, { noAuthorLink: true, empty: 'No activity from ' + member.display_name + ' in the loaded window yet.' }) + '</div>' +
    '</div><div class="hub-col">' +
    '<div class="card"><div class="hub-card-head"><h2>Projects they touched</h2><span class="path">recent</span></div>' +
    (projRows || '<p class="m-help">Nothing in the recent window.</p>') + '</div>' +
    '</div></div>';
}

/* ---- team project page ---- */
function renderProjectPage(d, team, sub) {
  var proj = null;
  for (var i = 0; i < hubProjects.length; i++) if (hubProjects[i].project_id === sub.projectId) proj = hubProjects[i];
  if (!proj) {
    teamRoot.innerHTML = '<div class="pj-head"><div class="grow"><h2>Project not found</h2></div>' +
      '<button class="pj-close" data-team-action="back" title="Back to team">&times;</button></div>' +
      '<div class="empty">This project is not shared with ' + esc(team.team_name) + ' anymore.</div>';
    return;
  }
  var localControls = '';
  if (proj.localPath) {
    localControls = '<button class="btn" data-team-action="open-local" data-path="' + esc(proj.localPath) + '">Open on this Mac</button>' +
      '<button class="btn del" data-team-action="unlink" data-path="' + esc(proj.localPath) + '">Unlink</button>';
  } else {
    var locals = (d.projects || []).filter(function (p) { return !p.team; });
    if (locals.length) {
      localControls = '<select class="role-select" id="pjLinkSel" aria-label="Local folder">' + locals.map(function (p) {
        return '<option value="' + esc(p.path) + '">' + esc(p.name) + '</option>';
      }).join('') + '</select><button class="btn" data-team-action="link-selected">Link local folder</button>';
    }
  }
  // Contributors: aggregated from this project's loaded feed window.
  var agg = {};
  var order = [];
  for (var j = 0; j < hubFeed.length; j++) {
    var e = hubFeed[j];
    if (!agg[e.author_id]) { agg[e.author_id] = { name: e.author_name, count: 0, last: e.ts }; order.push(e.author_id); }
    agg[e.author_id].count++;
    if (e.ts > agg[e.author_id].last) agg[e.author_id].last = e.ts;
  }
  var contribRows = order.map(function (uid) {
    var c = agg[uid];
    return '<div class="mem-row click" data-team-action="open-member" data-user-id="' + esc(uid) + '">' +
      avatarHtml(uid, c.name) +
      '<div class="grow"><strong>' + esc(c.name) + '</strong>' +
      '<small>' + c.count + ' recent entr' + (c.count === 1 ? 'y' : 'ies') + '</small></div>' +
      '<div class="meta"><span data-ago="' + esc(c.last) + '">' + esc(ago(c.last)) + '</span></div></div>';
  }).join('');
  teamRoot.innerHTML = '<div class="pj-head"><div class="grow"><h2>' + esc(proj.name) + '</h2>' +
    (proj.localPath ? '<span class="team-chip" style="margin-left:10px;vertical-align:4px">on this Mac</span>' : '') +
    '<div class="hub-stat-line">' + (proj.repo_url ? '<span class="path">' + esc(proj.repo_url) + '</span> &middot; ' : '') +
    '<span>' + proj.contributors + ' contributor' + (proj.contributors === 1 ? '' : 's') + ' &middot; ' + proj.entries + ' entries' +
    (proj.last_activity ? ' &middot; active <span data-ago="' + esc(proj.last_activity) + '">' + esc(ago(proj.last_activity)) + '</span>' : '') + '</span></div></div>' +
    localControls +
    '<button class="pj-close" data-team-action="back" title="Back to team">&times;</button></div>' +
    teamNoticeHtml() +
    '<div class="hub-grid" style="margin-top:20px"><div class="hub-col">' +
    '<div class="card"><div class="hub-card-head"><h2>Activity</h2></div>' +
    feedListHtml(hubFeed, { noProject: true, empty: 'No shared activity in this project yet.' }) + '</div>' +
    '</div><div class="hub-col">' +
    '<div class="card"><div class="hub-card-head"><h2>Contributors</h2><span class="path">recent</span></div>' +
    (contribRows || '<p class="m-help">Nothing in the recent window.</p>') + '</div>' +
    '</div></div>';
}

/* ---- destructive actions arm on first click instead of a modal ---- */
function armed(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = '1';
  btn.dataset.label = btn.textContent;
  btn.textContent = 'Click again to confirm';
  setTimeout(function () {
    if (btn.isConnected && btn.dataset.armed) {
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.label;
    }
  }, 3500);
  return false;
}

function handleTeamClick(e) {
  var btn = e.target.closest('[data-team-action]');
  if (!btn || btn.disabled) return;
  var action = btn.dataset.teamAction;
  if (action === 'auth-mode') {
    teamAuthMode = btn.dataset.mode;
    setTeamNotice('', '');
    loadTeam();
    return;
  }
  if (action === 'retry') { loadTeam(); return; }
  if (action === 'back') { location.hash = '#team'; return; }
  if (action === 'open-member') {
    location.hash = '#team-member=' + encodeURIComponent(teamSelId) + '/' + encodeURIComponent(btn.dataset.userId);
    return;
  }
  if (action === 'open-project') {
    location.hash = '#team-project=' + encodeURIComponent(teamSelId) + '/' + encodeURIComponent(btn.dataset.projectId);
    return;
  }
  if (action === 'open-local') { location.hash = '#project=' + encodeURIComponent(btn.dataset.path); return; }
  if (action === 'panel-invite') { hubPanel = hubPanel === 'invite' ? '' : 'invite'; renderCurrent(); return; }
  if (action === 'panel-settings') { hubPanel = hubPanel === 'settings' ? '' : 'settings'; renderCurrent(); return; }
  if (action === 'panel-close') { hubPanel = ''; renderCurrent(); return; }
  if (action === 'copy-invite') {
    copyText(btn.dataset.code).then(function () { copyDone(btn, 'Copied'); });
    return;
  }
  if (action === 'feed-more') {
    if (!hubFeed.length || !curTeam) return;
    btn.disabled = true;
    var last = hubFeed[hubFeed.length - 1];
    var seq = teamSeq;
    apiGet('/api/team/feed?teamId=' + encodeURIComponent(curTeam.team_id) + feedQuery(curSub) +
      '&beforeCreatedAt=' + encodeURIComponent(last.created_at) + '&beforeId=' + encodeURIComponent(last.id)
    ).then(function (res) {
      if (seq !== teamSeq) return;
      var more = res.entries || [];
      hubFeed = hubFeed.concat(more);
      hubFeedDone = more.length < 50;
      renderCurrent();
    }).catch(function (err) {
      if (seq !== teamSeq) return;
      setTeamNotice(err.message, 'error');
      renderCurrent();
    });
    return;
  }
  if (action === 'link-selected') {
    var sel = document.getElementById('pjLinkSel');
    if (!sel || !sel.value || !curTeam) return;
    btn.disabled = true;
    teamRequest('/api/team/link', { path: sel.value, teamId: curTeam.team_id, teamName: curTeam.team_name }).then(function () {
      setTeamNotice('Project linked. Its redacted memory is now shared with this team.', 'success');
      loadTeam();
    }).catch(function (err) { setTeamNotice(err.message, 'error'); loadTeam(); });
    return;
  }
  if (action === 'revoke-invite') {
    if (!armed(btn)) return;
    btn.disabled = true;
    teamRequest('/api/team/revoke-invite', { token: btn.dataset.token }).then(function () {
      var list = hubInvites[teamSelId] || [];
      hubInvites[teamSelId] = list.filter(function (inv) { return inv.token !== btn.dataset.token; });
      setTeamNotice('Invite revoked. Anyone who has not used it can no longer join.', 'success');
      renderCurrent();
    }).catch(function (err) { setTeamNotice(err.message, 'error'); renderCurrent(); });
    return;
  }
  if (action === 'rotate-code') {
    if (!armed(btn)) return;
    btn.disabled = true;
    teamRequest('/api/team/rotate-invite', { teamId: teamSelId }).then(function () {
      hubInvites[teamSelId] = [];
      setTeamNotice('Legacy code rotated. Every outstanding invite link was revoked.', 'success');
      loadTeam();
    }).catch(function (err) { setTeamNotice(err.message, 'error'); loadTeam(); });
    return;
  }
  if (action === 'remove-member') {
    if (!armed(btn)) return;
    btn.disabled = true;
    teamRequest('/api/team/remove-member', { teamId: teamSelId, userId: btn.dataset.userId }).then(function () {
      setTeamNotice('Removed from the team. Their copy of MemBridge keeps working locally.', 'success');
      location.hash = '#team';
      loadTeam();
    }).catch(function (err) { setTeamNotice(err.message, 'error'); loadTeam(); });
    return;
  }
  if (action === 'leave') {
    if (!armed(btn)) return;
    btn.disabled = true;
    teamRequest('/api/team/leave', { teamId: teamSelId }).then(function () {
      rememberTeam('');
      setTeamNotice('You left the team.', 'success');
      location.hash = '#team';
      loadTeam();
    }).catch(function (err) { setTeamNotice(err.message, 'error'); loadTeam(); });
    return;
  }
  btn.disabled = true;
  var request;
  if (action === 'logout') request = teamRequest('/api/team/logout');
  if (action === 'sync') request = teamRequest('/api/team/sync');
  if (action === 'suggest-accept') request = teamRequest('/api/team/suggestion', { path: btn.dataset.path, accept: true });
  if (action === 'suggest-dismiss') request = teamRequest('/api/team/suggestion', { path: btn.dataset.path, accept: false });
  if (action === 'unlink') request = armed(btn) ? teamRequest('/api/team/unlink', { path: btn.dataset.path }) : null;
  if (action === 'link') request = curTeam ? teamRequest('/api/team/link', { path: btn.dataset.path, teamId: curTeam.team_id, teamName: curTeam.team_name }) : null;
  if (!request) { btn.disabled = false; return; }
  request.then(function (result) {
    if (action === 'sync') {
      var count = (result.synced || []).length;
      setTeamNotice('Team memory synced across ' + count + ' project' + (count === 1 ? '' : 's') + '.', 'success');
    } else if (action === 'link' || action === 'suggest-accept') setTeamNotice('Project linked. Its redacted memory is now shared with this team.', 'success');
    else if (action === 'suggest-dismiss') setTeamNotice('Kept local. MemBridge will not suggest that remote again.', 'success');
    else if (action === 'unlink') setTeamNotice('Project unlinked. Future activity stays local.', 'success');
    else setTeamNotice('', '');
    loadTeam();
  }).catch(function (err) {
    setTeamNotice(err.message, 'error');
    loadTeam();
  });
}

function handleTeamChange(e) {
  var el = e.target.closest('[data-team-change]');
  if (!el) return;
  var act = el.dataset.teamChange;
  if (act === 'switch') {
    var v = el.value;
    if (v === '__create' || v === '__join') {
      hubPanel = v === '__create' ? 'create' : 'join';
      renderCurrent(); // rebuild resets the select back to the current team
      return;
    }
    rememberTeam(v);
    hubFilters = { author: '', project: '', source: '' };
    hubPanel = '';
    setTeamNotice('', '');
    loadTeam();
    return;
  }
  if (act === 'filter') {
    hubFilters[el.dataset.filter] = el.value;
    reloadFeedOnly();
    return;
  }
  if (act === 'set-role') {
    el.disabled = true;
    teamRequest('/api/team/set-role', { teamId: teamSelId, userId: el.dataset.userId, role: el.value }).then(function () {
      setTeamNotice('Role updated.', 'success');
      loadTeam();
    }).catch(function (err) { setTeamNotice(err.message, 'error'); loadTeam(); });
  }
}

function handleTeamSubmit(e) {
  var form = e.target.closest('[data-team-form]');
  if (!form) return;
  e.preventDefault();
  var data = new FormData(form);
  var kind = form.dataset.teamForm;
  var path = null;
  var body = null;
  var after = null;
  if (kind === 'signup' || kind === 'login') {
    path = '/api/team/' + kind;
    body = { displayName: data.get('displayName'), email: data.get('email'), password: data.get('password') };
  } else if (kind === 'team-create') {
    path = '/api/team/create';
    body = { name: data.get('teamName') };
    after = function (result) {
      if (result.team_id) rememberTeam(result.team_id);
      hubPanel = '';
      setTeamNotice('Team created. Use + Invite to bring people in.', 'success');
    };
  } else if (kind === 'team-join') {
    path = '/api/team/join';
    body = { inviteCode: data.get('inviteCode') };
    after = function (result) {
      if (result.team_id) rememberTeam(result.team_id);
      hubPanel = '';
      setTeamNotice('Joined ' + (result.team_name || 'the team') + '.', 'success');
    };
  } else if (kind === 'team-rename') {
    path = '/api/team/rename';
    body = { teamId: teamSelId, name: data.get('name') };
    after = function () { setTeamNotice('Team renamed.', 'success'); };
  } else if (kind === 'invite-create') {
    path = '/api/team/invite';
    body = { teamId: teamSelId, expiresDays: data.get('expiresDays'), maxUses: data.get('maxUses') };
    after = function (inv) {
      (hubInvites[teamSelId] = hubInvites[teamSelId] || []).unshift(inv);
      copyText(inv.url || ('membridge join ' + inv.token));
      setTeamNotice(inv.url
        ? 'Invite link copied - anyone with it can join as a member.'
        : 'No web app configured - copied a "membridge join" command instead.', 'success');
    };
  }
  if (!path) return;
  var submit = e.submitter || form.querySelector('[type=submit]');
  if (submit) submit.disabled = true;
  teamRequest(path, body).then(function (result) {
    if (result.needsConfirmation) setTeamNotice('Check ' + result.email + ' to confirm your account, then log in.', 'success');
    else if (kind === 'signup' || kind === 'login') setTeamNotice('', '');
    if (after) after(result);
    loadTeam();
  }).catch(function (err) {
    setTeamNotice(err.message, 'error');
    loadTeam();
  });
}
teamRoot.addEventListener('click', handleTeamClick);
authRoot.addEventListener('click', handleTeamClick);
teamRoot.addEventListener('change', handleTeamChange);
teamRoot.addEventListener('submit', handleTeamSubmit);
authRoot.addEventListener('submit', handleTeamSubmit);
`;

module.exports = { teamCss, teamHtml, teamJs };
