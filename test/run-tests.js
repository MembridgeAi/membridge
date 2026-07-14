'use strict';
// Zero-dependency end-to-end tests. Everything runs against a throwaway temp
// dir via MEMBRIDGE_* env overrides — no real user files are read or written.
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-test-'));
process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home');
process.env.MEMBRIDGE_CLAUDE_DIR = path.join(ROOT, 'claude-projects');
process.env.MEMBRIDGE_CODEX_DIR = path.join(ROOT, 'codex-sessions');
process.env.MEMBRIDGE_INTERVAL = '3600'; // daemon ticks once at boot, then stays quiet
delete process.env.ANTHROPIC_API_KEY; // a real key on the dev machine must not leak into settings tests

const util = require('../lib/util');
const { syncOnce } = require('../lib/scan');
const digest = require('../lib/digest');
const { buildGraph } = require('../lib/graph');
const { startServer, teamPayload, teamProjectsPayload } = require('../lib/server');
const teamsync = require('../lib/teamsync');
const { createMockSupabase } = require('./mock-supabase');
const advisorLib = require('../lib/advisor');
const memorydb = require('../lib/memorydb');
const claudeAdapter = require('../lib/adapters/claude-code');
const codexAdapter = require('../lib/adapters/codex');
const hooks = require('../lib/hooks');
const redactLib = require('../lib/redact');

const BIN = path.join(__dirname, '..', 'bin', 'membridge.js');
const proj1 = path.join(ROOT, 'projects', 'shop-app');
const proj2 = path.join(ROOT, 'projects', 'excluded-app');
const proj3 = path.join(ROOT, 'projects', 'marker-app');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push([name, null]);
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push([name, err]);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const read = f => fs.readFileSync(f, 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

function setupFixtures() {
  for (const p of [proj1, proj2, proj3]) fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(proj1, 'CLAUDE.md'), '# Shop app\n\nOriginal notes that must survive.\n');
  fs.mkdirSync(path.join(proj1, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj1, 'src', 'login.js'), 'export const login = () => {};\n');
  fs.mkdirSync(path.join(proj1, 'node_modules', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(proj1, 'node_modules', 'junk', 'index.js'), 'ignored\n');
  fs.writeFileSync(path.join(proj3, '.membridge-off'), '');

  // Claude Code sessions
  const cDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app');
  fs.mkdirSync(cDir, { recursive: true });
  fs.writeFileSync(path.join(cDir, 'sess1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Build the login page with OAuth' }, cwd: proj1, timestamp: '2026-07-09T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Use api_key=sk-test1234567890abcdef for the Stripe sandbox' }] }, cwd: proj1, timestamp: '2026-07-09T10:01:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: proj1, timestamp: '2026-07-09T10:02:00.000Z' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'meta noise must not appear' }, cwd: proj1, timestamp: '2026-07-09T10:03:00.000Z' },
    { type: 'user', message: { role: 'user', content: '<command-name>/help</command-name>' }, cwd: proj1, timestamp: '2026-07-09T10:04:00.000Z' },
  ]));
  const cDir2 = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-others');
  fs.mkdirSync(cDir2, { recursive: true });
  fs.writeFileSync(path.join(cDir2, 'sess2.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Excluded project work' }, cwd: proj2, timestamp: '2026-07-09T10:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'Marker project work' }, cwd: proj3, timestamp: '2026-07-09T10:00:00.000Z' },
  ]));

  // Codex rollout
  const xDir = path.join(process.env.MEMBRIDGE_CODEX_DIR, '2026', '07', '09');
  fs.mkdirSync(xDir, { recursive: true });
  fs.writeFileSync(path.join(xDir, 'rollout-1.jsonl'), jsonl([
    { timestamp: '2026-07-09T10:05:00.000Z', type: 'session_meta', payload: { id: 'abc', cwd: proj1 } },
    { timestamp: '2026-07-09T10:06:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add unit tests for the login form' }] } },
  ]));

  // A hypothetical third-party tool, wired via the custom adapter
  const mDir = path.join(ROOT, 'mytool-sessions');
  fs.mkdirSync(mDir, { recursive: true });
  fs.writeFileSync(path.join(mDir, 'log.jsonl'), jsonl([
    { when: '2026-07-09T10:07:00.000Z', dir: proj1, who: 'user', say: 'Refactor the login styles' },
    { when: '2026-07-09T10:07:30.000Z', dir: proj1, who: 'assistant', say: 'assistant chatter must not appear' },
  ]));

  // Config: exclude proj2, add the custom adapter
  util.ensureConfig();
  const cfg = util.loadUserConfig();
  cfg.exclude = [proj2];
  cfg.adapters = cfg.adapters || {};
  cfg.adapters.custom = [{
    id: 'mytool',
    displayName: 'MyTool',
    dir: mDir,
    fields: { project: 'dir', timestamp: 'when', text: 'say', role: 'who', roleValue: 'user' },
  }];
  util.saveUserConfig(cfg);
}

async function waitForHttp(url, ms = 15000) {
  const t0 = Date.now();
  let lastErr;
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
      lastErr = new Error(`status ${r.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}: ${lastErr && lastErr.message}`);
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });

