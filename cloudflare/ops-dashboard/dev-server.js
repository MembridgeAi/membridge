'use strict';
// Local review server for the ops dashboard. Serves index.html and a stubbed
// /api so the page exercises its REAL fetch path — not its demo branch —
// before anything is deployed to Cloudflare.
//
// The stub returns the same shape cloudflare/ops-api/src/index.js returns:
// { counters: { rows }, business: {...}, viewer }. Keep them in sync, or this
// server will happily prove a layout that production cannot feed.
//
//   node cloudflare/ops-dashboard/dev-server.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.argv[2]) || 8788;

// Deliberately unflattering sample data: most installs NOT serving, some
// registration failures, a dormant team. A demo that shows everything healthy
// teaches you nothing about whether the page communicates a problem.
const STUB = {
  viewer: 'dev@localhost',
  counters: {
    rows: [
      { name: 'heartbeat', version: '0.1.7', dim_key: '', dim_value: '', total: 41 },
      { name: 'heartbeat', version: '0.1.6', dim_key: '', dim_value: '', total: 7 },
      { name: 'heartbeat', version: '0.1.2', dim_key: '', dim_value: '', total: 2 },
      { name: 'recall_state', version: '0.1.7', dim_key: 'state', dim_value: 'no_hot_paths', total: 22 },
      { name: 'recall_state', version: '0.1.7', dim_key: 'state', dim_value: 'serving', total: 11 },
      { name: 'recall_state', version: '0.1.7', dim_key: 'state', dim_value: 'ready_unserved', total: 6 },
      { name: 'recall_state', version: '0.1.6', dim_key: 'state', dim_value: 'all_rejected', total: 2 },
      { name: 'environment', version: '0.1.7', dim_key: 'shape', dim_value: 'single', total: 21 },
      { name: 'environment', version: '0.1.7', dim_key: 'shape', dim_value: 'worktree', total: 19 },
      { name: 'environment', version: '0.1.7', dim_key: 'shape', dim_value: 'mixed', total: 8 },
      { name: 'hook_registration', version: '0.1.7', dim_key: 'result', dim_value: 'current', total: 44 },
      { name: 'hook_registration', version: '0.1.7', dim_key: 'result', dim_value: 'wrote', total: 9 },
      { name: 'hook_registration', version: '0.1.7', dim_key: 'result', dim_value: 'failed', total: 3 },
    ],
  },
  business: {
    generated_at: new Date().toISOString(),
    teams: { total: 12, created_7d: 3, created_30d: 9, active_7d: 7, active_30d: 10, dormant_7d: 4, never_active: 1 },
    team_sizes: { solo: 6, two_to_three: 4, four_to_nine: 2, ten_plus: 0, largest: 6 },
    projects: { total: 19, teams_with_multiple: 4 },
    developers: { active_7d: 14, active_30d: 23 },
    entries: { total: 1840, last_7d: 296 },
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
