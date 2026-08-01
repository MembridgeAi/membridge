'use strict';
// Local review server for the ops panel. Serves public/index.html plus a stubbed API
// that mirrors cloudflare/ops-api/src/index.js — including the WRITE actions,
// held in memory — so the panel can be clicked through end to end before
// anything is deployed. The page exercises its real fetch paths, not a demo
// branch.
//
// Keep the shapes in sync with ops-api and with supabase/migrations/020-022,
// or this will prove a panel production cannot feed.
//
// public/ is the ONLY thing deployed. This file lives outside it deliberately:
// it carries invented team names and would otherwise be published alongside the
// panel by a directory-wide `pages deploy`.
//
// The stub numbers are those of a real early-stage startup, not a showcase:
// mostly solo accounts, two stalled signups, several teams drifting, and a
// core feature working on a minority of installs. A demo where everything is
// green proves nothing about whether the panel communicates a problem.
//
//   node cloudflare/ops-dashboard/dev-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.argv[2]) || 8788;
const DAY = 864e5;
const ago = d => new Date(Date.now() - d * DAY).toISOString();
const weekOf = back => {
  const d = new Date(Date.now() - back * 7 * DAY);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const uuid = () => crypto.randomUUID();

// --- mutable in-memory state ----------------------------------------------
const teams = [
  { id: uuid(), name: 'Ravenline',    members: 4, created_at: ago(38), last_active: ago(0),  entries_all: 412, entries_7d: 71, entries_prev_7d: 63, contributors: 4, note: 'Design partner. Wants per-repo scoping.', internal: false },
  { id: uuid(), name: 'Halcyon Labs', members: 3, created_at: ago(31), last_active: ago(1),  entries_all: 286, entries_7d: 44, entries_prev_7d: 51, contributors: 3, note: null, internal: false },
  { id: uuid(), name: 'kestrel-dev',  members: 1, created_at: ago(12), last_active: ago(2),  entries_all: 61,  entries_7d: 19, entries_prev_7d: 22, contributors: 1, note: null, internal: false },
  { id: uuid(), name: 'Northgate',    members: 2, created_at: ago(26), last_active: ago(4),  entries_all: 158, entries_7d: 12, entries_prev_7d: 44, contributors: 2, note: 'Two devs left the company.', internal: false },
  { id: uuid(), name: 'm-solo',       members: 1, created_at: ago(9),  last_active: ago(6),  entries_all: 33,  entries_7d: 8,  entries_prev_7d: 11, contributors: 1, note: null, internal: false },
  { id: uuid(), name: 'Tidewater',    members: 5, created_at: ago(44), last_active: ago(11), entries_all: 340, entries_7d: 0,  entries_prev_7d: 6,  contributors: 4, note: null, internal: false },
  { id: uuid(), name: 'juniper',      members: 1, created_at: ago(21), last_active: ago(16), entries_all: 47,  entries_7d: 0,  entries_prev_7d: 0,  contributors: 1, note: null, internal: false },
  { id: uuid(), name: 'Barrow & Co',  members: 2, created_at: ago(35), last_active: ago(24), entries_all: 92,  entries_7d: 0,  entries_prev_7d: 0,  contributors: 2, note: null, internal: false },
  { id: uuid(), name: 'lantern',      members: 1, created_at: ago(19), last_active: ago(29), entries_all: 15,  entries_7d: 0,  entries_prev_7d: 0,  contributors: 1, note: null, internal: false },
  { id: uuid(), name: 'oakfield',     members: 1, created_at: ago(52), last_active: ago(47), entries_all: 8,   entries_7d: 0,  entries_prev_7d: 0,  contributors: 1, note: null, internal: false },
  { id: uuid(), name: 'Pelham Group', members: 1, created_at: ago(5),  last_active: null,    entries_all: 0,   entries_7d: 0,  entries_prev_7d: 0,  contributors: 0, note: 'Signed up after the HN post, never installed.', internal: false },
  { id: uuid(), name: 'wrenfield',    members: 1, created_at: ago(2),  last_active: null,    entries_all: 0,   entries_7d: 0,  entries_prev_7d: 0,  contributors: 0, note: null, internal: false },
];
const audit = [];
const invites = [];
const ACTOR = 'dev@localhost';

const log = (action, team, detail = {}) =>
  audit.unshift({ actor: ACTOR, action, team: team ? team.name : null, detail, at: new Date().toISOString() });

const counters = { rows: [
  { name: 'heartbeat', version: '0.1.7', dim_key: '', dim_value: '', total: 41 },
  { name: 'heartbeat', version: '0.1.6', dim_key: '', dim_value: '', total: 7 },
  { name: 'recall_state', version: '0.1.7', dim_key: 'state', dim_value: 'no_hot_paths', total: 22 },
  { name: 'recall_state', version: '0.1.7', dim_key: 'state', dim_value: 'serving', total: 11 },
  { name: 'recall_state', version: '0.1.7', dim_key: 'state', dim_value: 'ready_unserved', total: 6 },
  { name: 'recall_state', version: '0.1.6', dim_key: 'state', dim_value: 'all_rejected', total: 2 },
  { name: 'environment', version: '0.1.7', dim_key: 'shape', dim_value: 'single', total: 21 },
  { name: 'environment', version: '0.1.7', dim_key: 'shape', dim_value: 'worktree', total: 19 },
  { name: 'hook_registration', version: '0.1.7', dim_key: 'result', dim_value: 'current', total: 44 },
  { name: 'hook_registration', version: '0.1.7', dim_key: 'result', dim_value: 'failed', total: 3 },
] };

// Mirrors ops_snapshot v3: internal teams drop out of every figure.
function snapshot() {
  const live = teams.filter(t => !t.internal);
  const synced = live.filter(t => t.last_active);
  const active7 = live.filter(t => t.last_active && Date.now() - new Date(t.last_active) < 7 * DAY);
  const multi = live.filter(t => t.members > 1);
  return {
    generated_at: new Date().toISOString(),
    funnel: {
      created: live.length,
      synced_once: synced.length,
      returned: synced.filter(t => t.entries_all > 5).length,
      active_7d: active7.length,
      multi_member: multi.length,
      multi_member_active: multi.filter(t => active7.includes(t)).length,
    },
    series: [0, 1, 2, 3, 4, 5, 6, 7].map((_, i) => ({
      week: weekOf(7 - i),
      new_teams: [1, 0, 2, 1, 3, 1, 2, 2][i],
      active_teams: [1, 1, 3, 3, 5, 4, 6, active7.length][i],
      active_devs: [1, 2, 4, 4, 8, 7, 11, 9][i],
      entries: [12, 20, 58, 44, 130, 96, 210, 164][i],
    })),
    cohorts: [
      { week: weekOf(5), size: 3, wk1: 2, wk2: 1, wk4: 1 },
      { week: weekOf(4), size: 1, wk1: 1, wk2: 1, wk4: 0 },
      { week: weekOf(3), size: 2, wk1: 1, wk2: 1, wk4: 0 },
      { week: weekOf(2), size: 2, wk1: 2, wk2: 0, wk4: 0 },
      { week: weekOf(1), size: 2, wk1: 1, wk2: 0, wk4: 0 },
    ],
    teams: live.slice().sort((a, b) => (b.last_active || '') > (a.last_active || '') ? 1 : -1),
    excluded_internal: teams.filter(t => t.internal).length,
    tool_mix: { 'claude-code': 1502, codex: 301, cursor: 37 },
  };
}

function teamDetail(id) {
  const t = teams.find(x => x.id === id);
  if (!t) return null;
  const names = ['ana', 'ben', 'chi', 'dev', 'eli'];
  return {
    name: t.name, created_at: t.created_at, note: t.note, internal: t.internal,
    members: Array.from({ length: t.members }, (_, i) => ({
      name: `${names[i % names.length]}@example.com`, role: i === 0 ? 'owner' : 'member', joined_at: ago(30 - i * 3),
    })),
    projects: t.entries_all ? [
      { name: 'api', entries: Math.round(t.entries_all * 0.6), last_ts: t.last_active },
      { name: 'web', entries: Math.round(t.entries_all * 0.4), last_ts: t.last_active },
    ] : [],
    weeks: Array.from({ length: 12 }, (_, i) => ({
      week: weekOf(11 - i),
      entries: t.entries_all ? Math.max(0, Math.round(t.entries_all / 12 * (0.4 + Math.abs(Math.sin(i + t.name.length))))) : 0,
    })),
  };
}

// Mirrors the ops-api action allowlist. Anything else is rejected.
function runAction(body) {
  const t = teams.find(x => x.id === body.team);
  switch (body.action) {
    case 'set_note':
      if (!t) throw new Error('no such team');
      t.note = body.note || null; log('set_note', t, { length: (body.note || '').length });
      return { ok: true };
    case 'set_internal':
      if (!t) throw new Error('no such team');
      t.internal = !!body.internal; log('set_internal', t, { internal: t.internal });
      return { ok: true };
    case 'rotate_invite': {
      if (!t) throw new Error('no such team');
      log('rotate_invite', t); return { ok: true, invite_code: uuid() };
    }
    case 'onboard': {
      if (!body.team_name) throw new Error('team name required');
      const token = crypto.randomBytes(16).toString('hex');
      invites.unshift({
        token, team_name: body.team_name, note: body.note || null, created_by: ACTOR,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + (body.days || 14) * DAY).toISOString(),
        redeemed_at: null, redeemed_team: null,
      });
      log('create_onboarding_invite', null, { team_name: body.team_name });
      return { ok: true, token };
    }
    default:
      throw new Error('unknown action');
  }
}

const send = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (req.method === 'POST' && url === '/api/action') {
    // The real Worker also enforces same-origin + JSON content-type as CSRF
    // defence; mirrored loosely here so a mistake shows up locally too.
    if (!(req.headers['content-type'] || '').includes('application/json')) return send(res, 403, { error: 'bad request context' });
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { send(res, 200, { ok: true, result: runAction(JSON.parse(raw)) }); }
      catch (e) { send(res, 400, { error: e.message }); }
    });
    return;
  }

  const m = url.match(/^\/api\/team\/([0-9a-f-]{36})$/i);
  if (m) {
    const d = teamDetail(m[1]);
    return d ? send(res, 200, { team: d }) : send(res, 404, { error: 'not found' });
  }

  if (url === '/api') {
    return send(res, 200, { counters, business: snapshot(), audit: audit.slice(0, 50), invites, viewer: ACTOR });
  }

  if (url === '/' || url === '/index.html') {
    return fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); return res.end(String(err.message)); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }

  res.writeHead(404); res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ops panel review server: http://127.0.0.1:${PORT}`);
});