async function main() {
  console.log(`MemBridge test suite (fixtures in ${ROOT})\n`);
  setupFixtures();

  // --- 1. fresh sync ---
  const r1 = syncOnce();
  const claudeMd = () => read(path.join(proj1, 'CLAUDE.md'));
  const agentsMd = () => read(path.join(proj1, 'AGENTS.md'));

  check('fresh sync finds events from all three tools', () => {
    assert.ok(r1.newEvents >= 6, `expected >=6 events, got ${r1.newEvents}`);
  });
  check('CLAUDE.md gets the memory block and keeps original content', () => {
    const md = claudeMd();
    assert.ok(md.startsWith('# Shop app'), 'original heading lost');
    assert.ok(md.includes('Original notes that must survive.'), 'original body lost');
    assert.ok(md.includes(digest.BEGIN) && md.includes(digest.END), 'markers missing');
    assert.ok(md.includes('Build the login page with OAuth'), 'Claude prompt missing');
  });
  check('AGENTS.md is created with the same shared memory', () => {
    const md = agentsMd();
    assert.ok(md.includes(digest.BEGIN), 'markers missing');
    assert.ok(md.includes('Add unit tests for the login form'), 'Codex prompt missing');
  });
  check('cross-tool: Claude, Codex and custom-adapter prompts all present', () => {
    const md = claudeMd();
    assert.ok(md.includes('Claude Code:'), 'Claude Code source missing');
    assert.ok(md.includes('Codex:'), 'Codex source missing');
    assert.ok(md.includes('MyTool: Refactor the login styles'), 'custom adapter prompt missing');
  });
  check('noise is filtered (meta, command wrappers, assistant lines)', () => {
    const md = claudeMd();
    assert.ok(!md.includes('meta noise'), 'isMeta leaked');
    assert.ok(!md.includes('command-name'), 'command wrapper leaked');
    assert.ok(!md.includes('assistant chatter'), 'non-user custom line leaked');
  });
  check('secrets are redacted before injection', () => {
    const md = claudeMd();
    assert.ok(!md.includes('sk-test1234567890abcdef'), 'API key leaked');
    assert.ok(md.includes('[redacted'), 'no redaction marker');
  });
  check('recently modified files are listed', () => {
    assert.ok(claudeMd().includes('login.js'), 'edited file missing');
  });
  check('project memory DB is created with entries referencing files', () => {
    const db = JSON.parse(read(path.join(proj1, '.membridge', 'memory.json')));
    assert.ok(db.entries.find(e => e.ask.includes('Build the login page')), 'entry missing');
    // the 10:02 edit belongs to the most recent ask before it (10:01)
    const withFile = db.entries.find(e => e.files.includes('src/login.js'));
    assert.ok(withFile, 'no entry references the edited file');
    assert.strictEqual(withFile.source, 'Claude Code');
    assert.strictEqual(withFile.ts, '2026-07-09T10:01:00.000Z', 'edit attached to wrong ask');
    const banned = db.entries.find(e => e.ask.includes('sk-test1234567890abcdef'));
    assert.ok(!banned, 'secret leaked into memory DB');
  });
  check('file index covers project files and skips ignored dirs', () => {
    const db = JSON.parse(read(path.join(proj1, '.membridge', 'memory.json')));
    const paths = db.fileIndex.files.map(f => f.path);
    assert.ok(paths.includes('src/login.js'), 'src/login.js not indexed');
    assert.ok(paths.includes('CLAUDE.md'), 'CLAUDE.md not indexed');
    assert.ok(!paths.some(p => p.startsWith('node_modules')), 'node_modules indexed');
    assert.ok(!paths.some(p => p.startsWith('.membridge')), 'own dir indexed');
    assert.ok(db.fileIndex.files.every(f => typeof f.size === 'number' && f.mtime), 'index entries incomplete');
  });
  check('memory.md renders the log and the injected block points to it', () => {
    const md = read(path.join(proj1, '.membridge', 'memory.md'));
    assert.ok(md.includes('Claude Code'), 'source missing in memory.md');
    assert.ok(md.includes('`src/login.js`'), 'file reference missing in memory.md');
    assert.ok(md.includes('File index:'), 'file index summary missing');
    assert.ok(claudeMd().includes('.membridge/memory.md'), 'context block does not point at memory log');
  });
  check('excluded/paused projects get no memory DB', () => {
    assert.ok(!fs.existsSync(path.join(proj2, '.membridge')), 'excluded project got a DB');
    assert.ok(!fs.existsSync(path.join(proj3, '.membridge')), 'marker project got a DB');
  });
  check('excluded project is untouched', () => {
    assert.ok(!fs.existsSync(path.join(proj2, 'CLAUDE.md')), 'exclude ignored');
    assert.ok(!fs.existsSync(path.join(proj2, 'AGENTS.md')), 'exclude ignored');
  });
  check('.membridge-off project is untouched', () => {
    assert.ok(!fs.existsSync(path.join(proj3, 'CLAUDE.md')), 'marker ignored');
  });

  // --- 2. incremental sync ---
  fs.appendFileSync(
    path.join(process.env.MEMBRIDGE_CODEX_DIR, '2026', '07', '09', 'rollout-1.jsonl'),
    JSON.stringify({ timestamp: '2026-07-09T10:10:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Wire up the payment API' } }) + '\n',
  );
  const r2 = syncOnce();
  check('incremental: only the appended event is read', () => {
    assert.strictEqual(r2.newEvents, 1, `expected 1 new event, got ${r2.newEvents}`);
  });
  check('incremental: block updated in place, no duplicates', () => {
    const md = claudeMd();
    assert.ok(md.includes('Wire up the payment API'), 'new prompt missing');
    assert.strictEqual(count(md, 'Build the login page with OAuth'), 1, 'duplicate prompt');
    assert.strictEqual(count(md, digest.BEGIN), 1, 'duplicate block');
  });
  check('sync with no new events changes nothing', () => {
    const before = claudeMd();
    const r3 = syncOnce();
    assert.strictEqual(r3.newEvents, 0);
    assert.strictEqual(r3.changes.length, 0);
    assert.strictEqual(claudeMd(), before);
  });

  // --- 3. remove ---
  check('remove strips blocks, restores originals, deletes the memory DB', () => {
    const out = spawnSync(process.execPath, [BIN, 'remove', '--project', proj1], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(claudeMd(), '# Shop app\n\nOriginal notes that must survive.\n', 'original not restored');
    assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'block-only file should be deleted');
    assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), 'memory DB not removed');
  });

  // --- 4. session ids, state migration, neural graph ---
  check('events carry per-chat session ids from the transcript filename', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === proj1.toLowerCase());
    assert.ok(key, 'proj1 missing from state');
    const events = state.projects[key].events;
    assert.ok(events.length && events.every(e => e.session), 'event without session id');
    const claudeEv = events.find(e => e.text === 'Build the login page with OAuth');
    const codexEv = events.find(e => e.text === 'Add unit tests for the login form');
    assert.ok(claudeEv && codexEv, 'expected events missing from state');
    assert.strictEqual(claudeEv.session, 'sess1');
    assert.strictEqual(codexEv.session, 'rollout-1');
    assert.notStrictEqual(claudeEv.session, codexEv.session, 'sessions not distinct per transcript');
  });

  // Simulate a pre-v2 state file: stripping `version` must trigger a full
  // rescan of every transcript from byte 0 on the next sync.
  const v1State = JSON.parse(read(util.statePath()));
  delete v1State.version;
  fs.writeFileSync(util.statePath(), JSON.stringify(v1State, null, 2));
  const rBackfill = syncOnce();
  check('versionless state is discarded and all transcripts are re-read', () => {
    const want = r1.newEvents + r2.newEvents;
    assert.ok(rBackfill.newEvents >= want, `expected >=${want} backfill events, got ${rBackfill.newEvents}`);
    assert.strictEqual(JSON.parse(read(util.statePath())).version, util.STATE_VERSION, 'state not re-stamped');
  });
  check('backfill re-injects exactly one block, no duplicated prompts', () => {
    const md = claudeMd();
    assert.strictEqual(count(md, digest.BEGIN), 1, 'duplicate block');
    assert.strictEqual(count(md, 'Build the login page with OAuth'), 1, 'duplicate prompt');
  });

  // A second Claude Code session in the same project: same idea (OAuth login),
  // same file — the graph must connect it to sess1.
  fs.writeFileSync(path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess3.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Improve the OAuth login redirect error handling' }, cwd: proj1, timestamp: '2026-07-09T10:20:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: proj1, timestamp: '2026-07-09T10:21:00.000Z' },
  ]));
  syncOnce();

  const graph = buildGraph(util.loadState(), util.getConfig());
  check('graph: project node exists with >=3 distinct chat nodes', () => {
    const pNode = graph.nodes.find(n => n.type === 'project' && String(n.path).toLowerCase() === proj1.toLowerCase());
    assert.ok(pNode, 'proj1 project node missing');
    assert.ok(pNode.chats >= 3, `expected >=3 chats on project node, got ${pNode.chats}`);
    const chats = graph.nodes.filter(n => n.type === 'chat' && String(n.project).toLowerCase() === proj1.toLowerCase());
    assert.ok(chats.length >= 3, `expected >=3 chat nodes, got ${chats.length}`);
    assert.strictEqual(new Set(chats.map(c => c.id)).size, chats.length, 'chat ids not distinct');
  });
  check('graph: every chat node has a member link to its project', () => {
    const chats = graph.nodes.filter(n => n.type === 'chat');
    assert.ok(chats.length, 'no chat nodes at all');
    for (const c of chats) {
      assert.ok(
        graph.links.some(l => l.type === 'member' && l.source === c.id && l.target === 'p:' + c.project),
        `no member link for ${c.id}`,
      );
    }
  });
  check('graph: sess1 and sess3 are related by shared file and oauth terms', () => {
    const rel = graph.links.find(l => l.type === 'related' &&
      ((l.source === 'c:sess1' && l.target === 'c:sess3') || (l.source === 'c:sess3' && l.target === 'c:sess1')));
    assert.ok(rel, 'related link between sess1 and sess3 missing');
    assert.ok(rel.sharedFiles.some(f => f.includes('login.js')), `sharedFiles lack login.js: ${JSON.stringify(rel.sharedFiles)}`);
    assert.ok(rel.similarity > 0, `similarity not positive: ${rel.similarity}`);
    assert.ok(rel.terms.some(t => /^(oauth|login|redirect)/.test(t)), `no oauth-family term: ${JSON.stringify(rel.terms)}`);
  });
  check('graph: redacted secret never appears in graph output', () => {
    assert.ok(!JSON.stringify(graph).includes('sk-test1234567890abcdef'), 'secret leaked into graph');
  });

  // Strip everything again so the daemon section starts from the same clean
  // slate it always did (no blocks, no AGENTS.md, no memory DB).
  check('remove still cleans up after the backfill', () => {
    const out = spawnSync(process.execPath, [BIN, 'remove', '--project', proj1], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.ok(!claudeMd().includes(digest.BEGIN), 'block not stripped');
    assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'AGENTS.md not deleted');
    assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), 'memory DB not removed');
  });

  // --- 5. daemon + dashboard ---
  // Mock Anthropic API so key tests and roadmap generation stay offline
  // (advisor honors MEMBRIDGE_API_BASE).
  const GOOD_KEY = 'sk-ant-test-goodkey123';
  const AUTH_FAIL = '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
  const CANNED_PLAN = {
    summary: 'Shop-app has working OAuth login and early payment wiring; checkout is the next milestone.',
    phases: [
      {
        title: 'Checkout flow',
        tasks: [
          { task: 'Build the cart page', why: 'Users need to review items before paying', model: 'sonnet', model_reason: 'Standard UI feature work', size: 'M' },
          { task: 'Rename legacy price fields', why: 'Consistency before new code lands', model: 'haiku', model_reason: 'Mechanical rename', size: 'S' },
        ],
      },
      {
        title: 'Hardening',
        tasks: [
          { task: 'Debug the payment webhook retries', why: 'Orders drop when the webhook flakes', model: 'opus', model_reason: 'Tricky debugging across services', size: 'L' },
        ],
      },
    ],
    risks: ['Stripe sandbox limits could block end-to-end testing'],
    questions: ['Should guest checkout ship in v1?'],
  };
  let lastPlanRequest = null;
  const mockApi = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const authed = req.headers['x-api-key'] === GOOD_KEY;
      if (req.method === 'POST' && req.url === '/v1/messages/count_tokens') {
        res.writeHead(authed ? 200 : 401, { 'Content-Type': 'application/json' });
        res.end(authed ? '{"input_tokens":1}' : AUTH_FAIL);
      } else if (req.method === 'POST' && req.url === '/v1/messages') {
        if (!authed) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(AUTH_FAIL);
          return;
        }
        lastPlanRequest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          model: lastPlanRequest.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(CANNED_PLAN) }],
          usage: { input_tokens: 4200, output_tokens: 900 },
        }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise(r => mockApi.listen(17944, '127.0.0.1', r));

  const PORT = 17941;
  const apiClaudeSettings = path.join(ROOT, 'claude-settings-api.json');
  const child = spawn(process.execPath, [BIN, 'daemon'], {
    env: {
      ...process.env, MEMBRIDGE_PORT: String(PORT), MEMBRIDGE_API_BASE: 'http://127.0.0.1:17944',
      MEMBRIDGE_CLAUDE_SETTINGS: apiClaudeSettings,
    },
    stdio: 'ignore',
  });
  process.env.MEMBRIDGE_CLAUDE_SETTINGS = apiClaudeSettings; // same file, so hooks.isHookInstalled() here agrees
  const base = `http://127.0.0.1:${PORT}`;
  try {
    await waitForHttp(`${base}/api/status`);
    const status = await (await fetch(`${base}/api/status`)).json();
    check('dashboard /api/status reports daemon state', () => {
      assert.strictEqual(status.running, true);
      assert.ok(status.projectCount >= 1, 'no projects reported');
      assert.ok(status.adapters.includes('Claude Code') && status.adapters.includes('MyTool'), 'adapters missing');
    });
    const page = await fetch(base);
    const pageHtml = await page.text();
    check('dashboard page serves 200 html', () => {
      assert.strictEqual(page.status, 200);
    });
    const embeddedScript = (pageHtml.match(/<script>\n([\s\S]*)\n<\/script>/) || [])[1] || '';
    const scriptCheckPath = path.join(ROOT, 'dashboard-script.js');
    fs.writeFileSync(scriptCheckPath, embeddedScript);
    const scriptCheck = spawnSync(process.execPath, ['--check', scriptCheckPath], { encoding: 'utf8' });
    check('dashboard embedded script parses', () => {
      assert.ok(embeddedScript, 'embedded dashboard script missing');
      assert.strictEqual(scriptCheck.status, 0, scriptCheck.stderr || scriptCheck.stdout);
    });
    check('dashboard page has Overview and Neural map tabs', () => {
      assert.ok(pageHtml.includes('Overview'), 'Overview tab missing');
      assert.ok(pageHtml.includes('Neural map'), 'Neural map tab missing');
    });
    check('dashboard page has the full Team workspace', () => {
      assert.ok(pageHtml.includes('view-auth'), 'account gate missing');
      assert.ok(pageHtml.includes('view-team'), 'team view missing');
      assert.ok(pageHtml.includes("path = '/api/team/' + kind"), 'account auth flow missing');
      assert.ok(pageHtml.includes('/api/team/create'), 'team creation UI missing');
      assert.ok(pageHtml.includes('/api/team/link'), 'project linking UI missing');
      assert.ok(pageHtml.includes('/api/team/revoke-invite'), 'invite revoke UI missing');
      assert.ok(pageHtml.includes('Click again to confirm'), 'destructive-action arming missing');
      assert.ok(pageHtml.includes('data-team-form="invite-create"'), 'invite options form missing');
      assert.ok(pageHtml.includes('expiresDays'), 'invite expiry field missing');
      assert.ok(pageHtml.includes('maxUses'), 'invite max-uses field missing');
      assert.ok(pageHtml.includes("return 'auth'"), 'protected-route gate missing');
      assert.ok(pageHtml.includes('hub-grid'), 'team hub layout missing');
      assert.ok(pageHtml.includes('#team-member='), 'member drill-down route missing');
      assert.ok(pageHtml.includes('#team-project='), 'team project route missing');
      assert.ok(pageHtml.includes('/api/team/feed'), 'activity feed wiring missing');
      assert.ok(pageHtml.includes('/api/team/members'), 'members wiring missing');
    });
    check('dashboard page has the Copy for AI button', () => {
      assert.ok(pageHtml.includes('Copy for AI'), 'Copy for AI button missing');
    });
    check('dashboard page has the project view', () => {
      assert.ok(pageHtml.includes('view-project'), 'project view missing');
    });
    check('dashboard page has the Settings screen with BYOK', () => {
      assert.ok(pageHtml.includes('view-settings'), 'settings view missing');
      assert.ok(pageHtml.includes('Syncing'), 'sync section missing');
      assert.ok(pageHtml.includes('Anthropic API key'), 'key section missing');
      assert.ok(pageHtml.includes('Planner model'), 'model section missing');
      assert.ok(pageHtml.includes('Advanced: self-hosted backend'), 'self-hosted backend card missing');
      assert.ok(pageHtml.includes('stTeamUrl'), 'self-hosted backend URL field missing');
      assert.ok(pageHtml.includes('stTeamAnonKey'), 'self-hosted backend anon key field missing');
    });
    const graphRes = await fetch(`${base}/api/graph`);
    const graphText = await graphRes.text();
    check('dashboard /api/graph serves nodes and links, secrets redacted', () => {
      assert.strictEqual(graphRes.status, 200);
      const g = JSON.parse(graphText);
      assert.ok(Array.isArray(g.nodes) && g.nodes.some(n => n.type === 'chat'), 'chat nodes missing');
      assert.ok(Array.isArray(g.links) && g.links.some(l => l.type === 'member'), 'member links missing');
      assert.ok(!graphText.includes('sk-test1234567890abcdef'), 'secret leaked over HTTP');
    });
    const projects = await (await fetch(`${base}/api/projects`)).json();
    check('dashboard /api/projects lists the project with prompts', () => {
      const p = projects.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p, 'project missing');
      assert.ok(p.prompts.length >= 3, 'prompts missing');
      assert.strictEqual(p.paused, false);
    });

    // pause via API, then prove a paused project is skipped
    const tog = await (await post(`${base}/api/projects/toggle`, { path: proj1 })).json();
    check('toggle pauses the project and persists to config', () => {
      assert.strictEqual(tog.paused, true);
      assert.ok(util.loadUserConfig().exclude.includes(proj1), 'exclude not persisted');
    });
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Implement the secret feature Zeta' }, cwd: proj1, timestamp: '2026-07-09T11:00:00.000Z' }) + '\n',
    );
    await post(`${base}/api/sync`);
    check('paused project is not injected even with new activity', () => {
      assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'paused project was written');
      assert.ok(!claudeMd().includes('Implement the secret feature Zeta'), 'paused project was written');
      assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), 'paused project got a memory DB');
    });

    // resume + force a project sync
    await post(`${base}/api/projects/toggle`, { path: proj1 });
    await post(`${base}/api/sync`, { project: proj1 });
    check('resume + sync re-injects, including events captured while paused', () => {
      assert.ok(claudeMd().includes('Implement the secret feature Zeta'), 'event lost');
      assert.ok(fs.existsSync(path.join(proj1, 'AGENTS.md')), 'AGENTS.md not recreated');
    });

    // Copy for AI: the digest served to the dashboard's clipboard button
    const copyRes = await post(`${base}/api/projects/copy`, { path: proj1 });
    const copyBody = await copyRes.json();
    const copyBad = await post(`${base}/api/projects/copy`, { path: path.join(ROOT, 'no-such-dir') });
    check('copy-for-AI digest has the project, prompts and files', () => {
      assert.strictEqual(copyRes.status, 200);
      assert.ok(copyBody.text.includes('shop-app'), 'project name missing');
      assert.ok(copyBody.text.includes('Build the login page with OAuth'), 'Claude prompt missing');
      assert.ok(copyBody.text.includes('Add unit tests for the login form'), 'Codex prompt missing');
      assert.ok(copyBody.text.includes('src/login.js'), 'touched file missing');
      assert.ok(copyBody.text.includes('Project top level:'), 'top-level listing missing');
      assert.ok(!copyBody.text.includes('node_modules'), 'ignored dir leaked into top level');
    });
    check('copy-for-AI digest is redacted, unknown project 404s', () => {
      assert.ok(!copyBody.text.includes('sk-test1234567890abcdef'), 'secret leaked into copy digest');
      assert.ok(copyBody.text.includes('[redacted'), 'no redaction marker in copy digest');
      assert.strictEqual(copyBad.status, 404, 'unknown project was accepted');
    });

    // M1: grid payload + project page endpoints
    const projList = await (await fetch(`${base}/api/projects`)).json();
    check('/api/projects reports which tools were used per project', () => {
      const p = projList.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p && Array.isArray(p.tools), 'tools missing');
      assert.ok(p.tools.includes('Claude Code') && p.tools.includes('Codex'), `tools said: ${JSON.stringify(p && p.tools)}`);
    });
    // Feature 3: read-only scan/discovery view (dashboard equivalent of `membridge scan`)
    const scanRes = await fetch(`${base}/api/scan`);
    const scan = await scanRes.json();
    check('/api/scan reports adapter roots with correct exists flags', () => {
      assert.strictEqual(scanRes.status, 200);
      const claudeAdapterRoot = scan.adapters.find(a => a.displayName === 'Claude Code');
      assert.ok(claudeAdapterRoot, 'Claude Code adapter missing');
      assert.strictEqual(claudeAdapterRoot.root, process.env.MEMBRIDGE_CLAUDE_DIR);
      assert.strictEqual(claudeAdapterRoot.exists, true, 'existing Claude root reported as missing');
      const codexAdapterRoot = scan.adapters.find(a => a.displayName === 'Codex');
      assert.ok(codexAdapterRoot, 'Codex adapter missing');
      assert.strictEqual(codexAdapterRoot.exists, true, 'existing Codex root reported as missing');
    });
    check('/api/scan reports project counts and per-source breakdown', () => {
      assert.ok(scan.projectCount >= 3, `expected >=3 projects, got ${scan.projectCount}`);
      const p1 = scan.projects.find(p => p.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p1, 'shop-app missing from scan');
      // proj1's session files accumulate events across earlier tests in this run (this is a
      // fresh from-byte-0 scan), so assert the mixed-source breakdown is present with lower
      // bounds rather than brittle exact counts tied to test execution order.
      assert.ok(p1.bySource['Claude Code'] >= 4, `expected >=4 Claude Code events, got ${JSON.stringify(p1.bySource)}`);
      assert.ok(p1.bySource.Codex >= 1, `expected >=1 Codex event, got ${JSON.stringify(p1.bySource)}`);
      assert.ok(p1.bySource.MyTool >= 1, `expected >=1 MyTool event, got ${JSON.stringify(p1.bySource)}`);
    });
    check('/api/scan flags paused projects', () => {
      const p2 = scan.projects.find(p => p.path.toLowerCase() === proj2.toLowerCase());
      assert.ok(p2, 'excluded-app missing from scan');
      assert.strictEqual(p2.paused, true, 'excluded project not flagged paused');
      const p1 = scan.projects.find(p => p.path.toLowerCase() === proj1.toLowerCase());
      assert.strictEqual(p1.paused, false, 'active project incorrectly flagged paused');
    });
    check('dashboard page has the scan/discovery modal', () => {
      assert.ok(pageHtml.includes('scanOverlay'), 'scan overlay missing');
      assert.ok(pageHtml.includes('/api/scan'), 'scan fetch missing');
      assert.ok(pageHtml.includes('Detected tools'), 'scan modal title missing');
    });
    const detRes = await fetch(`${base}/api/project?path=${encodeURIComponent(proj1)}`);
    const det = await detRes.json();
    const detBad = await fetch(`${base}/api/project?path=${encodeURIComponent(path.join(ROOT, 'no-such-dir'))}`);
    check('/api/project returns the full project-page detail', () => {
      assert.strictEqual(detRes.status, 200);
      assert.strictEqual(det.name, 'shop-app');
      assert.ok(det.entries.length >= 4, `expected >=4 entries, got ${det.entries.length}`);
      assert.ok(det.entries.some(e => e.files.includes('src/login.js')), 'no entry carries the edited file');
      assert.ok(!JSON.stringify(det).includes('sk-test1234567890abcdef'), 'secret leaked into detail');
      assert.ok(det.targets.some(t => t.file === 'CLAUDE.md' && t.exists), 'targets missing');
      assert.ok(det.tools.includes('Codex'), 'tools missing from detail');
      assert.strictEqual(det.memory.exists, true, 'memory.md not reported as existing');
      assert.strictEqual(detBad.status, 404, 'unknown project was accepted');
    });
    const memRes = await fetch(`${base}/api/project/memory?path=${encodeURIComponent(proj1)}`);
    const memText = await memRes.text();
    const memBad = await fetch(`${base}/api/project/memory?path=${encodeURIComponent(path.join(ROOT, 'no-such-dir'))}`);
    check('/api/project/memory serves the memory log read-only', () => {
      assert.strictEqual(memRes.status, 200);
      assert.ok(memText.includes('Project memory'), 'memory.md content missing');
      assert.ok(!memText.includes('sk-test1234567890abcdef'), 'secret in served memory.md');
      assert.strictEqual(memBad.status, 404, 'unknown project memory was served');
    });

    // M2: settings + BYOK (key test goes to the mock Anthropic API)
    const st0 = await (await fetch(`${base}/api/settings`)).json();
    const stSave = await (await post(`${base}/api/settings`, {
      apiKey: GOOD_KEY, model: 'claude-sonnet-5', intervalSec: 45, targets: ['CLAUDE.md', 'AGENTS.md'],
    })).json();
    check('settings: key + model save, key never echoed back', () => {
      assert.strictEqual(st0.hasKey, false, 'fresh config claims a key');
      assert.strictEqual(st0.model, 'claude-haiku-4-5', 'default planner is not haiku');
      assert.strictEqual(stSave.hasKey, true);
      assert.strictEqual(stSave.keySource, 'config');
      assert.strictEqual(stSave.keyHint, '…y123');
      assert.strictEqual(stSave.model, 'claude-sonnet-5');
      assert.ok(!JSON.stringify(stSave).includes(GOOD_KEY), 'key echoed to the page');
      const rawCfg = JSON.parse(read(util.configPath()));
      assert.strictEqual(rawCfg.advisor.apiKey, GOOD_KEY, 'key not persisted');
      assert.strictEqual(rawCfg.intervalSec, 45, 'interval not persisted');
    });
    check('settings: config file is chmod 600 once a key is present', () => {
      if (process.platform === 'win32') return;
      const mode = fs.statSync(util.configPath()).mode & 0o777;
      assert.strictEqual(mode, 0o600, `mode was ${mode.toString(8)}`);
    });
    const tGood = await (await post(`${base}/api/settings/test`, {})).json();
    const tBad = await (await post(`${base}/api/settings/test`, { apiKey: 'sk-ant-wrong' })).json();
    check('settings: key test — stored key passes, bad key is rejected', () => {
      assert.strictEqual(tGood.ok, true, `good key said: ${JSON.stringify(tGood)}`);
      assert.strictEqual(tBad.ok, false);
      assert.ok(/rejected/.test(tBad.error), `bad key error said: ${tBad.error}`);
    });
    const stClear = await (await post(`${base}/api/settings`, { apiKey: '' })).json();
    check('settings: key removal + ANTHROPIC_API_KEY env fallback', () => {
      assert.strictEqual(stClear.hasKey, false, 'key not removed');
      process.env.ANTHROPIC_API_KEY = 'sk-env-fallback';
      const viaEnv = advisorLib.getAdvisorConfig({ advisor: { apiKey: '' } });
      delete process.env.ANTHROPIC_API_KEY;
      assert.strictEqual(viaEnv.source, 'env');
      assert.strictEqual(viaEnv.apiKey, 'sk-env-fallback');
      assert.strictEqual(advisorLib.getAdvisorConfig({}).source, null, 'no key should mean null source');
    });

    // Session summaries card: /api/settings exposes hookInstalled + distill,
    // and toggling distill.enabled installs/removes the Claude Code Stop hook
    // AND records consent — otherwise the first-run popup (needsConsentPrompt)
    // would keep nagging even after the Settings toggle already acted.
    const consentLib = require('../lib/consent');
    const stFresh = await (await fetch(`${base}/api/settings`)).json();
    check('settings: hookInstalled + distill fields are reported', () => {
      assert.strictEqual(stFresh.hookInstalled, false, 'hook should not be installed yet');
      assert.deepStrictEqual(stFresh.distill, { enabled: true, consent: null, minEdits: 1, checkpointEvery: 4 });
    });
    const stDistillOn = await (await post(`${base}/api/settings`, { distill: { enabled: true } })).json();
    check('settings: enabling summaries installs the Claude Code Stop hook and grants consent', () => {
      assert.strictEqual(stDistillOn.distill.enabled, true);
      assert.strictEqual(stDistillOn.distill.consent, 'granted', 'consent not recorded on enable');
      assert.strictEqual(stDistillOn.hookInstalled, true, 'hookInstalled not reflected after enabling');
      assert.strictEqual(hooks.isHookInstalled(), true, 'hook file was not actually written');
      assert.strictEqual(consentLib.needsConsentPrompt(util.getConfig()), false,
        'first-run popup would still nag after the Settings toggle enabled summaries');
    });
    const stDistillOff = await (await post(`${base}/api/settings`, { distill: { enabled: false } })).json();
    check('settings: disabling summaries removes the Claude Code Stop hook and declines consent', () => {
      assert.strictEqual(stDistillOff.distill.enabled, false);
      assert.strictEqual(stDistillOff.distill.consent, 'declined', 'consent not recorded on disable');
      assert.strictEqual(stDistillOff.hookInstalled, false, 'hookInstalled not reflected after disabling');
      assert.strictEqual(hooks.isHookInstalled(), false, 'hook file was not actually removed');
      assert.strictEqual(consentLib.needsConsentPrompt(util.getConfig()), false,
        'first-run popup would still nag after the Settings toggle disabled summaries');
    });
    const stDistillFields = await (await post(`${base}/api/settings`, {
      distill: { enabled: false, minEdits: 3, checkpointEvery: 7 },
    })).json();
    check('settings: minEdits/checkpointEvery are saved when valid', () => {
      assert.strictEqual(stDistillFields.distill.minEdits, 3);
      assert.strictEqual(stDistillFields.distill.checkpointEvery, 7);
    });
    const stDistillInvalid = await (await post(`${base}/api/settings`, {
      distill: { minEdits: 0, checkpointEvery: 'nope' },
    })).json();
    check('settings: invalid minEdits/checkpointEvery are rejected, previous values kept', () => {
      assert.strictEqual(stDistillInvalid.distill.minEdits, 3, 'invalid minEdits (0) was accepted');
      assert.strictEqual(stDistillInvalid.distill.checkpointEvery, 7, 'invalid checkpointEvery (non-numeric) was accepted');
    });
    const stTeamBackend = await (await post(`${base}/api/settings`, {
      team: { url: 'https://selfhost.supabase.co ', anonKey: ' anon-test-key ' },
    })).json();
    check('settings: self-hosted team backend is saved and reported', () => {
      assert.strictEqual(stTeamBackend.team.url, 'https://selfhost.supabase.co');
      assert.strictEqual(stTeamBackend.team.anonKey, 'anon-test-key');
      assert.strictEqual(stTeamBackend.team.customBackend, true);
      const cfg = util.getConfig();
      assert.strictEqual(cfg.team.url, 'https://selfhost.supabase.co');
      assert.strictEqual(cfg.team.anonKey, 'anon-test-key');
    });
    const stTeamBackendReset = await (await post(`${base}/api/settings`, {
      team: { url: '', anonKey: '' },
    })).json();
    check('settings: self-hosted team backend can reset to default', () => {
      assert.deepStrictEqual(stTeamBackendReset.team, { url: '', anonKey: '', customBackend: false });
      const cfg = util.getConfig();
      assert.strictEqual(cfg.team.url, '');
      assert.strictEqual(cfg.team.anonKey, '');
    });
    // Leave distill in its default post-first-run-consent-tests-friendly state
    // for any later checks in this file that rely on the default config shape.
    await post(`${base}/api/settings`, { distill: { enabled: true, minEdits: 1, checkpointEvery: 4 } });

    // M3: roadmap generation (the mock returns a canned plan and captures the request)
    const planNoKey = await post(`${base}/api/plan/generate`, { path: proj1, goal: 'Ship checkout' });
    check('plan: generating without a key is refused', () => {
      assert.strictEqual(planNoKey.status, 400);
    });
    await post(`${base}/api/settings`, { apiKey: GOOD_KEY });
    const genRes = await post(`${base}/api/plan/generate`, {
      path: proj1,
      goal: 'Ship checkout with api_key=sk-goal-secret-9999 and card vaulting',
    });
    const gen = await genRes.json();
    check('plan: generate succeeds and persists plan.json', () => {
      assert.strictEqual(genRes.status, 200, JSON.stringify(gen));
      assert.strictEqual(gen.ok, true);
      const saved = JSON.parse(read(path.join(proj1, '.membridge', 'plan.json')));
      assert.strictEqual(saved.model, 'claude-sonnet-5');
      assert.ok(Math.abs(saved.costUsd - 0.0174) < 1e-9, `costUsd was ${saved.costUsd}`);
      assert.strictEqual(saved.plan.phases.length, 2);
      assert.ok(saved.generatedAt, 'generatedAt missing');
      assert.ok(!saved.goal.includes('sk-goal-secret-9999'), 'secret kept in the stored goal');
    });
    check('plan: request to Anthropic is shaped right and fully redacted', () => {
      assert.ok(lastPlanRequest, 'mock never saw the request');
      assert.strictEqual(lastPlanRequest.model, 'claude-sonnet-5');
      assert.strictEqual(lastPlanRequest.max_tokens, 4000);
      assert.strictEqual(lastPlanRequest.output_config.format.type, 'json_schema');
      assert.strictEqual(lastPlanRequest.thinking.type, 'disabled', 'sonnet must run with thinking off');
      assert.ok(lastPlanRequest.system.includes('escalating on failure'), 'routing philosophy missing');
      const body = JSON.stringify(lastPlanRequest);
      assert.ok(!body.includes('sk-goal-secret-9999'), 'goal secret reached the API');
      assert.ok(!body.includes('sk-test1234567890abcdef'), 'transcript secret reached the API');
      assert.ok(body.includes('[redacted'), 'redaction marker missing from the payload');
      assert.ok(body.includes('shop-app'), 'project name missing');
      assert.ok(body.includes('Build the login page with OAuth'), 'recent asks missing');
    });
    check('plan: roadmap line lands in the context files right away', () => {
      const md = claudeMd();
      assert.ok(md.includes('Current roadmap:'), 'roadmap line missing');
      assert.ok(md.includes('3 tasks'), 'task count wrong');
      assert.ok(md.includes('.membridge/plan.json'), 'plan pointer missing');
      assert.ok(!md.includes('sk-goal-secret-9999'), 'secret leaked into the context file');
    });
    const detPlan = await (await fetch(`${base}/api/project?path=${encodeURIComponent(proj1)}`)).json();
    check('plan: /api/project carries the plan, key state and estimate', () => {
      assert.strictEqual(detPlan.hasKey, true);
      assert.ok(detPlan.plan && detPlan.plan.plan.phases.length === 2, 'plan missing from detail');
      assert.ok(detPlan.estimate.costUsd > 0, 'estimate missing');
      assert.strictEqual(detPlan.estimate.model, 'claude-sonnet-5');
    });
    await post(`${base}/api/settings`, { apiKey: 'sk-ant-badkey-000000' });
    const gen401 = await post(`${base}/api/plan/generate`, { path: proj1, goal: 'Anything at all' });
    check('plan: an invalid key surfaces a friendly 401', () => {
      assert.strictEqual(gen401.status, 401);
    });
    await post(`${base}/api/settings`, { apiKey: '' });
    const lowSave = await post(`${base}/api/settings`, { intervalSec: 3 });
    check('settings: interval below the 15s floor is clamped', () => {
      assert.strictEqual(lowSave.status, 200);
      const rawCfg = JSON.parse(read(util.configPath()));
      assert.strictEqual(rawCfg.intervalSec, 15, `interval persisted as ${rawCfg.intervalSec}`);
    });

    // add a fresh, never-seen directory via the dashboard API
    const freshDir = path.join(ROOT, 'projects', 'fresh-app');
    fs.mkdirSync(freshDir, { recursive: true });
    const addFirst = await (await post(`${base}/api/projects/add`, { path: freshDir })).json();
    const afterAdd = await (await fetch(`${base}/api/projects`)).json();
    const addAgain = await (await post(`${base}/api/projects/add`, { path: freshDir })).json();
    const addBad = await post(`${base}/api/projects/add`, { path: path.join(ROOT, 'no-such-dir') });
    check('add project registers an empty project', () => {
      assert.strictEqual(addFirst.added, true, `first add said: ${JSON.stringify(addFirst)}`);
      const p = afterAdd.find(x => x.path.toLowerCase() === freshDir.toLowerCase());
      assert.ok(p, 'added project missing from /api/projects');
      assert.strictEqual(p.prompts.length, 0, 'empty project reported prompts');
      assert.strictEqual(addAgain.added, false, 'second add not reported as already tracked');
      assert.strictEqual(addBad.status, 400, 'nonexistent path was accepted');
    });

    // Remove block: unlike delete, this only strips the injected block from
    // context files. History (.membridge + state) stays put, and a plain
    // sync brings the block right back.
    const removeRes = await (await post(`${base}/api/projects/remove`, { path: proj1 })).json();
    check('remove-block strips the block but keeps memory + state', () => {
      assert.strictEqual(removeRes.removed, true, `remove said: ${JSON.stringify(removeRes)}`);
      const md = claudeMd();
      assert.ok(!md.includes(digest.BEGIN), 'block not stripped from CLAUDE.md');
      assert.ok(md.startsWith('# Shop app'), 'original heading lost');
      assert.ok(!fs.existsSync(path.join(proj1, 'AGENTS.md')), 'block-only AGENTS.md not deleted');
      assert.ok(fs.existsSync(path.join(proj1, '.membridge')), '.membridge dir was removed');
      assert.ok(fs.existsSync(path.join(proj1, '.membridge', 'memory.md')), 'memory log was removed');
      const state = util.loadState();
      const key = Object.keys(state.projects).find(k => k.toLowerCase() === proj1.toLowerCase());
      assert.ok(key && state.projects[key].events.length, 'project state/history was wiped');
    });

    await post(`${base}/api/sync`, { project: proj1 });
    check('sync after remove-block re-adds the block', () => {
      const md = claudeMd();
      assert.ok(md.includes(digest.BEGIN), 'block not re-added after sync');
      assert.ok(fs.existsSync(path.join(proj1, 'AGENTS.md')), 'AGENTS.md not recreated after sync');
    });

    const delRes = await (await post(`${base}/api/projects/delete`, { path: proj1 })).json();
    const afterDel = await (await fetch(`${base}/api/projects`)).json();
    check('delete project strips blocks, memory and state', () => {
      assert.strictEqual(delRes.deleted, true, `delete said: ${JSON.stringify(delRes)}`);
      const md = claudeMd();
      assert.ok(!md.includes(digest.BEGIN), 'block not stripped from CLAUDE.md');
      assert.ok(md.startsWith('# Shop app'), 'original heading lost');
      assert.ok(!fs.existsSync(path.join(proj1, '.membridge')), '.membridge dir not removed');
      assert.ok(!afterDel.some(x => x.path.toLowerCase() === proj1.toLowerCase()), 'project still listed');
    });

    // new activity in a deleted project must bring it back (offsets were
    // already consumed, so only the appended event returns)
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ship the checkout flow' }, cwd: proj1, timestamp: '2026-07-09T12:00:00.000Z' }) + '\n',
    );
    await post(`${base}/api/sync`);
    const afterRevive = await (await fetch(`${base}/api/projects`)).json();
    check('deleted project reappears with new activity', () => {
      const p = afterRevive.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p, 'deleted project did not reappear');
      assert.ok(p.prompts.some(e => e.text.includes('Ship the checkout flow')), 'new prompt missing');
    });
  } finally {
    child.kill();
    await new Promise(r => mockApi.close(r));
  }
  await new Promise(r => setTimeout(r, 300));

  // --- 6. CLI start/stop lifecycle ---
  const env2 = { ...process.env, MEMBRIDGE_PORT: '17942' };
  const startOut = spawnSync(process.execPath, [BIN, 'start'], { env: env2, encoding: 'utf8' });
  await new Promise(r => setTimeout(r, 1500));
  const statusOut = spawnSync(process.execPath, [BIN, 'status'], { env: env2, encoding: 'utf8' });
  const stopOut = spawnSync(process.execPath, [BIN, 'stop'], { env: env2, encoding: 'utf8' });
  const statusOut2 = spawnSync(process.execPath, [BIN, 'status'], { env: env2, encoding: 'utf8' });
  check('CLI start/status/stop lifecycle', () => {
    assert.ok(/started in the background/.test(startOut.stdout), `start said: ${startOut.stdout} ${startOut.stderr}`);
    assert.ok(/running \(pid \d+\)/.test(statusOut.stdout), `status said: ${statusOut.stdout}`);
    assert.ok(/Stopped MemBridge/.test(stopOut.stdout), `stop said: ${stopOut.stdout}`);
    assert.ok(/not running/.test(statusOut2.stdout), `status said: ${statusOut2.stdout}`);
  });

  // --- 7. dashboard port retry (EADDRINUSE) ---
  // A fast stop→start can find the port still held by the dying daemon: the
  // server must retry the bind instead of leaving a daemon with no dashboard.
  {
    const PORT3 = 17943;
    const blocker = net.createServer();
    await new Promise(r => blocker.listen(PORT3, '127.0.0.1', r));
    const srv = startServer(PORT3, { retries: 40, retryDelayMs: 100 });
    await new Promise(r => setTimeout(r, 350)); // let a few binds fail first
    const logAfterRetries = read(util.logPath());
    await new Promise(r => blocker.close(r));
    const retryRes = await waitForHttp(`http://127.0.0.1:${PORT3}/api/status`);
    check('dashboard retries EADDRINUSE and binds once the port frees', () => {
      assert.ok(logAfterRetries.includes(`port ${PORT3} in use, retrying`), 'no retry log line');
      assert.ok(!logAfterRetries.includes(`dashboard on http://127.0.0.1:${PORT3}`), 'bound while port was blocked');
      assert.ok(retryRes.ok, 'dashboard never came up after the port freed');
      assert.ok(read(util.logPath()).includes(`dashboard on http://127.0.0.1:${PORT3}`), 'no bind log line');
    });
    await new Promise(r => srv.close(r));
  }

  // --- 8. team sync (mock Supabase: GoTrue + PostgREST + membership checks) ---
  const mock = createMockSupabase();
  await new Promise(r => mock.server.listen(17945, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17945';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  const HOME_A = process.env.MEMBRIDGE_HOME; // homeDir() reads env per call
  const sameKey = (a, b) => a.toLowerCase() === path.resolve(b).toLowerCase();

  check('team: backend resolves env > config > baked default', () => {
    // env override in force now
    assert.ok(teamsync.backend(util.getConfig()), 'env override not honored');
    // with env cleared, this official build falls back to its baked backend,
    // and a config override still takes precedence.
    const savedUrl = process.env.MEMBRIDGE_TEAM_URL;
    const savedKey = process.env.MEMBRIDGE_TEAM_ANON_KEY;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    try {
      assert.ok(teamsync.backend({}), 'baked backend missing');
      assert.ok(teamsync.backend({ team: { url: 'https://x.supabase.co', anonKey: 'k' } }),
        'config override not honored');
    } finally {
      process.env.MEMBRIDGE_TEAM_URL = savedUrl;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey;
    }
  });

  try {
    // Marco: signup, team, link the shop-app project, first push.
    const credsA = await teamsync.signup(util.getConfig(), 'marco@test.dev', 'pw-a', 'Marco');
    check('team: signup stores credentials outside any project, chmod 600', () => {
      assert.strictEqual(credsA.email, 'marco@test.dev');
      assert.ok(teamsync.credentialsPath().startsWith(HOME_A), 'credentials not in MemBridge home');
      const stored = JSON.parse(read(teamsync.credentialsPath()));
      assert.strictEqual(stored.displayName, 'Marco');
      assert.ok(stored.refreshToken, 'refresh token missing');
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(teamsync.credentialsPath()).mode & 0o777, 0o600);
      }
    });

    const team = await teamsync.createTeam(util.getConfig(), 'Acme');
    const linkA = await teamsync.linkProject(util.getConfig(), proj1, team.team_id, 'Acme');
    check('team: create + link write .membridge/team.json with the project id', () => {
      assert.ok(team.team_id && team.invite_code, 'team ids missing');
      const l = JSON.parse(read(path.join(proj1, '.membridge', 'team.json')));
      assert.strictEqual(l.projectId, linkA.projectId);
      assert.strictEqual(l.teamId, team.team_id);
    });
    const dashboardTeam = await teamPayload();
    check('dashboard: team payload exposes identity, teams and linked projects without tokens', () => {
      assert.strictEqual(dashboardTeam.authenticated, true);
      assert.strictEqual(dashboardTeam.user.email, 'marco@test.dev');
      assert.ok(dashboardTeam.teams.some(t => t.team_id === team.team_id), 'team missing');
      assert.ok(dashboardTeam.linkedProjects.some(p => sameKey(p.path, proj1)), 'linked project missing');
      assert.ok(!JSON.stringify(dashboardTeam).includes(credsA.accessToken), 'access token exposed');
      assert.ok(!JSON.stringify(dashboardTeam).includes(credsA.refreshToken), 'refresh token exposed');
    });
    const PORT4 = 17946;
    const srv4 = startServer(PORT4, { retries: 0 });
    try {
      const base4 = `http://127.0.0.1:${PORT4}`;
      await waitForHttp(`${base4}/api/status`);
      const apiInv = await (await fetch(`${base4}/api/team/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: team.team_id }),
      })).json();
      const optInv = await (await fetch(`${base4}/api/team/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: team.team_id, expiresDays: '7', maxUses: '3' }),
      })).json();
      const revokeRes = await fetch(`${base4}/api/team/revoke-invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: `https://app.membridge.dev/join/${apiInv.token}` }),
      });
      const revokeJson = await revokeRes.json();
      const optRow = mock.invites.get(optInv.token);
      check('dashboard: /api/team/revoke-invite revokes pasted invite links', () => {
        assert.strictEqual(revokeRes.status, 200);
        assert.strictEqual(revokeJson.revoked, true);
        assert.ok(mock.invites.get(apiInv.token).revokedAt, 'invite was not revoked');
      });
      check('dashboard: /api/team/invite passes expiry and max-use options', () => {
        assert.ok(optRow.expiresAt, 'expiry was not passed');
        assert.strictEqual(optRow.maxUses, 3);
        assert.strictEqual(optInv.max_uses, 3);
      });
    } finally {
      srv4.close();
    }

    // proj1 was deleted+revived earlier, so its live history is the single
    // "Ship the checkout flow" ask — enough to prove the push path end to end.
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add the order confirmation email' }, cwd: proj1, timestamp: '2026-07-12T08:00:00.000Z' }) + '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Wire the receipt PDF, api_key=sk-test1234567890abcdef' }, cwd: proj1, timestamp: '2026-07-12T08:01:00.000Z' }) + '\n',
    );
    syncOnce(); // fold the new asks into proj1's history before the first push
    const rA = await teamsync.syncTeams();
    check('team: push uploads only redacted digest entries', () => {
      assert.ok(rA.synced.some(k => sameKey(k, proj1)), `synced said: ${JSON.stringify(rA)}`);
      assert.ok(mock.entries.length >= 3, `expected >=3 pushed entries, got ${mock.entries.length}`);
      const body = JSON.stringify(mock.entries);
      assert.ok(!body.includes('sk-test1234567890abcdef'), 'secret reached the server');
      assert.ok(body.includes('[redacted'), 'redaction marker missing server-side');
      assert.ok(mock.entries.every(e => e.author_name === 'Marco'), 'author attribution wrong');
    });

    const pushedCount = mock.entries.length;
    await teamsync.syncTeams();
    check('team: re-sync is idempotent (cursor + server dedupe)', () => {
      assert.strictEqual(mock.entries.length, pushedCount, 'duplicate entries pushed');
    });

    // A hosted backend whose schema predates the summary column must not kill
    // the push — the client drops the field and retries.
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Tighten the refund policy checks' }, cwd: proj1, timestamp: '2026-07-12T08:30:00.000Z' }) + '\n',
    );
    syncOnce();
    mock.flags.rejectSummary = true;
    const rLegacy = await teamsync.syncTeams();
    mock.flags.rejectSummary = false;
    check('team: push falls back to summary-less rows on a pre-summary backend', () => {
      assert.strictEqual((rLegacy.errors || []).length, 0, `push errored: ${JSON.stringify(rLegacy.errors)}`);
      assert.ok(rLegacy.synced.some(k => sameKey(k, proj1)), `synced said: ${JSON.stringify(rLegacy)}`);
      const row = mock.entries.find(e => (e.ask || '').includes('Tighten the refund policy checks'));
      assert.ok(row, 'new entry never reached the server');
      assert.ok(!('summary' in row), 'summary field still sent to a backend without the column');
    });

    // Andrew: second machine (own MemBridge home), same repo basename, joins
    // by invite code — link_project maps his clone to the same project row.
    const projB = path.join(ROOT, 'projects-b', 'shop-app');
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projB, 'CLAUDE.md'), '# B clone\n\nAndrew notes.\n');
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-b');
    util.ensureConfig();
    const stateB = util.loadState();
    stateB.projects = {
      [projB]: {
        events: [{ ts: '2026-07-12T09:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'Refactor checkout validation', session: 'b1' }],
      },
    };
    util.saveState(stateB);
    await teamsync.signup(util.getConfig(), 'andrew@test.dev', 'pw-b', 'Andrew');
    const joined = await teamsync.joinTeam(util.getConfig(), team.invite_code);
    const linkB = await teamsync.linkProject(util.getConfig(), projB, joined.team_id, joined.team_name);
    check('team: invite-code join maps the clone to the same project row', () => {
      assert.strictEqual(joined.team_id, team.team_id);
      assert.strictEqual(joined.team_name, 'Acme');
      assert.strictEqual(linkB.projectId, linkA.projectId, 'clone got a different project row');
    });

    const rB = await teamsync.syncTeams();
    for (const k of rB.changed) syncOnce({ project: k });
    check("team: Andrew pulls Marco's asks into his context block", () => {
      assert.ok(rB.changed.some(k => sameKey(k, projB)), `changed said: ${JSON.stringify(rB)}`);
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(md.startsWith('# B clone'), 'his own notes were lost');
      assert.ok(md.includes("Teammates' AI activity"), 'team section missing');
      assert.ok(md.includes('Marco'), 'author name missing');
      assert.ok(md.includes('Ship the checkout flow'), "Marco's ask missing");
      assert.ok(!md.includes('sk-test1234567890abcdef'), 'secret leaked into teammate file');
    });

    // Back to Marco: his next pass pulls Andrew's Codex ask.
    process.env.MEMBRIDGE_HOME = HOME_A;
    const rA2 = await teamsync.syncTeams();
    for (const k of rA2.changed) syncOnce({ project: k });
    check("team: Marco pulls Andrew's ask back, with attribution", () => {
      assert.ok(rA2.changed.some(k => sameKey(k, proj1)), `changed said: ${JSON.stringify(rA2)}`);
      const md = claudeMd();
      assert.ok(md.includes("Teammates' AI activity"), 'team section missing');
      assert.ok(md.includes('Andrew · Codex: Refactor checkout validation'), "Andrew's ask missing");
    });

    // ----- team v2 (002_team_v2.sql): invite links, roles, feed, auto-link -----
    const MOCK_URL = 'http://127.0.0.1:17945';
    // Direct RPC helper for endpoints teamsync has no wrapper for (web-only).
    const rpcAs = async (home, fn, args) => {
      const saved = process.env.MEMBRIDGE_HOME;
      process.env.MEMBRIDGE_HOME = home;
      const creds = await teamsync.getAccessToken(util.getConfig());
      process.env.MEMBRIDGE_HOME = saved;
      const res = await fetch(`${MOCK_URL}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: 'anon-test', Authorization: `Bearer ${creds.accessToken}` },
        body: JSON.stringify(args),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error((data && data.message) || `rpc ${fn}: ${res.status}`);
      return data;
    };
    const gitRepo = (dir, remote) => {
      fs.mkdirSync(dir, { recursive: true });
      spawnSync('git', ['init', '-q'], { cwd: dir });
      spawnSync('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
    };
    const HOME_B = path.join(ROOT, 'home-b');

    // Marco (owner) mints an invite link.
    const inv1 = await teamsync.createInvite(util.getConfig(), team.team_id, {});
    check('invites: owner mints a short URL-safe token; URL parsing round-trips', () => {
      assert.ok(/^[A-Za-z0-9_-]{8,}$/.test(inv1.token), `token was ${inv1.token}`);
      assert.strictEqual(inv1.url, null, 'no web app configured, url must be null');
      assert.strictEqual(teamsync.parseInviteToken(`https://app.membridge.dev/join/${inv1.token}`), inv1.token);
      assert.strictEqual(teamsync.parseInviteToken(`  ${inv1.token}  `), inv1.token);
      process.env.MEMBRIDGE_TEAM_WEB_URL = 'https://app.membridge.dev/';
      assert.strictEqual(teamsync.inviteUrl(util.getConfig(), inv1.token), `https://app.membridge.dev/join/${inv1.token}`);
      delete process.env.MEMBRIDGE_TEAM_WEB_URL;
    });

    // A plain member cannot mint one.
    process.env.MEMBRIDGE_HOME = HOME_B;
    let memberInviteErr = null;
    try {
      await teamsync.createInvite(util.getConfig(), team.team_id, {});
    } catch (err) {
      memberInviteErr = err;
    }
    check('invites: a plain member cannot create invite links', () => {
      assert.ok(memberInviteErr && /owner or admin/i.test(memberInviteErr.message), `said: ${memberInviteErr && memberInviteErr.message}`);
    });

    // Dana joins by pasting the full /join URL.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'dana@test.dev', 'pw-d', 'Dana');
    const danaJoin = await teamsync.join(util.getConfig(), `https://app.membridge.dev/join/${inv1.token}`);
    check('invites: redeem via pasted /join URL grants member role only', () => {
      assert.strictEqual(danaJoin.team_name, 'Acme');
      const m = mock.members.find(x => x.displayName === 'Dana');
      assert.ok(m, 'Dana not a member');
      assert.strictEqual(m.role, 'member');
      assert.strictEqual(mock.invites.get(inv1.token).useCount, 1, 'use_count not incremented');
    });

    // Revocation, expiry and max-uses.
    process.env.MEMBRIDGE_HOME = HOME_A;
    const inv2 = await teamsync.createInvite(util.getConfig(), team.team_id, { maxUses: 1 });
    const invExpired = await teamsync.createInvite(util.getConfig(), team.team_id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    await teamsync.revokeInvite(util.getConfig(), inv1.token);
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-e');
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'erin@test.dev', 'pw-e', 'Erin');
    let revokedErr = null;
    try {
      await teamsync.join(util.getConfig(), inv1.token);
    } catch (err) {
      revokedErr = err;
    }
    await teamsync.join(util.getConfig(), inv2.token); // burns the single use
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-f');
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'frank@test.dev', 'pw-f', 'Frank');
    let usedErr = null;
    let expiredErr = null;
    try {
      await teamsync.join(util.getConfig(), inv2.token);
    } catch (err) {
      usedErr = err;
    }
    try {
      await teamsync.join(util.getConfig(), invExpired.token);
    } catch (err) {
      expiredErr = err;
    }
    check('invites: revoked, exhausted and expired links are all refused', () => {
      assert.ok(revokedErr && /revoked/i.test(revokedErr.message), `revoked said: ${revokedErr && revokedErr.message}`);
      assert.ok(usedErr && /already been used/i.test(usedErr.message), `used said: ${usedErr && usedErr.message}`);
      assert.ok(expiredErr && /expired/i.test(expiredErr.message), `expired said: ${expiredErr && expiredErr.message}`);
    });

    // Roles: owner promotes Andrew to admin; as admin he can mint invites.
    const andrewId = mock.members.find(m => m.displayName === 'Andrew').userId;
    await rpcAs(HOME_A, 'set_role', { p_team: team.team_id, p_user: andrewId, p_role: 'admin' });
    process.env.MEMBRIDGE_HOME = HOME_B;
    const adminInv = await teamsync.createInvite(util.getConfig(), team.team_id, {});
    let demoteErr = null;
    try {
      await rpcAs(HOME_B, 'set_role', { p_team: team.team_id, p_user: andrewId, p_role: 'member' });
    } catch (err) {
      demoteErr = err;
    }
    check('roles: owner promotes to admin; admin manages invites but not roles', () => {
      assert.strictEqual(mock.members.find(m => m.userId === andrewId).role, 'admin');
      assert.ok(adminInv.token, 'admin could not mint an invite');
      assert.ok(demoteErr && /only the team owner/i.test(demoteErr.message), `said: ${demoteErr && demoteErr.message}`);
    });

    // Feed read model: one call, filters, keyset pagination.
    const feedAll = await rpcAs(HOME_A, 'team_feed', { p_team: team.team_id, p_limit: 50 });
    const feedCodex = await rpcAs(HOME_A, 'team_feed', { p_team: team.team_id, p_source: 'Codex' });
    const feedPage1 = await rpcAs(HOME_A, 'team_feed', { p_team: team.team_id, p_limit: 1 });
    const feedPage2 = await rpcAs(HOME_A, 'team_feed', {
      p_team: team.team_id, p_limit: 1,
      p_before_created_at: feedPage1[0].created_at, p_before_id: feedPage1[0].id,
    });
    check('feed: team_feed joins project names, filters by tool, paginates by keyset', () => {
      assert.ok(feedAll.length >= 3, `expected >=3 rows, got ${feedAll.length}`);
      assert.ok(feedAll.every(r => r.project_name === 'shop-app'), 'project_name missing');
      const authors = new Set(feedAll.map(r => r.author_name));
      assert.ok(authors.has('Marco') && authors.has('Andrew'), `authors were ${[...authors]}`);
      assert.ok(feedCodex.length >= 1 && feedCodex.every(r => r.source === 'Codex'), 'tool filter failed');
      assert.strictEqual(feedPage1.length, 1);
      assert.strictEqual(feedPage2.length, 1);
      assert.notStrictEqual(feedPage1[0].id, feedPage2[0].id, 'keyset returned the same row');
    });

    // ----- team hub: read wrappers, dashboard routes, management -----
    process.env.MEMBRIDGE_HOME = HOME_A;
    const hubMembers = await teamsync.listMembers(util.getConfig(), team.team_id);
    check('hub: listMembers returns every member with role and joined_at', () => {
      const names = hubMembers.map(m => m.display_name);
      assert.ok(names.includes('Marco') && names.includes('Andrew') && names.includes('Dana'), `members were ${names}`);
      assert.strictEqual(hubMembers.find(m => m.display_name === 'Marco').role, 'owner');
      assert.ok(hubMembers.every(m => m.user_id && m.joined_at), 'user_id/joined_at missing');
    });

    const hubFeedAndrew = await teamsync.teamFeed(util.getConfig(), team.team_id, { author: andrewId, limit: 10 });
    check('hub: teamFeed wrapper filters by author', () => {
      assert.ok(hubFeedAndrew.length >= 1, 'no rows for Andrew');
      assert.ok(hubFeedAndrew.every(r => r.author_id === andrewId), 'author filter leaked other rows');
    });

    const hubStats = await teamsync.projectStats(util.getConfig(), team.team_id);
    check('hub: projectStats aggregates contributors, entries and last activity', () => {
      const shop = hubStats.find(r => r.name === 'shop-app');
      assert.ok(shop, 'shop-app missing from stats');
      assert.ok(shop.contributors >= 2, `contributors was ${shop.contributors}`);
      assert.ok(shop.entries >= 3, `entries was ${shop.entries}`);
      assert.ok(shop.last_activity, 'last_activity missing');
    });

    const hubProjects = await teamProjectsPayload(team.team_id);
    check('hub: team projects payload maps team projects to linked local folders', () => {
      const shop = hubProjects.find(r => r.name === 'shop-app');
      assert.ok(shop && shop.localPath && sameKey(shop.localPath, proj1), `localPath was ${shop && shop.localPath}`);
    });

    // The same reads over the local dashboard API (in-process server; the mock
    // backend is async in this process too, so no event-loop deadlock).
    const HUB_PORT = 17947;
    const hubSrv = startServer(HUB_PORT, { retries: 0 });
    await waitForHttp(`http://127.0.0.1:${HUB_PORT}/api/status`);
    const hubBase = `http://127.0.0.1:${HUB_PORT}`;
    const membersRes = await (await fetch(`${hubBase}/api/team/members?teamId=${team.team_id}`)).json();
    const feedRes = await (await fetch(`${hubBase}/api/team/feed?teamId=${team.team_id}&source=Codex`)).json();
    const projectsRes = await (await fetch(`${hubBase}/api/team/projects?teamId=${team.team_id}`)).json();
    const badRes = await fetch(`${hubBase}/api/team/feed`);
    check('hub routes: members, feed and projects serve team data over the local API', () => {
      assert.ok(membersRes.members.some(m => m.display_name === 'Andrew'), 'members route empty');
      assert.ok(feedRes.entries.length >= 1 && feedRes.entries.every(e => e.source === 'Codex'), 'feed route filter failed');
      assert.ok(projectsRes.projects.some(p => p.name === 'shop-app'), 'projects route empty');
      assert.strictEqual(badRes.status, 400, 'missing teamId must 400');
    });
    await new Promise(r => hubSrv.close(r));

    // Management runs on a fresh team so rotate/remove cannot disturb the
    // Acme fixtures that later tests (CLI join, Mallory) still rely on.
    const opsTeam = await teamsync.createTeam(util.getConfig(), 'Hub Ops');
    const opsInv = await teamsync.createInvite(util.getConfig(), opsTeam.team_id, {});
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-f');
    await teamsync.join(util.getConfig(), opsInv.token);
    const frankId = mock.members.find(m => m.displayName === 'Frank').userId;
    process.env.MEMBRIDGE_HOME = HOME_A;
    await teamsync.setRole(util.getConfig(), opsTeam.team_id, frankId, 'admin');
    await teamsync.renameTeam(util.getConfig(), opsTeam.team_id, 'Hub Operations');
    const rotated = await teamsync.rotateInvite(util.getConfig(), opsTeam.team_id);
    check('hub: owner manages roles, team name and the legacy code via wrappers', () => {
      assert.strictEqual(mock.members.find(m => m.userId === frankId && m.teamId === opsTeam.team_id).role, 'admin');
      assert.strictEqual(mock.teams.get(opsTeam.team_id).name, 'Hub Operations');
      assert.notStrictEqual(rotated, opsTeam.invite_code, 'invite code did not rotate');
      assert.ok(mock.invites.get(opsInv.token).revokedAt, 'rotate must revoke outstanding invite links');
    });

    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-f');
    await teamsync.leaveTeam(util.getConfig(), opsTeam.team_id);
    process.env.MEMBRIDGE_HOME = HOME_A;
    let ownerLeaveErr = null;
    try {
      await teamsync.leaveTeam(util.getConfig(), opsTeam.team_id);
    } catch (err) {
      ownerLeaveErr = err;
    }
    check('hub: members can leave; the owner cannot abandon their own team', () => {
      assert.ok(!mock.members.some(m => m.teamId === opsTeam.team_id && m.userId === frankId), 'Frank still a member');
      assert.ok(ownerLeaveErr && /owner cannot leave/i.test(ownerLeaveErr.message), `said: ${ownerLeaveErr && ownerLeaveErr.message}`);
    });

    const opsInv2 = await teamsync.createInvite(util.getConfig(), opsTeam.team_id, {});
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-f');
    await teamsync.join(util.getConfig(), opsInv2.token);
    process.env.MEMBRIDGE_HOME = HOME_A;
    await teamsync.removeMember(util.getConfig(), opsTeam.team_id, frankId);
    check('hub: the owner can remove a member', () => {
      assert.ok(!mock.members.some(m => m.teamId === opsTeam.team_id && m.userId === frankId), 'Frank not removed');
    });

    // Auto-link: Marco links a git-remoted project; credentials in the remote
    // URL must never reach the server.
    process.env.MEMBRIDGE_HOME = HOME_A;
    const projApi = path.join(ROOT, 'projects', 'api-server');
    gitRepo(projApi, 'https://marco:tok123@github.com/acme/api-server.git');
    const apiLink = await teamsync.linkProject(util.getConfig(), projApi, team.team_id, 'Acme');
    check('privacy: git remote credentials are stripped before anything is uploaded', () => {
      assert.strictEqual(teamsync.repoUrl(projApi), 'github.com/acme/api-server');
      const row = mock.projects.find(p => p.id === apiLink.projectId);
      assert.strictEqual(row.repoUrl, 'github.com/acme/api-server');
      assert.ok(!JSON.stringify(mock.projects).includes('tok123'), 'credential reached the server');
    });

    // Dana's clone (ssh remote, same repo): suggested, NOT auto-linked.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    const danaApi = path.join(ROOT, 'projects-d', 'api-server');
    gitRepo(danaApi, 'git@github.com:acme/api-server.git');
    const stateD = util.loadState();
    stateD.projects = { [danaApi]: { events: [{ ts: '2026-07-12T11:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'Add rate limiting', session: 'd1' }] } };
    util.saveState(stateD);
    const rD = await teamsync.syncTeams();
    check('auto-link: a matching remote is suggested, never silently shared', () => {
      assert.ok(rD.suggested.some(k => sameKey(k, danaApi)), `suggested said: ${JSON.stringify(rD.suggested)}`);
      const s = util.loadState().projects[danaApi].teamSuggestion;
      assert.ok(s && s.teamName === 'Acme' && s.repoUrl === 'github.com/acme/api-server', `suggestion was ${JSON.stringify(s)}`);
      assert.ok(!teamsync.loadTeamLink(danaApi), 'project was linked without consent');
      assert.ok(!mock.entries.some(e => e.ask.includes('rate limiting')), 'entries pushed without consent');
    });
    const danaLink = await teamsync.resolveSuggestion(util.getConfig(), danaApi, true);
    await teamsync.syncTeams();
    check('auto-link: accepting the suggestion links the clone to the same project row', () => {
      assert.strictEqual(danaLink.projectId, apiLink.projectId, 'clone got a different project row');
      assert.ok(!util.loadState().projects[danaApi].teamSuggestion, 'suggestion not cleared');
      assert.ok(mock.entries.some(e => e.ask.includes('rate limiting')), 'entries not pushed after accept');
    });

    // Erin opts into full auto-link: her clone links without a prompt.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-e');
    const erinCfg = util.loadUserConfig();
    erinCfg.team = { ...(erinCfg.team || {}), autoLink: true };
    util.saveUserConfig(erinCfg);
    const erinApi = path.join(ROOT, 'projects-e', 'api-server');
    gitRepo(erinApi, 'https://github.com/acme/api-server.git');
    const stateE = util.loadState();
    stateE.projects = { [erinApi]: { events: [] } };
    util.saveState(stateE);
    await teamsync.syncTeams();
    check('auto-link: config team.autoLink=true links matching clones automatically', () => {
      const link = teamsync.loadTeamLink(erinApi);
      assert.ok(link, 'not auto-linked');
      assert.strictEqual(link.projectId, apiLink.projectId);
    });

    // Privacy: entries never carry a foreign path — not even its basename.
    check('privacy: files outside the project are dropped from entries', () => {
      const ents = memorydb.buildEntries(proj1, {
        events: [
          { ts: '2026-07-12T12:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'tweak global config', session: 'x1' },
          { ts: '2026-07-12T12:00:01.000Z', source: 'Claude Code', kind: 'edit', file: '/Users/alice/secret-place/config.js', session: 'x1' },
        ],
      }, util.getConfig());
      assert.deepStrictEqual(ents[ents.length - 1].files, []);
      assert.ok(!JSON.stringify(ents).includes('config.js'), 'foreign basename leaked into entries');
    });

    // CLI: `membridge join <token>` signs the account up when it is new.
    // Async spawn, NOT spawnSync: the mock backend lives in this process, and
    // spawnSync would block the event loop the mock answers from (deadlock).
    const HOME_CLI2 = path.join(ROOT, 'home-cli2');
    const joinOut = await new Promise(resolve => {
      const child = spawn(process.execPath,
        [BIN, 'join', adminInv.token, '--email', 'cli@test.dev', '--password', 'pw-cli', '--name', 'CLI'],
        { env: { ...process.env, MEMBRIDGE_HOME: HOME_CLI2 } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('close', () => resolve({ stdout, stderr }));
    });
    check('CLI: membridge join signs up and joins in one command', () => {
      assert.ok(/Joined team "Acme"/.test(joinOut.stdout), `join said: ${joinOut.stdout} ${joinOut.stderr}`);
      assert.ok(mock.members.some(m => m.displayName === 'CLI' && m.role === 'member'), 'CLI user not a member');
    });
    process.env.MEMBRIDGE_HOME = HOME_A;

    // Stale token: the next call must transparently use the refresh grant.
    const stale = teamsync.loadCredentials();
    stale.expiresAt = Date.now() - 1000;
    fs.writeFileSync(teamsync.credentialsPath(), JSON.stringify(stale));
    const refreshesBefore = mock.stats.refreshCalls;
    await teamsync.getAccessToken(util.getConfig());
    check('team: stale access token refreshes transparently', () => {
      assert.strictEqual(mock.stats.refreshCalls, refreshesBefore + 1, 'refresh grant not used');
    });

    // Mallory: signed up but never joined the team; a hand-crafted team.json
    // must not let her push into (or read) the team's project.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-c');
    util.ensureConfig();
    const projC = path.join(ROOT, 'projects-c', 'shop-app');
    fs.mkdirSync(path.join(projC, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(projC, '.membridge', 'team.json'),
      JSON.stringify({ projectId: linkA.projectId, teamId: team.team_id }));
    const stateC = util.loadState();
    stateC.projects = {
      [projC]: {
        events: [{ ts: '2026-07-12T10:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'sneaky non-member write', session: 'c1' }],
      },
    };
    util.saveState(stateC);
    await teamsync.signup(util.getConfig(), 'mallory@test.dev', 'pw-c', 'Mallory');
    const rC = await teamsync.syncTeams();
    check('team: a non-member cannot push into or pull from the project', () => {
      assert.strictEqual(rC.changed.length, 0, 'non-member pulled entries');
      assert.strictEqual(rC.errors.length, 1, `errors said: ${JSON.stringify(rC.errors)}`);
      assert.ok(/security|member/i.test(rC.errors[0]), `error said: ${rC.errors[0]}`);
      assert.ok(!JSON.stringify(mock.entries).includes('sneaky'), 'non-member row was stored');
      assert.ok(mock.stats.deniedInserts >= 1, 'mock never denied the insert');
    });

    // CLI: `team setup` persists the backend; `logout` clears credentials.
    const HOME_CLI = path.join(ROOT, 'home-cli');
    const envT = { ...process.env, MEMBRIDGE_HOME: HOME_CLI };
    const setupOut = spawnSync(process.execPath,
      [BIN, 'team', 'setup', '--url', 'http://127.0.0.1:17945', '--anon-key', 'anon-test'],
      { env: envT, encoding: 'utf8' });
    process.env.MEMBRIDGE_HOME = HOME_A;
    const logoutOut = spawnSync(process.execPath, [BIN, 'logout'], { env: { ...process.env }, encoding: 'utf8' });
    check('CLI: team setup persists the backend, logout clears credentials', () => {
      assert.ok(/team backend saved/i.test(setupOut.stdout), `setup said: ${setupOut.stdout} ${setupOut.stderr}`);
      const cfg = JSON.parse(read(path.join(HOME_CLI, 'config.json')));
      assert.strictEqual(cfg.team.url, 'http://127.0.0.1:17945');
      assert.ok(/Logged out/.test(logoutOut.stdout), `logout said: ${logoutOut.stdout}`);
      assert.ok(!fs.existsSync(teamsync.credentialsPath()), 'credentials survive logout');
    });
  } finally {
    process.env.MEMBRIDGE_HOME = HOME_A;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock.server.close(r));
  }

  // --- 9. rich signals: todos + agent summaries ---
  const projR = path.join(ROOT, 'projects', 'rich-app');
  fs.mkdirSync(projR, { recursive: true });
  const rDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-rich-app');
  fs.mkdirSync(rDir, { recursive: true });
  const OLD_SUMMARY = 'Refactored the payment retry queue: exponential backoff with jitter is in, the dead-letter queue is wired, and idempotency is covered by tests. Rotated api_key=sk-test1234567890abcdef.';
  const NEW_SUMMARY = 'All retry-queue work is finished: backoff, dead-letter wiring and the idempotency suite all pass in CI.';
  fs.writeFileSync(path.join(rDir, 'sessR.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Refactor the payment retry queue with backoff' }, cwd: projR, timestamp: '2026-07-12T09:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
      { content: 'Add exponential backoff', status: 'completed', activeForm: 'Adding backoff' },
      { content: 'Wire the dead-letter queue token=secret-todo-999', status: 'in_progress', activeForm: 'Wiring DLQ' },
      { content: 'Cover idempotency with tests', status: 'pending', activeForm: 'Covering idempotency' },
    ] } }] }, cwd: projR, timestamp: '2026-07-12T09:01:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projR, 'src', 'queue.js') } }] }, cwd: projR, timestamp: '2026-07-12T09:02:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: OLD_SUMMARY }] }, cwd: projR, timestamp: '2026-07-12T09:03:00.000Z' },
  ]));
  // A second session whose final text is under the 80-char summary bar.
  fs.writeFileSync(path.join(rDir, 'sessShort.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Quick tweak to the readme' }, cwd: projR, timestamp: '2026-07-12T09:10:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] }, cwd: projR, timestamp: '2026-07-12T09:11:00.000Z' },
  ]));
  // Grant consent so the summaries instruction appears in AGENTS.md
  { const rc = util.loadUserConfig(); if (!rc.distill) rc.distill = {}; rc.distill.consent = 'granted'; util.saveUserConfig(rc); }
  syncOnce();
  const richMd = () => read(path.join(projR, 'CLAUDE.md'));
  const richEvents = () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === projR.toLowerCase());
    return state.projects[key].events;
  };

  check('rich: adapter extracts todos and summary events from the transcript', () => {
    const evs = richEvents();
    const todos = evs.find(e => e.kind === 'todos' && e.session === 'sessR');
    assert.ok(todos, 'todos event missing');
    assert.strictEqual(todos.items.length, 3);
    assert.deepStrictEqual(todos.items[0], { text: 'Add exponential backoff', status: 'completed' });
    const summary = evs.find(e => e.kind === 'summary' && e.session === 'sessR');
    assert.ok(summary, 'summary event missing');
    assert.strictEqual(summary.text, OLD_SUMMARY);
    assert.strictEqual(summary.ts, '2026-07-12T09:03:00.000Z');
  });
  check('rich: a final text under 80 chars is not emitted as a summary', () => {
    assert.ok(!richEvents().some(e => e.kind === 'summary' && e.session === 'sessShort'), 'short text became a summary');
  });
  check('rich: renderBlock groups by session with Ask/Result/Tasks/Files', () => {
    const md = richMd();
    assert.ok(md.includes('Ask: Refactor the payment retry queue with backoff'), 'Ask line missing');
    assert.ok(md.includes('Result: Refactored the payment retry queue'), 'Result line missing');
    assert.ok(md.includes('Tasks: 1/3 done'), 'Tasks line missing');
    assert.ok(md.includes('Files: src/queue.js'), 'Files line missing');
    // the summary-less session keeps the original one-line ask format
    assert.ok(md.includes('Claude Code: Quick tweak to the readme'), 'fallback one-liner missing');
  });
  check('rich: summaries and todo items are redacted everywhere they land', () => {
    assert.ok(!richMd().includes('sk-test1234567890abcdef'), 'summary secret leaked into the block');
    assert.ok(richMd().includes('[redacted'), 'no redaction marker in the block');
    const db = JSON.parse(read(path.join(projR, '.membridge', 'memory.json')));
    const entry = db.entries.find(e => e.summary);
    assert.ok(entry, 'no entry carries a summary');
    assert.ok(entry.summary.includes('[redacted') && !entry.summary.includes('sk-test1234567890abcdef'), 'entry summary not redacted');
    assert.deepStrictEqual({ done: entry.tasks.done, total: entry.tasks.total }, { done: 1, total: 3 });
    const raw = read(path.join(projR, '.membridge', 'memory.json')) + read(path.join(projR, '.membridge', 'memory.md'));
    assert.ok(!raw.includes('secret-todo-999'), 'todo item secret leaked into the memory DB');
    assert.ok(read(path.join(projR, '.membridge', 'memory.md')).includes('Result: '), 'memory.md has no Result line');
  });
  check('rich: copy-for-AI digest shows the Result line', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === projR.toLowerCase());
    const text = memorydb.renderCopyText(projR, state.projects[key], util.getConfig());
    assert.ok(text.includes('Result: '), 'Result line missing from copy digest');
    assert.ok(!text.includes('sk-test1234567890abcdef'), 'secret leaked into copy digest');
  });

  // Incremental: the session keeps going, a fresh final text lands. The new
  // summary event supersedes the old one in rendering (latest per session).
  fs.appendFileSync(path.join(rDir, 'sessR.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ship it once CI is green' }, cwd: projR, timestamp: '2026-07-12T09:20:00.000Z' }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: NEW_SUMMARY }] }, cwd: projR, timestamp: '2026-07-12T09:21:00.000Z' }) + '\n');
  syncOnce();
  check('rich: incremental reads produce a superseding summary in rendering', () => {
    const summaries = richEvents().filter(e => e.kind === 'summary' && e.session === 'sessR');
    assert.strictEqual(summaries.length, 2, `expected 2 summary events, got ${summaries.length}`);
    const md = richMd();
    assert.ok(md.includes('all pass in CI'), 'updated summary missing');
    assert.ok(!md.includes('exponential backoff with jitter'), 'stale summary still rendered');
  });

  // Adapter units: item cap, and both Codex agent_message payload shapes.
  check('rich: todos items are capped at 20 per event', () => {
    const todos = Array.from({ length: 25 }, (_, i) => ({ content: `task ${i}`, status: 'pending' }));
    const evs = claudeAdapter.extractEvents([
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] }, cwd: projR, timestamp: '2026-07-12T10:00:00.000Z' },
    ], {});
    const ev = evs.find(e => e.kind === 'todos');
    assert.strictEqual(ev.items.length, 20, `stored ${ev.items.length} items`);
  });
  check('rich: codex summaries parse both string and content-array payloads', () => {
    const long = 'The Codex agent finished the task: it rewrote the retry logic and added regression tests for the queue.';
    const meta = { timestamp: '2026-07-12T10:00:00.000Z', type: 'session_meta', payload: { id: 'x', cwd: projR } };
    const asString = codexAdapter.extractEvents([
      meta,
      { timestamp: '2026-07-12T10:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: long } },
    ], {});
    const asArray = codexAdapter.extractEvents([
      meta,
      { timestamp: '2026-07-12T10:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', content: [{ type: 'output_text', text: long }] } },
    ], {});
    for (const evs of [asString, asArray]) {
      const s = evs.find(e => e.kind === 'summary');
      assert.ok(s, 'codex summary missing');
      assert.strictEqual(s.text, long);
      assert.strictEqual(s.project, projR);
    }
    const short = codexAdapter.extractEvents([
      meta,
      { timestamp: '2026-07-12T10:01:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Done.' } },
    ], {});
    assert.ok(!short.some(e => e.kind === 'summary'), 'short codex text became a summary');
  });

  // Rendering fixes: out-of-project files, markdown summaries, missing asks.
  const MD_SUMMARY = '## Build patch\n\n**Rewrote** the scratch build runner and `verified` it twice | all targets\n```bash\nmake test\n```\nGreen across the board.';
  fs.writeFileSync(path.join(rDir, 'sessOut.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Patch the temp build script' }, cwd: projR, timestamp: '2026-07-12T09:30:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(ROOT, 'outside-place', 'tmp-script.sh') } }] }, cwd: projR, timestamp: '2026-07-12T09:31:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: MD_SUMMARY }] }, cwd: projR, timestamp: '2026-07-12T09:32:00.000Z' },
  ]));
  // A session whose only capture is the agent's self-report (no user prompt).
  fs.writeFileSync(path.join(rDir, 'sessNoAsk.jsonl'), jsonl([
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Resumed after a crash and finished wiring the webhook retries; the full suite is passing again.' }] }, cwd: projR, timestamp: '2026-07-12T09:40:00.000Z' },
  ]));
  syncOnce();

  check('fix: out-of-project files are excluded from the block and memory DB', () => {
    const md = richMd();
    assert.ok(md.includes('Files: (outside project)'), 'placeholder missing for an outside-only session');
    assert.ok(!md.includes('tmp-script.sh') && !md.includes('outside-place'), 'foreign path leaked into the block');
    const mem = read(path.join(projR, '.membridge', 'memory.json')) + read(path.join(projR, '.membridge', 'memory.md'));
    assert.ok(!mem.includes('tmp-script.sh') && !mem.includes('outside-place'), 'foreign path leaked into the memory DB');
  });
  check('fix: plainText flattens markdown before clipping', () => {
    const flat = digest.plainText('## Heading\n**bold** and `inline` text\n```js\nlet x = 1\n```\ncol a | col b');
    assert.strictEqual(flat, 'Heading bold and inline text let x = 1 col a col b');
    const line = richMd().split('\n').find(l => l.includes('Rewrote the scratch build runner'));
    assert.ok(line && line.trim().startsWith('Result:'), 'flattened summary missing from the block');
    assert.ok(!/[*`|#]/.test(line), `markdown survived into the Result line: ${line}`);
  });
  check('fix: a summary-only session renders Ask: (not captured)', () => {
    const md = richMd();
    assert.ok(md.includes('Ask: (not captured)'), 'placeholder Ask line missing');
    assert.ok(md.includes('finished wiring the webhook retries'), 'prompt-less summary missing');
  });

  // Team push carries the redacted summary (fresh mock: section 8's is gone).
  const mock2 = createMockSupabase();
  await new Promise(r => mock2.server.listen(17946, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17946';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    await teamsync.signup(util.getConfig(), 'rich@test.dev', 'pw-r', 'Rich');
    const teamR = await teamsync.createTeam(util.getConfig(), 'RichTeam');
    await teamsync.linkProject(util.getConfig(), projR, teamR.team_id, 'RichTeam');
    await teamsync.syncTeams({ project: projR });
    check('rich: pushed entries include the redacted summary, never todo text', () => {
      const withSummary = mock2.entries.filter(e => e.summary);
      assert.ok(withSummary.length >= 1, `no pushed entry carries a summary (${mock2.entries.length} rows)`);
      assert.ok(withSummary.some(e => e.summary.includes('[redacted')), 'pushed summary not redacted');
      assert.ok(mock2.entries.every(e => !e.summary || e.summary.length <= 300), 'summary over the 300-char cap');
      const body = JSON.stringify(mock2.entries);
      assert.ok(!body.includes('sk-test1234567890abcdef'), 'summary secret reached the server');
      assert.ok(!body.includes('secret-todo-999'), 'todo item text reached the server');
      assert.ok(mock2.entries.some(e => e.summary === null), 'summary-less entries should push null');
    });
    check('fix: out-of-project files never reach the server', () => {
      const row = mock2.entries.find(e => e.ask.includes('Patch the temp build script'));
      assert.ok(row, 'sessOut entry not pushed');
      assert.deepStrictEqual(row.files, [], `files said: ${JSON.stringify(row.files)}`);
      assert.ok(!JSON.stringify(mock2.entries).includes('tmp-script.sh'), 'foreign path reached the server');
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock2.server.close(r));
  }

  // --- 10. distillation: Stop hook, settings surgery, Distilled precedence ---
  const summariesFile = path.join(projR, '.membridge', 'summaries.jsonl');
  const runHook = payload => spawnSync(process.execPath, [BIN, 'hook', 'stop'], {
    input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env },
  });
  const stopPayload = (session, extra) => ({
    session_id: session, cwd: projR, hook_event_name: 'Stop',
    transcript_path: path.join(rDir, `${session}.jsonl`), stop_hook_active: false, ...extra,
  });
  // Raw stdin + arbitrary env, for the fail-open paths the JSON helper can't reach.
  const runHookRaw = (input, env) => spawnSync(process.execPath, [BIN, 'hook', 'stop'], {
    input, encoding: 'utf8', env: { ...process.env, ...env },
  });

  // Fail-open on the most common real path: the hook is installed but the
  // daemon never ran, so MEMBRIDGE_HOME has no state.json at all. And on
  // garbage/empty stdin (not a real hook invocation). Both must exit 0 silent.
  check('distill: hook fails open on a fresh HOME with no state and on garbage stdin', () => {
    const freshHome = path.join(ROOT, 'distill-fresh-home');
    const env = { MEMBRIDGE_HOME: freshHome };
    assert.ok(!fs.existsSync(path.join(freshHome, 'state.json')), 'fresh home should have no state');
    for (const [label, out] of [
      ['fresh home, valid payload', runHookRaw(JSON.stringify(stopPayload('sessR')), env)],
      ['garbage stdin', runHookRaw('not json at all', env)],
      ['empty stdin', runHookRaw('', env)],
      ['valid JSON, wrong type', runHookRaw('42', env)],
    ]) {
      assert.strictEqual(out.status, 0, `${label}: exit ${out.status} (${out.stderr})`);
      assert.strictEqual(out.stdout, '', `${label}: wrote to stdout: ${out.stdout}`);
      assert.strictEqual(out.stderr, '', `${label}: wrote to stderr: ${out.stderr}`);
    }
  });

  check('distill: pickSummary prefers Distilled over a newer harvested summary', () => {
    const distilledOlder = { ts: '2026-07-12T09:00:00.000Z', source: 'Distilled', kind: 'summary', session: 's', text: 'D' };
    const harvestedNewer = { ts: '2026-07-12T09:59:00.000Z', source: 'Claude Code', kind: 'summary', session: 's', text: 'H' };
    assert.strictEqual(digest.pickSummary([distilledOlder, harvestedNewer]), distilledOlder);
    // same tier: the later event wins; session filter narrows
    const h2 = { ...harvestedNewer, ts: '2026-07-12T10:30:00.000Z', text: 'H2' };
    assert.strictEqual(digest.pickSummary([harvestedNewer, h2]), h2);
    assert.strictEqual(digest.pickSummary([distilledOlder, harvestedNewer], 'nope'), null);
  });

  const blockOut = runHook(stopPayload('sessR'));
  check('distill: hook stop blocks with exact decision/reason JSON when no summary exists', () => {
    assert.strictEqual(blockOut.status, 0, blockOut.stderr);
    assert.strictEqual(blockOut.stderr, '', 'hook wrote to stderr');
    const parsed = JSON.parse(blockOut.stdout);
    assert.deepStrictEqual(Object.keys(parsed).sort(), ['decision', 'reason']);
    assert.strictEqual(parsed.decision, 'block');
    assert.ok(parsed.reason.includes(summariesFile), 'reason lacks the absolute summaries.jsonl path');
    assert.ok(parsed.reason.includes('"session":"sessR"'), 'reason lacks the session id in the schema');
    assert.ok(parsed.reason.includes('"did"') && parsed.reason.includes('"decisions"') && parsed.reason.includes('"gotchas"'), 'reason lacks the line schema');
  });
  check('distill: loop guard — stop_hook_active true never blocks twice', () => {
    const out = runHook(stopPayload('sessR', { stop_hook_active: true }));
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stdout, '');
  });
  check('distill: worthiness gate — a session with no edits is not blocked', () => {
    const out = runHook(stopPayload('sessShort'));
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stdout, '');
  });
  {
    const rawCfg = util.loadUserConfig();
    rawCfg.distill = { enabled: false };
    util.saveUserConfig(rawCfg);
    const out = runHook(stopPayload('sessR'));
    rawCfg.distill = { enabled: true, consent: 'granted' };
    util.saveUserConfig(rawCfg);
    check('distill: hook exits immediately when distill.enabled is false', () => {
      assert.strictEqual(out.status, 0);
      assert.strictEqual(out.stdout, '');
    });
  }
  fs.writeFileSync(summariesFile,
    'this is {not json\n' +
    JSON.stringify({ session: 'sessOther', ts: '2026-07-12T09:44:00.000Z', did: 'Tuned the CI cache keys so cold builds stopped thrashing the runner disks entirely.', decisions: '', gotchas: '' }) + '\n');
  check('distill: malformed summaries.jsonl lines count as absent, no crash', () => {
    const out = runHook(stopPayload('sessR'));
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(JSON.parse(out.stdout).decision, 'block', 'malformed line was treated as a summary');
  });
  fs.appendFileSync(summariesFile,
    JSON.stringify({ session: 'sessR', ts: '2026-07-12T09:45:00.000Z', did: 'Rebuilt the retry queue end to end; the flaky legacy path is gone.', decisions: 'Kept the queue schema; only consumers changed.', gotchas: '' }) + '\n');
  check('distill: hook allows the stop once a valid summary line exists', () => {
    const out = runHook(stopPayload('sessR'));
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stdout, '');
  });

  // A fresh session with BOTH a harvested and a distilled summary, recent
  // enough to clear the team-push cursor left by the section-9 sync.
  fs.writeFileSync(path.join(rDir, 'sessD.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Harden the webhook auth' }, cwd: projR, timestamp: '2026-07-12T09:50:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projR, 'src', 'webhook.js') } }] }, cwd: projR, timestamp: '2026-07-12T09:51:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Harvested note: webhook auth hardened with HMAC verification and replay-window checks everywhere.' }] }, cwd: projR, timestamp: '2026-07-12T09:52:00.000Z' },
  ]));
  fs.appendFileSync(summariesFile,
    JSON.stringify({ session: 'sessD', ts: '2026-07-12T09:53:00.000Z', did: 'Hardened the webhook auth with HMAC and a replay window; rotated api_key=sk-distilled-secret-123.', decisions: '', gotchas: 'Clock skew over 30s breaks verification.' }) + '\n');
  syncOnce();

  check('distill: summaries.jsonl is merged as Distilled events with offsets tracked', () => {
    const evs = richEvents();
    const d = evs.filter(e => e.kind === 'summary' && e.source === 'Distilled');
    assert.ok(d.some(e => e.session === 'sessR') && d.some(e => e.session === 'sessD') && d.some(e => e.session === 'sessOther'),
      `distilled sessions were: ${JSON.stringify(d.map(e => e.session))}`);
    assert.ok(d.find(e => e.session === 'sessD').text.includes('Gotchas: Clock skew'), 'gotchas not folded into the text');
    const rec = util.loadState().files[summariesFile];
    assert.ok(rec && rec.adapter === 'distill' && rec.offset > 0, `summaries offset record was ${JSON.stringify(rec)}`);
  });
  check('distill: the block prefers Distilled over harvested in every session', () => {
    const md = richMd();
    assert.ok(md.includes('Rebuilt the retry queue end to end'), 'sessR distilled summary missing');
    assert.ok(md.includes('Decisions: Kept the queue schema'), 'decisions not folded in');
    assert.ok(!md.includes('all pass in CI'), 'sessR harvested summary still shown');
    assert.ok(md.includes('Hardened the webhook auth'), 'sessD distilled summary missing');
    assert.ok(!md.includes('Harvested note'), 'sessD harvested summary still shown');
    assert.ok(!md.includes('sk-distilled-secret-123'), 'distilled secret leaked into the block');
  });
  check('distill: memory.md and the copy digest show the Distilled text', () => {
    const mem = read(path.join(projR, '.membridge', 'memory.md'));
    assert.ok(mem.includes('Rebuilt the retry queue end to end'), 'memory.md lacks the distilled result');
    assert.ok(mem.includes('Hardened the webhook auth') && !mem.includes('Harvested note'), 'memory.md picked the harvested summary');
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === projR.toLowerCase());
    const copy = memorydb.renderCopyText(projR, state.projects[key], util.getConfig());
    assert.ok(copy.includes('Hardened the webhook auth') && !copy.includes('Harvested note'), 'copy digest picked the harvested summary');
    assert.ok(!(mem + copy).includes('sk-distilled-secret-123'), 'distilled secret leaked');
  });
  check('distill: AGENTS.md carries the Codex self-report fallback, CLAUDE.md does not', () => {
    const agents = read(path.join(projR, 'AGENTS.md'));
    assert.ok(agents.includes('summaries.jsonl'), 'AGENTS.md fallback instruction missing');
    assert.ok(agents.includes('"did"'), 'fallback instruction lacks the line schema');
    assert.ok(agents.includes('never edit earlier lines'), 'fallback lacks the append-more-lines guidance');
    const claude = richMd();
    assert.ok(!claude.includes('append a line to'), 'CLAUDE.md got the Codex fallback instruction');
  });

  // setup-hooks / remove-hooks: surgical merge into a user's settings.json.
  const claudeSettings = path.join(ROOT, 'claude-settings.json');
  const seedSettings = {
    model: 'opus',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'echo user-stop' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }],
    },
    feedbackSurveyState: { lastShown: 123 },
  };
  fs.writeFileSync(claudeSettings, JSON.stringify(seedSettings, null, 2));
  const envHook = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: claudeSettings };
  const setup1 = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: envHook, encoding: 'utf8' });
  const afterSetup = JSON.parse(read(claudeSettings));
  const setup2 = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: envHook, encoding: 'utf8' });
  const afterSetup2 = JSON.parse(read(claudeSettings));
  check('distill: setup-hooks appends once and preserves user hooks byte-for-byte', () => {
    assert.strictEqual(setup1.status, 0, setup1.stderr);
    assert.strictEqual(afterSetup.hooks.Stop.length, 2, 'membridge entry not appended');
    assert.strictEqual(JSON.stringify(afterSetup.hooks.Stop[0]), JSON.stringify(seedSettings.hooks.Stop[0]), 'user Stop hook changed');
    assert.ok(JSON.stringify(afterSetup.hooks.Stop[1]).includes('membridge hook stop'), 'membridge command missing');
    assert.deepStrictEqual(afterSetup.hooks.PreToolUse, seedSettings.hooks.PreToolUse, 'unrelated hooks changed');
    assert.strictEqual(afterSetup.model, 'opus');
    assert.deepStrictEqual(afterSetup.feedbackSurveyState, seedSettings.feedbackSurveyState, 'unknown keys lost');
    assert.ok(/already installed/.test(setup2.stdout), `second run said: ${setup2.stdout}`);
    assert.strictEqual(afterSetup2.hooks.Stop.length, 2, 'setup-hooks duplicated the entry');
  });
  check('distill: status reports the Distill line with hook install state', () => {
    const out = spawnSync(process.execPath, [BIN, 'status'], { env: envHook, encoding: 'utf8' });
    assert.ok(/Distill:\s+enabled — Claude Code hook installed/.test(out.stdout), `status said: ${out.stdout}`);
  });
  const removeOut = spawnSync(process.execPath, [BIN, 'remove-hooks'], { env: envHook, encoding: 'utf8' });
  const afterRemove = JSON.parse(read(claudeSettings));
  check('distill: remove-hooks strips only membridge entries', () => {
    assert.ok(/Removed the MemBridge Stop hook/.test(removeOut.stdout), removeOut.stdout);
    assert.deepStrictEqual(afterRemove.hooks.Stop, seedSettings.hooks.Stop, 'user Stop hooks not intact');
    assert.deepStrictEqual(afterRemove.hooks.PreToolUse, seedSettings.hooks.PreToolUse, 'unrelated hooks changed');
    assert.strictEqual(afterRemove.model, 'opus');
  });
  // A settings.json MemBridge cannot safely parse must be refused, never
  // overwritten — a silent default-to-{} regression would wipe the user's
  // whole file (all their hooks, model, permissions).
  check('distill: setup/remove-hooks refuse an unsafe settings.json, leaving it byte-identical', () => {
    for (const bad of ['{ not json', JSON.stringify([1, 2, 3]), JSON.stringify({ hooks: [] }), JSON.stringify({ hooks: { Stop: {} } })]) {
      const badFile = path.join(ROOT, 'bad-settings.json');
      fs.writeFileSync(badFile, bad);
      const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: badFile };
      for (const cmd of ['setup-hooks', 'remove-hooks']) {
        const out = spawnSync(process.execPath, [BIN, cmd], { env, encoding: 'utf8' });
        assert.strictEqual(out.status, 1, `${cmd} on ${bad}: expected exit 1, got ${out.status}`);
        assert.ok(/refusing to touch/i.test(out.stderr), `${cmd} on ${bad}: no refusal message (${out.stderr})`);
        assert.strictEqual(read(badFile), bad, `${cmd} on ${bad}: file was modified`);
      }
    }
  });

  // Team push: the pushed summary field is the Distilled text, redacted.
  const mock3 = createMockSupabase();
  await new Promise(r => mock3.server.listen(17947, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17947';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    await teamsync.signup(util.getConfig(), 'distill@test.dev', 'pw-x', 'Distill');
    const teamX = await teamsync.createTeam(util.getConfig(), 'DistillTeam');
    await teamsync.linkProject(util.getConfig(), projR, teamX.team_id, 'DistillTeam');
    await teamsync.syncTeams({ project: projR });
    check('distill: pushed summary is the Distilled text, redacted', () => {
      const row = mock3.entries.find(e => e.ask.includes('Harden the webhook auth'));
      assert.ok(row, `sessD entry not pushed (${mock3.entries.length} rows)`);
      assert.ok(row.summary && row.summary.includes('Hardened the webhook auth'), `summary was: ${row.summary}`);
      assert.ok(!row.summary.includes('Harvested note'), 'push chose the harvested summary');
      assert.ok(row.summary.includes('[redacted'), 'pushed distilled summary not redacted');
      assert.ok(!JSON.stringify(mock3.entries).includes('sk-distilled-secret-123'), 'distilled secret reached the server');
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock3.server.close(r));
  }

  // Incremental second read: a summary appended AFTER the first scan must be
  // merged on the next sync. Pins the offset to the byte past the last
  // newline, so an over-advance that silently drops every later summary
  // (mergeEvents dedup would otherwise mask a sibling re-read) can't ship
  // green. Runs last: this supersedes sessR's earlier distilled summary.
  check('distill: a summary appended after the first scan is merged incrementally', () => {
    const before = util.loadState().files[summariesFile].offset;
    fs.appendFileSync(summariesFile,
      JSON.stringify({ session: 'sessR', ts: '2026-07-12T09:59:00.000Z', did: 'Follow-up: added a metrics counter for retry exhaustion so ops can alert on it.', decisions: '', gotchas: '' }) + '\n');
    const r = syncOnce();
    assert.ok(r.newEvents >= 1, `appended line produced no new event (got ${r.newEvents})`);
    const merged = richEvents().filter(e => e.kind === 'summary' && e.source === 'Distilled' && e.session === 'sessR');
    assert.ok(merged.some(e => e.text.includes('metrics counter for retry exhaustion')), 'appended summary not merged into events');
    const after = util.loadState().files[summariesFile].offset;
    assert.ok(after > before, `offset did not advance: ${before} -> ${after}`);
    assert.ok(richMd().includes('metrics counter for retry exhaustion'), 'appended summary not rendered (latest-in-tier wins)');
  });

  // --- 11. checkpoints: staleness-based re-blocking + the "go deeper" view ---
  // A project whose edit count (state) and checkpoint lines (disk) we control
  // directly, so the block/no-block thresholds can be exercised exactly.
  const projCk = path.join(ROOT, 'projects', 'checkpoint-app');
  fs.mkdirSync(path.join(projCk, '.membridge'), { recursive: true });
  const ckSummaries = path.join(projCk, '.membridge', 'summaries.jsonl');
  const ckTs = i => `2026-07-14T00:00:${String(i).padStart(2, '0')}.000Z`;
  const setCkEdits = n => {
    const st = util.loadState();
    st.projects[projCk] = {
      events: Array.from({ length: n }, (_, i) => ({
        ts: ckTs(i), source: 'Claude Code', kind: 'edit', file: path.join(projCk, `f${i}.js`), session: 'ck1',
      })),
    };
    util.saveState(st);
  };
  const writeCkLines = m => fs.writeFileSync(ckSummaries,
    Array.from({ length: m }, (_, i) => JSON.stringify({ session: 'ck1', ts: ckTs(i), did: `Checkpoint ${i}: did real work worth summarizing here.` })).join('\n') + (m ? '\n' : ''));
  const runCk = extra => spawnSync(process.execPath, [BIN, 'hook', 'stop'], {
    input: JSON.stringify({ session_id: 'ck1', cwd: projCk, stop_hook_active: false, ...extra }),
    encoding: 'utf8', env: { ...process.env },
  });
  const ckBlocked = out => out.status === 0 && !!out.stdout.trim() && JSON.parse(out.stdout).decision === 'block';

  check('checkpoint: re-blocks only when checkpointEvery further edits accrue (minEdits 1, every 4)', () => {
    writeCkLines(0); setCkEdits(1); // 0 lines, due at minEdits (1)
    assert.ok(ckBlocked(runCk()), 'first checkpoint did not block at minEdits');
    writeCkLines(1); setCkEdits(2); // 1 line, next due at 1+1*4=5
    assert.ok(!ckBlocked(runCk()), 'blocked too early (minEdits+1 with 1 line)');
    setCkEdits(5); // reaches the 2nd threshold
    assert.ok(ckBlocked(runCk()), 'did not block at minEdits+4 with 1 line');
    writeCkLines(2); setCkEdits(9); // 2 lines, next due at 1+2*4=9
    assert.ok(ckBlocked(runCk()), 'did not block again at minEdits+8 with 2 lines');
  });
  check('checkpoint: loop guard short-circuits even when a checkpoint is due', () => {
    writeCkLines(0); setCkEdits(5);
    const out = runCk({ stop_hook_active: true });
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stdout, '');
  });
  check('checkpoint: blockReason scopes later checkpoints to only new work', () => {
    const first = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 0);
    const later = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 2);
    assert.ok(!/since your previous summary/i.test(first), 'first checkpoint should not reference prior lines');
    assert.ok(/only the work done since your previous summary/i.test(later), 'later checkpoint must scope to new work');
    assert.ok(later.includes('2 already written'), 'later checkpoint should state the count');
    assert.ok(later.includes('do not repeat or modify earlier lines'), 'later checkpoint must forbid editing earlier lines');
  });
  check('checkpoint: countSummaryLines ignores malformed lines, empty did, and other sessions', () => {
    fs.writeFileSync(ckSummaries,
      'not json {\n' +
      JSON.stringify({ session: 'ck1', ts: ckTs(0), did: 'first real checkpoint' }) + '\n' +
      JSON.stringify({ session: 'other', ts: ckTs(1), did: 'a different session' }) + '\n' +
      JSON.stringify({ session: 'ck1', ts: ckTs(2), did: '   ' }) + '\n' +
      JSON.stringify({ session: 'ck1', ts: ckTs(3), did: 'second real checkpoint' }) + '\n');
    assert.strictEqual(hooks.countSummaryLines(projCk, 'ck1'), 2);
    assert.strictEqual(hooks.countSummaryLines(projCk, 'nope'), 0);
    assert.strictEqual(hooks.hasSummaryLine(projCk, 'ck1'), true);
  });
  check('checkpoint: checkpointEvery below 1 or non-finite falls back to 4', () => {
    const rawCfg = util.loadUserConfig();
    rawCfg.distill = { enabled: true, minEdits: 1, checkpointEvery: 0 };
    util.saveUserConfig(rawCfg);
    writeCkLines(1); setCkEdits(2); // with every=4 → threshold 5 → no block; with a bad every=0 → threshold 1 → block
    const out = runCk();
    delete rawCfg.distill;
    util.saveUserConfig(rawCfg);
    assert.ok(!ckBlocked(out), 'checkpointEvery 0 was not clamped to the default 4');
  });
  check('checkpoint: sessionSummaries returns only Distilled when both tiers exist, time-ordered', () => {
    const evs = [
      { kind: 'summary', source: 'Claude Code', session: 's', ts: '2026-07-14T01:00:00.000Z', text: 'harvested middle' },
      { kind: 'summary', source: 'Distilled', session: 's', ts: '2026-07-14T00:30:00.000Z', text: 'distilled early' },
      { kind: 'summary', source: 'Distilled', session: 's', ts: '2026-07-14T02:00:00.000Z', text: 'distilled late' },
      { kind: 'summary', source: 'Distilled', session: 'other', ts: '2026-07-14T00:00:00.000Z', text: 'wrong session' },
    ];
    assert.deepStrictEqual(digest.sessionSummaries(evs, 's').map(e => e.text), ['distilled early', 'distilled late']);
    const harvOnly = [{ kind: 'summary', source: 'Codex', session: 's', ts: 't', text: 'only harvested' }];
    assert.deepStrictEqual(digest.sessionSummaries(harvOnly, 's').map(e => e.text), ['only harvested']);
  });

  // Three distilled checkpoints in one session, driven end to end.
  const projSeq = path.join(ROOT, 'projects', 'seq-app');
  fs.mkdirSync(path.join(projSeq, 'src'), { recursive: true });
  const seqCDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-seq-app');
  fs.mkdirSync(seqCDir, { recursive: true });
  fs.writeFileSync(path.join(seqCDir, 'seq1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Migrate the auth module to tokens' }, cwd: projSeq, timestamp: '2026-07-14T03:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projSeq, 'src', 'auth.js') } }] }, cwd: projSeq, timestamp: '2026-07-14T03:01:00.000Z' },
  ]));
  fs.mkdirSync(path.join(projSeq, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(projSeq, '.membridge', 'summaries.jsonl'),
    JSON.stringify({ session: 'seq1', ts: '2026-07-14T03:05:00.000Z', did: 'Checkpoint one: scaffolded the token store and swapped the session cookie for a bearer header.' }) + '\n' +
    JSON.stringify({ session: 'seq1', ts: '2026-07-14T03:15:00.000Z', did: 'Checkpoint two: migrated the login and refresh endpoints; rotated api_key=sk-seq-secret-42 along the way.' }) + '\n' +
    JSON.stringify({ session: 'seq1', ts: '2026-07-14T03:25:00.000Z', did: 'Checkpoint three: deleted the legacy cookie path and updated every test to the token flow.' }) + '\n');
  syncOnce();

  check('checkpoint: block shows the latest checkpoint; memory.md/json hold the full ordered sequence', () => {
    const claude = read(path.join(projSeq, 'CLAUDE.md'));
    assert.ok(claude.includes('Result: Checkpoint three'), 'block should show the latest checkpoint');
    assert.ok(!claude.includes('Checkpoint one') && !claude.includes('Checkpoint two'), 'block should not show earlier checkpoints');
    assert.ok(!claude.includes('sk-seq-secret-42'), 'secret leaked into the block');
    const mem = read(path.join(projSeq, '.membridge', 'memory.md'));
    assert.ok(mem.includes('Checkpoints:'), 'memory.md checkpoints header missing');
    const i1 = mem.indexOf('Checkpoint one'), i2 = mem.indexOf('Checkpoint two'), i3 = mem.indexOf('Checkpoint three');
    assert.ok(i1 > -1 && i2 > i1 && i3 > i2, `memory.md checkpoints out of order: ${[i1, i2, i3]}`);
    assert.ok(!mem.includes('sk-seq-secret-42'), 'secret leaked into memory.md');
    const db = JSON.parse(read(path.join(projSeq, '.membridge', 'memory.json')));
    const entry = db.entries.find(e => Array.isArray(e.checkpoints));
    assert.ok(entry && entry.checkpoints.length === 3, `checkpoints array missing/wrong length: ${entry && entry.checkpoints.length}`);
    assert.ok(entry.checkpoints[2].includes('Checkpoint three'), 'checkpoints array out of order');
    assert.ok(!JSON.stringify(db).includes('sk-seq-secret-42'), 'secret leaked into memory.json');
  });

  const mock4 = createMockSupabase();
  await new Promise(r => mock4.server.listen(17948, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17948';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    await teamsync.signup(util.getConfig(), 'seq@test.dev', 'pw-s', 'Seq');
    const teamS = await teamsync.createTeam(util.getConfig(), 'SeqTeam');
    await teamsync.linkProject(util.getConfig(), projSeq, teamS.team_id, 'SeqTeam');
    await teamsync.syncTeams({ project: projSeq });
    check('checkpoint: team push carries only the latest checkpoint, redacted', () => {
      const row = mock4.entries.find(e => e.ask.includes('Migrate the auth module'));
      assert.ok(row, `seq entry not pushed (${mock4.entries.length} rows)`);
      assert.ok(row.summary && row.summary.includes('Checkpoint three'), `push summary was: ${row.summary}`);
      assert.ok(!row.summary.includes('Checkpoint one') && !row.summary.includes('Checkpoint two'), 'push carried an older checkpoint');
      assert.ok(!JSON.stringify(mock4.entries).includes('sk-seq-secret-42'), 'secret reached the server');
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock4.server.close(r));
  }

  // --- 12. built-in secret redaction (lib/redact.js) ---
  // Per-pattern unit coverage: the secret is gone and the named marker present.
  const GH_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const SLACK_TOKEN = 'xox' + 'b-9999999999-ABCDEFGHIJKLMNOP';
  const ANTHROPIC_KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOP1234567890';
  const GOOGLE_KEY = 'AIza' + 'B1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2'; // AIza + 35
  const AWS_KEY = 'AKIA1234567890ABCDEF';
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N';
  const PG_URI = 'postgres://app:hunter2secret@db.internal:5432/prod';
  const ENTROPY_TOKEN = 'aB3dE5gH7jK9mN1pQ3rS5tU7wX9zA1cE'; // 32-char base64, entropy > 4.5
  const cases = [
    ['aws-access-key', `creds ${AWS_KEY} here`, AWS_KEY],
    ['github-token', `rotate ${GH_TOKEN} now`, GH_TOKEN],
    ['google-api-key', `key ${GOOGLE_KEY} end`, GOOGLE_KEY],
    ['slack-token', `slack ${SLACK_TOKEN} end`, SLACK_TOKEN],
    ['anthropic-key', `key ${ANTHROPIC_KEY} tail`, ANTHROPIC_KEY],
    ['jwt', `token ${JWT} done`, JWT],
    ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIBhaha+notreal/xyz==\n-----END RSA PRIVATE KEY-----', 'MIIBhaha'],
    ['credentials', `DB ${PG_URI} yo`, 'hunter2secret'],
    ['secret-assignment', "config password=hunter2xyz done", 'hunter2xyz'],
    ['high-entropy', `blob ${ENTROPY_TOKEN} done`, ENTROPY_TOKEN],
  ];
  check('redact: every default pattern removes the secret and emits a named marker', () => {
    for (const [name, input, secret] of cases) {
      const out = redactLib.redactDefault(input);
      assert.ok(!out.includes(secret), `${name}: secret survived -> ${out}`);
      assert.ok(out.includes(`[redacted:${name}]`), `${name}: marker missing -> ${out}`);
    }
    // Bearer/authorization consume the whole value, no leak.
    const auth = redactLib.redactDefault('Authorization: Bearer abcDEF123456ghijKLmn');
    assert.ok(!auth.includes('abcDEF123456ghijKLmn') && auth.includes('[redacted:authorization]'), `auth -> ${auth}`);
  });

  // Negatives — as important as positives. None of these may be touched.
  check('redact: normal text, versions, paths, SHAs, UUIDs, identifiers survive untouched', () => {
    const survivors = [
      'The quick brown fox jumps over the lazy dog again and again.',
      'Upgrade express@4.18.2 and lodash@4.17.21 in package.json.',
      'See lib/adapters/claude-code.js and lib/redact.js for the wiring.',
      'Commit 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c reverted it cleanly.',
      'session 1f0e5d5d-1603-4ea6-8b41-832bf6d27195 kept running',
      'getUserAuthenticationTokenFromLocalCache is called on every request',
      'the config keys checkpointEvery and summaries.jsonl are documented',
      'a b c d camelCaseWord PascalCaseWord snake_case_word kebab-case-word',
    ];
    for (const s of survivors) {
      assert.strictEqual(redactLib.redactDefault(s), s, `false positive on: ${s}`);
    }
  });
  check('redact: session-id UUIDs are never redacted (load-bearing for the hook)', () => {
    const uuid = '1f0e5d5d-1603-4ea6-8b41-832bf6d27195';
    assert.strictEqual(redactLib.redactDefault(uuid), uuid);
    assert.strictEqual(redactLib.redactDefault(`Resumed session ${uuid} after a crash`).includes(uuid), true);
  });
  check('redact: entropy catches a standalone token but not the same token in a URL path', () => {
    assert.ok(redactLib.redactDefault(`x ${ENTROPY_TOKEN} y`).includes('[redacted:high-entropy]'), 'standalone token not caught');
    // Pinned behavior: a high-entropy segment inside a plain URL path (no
    // embedded credentials) is treated as a path, not a secret, and survives.
    const url = `https://cdn.example.com/assets/${ENTROPY_TOKEN}/main.js`;
    assert.strictEqual(redactLib.redactDefault(url), url, `URL path token was redacted -> ${redactLib.redactDefault(url)}`);
    assert.ok(redactLib.entropy(ENTROPY_TOKEN) > 4.5, 'test token is not actually high-entropy');
  });
  check('redact: redactDefaults:false opts out; redactExtra is additive', () => {
    const off = digest.redactText(`key ${AWS_KEY}`, digest.compileRedactions({ redactDefaults: false }));
    assert.ok(off.includes(AWS_KEY), 'defaults not disabled by redactDefaults:false');
    const extra = digest.redactText('internal CODENAME-BLUEJAY ships', digest.compileRedactions({ redactDefaults: false, redactExtra: ['CODENAME-\\w+'] }));
    assert.ok(!extra.includes('CODENAME-BLUEJAY') && extra.includes('[redacted]'), `redactExtra not applied -> ${extra}`);
    // defaults + user patterns compose: both a built-in and an extra match.
    const both = digest.redactText(`${AWS_KEY} and CODENAME-BLUEJAY`, digest.compileRedactions({ redactExtra: ['CODENAME-\\w+'] }));
    assert.ok(!both.includes(AWS_KEY) && !both.includes('CODENAME-BLUEJAY'), `compose failed -> ${both}`);
  });

  // Performance: default regexes compile once per pass, not per event.
  check('redact: a 200-event render stays well under 200ms', () => {
    const events = [];
    for (let i = 0; i < 200; i++) {
      const ts = `2026-07-15T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
      if (i % 3 === 0) events.push({ ts, source: 'Claude Code', kind: 'prompt', text: `Do step ${i} with some ${AWS_KEY} and ${ENTROPY_TOKEN} inline`, session: `s${i % 7}` });
      else if (i % 3 === 1) events.push({ ts, source: 'Claude Code', kind: 'edit', file: path.join(ROOT, 'projects', 'perf', `f${i}.js`), session: `s${i % 7}` });
      else events.push({ ts, source: 'Distilled', kind: 'summary', text: `Finished step ${i}; rotated ${ANTHROPIC_KEY} along the way.`, session: `s${i % 7}` });
    }
    const proj = { events };
    const cfg = util.getConfig();
    const t0 = Date.now();
    const block = digest.renderBlock(path.join(ROOT, 'projects', 'perf'), proj, cfg, 'CLAUDE.md');
    memorydb.buildEntries(path.join(ROOT, 'projects', 'perf'), proj, cfg);
    const ms = Date.now() - t0;
    assert.ok(ms < 200, `200-event render took ${ms}ms`);
    assert.ok(!block.includes(AWS_KEY) && !block.includes(ANTHROPIC_KEY), 'secret leaked into the perf render');
  });

  // End to end: secrets planted in a prompt, a distilled checkpoint, and a todo
  // item must be redacted in the block, memory.md, the copy digest, and a push.
  const projRed = path.join(ROOT, 'projects', 'redact-app');
  fs.mkdirSync(path.join(projRed, '.membridge'), { recursive: true });
  const redCDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-redact-app');
  fs.mkdirSync(redCDir, { recursive: true });
  fs.writeFileSync(path.join(redCDir, 'red1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: `Rotate the leaked GitHub token ${GH_TOKEN} immediately` }, cwd: projRed, timestamp: '2026-07-15T01:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [
      { content: `Revoke Slack token ${SLACK_TOKEN} in the admin panel`, status: 'in_progress', activeForm: 'Revoking Slack token' },
      { content: 'Ship the rotation script', status: 'pending', activeForm: 'Shipping' },
    ] } }] }, cwd: projRed, timestamp: '2026-07-15T01:01:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projRed, 'rotate.js') } }] }, cwd: projRed, timestamp: '2026-07-15T01:02:00.000Z' },
  ]));
  fs.writeFileSync(path.join(projRed, '.membridge', 'summaries.jsonl'),
    JSON.stringify({ session: 'red1', ts: '2026-07-15T01:05:00.000Z', did: `Rotated everything: new key ${ANTHROPIC_KEY} and moved the DB to ${PG_URI}.` }) + '\n');
  syncOnce();

  const redBlock = () => read(path.join(projRed, 'CLAUDE.md'));
  const secretsGone = s => !s.includes(GH_TOKEN) && !s.includes(SLACK_TOKEN) && !s.includes(ANTHROPIC_KEY) && !s.includes('hunter2secret');
  check('redact: block redacts secrets from prompt and distilled checkpoint', () => {
    const b = redBlock();
    assert.ok(secretsGone(b), 'a secret survived into the block');
    assert.ok(b.includes('[redacted:github-token]'), 'github marker missing from Ask line');
    assert.ok(b.includes('[redacted:anthropic-key]'), 'anthropic marker missing from Result line');
    assert.ok(b.includes('[redacted:credentials]'), 'connection marker missing from Result line');
  });
  check('redact: memory.md and memory.json redact prompt, checkpoint, and todo item', () => {
    const mem = read(path.join(projRed, '.membridge', 'memory.md'));
    const db = read(path.join(projRed, '.membridge', 'memory.json'));
    assert.ok(secretsGone(mem) && secretsGone(db), 'a secret survived into the memory DB');
    assert.ok(mem.includes('[redacted:github-token]') && mem.includes('[redacted:anthropic-key]'), 'markers missing from memory.md');
    assert.ok(db.includes('[redacted:slack-token]'), 'todo item Slack token not redacted in memory.json');
  });
  check('redact: copy-for-AI digest redacts every planted secret', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => k.toLowerCase() === projRed.toLowerCase());
    const copy = memorydb.renderCopyText(projRed, state.projects[key], util.getConfig());
    assert.ok(secretsGone(copy), 'a secret survived into the copy digest');
    assert.ok(copy.includes('[redacted:github-token]') && copy.includes('[redacted:anthropic-key]'), 'markers missing from copy digest');
  });

  const mock5 = createMockSupabase();
  await new Promise(r => mock5.server.listen(17949, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17949';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    await teamsync.signup(util.getConfig(), 'red@test.dev', 'pw-r', 'Red');
    const teamRed = await teamsync.createTeam(util.getConfig(), 'RedTeam');
    await teamsync.linkProject(util.getConfig(), projRed, teamRed.team_id, 'RedTeam');
    await teamsync.syncTeams({ project: projRed });
    check('redact: pushed entries carry only redacted markers, never a secret', () => {
      const body = JSON.stringify(mock5.entries);
      assert.ok(!body.includes(GH_TOKEN) && !body.includes(ANTHROPIC_KEY) && !body.includes('hunter2secret'), 'a secret reached the server');
      const row = mock5.entries.find(e => e.ask.includes('[redacted:github-token]'));
      assert.ok(row, 'pushed ask not redacted with a named marker');
      assert.ok(row.summary.includes('[redacted:anthropic-key]'), `pushed summary not redacted -> ${row.summary}`);
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mock5.server.close(r));
  }

  // --- 12. consent: needsConsentPrompt + applyConsent + digest gating ---
  const consent = require('../lib/consent');

  check('consent: needsConsentPrompt returns true for fresh config', () => {
    assert.strictEqual(consent.needsConsentPrompt({ distill: { enabled: true, consent: null } }), true);
  });
  check('consent: needsConsentPrompt returns false after granted', () => {
    assert.strictEqual(consent.needsConsentPrompt({ distill: { enabled: true, consent: 'granted' } }), false);
  });
  check('consent: needsConsentPrompt returns false after declined', () => {
    assert.strictEqual(consent.needsConsentPrompt({ distill: { enabled: true, consent: 'declined' } }), false);
  });
  check('consent: needsConsentPrompt returns false when distill disabled', () => {
    assert.strictEqual(consent.needsConsentPrompt({ distill: { enabled: false, consent: null } }), false);
  });

  // Save current consent, test digest gating, then restore
  const savedConsent = (util.loadUserConfig().distill || {}).consent;
  function setConsent(val) {
    const rc = util.loadUserConfig();
    if (!rc.distill) rc.distill = {};
    rc.distill.consent = val;
    util.saveUserConfig(rc);
  }
  function dirtyProj1() {
    const st = util.loadState();
    const k = Object.keys(st.projects).find(p => p.toLowerCase() === proj1.toLowerCase());
    if (k) { st.projects[k].dirty = true; util.saveState(st); }
  }
  setConsent(null);
  dirtyProj1();
  syncOnce();
  check('consent: digest omits summary line when consent is null', () => {
    const agents = read(path.join(proj1, 'AGENTS.md'));
    assert.ok(!agents.includes('summaries.jsonl'), 'summaries instruction present without consent');
  });
  setConsent('granted');
  dirtyProj1();
  syncOnce();
  check('consent: digest includes summary line after consent granted', () => {
    const agents = read(path.join(proj1, 'AGENTS.md'));
    assert.ok(agents.includes('summaries.jsonl'), 'summaries instruction missing after consent granted');
  });
  setConsent('declined');
  dirtyProj1();
  syncOnce();
  check('consent: digest omits summary line after consent declined', () => {
    const agents = read(path.join(proj1, 'AGENTS.md'));
    assert.ok(!agents.includes('summaries.jsonl'), 'summaries instruction present after declined');
  });

  // applyConsent + hook checks
  const consentSettings = path.join(ROOT, 'consent-claude-settings.json');
  fs.writeFileSync(consentSettings, JSON.stringify({ model: 'opus' }));
  setConsent(null);
  const origEnv = process.env.MEMBRIDGE_CLAUDE_SETTINGS;
  process.env.MEMBRIDGE_CLAUDE_SETTINGS = consentSettings;
  try {
    consent.applyConsent('granted');
    check('consent: applyConsent granted installs the Stop hook', () => {
      const s = JSON.parse(read(consentSettings));
      const stopHooks = (s.hooks && s.hooks.Stop) || [];
      assert.ok(stopHooks.some(e => JSON.stringify(e).includes('membridge')), 'hook not installed');
    });
    check('consent: applyConsent granted sets consent in config', () => {
      assert.strictEqual(util.loadUserConfig().distill.consent, 'granted');
    });

    // Reset and test declined
    fs.writeFileSync(consentSettings, JSON.stringify({ model: 'opus' }));
    setConsent(null);
    consent.applyConsent('declined');
    check('consent: applyConsent declined does NOT install the hook', () => {
      const s = JSON.parse(read(consentSettings));
      const stopHooks = (s.hooks && s.hooks.Stop) || [];
      assert.ok(!stopHooks.some(e => JSON.stringify(e).includes('membridge')), 'hook installed on decline');
    });

    // Idempotency
    setConsent(null);
    fs.writeFileSync(consentSettings, JSON.stringify({ model: 'opus' }));
    consent.applyConsent('granted');
    consent.applyConsent('granted');
    check('consent: granting twice does not duplicate the hook', () => {
      const s = JSON.parse(read(consentSettings));
      const stopHooks = (s.hooks && s.hooks.Stop) || [];
      const mbHooks = stopHooks.filter(e => JSON.stringify(e).includes('membridge'));
      assert.strictEqual(mbHooks.length, 1, `expected 1 membridge hook, got ${mbHooks.length}`);
    });
  } finally {
    if (origEnv !== undefined) process.env.MEMBRIDGE_CLAUDE_SETTINGS = origEnv;
    else delete process.env.MEMBRIDGE_CLAUDE_SETTINGS;
    // Restore consent for any remaining tests
    const rc = util.loadUserConfig();
    rc.distill.consent = savedConsent;
    util.saveUserConfig(rc);
  }

  // --- summary ---
  const failed = results.filter(([, e]) => e);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {}
  if (failed.length) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
