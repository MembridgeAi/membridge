'use strict';

// Team module for the dashboard: the auth gate (login/signup) plus the shared
// team-management builders and handlers that Settings reuses (invite, switch,
// rename, roles, membership, sharing). The standalone team hub, member pages,
// and team-project route were removed with the simplified dashboard — team
// management now lives entirely in Settings (see renderTeamSettings in
// lib/dashboard.js). Composed into lib/dashboard.js's single self-contained
// page: no build step, no external assets, ES5-style client JS.

const teamCss = `
/* ---------- team management (shared with Settings) ---------- */
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
  border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); background: color-mix(in srgb, var(--accent) 7%, transparent);
  font: 600 10px/1 var(--mono); letter-spacing: .08em; text-transform: uppercase;
}
.role-badge.owner { border-color: transparent; color: #fff; background: var(--grad); }
.mem-row .role-badge:not(.owner) { color: var(--text3); border-color: var(--border); background: none; }
.hub-panel.card { margin: 0; }
.hub-panel { margin-bottom: 14px !important; }
.mem-row { display: flex; align-items: center; gap: 11px; padding: 9px 8px; border-radius: 11px; }
.mem-row.click { cursor: pointer; }
.mem-row.click:hover { background: var(--surface-subtle); }
.mem-row .avatar { flex: none; width: 34px; height: 34px; border-radius: 11px; font-size: 13px; box-shadow: none; }
.mem-row .grow { min-width: 0; }
.mem-row strong { display: block; font-size: 13.5px; }
.mem-row small { display: block; color: var(--muted); font-size: 11.5px; }
.mem-row .meta { margin: 0; flex: none; text-align: right; font-size: 11.5px; }
.hub-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.hub-card-head h2 { font-size: 15px; }
.hub-card-head .path { flex: none; }
.inline-form { display: flex; gap: 9px; align-items: end; flex-wrap: wrap; }
.inline-form label { display: grid; gap: 6px; color: var(--muted); font: 600 10px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
.inline-form input, .inline-form select {
  min-height: 42px; padding: 0 12px; border: 1px solid var(--border); border-radius: 11px;
  background: var(--card); color: var(--text); font: 13.5px/1.4 inherit; outline: none; width: auto;
}
.inline-form input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent); }
.role-select { min-height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--card); color: var(--text); font: 12.5px/1.4 inherit; outline: none; }
`;

