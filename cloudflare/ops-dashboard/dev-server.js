'use strict';
// Local review server for the ops dashboard. Serves index.html and a stubbed
// /api so the page exercises its REAL fetch path — not a demo branch — before
// anything is deployed to Cloudflare.
//
// The stub mirrors what cloudflare/ops-api/src/index.js returns, which is
// ops_snapshot() (supabase/migrations/020) plus Analytics Engine rows. Keep
// them in sync or this will prove a layout production cannot feed.
//
// The numbers are deliberately those of a REAL early-stage startup, not a
// showcase: mostly solo accounts, a stalled signup, two teams drifting, a
// core feature working on a minority of installs. A demo where everything is
// green proves nothing about whether the page communicates a problem.
//
//   node cloudflare/ops-dashboard/dev-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8788;

const DAY = 864e5;
const ago = d => new Date(Date.now() - d * DAY).toISOString();
// Week buckets, oldest first, matching ops_snapshot's date_trunc('week') keys.
const weekOf = back => {
  const d = new Date(Date.now() - back * 7 * DAY);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

const STUB = {
  viewer: 'dev@localhost',
  counters: {
    rows: [
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
    ],
  },
  business: {
    generated_at: new Date().toISOString(),
    funnel: {
      created: 12,
      synced_once: 10,
      returned: 7,
      active_7d: 5,
      multi_member: 4,
      multi_member_active: 2,
    },
    series: [7, 6, 5, 4, 3, 2, 1, 0].map(back => back).reverse().map((back, i) => ({
      week: weekOf(7 - i),
      new_teams: [1, 0, 2, 1, 3, 1, 2, 2][i],
      active_teams: [1, 1, 3, 3, 5, 4, 6, 5][i],
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
    teams: [
      { name: 'Ravenline', members: 4, created_at: ago(38), last_active: ago(0), entries_all: 412, entries_7d: 71, entries_prev_7d: 63, contributors: 4 },
      { name: 'Halcyon Labs', members: 3, created_at: ago(31), last_active: ago(1), entries_all: 286, entries_7d: 44, entries_prev_7d: 51, contributors: 3 },
      { name: 'kestrel-dev', members: 1, created_at: ago(12), last_active: ago(2), entries_all: 61, entries_7d: 19, entries_prev_7d: 22, contributors: 1 },
      { name: 'Northgate', members: 2, created_at: ago(26), last_active: ago(4), entries_all: 158, entries_7d: 12, entries_prev_7d: 44, contributors: 2 },
      { name: 'm-solo', members: 1, created_at: ago(9), last_active: ago(6), entries_all: 33, entries_7d: 8, entries_prev_7d: 11, contributors: 1 },
      { name: 'Tidewater', members: 5, created_at: ago(44), last_active: ago(11), entries_all: 340, entries_7d: 0, entries_prev_7d: 6, contributors: 4 },
      { name: 'juniper', members: 1, created_at: ago(21), last_active: ago(16), entries_all: 47, entries_7d: 0, entries_prev_7d: 0, contributors: 1 },
      { name: 'Barrow & Co', members: 2, created_at: ago(35), last_active: ago(24), entries_all: 92, entries_7d: 0, entries_prev_7d: 0, contributors: 2 },
      { name: 'lantern', members: 1, created_at: ago(19), last_active: ago(29), entries_all: 15, entries_7d: 0, entries_prev_7d: 0, contributors: 1 },
      { name: 'oakfield', members: 1, created_at: ago(52), last_active: ago(47), entries_all: 8, entries_7d: 0, entries_prev_7d: 0, contributors: 1 },
      { name: 'Pelham Group', members: 1, created_at: ago(5), last_active: null, entries_all: 0, entries_7d: 0, entries_prev_7d: 0, contributors: 0 },
      { name: 'wrenfield', members: 1, created_at: ago(2), last_active: null, entries_all: 0, entries_7d: 0, entries_prev_7d: 0, contributors: 0 },
    ],
    tool_mix: { 'claude-code': 1502, codex: 301, cursor: 37 },
  },
};

http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(STUB));
    return;
  }
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(500); res.end(String(err.message)); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`ops dashboard review server: http://127.0.0.1:${PORT}`);
});