const teamJs = `
/* ================= team auth gate + shared management ================= */
var authRoot = document.getElementById('authRoot');
var teamAuthMode = 'login';
var emailAuthOpen = false;  // auth screen: false shows the "Continue with email" button
var teamNoticeText = '';
var teamNoticeKind = '';
var teamState = null;      // last /api/team payload
var curTeam = null;        // team object currently selected (in Settings)
var curSub = { kind: 'hub' };
var teamSelId = '';
try { teamSelId = localStorage.getItem('mb-team') || ''; } catch (err) {}
var hubPanel = '';         // '' | 'invite' | 'settings' | 'create' | 'join'
var hubMembers = [];
var hubProjects = [];
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

// Auth screen body (rendered into #authRoot inside the template's centered card).
// Closed: the template's "Continue with email" button. Open: the email
// sign-in / create-account form wired to /api/team/login + /api/team/signup.
function authRootHtml() {
  if (!emailAuthOpen) {
    return '<button data-team-action="show-email" style="width:100%;height:48px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s ease-out" style-hover="border-color:var(--accent-brd);box-shadow:var(--shadow-md)">Continue with email</button>';
  }
  var signup = teamAuthMode === 'signup';
  var inp = 'width:100%;height:44px;padding:0 13px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);font-size:14px;outline:none;font-family:inherit';
  return '<form class="team-form" data-team-form="' + (signup ? 'signup' : 'login') + '" style="text-align:left;display:flex;flex-direction:column;gap:10px">' +
    '<div style="display:flex;gap:8px;margin-bottom:2px">' +
      '<button type="button" data-team-action="auth-mode" data-mode="login" style="flex:1;height:34px;border-radius:10px;border:1px solid ' + (!signup ? 'var(--accent-brd)' : 'var(--border)') + ';background:' + (!signup ? 'var(--accent-soft)' : 'var(--card)') + ';color:' + (!signup ? 'var(--accent)' : 'var(--text2)') + ';font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Log in</button>' +
      '<button type="button" data-team-action="auth-mode" data-mode="signup" style="flex:1;height:34px;border-radius:10px;border:1px solid ' + (signup ? 'var(--accent-brd)' : 'var(--border)') + ';background:' + (signup ? 'var(--accent-soft)' : 'var(--card)') + ';color:' + (signup ? 'var(--accent)' : 'var(--text2)') + ';font-size:13px;font-weight:600;cursor:pointer;font-family:inherit">Create account</button></div>' +
    (signup ? '<input name="displayName" autocomplete="name" placeholder="How teammates see you" required style="' + inp + '" />' : '') +
    '<input name="email" type="email" autocomplete="email" placeholder="you@company.com" required style="' + inp + '" />' +
    '<input name="password" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '" placeholder="At least 6 characters" required style="' + inp + '" />' +
    teamNoticeHtml() +
    '<button type="submit" style="width:100%;height:48px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent)">' + (signup ? 'Create my workspace' : 'Open MemBridge') + '</button>' +
    '<button type="button" data-team-action="stay-local" style="width:100%;height:40px;border:none;background:none;color:var(--text3);font-size:13px;cursor:pointer;font-family:inherit">Continue without an account &rarr;</button></form>';
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
    stopHome(); stopProject(); showView();
    // Local-first: keep the active non-auth view running (Home/Project/Settings).
    // Guarded so the auth view never re-enters applyRun -> loadTeam (the fixed loop).
    if (currentTab() !== 'auth') applyRun();
    return;
  }
  if (!d.authenticated) {
    document.body.className = 'session-ready signed-out';
    authRoot.innerHTML = authRootHtml();
    stopHome(); stopProject(); showView();
    // Local-first: keep the active non-auth view running (Home/Project/Settings).
    // Guarded so the auth view never re-enters applyRun -> loadTeam (the fixed loop).
    if (currentTab() !== 'auth') applyRun();
    return;
  }
  document.body.className = 'session-ready signed-in';
  authRoot.innerHTML = '';
  if (!wasSignedIn) applyTab();
  // The team surface lives entirely in Settings now: refresh it when active.
  // Any other tab is a boot/gate-only call — set the body class and stop.
  if (currentTab() === 'settings') { renderTeamSettings(d); return; }
}
// In Settings, re-render the management panels so handlers that call
// renderCurrent() (e.g. revoke-invite) refresh the Settings view.
function renderCurrent() {
  if (currentTab() === 'settings') { if (teamState) renderTeamSettings(teamState); return; }
}

/* ---- team-management building blocks (shared with Settings) ---- */
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
    '<button class="btn primary" type="submit">Create &amp; copy code</button></form>';
  var invs = hubInvites[team.team_id] || [];
  if (invs.length) {
    h += '<div class="team-list" style="margin-top:14px">' + invs.map(function (inv) {
      return '<div class="team-row"><div class="grow"><strong class="invite" style="font-size:12px">' + esc(inv.token) + '</strong>' +
        '<small>' + (inv.expires_at ? 'expires ' + esc(String(inv.expires_at).slice(0, 10)) : 'no expiry') +
        ' &middot; ' + (inv.max_uses ? inv.max_uses + ' use' + (inv.max_uses === 1 ? '' : 's') + ' max' : 'unlimited uses') + '</small></div>' +
        '<button class="btn" data-team-action="copy-invite" data-code="' + esc(inv.token) + '">Copy code</button>' +
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
  // Profile/logout lives in the standalone Account card (accountRowHtml) now —
  // exactly one Log out across Settings.
  return h + '</div>';
}
function createJoinPanelHtml(which) {
  var create = which === 'create';
  return '<div class="card hub-panel"><div class="hub-card-head"><h2>' + (create ? 'Create a new team' : 'Join a team') + '</h2>' +
    '<button class="btn ghost" data-team-action="panel-close">Close</button></div>' +
    (create
      ? '<form class="inline-form" data-team-form="team-create"><label>Team name<input name="teamName" placeholder="Acme design" required style="width:220px"></label><button class="btn primary" type="submit">Create team</button></form>'
      : '<form class="inline-form" data-team-form="team-join"><label>Invite code<input name="inviteCode" placeholder="Paste an invite code" required style="width:300px"></label><button class="btn primary" type="submit">Join team</button></form>') +
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
  if (action === 'show-email') { emailAuthOpen = true; setTeamNotice('', ''); loadTeam(); return; }
  if (action === 'stay-local') { location.hash = '#home'; return; }
  if (action === 'retry') { loadTeam(); return; }
  if (action === 'panel-invite') { hubPanel = hubPanel === 'invite' ? '' : 'invite'; renderCurrent(); return; }
  if (action === 'panel-settings') { hubPanel = hubPanel === 'settings' ? '' : 'settings'; renderCurrent(); return; }
  if (action === 'panel-close') { hubPanel = ''; renderCurrent(); return; }
  if (action === 'copy-invite') {
    copyText(btn.dataset.code).then(function () { copyDone(btn, 'Copied'); });
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
    hubPanel = '';
    setTeamNotice('', '');
    loadTeam();
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
      copyText(inv.token);
      setTeamNotice('Invite code copied — share it and they run "membridge join <code>" or paste it in Join a team.', 'success');
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
// The auth gate binds to authRoot; Settings binds the same handlers to
// teamSettingsRoot (see lib/dashboard.js). There is no team-hub container.
authRoot.addEventListener('click', handleTeamClick);
authRoot.addEventListener('submit', handleTeamSubmit);
`;

module.exports = { teamCss, teamJs };
