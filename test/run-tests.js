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
const { syncOnce, filterTrackedSessions, filterScratchpadResidue } = require('../lib/scan');
const digest = require('../lib/digest');
const { startServer, teamPayload, teamProjectsPayload, statusPayload, feedPayload, projectDetail, planPayload } = require('../lib/server');
const teamsync = require('../lib/teamsync');
const { createMockSupabase } = require('./mock-supabase');
const advisorLib = require('../lib/advisor');
const advisors = require('../lib/advisors');
const memorydb = require('../lib/memorydb');
const claudeAdapter = require('../lib/adapters/claude-code');
const codexAdapter = require('../lib/adapters/codex');
const hooks = require('../lib/hooks');
const redactLib = require('../lib/redact');
const feed = require('../lib/feed');
const mcpMod = require('../lib/mcp');
const changesLib = require('../lib/changes');
const projectResolve = require('../lib/project-resolve');
const { Client: McpClient } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const BIN = path.join(__dirname, '..', 'bin', 'membridge.js');
const proj1 = path.join(ROOT, 'projects', 'shop-app');
const proj2 = path.join(ROOT, 'projects', 'excluded-app');
const proj3 = path.join(ROOT, 'projects', 'marker-app');

const results = [];
// Supports both sync and async fn. Sync callers (the vast majority) ignore
// the return value, exactly as before. Async callers must `await check(...)`
// so a rejected assertion is recorded as a FAIL instead of becoming an
// unhandled promise rejection that crashes the whole suite.
function check(name, fn) {
  const onOk = () => { results.push([name, null]); console.log(`  ok    ${name}`); };
  const onErr = err => { results.push([name, err]); console.log(`  FAIL  ${name}\n        ${err.message}`); };
  try {
    const ret = fn();
    if (ret && typeof ret.then === 'function') return ret.then(onOk, onErr);
    onOk();
  } catch (err) {
    onErr(err);
  }
}
const jsonl = lines => lines.map(l => JSON.stringify(l)).join('\n') + '\n';
const read = f => fs.readFileSync(f, 'utf8');
const count = (hay, needle) => hay.split(needle).length - 1;

// Minimal OpenAI/Gemini-shaped JSON mock. `handler(req, body, send)` returns a
// response via send(code, obj). Returns the http.Server (already listening).
function startJsonMock(port, handler) {
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = {}; try { body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch {}
      handler(req, body, (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); });
    });
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

function setupFixtures() {
  for (const p of [proj1, proj2, proj3]) fs.mkdirSync(p, { recursive: true });
  // The ingestion gate only keeps sessions landing in an already-tracked root.
  // proj1 is the tracked project; proj2/proj3 stay untracked on purpose (their
  // exclusion/marker tests assert no .membridge is ever created for them).
  fs.mkdirSync(path.join(proj1, '.membridge'), { recursive: true });
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
  // The legacy team-sync tests assert prompt text crossing the wire, so the
  // main test home opts into prompt sharing. The prompt-gate section removes
  // and restores this flag to pin the shipped (ask=null) default explicitly.
  // encrypt:false is the explicit escape hatch (encryption defaults ON): the
  // whole legacy section doubles as proof the hatch restores plaintext sync
  // byte-identically, and keeps these tests off the real macOS keychain.
  cfg.team = { ...(cfg.team || {}), sharePrompts: true, encrypt: false };
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
// Tiny (port, path) helpers for the in-process/daemon server tests — a thin
// wrapper over fetch/post that always resolves the parsed JSON body.
const httpGet = (port, p) => fetch(`http://127.0.0.1:${port}${p}`).then(r => r.json());
const httpPost = (port, p, body) => post(`http://127.0.0.1:${port}${p}`, body).then(r => r.json());

async function main() {
  console.log(`MemBridge test suite (fixtures in ${ROOT})\n`);
  setupFixtures();

  // --- capture hygiene: temp/scratchpad edits never mint a phantom project ---
  check('util.isTempPath: scratchpad + claude temp roots are temp; real paths are not', () => {
    assert.strictEqual(util.isTempPath('/private/tmp/claude-501/-Users-x/abc/scratchpad/mine/lib/x.js'), true);
    assert.strictEqual(util.isTempPath('/tmp/claude-9/work/file.js'), true);
    assert.strictEqual(util.isTempPath('/repo/scratchpad/note.md'), true); // scratchpad segment anywhere
    assert.strictEqual(util.isTempPath('/Users/marco/Documents/AI/src/x.js'), false);
    assert.strictEqual(util.isTempPath('/tmp/membridge-test-abc/projects/shop/login.js'), false); // fixture-style path
    assert.strictEqual(util.isTempPath(''), false);
  });

  check('capture: temp/scratchpad edits are dropped; real edits attributed to the repo', () => {
    const repo = path.join(ROOT, 'hygiene-repo');
    fs.mkdirSync(repo, { recursive: true });
    const events = [
      { kind: 'edit', file: '/private/tmp/claude-9/x/scratchpad/mine/a.js', project: repo, session: 's1' },
      { kind: 'edit', file: path.join(repo, 'real.js'), project: repo, session: 's1' },
      { kind: 'prompt', text: 'do it', project: repo, session: 's1' },
    ];
    projectResolve.rehomeEvents(events, new Set([util.normPath(repo)]));
    const kept = filterTrackedSessions(events, new Set([util.normPath(repo)]));
    assert.strictEqual(kept.some(e => e.file && e.file.includes('scratchpad')), false, 'temp edit leaked into ingestion');
    assert.ok(kept.some(e => e.kind === 'edit' && e.file === path.join(repo, 'real.js')), 'real edit missing');
    assert.ok(kept.every(e => util.normPath(e.project) === util.normPath(repo)), 'kept events not homed to the repo');
  });

  check('capture: filterScratchpadResidue drops pure-scratchpad sessions, keeps mixed & prompt-only', () => {
    const tmp = '/private/tmp/claude-9/x/scratchpad/a.js';
    const events = [
      // s1 pure-scratchpad: temp edit + prompt -> everything dropped (no cwd residue)
      { kind: 'edit', file: tmp, project: '/AI', session: 's1' },
      { kind: 'prompt', text: 'scratch work', project: '/AI', session: 's1' },
      // s2 mixed: temp edit dropped, real edit + prompt kept
      { kind: 'edit', file: tmp, project: '/repo', session: 's2' },
      { kind: 'edit', file: '/repo/real.js', project: '/repo', session: 's2' },
      { kind: 'prompt', text: 'real work', project: '/repo', session: 's2' },
      // s3 prompt-only (no edits at all) -> untouched
      { kind: 'prompt', text: 'planning', project: '/repo', session: 's3' },
    ];
    const out = filterScratchpadResidue(events);
    assert.strictEqual(out.some(e => e.session === 's1'), false, 'pure-scratchpad session residue not dropped');
    assert.strictEqual(out.some(e => e.file && e.file.includes('scratchpad')), false, 'a temp edit leaked');
    assert.ok(out.some(e => e.session === 's2' && e.kind === 'prompt'), 's2 prompt lost');
    assert.ok(out.some(e => e.session === 's2' && e.file === '/repo/real.js'), 's2 real edit lost');
    assert.ok(out.some(e => e.session === 's3'), 'prompt-only session wrongly dropped');
  });

  check('prepare-app bundles the CLI into app/bin so the packaged asar carries it', () => {
    const r = spawnSync('node', [path.join(__dirname, '..', 'scripts', 'prepare-app.js')], { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `prepare-app failed: ${r.stderr}`);
    const binned = path.join(__dirname, '..', 'app', 'bin', 'membridge.js');
    assert.ok(fs.existsSync(binned), 'app/bin/membridge.js not created by prepare-app');
  });

  check('gen-install: sha256File hashes file contents', () => {
    const gen = require('../scripts/install/gen-install');
    const f = path.join(ROOT, 'fixture.zip');
    fs.writeFileSync(f, 'hello'); // sha256("hello") is a known constant
    assert.strictEqual(gen.sha256File(f),
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
  check('gen-install: renderInstallScript stamps version + sha256 and leaves no placeholders', () => {
    const gen = require('../scripts/install/gen-install');
    const out = gen.renderInstallScript('V=__MEMBRIDGE_VERSION__ H=__MEMBRIDGE_SHA256__',
      { version: '9.9.9', sha256: 'abc123' });
    assert.strictEqual(out, 'V=9.9.9 H=abc123');
    assert.ok(!out.includes('__MEMBRIDGE_'), 'placeholders left unstamped');
  });
  check('install.sh template carries the safety-critical steps', () => {
    const tmpl = read(path.join(__dirname, '..', 'scripts', 'install', 'install.sh.tmpl'));
    assert.ok(tmpl.includes('com.apple.quarantine'), 'quarantine strip missing');
    assert.ok(tmpl.includes('ELECTRON_RUN_AS_NODE=1'), 'CLI wrapper runtime missing');
    assert.ok(tmpl.includes('shasum -a 256'), 'sha256 verification missing');
    assert.ok(tmpl.includes('__MEMBRIDGE_VERSION__') && tmpl.includes('__MEMBRIDGE_SHA256__'),
      'pin placeholders missing');
  });
  check('build config ships an arm64 zip with a deterministic name for the installer URL', () => {
    const pkg = JSON.parse(read(path.join(__dirname, '..', 'package.json')));
    // arm64 pinned inside the target object (electron-builder has no valid
    // top-level mac.arch), so the emitted asset is deterministically
    // MemBridge-<version>-arm64.zip and the install.sh URL resolves.
    assert.deepStrictEqual(pkg.build.mac.target, [{ target: 'zip', arch: ['arm64'] }],
      'mac target should be a single arm64-pinned zip');
    assert.strictEqual(pkg.build.mac.artifactName, 'MemBridge-${version}-${arch}.${ext}',
      'artifactName must be deterministic so install.sh can build the release URL');
  });

  // --- 1. fresh sync ---
  const r1 = syncOnce();
  const claudeMd = () => read(path.join(proj1, 'CLAUDE.md'));
  const agentsMd = () => read(path.join(proj1, 'AGENTS.md'));

  check('fresh sync finds events from all three tools', () => {
    // proj1's five events survive the ingestion gate; proj2/proj3 sessions are
    // dropped (untracked cwds) and asserted absent in the gate section below.
    assert.ok(r1.newEvents >= 5, `expected >=5 events, got ${r1.newEvents}`);
  });
  check('untracked fixture cwds never become projects', () => {
    const st = util.loadState();
    for (const p of [proj2, proj3]) {
      assert.ok(!Object.keys(st.projects || {}).some(k => util.normPath(k) === util.normPath(p)),
        `${p} should not have been auto-created`);
    }
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
  // --- 1b. capture provenance: the codex adapter must never mislabel foreign
  // files. Codex Desktop's history importer writes rollout-SHAPED files for
  // OTHER tools' sessions under ~/.codex/sessions, branded in the originator
  // (Claude Code / Cowork) — those and any Claude-Code-shaped JSONL in the
  // codex root must be skipped, not stamped 'Codex'. history_mode "legacy" is
  // NOT a foreignness signal (genuine native Codex sessions carry it too). ---
  check('codex: an imported rollout (Claude/Cowork originator) is skipped, never stamped Codex', () => {
    const fsA = {};
    const evsA = codexAdapter.extractEvents([
      { timestamp: '2026-07-18T23:08:43.825Z', type: 'session_meta', payload: { id: 'imp-1', cwd: proj1, originator: 'Claude Code', history_mode: 'legacy' } },
      { timestamp: '2026-07-18T23:08:43.831Z', type: 'event_msg', payload: { type: 'user_message', message: 'how do i get to it fast' } },
    ], fsA);
    assert.deepStrictEqual(evsA, [], 'imported Claude-Code rollout produced Codex events');
    assert.ok(fsA.foreign, 'imported file not marked foreign');
    const fsB = {};
    const evsB = codexAdapter.extractEvents([
      { timestamp: '2026-07-18T23:08:47.000Z', type: 'session_meta', payload: { id: 'imp-2', cwd: proj1, originator: 'Claude Cowork' } },
      { timestamp: '2026-07-18T23:08:47.100Z', type: 'event_msg', payload: { type: 'user_message', message: 'morning email summary please' } },
    ], fsB);
    assert.deepStrictEqual(evsB, [], 'Cowork-originated rollout produced Codex events');
    assert.ok(fsB.foreign, 'Cowork file not marked foreign');
    // once foreign, later incremental batches stay skipped even with codex-ish lines
    const evsA2 = codexAdapter.extractEvents([
      { timestamp: '2026-07-18T23:09:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'try again', cwd: proj1 } },
    ], fsA);
    assert.deepStrictEqual(evsA2, [], 'foreign file resumed emitting on a later batch');
  });
  check('codex: a Claude-Code-shaped transcript in the codex root is skipped (no session_meta opener)', () => {
    const fsC = {};
    const evsC = codexAdapter.extractEvents([
      { type: 'user', message: { role: 'user', content: 'Build the login page with OAuth' }, cwd: proj1, timestamp: '2026-07-10T10:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(120) }] }, cwd: proj1, timestamp: '2026-07-10T10:01:00.000Z' },
    ], fsC);
    assert.deepStrictEqual(evsC, [], 'Claude-shaped transcript produced Codex events');
    assert.ok(fsC.foreign, 'Claude-shaped file not marked foreign');
  });
  check('codex: a genuine rollout still ingests as Codex (no regression), and the verdict persists in fileState', () => {
    const fsD = {};
    const evsD = codexAdapter.extractEvents([
      { timestamp: '2026-07-09T10:05:00.000Z', type: 'session_meta', payload: { id: 'gen-1', cwd: proj1, originator: 'codex_cli_rs' } },
      { timestamp: '2026-07-09T10:06:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add unit tests for the login form' } },
    ], fsD);
    assert.strictEqual(evsD.length, 1, `expected 1 event, got ${evsD.length}`);
    assert.strictEqual(evsD[0].source, 'Codex');
    assert.strictEqual(evsD[0].project, proj1);
    assert.ok(fsD.validated, 'genuine file not stamped validated');
    // incremental follow-up batch (no session_meta) keeps working off the verdict
    const evsD2 = codexAdapter.extractEvents([
      { timestamp: '2026-07-09T10:07:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Now wire the submit button' } },
    ], fsD);
    assert.strictEqual(evsD2.length, 1, 'validated file stopped ingesting on incremental read');
  });
  // Regression: current Codex (>= ~0.144) stamps history_mode "legacy" on
  // GENUINE native sessions, not just imported foreign ones. history_mode is
  // therefore not a foreignness signal; only a Claude/Cowork originator is. A
  // native rollout carrying legacy + a Codex originator MUST still ingest.
  check('codex: a genuine native rollout stamped history_mode "legacy" still ingests as Codex', () => {
    for (const originator of ['Codex Desktop', 'codex_work_desktop']) {
      const fsL = {};
      const evsL = codexAdapter.extractEvents([
        { timestamp: '2026-07-21T18:56:28.000Z', type: 'session_meta', payload: { id: 'nat-1', cwd: proj1, originator, history_mode: 'legacy', model_provider: 'openai' } },
        { timestamp: '2026-07-21T18:57:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'remove the back button in the activity tab' } },
      ], fsL);
      assert.strictEqual(evsL.length, 1, `[${originator}] expected 1 event, got ${evsL.length}`);
      assert.strictEqual(evsL[0].source, 'Codex', `[${originator}] not stamped Codex`);
      assert.strictEqual(evsL[0].kind, 'prompt', `[${originator}] not a prompt`);
      assert.ok(fsL.validated, `[${originator}] genuine legacy rollout not validated`);
      assert.ok(!fsL.foreign, `[${originator}] genuine legacy rollout wrongly marked foreign`);
    }
  });
  check('codex cleanup: purges mislabeled sessions + resets offsets, leaves genuine and undecidable files alone', () => {
    const scanMod = require('../lib/scan');
    const foreignFile = '/fake/.codex/sessions/2026/07/18/rollout-fake-import.jsonl';
    const genuineFile = '/fake/.codex/sessions/2026/06/01/rollout-real.jsonl';
    const missingFile = '/fake/.codex/sessions/2026/05/01/rollout-gone.jsonl';
    const st = {
      files: {
        [foreignFile]: { offset: 999, adapter: 'codex', data: { cwd: proj1 } },
        [genuineFile]: { offset: 500, adapter: 'codex', data: { cwd: '/other/proj' } },
        [missingFile]: { offset: 42, adapter: 'codex', data: {} },
        '/fake/claude/x.jsonl': { offset: 5, adapter: 'claude-code', data: {} },
      },
      projects: {
        [proj1]: { events: [
          { ts: '2026-07-18T23:08:43.831Z', project: proj1, source: 'Codex', kind: 'prompt', text: 'mislabeled', session: 'rollout-fake-import' },
          { ts: '2026-07-18T23:08:43.900Z', project: proj1, source: 'Codex', kind: 'prompt', text: 'unjudgeable', session: 'rollout-gone' },
          { ts: '2026-07-09T10:00:00.000Z', project: proj1, source: 'Claude Code', kind: 'prompt', text: 'real claude', session: 'sess-c' },
        ] },
        '/other/proj': { events: [
          { ts: '2026-06-01T09:00:00.000Z', project: '/other/proj', source: 'Codex', kind: 'prompt', text: 'genuine codex', session: 'rollout-real' },
        ] },
      },
    };
    const purged = scanMod.cleanupCodexMislabels(st, { readFirstEntry: f =>
      f === foreignFile ? { type: 'session_meta', payload: { id: 'i', cwd: proj1, originator: 'Claude Cowork', history_mode: 'legacy' } }
      : f === genuineFile ? { type: 'session_meta', payload: { id: 'g', cwd: '/other/proj' } }
      : null });
    assert.deepStrictEqual(purged, ['rollout-fake-import'], 'purge set is not exactly the foreign file');
    assert.ok(!st.files[foreignFile], 'foreign file offsets not reset');
    assert.ok(st.files[genuineFile] && st.files[genuineFile].data.validated, 'genuine file not stamped validated');
    assert.strictEqual(st.files[genuineFile].offset, 500, 'genuine file offset must not reset');
    assert.ok(st.files[missingFile], 'undecidable (missing) file must be left alone');
    assert.deepStrictEqual(st.projects[proj1].events.map(e => e.session), ['rollout-gone', 'sess-c'],
      'purge must remove exactly the foreign-file Codex events');
    assert.strictEqual(st.projects['/other/proj'].events.length, 1, 'genuine Codex session on another project was deleted');
    assert.ok(st.projects[proj1].dirty, 'purged project not marked dirty for re-render');
    assert.ok(!st.projects['/other/proj'].dirty, 'untouched project must not be dirtied');
    // second pass is a no-op for decided recs: even a reader that now calls
    // everything legacy must not re-judge the validated genuine file. The
    // still-missing file stays undecided (it would be judged if it appeared —
    // deliberate self-healing).
    const purged2 = scanMod.cleanupCodexMislabels(st, { readFirstEntry: f =>
      f === missingFile ? null : { type: 'session_meta', payload: { id: 'z', history_mode: 'legacy' } } });
    assert.deepStrictEqual(purged2, [], 'cleanup re-judged already-decided files');
  });
  // The reverse migration: the old history_mode gate persisted foreign:true on
  // GENUINE native sessions and consumed their offsets, so a mere gate fix
  // leaves them black-holed forever. reopen re-reads each foreign codex file
  // and, if the corrected gate now accepts it, drops the rec so the next scan
  // re-reads it from offset 0 and re-ingests. Real imports stay foreign and are
  // flagged so they're never re-read again (self-quiescing).
  check('codex reopen: a foreign-marked file that now passes the gate is reset to re-scan; genuine imports stay foreign', () => {
    const scanMod = require('../lib/scan');
    const healFile = '/fake/.codex/sessions/2026/07/21/rollout-native-legacy.jsonl';
    const realImport = '/fake/.codex/sessions/2026/07/18/rollout-cowork.jsonl';
    const validated = '/fake/.codex/sessions/2026/06/01/rollout-good.jsonl';
    const st = {
      files: {
        [healFile]: { offset: 900, adapter: 'codex', data: { foreign: true } },
        [realImport]: { offset: 800, adapter: 'codex', data: { foreign: true } },
        [validated]: { offset: 500, adapter: 'codex', data: { validated: true, cwd: '/p' } },
        '/fake/claude/y.jsonl': { offset: 5, adapter: 'claude-code', data: { foreign: true } },
      },
    };
    const reader = f =>
      f === healFile ? { type: 'session_meta', payload: { id: 'h', cwd: '/p', originator: 'codex_work_desktop', history_mode: 'legacy', model_provider: 'openai' } }
      : f === realImport ? { type: 'session_meta', payload: { id: 'r', cwd: '/p', originator: 'Claude Cowork', history_mode: 'legacy' } }
      : null;
    const reopened = scanMod.reopenMislabeledForeignCodex(st, { readFirstEntry: reader });
    assert.deepStrictEqual(reopened, ['rollout-native-legacy'], 'reopen set is not exactly the healed native file');
    assert.ok(!st.files[healFile], 'healed file rec not reset (must re-scan from offset 0)');
    assert.ok(st.files[realImport] && st.files[realImport].data.foreign, 'genuine import lost its foreign verdict');
    assert.ok(st.files[realImport].data.reopenChecked, 'genuine import not flagged (would be re-read every sync)');
    assert.strictEqual(st.files[realImport].offset, 800, 'genuine import offset must not move');
    assert.ok(st.files[validated] && st.files[validated].data.validated && !st.files[validated].data.reopenChecked, 'validated file disturbed');
    assert.strictEqual(st.files['/fake/claude/y.jsonl'].offset, 5, 'non-codex file disturbed');
    // idempotent + self-quiescing: nothing left to reopen, and no decided file is re-read
    let reads = 0;
    const reopened2 = scanMod.reopenMislabeledForeignCodex(st, { readFirstEntry: f => { reads++; return reader(f); } });
    assert.deepStrictEqual(reopened2, [], 'second pass reopened something');
    assert.strictEqual(reads, 0, 'second pass re-read a decided file (not self-quiescing)');
  });
  // ACCEPTANCE e2e: replicate the real damage (imported rollout on disk, its
  // events already in state as 'Codex') — after a sync, the project has ZERO
  // Codex sessions from imported files, genuine Codex events survive, and a
  // re-scan does not re-introduce the mislabels.
  {
    const impDir = path.join(process.env.MEMBRIDGE_CODEX_DIR, '2026', '07', '18');
    fs.mkdirSync(impDir, { recursive: true });
    const impFile = path.join(impDir, 'rollout-import-e2e.jsonl');
    fs.writeFileSync(impFile, jsonl([
      { timestamp: '2026-07-18T23:08:43.825Z', type: 'session_meta', payload: { id: 'imp-e2e', cwd: proj1, originator: 'Claude Cowork', history_mode: 'legacy' } },
      { timestamp: '2026-07-18T23:08:43.831Z', type: 'event_msg', payload: { type: 'user_message', message: 'i had an idea as another feature for membridge' } },
    ]));
    const stSeed = util.loadState();
    const p1key = Object.keys(stSeed.projects || {}).find(k => util.normPath(k) === util.normPath(proj1));
    assert.ok(p1key, 'proj1 missing from state before acceptance seed');
    // pre-fix damage: file fully consumed by the old adapter, events stamped Codex
    stSeed.files[impFile] = { offset: fs.statSync(impFile).size, adapter: 'codex', data: { cwd: proj1 } };
    stSeed.projects[p1key].events.push(
      { ts: '2026-07-18T23:08:43.831Z', project: p1key, source: 'Codex', kind: 'prompt', text: 'i had an idea as another feature for membridge', session: 'rollout-import-e2e' });
    util.saveState(stSeed);
    syncOnce();
    check('ACCEPTANCE: after fix + cleanup + re-scan the project has zero imported-Codex sessions, genuine Codex intact', () => {
      const st = util.loadState();
      const evs = st.projects[p1key].events || [];
      assert.ok(!evs.some(e => e.source === 'Codex' && e.session === 'rollout-import-e2e'),
        'mislabeled imported session still present after cleanup');
      assert.ok(evs.some(e => e.source === 'Codex' && e.session === 'rollout-1'),
        'genuine Codex session was wrongly purged');
      assert.ok(!st.files[impFile] || (st.files[impFile].data || {}).foreign,
        'imported file is neither reset nor marked foreign');
    });
    syncOnce(); // re-scan: the reset offsets re-read the import file from 0
    check('ACCEPTANCE: a re-scan does not re-introduce the mislabeled sessions as Codex', () => {
      const st = util.loadState();
      const evs = st.projects[p1key].events || [];
      assert.ok(!evs.some(e => e.source === 'Codex' && e.session === 'rollout-import-e2e'),
        're-scan re-ingested the imported file as Codex');
      assert.ok((st.files[impFile] && st.files[impFile].data || {}).foreign,
        'rescanned import file not marked foreign in fileState');
    });
  }
  // A project whose ONLY events were mislabeled (the real outer-dir case) is
  // purged to empty — its already-injected context block must still be
  // REWRITTEN clean, not skipped by the events-empty render guard, and dirty
  // must clear rather than leak true forever.
  {
    const projX = path.join(ROOT, 'projects', 'outer-shell');
    fs.mkdirSync(path.join(projX, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(projX, 'CLAUDE.md'),
      '# Outer shell\n\n' + digest.BEGIN + '\n- 2026-07-18 23:08 · Codex: polluted mislabeled ask\n' + digest.END + '\n');
    const impDir2 = path.join(process.env.MEMBRIDGE_CODEX_DIR, '2026', '07', '18');
    const impFile2 = path.join(impDir2, 'rollout-import-outer.jsonl');
    fs.writeFileSync(impFile2, jsonl([
      { timestamp: '2026-07-18T23:08:44.000Z', type: 'session_meta', payload: { id: 'imp-outer', cwd: projX, originator: 'Claude Cowork', history_mode: 'legacy' } },
      { timestamp: '2026-07-18T23:08:44.100Z', type: 'event_msg', payload: { type: 'user_message', message: 'polluted mislabeled ask' } },
    ]));
    const stSeed2 = util.loadState();
    stSeed2.files[impFile2] = { offset: fs.statSync(impFile2).size, adapter: 'codex', data: { cwd: projX } };
    stSeed2.projects[projX] = { events: [
      { ts: '2026-07-18T23:08:44.100Z', project: projX, source: 'Codex', kind: 'prompt', text: 'polluted mislabeled ask', session: 'rollout-import-outer' },
    ] };
    util.saveState(stSeed2);
    syncOnce();
    check('cleanup: a project purged to EMPTY still gets its polluted context block rewritten clean, dirty cleared', () => {
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => util.normPath(k) === util.normPath(projX));
      assert.ok(key, 'outer-shell project lost from state');
      assert.strictEqual((st.projects[key].events || []).length, 0, 'mislabeled event not purged');
      const md = read(path.join(projX, 'CLAUDE.md'));
      assert.ok(md.includes('# Outer shell'), 'original content lost');
      assert.ok(md.includes(digest.BEGIN), 'block markers lost');
      assert.ok(!md.includes('polluted mislabeled ask'), 'purged Codex ask still injected in CLAUDE.md');
      assert.ok(!st.projects[key].dirty, 'dirty flag leaked true on the purged-to-empty project');
    });
  }
  check('cleanup default reader: a blank first line does not stall the verdict (file still judged from its first real line)', () => {
    const scanMod = require('../lib/scan');
    const blankDir = path.join(ROOT, 'codex-blankline');
    fs.mkdirSync(blankDir, { recursive: true });
    const blankFile = path.join(blankDir, 'rollout-blank-first.jsonl');
    fs.writeFileSync(blankFile,
      '\n' + JSON.stringify({ timestamp: '2026-07-18T23:08:45.000Z', type: 'session_meta', payload: { id: 'b1', cwd: proj1, originator: 'Claude Cowork', history_mode: 'legacy' } }) + '\n');
    const st = {
      files: { [blankFile]: { offset: 10, adapter: 'codex', data: {} } },
      projects: { [proj1]: { events: [
        { ts: '2026-07-18T23:08:45.000Z', project: proj1, source: 'Codex', kind: 'prompt', text: 'x', session: 'rollout-blank-first' },
      ] } },
    };
    const purged = scanMod.cleanupCodexMislabels(st); // default disk reader
    assert.deepStrictEqual(purged, ['rollout-blank-first'], 'blank-first-line import file was not judged');
    assert.strictEqual(st.projects[proj1].events.length, 0, 'its mislabeled event survived');
  });
  check('projectStats: week-windowed sessions, distinct files, deduped open todos', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const iso = d => new Date(now - d * 86400000).toISOString();
    const proj = { events: [
      { kind: 'prompt', source: 'Claude Code', session: 's1', ts: iso(1), text: 'a' },
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(proj1, 'src/login.js') },
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(proj1, 'src/login.js') }, // dup file
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(proj1, 'src/api.js') },
      { kind: 'edit', source: 'Claude Code', session: 's1', ts: iso(1), file: path.join(ROOT, 'scratch.js') }, // outside project -> dropped
      { kind: 'todos', session: 's1', ts: iso(1), items: [ { text: 'x', status: 'completed' }, { text: 'y', status: 'pending' } ] },
      { kind: 'todos', session: 's1', ts: iso(0.5), items: [ { text: 'x', status: 'completed' }, { text: 'y', status: 'in_progress' }, { text: 'z', status: 'pending' } ] }, // later snapshot -> 2 open
      { kind: 'prompt', source: 'Codex', session: 's2', ts: iso(2), text: 'b' },
      { kind: 'todos', session: 's2', ts: iso(2), items: [ { text: 'q', status: 'pending' } ] }, // 1 open
      { kind: 'prompt', source: 'Claude Code', session: 's3', ts: iso(10), text: 'old' }, // outside 7d window
      { kind: 'edit', source: 'Claude Code', session: 's3', ts: iso(10), file: path.join(proj1, 'src/old.js') }, // still counts (files are all-time)
    ] };
    const stats = memorydb.projectStats(proj1, proj, now);
    assert.strictEqual(stats.sessionsThisWeek, 2, `sessions ${stats.sessionsThisWeek}`); // s1, s2 in window; s3 excluded
    assert.strictEqual(stats.filesTouched, 3, `files ${stats.filesTouched}`); // login, api, old (scratch dropped)
    assert.strictEqual(stats.openTodos, 3, `open ${stats.openTodos}`); // s1 latest snapshot = 2 open, s2 = 1 open
  });
  check('relativeLabel: coarse buckets with injectable now', () => {
    const now = Date.parse('2026-07-14T12:00:00.000Z');
    const iso = d => new Date(now - d * 86400000).toISOString();
    assert.strictEqual(digest.relativeLabel(iso(0), now), 'today');
    assert.strictEqual(digest.relativeLabel(iso(1), now), 'yesterday');
    assert.strictEqual(digest.relativeLabel(iso(3), now), '3 days ago');
    assert.strictEqual(digest.relativeLabel(null, now), 'no activity yet');
  });
  check('changes: git status + numstat → grouped model', () => {
    const runGit = args => {
      if (args[0] === 'status') return '?? lib/mcp.js\n M bin/membridge.js\n D old.js\n';
      if (args[0] === 'diff') return '312\t0\tlib/mcp.js\n28\t4\tbin/membridge.js\n0\t9\told.js\n';
      return '';
    };
    const out = changesLib.deriveChanges('/repo',
      ['bin/membridge.js', 'lib/mcp.js', 'old.js', 'package.json'],
      [{ file: 'lib/mcp.js', note: 'the MCP server' }],
      { runGit });
    // order: new, edited, deleted, then deps last
    assert.deepStrictEqual(out.map(c => c.file), ['lib/mcp.js', 'bin/membridge.js', 'old.js', 'package.json']);
    assert.strictEqual(out[0].status, 'new');
    assert.strictEqual(out[0].add, 312);
    assert.strictEqual(out[0].note, 'the MCP server');
    assert.strictEqual(out[1].status, 'edited');
    assert.strictEqual(out[2].status, 'deleted');
    assert.strictEqual(out[3].dep, true);
    assert.strictEqual(out[3].add, null); // deps: counts suppressed
  });
  check('changes: git failure degrades to filename-only', () => {
    const runGit = () => { throw new Error('not a git repo'); };
    const out = changesLib.deriveChanges('/repo', ['lib/a.js', 'package.json'], [], { runGit });
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].status, 'edited');
    assert.strictEqual(out[0].add, null);
    assert.strictEqual(out[1].dep, true);
  });
  check('changes: quoted spaced paths classify correctly', () => {
    const runGit = args => {
      if (args[0] === 'status') return '?? "new doc.md"\n D "sub/old file.txt"\n';
      return ''; // no numstat rows
    };
    const out = changesLib.deriveChanges('/repo', ['new doc.md', 'sub/old file.txt'], [], { runGit });
    const byFile = Object.fromEntries(out.map(c => [c.file, c.status]));
    assert.strictEqual(byFile['new doc.md'], 'new');
    assert.strictEqual(byFile['sub/old file.txt'], 'deleted');
  });
  check('changes: rename attributes destination status', () => {
    const runGit = args => {
      if (args[0] === 'status') return 'R  old.js -> src/new.js\n';
      if (args[0] === 'diff') return '5\t2\t{old.js => src/new.js}\n';
      return '';
    };
    const out = changesLib.deriveChanges('/repo', ['src/new.js'], [], { runGit });
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, 'src/new.js');
    // rename dest present in status map (not the compound "old.js -> src/new.js" key)
    assert.strictEqual(out[0].status, 'edited');
    assert.strictEqual(out[0].add, null); // rename counts are best-effort null
  });
  // Stubs cp.execFileSync itself (lib/changes.js calls it via the module
  // object, not a destructured const, exactly so it can be swapped here) —
  // proves what defaultRunGit passes to the subprocess call without needing
  // a real spawnable fake `git`, whose shape (shebang script vs. PE exe) is
  // not portable across POSIX and Windows.
  const cp = require('child_process');
  function withStubExecFileSync(stub, fn) {
    const real = cp.execFileSync;
    cp.execFileSync = stub;
    try { return fn(); } finally { cp.execFileSync = real; }
  }
  check('changes: defaultRunGit hardens env (no terminal prompt, no optional locks)', () => {
    let seenEnv = null;
    withStubExecFileSync((file, args, opts) => { seenEnv = opts.env; return 'ok'; }, () => {
      changesLib.defaultRunGit('/repo')(['status']);
    });
    assert.ok(seenEnv, 'execFileSync was not called');
    assert.strictEqual(seenEnv.GIT_TERMINAL_PROMPT, '0', 'GIT_TERMINAL_PROMPT not hardened');
    assert.strictEqual(seenEnv.GIT_OPTIONAL_LOCKS, '0', 'GIT_OPTIONAL_LOCKS not hardened');
  });
  check('changes: defaultRunGit still throws on nonzero exit (contract preserved for callers)', () => {
    withStubExecFileSync(() => { throw Object.assign(new Error('Command failed'), { status: 1 }); }, () => {
      assert.throws(() => changesLib.defaultRunGit('/repo')(['status']), 'nonzero exit should still throw');
    });
  });
  check('changes: defaultRunGit is bounded — a blocked git is killed within the timeout, not hung', () => {
    let seenOpts = null;
    withStubExecFileSync((file, args, opts) => {
      seenOpts = opts;
      throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGKILL' });
    }, () => {
      assert.throws(() => changesLib.defaultRunGit('/repo')(['status']), /ETIMEDOUT|SIGKILL/);
    });
    assert.strictEqual(seenOpts.timeout, 5000, 'timeout not set to 5s');
    assert.strictEqual(seenOpts.killSignal, 'SIGKILL', 'killSignal not set');
  });
  check('projectDetail: a teammate touch drives team-aware lastTouched + activeLabel + stats', () => {
    const state = util.loadState();
    const key = Object.keys(state.projects).find(k => path.basename(k) === 'shop-app');
    const proj = state.projects[key];
    const localLast = proj.events[proj.events.length - 1].ts;
    const saved = proj.teamEntries;
    const future = '2999-01-01T00:00:00.000Z';
    proj.teamEntries = [{ author: 'Andrew', ts: future, source: 'Codex', ask: 'teammate touch', files: [] }];
    util.saveState(state);
    const det = projectDetail(proj1);
    assert.strictEqual(det.lastTouched, future, `lastTouched ${det.lastTouched} (localLast ${localLast})`);
    assert.strictEqual(det.lastActivity, localLast, 'lastActivity should stay local-only');
    assert.ok(det.stats && typeof det.stats.filesTouched === 'number', 'stats row missing');
    assert.strictEqual(typeof det.activeLabel, 'string', 'activeLabel missing');
    assert.ok(det.activeLabel.length > 0, 'activeLabel empty');
    // restore original state for downstream tests
    const st2 = util.loadState();
    st2.projects[key].teamEntries = saved;
    util.saveState(st2);
  });
  check('perf(deferChanges): deferred derivation equals the inline change model', () => {
    // The feed + project-page hot paths call buildEntries with deferChanges to
    // skip the per-entry git subprocess storm, then derive changes only for the
    // entries they show. Prove that deferred derivation is byte-identical to the
    // old inline path, so the speedup changes nothing a teammate sees.
    const config = util.getConfig();
    const digestLib = require('../lib/digest');
    const key = path.join(ROOT, 'projects', 'defer-app');
    const ago = sec => new Date(Date.now() - sec * 1000).toISOString();
    const proj = {
      events: [
        { ts: ago(30), source: 'Claude Code', kind: 'prompt', session: 'ds1', text: 'do the thing' },
        { ts: ago(20), source: 'Claude Code', kind: 'edit', session: 'ds1', file: path.join(key, 'src', 'a.js') },
        { ts: ago(10), source: 'Distilled', kind: 'summary', session: 'ds1', text: 'Did the thing.',
          goal: 'g', decisions: '', gotchas: '', highlights: [{ file: 'src/a.js', note: 'touched a.js' }] },
      ],
    };
    const inline = memorydb.buildEntries(key, JSON.parse(JSON.stringify(proj)), config);
    const deferred = memorydb.buildEntries(key, JSON.parse(JSON.stringify(proj)), config, { deferChanges: true });
    const inlineEntry = inline.find(e => Array.isArray(e.changes) && e.changes.length);
    assert.ok(inlineEntry, 'inline path should produce a change model to compare against');
    const deferredEntry = deferred.find(e => e.session === inlineEntry.session && e._highlights);
    assert.ok(deferredEntry, 'deferred path should keep _highlights instead of deriving inline');
    assert.ok(!Array.isArray(deferredEntry.changes) || !deferredEntry.changes.length, 'deferred path must not derive changes inline');
    const derived = memorydb.deriveEntryChanges(key, deferredEntry.files, deferredEntry._highlights, digestLib.compileRedactions(config));
    assert.deepStrictEqual(derived, inlineEntry.changes, 'deferred derivation must equal the inline change model');
  });
  check('planPayload: recentAsks merges + dedupes teammate teamEntries, sorted, capped at 20', () => {
    const config = util.getConfig();
    const proj = {
      events: [{ kind: 'prompt', source: 'Claude Code', session: 's1', ts: '2026-07-10T09:00:00.000Z', text: 'Local ask one' }],
      teamEntries: [
        { author: 'Andrew', ts: '2026-07-11T09:00:00.000Z', source: 'Codex', ask: 'Teammate refactor', files: ['src/api.js'] },
        { author: 'Andrew', ts: '2026-07-11T09:00:00.000Z', source: 'Codex', ask: 'Teammate refactor', files: ['src/api.js'] }, // exact dup
      ],
    };
    const payload = planPayload(proj1, proj, config, 'ship it');
    const asks = payload.recentAsks.map(e => e.ask);
    assert.ok(asks.includes('Local ask one'), 'local ask dropped');
    assert.ok(asks.includes('Teammate refactor'), 'teammate ask not folded in');
    assert.strictEqual(asks.filter(a => a === 'Teammate refactor').length, 1, 'teammate ask not deduped');
    assert.ok(payload.recentAsks.length <= 20, 'not capped at 20');
    const iLocal = payload.recentAsks.findIndex(e => e.ask === 'Local ask one');
    const iTeam = payload.recentAsks.findIndex(e => e.ask === 'Teammate refactor');
    assert.ok(iLocal !== -1 && iTeam !== -1 && iLocal < iTeam, 'recentAsks not sorted oldest-first by ts');
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

  // --- 4. session ids, state migration ---
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
  // rescan of every transcript from byte 0 on the next sync. The remove step
  // above untracked proj1 on disk, and a discarded state has no project keys,
  // so re-track proj1 first (as the dashboard "add" would) — the ingestion
  // gate only rebuilds projects that are still tracked.
  fs.mkdirSync(path.join(proj1, '.membridge'), { recursive: true });
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

  // --- 4a. scan: re-home events launched from a parent dir into the tracked
  // child project. proj1 is already tracked at this point (backfill above
  // recreated its .membridge), and the "remove" step right below wipes the
  // on-disk artifacts again without touching state history, so this leaves
  // the clean slate the daemon section (5.) expects intact.
  check('scan: session edits re-home to the tracked project, not the launch cwd', () => {
    const parent = path.dirname(proj1);
    const sessDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-rehome');
    fs.mkdirSync(sessDir, { recursive: true });
    fs.writeFileSync(path.join(sessDir, 'rehome1.jsonl'), jsonl([
      { type: 'user', message: { role: 'user', content: 'edit the login file' }, cwd: parent, timestamp: '2026-07-16T12:00:00.000Z' },
      { type: 'assistant', message: { role: 'assistant', content: [
        { type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: parent, timestamp: '2026-07-16T12:00:01.000Z' },
    ]));
    fs.mkdirSync(path.join(proj1, '.membridge'), { recursive: true });
    syncOnce();
    const state = util.loadState();
    const proj1Events = (state.projects[proj1] || { events: [] }).events;
    assert.ok(proj1Events.some(e => e.kind === 'edit' && e.session === 'rehome1'), 'edit filed under proj1');
    const parentEvents = (state.projects[parent] || { events: [] }).events;
    assert.ok(!parentEvents.some(e => e.session === 'rehome1'), 'nothing filed under the parent cwd');
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

  // --- 4b. extra targets: opt-in injection into Gemini/Cursor/Windsurf/Copilot ---
  const projX = path.join(ROOT, 'projects', 'multi-tool-app');
  fs.mkdirSync(path.join(projX, '.membridge'), { recursive: true }); // tracked, so the gate ingests it
  const xtDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-multi-tool-app');
  fs.mkdirSync(xtDir, { recursive: true });
  fs.writeFileSync(path.join(xtDir, 'sessX.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Wire up the search index' }, cwd: projX, timestamp: '2026-07-13T09:00:00.000Z' },
  ]));
  syncOnce();
  const geminiMd = () => read(path.join(projX, 'GEMINI.md'));
  const cursorMdc = () => read(path.join(projX, '.cursor', 'rules', 'membridge.mdc'));
  const windsurfRules = () => read(path.join(projX, '.windsurfrules'));
  const copilotMd = () => read(path.join(projX, '.github', 'copilot-instructions.md'));

  check('extra targets: defaults (opt-out) leave Gemini/Cursor/Windsurf/Copilot files uncreated', () => {
    assert.ok(fs.existsSync(path.join(projX, 'CLAUDE.md')), 'default CLAUDE.md missing');
    assert.ok(fs.existsSync(path.join(projX, 'AGENTS.md')), 'default AGENTS.md missing');
    assert.ok(!fs.existsSync(path.join(projX, 'GEMINI.md')), 'GEMINI.md created while opted out');
    assert.ok(!fs.existsSync(path.join(projX, '.cursor')), '.cursor dir created while opted out');
    assert.ok(!fs.existsSync(path.join(projX, '.windsurfrules')), '.windsurfrules created while opted out');
    assert.ok(!fs.existsSync(path.join(projX, '.github')), '.github dir created while opted out');
  });

  { const rc = util.loadUserConfig(); rc.extraTargets = { gemini: true, cursor: true, windsurf: true, copilot: true }; util.saveUserConfig(rc); }
  syncOnce({ project: projX });

  check('extra targets: enabling writes the marked block into each new target, creating parent dirs', () => {
    assert.ok(geminiMd().includes(digest.BEGIN) && geminiMd().includes(digest.END), 'GEMINI.md missing markers');
    assert.ok(geminiMd().includes('Wire up the search index'), 'GEMINI.md missing prompt');
    assert.ok(windsurfRules().includes(digest.BEGIN) && windsurfRules().includes(digest.END), '.windsurfrules missing markers');
    assert.ok(copilotMd().includes(digest.BEGIN) && copilotMd().includes(digest.END), 'copilot-instructions.md missing markers');
    assert.ok(fs.existsSync(path.join(projX, '.github')), '.github dir not created');
    const cursor = cursorMdc();
    assert.ok(cursor.startsWith('---\ndescription:'), 'cursor .mdc missing frontmatter as the literal first bytes');
    assert.ok(cursor.includes('alwaysApply: true'), 'cursor frontmatter missing alwaysApply');
    assert.ok(cursor.includes(digest.BEGIN) && cursor.includes(digest.END), 'cursor .mdc missing markers');
    assert.ok(fs.existsSync(path.join(projX, '.cursor', 'rules')), '.cursor/rules dir not created');
  });

  check('extra targets: re-sync is idempotent — one block, one frontmatter, no duplicates', () => {
    syncOnce({ project: projX });
    assert.strictEqual(count(geminiMd(), digest.BEGIN), 1, 'GEMINI.md block duplicated');
    assert.strictEqual(count(windsurfRules(), digest.BEGIN), 1, '.windsurfrules block duplicated');
    assert.strictEqual(count(copilotMd(), digest.BEGIN), 1, 'copilot-instructions.md block duplicated');
    const cursor = cursorMdc();
    assert.strictEqual(count(cursor, digest.BEGIN), 1, 'cursor .mdc block duplicated');
    assert.strictEqual(count(cursor, '---\ndescription:'), 1, 'cursor frontmatter duplicated');
  });

  check('extra targets: remove strips every target and cleans up dirs it created', () => {
    const out = spawnSync(process.execPath, [BIN, 'remove', '--project', projX], { encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.ok(!fs.existsSync(path.join(projX, 'CLAUDE.md')), 'block-only CLAUDE.md should be deleted');
    assert.ok(!fs.existsSync(path.join(projX, 'AGENTS.md')), 'block-only AGENTS.md should be deleted');
    assert.ok(!fs.existsSync(path.join(projX, 'GEMINI.md')), 'GEMINI.md not deleted');
    assert.ok(!fs.existsSync(path.join(projX, '.windsurfrules')), '.windsurfrules not deleted');
    assert.ok(!fs.existsSync(path.join(projX, '.github')), '.github dir not cleaned up');
    assert.ok(!fs.existsSync(path.join(projX, '.cursor')), '.cursor dir not cleaned up (frontmatter-only mdc should count as MemBridge-owned)');
  });

  // Reset extraTargets to the shipped defaults so the rest of the suite
  // (which shares this same MEMBRIDGE_HOME config) behaves exactly as before.
  { const rc = util.loadUserConfig(); rc.extraTargets = { gemini: false, cursor: false, windsurf: false, copilot: false }; util.saveUserConfig(rc); }

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
  let lastBriefingRequest = null;
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
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed.output_config) {
          // Roadmap request: structured JSON plan.
          lastPlanRequest = parsed;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: parsed.model,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(CANNED_PLAN) }],
            usage: { input_tokens: 4200, output_tokens: 900 },
          }));
        } else {
          // Briefing request: free-form prose.
          lastBriefingRequest = parsed;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            model: parsed.model,
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'Andrew wired the receipt PDF; Dana added refund guardrails.' }],
            usage: { input_tokens: 500, output_tokens: 60 },
          }));
        }
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
    // The dashboard needs a visible E2E signal (the whole point of "how does a
    // user SEE encryption is on"). statusPayload surfaces the state the header
    // badge renders: enabled (default-on unless the explicit hatch), whether
    // sync is paused fail-closed, and any outstanding key alerts. Asserted
    // in-process (not over HTTP) so a stale daemon squatting the test port
    // can't mask the new fields — see the port-squat memory.
    check('statusPayload surfaces encryption state for the header badge', () => {
      const enc = statusPayload().encryption;
      assert.ok(enc && typeof enc === 'object', 'encryption block missing');
      // This home runs the encrypt:false legacy hatch (setupFixtures).
      assert.strictEqual(enc.enabled, false, 'legacy hatch home must report encryption disabled');
      assert.strictEqual(enc.paused, null, 'no pause expected');
      assert.strictEqual(enc.keyAlerts, 0, 'no key alerts expected');
      assert.strictEqual(typeof enc.plaintextOff, 'boolean', 'plaintextOff must be present');
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
    check('dashboard page has the simplified three-route shell', () => {
      assert.ok(pageHtml.includes('id="view-home"'), 'home feed view missing');
      assert.ok(pageHtml.includes('id="goHome"'), 'home logo button missing');
      assert.ok(pageHtml.includes('id="openInvite"'), 'invite button missing');
      assert.ok(pageHtml.includes("return 'home'"), 'home default route missing');
      assert.ok(!pageHtml.includes('id="tab-overview"'), 'obsolete overview tab still present');
      assert.ok(!pageHtml.includes('id="tab-neural"'), 'obsolete neural map tab still present');
    });
    check('dashboard page has the account gate and Settings team management', () => {
      assert.ok(pageHtml.includes('view-auth'), 'account gate missing');
      assert.ok(pageHtml.includes("path = '/api/team/' + kind"), 'account auth flow missing');
      assert.ok(pageHtml.includes('/api/team/create'), 'team creation UI missing');
      assert.ok(pageHtml.includes('/api/team/link'), 'project linking UI missing');
      assert.ok(pageHtml.includes('/api/team/revoke-invite'), 'invite revoke UI missing');
      assert.ok(pageHtml.includes('Click again to confirm'), 'destructive-action arming missing');
      assert.ok(pageHtml.includes('data-team-form="invite-create"'), 'invite options form missing');
      assert.ok(pageHtml.includes('expiresDays'), 'invite expiry field missing');
      assert.ok(pageHtml.includes('maxUses'), 'invite max-uses field missing');
      assert.ok(pageHtml.includes("return 'auth'"), 'protected-route gate missing');
      // v3: team management lives on the dedicated Team screen (Settings keeps
      // only a compact card that links there). The team switcher moved with it.
      assert.ok(pageHtml.includes('id="teamScreen"'), 'Team screen container missing');
      assert.ok(pageHtml.includes('data-ts-switch'), 'team switcher missing');
      assert.ok(pageHtml.includes('/api/team/members'), 'members wiring missing');
      assert.ok(!pageHtml.includes('view-team'), 'dead team hub container still present');
      assert.ok(!pageHtml.includes('#team-member='), 'dead member drill-down route still present');
      assert.ok(!pageHtml.includes('#team-project='), 'dead team-project route still present');
    });
    check('dashboard page has a persisted three-way theme', () => {
      assert.ok(pageHtml.includes('body[data-theme="dark"]'), 'dark theme token block missing');
      assert.ok(pageHtml.includes('prefers-color-scheme: dark'), 'system theme fallback missing');
      assert.ok(pageHtml.includes("localStorage.getItem('mb-theme')"), 'theme boot script missing');
    });
    check('dashboard page has the Copy for AI button', () => {
      assert.ok(pageHtml.includes('Copy for AI'), 'Copy for AI button missing');
    });
    check('dashboard page has the project view', () => {
      assert.ok(pageHtml.includes('view-project'), 'project view missing');
    });
    check('dashboard ⋯ project menu dismisses on outside click and Escape', () => {
      assert.ok(embeddedScript.includes('data-px-menu-pop'), 'menu popover marker missing');
      assert.ok(embeddedScript.includes("closest('[data-px-menu-pop]')"), 'outside-click dismiss check missing');
      assert.ok(/Escape[\s\S]{0,600}pxMenuId = null/.test(embeddedScript), 'Escape-key menu dismiss missing');
    });
    check('dashboard Settings screen renders without the BYOK/advisor-key UI', () => {
      assert.ok(pageHtml.includes('view-settings'), 'settings view missing');
      assert.ok(pageHtml.includes('id="settingsRoot"'), 'settings host missing');
      assert.ok(pageHtml.includes('Watched projects'), 'watched projects section missing');
      assert.ok(pageHtml.includes('Tools detected: '), 'tools-detected line missing');
      // The BYOK advisor-key UI was removed from the dashboard Settings screen
      // (the /api/advisor backend is retained and covered separately). The
      // Settings screen must no longer surface any key-entry affordance.
      assert.ok(!pageHtml.includes('AI briefings &amp; roadmaps'), 'BYOK section should be gone');
      assert.ok(!pageHtml.includes('Bring your own key'), 'BYOK copy should be gone');
      assert.ok(!pageHtml.includes('data-adv-key'), 'advisor key input should be gone');
    });
    check('dashboard page has multi-select + bulk delete for local watched projects', () => {
      assert.ok(embeddedScript.includes('data-bulk-check='), 'per-row bulk checkbox missing');
      assert.ok(embeddedScript.includes('data-bulk-selectall'), '"select all local" control missing');
      assert.ok(embeddedScript.includes('data-bulk-delete'), 'delete-selected affordance missing');
      assert.ok(embeddedScript.includes("This can't be undone."), 'bulk-delete confirm copy missing');
      // Local-only gating: the checkbox markup must be emitted from a branch keyed
      // off "not a team project" (the same field the shared/local-only badge
      // uses) so shared rows never get a bulk checkbox.
      assert.ok(/isLocal\s*=\s*!p\.team/.test(embeddedScript), 'checkbox gating is not keyed off p.team (local vs shared)');
    });
    // deleteProjectsBulk is a pure, injected-fetch helper (house style: offline
    // testable, no DOM). Extract it from the embedded script by brace-matching
    // and exercise it directly, mirroring how the rest of the app is tested.
    function extractFn(src, name) {
      const startIdx = src.indexOf('function ' + name + '(');
      if (startIdx === -1) return null;
      let i = src.indexOf('{', startIdx);
      let depth = 0, end = i;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') { depth--; if (depth === 0) { end++; break; } }
      }
      return src.slice(startIdx, end);
    }
    // esc is declared as `var esc = function (s) { ... };`, not a `function
    // esc(` declaration, so extractFn's pattern can't find it. Card-headline
    // sandbox tests below need esc's real source (runHeadline calls it), so
    // brace-match the var-assignment form separately.
    function extractVarFn(src, name) {
      const startIdx = src.indexOf('var ' + name + ' = function');
      if (startIdx === -1) return null;
      let i = src.indexOf('{', startIdx);
      let depth = 0, end = i;
      for (; end < src.length; end++) {
        if (src[end] === '{') depth++;
        else if (src[end] === '}') { depth--; if (depth === 0) { end++; break; } }
      }
      return src.slice(startIdx, end) + ';';
    }
    // Card-headline helpers (firstSentence / askHeadline / runHeadline) are pure
    // client functions with no DOM dependency — extract their source from the
    // embedded script and evaluate them in a sandbox, same technique as
    // deleteProjectsBulk above. See specs/2026-07-20-activity-display-headline.
    check('headline helpers: firstSentence / askHeadline behavior', () => {
      const src = ['esc', 'capLine', 'firstSentence', 'askHeadline'].map(n => extractFn(embeddedScript, n)).join('\n');
      const sandbox = new Function(src + '\nreturn { capLine: capLine, firstSentence: firstSentence, askHeadline: askHeadline };')();
      assert.strictEqual(sandbox.firstSentence('One thing. Two thing.'), 'One thing.');
      assert.strictEqual(sandbox.firstSentence(''), '');
      assert.ok(sandbox.firstSentence('x'.repeat(200)).length <= 92, 'not capped');
      // capLine: at-cap lines pass verbatim; over-cap lines end in an ellipsis.
      assert.strictEqual(sandbox.capLine('y'.repeat(90)), 'y'.repeat(90), 'at-cap line must pass untouched');
      const overCap = sandbox.capLine('y'.repeat(91));
      assert.ok(overCap.length <= 90 && overCap.endsWith('…'), 'over-cap line not capped with ellipsis');
      assert.strictEqual(sandbox.askHeadline(''), null);
      assert.strictEqual(sandbox.askHeadline('Add a logout button'), 'Add a logout button');
      assert.strictEqual(sandbox.askHeadline('Install failed: Error at /x lockdownd\n\n\nstack'), null, 'noisy ask not degraded');
    });
    check('headline helpers: runHeadline behavior', () => {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const fnSrc = ['capLine', 'firstSentence', 'askHeadline', 'runHeadline'].map(n => extractFn(embeddedScript, n)).join('\n');
      const sandbox = new Function(escSrc + '\n' + fnSrc + '\nreturn { runHeadline: runHeadline };')();
      // Distilled rep WITH a headline wins outright, and is escaped.
      assert.strictEqual(
        sandbox.runHeadline({ headline: 'Fixed the <bug>', summary: 'Long summary text. More.' }, null, false),
        'Fixed the &lt;bug&gt;'
      );
      // A capture-compliant headline (hooks.HEADLINE_MAX = 80 chars) renders
      // verbatim — even when it contains sentence punctuation.
      const compliant = ('Fixed sync. Codex sessions now visible to teammates. ' + 'x'.repeat(80)).slice(0, 80);
      assert.strictEqual(sandbox.runHeadline({ headline: compliant }, null, false), compliant, 'compliant headline altered');
      // A legacy over-long headline degrades at a word boundary with an
      // ellipsis instead of hitting the CSS clamp mid-word.
      const legacy = ('alpha bravo '.repeat(20)).trim();
      const capped = sandbox.runHeadline({ headline: legacy }, null, false);
      assert.ok(capped.endsWith('…'), 'legacy over-long headline not capped');
      assert.ok(capped.length <= 90, 'legacy cap exceeded');
      const stem = capped.slice(0, -1);
      assert.ok(legacy.startsWith(stem) && legacy[stem.length] === ' ', 'cap must land on a word boundary');
      // Distilled rep with NO headline falls back to the first sentence of the summary.
      assert.strictEqual(
        sandbox.runHeadline({ summary: 'Did the thing. And then some more.' }, null, false),
        'Did the thing.'
      );
      // No rep + live + clean ask -> guarded "Working on: <ask>".
      const liveClean = sandbox.runHeadline(null, { ask: 'Add a logout button' }, true);
      assert.ok(liveClean.includes('Working on:') && liveClean.includes('Add a logout button'), 'clean live ask not shown');
      // No rep + live + noisy ask -> "Working…", never the raw noisy ask.
      const liveNoisy = sandbox.runHeadline(null, { ask: 'Install failed: Error at /x lockdownd\n\n\nstack' }, true);
      assert.ok(liveNoisy.includes('Working…'), 'noisy live ask not guarded to Working…');
      assert.ok(!liveNoisy.includes('lockdownd'), 'noisy live ask text leaked through');
      // No rep + finished + no ask -> plain placeholder, never harvested prose.
      // runHeadline's signature is (rep, newest, live) — it has no repHarvested
      // parameter at all, so any harvested-looking data hanging off `newest`
      // cannot reach the headline; this proves the finished branch ignores it.
      const finished = sandbox.runHeadline(null, { ask: '', repHarvested: { summary: 'HARVESTED PROSE' } }, false);
      assert.ok(finished.includes('session ended') && finished.includes('no summary shared'), 'finished no-ask placeholder missing');
      assert.ok(!finished.includes('HARVESTED PROSE'), 'harvested text leaked into the headline');
    });
    // Activity feed rolling window + View more: page one always covers the
    // last FEED_WINDOW_HOURS (24h), older history pages in on demand. The
    // button HTML is a pure helper (feedMoreHtml) — sandbox it like the other
    // pure client fns; the async fetch/render wiring is asserted by grep.
    check('dashboard Activity feed: 24h window param + View more wiring', () => {
      assert.ok(/FEED_WINDOW_HOURS\s*=\s*24/.test(embeddedScript), '24h window constant missing');
      assert.ok(embeddedScript.includes("'window=' + FEED_WINDOW_HOURS"), 'feedViewUrl must request the rolling window');
      assert.ok(embeddedScript.includes('function loadMoreFeed'), 'View more loader missing');
      assert.ok(embeddedScript.includes("closest('#feedMoreBtn')"), 'View more click delegation missing');
    });
    check('dashboard feedMoreHtml: View more renders only with a cursor', () => {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const fnSrc = extractFn(embeddedScript, 'feedMoreHtml');
      assert.ok(fnSrc, 'feedMoreHtml helper missing from the embedded script');
      const sandbox = new Function(escSrc + '\n' + fnSrc + '\nreturn { feedMoreHtml: feedMoreHtml };')();
      assert.ok(!/feedMoreBtn/.test(sandbox.feedMoreHtml(null)), 'no cursor must render no button');
      const html = sandbox.feedMoreHtml('2026-07-14T01:00:00Z');
      assert.ok(html.indexOf('id="feedMoreBtn"') !== -1, 'button id missing');
      assert.ok(html.indexOf('data-before="2026-07-14T01:00:00Z"') !== -1, 'cursor missing from the button');
      assert.ok(html.indexOf('View more') !== -1, 'View more label missing');
    });
    // Behavioral coverage for the client paging state machine: feedCombined's
    // dedupe/append, and the stale-response guard — a View more fetch that
    // resolves AFTER the filters/team context changed (resetFeedPaging ran)
    // must be dropped, or old-context entries leak into feedExtra forever.
    {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const fnSrc = ['feedKey', 'feedCombined', 'resetFeedPaging', 'loadMoreFeed']
        .map(n => extractFn(embeddedScript, n)).join('\n');
      const mkSandbox = new Function(
        escSrc +
        '\nvar feedBase = [], feedExtra = [], feedNextBefore = null, feedPageGen = 0;' +
        '\nvar setPill = function () {}; var renderFeed = function () {};' +
        '\nvar feedViewUrl = function () { return "/api/feed?limit=100&window=24"; };' +
        '\nvar document = { getElementById: function () { return null; } };' +
        '\nvar fetch = function () { throw new Error("fetch not stubbed"); };\n' +
        fnSrc +
        '\nreturn {' +
        ' state: function () { return { extra: feedExtra, next: feedNextBefore }; },' +
        ' setBase: function (b) { feedBase = b; },' +
        ' setNext: function (n) { feedNextBefore = n; },' +
        ' setFetch: function (f) { fetch = f; },' +
        ' feedCombined: feedCombined, resetFeedPaging: resetFeedPaging, loadMoreFeed: loadMoreFeed };');
      const entry = (ts, ask) => ({ project: 'p', projectId: null, projectPath: null, ts, ask });
      const btnFor = ts => ({ disabled: false, getAttribute: () => ts });
      const pageResponse = (entries, nextBefore) =>
        Promise.resolve({ json: () => Promise.resolve({ entries, nextBefore }) });

      // Happy path: an older page appends (deduped against the base) and
      // adopts the deeper cursor.
      const sHappy = mkSandbox();
      sHappy.setBase([entry('2026-07-14T05:00:00Z', 'new'), entry('2026-07-14T04:00:00Z', 'edge')]);
      sHappy.setNext('2026-07-14T04:00:00Z');
      sHappy.setFetch(() => pageResponse(
        [entry('2026-07-14T04:00:00Z', 'edge'), entry('2026-07-14T03:00:00Z', 'older')],
        '2026-07-14T03:00:00Z'));
      sHappy.loadMoreFeed(btnFor('2026-07-14T04:00:00Z'));
      await new Promise(r => setImmediate(r));
      check('dashboard feed paging: View more appends the deduped older page and keeps the deeper cursor', () => {
        const st = sHappy.state();
        assert.strictEqual(st.extra.length, 1, 'only the genuinely older entry is appended');
        assert.strictEqual(st.extra[0].ask, 'older');
        assert.strictEqual(st.next, '2026-07-14T03:00:00Z', 'cursor advanced to the deeper page tail');
        const combined = sHappy.feedCombined([entry('2026-07-14T05:00:00Z', 'new'), entry('2026-07-14T04:00:00Z', 'edge')]);
        assert.deepStrictEqual(combined.map(e => e.ask), ['new', 'edge', 'older'], 'combined render = base then extras');
      });

      // Stale response: the filter/team context changes (resetFeedPaging)
      // while the View more fetch is in flight — its response must be dropped.
      const sStale = mkSandbox();
      sStale.setBase([entry('2026-07-14T05:00:00Z', 'old-filter-base')]);
      let releaseStale;
      sStale.setFetch(() => new Promise(resolve => { releaseStale = resolve; }));
      sStale.loadMoreFeed(btnFor('2026-07-14T05:00:00Z'));
      sStale.resetFeedPaging(); // user changed filters mid-flight
      sStale.setBase([entry('2026-07-14T06:00:00Z', 'new-filter-base')]);
      releaseStale({ json: () => Promise.resolve({ entries: [entry('2026-07-14T02:00:00Z', 'stale-page')], nextBefore: '2026-07-14T02:00:00Z' }) });
      await new Promise(r => setImmediate(r));
      await new Promise(r => setImmediate(r));
      check('dashboard feed paging: a View more response landing after a context reset is dropped', () => {
        const st = sStale.state();
        assert.strictEqual(st.extra.length, 0, 'stale old-context page leaked into feedExtra');
        assert.strictEqual(st.next, null, 'stale cursor leaked into feedNextBefore');
      });
    }
    // Task 3 (specs/2026-07-20-activity-display-headline): threadHtml/unitHtml
    // must call runHeadline for their card headline instead of the old inline
    // three-way ternary that could fall back to repHarvested prose, the
    // headline div must 2-line-clamp, and the expander must carry the FULL
    // brief (summaryFull || summary) that the clamp pushed out of the headline.
    check('cards: headline uses runHeadline and never repHarvested; headline clamps; expander carries full brief', () => {
      const th = extractFn(embeddedScript, 'threadHtml');
      const uh = extractFn(embeddedScript, 'unitHtml');
      assert.ok(/runHeadline\(/.test(th) && /runHeadline\(/.test(uh), 'cards do not call runHeadline');
      assert.ok(!/repHarvested\)\s*\?/.test(th) && !/repHarvested\)\s*\?/.test(uh), 'repHarvested still in a headline ternary');
      assert.ok(/-webkit-line-clamp:2/.test(th), 'threadHtml headline is not 2-line clamped');
      assert.ok(/-webkit-line-clamp:2/.test(uh), 'unitHtml headline is not 2-line clamped');
      assert.ok(/summaryFull \|\| t\.rep\.summary/.test(th) || /t\.rep\.summaryFull \|\| t\.rep\.summary/.test(th), 'threadHtml expander missing full-brief fallback');
      assert.ok(/fd-label/.test(th) && /fd-label/.test(uh), 'expander missing a Summary label block');
      // The per-run agent-thread label inside unitHtml (the u.runs map, `rlabel`)
      // is a third headline/label site — same ban applies.
      assert.ok(!/r\.repHarvested\s*\?/.test(uh), 'per-run agent-thread label still falls back to r.repHarvested');
      // subagentLine (the one-line label for a subagent run shown in the
      // session detail page's per-prompt dropdown) is a fourth headline/label
      // site found by grepping repHarvested — it must route through
      // runHeadline too, never returning raw harvested prose.
      const sub = extractFn(embeddedScript, 'subagentLine');
      assert.ok(sub, 'subagentLine not found');
      assert.ok(/runHeadline\(/.test(sub), 'subagentLine does not call runHeadline');
      assert.ok(!/repHarvested/.test(sub), 'subagentLine still references repHarvested');
    });
    // buildDayCards (docs/superpowers/specs/2026-07-21-activity-day-drilldown-design.md, Task 1): groups
    // buildUnits' output into one card per (author, project, local day). Pure
    // client function, same extractFn+sandbox technique as the runHeadline
    // checks above. unitWith builds a fixture shaped like a real buildUnits/
    // finalizeUnit output (key, ts, author(Id), project(Id/Path), self, source,
    // agentCount, promptCount, rep [a run with its own .rep distilled entry, or
    // null], live, runs) so evalDayCards exercises the real grouping/rollup
    // logic, not a stub.
    const dayCardsNow = new Date();
    function dayCardsLocalTs(daysAgo, hour) {
      return new Date(dayCardsNow.getFullYear(), dayCardsNow.getMonth(), dayCardsNow.getDate() - daysAgo, hour, 0, 0).toISOString();
    }
    let dayCardsSeq = 0;
    function unitWith(overrides) {
      overrides = overrides || {};
      const id = dayCardsSeq++;
      const ts = overrides.ts !== undefined ? overrides.ts : dayCardsLocalTs(0, 10);
      const author = overrides.author !== undefined ? overrides.author : 'Marco';
      const authorId = overrides.authorId; // no default: exercises the author fallback in the key
      const project = overrides.project !== undefined ? overrides.project : 'ProjA';
      const projectId = overrides.projectId; // no default: exercises the project fallback in the key
      const projectPath = overrides.projectPath;
      const repEntry = Object.prototype.hasOwnProperty.call(overrides, 'repEntry') ? overrides.repEntry : null;
      // A harvested (non-distilled) summary entry, mirroring a thread's
      // t.repHarvested. One run carries both reps, exactly as finalizeUnit does.
      const harvestedEntry = Object.prototype.hasOwnProperty.call(overrides, 'harvestedEntry') ? overrides.harvestedEntry : null;
      const ask = overrides.ask !== undefined ? overrides.ask : 'Do the thing';
      const entry = { ts, ask, author, authorId };
      const run = { ts, key: 'run' + id, entries: [entry], rep: repEntry, repHarvested: harvestedEntry };
      return {
        key: 'unit' + id,
        ts,
        author, authorId,
        self: overrides.self !== undefined ? overrides.self : false,
        source: overrides.source !== undefined ? overrides.source : 'Claude Code',
        project, projectId, projectPath,
        agentCount: overrides.agentCount !== undefined ? overrides.agentCount : 1,
        promptCount: overrides.promptCount !== undefined ? overrides.promptCount : 1,
        rep: repEntry ? run : null,
        repHarvested: harvestedEntry ? run : null,
        live: overrides.live !== undefined ? overrides.live : false,
        runs: overrides.runs !== undefined ? overrides.runs : [run],
      };
    }
    function evalDayCards(units) {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const fnSrc = ['normKeyPart', 'homeDayLabel', 'capLine', 'firstSentence', 'askHeadline', 'runHeadline', 'buildDayCards']
        .map(n => extractFn(embeddedScript, n)).join('\n');
      const sandbox = new Function(escSrc + '\n' + fnSrc + '\nreturn { buildDayCards: buildDayCards };')();
      return sandbox.buildDayCards(units);
    }
    const uToday1 = unitWith({ ts: dayCardsLocalTs(0, 14) });
    const uToday2 = unitWith({ ts: dayCardsLocalTs(0, 9) });
    const uYesterday = unitWith({ ts: dayCardsLocalTs(1, 14) });
    const uMarco = unitWith({ author: 'Marco', ts: dayCardsLocalTs(0, 10) });
    const uAndrew = unitWith({ author: 'Andrew', ts: dayCardsLocalTs(0, 10) });
    const uMarcoOtherProj = unitWith({ author: 'Marco', project: 'ProjB', ts: dayCardsLocalTs(0, 10) });
    const liveUnit3prompts = unitWith({ promptCount: 3, agentCount: 2, live: true, ts: dayCardsLocalTs(0, 14) });
    const staleUnit2prompts = unitWith({ promptCount: 2, agentCount: 1, live: false, ts: dayCardsLocalTs(0, 9) });
    const big5PromptsDistilled = unitWith({ promptCount: 5, ts: dayCardsLocalTs(0, 14), repEntry: { headline: 'Shipped the big feature' } });
    big5PromptsDistilled.expectedHeadline = 'Shipped the big feature';
    const small2PromptsDistilled = unitWith({ promptCount: 2, ts: dayCardsLocalTs(0, 13), repEntry: { headline: 'Small fix' } });
    small2PromptsDistilled.expectedHeadline = 'Small fix';
    const tieOldDistilled = unitWith({ promptCount: 4, ts: dayCardsLocalTs(0, 9), repEntry: { headline: 'Older tie headline' } });
    tieOldDistilled.expectedHeadline = 'Older tie headline';
    const tieNewDistilled = unitWith({ promptCount: 4, ts: dayCardsLocalTs(0, 15), repEntry: { headline: 'Newer tie headline' } });
    tieNewDistilled.expectedHeadline = 'Newer tie headline';
    const liveNoRep = unitWith({ live: true, repEntry: null, ts: dayCardsLocalTs(0, 10) });
    const staleNoRep = unitWith({ live: false, repEntry: null, ts: dayCardsLocalTs(0, 9) });
    const staleNoRep2 = unitWith({ live: false, repEntry: null, ts: dayCardsLocalTs(0, 10) });
    check('dayCards: groups by author+project+local day, newest first', () => {
      // three units: marco/projA today x2, marco/projA yesterday x1
      const cards = evalDayCards([uToday1, uToday2, uYesterday]);
      assert.strictEqual(cards.length, 2);
      assert.strictEqual(cards[0].units.length, 2, 'today card holds both units');
      assert.ok(cards[0].ts >= cards[1].ts, 'newest day first');
    });
    check('dayCards: same day, different author or project -> separate cards', () => {
      const cards = evalDayCards([uMarco, uAndrew, uMarcoOtherProj]);
      assert.strictEqual(cards.length, 3);
    });
    check('dayCards: key normalization matches unitKeyOf (case/trim never splits)', () => {
      const cards = evalDayCards([unitWith({ author: 'Marco ' }), unitWith({ author: 'marco' })]);
      assert.strictEqual(cards.length, 1);
    });
    check('dayCards: counts sum and live ORs across units', () => {
      const c = evalDayCards([liveUnit3prompts, staleUnit2prompts])[0];
      assert.strictEqual(c.promptCount, 5);
      assert.strictEqual(c.sessionCount, liveUnit3prompts.agentCount + staleUnit2prompts.agentCount);
      assert.strictEqual(c.live, true);
    });
    check('dayCards: headline picks highest-promptCount distilled unit, tie -> newer', () => {
      assert.ok(evalDayCards([big5PromptsDistilled, small2PromptsDistilled])[0]
        .headline.includes(big5PromptsDistilled.expectedHeadline));
      assert.ok(evalDayCards([tieOldDistilled, tieNewDistilled])[0]
        .headline.includes(tieNewDistilled.expectedHeadline));
    });
    check('dayCards: no distilled rep -> live "Working…" / finished "N sessions · no summaries shared"', () => {
      assert.ok(/Working/.test(evalDayCards([liveNoRep])[0].headline));
      assert.ok(/no summaries shared/.test(evalDayCards([staleNoRep, staleNoRep2])[0].headline));
    });
    // Option B — teammate harvested fallback. A teammate's summary can never be
    // distilled locally (the distilled bit isn't propagated over team sync, and
    // even with Option A only re-pushed rows carry it), so a day card whose only
    // teammate summary is harvested must SHOW it, not fall through to "no
    // summaries shared". Scoped to non-self: your OWN harvested-only days keep
    // the strict distilled-only headline, so mid-session noise never surfaces.
    check('dayCards: teammate harvested-only summary shows on the card, not "no summaries shared"', () => {
      const teammate = unitWith({ self: false, ts: dayCardsLocalTs(0, 11), repEntry: null,
        harvestedEntry: { summary: 'Refactored the checkout validation path' } });
      const c = evalDayCards([teammate])[0];
      assert.ok(c.headline.includes('Refactored the checkout validation path'),
        `teammate harvested summary missing from headline: ${c.headline}`);
      assert.ok(!/no summaries shared/.test(c.headline), 'still fell through to the empty fallback');
    });
    check('dayCards: your OWN harvested-only summary still reads "no summaries shared"', () => {
      const mine = unitWith({ self: true, ts: dayCardsLocalTs(0, 11), repEntry: null,
        harvestedEntry: { summary: 'mid-session reasoning line, not a real brief' } });
      const c = evalDayCards([mine])[0];
      assert.ok(/no summaries shared/.test(c.headline),
        `self harvested summary must not surface on the day card: ${c.headline}`);
    });
    check('dayCards: distilled still beats harvested for a teammate, regardless of promptCount', () => {
      const harvestedBig = unitWith({ self: false, promptCount: 9, ts: dayCardsLocalTs(0, 15),
        repEntry: null, harvestedEntry: { summary: 'Noisy harvested tail line' } });
      const distilledSmall = unitWith({ self: false, promptCount: 2, ts: dayCardsLocalTs(0, 14),
        repEntry: { headline: 'Shipped the real thing' } });
      const c = evalDayCards([harvestedBig, distilledSmall])[0];
      assert.ok(c.headline.includes('Shipped the real thing'), `distilled should win: ${c.headline}`);
      assert.ok(!c.headline.includes('Noisy harvested tail line'), 'harvested leaked past a distilled rep');
    });
    check('dayCards v2: teammate harvested unit gets ✓ and its summary text in the checklist', () => {
      const teammate = unitWith({ self: false, ts: dayCardsLocalTs(0, 11), repEntry: null,
        harvestedEntry: { summary: 'Harvested outcome for the checklist row' } });
      const c = evalDayCards([teammate])[0];
      assert.strictEqual(c.checklist[0].glyph, '✓', 'a shared teammate summary should get the check glyph');
      assert.ok(c.checklist[0].text.includes('Harvested outcome for the checklist row'),
        `checklist row text missing the harvested summary: ${c.checklist[0].text}`);
    });
    check('dayCards: pure and total — empty input, bad ts never throw', () => {
      assert.deepStrictEqual(evalDayCards([]), []);
      assert.ok(evalDayCards([unitWith({ ts: 'not-a-date' })]).length === 1);
    });
    // The "All models shows only Claude" bug: buildUnits keyed a work unit on
    // author+project alone, so a Claude Code run and a Codex run in the same
    // burst collapsed into ONE unit that finalizeUnit then labeled by its
    // newest entry's tool — hiding the other tool on the unfiltered Activity
    // view until the Tool filter narrowed to it. unitKeyOf now includes the
    // tool; different tools never share a unit. (buildDayCards, by contrast,
    // intentionally keys WITHOUT the tool — FIX 1 — so a person's tools share
    // one day card, each surfaced as its own checklist row and tool badge.)
    function evalBuildUnits(entries) {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const fnSrc = ['normKeyPart', 'feedKey', 'threadKey', 'buildThreads', 'unitKeyOf', 'finalizeUnit', 'buildUnits']
        .map(n => extractFn(embeddedScript, n)).join('\n');
      const sandbox = new Function(
        'var STALE_GAP = 45 * 60 * 1000, BURST_GAP = 30 * 60 * 1000;\n' + escSrc + '\n' + fnSrc +
        '\nreturn { buildUnits: buildUnits, buildThreads: buildThreads };'
      )();
      return sandbox.buildUnits(sandbox.buildThreads(entries));
    }
    function rawEntry(overrides) {
      overrides = overrides || {};
      return {
        ts: overrides.ts, ask: overrides.ask !== undefined ? overrides.ask : '',
        author: overrides.author !== undefined ? overrides.author : 'You',
        authorId: overrides.authorId, self: overrides.self !== undefined ? overrides.self : true,
        source: overrides.source,
        project: overrides.project !== undefined ? overrides.project : 'ProjA',
        projectId: overrides.projectId, projectPath: overrides.projectPath,
        session: overrides.session,
        summary: overrides.summary, distilled: overrides.distilled,
      };
    }
    check('units: finalizeUnit carries a thread\'s harvested rep up to unit.repHarvested', () => {
      // The real render path (buildThreads -> buildUnits/finalizeUnit ->
      // buildDayCards) must expose a harvested summary at the unit level, or the
      // teammate fallback in buildDayCards has nothing to read.
      const units = evalBuildUnits([
        rawEntry({ ts: dayCardsLocalTs(0, 14), self: false, author: 'Andrew', source: 'Codex',
          session: 'ax-1', summary: 'Harvested outcome from Andrew', distilled: false }),
      ]);
      assert.strictEqual(units.length, 1);
      assert.ok(!units[0].rep, 'a non-distilled entry must not become the distilled rep');
      assert.ok(units[0].repHarvested && units[0].repHarvested.repHarvested,
        'finalizeUnit did not propagate the harvested rep to the unit');
      assert.strictEqual(units[0].repHarvested.repHarvested.summary, 'Harvested outcome from Andrew');
    });
    check('units: different tools in one author+project burst never merge (Claude != Codex)', () => {
      const t = dayCardsLocalTs(0, 14);
      const units = evalBuildUnits([
        rawEntry({ ts: t, source: 'Claude Code', session: 'cc-1' }),
        rawEntry({ ts: t, source: 'Codex', session: 'cx-1' }),
      ]);
      assert.strictEqual(units.length, 2, 'a Claude run and a Codex run in one burst must stay separate units');
      assert.deepStrictEqual(units.map(u => u.source).sort(), ['Claude Code', 'Codex']);
    });
    check('units: same tool in one burst still merges into a single unit', () => {
      const units = evalBuildUnits([
        rawEntry({ ts: dayCardsLocalTs(0, 14), source: 'Claude Code', session: 'cc-1' }),
        rawEntry({ ts: dayCardsLocalTs(0, 14), source: 'Claude Code', session: 'cc-2' }),
      ]);
      assert.strictEqual(units.length, 1, 'same author+project+tool within the burst window is one unit');
      assert.strictEqual(units[0].agentCount, 2, 'both runs roll up as agents inside the one unit');
    });
    // FIX 1 (auto/day-card-fixes): consolidate all of one person's tools for a
    // day into ONE card that carries every tool as a badge set and every tool's
    // work units in its checklist. Supersedes the earlier per-tool split
    // (commit 261fe74): units stay per-tool (so nothing is hidden — see the
    // buildUnits checks above), but the DAY CARD no longer keys on tool.
    check('dayCards: one card per author+project+day across all tools, carrying every tool as a badge set', () => {
      const claude = unitWith({ ts: dayCardsLocalTs(0, 14), source: 'Claude Code' });
      const codex = unitWith({ ts: dayCardsLocalTs(0, 10), source: 'Codex', live: true });
      const distilled = unitWith({ ts: dayCardsLocalTs(0, 12), source: 'Distilled', repEntry: { headline: 'Distilled outcome' } });
      const cards = evalDayCards([claude, codex, distilled]);
      assert.strictEqual(cards.length, 1, 'all of a person\'s tools for one day collapse into a single card');
      assert.strictEqual(cards[0].units.length, 3, 'every tool\'s work unit is retained on the card');
      assert.ok(Array.isArray(cards[0].tools), 'card carries a tools badge set');
      assert.deepStrictEqual(cards[0].tools.slice().sort(), ['Claude Code', 'Codex', 'Distilled'], 'all three tools present as badges');
      assert.strictEqual(cards[0].checklist.length, 3, 'checklist includes a row from every tool');
      assert.strictEqual(cards[0].checklist[0].live, true, 'live-first: the live Codex unit heads the checklist');
    });
    check('dayCards: a single-tool day carries exactly one tool badge', () => {
      const cards = evalDayCards([unitWith({ ts: dayCardsLocalTs(0, 14), source: 'Claude Code' })]);
      assert.strictEqual(cards.length, 1);
      assert.deepStrictEqual(cards[0].tools, ['Claude Code'], 'a one-tool day shows one badge');
    });
    // v2 checklist data (docs/superpowers/specs/2026-07-20-activity-day-cards-v2-design.md, Task 1):
    // each card carries a checklist[] — one {glyph, text, live} row per unit,
    // live rows first — and a fileCount summed over the day. Same fixtures and
    // sandbox as the grouping checks above.
    check('dayCards v2: checklist is one {glyph, text, live} row per unit, live rows first', () => {
      const distilledNewest = unitWith({ ts: dayCardsLocalTs(0, 14), repEntry: { headline: 'Shipped checklist item' } });
      const liveMid = unitWith({ ts: dayCardsLocalTs(0, 13), live: true, ask: 'Wire the toggle' });
      const staleNoSum = unitWith({ ts: dayCardsLocalTs(0, 12), ask: 'Old chore' });
      const c = evalDayCards([distilledNewest, liveMid, staleNoSum])[0];
      assert.ok(Array.isArray(c.checklist), 'card has a checklist array');
      assert.strictEqual(c.checklist.length, 3, 'one row per unit');
      assert.strictEqual(c.checklist[0].glyph, '◐', 'live row sorts first with the half-moon glyph');
      assert.strictEqual(c.checklist[0].live, true, 'live row carries live:true');
      assert.ok(c.checklist[0].text.includes('Wire the toggle'), 'live row text is its runHeadline (the ask)');
      assert.strictEqual(c.checklist[1].glyph, '✓', 'distilled finished row gets the check glyph');
      assert.strictEqual(c.checklist[1].live, false, 'finished row carries live:false');
      assert.ok(c.checklist[1].text.includes('Shipped checklist item'), 'distilled row text is its rep headline');
      assert.strictEqual(c.checklist[2].glyph, '○', 'finished-no-summary row gets the open-circle glyph');
      assert.ok(c.checklist[2].text.includes('Old chore'), 'no-summary row text falls back to the ask');
    });
    check('dayCards v2: fileCount = distinct files across the day (changes first, files fallback, deduped)', () => {
      const u1 = unitWith({ ts: dayCardsLocalTs(0, 14) });
      u1.runs[0].entries[0].changes = [{ file: 'lib/a.js' }, { file: 'lib/b.js' }];
      u1.runs[0].entries[0].files = ['lib/ignored-when-changes-present.js'];
      const u2 = unitWith({ ts: dayCardsLocalTs(0, 13) });
      u2.runs[0].entries[0].files = ['lib/b.js', 'lib/c.js'];
      const u3 = unitWith({ ts: dayCardsLocalTs(0, 12) });
      const c = evalDayCards([u1, u2, u3])[0];
      assert.strictEqual(c.fileCount, 3, 'a.js, b.js, c.js — changes beat files per entry, deduped across units');
    });
    // v2 renderer (docs/superpowers/specs/2026-07-20-activity-day-cards-v2-design.md, Task 2):
    // dayCardHtml consumes the precomputed card (headline/checklist/counts), so
    // its sandbox needs only esc/ago/MONO/personColor — none of the unitHtml
    // graph. extractConst lifts a one-line `var NAME = …;` declaration, the
    // same helper shape the drilldown branch used.
    function extractConst(src, name) {
      const m = src.match(new RegExp('var ' + name + '\\s*=[^;]*;'));
      return m ? m[0] : '';
    }
    function evalDayCardHtml(card, opts, expandedKeys) {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const agoSrc = extractVarFn(embeddedScript, 'ago') || '';
      const constSrc = extractConst(embeddedScript, 'MONO');
      const fnSrc = ['personColor', 'dayCardHtml'].map(n => extractFn(embeddedScript, n)).join('\n');
      const sandbox = new Function('expandedKeys',
        escSrc + '\n' + agoSrc + '\n' + constSrc + '\nvar catchupExpanded = expandedKeys || {};\n' + fnSrc +
        '\nreturn { dayCardHtml: dayCardHtml };'
      )(expandedKeys);
      return sandbox.dayCardHtml(card, opts || {});
    }
    const v2Units6 = [15, 14, 13, 12, 11, 10].map(h => unitWith({ ts: dayCardsLocalTs(0, h), repEntry: { headline: 'Change at ' + h } }));
    const v2Card6 = evalDayCards(v2Units6)[0];
    const v2Card3 = evalDayCards([15, 14, 13].map(h => unitWith({ ts: dayCardsLocalTs(0, h), repEntry: { headline: 'Change at ' + h } })))[0];
    const v2Distilled = unitWith({ ts: dayCardsLocalTs(0, 15), repEntry: { headline: 'Shipped the v2 cards' } });
    const v2Live = unitWith({ ts: dayCardsLocalTs(0, 14), live: true, ask: 'Wire the level two view' });
    const v2Stale = unitWith({ ts: dayCardsLocalTs(0, 13), ask: 'Tidy the styles' });
    const v2MixedCard = evalDayCards([v2Distilled, v2Live, v2Stale])[0];
    check('dayCardHtml v2: header carries the sentence headline and is the data-day-open drill target', () => {
      const h = evalDayCardHtml(v2MixedCard);
      assert.ok(h.indexOf('data-day-open="') !== -1, 'header must be a data-day-open target');
      assert.ok(h.includes('Shipped the v2 cards'), 'day headline sentence missing');
      assert.ok(h.indexOf('data-day-open') < h.indexOf('Shipped the v2 cards'), 'headline lives inside the drill-target header');
      assert.ok(!/data-card-toggle/.test(h), 'v2 header navigates — the v1 in-place toggle contract must be gone');
    });
    check('dayCardHtml v2: first 4 checklist rows visible, rest behind the bottom-right expander, collapsed by default', () => {
      const h = evalDayCardHtml(v2Card6);
      const moreAt = h.indexOf('data-day-more');
      assert.ok(moreAt !== -1, 'hidden-rows container missing');
      assert.strictEqual((h.slice(0, moreAt).match(/✓/g) || []).length, 4, 'exactly 4 rows before the fold');
      assert.strictEqual((h.slice(moreAt).match(/✓/g) || []).length, 2, 'rows 5+ live inside the fold');
      assert.ok(/<div data-day-more="[^"]*"[^>]*display:none/.test(h), 'fold must start hidden (collapsed by default)');
      assert.ok(/data-day-expand/.test(h), 'expander control missing');
      assert.ok(h.includes('Show all 6 changes'), 'expander label counts every change');
      assert.ok(h.indexOf('6 sessions') < h.indexOf('data-day-expand'), 'stat row sits left of the expander in the footer');
      assert.ok(!/data-day-expand/.test(evalDayCardHtml(v2Card3)), 'a 4-rows-or-fewer card needs no expander');
    });
    check('dayCardHtml v2: live row first with the working-now tag; glyphs ◐/✓/○ by state', () => {
      const h = evalDayCardHtml(v2MixedCard);
      const iLive = h.indexOf('◐'), iDone = h.indexOf('✓'), iBare = h.indexOf('○');
      assert.ok(iLive !== -1 && iDone !== -1 && iBare !== -1, 'all three state glyphs render');
      assert.ok(iLive < iDone && iDone < iBare, 'live row first, then distilled, then no-summary');
      assert.strictEqual((h.match(/working now/g) || []).length, 1, 'exactly the live row carries the tag');
    });
    // FIX 1 render side: the consolidated card shows one badge per tool used.
    check('dayCardHtml: renders a badge for every tool the day used', () => {
      const claude = unitWith({ ts: dayCardsLocalTs(0, 14), source: 'Claude Code' });
      const codex = unitWith({ ts: dayCardsLocalTs(0, 12), source: 'Codex' });
      const distilled = unitWith({ ts: dayCardsLocalTs(0, 10), source: 'Distilled', repEntry: { headline: 'D' } });
      const h = evalDayCardHtml(evalDayCards([claude, codex, distilled])[0]);
      assert.ok(/Claude Code/.test(h) && /Codex/.test(h) && /Distilled/.test(h), 'all tool badges must render on the one card');
      const single = evalDayCardHtml(evalDayCards([unitWith({ ts: dayCardsLocalTs(0, 14), source: 'Codex' })])[0]);
      assert.ok(/Codex/.test(single) && !/Claude Code/.test(single), 'a single-tool day shows only its one badge');
    });
    check('dayCardHtml v2: stat row sums sessions · prompts · files over the day', () => {
      const su1 = unitWith({ ts: dayCardsLocalTs(0, 15), agentCount: 2, promptCount: 5 });
      su1.runs[0].entries[0].files = ['lib/x.js', 'lib/y.js'];
      const su2 = unitWith({ ts: dayCardsLocalTs(0, 12), agentCount: 1, promptCount: 7 });
      su2.runs[0].entries[0].changes = [{ file: 'lib/x.js' }, { file: 'lib/z.js' }];
      const h = evalDayCardHtml(evalDayCards([su1, su2])[0]);
      assert.ok(/3 sessions/.test(h) && /12 prompts/.test(h) && /3 files/.test(h), 'stat row sums the day');
    });
    check('dayCardHtml v2: catchupExpanded[key] reopens the checklist across repaints', () => {
      const exp = {};
      exp[v2Card6.key] = true;
      const h = evalDayCardHtml(v2Card6, {}, exp);
      assert.ok(/<div data-day-more="[^"]*"[^>]*display:block/.test(h), 'expanded fold must render open');
      assert.ok(/Show fewer/.test(h), 'expander label flips when open');
    });
    // feedDayGroupHtml wiring: like the drilldown branch's wiring checks, a
    // plain pageHtml.includes() can't tell "defined" from "wired", so these run
    // the REAL feedDayGroupHtml (full call graph down through buildDayCards/
    // dayCardHtml/unitHtml/threadHtml) against hand-seeded raw feed entries.
    function evalFeedDayGroupHtml() {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const agoSrc = extractVarFn(embeddedScript, 'ago') || '';
      const constSrc = ['MONO', 'STALE_GAP', 'BURST_GAP'].map(n => extractConst(embeddedScript, n)).join('\n');
      const fnSrc = [
        'personColor', 'capLine', 'firstSentence', 'askHeadline', 'runHeadline', 'promptCellText', 'promptRowsHtml', 'cardCloseHtml', 'shareToggleHtml',
        'intentRowHtml', 'threadHtml', 'unitHtml', 'dayCardHtml',
        'feedKey', 'normKeyPart', 'threadKey', 'buildThreads', 'unitKeyOf', 'finalizeUnit', 'buildUnits',
        'homeDayLabel', 'buildDayCards', 'feedDayGroupHtml',
      ].map(n => extractFn(embeddedScript, n)).join('\n');
      return new Function(
        escSrc + '\n' + agoSrc + '\n' + constSrc + '\nvar catchupExpanded = {};\n' + fnSrc +
        '\nreturn { feedDayGroupHtml: feedDayGroupHtml };'
      )();
    }
    // Raw seeded feed entries (buildThreads' input shape, not unitWith's
    // unit shape): 4 entries -> 3 (author, project, local day) day cards over
    // 2 distinct days.
    function feedEntryWith(overrides) {
      overrides = overrides || {};
      return {
        ts: overrides.ts,
        ask: overrides.ask !== undefined ? overrides.ask : 'Do the thing',
        author: overrides.author !== undefined ? overrides.author : 'Marco',
        authorId: overrides.authorId,
        self: overrides.self !== undefined ? overrides.self : false,
        source: overrides.source !== undefined ? overrides.source : 'Claude Code',
        project: overrides.project !== undefined ? overrides.project : 'ProjA',
        projectId: overrides.projectId,
        projectPath: overrides.projectPath,
        session: overrides.session,
      };
    }
    const v2FeedEntries = [
      feedEntryWith({ ts: dayCardsLocalTs(0, 14), author: 'Marco', project: 'ProjA', session: 's-a1' }),
      feedEntryWith({ ts: dayCardsLocalTs(0, 9), author: 'Marco', project: 'ProjA', session: 's-a2' }),
      feedEntryWith({ ts: dayCardsLocalTs(0, 10), author: 'Andrew', self: true, project: 'ProjA', session: 's-b1' }),
      feedEntryWith({ ts: dayCardsLocalTs(1, 10), author: 'Marco', project: 'ProjB', session: 's-c1' }),
    ];
    check('feedDayGroupHtml v2: Activity top level renders day cards under day separators, no per-unit cards', () => {
      const h = evalFeedDayGroupHtml().feedDayGroupHtml(v2FeedEntries);
      assert.strictEqual((h.match(/data-day-open="/g) || []).length, 3, 'one drill target per author-day');
      assert.strictEqual((h.match(/margin:28px 0 4px/g) || []).length, 2, 'two day separators (today + yesterday)');
      assert.ok(!/data-card-toggle/.test(h), 'no per-unit card at the Activity top level');
    });
    check('feedDayGroupHtml v2: opts.unitCards keeps the project page per-unit', () => {
      const h = evalFeedDayGroupHtml().feedDayGroupHtml(v2FeedEntries, { unitCards: true, hideProject: true });
      assert.ok(!/data-day-open/.test(h), 'project page must not render day cards');
      assert.ok(/<article/.test(h), 'per-unit cards must still render');
    });
    // The Intent row is always rendered per card so the layout stays stable;
    // when no distilled goal exists it shows a muted "(not captured)" rather
    // than dropping the row (present-goal keeps its text).
    check('intentRowHtml: always renders an Intent row, "(not captured)" when no goal', () => {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const fn = new Function(escSrc + '\n' + extractFn(embeddedScript, 'intentRowHtml') + '\nreturn intentRowHtml;')();
      const withGoal = fn('Ship the thing');
      assert.ok(/class="flabel">Intent</.test(withGoal) && withGoal.includes('Ship the thing'), 'goal text must render');
      const noGoal = fn('');
      assert.ok(/class="flabel">Intent</.test(noGoal), 'Intent row must render even without a goal');
      assert.ok(noGoal.includes('(not captured)'), 'goal-less card must show the (not captured) placeholder');
    });
    // Level-2 day-detail view (docs/superpowers/specs/2026-07-20-activity-day-cards-v2-design.md, Task 3):
    // dayDetailHtml renders the session view for one author-day card —
    // breadcrumb + day headline, one session card per unit (live-first), the
    // 2–3 sentence distilled summary, prompts inline behind a bottom-left
    // toggle, and NO deeper drill target anywhere (two levels only).
    function evalDayDetailHtml(card, opts, expandedKeys) {
      const escSrc = extractVarFn(embeddedScript, 'esc') || '';
      const agoSrc = extractVarFn(embeddedScript, 'ago') || '';
      const constSrc = extractConst(embeddedScript, 'MONO');
      const fnSrc = ['personColor', 'capLine', 'firstSentence', 'askHeadline', 'runHeadline', 'wordSafeTail', 'promptCellText', 'shareToggleHtml', 'dayDetailHtml']
        .map(n => extractFn(embeddedScript, n)).join('\n');
      const sandbox = new Function('expandedKeys',
        escSrc + '\n' + agoSrc + '\n' + constSrc + '\nvar catchupExpanded = expandedKeys || {};\n' + fnSrc +
        '\nreturn { dayDetailHtml: dayDetailHtml };'
      )(expandedKeys);
      return sandbox.dayDetailHtml(card, opts || {});
    }
    const dSum = unitWith({ ts: dayCardsLocalTs(0, 15), repEntry: { headline: 'Shipped it', summary: 'Did the thing end to end. Wired the tests. Landed green.' } });
    const dLive = unitWith({ ts: dayCardsLocalTs(0, 14), live: true, ask: 'Keep wiring' });
    const dBare = unitWith({ ts: dayCardsLocalTs(0, 13), ask: 'Chore run' });
    const dNoAsk = unitWith({ ts: dayCardsLocalTs(0, 12), ask: '' });
    const dDetailCard = evalDayCards([dSum, dLive, dBare, dNoAsk])[0];
    check('dayDetailHtml: breadcrumb + day headline; one session card per unit, live-first', () => {
      const h = evalDayDetailHtml(dDetailCard);
      assert.ok(/data-day-back/.test(h), 'breadcrumb back control missing');
      assert.ok(h.includes('Activity'), 'crumb names the Activity feed');
      assert.ok(h.includes('Shipped it'), 'day headline missing');
      assert.strictEqual((h.match(/<article/g) || []).length, 4, 'one session card per unit');
      const iLive = h.indexOf('Keep wiring');
      const iSum = h.indexOf('Shipped it', h.indexOf('<article'));
      assert.ok(iLive !== -1 && iSum !== -1 && iLive < iSum, 'live unit card renders first');
      assert.ok(/working now/i.test(h), 'live unit keeps its working-now marker');
    });
    check('dayDetailHtml: 2–3 sentence distilled summary shown, not just the headline', () => {
      const h = evalDayDetailHtml(dDetailCard);
      assert.ok(h.includes('Did the thing end to end. Wired the tests. Landed green.'), 'full distilled summary missing');
    });
    // FIX 3 (auto/day-card-fixes): a teammate's summary is harvested (never
    // distilled over sync), so the day-detail card used to drop it and show only
    // the clamped ask. It must fall back to the harvested rep — same rule the
    // day-card checklist uses — and render the FULL summary.
    check('dayDetailHtml: a teammate\'s full summary renders (harvested fallback), not just the clamped ask', () => {
      const teammate = unitWith({ self: false, author: 'Andrew', ts: dayCardsLocalTs(0, 11), ask: 'refactor auth',
        harvestedEntry: { summary: 'Refactored the auth module across three files. Added tests. All green now.' } });
      const h = evalDayDetailHtml(evalDayCards([teammate])[0]);
      assert.ok(h.includes('Refactored the auth module across three files. Added tests. All green now.'),
        'teammate harvested summary must render in full in the day-detail card');
    });
    check('dayDetailHtml: prompts hidden behind the bottom-left toggle; display-only rows; no level-3 target', () => {
      const h = evalDayDetailHtml(dDetailCard);
      assert.ok(/data-prompts-toggle/.test(h), 'prompts toggle missing');
      assert.ok(/show 1 prompt\b/.test(h), 'toggle label counts the prompts');
      assert.ok(/<div data-prompts-fold="[^"]*"[^>]*display:none/.test(h), 'prompt fold must start hidden');
      assert.ok(h.includes('(prompt not shared)'), 'unshared prompt renders the placeholder row');
      assert.ok(h.indexOf('Chore run') !== -1, 'shared ask renders as a prompt row');
      assert.ok(!/data-sess-open|data-day-open|data-prompt-open/.test(h), 'no deeper-open attribute anywhere — two levels only');
      const exp = {};
      exp['prompts|' + dLive.key] = true;
      const h2 = evalDayDetailHtml(dDetailCard, {}, exp);
      assert.ok(/<div data-prompts-fold="[^"]*"[^>]*display:block/.test(h2), 'catchupExpanded reopens a prompt fold across repaints');
    });
    check('dayDetailHtml: a missing day degrades to the friendly not-found state', () => {
      const h = evalDayDetailHtml(null);
      assert.ok(/data-day-back/.test(h), 'not-found still offers the way back');
      assert.ok(/isn|scrolled|no longer/i.test(h), 'not-found copy missing');
    });
    // FIX 2 (auto/day-card-fixes): kill the not-found flash while the day view's
    // fetch is still in flight. During loading, show the slow-load spinner —
    // never the "not in feed" message. Not-found renders ONLY once the fetch has
    // resolved with no matching day (loading falsy).
    check('dayDetailHtml: loading state shows the spinner, never the not-found message', () => {
      const h = evalDayDetailHtml(null, { loading: true });
      assert.ok(/mbSpin/.test(h), 'loading state must render the slow-load spinner');
      assert.ok(!/isn|scrolled|no longer/i.test(h), 'not-found copy must NOT render during load');
      assert.ok(/data-day-back/.test(h), 'loading state still offers the way back');
    });
    check('dayDetailHtml: not-found renders only after a resolved fetch (loading falsy)', () => {
      const h = evalDayDetailHtml(null, { loading: false });
      assert.ok(/isn|scrolled|no longer/i.test(h), 'a resolved fetch with no day must show not-found');
      assert.ok(!/mbSpin/.test(h), 'a resolved empty fetch is not a loading state');
    });
    check('day view wiring: startDay paints the loading state before the fetch, loadDay renders after it', () => {
      const startSrc = extractFn(embeddedScript, 'startDay');
      const loadSrc = extractFn(embeddedScript, 'loadDay');
      assert.ok(/dayDetailHtml\(null,\s*\{\s*loading:\s*true\s*\}\)/.test(startSrc),
        'startDay must paint the loading state (dayDetailHtml(null,{loading:true})) before loadDay resolves');
      assert.ok(loadSrc.indexOf('dayDetailHtml(card)') !== -1 && loadSrc.indexOf('.then(') < loadSrc.indexOf('dayDetailHtml(card)'),
        'loadDay must render the resolved card (not-found included) only inside the fetch .then');
    });
    // BUG 2 (fix/share-live-and-clamp): day-detail text must never end
    // mid-word. Local rows render the full ask (askFull); rows that only
    // exist clipped (team rows, pre-fix data) get their tail tidied to the
    // last whole word before the ellipsis.
    check('dayDetailHtml: prompt/summary text never cut mid-word — full local text, word-safe fallback', () => {
      const fullAsk = 'refactor the authentication checkpoints module end to end';
      const dFull = unitWith({ ts: dayCardsLocalTs(0, 10), ask: 'refactor the authentication chec…' });
      dFull.runs[0].entries[0].askFull = fullAsk;
      const dClipped = unitWith({ ts: dayCardsLocalTs(0, 9), ask: 'triage the flaky supabase chec…' });
      const dClipSum = unitWith({ ts: dayCardsLocalTs(0, 8), repEntry: { headline: 'Clip headline', summary: 'Landed the share fix across chec…' } });
      const h = evalDayDetailHtml(evalDayCards([dFull, dClipped, dClipSum])[0]);
      assert.ok(h.includes(fullAsk), 'local prompt row must render the complete ask (askFull)');
      assert.ok(!h.includes('authentication chec…'), 'the clipped local ask must not render once the full text exists');
      assert.ok(!h.includes('supabase chec…'), 'a clipped-only ask must not end mid-word anywhere (title or row)');
      assert.ok(h.includes('supabase…'), 'the clipped-only ask ends at a word boundary instead');
      assert.ok(!h.includes('across chec…'), 'a clipped-only summary must not end mid-word');
      assert.ok(h.includes('across…'), 'the clipped-only summary ends at a word boundary instead');
    });
    // Regression: the day-cards v2 redesign dropped the per-session share toggle
    // from the Activity view (it survived only on the project page). It belongs on
    // the session card in the day-detail level — one card is one session.
    function selfUnit(overrides) {
      overrides = overrides || {};
      const ts = overrides.ts !== undefined ? overrides.ts : dayCardsLocalTs(0, 11);
      const entry = { ts, ask: overrides.ask, author: 'Marco', self: overrides.entrySelf,
        session: overrides.session, projectPath: overrides.projectPath, shared: !!overrides.shared };
      return unitWith({ ts, self: true, author: 'Marco', project: 'ProjA',
        runs: [{ ts, key: 'run-' + (overrides.session || 'x'), entries: [entry], rep: null }] });
    }
    check('dayDetailHtml: restores the per-session share toggle on your own session card', () => {
      const card = evalDayCards([selfUnit({ ask: 'My own prompt', entrySelf: true, session: 's-self1', projectPath: '/Users/marco/ProjA' })])[0];
      const h = evalDayDetailHtml(card);
      assert.ok(/data-share-toggle/.test(h), 'share toggle missing from the day-detail session card');
      assert.ok(/data-share-session="s-self1"/.test(h), 'toggle not wired to the session id');
      assert.ok(/Share with team/.test(h), 'unshared toggle should read "Share with team"');
    });
    check('dayDetailHtml: an already-shared session card reads "Shared"', () => {
      const card = evalDayCards([selfUnit({ ask: 'Shared prompt', entrySelf: true, session: 's-self3', projectPath: '/Users/marco/ProjA', shared: true })])[0];
      const h = evalDayDetailHtml(card);
      assert.ok(/data-share-on="1"/.test(h) && />Shared</.test(h), 'shared session card should show the on-state toggle');
    });
    check("dayDetailHtml: no share toggle on a teammate's session card", () => {
      const teammate = unitWith({ ts: dayCardsLocalTs(0, 11), self: false, author: 'Andrew', project: 'ProjA',
        runs: [{ ts: dayCardsLocalTs(0, 11), key: 'run-t1', entries: [{ ts: dayCardsLocalTs(0, 11), ask: 'Their prompt', author: 'Andrew', self: false, session: 's-t1', projectPath: null }], rep: null }] });
      const h = evalDayDetailHtml(evalDayCards([teammate])[0]);
      assert.ok(!/data-share-toggle/.test(h), 'teammate card must not expose your share toggle');
    });
    // Regression: your own prompt is never gated FROM you — an empty own ask means
    // capture missed it, never the sharing-implying "(prompt not shared)" label.
    check('dayDetailHtml: your own empty-ask prompt never reads "(prompt not shared)"', () => {
      const card = evalDayCards([selfUnit({ ask: '', entrySelf: true, session: 's-self2', projectPath: '/Users/marco/ProjA' })])[0];
      const h = evalDayDetailHtml(card);
      assert.ok(h.includes('(no prompt captured)'), 'own uncaptured prompt should read "(no prompt captured)"');
      assert.ok(!h.includes('(prompt not shared)'), 'own prompt must never read as unshared to yourself');
    });
    check('day route: container, tab, poller, and back handler wired', () => {
      assert.ok(pageHtml.includes('id="view-day"') && pageHtml.includes('id="dayRoot"'), 'day view container missing from the page');
      assert.ok(embeddedScript.includes("indexOf('#day=') === 0"), 'currentTab must recognize #day=');
      assert.ok(/function startDay\(\)/.test(embeddedScript) && /function loadDay\(\)/.test(embeddedScript) && /function stopDay\(\)/.test(embeddedScript), 'day poller trio missing');
      assert.ok(embeddedScript.includes("getElementById('view-day')"), 'view-day delegated listener missing');
    });
    // ---- Five Electron-runtime UI bug fixes. No DOM runtime in this suite,
    // so these are source-level presence/shape assertions against the served
    // pageHtml/embeddedScript (both already fully rendered by dashboardPage()). ----
    check('dashboard embedded script never calls window.prompt/confirm/alert (Electron has no window.prompt — it silently no-ops)', () => {
      assert.ok(!embeddedScript.includes('window.prompt('), 'window.prompt( still present');
      assert.ok(!embeddedScript.includes('window.confirm('), 'window.confirm( still present');
      assert.ok(!embeddedScript.includes('window.alert('), 'window.alert( still present');
      assert.ok(!/(^|[^.\w])prompt\(/.test(embeddedScript), 'a bare prompt( call is still present');
      assert.ok(!/(^|[^.\w])confirm\(/.test(embeddedScript), 'a bare confirm( call is still present');
      assert.ok(!/(^|[^.\w])alert\(/.test(embeddedScript), 'a bare alert( call is still present');
    });
    check('dashboard has a reusable in-app prompt modal joined to the overlay + Escape idiom', () => {
      assert.ok(pageHtml.includes('id="promptOverlay"'), 'prompt overlay markup missing');
      assert.ok(pageHtml.includes('id="promptInput"'), 'prompt input missing');
      assert.ok(pageHtml.includes('id="promptConfirm"'), 'prompt confirm button missing');
      assert.ok(embeddedScript.includes('function openPrompt('), 'openPrompt helper missing');
      assert.ok(/promptInput[\s\S]{0,400}key === 'Enter'/.test(embeddedScript), 'Enter-confirms wiring missing');
      assert.ok(/hadModal[\s\S]{0,400}promptOverlay/.test(embeddedScript), 'prompt overlay not joined to the Escape hadModal chain');
      assert.ok(/window\.addEventListener\('keydown'[\s\S]{0,900}closePrompt\(\)/.test(embeddedScript), 'Escape does not close the prompt overlay');
      assert.ok(embeddedScript.includes("teamRequest('/api/team/create'"), 'create still runs the same teamRequest flow');
      assert.ok(embeddedScript.includes("teamRequest('/api/team/join'"), 'join still runs the same teamRequest flow');
      assert.ok(embeddedScript.includes("teamRequest('/api/team/rename'"), 'rename still runs the same teamRequest flow');
    });
    check('feedFilterBarHtml renders a stable, never-shrinking union of tools/projects instead of deriving from filtered entries', () => {
      const barFnSrc = extractFn(embeddedScript, 'feedFilterBarHtml');
      assert.ok(barFnSrc, 'feedFilterBarHtml not found');
      assert.ok(embeddedScript.includes('feedToolsSeen') && embeddedScript.includes('feedProjectsSeen'),
        'stable-superset accumulator vars missing');
      assert.ok(barFnSrc.includes('feedToolsSeen') && barFnSrc.includes('feedProjectsSeen'),
        'feedFilterBarHtml does not read from the stable-superset accumulators');
      // the old collapsing shape built a fresh tools/projects map off entries.forEach every render
      assert.ok(!/entries\.forEach[\s\S]{0,200}tools\[e\.source\]/.test(barFnSrc),
        'feedFilterBarHtml still derives tool options from its entries argument the old collapsing way');
    });
    check('Activity top level does not render a persistent back control', () => {
      assert.ok(!embeddedScript.includes('← Catch-Up'), 'old "← Catch-Up" label still present');
      assert.ok(!embeddedScript.includes('← All activity'), 'persistent Activity back-link label still present');
      assert.ok(!/data-feed="back"/.test(embeddedScript), 'persistent Activity back-link target still present');
    });
    check('Team empty-state card reuses the header brand mark above "No team yet"', () => {
      const noneFnSrc = extractFn(embeddedScript, 'teamScreenNone');
      assert.ok(noneFnSrc, 'teamScreenNone not found');
      assert.ok(noneFnSrc.includes('brand-mark'), 'brand-mark asset missing from the team empty state');
      assert.ok(noneFnSrc.includes('No team yet'), 'heading missing');
      assert.ok(noneFnSrc.indexOf('brand-mark') < noneFnSrc.indexOf('No team yet'), 'brand mark is not positioned above the heading');
    });
    check('a reusable slow-load spinner arms at 3s and is wired into the three view loaders', () => {
      assert.ok(/SPINNER_DELAY_MS\s*=\s*3000/.test(embeddedScript), '3s spinner delay constant missing');
      assert.ok(embeddedScript.includes('function armSpinner('), 'armSpinner helper missing');
      assert.ok(embeddedScript.includes('function clearSpinner('), 'clearSpinner helper missing');
      ['loadProjectsIndex', 'loadFeed', 'renderTeamScreen'].forEach((name) => {
        const src = extractFn(embeddedScript, name);
        assert.ok(src, `${name} not found`);
        assert.ok(/armSpinner\(/.test(src), `${name} does not arm the spinner`);
        assert.ok(/clearSpinner\(/.test(src), `${name} does not clear the spinner`);
      });
    });
    // Fix round: the spinner's 3s paint replaces host content, which the
    // fp-dedup guards (fp === feedFp/pxFp && host.firstChild → skip render)
    // cannot see — a slow-but-unchanged poll tick stranded the spinner, and
    // the paint could wipe an open ⋯ menu the dedup branch protects.
    check('spinner paint is observable: fp-dedup skips must re-render a painted-over host, and an open ⋯ menu blocks the paint', () => {
      assert.ok(/function clearSpinner\(viewKey, token\)[\s\S]{0,400}return !!spinnerPainted\[viewKey\]/.test(embeddedScript),
        'clearSpinner does not report whether the timer already painted');
      assert.ok(embeddedScript.includes('function spinnerRendered('),
        'spinnerRendered reset helper missing (painted debt must clear only on a real render)');
      const feedSrc = extractFn(embeddedScript, 'loadFeed');
      assert.ok(/fp === feedFp && host\.firstChild && !spinnerPaintedOver/.test(feedSrc),
        "loadFeed's fp-dedup skip does not consult the painted flag");
      const pxSrc = extractFn(embeddedScript, 'loadProjectsIndex');
      const pxGuards = pxSrc.match(/fp === pxFp && host\.firstChild && !spinnerPaintedOver/g) || [];
      assert.ok(pxGuards.length >= 2,
        `loadProjectsIndex's fp-dedup skips must both consult the painted flag (found ${pxGuards.length})`);
      // menu guard: the paint path must skip when the projects ⋯ menu/confirm is open
      assert.ok(/skipPaint && skipPaint\(\)/.test(embeddedScript), 'paint path has no skip-paint guard');
      assert.ok(/armSpinner\('projects'[\s\S]{0,140}pxMenuId \|\| pxConfirmId/.test(pxSrc),
        'projects loader does not pass the open-menu guard to armSpinner');
    });
    check('switching/joining/creating/leaving a team resets the feed filter unions (stale old-team options cannot persist)', () => {
      assert.ok(embeddedScript.includes('function resetFeedFilterUnions('), 'union reset helper missing');
      assert.ok(/data-ts-switchto[\s\S]{0,220}resetFeedFilterUnions\(\)/.test(embeddedScript),
        'switch-to branch does not reset the unions');
      assert.ok(/\/api\/team\/join'[\s\S]{0,260}resetFeedFilterUnions\(\)/.test(embeddedScript),
        'join flow does not reset the unions');
    });
    // ---- Round 3 Electron-runtime UI bugs: team create/join failing silently,
    // the Activity project filter matching on display name, and the session
    // page's old no-summary liveness rule. Same contract as the rounds above:
    // browser behavior is pinned by source-shape assertions (no DOM runtime in
    // this suite); the server half of each contract is exercised for real. ----
    const noAuthCreate = await fetch(`${base}/api/team/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'ghost-team' }),
    });
    const noAuthCreateBody = await noAuthCreate.json().catch(() => ({}));
    const noAuthJoin = await fetch(`${base}/api/team/join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inviteCode: 'no-such-code' }),
    });
    const noAuthJoinBody = await noAuthJoin.json().catch(() => ({}));
    check('unauthenticated /api/team/create + /join answer a non-2xx with an error body the UI can surface', () => {
      assert.ok(!noAuthCreate.ok, 'unauthenticated create must not be 2xx');
      assert.ok(noAuthCreateBody.error, 'create error body is empty');
      assert.ok(!noAuthJoin.ok, 'unauthenticated join must not be 2xx');
      assert.ok(noAuthJoinBody.error, 'join error body is empty');
    });
    check('Team screen surfaces create/join failures — auth-aware notice + sign-in gate, never a silent no-op', () => {
      assert.ok(embeddedScript.includes('function tsNoticeHtml('), 'Team screen notice helper missing');
      const tsViewSrc = extractFn(embeddedScript, 'renderTeamScreenView');
      assert.ok(tsViewSrc && tsViewSrc.includes('tsNoticeHtml()'), 'Team screen view does not render the notice');
      // Rejections must reach the notice — the old handlers swallowed them with
      // an argument-less .catch(function () { setPill(false); }).
      assert.ok(/\/api\/team\/create'[\s\S]{0,600}\.catch\(function \(err\)/.test(embeddedScript),
        'create rejection is still swallowed (argument-less catch)');
      assert.ok(/\/api\/team\/join'[\s\S]{0,600}\.catch\(function \(err\)/.test(embeddedScript),
        'join rejection is still swallowed (argument-less catch)');
      // A resolved-but-error body must surface too, not just rejections.
      assert.ok(/r && r\.error/.test(embeddedScript), 'resolved r.error responses are not surfaced');
      // Auth failures get actionable copy; other failures show the server error.
      assert.ok(embeddedScript.includes('Sign in to create a team'), 'auth-failure copy missing (create)');
      assert.ok(embeddedScript.includes('Sign in to join a team'), 'auth-failure copy missing (join)');
      // Signed-out empty state gates behind sign-in instead of two dead buttons.
      const noneSrc = extractFn(embeddedScript, 'teamScreenNone');
      assert.ok(noneSrc && noneSrc.includes('authenticated'), 'team empty state ignores auth state');
      assert.ok(noneSrc.includes('data-ts-signin'), 'signed-out empty state has no sign-in CTA');
      // Happy path intact: a returned team_id is remembered and the screen re-renders.
      assert.ok(/r\.team_id\) \{ rememberTeam\(r\.team_id\); resetFeedFilterUnions\(\); \}/.test(embeddedScript),
        'create/join happy path no longer remembers the new team');
      // The notice clears only on a REAL /api/team payload: renderTeamScreen's
      // fetch coerces a failure to null and flows through the success handler,
      // which must not wipe a just-painted failure banner.
      const tsLoadSrc = extractFn(embeddedScript, 'renderTeamScreen');
      assert.ok(tsLoadSrc && /if \(tsTeamState\) \{ tsNotice = ''; tsNoticeAuth = false; \}/.test(tsLoadSrc),
        'notice clear is not gated on a real /api/team payload — a failed reload wipes the banner');
    });
    const feedByPath = await (await fetch(`${base}/api/feed?project=${encodeURIComponent(proj1)}&limit=50`)).json();
    check('Activity project filter: a tracked project path returns that project\'s local entries', () => {
      const locals = (feedByPath.entries || []).filter(e => e.origin === 'local');
      assert.ok(locals.length > 0, 'path filter returned no local entries for a project with activity');
      assert.ok(locals.every(e => e.projectPath === proj1), 'foreign entries leaked through the project filter');
    });
    check('Activity project dropdown sends the value the feed filters on (projectId/projectPath) — display name is label only', () => {
      const barFnSrc = extractFn(embeddedScript, 'feedFilterBarHtml');
      assert.ok(barFnSrc, 'feedFilterBarHtml not found');
      assert.ok(!/feedProjectsSeen\[e\.project\]/.test(barFnSrc),
        'dropdown still keys project options by display name — /api/feed matches projectPath/projectId, so a name value returns "Nothing to show"');
      assert.ok(/e\.projectId \|\| e\.projectPath/.test(barFnSrc),
        'dropdown option value is not the id-preferred precedence the .fproj pill and /api/feed use');
    });
    check("session page liveness = the feed's STALE_GAP wall-clock rule (an old session renders finished, never 'working now')", () => {
      const sessSrc = extractFn(embeddedScript, 'sessionPageHtml');
      assert.ok(sessSrc, 'sessionPageHtml not found');
      assert.ok(/\(Date\.now\(\) - \(Date\.parse\(t\.ts\) \|\| 0\)\) < STALE_GAP/.test(sessSrc),
        'session page does not compute live from STALE_GAP');
      assert.ok(!/wip = !t\.rep/.test(sessSrc), 'old summary-claim liveness (wip = !t.rep) still drives the page');
      assert.ok(/live\s*\n?\s*\?[\s\S]{0,420}working now/.test(sessSrc), '"working now" badge is not gated on live');
      assert.ok(/tail = live/.test(sessSrc), "timeline 'working…' tail is not gated on live");
      assert.ok(sessSrc.includes('session ended'), 'stale-session finished fallback missing');
      assert.ok(sessSrc.includes('repHarvested'), 'harvested-summary fallback missing for stale sessions');
      // The 5s poll dedups on a serialized fingerprint; unless liveness is IN
      // that fingerprint, a page opened while live keeps its "working now"
      // badge forever once the session crosses STALE_GAP with no new entries.
      const loadSessSrc = extractFn(embeddedScript, 'loadSession');
      assert.ok(loadSessSrc && /STALE_GAP[\s\S]{0,200}sessFp|live[\s\S]{0,600}sessFp = fp/.test(loadSessSrc) && /live/.test(loadSessSrc),
        "loadSession's dedup fingerprint ignores liveness — a stale session never repaints to finished");
    });
    // ---- Round 4: auth-screen polish + the Projects person filter blanking on
    // shared-project members with no recent local activity. Browser behavior
    // pinned by source/page-shape assertions; the person filter is a pure
    // extracted helper exercised directly (deleteProjectsBulk style). ----
    check('auth screen: password is labeled, display name says what it is, password hint intact', () => {
      // The micro-label styling must live on an inner span, NOT the <label>
      // itself: the input is the label's child and would inherit the mono/
      // uppercase/tracking styles (font-family:inherit + inherited props),
      // rendering the placeholder as wide-tracked ALL-CAPS mono.
      assert.ok(/<label[^>]*><span[^>]*>Password<\/span><input name="password"/.test(embeddedScript),
        'password label missing or its styling sits on the label element (input would inherit mono/uppercase)');
      assert.ok(embeddedScript.includes('<label style="display:grid;gap:6px;text-align:left"><span'),
        'the wrapping label is not style-neutral');
      assert.ok(!embeddedScript.includes('placeholder="How teammates see you"'),
        'display-name placeholder still reads "How teammates see you"');
      assert.ok(embeddedScript.includes('placeholder="Display name"'), 'display-name placeholder missing');
      assert.ok(embeddedScript.includes('placeholder="At least 6 characters"'), 'password hint placeholder lost');
    });
    check('auth screen: the mark is a proper MemBridge logo lockup, not a bare toggle-look tile', () => {
      // the enlarged header-style lockup: brand-mark tile + wordmark side by side
      assert.ok(pageHtml.includes('brand-mark auth-mark'), 'enlarged auth logo mark missing');
      assert.ok(/brand-mark auth-mark[\s\S]{0,400}Mem<span/.test(pageHtml),
        'auth mark is not a lockup with the MemBridge wordmark');
      assert.ok(/\.auth-mark \{/.test(pageHtml) && /\.auth-mark svg \{/.test(pageHtml),
        'auth-mark sizing CSS missing (mark or its svg would render header-sized)');
      // the old toggle-look motif (two overlapped circles) is gone from the auth card
      const authCard = pageHtml.slice(pageHtml.indexOf('id="view-auth"'), pageHtml.indexOf('<header'));
      assert.ok(!authCard.includes('margin-left:-9px'), 'old two-circle toggle-look motif still in the auth card');
    });
    const pxFilterSrc = extractFn(embeddedScript, 'pxPersonFilter');
    const pxInProjSrc = extractFn(embeddedScript, 'pxEntryInProject');
    check('Projects person filter: shared-project team membership keeps the project visible without recent activity', () => {
      assert.ok(pxFilterSrc, 'pxPersonFilter pure helper missing');
      assert.ok(pxInProjSrc, 'pxEntryInProject missing');
      const pxPersonFilter = new Function('return (' + pxFilterSrc + ')')();
      const pxEntryInProject = new Function('return (' + pxInProjSrc + ')')();
      const projects = [
        { name: 'membridge', path: '/w/membridge', team: { teamId: 't1', teamName: 'Melika' } },
        { name: 'sidecar', path: '/w/sidecar', team: null },
        { name: 'otherteam', path: '/w/otherteam', team: { teamId: 't2', teamName: 'Elsewhere' } },
      ];
      const recent = [{ author: 'You', projectPath: '/w/sidecar', project: 'sidecar' }];
      const membersByTeam = { t1: ['marco', 'Andrew'] };
      // marco: t1 member with NO local recent activity -> the shared t1 project stays visible…
      const marcoVis = pxPersonFilter(projects, 'marco', recent, membersByTeam, pxEntryInProject);
      assert.deepStrictEqual(marcoVis.map(p => p.name), ['membridge'],
        `expected only the t1 shared project, got [${marcoVis.map(p => p.name)}]`);
      // …and membership is TEAM-scoped (t2's project excluded above), local projects excluded above.
      const youVis = pxPersonFilter(projects, 'You', recent, membersByTeam, pxEntryInProject);
      assert.deepStrictEqual(youVis.map(p => p.name), ['sidecar'], 'recent-activity match broke');
      assert.strictEqual(pxPersonFilter(projects, 'All', recent, membersByTeam, pxEntryInProject).length, 3, "'All' must pass everything");
      assert.strictEqual(pxPersonFilter(projects, 'marco', recent, null, pxEntryInProject).length, 0,
        'missing member map must degrade to activity-only, not throw');
    });
    check('Projects person filter is wired: loader fetches members, render uses the helper, options include members', () => {
      const renderSrc = extractFn(embeddedScript, 'renderProjectsIndex');
      assert.ok(/pxPersonFilter\(/.test(renderSrc), 'renderProjectsIndex does not use the pure helper');
      assert.ok(/personOpts[\s\S]{0,320}feedMembers/.test(renderSrc),
        'person dropdown does not include team members without recent activity');
      assert.ok(embeddedScript.includes('feedMembersByTeam'), 'per-team member map missing');
      const loadPxSrc = extractFn(embeddedScript, 'loadProjectsIndex');
      assert.ok(/ensureFeedMembers\(\)/.test(loadPxSrc), 'projects loader does not kick off the member-list load');
      assert.ok(/feedMembers[\s\S]{0,200}\.map\(/.test(loadPxSrc) && /\bfp = JSON\.stringify\([\s\S]{0,260}feedMembers/.test(loadPxSrc),
        'projects fingerprint ignores the member list — a late member load never repaints the dropdown');
      // Team-context changes must also reset the member cache: ensureFeedMembers
      // caches forever (even an empty no-team result), so joining a team
      // mid-session would otherwise leave feedMembersByTeam empty and reproduce
      // the blank-filter bug until an app reload; leaving keeps ghosts selectable.
      assert.ok(/function resetFeedFilterUnions\(\) \{[\s\S]{0,240}feedMembers = null[\s\S]{0,140}feedMembersByTeam = \{\}/.test(embeddedScript),
        'resetFeedFilterUnions does not reset the member cache — a mid-session team join never loads members');
    });
    check('Projects 1c: latest-entry and sparkline helpers are pure, ts-ordered and clock-injected', () => {
      const pxLatestSrc = extractFn(embeddedScript, 'pxLatestEntry');
      const pxSparkSrc = extractFn(embeddedScript, 'pxSparkCounts');
      assert.ok(pxLatestSrc, 'pxLatestEntry pure helper missing');
      assert.ok(pxSparkSrc, 'pxSparkCounts pure helper missing');
      const pxEntryInProject = new Function('return (' + pxInProjSrc + ')')();
      const pxLatestEntry = new Function('return (' + pxLatestSrc + ')')();
      const pxSparkCounts = new Function('return (' + pxSparkSrc + ')')();
      const p = { name: 'membridge', path: '/w/membridge' };
      // Local-noon clock so the day bucketing is stable in any timezone.
      const now = new Date(2026, 6, 22, 12, 0, 0).getTime();
      const recent = [
        { projectPath: '/w/membridge', ts: new Date(now - 26 * 3600e3).toISOString(), summary: 'older' },
        { projectPath: '/w/membridge', ts: new Date(now - 2 * 3600e3).toISOString(), summary: 'newest' },
        { projectPath: '/w/other', ts: new Date(now).toISOString(), summary: 'other project' },
        { projectPath: '/w/membridge', ts: new Date(now - 20 * 86400e3).toISOString(), summary: 'outside window' },
      ];
      assert.strictEqual(pxLatestEntry(p, recent, pxEntryInProject).summary, 'newest',
        'latest pick must go by ts, not array order');
      assert.strictEqual(pxLatestEntry(p, null, pxEntryInProject), null, 'null feed must not throw');
      const counts = pxSparkCounts(p, recent, pxEntryInProject, now);
      assert.strictEqual(counts.length, 24, 'sparkline must have 24 hourly buckets');
      assert.strictEqual(counts[21], 1, 'the 2h-ago session must land in the 2-hours-back bucket');
      assert.strictEqual(counts.reduce((a, b) => a + b, 0), 1,
        'sessions older than 24h or from other projects leaked into the sparkline');
      assert.strictEqual(pxSparkCounts(p, null, pxEntryInProject, now).reduce((a, b) => a + b, 0), 0,
        'null feed must yield an all-zero sparkline, not throw');
      const pxClipSrc = extractFn(embeddedScript, 'pxClipSummary');
      assert.ok(pxClipSrc, 'pxClipSummary pure helper missing');
      const pxClipSummary = new Function('return (' + pxClipSrc + ')')();
      assert.strictEqual(pxClipSummary('short text', 160), 'short text', 'short summaries must pass through untouched');
      const clipped = pxClipSummary('word '.repeat(60).trim(), 160);
      assert.ok(clipped.length <= 161 && clipped.endsWith('\u2026'), 'long summaries must clip with an ellipsis');
      assert.ok(!/\s\u2026$/.test(clipped), 'clip must land on a word boundary, not trailing space');
      assert.strictEqual(pxClipSummary('x'.repeat(300), 160), 'x'.repeat(160) + '\u2026',
        'an unbreakable string must hard-cut at the limit');
    });
    check('Projects index renders the 1c compact grid with every row action hook intact', () => {
      const rowSrc = extractFn(embeddedScript, 'pxRowHtml');
      const renderSrc = extractFn(embeddedScript, 'renderProjectsIndex');
      assert.ok(/px-hdr/.test(renderSrc) && /Latest session/.test(renderSrc), '1c column header row missing');
      assert.ok(/px-spark/.test(rowSrc) && /px-who/.test(rowSrc), 'sparkline/avatar cells missing from rows');
      assert.ok(/pxClipSummary\(/.test(rowSrc), 'latest-session summary is not length-capped');
      assert.ok(/title="' \+ esc\(summary\)/.test(rowSrc), 'full summary tooltip missing from the latest-session cell');
      assert.ok(/px-row dim/.test(rowSrc), 'paused/dormant rows do not collapse to the dim one-line form');
      ['data-px-open', 'data-px-menu', 'data-px-pause', 'data-px-askdel', 'data-px-dodel', 'data-px-canceldel'].forEach((a) => {
        assert.ok(rowSrc.includes(a), a + ' hook lost in the 1c redesign');
      });
      assert.ok(!rowSrc.includes('Roadmap'), 'the removed Roadmap item is back in the row menu');
      assert.ok(pageHtml.includes('.px-hdr'), '1c grid CSS missing from the stylesheet');
    });
    const bulkFnSrc = extractFn(embeddedScript, 'deleteProjectsBulk');
    check('deleteProjectsBulk helper exists standalone in the embedded script', () => {
      assert.ok(bulkFnSrc, 'deleteProjectsBulk function not found');
    });
    if (bulkFnSrc) {
      const deleteProjectsBulk = new Function('return (' + bulkFnSrc + ');')();
      const okResult = await deleteProjectsBulk(['/a', '/b'], () => Promise.resolve({ ok: true }));
      check('deleteProjectsBulk: all succeed -> both deleted, none failed', () => {
        assert.deepStrictEqual(okResult, { deleted: ['/a', '/b'], failed: [] });
      });
      let calls = 0;
      const partialResult = await deleteProjectsBulk(['/a', '/b', '/c'], (url, opts) => {
        calls++;
        const body = JSON.parse(opts.body);
        if (body.path === '/b') return Promise.reject(new Error('boom'));
        return Promise.resolve({ ok: true });
      });
      check('deleteProjectsBulk: one failure does not stop the loop', () => {
        assert.strictEqual(calls, 3, `loop stopped early after a failure (only ${calls} calls)`);
        assert.deepStrictEqual(partialResult.deleted, ['/a', '/c']);
        assert.deepStrictEqual(partialResult.failed, ['/b']);
      });
      // The server's top-level catch answers a throwing deleteProject with an
      // HTTP 500 (lib/server.js) — fetch RESOLVES on that, so a resolved but
      // not-ok response must land in failed, never in deleted.
      let httpCalls = 0;
      const httpFailResult = await deleteProjectsBulk(['/a', '/b', '/c'], (url, opts) => {
        httpCalls++;
        const body = JSON.parse(opts.body);
        return body.path === '/b'
          ? Promise.resolve({ ok: false, status: 500 })
          : Promise.resolve({ ok: true, status: 200 });
      });
      check('deleteProjectsBulk: a resolved non-2xx response counts as failed, loop continues', () => {
        assert.strictEqual(httpCalls, 3, `loop stopped early on an http error (only ${httpCalls} calls)`);
        assert.deepStrictEqual(httpFailResult.deleted, ['/a', '/c']);
        assert.deepStrictEqual(httpFailResult.failed, ['/b']);
      });
      let fetchCalledOnEmpty = false;
      const emptyResult = await deleteProjectsBulk([], () => { fetchCalledOnEmpty = true; return Promise.resolve({ ok: true }); });
      check('deleteProjectsBulk: empty selection is a no-op', () => {
        assert.deepStrictEqual(emptyResult, { deleted: [], failed: [] });
        assert.ok(!fetchCalledOnEmpty, 'fetch was called for an empty selection');
      });
    }
    const feedRes = await (await fetch(`${base}/api/feed?limit=50`)).json();
    check('/api/feed returns a merged entries array with a degradation flag', () => {
      assert.ok(Array.isArray(feedRes.entries), 'entries is an array');
      assert.ok('teamUnavailable' in feedRes, 'response carries the teamUnavailable flag');
      assert.ok(feedRes.entries.every(e => 'summary' in e && 'origin' in e),
        'every entry is normalized (has origin + summary)');
    });
    // window= over HTTP is a smoke test only (the endpoint clock is the real
    // one, so fixture recency varies); the deterministic floor behavior is
    // covered in-process with an injected `now` and in the buildFeed units.
    const feedWindow = await (await fetch(`${base}/api/feed?limit=1&window=24`)).json();
    check('/api/feed window= is accepted and never shrinks the page below limit', () => {
      assert.ok(Array.isArray(feedWindow.entries), 'entries is an array');
      assert.ok(feedWindow.entries.length >= 1, 'window must never return fewer than limit entries');
    });
    const beforeTs = '2099-01-01T00:00:00Z';
    const feedBefore = await (await fetch(`${base}/api/feed?before=${encodeURIComponent(beforeTs)}&limit=50`)).json();
    check('/api/feed before= filters local entries inclusively by ts', () => {
      assert.ok(feedBefore.entries.filter(e => e.origin === 'local').every(e => String(e.ts) <= beforeTs),
        'all local entries respect the before boundary');
    });
    check('loadState seeds a default catchup read-state', () => {
      const st = util.loadState();
      assert.deepStrictEqual(st.catchup, { lastViewedTs: null, prevViewedTs: null, briefing: null },
        `catchup default missing: ${JSON.stringify(st.catchup)}`);
    });
    // Derive the window from the feed's own timestamps so the test does not
    // depend on which fixtures have been written by this point in the suite.
    const feedAllLocal = await (await fetch(`${base}/api/feed?limit=50`)).json();
    const localAll = feedAllLocal.entries.filter(e => e.origin === 'local');
    const distinctTs = [...new Set(localAll.map(e => String(e.ts)))].sort();
    const sinceTs = distinctTs[1]; // second-oldest: guarantees the oldest entry is excluded
    const feedSince = await (await fetch(`${base}/api/feed?since=${encodeURIComponent(sinceTs)}&limit=50`)).json();
    check('/api/feed since= keeps only local entries at or after the window', () => {
      assert.ok(distinctTs.length >= 2, 'fixture needs >=2 distinct local timestamps to exercise the window');
      const localRows = feedSince.entries.filter(e => e.origin === 'local');
      assert.ok(localRows.length >= 1, 'expected at least one entry inside the window');
      assert.ok(localRows.every(e => String(e.ts) >= sinceTs), 'a local entry older than since= leaked through');
      assert.ok(localRows.length < localAll.length, 'since= did not exclude the older entries');
    });
    const feedSinceFuture = await (await fetch(`${base}/api/feed?since=2099-01-01T00:00:00.000Z&limit=50`)).json();
    check('/api/feed since= in the future drops all local entries', () => {
      assert.strictEqual(feedSinceFuture.entries.filter(e => e.origin === 'local').length, 0,
        'future since window must exclude every local row');
    });

    // Catch-Up read pointer: GET is pure; mark/undo rewrite it. Run sequentially
    // so the pointer transitions are deterministic (mark sets prev=old-last).
    const cu0 = await (await fetch(`${base}/api/catchup`)).json();
    check('GET /api/catchup returns the empty read pointer', () => {
      assert.strictEqual(cu0.lastViewedTs, null, 'lastViewedTs should start null');
      assert.strictEqual(cu0.prevViewedTs, null, 'prevViewedTs should start null');
      assert.strictEqual(cu0.hasBriefing, false, 'no briefing yet');
    });
    const markTs = '2026-07-10T00:00:00.000Z';
    const cu1 = await (await post(`${base}/api/catchup/mark`, { ts: markTs })).json();
    check('POST /api/catchup/mark with a ts sets lastViewedTs and clears prev from null', () => {
      assert.strictEqual(cu1.lastViewedTs, markTs, 'lastViewedTs not set to the given ts');
      assert.strictEqual(cu1.prevViewedTs, null, 'prevViewedTs should be the old (null) lastViewedTs');
    });
    const cu2 = await (await post(`${base}/api/catchup/mark`, {})).json();
    check('POST /api/catchup/mark without a ts stamps now() and shifts prev', () => {
      assert.strictEqual(cu2.prevViewedTs, markTs, 'prevViewedTs must capture the previous lastViewedTs');
      assert.ok(cu2.lastViewedTs && !isNaN(Date.parse(cu2.lastViewedTs)), 'lastViewedTs must be a valid ISO now()');
      assert.ok(cu2.lastViewedTs > markTs, 'now() must sort after the earlier marked ts');
    });
    const cuGet = await (await fetch(`${base}/api/catchup`)).json();
    check('GET /api/catchup reflects the latest mark', () => {
      assert.strictEqual(cuGet.lastViewedTs, cu2.lastViewedTs, 'read pointer did not persist');
    });
    const cu3 = await (await post(`${base}/api/catchup/undo`, {})).json();
    check('POST /api/catchup/undo restores the previous pointer', () => {
      assert.strictEqual(cu3.lastViewedTs, markTs, 'undo must restore lastViewedTs to prevViewedTs');
      assert.strictEqual(cu3.prevViewedTs, null, 'undo must clear prevViewedTs');
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
    const stExtra = await (await post(`${base}/api/settings`, {
      extraTargets: { cursor: true, gemini: true },
    })).json();
    check('settings: extraTargets are opt-in booleans, off by default and independently toggleable', () => {
      assert.deepStrictEqual(st0.extraTargets, { gemini: false, cursor: false, windsurf: false, copilot: false }, 'extraTargets not off by default');
      assert.deepStrictEqual(stExtra.extraTargets, { gemini: true, cursor: true, windsurf: false, copilot: false }, 'extraTargets toggle did not merge correctly');
      const rawCfg = JSON.parse(read(util.configPath()));
      assert.deepStrictEqual(rawCfg.extraTargets, { gemini: true, cursor: true, windsurf: false, copilot: false }, 'extraTargets not persisted');
    });
    // Restore defaults — this config is shared by the rest of the suite.
    await post(`${base}/api/settings`, { extraTargets: { gemini: false, cursor: false, windsurf: false, copilot: false } });
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
    // hookInstalled is already true here: the daemon force-registers the Stop
    // hook at boot (hooks.ensureInstalled), so it is present regardless of the
    // Settings toggle. Disabling still removes it in-session; the next daemon
    // boot re-registers it (unconditional by design).
    const consentLib = require('../lib/consent');
    const stFresh = await (await fetch(`${base}/api/settings`)).json();
    check('settings: hookInstalled + distill fields are reported', () => {
      assert.strictEqual(stFresh.hookInstalled, true, 'daemon should auto-register the Stop hook at boot');
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

    // Multi-Provider Advisor: /api/advisor exposes the provider registry and
    // never leaks a saved key value back to the page.
    await check('server: /api/advisor exposes providers + never leaks key values', async () => {
      await httpPost(PORT, '/api/advisor', { provider: 'openai', apiKey: 'sk-secret', model: 'gpt-4o' });
      const adv = await httpGet(PORT, '/api/advisor');
      assert.strictEqual(adv.provider, 'openai');
      const oai = adv.providers.find(p => p.id === 'openai');
      assert.strictEqual(oai.keySet, true);
      assert.ok(!JSON.stringify(adv).includes('sk-secret'), 'key value leaked to the page');
      const local = adv.providers.find(p => p.id === 'local');
      assert.strictEqual(local.needsBaseUrl, true);
    });
    // Restore the default provider so later checks (which assume Anthropic)
    // are unaffected by this test's provider switch.
    await post(`${base}/api/settings`, { advisor: { provider: 'anthropic' } });

    // Review fix: clearing the anthropic key through /api/advisor must retire the
    // legacy top-level advisor.apiKey, so an explicit clear actually takes effect
    // instead of the legacy value continuing to win via getAdvisorConfig's
    // !pconf.apiKey fallback. Seed a legacy flat config, clear, then restore.
    {
      const savedAdvisor = util.loadUserConfig().advisor;
      const rcLegacy = util.loadUserConfig();
      rcLegacy.advisor = { apiKey: 'sk-legacy-clear', model: 'claude-haiku-4-5' };
      util.saveUserConfig(rcLegacy);
      const beforeClear = advisorLib.getAdvisorConfig(util.getConfig());
      await httpPost(PORT, '/api/advisor', { provider: 'anthropic', apiKey: '' });
      const afterClear = advisorLib.getAdvisorConfig(util.getConfig());
      await check('advisor: clearing the anthropic key retires the legacy top-level key', () => {
        assert.strictEqual(beforeClear.apiKey, 'sk-legacy-clear', 'precondition: legacy key should be active');
        assert.strictEqual(afterClear.apiKey, '', 'legacy key still winning after explicit clear: ' + JSON.stringify(afterClear.apiKey));
      });
      const rcRestore = util.loadUserConfig();
      if (savedAdvisor === undefined) delete rcRestore.advisor; else rcRestore.advisor = savedAdvisor;
      util.saveUserConfig(rcRestore);
    }

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

    // The ingestion gate means a deleted project stays deleted: new activity
    // in its (now untracked) cwd is dropped, never auto-revived. Re-adding the
    // project through the dashboard, plus fresh activity, brings it back.
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Dropped while deleted' }, cwd: proj1, timestamp: '2026-07-09T12:00:00.000Z' }) + '\n',
    );
    await post(`${base}/api/sync`);
    const afterDrop = await (await fetch(`${base}/api/projects`)).json();
    check('deleted project does NOT reappear from new activity alone (ingestion gate)', () => {
      assert.ok(!afterDrop.some(x => x.path.toLowerCase() === proj1.toLowerCase()), 'deleted project auto-revived from an untracked cwd');
    });

    await post(`${base}/api/projects/add`, { path: proj1 });
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Ship the checkout flow' }, cwd: proj1, timestamp: '2026-07-09T12:01:00.000Z' }) + '\n',
    );
    await post(`${base}/api/sync`);
    const afterRevive = await (await fetch(`${base}/api/projects`)).json();
    check('re-added project picks up new activity again', () => {
      const p = afterRevive.find(x => x.path.toLowerCase() === proj1.toLowerCase());
      assert.ok(p, 'deleted project did not reappear');
      assert.ok(p.prompts.some(e => e.text.includes('Ship the checkout flow')), 'new prompt missing');
      assert.ok(!p.prompts.some(e => e.text.includes('Dropped while deleted')), 'gate-dropped prompt resurfaced');
    });

    process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17944'; // in-process advisor -> the same mock
    const briefNoKey = await advisorLib.generateBriefing('', 'claude-sonnet-5', { since: null, teammates: [] });
    const briefOk = await advisorLib.generateBriefing(GOOD_KEY, 'claude-sonnet-5', {
      since: '2026-07-10T00:00:00.000Z', until: '2026-07-14T00:00:00.000Z',
      teammates: [
        { name: 'Andrew', entries: [{ ts: '2026-07-11T09:00:00.000Z', source: 'Claude Code', ask: 'Wire the receipt PDF', summary: 'Receipts now email a PDF', files: ['pay.js'], project: 'shop-app' }] },
        { name: 'Dana', entries: [{ ts: '2026-07-12T09:00:00.000Z', source: 'Codex', ask: 'Add refund guardrails', summary: null, files: [], project: 'shop-app' }] },
      ],
    });
    check('briefing: generateBriefing needs a key and turns teammate activity into prose', () => {
      assert.ok(briefNoKey.error && !briefNoKey.text, 'no-key path must return { error }, not text');
      assert.ok(briefOk.text && !briefOk.error, `expected { text }, got ${JSON.stringify(briefOk)}`);
      assert.ok(lastBriefingRequest, 'mock never saw a briefing request');
      assert.ok(!lastBriefingRequest.output_config, 'a briefing must be plain text, never json_schema');
      assert.strictEqual(lastBriefingRequest.max_tokens, 1200);
      assert.strictEqual(lastBriefingRequest.thinking.type, 'disabled', 'sonnet must run with thinking off');
      assert.ok(lastBriefingRequest.system.includes('catch-up'), 'briefing system prompt missing');
      const userMsg = lastBriefingRequest.messages[0].content;
      assert.ok(userMsg.includes('Andrew') && userMsg.includes('Dana'), 'teammate activity missing from the prompt');
      assert.ok(userMsg.includes('Wire the receipt PDF') || userMsg.includes('Receipts now email a PDF'), 'ask/summary missing');
    });

    await check('advisors/anthropic: generate returns text + normalized usage', async () => {
      process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17944'; // existing Anthropic mock
      const a = advisors.byId('anthropic');
      const r = await a.generate({ apiKey: GOOD_KEY, model: 'claude-sonnet-5', system: 'sys', prompt: 'hi', schema: null, maxTokens: 200 });
      assert.ok(r.text && typeof r.text === 'string', 'no text');
      assert.ok(Number.isFinite(r.usage.input_tokens), 'usage not normalized');
      assert.strictEqual(a.priceFor('claude-haiku-4-5')[0], 1);
    });

    await check('advisors/openai: chat-completions request shape + normalized usage', async () => {
      let seen = null;
      const srv = await startJsonMock(17960, (req, body, send) => {
        seen = { url: req.url, body };
        if (req.method === 'GET' && /\/models$/.test(req.url)) return send(200, { data: [{ id: 'gpt-4o' }] });
        send(200, { choices: [{ message: { content: '{"summary":"ok","phases":[],"risks":[],"questions":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      });
      try {
        const a = advisors.byId('openai');
        const r = await a.generate({ apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:17960/v1', model: 'gpt-4o', system: 's', prompt: 'p', schema: { type: 'object' }, maxTokens: 300 });
        assert.strictEqual(seen.body.response_format.type, 'json_schema');
        assert.strictEqual(seen.body.messages[0].role, 'system');
        assert.strictEqual(r.usage.input_tokens, 10);
        assert.strictEqual(r.usage.output_tokens, 5);
        const test = await a.testKey({ apiKey: 'sk-x', baseUrl: 'http://127.0.0.1:17960/v1' });
        assert.strictEqual(test.ok, true);
      } finally { srv.close(); }
    });

    await check('advisors/google: generateContent shape + schema sanitized + usage', async () => {
      let seen = null;
      const srv = await startJsonMock(17961, (req, body, send) => {
        seen = { url: req.url, body };
        if (req.method === 'GET' && /\/models/.test(req.url)) return send(200, { models: [] });
        send(200, { candidates: [{ content: { parts: [{ text: '{"summary":"ok","phases":[],"risks":[],"questions":[]}' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 } });
      });
      try {
        const a = advisors.byId('google');
        const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
        const r = await a.generate({ apiKey: 'g-x', baseUrl: 'http://127.0.0.1:17961', model: 'gemini-2.0-flash', system: 's', prompt: 'p', schema, maxTokens: 300 });
        assert.ok(!JSON.stringify(seen.body.generationConfig.responseSchema).includes('additionalProperties'));
        assert.strictEqual(seen.body.generationConfig.responseMimeType, 'application/json');
        assert.strictEqual(r.usage.input_tokens, 12);
        assert.strictEqual(r.usage.output_tokens, 7);
      } finally { srv.close(); }
    });

    // --- Multi-provider advisor: registry + shared helpers ---
    check('advisors: registry lists providers and looks them up by id', () => {
      assert.deepStrictEqual(advisors.list().map(a => a.id), ['anthropic', 'openai', 'google', 'local']);
      assert.strictEqual(advisors.byId('openai').label, 'OpenAI (GPT)');
      assert.strictEqual(advisors.byId('nope'), null);
    });
    check('advisors: extractJson recovers an object from surrounding prose', () => {
      assert.deepStrictEqual(advisors.extractJson('sure!\n{"a":1,"b":[2,3]}\ndone'), { a: 1, b: [2, 3] });
      assert.strictEqual(advisors.extractJson('no json here'), null);
    });

    await check('advisors/local: needs base URL, no schema support, prices unknown', async () => {
      const a = advisors.byId('local');
      assert.strictEqual(a.needsBaseUrl, true);
      assert.strictEqual(a.supportsSchema, false);
      assert.deepStrictEqual(a.priceFor('anything'), [0, 0]);
      const noBase = await a.generate({ apiKey: '', baseUrl: '', model: 'llama3.1', system: 's', prompt: 'p', schema: null, maxTokens: 100 });
      assert.ok(noBase.error && /base URL/i.test(noBase.error), 'should demand a base URL');

      const srv = await startJsonMock(17962, (req, body, send) => {
        send(200, { choices: [{ message: { content: 'here you go {"summary":"ok","phases":[],"risks":[],"questions":[]}' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
      });
      try {
        const r = await a.generate({ apiKey: '', baseUrl: 'http://127.0.0.1:17962/v1', model: 'llama3.1', system: 's', prompt: 'p', schema: null, maxTokens: 100 });
        assert.ok(r.text.includes('summary'), 'returns raw text');
        assert.strictEqual(r.usage.input_tokens, 3);
      } finally { srv.close(); }
    });

    // --- Task 6: advisor.js delegates to provider adapters ---
    check('advisor: getAdvisorConfig migrates legacy anthropic key + reads providers', () => {
      let cfg = { advisor: { apiKey: 'sk-legacy', model: 'claude-opus-4-8' } };
      let a = advisorLib.getAdvisorConfig(cfg);
      assert.strictEqual(a.provider, 'anthropic');
      assert.strictEqual(a.apiKey, 'sk-legacy');
      assert.strictEqual(a.model, 'claude-opus-4-8');
      assert.strictEqual(a.baseUrl, '');
      cfg = { advisor: { provider: 'openai', providers: { openai: { apiKey: 'sk-oai', model: 'gpt-4o' } } } };
      a = advisorLib.getAdvisorConfig(cfg);
      assert.strictEqual(a.provider, 'openai');
      assert.strictEqual(a.apiKey, 'sk-oai');
      assert.strictEqual(a.model, 'gpt-4o');
      cfg = { advisor: { provider: 'local', providers: { local: { baseUrl: 'http://h/v1', model: 'llama3.1' } } } };
      a = advisorLib.getAdvisorConfig(cfg);
      assert.strictEqual(a.provider, 'local');
      assert.strictEqual(a.baseUrl, 'http://h/v1');
      assert.strictEqual(a.model, 'llama3.1');
      // Regression: a legacy user who sets ONLY a model (via the new UI) creates a
      // partial providers.anthropic entry with no key — the legacy top-level key
      // must still survive rather than being shadowed to ''.
      cfg = { advisor: { apiKey: 'sk-legacy', model: 'claude-haiku-4-5', providers: { anthropic: { model: 'claude-opus-4-8' } } } };
      a = advisorLib.getAdvisorConfig(cfg);
      assert.strictEqual(a.apiKey, 'sk-legacy', 'legacy key dropped by a model-only providers entry');
      assert.strictEqual(a.model, 'claude-opus-4-8');
      assert.strictEqual(a.source, 'config');
    });
    await check('advisor: generatePlan routes to the selected provider', async () => {
      const srv = await startJsonMock(17963, (req, body, send) => {
        if (req.method === 'GET') return send(200, { data: [] });
        send(200, { choices: [{ message: { content: '{"summary":"S","phases":[],"risks":[],"questions":[]}' } }], usage: { prompt_tokens: 8, completion_tokens: 9 } });
      });
      try {
        const r = await advisorLib.generatePlan('sk-oai', 'gpt-4o', { projectName: 'p', goal: 'g', recentAsks: [] }, { provider: 'openai', baseUrl: 'http://127.0.0.1:17963/v1' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.plan.summary, 'S');
        assert.ok(r.costUsd >= 0);
      } finally { srv.close(); }
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
    check('dashboard: team payload surfaces member count and creation date', () => {
      const t = dashboardTeam.teams.find(x => x.team_id === team.team_id);
      assert.ok(t, 'team missing from payload');
      assert.strictEqual(t.memberCount, 1, `expected 1 member, got ${t.memberCount}`);
      assert.ok(t.createdAt && !Number.isNaN(Date.parse(t.createdAt)), 'createdAt missing or unparseable');
      // raw RPC columns are preserved for older consumers
      assert.ok('member_count' in t && 'created_at' in t, 'raw RPC columns dropped');
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
    // Now-relative timestamps: the injected team slice drops entries older
    // than teamMaxAgeHours, so rendered fixtures must stay fresh at any run
    // date. The final assistant text (>=80 chars) becomes the session summary.
    const tsAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
    const MARCO_SUMMARY = 'Receipt PDF wiring is done end to end: template, storage upload and the email attachment all pass the smoke test.';
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add the order confirmation email' }, cwd: proj1, timestamp: tsAgo(90) }) + '\n' +
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Wire the receipt PDF, api_key=sk-test1234567890abcdef' }, cwd: proj1, timestamp: tsAgo(60) }) + '\n' +
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: MARCO_SUMMARY }] }, cwd: proj1, timestamp: tsAgo(30) }) + '\n',
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
    check('status: teamLastSync records a real wall-clock time after a successful sync', () => {
      const before = statusPayload();
      assert.ok(before.teamLastSync, 'teamLastSync missing after a successful team sync');
      assert.ok(!Number.isNaN(Date.parse(before.teamLastSync)), 'teamLastSync is not an ISO timestamp');
      // distinct field from the local injection time
      assert.ok('lastSync' in before, 'lastSync field disappeared');
    });

    const pushedCount = mock.entries.length;
    await teamsync.syncTeams();
    check('team: re-sync is idempotent (cursor + server dedupe)', () => {
      assert.strictEqual(mock.entries.length, pushedCount, 'duplicate entries pushed');
    });

    // A row the client never scrubbed (tampered server, hostile backend),
    // planted straight into the mock: render-side redaction must catch it.
    mock.entries.push({
      project_id: linkA.projectId, author_id: credsA.userId, author_name: 'Marco',
      ts: tsAgo(10), source: 'Codex',
      ask: 'rotate the deploy key api_key=sk-tamper111122223333',
      files: [], summary: 'stored the new key api_key=sk-tamper444455556666 in the vault note',
      id: mock.entries.length + 1, created_at: new Date().toISOString(),
    });

    // Option A — a distilled row on the backend must arrive at the puller with
    // distilled:true preserved (pull selects + stores the column). Distinct
    // (ts, source) so it is its own pulled entry, not deduped against another;
    // an old ts keeps it from perturbing later newest-first feed-order asserts
    // (the pull check below finds it by summary text, not position).
    mock.entries.push({
      project_id: linkA.projectId, author_id: credsA.userId, author_name: 'Marco',
      ts: '2026-07-11T09:00:00.000Z', source: 'Claude Code',
      ask: null, files: [], summary: 'Distilled outcome that must stay flagged distilled',
      distilled: true,
      id: mock.entries.length + 1, created_at: new Date().toISOString(),
    });


    // Andrew: second machine (own MemBridge home), same repo basename, joins
    // by invite code — link_project maps his clone to the same project row.
    const projB = path.join(ROOT, 'projects-b', 'shop-app');
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projB, 'CLAUDE.md'), '# B clone\n\nAndrew notes.\n');
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-b');
    util.ensureConfig();
    {
      // Marco's pull asserts Andrew's verbatim ask, so this home opts in too.
      const cfgB = util.loadUserConfig();
      cfgB.team = { ...(cfgB.team || {}), sharePrompts: true, encrypt: false }; // legacy plaintext home — hatch keeps it off the real keychain
      util.saveUserConfig(cfgB);
    }
    const stateB = util.loadState();
    stateB.projects = {
      [projB]: {
        events: [{ ts: tsAgo(45), source: 'Codex', kind: 'prompt', text: 'Refactor checkout validation', session: 'b1' }],
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
    check("team: Andrew pulls Marco's latest ask into his context block", () => {
      assert.ok(rB.changed.some(k => sameKey(k, projB)), `changed said: ${JSON.stringify(rB)}`);
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(md.startsWith('# B clone'), 'his own notes were lost');
      assert.ok(md.includes("Teammates' AI activity"), 'team section missing');
      assert.ok(md.includes('Marco'), 'author name missing');
      assert.ok(md.includes('Wire the receipt PDF'), "Marco's latest ask missing");
      assert.ok(!md.includes('sk-test1234567890abcdef'), 'secret leaked into teammate file');
    });

    check('team: a pushed summary is pulled intact and renders as a Did line', () => {
      assert.ok(mock.entries.some(e => e.summary && e.summary.includes('smoke test')),
        'summary missing from the pushed rows');
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => sameKey(k, projB));
      // Specific to the smoke-test row: other summary-bearing teammate entries
      // now share the feed (e.g. the distilled round-trip fixture), so a bare
      // find-first would pick whichever sorts earliest, not this one.
      const pulled = (st.projects[key].teamEntries || []).find(e => e.summary && e.summary.includes('smoke test'));
      assert.ok(pulled, 'no pulled entry carries the smoke-test summary');
      assert.ok(pulled.summary.includes('smoke test'), `summary was: ${pulled.summary}`);
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(md.includes('Did: '), 'Did line missing from the team section');
      assert.ok(md.includes('smoke test'), 'summary text missing from the team section');
    });

    check('team: pull preserves the distilled flag on a distilled row (Option A round-trip)', () => {
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => sameKey(k, projB));
      const pulled = (st.projects[key].teamEntries || [])
        .find(e => e.summary && e.summary.includes('must stay flagged distilled'));
      assert.ok(pulled, 'the distilled row was not pulled into teamEntries');
      assert.strictEqual(pulled.distilled, true, 'distilled flag was dropped over pull');
    });

    check('team: injection collapses each teammate session to its newest entry; state keeps all', () => {
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => sameKey(k, projB));
      assert.ok(st.projects[key].teamEntries.length >= 3, 'full pulled history not kept in state');
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(!md.includes('Ship the checkout flow'), 'older entry of the same session still injected');
      assert.ok(!md.includes('order confirmation email'), 'superseded ask still injected');
    });

    // Render-side defense in depth against the tampered row planted above.
    check('team: a pulled ask and summary are re-redacted at render time', () => {
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(md.includes('rotate the deploy key'), 'tampered entry not rendered');
      assert.ok(md.includes('stored the new key'), 'tampered summary not rendered');
      assert.ok(!md.includes('sk-tamper111122223333') && !md.includes('sk-tamper444455556666'),
        'raw secret reached the rendered block');
      assert.ok(count(md, '[redacted') >= 3, 'redaction markers missing');
    });

    // Merge cleanup: drop the planted tamper row so it can't pollute the
    // shared mock read by later feed tests.
    for (let ti = mock.entries.length - 1; ti >= 0; ti--) {
      if (String(mock.entries[ti].ask).includes('sk-tamper111122223333')) mock.entries.splice(ti, 1);
    }

    // A hosted backend whose schema predates the summary column must not kill
    // the push — the client drops the field and retries.
    fs.appendFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess1.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Tighten the refund policy checks' }, cwd: proj1, timestamp: tsAgo(20) }) + '\n',
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

    // Injection trimming knobs, against renderBlock directly: the cap, the age
    // window, their fallbacks, and that the state array is never trimmed.
    const trimProj = path.join(ROOT, 'projects', 'trim-app');
    fs.mkdirSync(trimProj, { recursive: true });
    const mkEntry = (i, over) => ({
      author: `Dev${i}`, ts: tsAgo(600 - i), source: 'Claude Code',
      ask: `team ask ${i}`, files: [], summary: null, ...over,
    });
    const trimState = { events: [], teamEntries: Array.from({ length: 12 }, (_, i) => mkEntry(i)) };
    trimState.teamEntries[11].files = ['lib/pay.js'];
    const cfgBase = util.getConfig();
    const mdOf = over => digest.renderBlock(trimProj, trimState, { ...cfgBase, ...over }, 'CLAUDE.md');
    check('team: teamInjectMax caps the injected slice, newest entries win', () => {
      const md = mdOf({});
      assert.strictEqual(count(md, 'team ask '), 8, 'default cap is not 8');
      assert.ok(md.includes('team ask 4') && !md.includes('team ask 3'), 'not the newest entries');
      assert.ok(md.includes('Files: lib/pay.js'), 'files line missing');
      assert.ok(!md.includes('Did:'), 'summary-less entries rendered a Did line');
      const md3 = mdOf({ teamInjectMax: 3 });
      assert.strictEqual(count(md3, 'team ask '), 3, 'explicit cap not honored');
      assert.ok(md3.includes('team ask 9') && !md3.includes('team ask 8'), 'cap did not keep the newest');
      assert.strictEqual(trimState.teamEntries.length, 12, 'state array was truncated by the injection trim');
    });
    check('team: teamMaxAgeHours drops stale entries from the injected slice only', () => {
      const stale = { events: [], teamEntries: [
        mkEntry(0, { ts: new Date(Date.now() - 100 * 3600000).toISOString(), ask: 'stale ask' }),
        mkEntry(1, { ask: 'fresh ask' }),
      ] };
      const md = digest.renderBlock(trimProj, stale, cfgBase, 'CLAUDE.md');
      assert.ok(md.includes('fresh ask') && !md.includes('stale ask'), 'default 72h window wrong');
      const mdWide = digest.renderBlock(trimProj, stale, { ...cfgBase, teamMaxAgeHours: 200 }, 'CLAUDE.md');
      assert.ok(mdWide.includes('stale ask'), 'a wider window did not keep the older entry');
      assert.strictEqual(stale.teamEntries.length, 2, 'state array was truncated');
    });
    check('team: non-finite or sub-1 trim knobs fall back to the defaults', () => {
      const md = mdOf({ teamInjectMax: 0, teamMaxAgeHours: 'soon' });
      assert.strictEqual(count(md, 'team ask '), 8, 'fallback cap is not 8');
    });
    check('team: checkpoints from one teammate session inject only the newest', () => {
      const sess = { events: [], teamEntries: [
        mkEntry(0, { author: 'Pat', session: 's9', ts: tsAgo(300), ask: 'checkpoint one', summary: 'first third done' }),
        mkEntry(1, { author: 'Pat', session: 's9', ts: tsAgo(200), ask: 'checkpoint two', summary: 'two thirds done' }),
        mkEntry(2, { author: 'Pat', session: 's9', ts: tsAgo(100), ask: 'checkpoint three', summary: 'session complete, all tests green' }),
      ] };
      const md = digest.renderBlock(trimProj, sess, cfgBase, 'CLAUDE.md');
      assert.strictEqual(count(md, 'checkpoint '), 1, 'session not collapsed to one entry');
      assert.ok(md.includes('checkpoint three') && md.includes('session complete'), 'newest checkpoint missing');
      assert.strictEqual(count(md, 'Did: '), 1, 'expected exactly one Did line');
      assert.strictEqual(sess.teamEntries.length, 3, 'state array was truncated');
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

    // Regression: pushProject/pullProject used to drop each entry's session
    // id entirely, so teamInjectSlice's per-(author, session) dedup silently
    // fell back to per-(author, source) — collapsing a teammate's genuinely
    // distinct sessions on the same tool into just the newest one, dropping
    // real work from the injected block even though the live dashboard feed
    // (a separate, session-agnostic RPC read) still showed all of it. Drives
    // the FULL pullProject -> syncOnce -> inject path end to end (no hand-fed
    // teamEntries) so it actually exercises the wire format, not just
    // digest.renderBlock's already-correct collapsing logic in isolation.
    process.env.MEMBRIDGE_HOME = HOME_A;
    fs.writeFileSync(
      path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'sess2.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Add inventory tracking for warehouse SKUs' }, cwd: proj1, timestamp: tsAgo(5) }) + '\n',
    );
    syncOnce(); // fold Marco's new, distinct session into proj1's local history
    const rA3 = await teamsync.syncTeams(); // home A: push the new session's entry
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-b'); // Andrew's home (HOME_B is bound later, below)
    const rB2 = await teamsync.syncTeams(); // home B: pull it
    for (const k of rB2.changed) syncOnce({ project: k });
    check("team: a teammate's distinct sessions on the same tool both survive injection", () => {
      assert.ok(rA3.synced.some(k => sameKey(k, proj1)), `push said: ${JSON.stringify(rA3)}`);
      assert.ok(rB2.changed.some(k => sameKey(k, projB)), `pull said: ${JSON.stringify(rB2)}`);
      const md = read(path.join(projB, 'CLAUDE.md'));
      assert.ok(md.includes('Add inventory tracking for warehouse SKUs'), "Marco's new (sess2) ask missing");
      // sess1's own latest ask ("Tighten the refund policy checks", pushed
      // earlier in this section) must still show up alongside sess2's —
      // without the fix both entries carry no session id, collapse to one
      // (author, source) key, and only the chronologically newest survives.
      assert.ok(md.includes('Tighten the refund policy checks'), "Marco's other session (sess1) was wrongly collapsed away by the newer sess2 entry");
    });
    process.env.MEMBRIDGE_HOME = HOME_A;

    // check() is synchronous (fn() is called and awaited via try/catch only
    // for synchronous throws) — an async fn would resolve after check() has
    // already recorded a pass, making the assertions vacuous. So the async
    // work is awaited here first, and a plain synchronous check() verifies
    // the already-settled result, mirroring how every other awaited team
    // assertion in this block is structured (await ...; check(() => {...})).
    const savedTeamUrl = process.env.MEMBRIDGE_TEAM_URL;
    process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:1'; // unreachable -> teamUnavailable
    let offlineFeedRes;
    try {
      offlineFeedRes = await feedPayload({ limit: 50 });
    } finally {
      process.env.MEMBRIDGE_TEAM_URL = savedTeamUrl;
    }
    check('feed: offline (degraded) branch still names teammates from cached teamEntries', () => {
      assert.strictEqual(offlineFeedRes.teamUnavailable, true, 'expected degraded feed');
      assert.ok(Array.isArray(offlineFeedRes.offlineTeammates), 'offlineTeammates should be an array');
      assert.ok(offlineFeedRes.offlineTeammates.length >= 1, 'no teammate names derived from cached teamEntries');
      assert.ok(!offlineFeedRes.offlineTeammates.includes('You'), 'self should not appear as a teammate');
    });

    const goalChangesFeed = await feedPayload({ limit: 10 });
    check('feedPayload: entries expose goal + changes', () => {
      const e = (goalChangesFeed.entries || [])[0];
      if (e) { assert.ok('goal' in e, 'goal key present'); assert.ok('changes' in e, 'changes key present'); }
    });

    // Rolling-window floor (Activity "always show the last 24h"): window=
    // must lift a small limit so page one covers every entry inside the
    // window, and a before= page (the View more path) must bypass the floor —
    // otherwise every older page would re-inflate back to the window size.
    // `now` is injected so the fixture's fixed 2026-07-09 timestamps stay
    // inside the window forever (no time bombs, per the teamMaxAgeHours rule).
    const pinnedNow = '2026-07-09T20:00:00.000Z';
    const windowCutoff = '2026-07-08T20:00:00.000Z';
    const oneFeed = await feedPayload({ limit: 1 });
    const windowFeed = await feedPayload({ limit: 1, window: 24, now: pinnedNow });
    const wfBoundary = (windowFeed.entries[1] || {}).ts || windowCutoff;
    const windowBeforeFeed = await feedPayload({ limit: 1, window: 24, now: pinnedNow, before: wfBoundary });
    check('feedPayload: window= lifts the limit to cover the last 24h; before= bypasses the floor', () => {
      assert.strictEqual(oneFeed.entries.length, 1, 'control: limit=1 without window returns one entry');
      assert.ok(windowFeed.entries.length >= 3,
        'fixture must hold >=3 entries inside the pinned window to exercise the floor; got ' + windowFeed.entries.length);
      assert.ok(windowFeed.entries.every(e => String(e.ts) >= windowCutoff),
        'page one leaked an entry older than the window');
      assert.strictEqual(windowBeforeFeed.entries.length, 1,
        'a before= page must honor the plain limit, not the window floor');
      assert.strictEqual(String(windowBeforeFeed.entries[0].ts), String(wfBoundary),
        'the before= boundary is inclusive');
    });

    check('dashboard: card render includes Intent + changesHtml wiring', () => {
      const dashboard = require('../lib/dashboard');
      const html = dashboard.dashboardPage();
      assert.ok(/changesHtml/.test(html), 'changesHtml helper present');
      assert.ok(/Intent/.test(html), 'Intent label present');
      // Both card builders (feedEntryHtml for the main/project feed and
      // catchupCardHtml for the Catch-Up headlines + Everything view) must
      // call changesHtml — one match would mean only one path renders the
      // triad, silently leaving the other on the old summary+files render.
      assert.ok((html.match(/changesHtml\(/g) || []).length >= 2, 'changes rendered in both card paths');
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

    // Migration 004: team_feed must return teammates' `summary`. Seed a team
    // entry that carries one, then prove it survives the whole read path:
    // team_feed RPC -> feed.normalizeTeam -> /api/feed merged read-model.
    const seedTemplate = feedAll[0]; // a confirmed team_feed row for team.team_id
    mock.entries.push({
      ...seedTemplate,
      id: mock.entries.length + 1,
      ts: '2026-07-13T10:00:00.000Z',
      source: 'Claude Code',
      ask: 'Wire the receipt PDF and refund guardrails',
      summary: 'Checkout now emails a receipt PDF; refunds are the next milestone.',
      goal: 'Ship the receipt PDF',
      decisions: 'Generate PDFs synchronously for now.',
      gotchas: 'Large carts can push generation past 2s.',
      changes: [{ file: 'lib/receipts.js', status: 'new', add: 40, del: 0, note: 'PDF renderer', dep: false }],
      created_at: new Date(Date.now() + 5000).toISOString(),
    });
    const feedSummaryRes = await (await fetch(`${hubBase}/api/feed?limit=50`)).json();
    // NOTE: exercises the read path (team_feed RPC -> normalizeTeam -> /api/feed). The mock cannot model Postgres's create-or-replace return-type constraint, so migration 008 itself must be validated against real Postgres before deploy.
    check('/api/feed surfaces teammate summaries end-to-end (read path)', () => {
      const teamEntry = feedSummaryRes.entries.find(e => e.origin === 'team' && e.summary);
      assert.ok(teamEntry, 'at least one team entry carries a non-null summary');
      assert.ok(/receipt PDF/.test(teamEntry.summary), `summary text lost: ${teamEntry && teamEntry.summary}`);
    });
    // Migration 008: team_feed must also return goal/decisions/gotchas/changes.
    check('/api/feed surfaces teammate goal/decisions/changes end-to-end (read path)', () => {
      const teamEntry = feedSummaryRes.entries.find(e => e.origin === 'team' && e.goal === 'Ship the receipt PDF');
      assert.ok(teamEntry, 'no team entry carries the seeded goal');
      assert.strictEqual(teamEntry.decisions, 'Generate PDFs synchronously for now.');
      assert.ok(Array.isArray(teamEntry.changes) && teamEntry.changes.some(c => c.file === 'lib/receipts.js'),
        `changes missing from feed entry: ${JSON.stringify(teamEntry.changes)}`);
    });

    // Phase 1: /api/feed?since threads through to the team_feed RPC p_since arg.
    // The receipt-PDF row above (ts 2026-07-13T10:00Z) is the recent fixture.
    const teamSinceHit = await (await fetch(
      `${hubBase}/api/feed?since=2026-07-13T09:00:00.000Z&limit=50`)).json();
    const teamSinceMiss = await (await fetch(
      `${hubBase}/api/feed?since=2099-01-01T00:00:00.000Z&limit=50`)).json();
    check('/api/feed since= forwards to team_feed p_since (both directions)', () => {
      assert.ok(teamSinceHit.entries.some(e => e.origin === 'team' && /receipt PDF/.test(e.summary || '')),
        'recent team row should pass the since window');
      assert.strictEqual(teamSinceMiss.entries.filter(e => e.origin === 'team').length, 0,
        'future since window must exclude every team row');
    });

    // Regression (Critical): the project page filters /api/feed by a local
    // filesystem path (`?project=/abs/path`), but team_feed's p_project is a
    // uuid. feedPayload must resolve a LINKED local path -> its team-project
    // uuid before querying, or every teammate row for the project silently
    // vanishes. proj1 is linked to linkA.projectId (shop-app); the mock's
    // team_feed filters rows by p_project, so a path that isn't resolved
    // matches nothing.
    const feedByPath = await (await fetch(
      `${hubBase}/api/feed?project=${encodeURIComponent(proj1)}&limit=50`)).json();
    check('/api/feed resolves a linked local path to the team uuid so teammate rows survive', () => {
      assert.strictEqual(feedByPath.teamUnavailable, false, 'team query must not be flagged unavailable');
      const teamRow = feedByPath.entries.find(e => e.origin === 'team');
      assert.ok(teamRow, 'no team-origin row for the linked project — path was not resolved to its uuid');
    });

    // Regression: the feed is a READ path over server rows — a hostile or
    // legacy backend row holding unredacted text must be re-redacted at the
    // normalize boundary, mirroring the injection path's render-side tamper
    // test above. Planted straight into the mock, never through push scrub.
    mock.entries.push({
      ...seedTemplate,
      id: mock.entries.length + 1,
      ts: '2026-07-13T10:05:00.000Z',
      source: 'Codex',
      ask: 'tampered feed ask, rotate api_key=sk-feedtamper1111 today',
      summary: 'tampered feed summary stored api_key=sk-feedtamper2222 in plain text',
      created_at: new Date(Date.now() + 6000).toISOString(),
    });
    // A prompt-gated row (ask null): redaction must not turn it into "null".
    mock.entries.push({
      ...seedTemplate,
      id: mock.entries.length + 1,
      ts: '2026-07-13T10:06:00.000Z',
      source: 'Claude Code',
      ask: null,
      summary: 'gated row: summary only',
      created_at: new Date(Date.now() + 7000).toISOString(),
    });
    const feedTamperRes = await (await fetch(`${hubBase}/api/feed?limit=50`)).json();
    check('/api/feed re-redacts server-row ask and summary (read-side defense in depth)', () => {
      const row = feedTamperRes.entries.find(e => e.origin === 'team' && e.ask.includes('tampered feed ask'));
      assert.ok(row, 'planted feed-tamper row missing from /api/feed');
      assert.ok(row.ask.includes('[redacted'), `tampered ask not redacted: ${row.ask}`);
      assert.ok(row.summary.includes('[redacted'), `tampered summary not redacted: ${row.summary}`);
      const body = JSON.stringify(feedTamperRes);
      assert.ok(!body.includes('sk-feedtamper1111') && !body.includes('sk-feedtamper2222'),
        'raw planted secret surfaced in the /api/feed response');
      // Redaction must be surgical: the clean seeded summary passes untouched.
      const clean = feedTamperRes.entries.find(e => e.origin === 'team' && /receipt PDF;/.test(e.summary || ''));
      assert.ok(clean && /refunds are the next milestone/.test(clean.summary), 'clean summary was altered by redaction');
    });
    check('/api/feed keeps a null ask falsy for the "(prompt not shared)" rendering', () => {
      const gated = feedTamperRes.entries.find(e => e.origin === 'team' && e.summary === 'gated row: summary only');
      assert.ok(gated, 'gated null-ask row missing from /api/feed');
      assert.strictEqual(gated.ask, '', `null ask must normalize to '', got: ${JSON.stringify(gated.ask)}`);
    });
    // Regression: your own UNSHARED session is pushed to the team with a null
    // ask and returns as a self-authored team row. Left in, it renders a phantom
    // "(prompt not shared)" duplicate of the local prompt you can already read in
    // full — "I can't see my own messages". feedPayload must drop the self twin
    // matching a local entry on (session, ts), keeping the local original intact.
    const selfLocal = feedTamperRes.entries.find(e => e.origin === 'local' && e.self && e.session && e.ask);
    check('/api/feed exposes a local self entry to base the phantom-twin test on', () => {
      assert.ok(selfLocal, 'no local self entry with a session+ask in the feed');
    });
    if (selfLocal) {
      mock.entries.push({
        ...seedTemplate,
        id: mock.entries.length + 1,
        author_id: credsA.userId, author_name: 'Marco',
        ts: selfLocal.ts, session: selfLocal.session, source: selfLocal.source,
        ask: null, summary: 'phantom twin: summary only',
        created_at: new Date(Date.now() + 8000).toISOString(),
      });
      const feedPhantomRes = await (await fetch(`${hubBase}/api/feed?limit=50`)).json();
      check('/api/feed drops the unshared self twin so your own prompt is never masked', () => {
        const twin = feedPhantomRes.entries.find(e => e.origin === 'team'
          && e.session === selfLocal.session && e.ts === selfLocal.ts);
        assert.ok(!twin, 'phantom self team-row survived — it would render a duplicate "(prompt not shared)" row');
        const localStill = feedPhantomRes.entries.find(e => e.origin === 'local'
          && e.session === selfLocal.session && e.ts === selfLocal.ts);
        assert.ok(localStill && localStill.ask, 'your own local prompt must remain visible in full');
        assert.ok(!JSON.stringify(feedPhantomRes).includes('phantom twin: summary only'),
          'the dropped twin must not surface at all');
      });
    }

    const teamFeedTamperRes = await (await fetch(`${hubBase}/api/team/feed?teamId=${team.team_id}&limit=50`)).json();
    check('/api/team/feed re-redacts server-row ask and summary too', () => {
      const body = JSON.stringify(teamFeedTamperRes);
      assert.ok(!body.includes('sk-feedtamper1111') && !body.includes('sk-feedtamper2222'),
        'raw secret surfaced in the /api/team/feed response');
      const row = teamFeedTamperRes.entries.find(e => e.ask && e.ask.includes('tampered feed ask'));
      assert.ok(row && row.ask.includes('[redacted') && row.summary.includes('[redacted'),
        'tampered row not redacted on /api/team/feed');
      const gated = teamFeedTamperRes.entries.find(e => e.summary === 'gated row: summary only');
      assert.ok(gated && gated.ask === null, 'null ask must survive /api/team/feed unchanged');
    });

    // Same hole, third surface: /api/project embeds pulled teamEntries, which
    // pullProject stores RAW in state — plant a tampered pulled row and prove
    // projectDetail re-redacts it before it crosses the local HTTP boundary.
    {
      const st = util.loadState();
      const k = Object.keys(st.projects).find(p => sameKey(p, proj1));
      st.projects[k].teamEntries = (st.projects[k].teamEntries || []).concat({
        author: 'Tamper', ts: tsAgo(5), source: 'Codex',
        ask: 'pulled tampered ask api_key=sk-feedtamper3333 here',
        files: [], summary: 'pulled tampered summary api_key=sk-feedtamper4444 stored raw',
      });
      util.saveState(st);
    }
    const detailTamperRes = await (await fetch(`${hubBase}/api/project?path=${encodeURIComponent(proj1)}`)).json();
    check('/api/project re-redacts pulled teamEntries ask and summary', () => {
      const body = JSON.stringify(detailTamperRes);
      assert.ok(!body.includes('sk-feedtamper3333') && !body.includes('sk-feedtamper4444'),
        'raw secret surfaced in the /api/project response');
      const row = (detailTamperRes.teamEntries || []).find(e => e.author === 'Tamper');
      assert.ok(row, 'planted pulled row missing from /api/project teamEntries');
      assert.ok(row.ask.includes('[redacted') && row.summary.includes('[redacted'),
        `pulled row not redacted: ${row.ask} / ${row.summary}`);
    });
    // Catch-up briefing over the local API: teammate rows only, self excluded,
    // grouped by author, and a no-key degrade. A throwaway Anthropic mock
    // stands in for the (already-closed) roadmap mock; the in-process server
    // reads MEMBRIDGE_API_BASE per call, so setting it now is enough.
    let lastTeamBriefReq = null;
    const briefMock = http.createServer((rq, rs) => {
      const cs = [];
      rq.on('data', c => cs.push(c));
      rq.on('end', () => {
        lastTeamBriefReq = JSON.parse(Buffer.concat(cs).toString('utf8'));
        rs.writeHead(200, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({
          model: lastTeamBriefReq.model,
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Andrew wired the receipt PDF; Dana added refund guardrails.' }],
          usage: { input_tokens: 500, output_tokens: 60 },
        }));
      });
    });
    await new Promise(r => briefMock.listen(17948, '127.0.0.1', r));
    process.env.MEMBRIDGE_API_BASE = 'http://127.0.0.1:17948';

    await post(`${hubBase}/api/settings`, { apiKey: '' });
    const briefDegraded = await (await post(`${hubBase}/api/briefing/generate`, {})).json();
    await post(`${hubBase}/api/settings`, { apiKey: GOOD_KEY });
    const briefRes = await (await post(`${hubBase}/api/briefing/generate`, { since: '2026-07-01T00:00:00.000Z' })).json();
    check('briefing route: degrades without a key; briefs teammate activity with one', () => {
      assert.strictEqual(briefDegraded.degraded, true, 'no-key path must degrade');
      assert.ok(!briefDegraded.text, 'degraded path must not carry a briefing');
      assert.strictEqual(briefRes.degraded, false);
      assert.ok(briefRes.text && /receipt PDF/.test(briefRes.text), `briefing text missing: ${JSON.stringify(briefRes)}`);
      assert.ok(briefRes.generatedAt, 'generatedAt missing');
      assert.ok(lastTeamBriefReq, 'briefing mock never saw a request');
      const userMsg = lastTeamBriefReq.messages[0].content;
      assert.ok(userMsg.includes('Andrew'), 'teammate Andrew missing from the digest');
      assert.ok(!/^##\s*You\b/m.test(userMsg), 'self rows leaked into the teammate digest');
      const st = util.loadState();
      assert.ok(st.catchup && st.catchup.briefing && /receipt PDF/.test(st.catchup.briefing.text),
        'briefing not cached to state.catchup.briefing');
      assert.strictEqual(st.catchup.briefing.since, '2026-07-01T00:00:00.000Z', 'cached since window wrong');
    });
    await post(`${hubBase}/api/settings`, { apiKey: '' });
    await new Promise(r => briefMock.close(r));
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
    {
      // The accepted-suggestion check asserts Dana's ask reached the server.
      const cfgD = util.loadUserConfig();
      cfgD.team = { ...(cfgD.team || {}), sharePrompts: true, encrypt: false };
      util.saveUserConfig(cfgD);
    }
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
      assert.ok(!mock.entries.some(e => e.ask && e.ask.includes('rate limiting')), 'entries pushed without consent');
    });
    const danaLink = await teamsync.resolveSuggestion(util.getConfig(), danaApi, true);
    await teamsync.syncTeams();
    check('auto-link: accepting the suggestion links the clone to the same project row', () => {
      assert.strictEqual(danaLink.projectId, apiLink.projectId, 'clone got a different project row');
      assert.ok(!util.loadState().projects[danaApi].teamSuggestion, 'suggestion not cleared');
      assert.ok(mock.entries.some(e => e.ask && e.ask.includes('rate limiting')), 'entries not pushed after accept');
    });

    // Erin opts into full auto-link: her clone links without a prompt.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-e');
    const erinCfg = util.loadUserConfig();
    erinCfg.team = { ...(erinCfg.team || {}), autoLink: true, encrypt: false };
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

    // ----- cross-fork convergence: a committed team.json beats the remote -----
    // Grace's clone sits on her own fork remote AND a differently-named
    // directory, so neither the repo_url upsert nor the name fallback can
    // match — the committed team.json is the only bridge. Revert the adoption
    // logic and link_project mints a fresh island row, failing these checks.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-g');
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'grace@test.dev', 'pw-g', 'Grace');
    await teamsync.joinTeam(util.getConfig(), team.invite_code);
    const committedLink = { projectId: apiLink.projectId, teamId: team.team_id, teamName: 'Acme' };
    const graceClone = path.join(ROOT, 'projects-g', 'api-server-grace');
    gitRepo(graceClone, 'https://github.com/grace-fork/api-server.git');
    fs.mkdirSync(path.join(graceClone, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(graceClone, '.membridge', 'team.json'), JSON.stringify(committedLink, null, 2));
    const projectRowsBefore = mock.projects.length;
    const linkG = await teamsync.linkProject(util.getConfig(), graceClone, team.team_id, 'Acme');
    check('fork link: team link adopts a committed team.json instead of minting a new row', () => {
      assert.strictEqual(linkG.projectId, apiLink.projectId, 'fork clone got its own project row (island)');
      assert.strictEqual(linkG.adopted, true, 'adoption not flagged on the returned link');
      assert.strictEqual(mock.projects.length, projectRowsBefore, 'a new project row was minted');
      assert.ok(!mock.projects.some(p => String(p.repoUrl || '').includes('grace-fork')),
        'the fork remote reached the server as a project row');
      // Adoption must not rewrite the committed file — that would dirty every
      // teammate's working tree.
      assert.deepStrictEqual(JSON.parse(read(path.join(graceClone, '.membridge', 'team.json'))), committedLink);
    });

    // Dana clones the other fork with the same committed file: both clones
    // resolve to the one shared project row — the convergence the fix is for.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    const melikaClone = path.join(ROOT, 'projects-d', 'api-server-melika');
    gitRepo(melikaClone, 'git@github.com:melika-fork/api-server.git');
    fs.mkdirSync(path.join(melikaClone, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(melikaClone, '.membridge', 'team.json'), JSON.stringify(committedLink, null, 2));
    const linkM = await teamsync.linkProject(util.getConfig(), melikaClone, team.team_id, 'Acme');
    check('fork link: two fork clones with the same committed team.json converge on one project', () => {
      assert.strictEqual(linkM.projectId, linkG.projectId, 'the two forks resolved to different project rows');
      assert.strictEqual(mock.projects.length, projectRowsBefore, 'convergence still minted a row');
    });

    // Iris is in her own team but not Acme: linking a clone that carries
    // Acme's committed team.json must refuse with a clear message — never
    // quietly mint an island row in her team.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-i');
    util.ensureConfig();
    await teamsync.signup(util.getConfig(), 'iris@test.dev', 'pw-i', 'Iris');
    const irisTeam = await teamsync.createTeam(util.getConfig(), 'IrisCo');
    const irisClone = path.join(ROOT, 'projects-i', 'api-server');
    gitRepo(irisClone, 'https://github.com/iris-fork/api-server.git');
    fs.mkdirSync(path.join(irisClone, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(irisClone, '.membridge', 'team.json'), JSON.stringify(committedLink, null, 2));
    let irisErr = null;
    try {
      await teamsync.linkProject(util.getConfig(), irisClone, irisTeam.team_id, 'IrisCo');
    } catch (err) {
      irisErr = err;
    }
    check('fork link: a committed team.json for a foreign team fails clearly, never an island', () => {
      assert.ok(irisErr && /not a member/i.test(irisErr.message), `said: ${irisErr && irisErr.message}`);
      assert.ok(irisErr && /team\.json/.test(irisErr.message), 'error does not point at the committed file');
      assert.strictEqual(mock.projects.length, projectRowsBefore, 'a foreign team.json minted an island row');
      assert.deepStrictEqual(JSON.parse(read(path.join(irisClone, '.membridge', 'team.json'))), committedLink,
        'the refusal rewrote the committed file');
    });
    process.env.MEMBRIDGE_HOME = HOME_A;

    // The shipped .gitignore must let team.json be committed (the whole
    // cross-fork story depends on it) while the rest of .membridge/ stays
    // ignored as per-machine derived data, at any depth.
    const giRepo = path.join(ROOT, 'gitignore-check');
    fs.mkdirSync(giRepo, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: giRepo });
    fs.copyFileSync(path.join(__dirname, '..', '.gitignore'), path.join(giRepo, '.gitignore'));
    const gitIgnores = rel => spawnSync('git', ['-C', giRepo, 'check-ignore', '-q', rel]).status === 0;
    check('gitignore: .membridge/team.json is committable, the rest of .membridge/ stays ignored', () => {
      assert.strictEqual(gitIgnores('.membridge/team.json'), false, 'team.json is gitignored — it can never be committed');
      assert.strictEqual(gitIgnores('.membridge/memory.md'), true, '.membridge/ derived data no longer ignored');
      assert.strictEqual(gitIgnores('.membridge/memory.json'), true, '.membridge/ derived data no longer ignored');
      assert.strictEqual(gitIgnores('web/.membridge/memory.md'), true, 'nested .membridge/ no longer ignored');
    });

    // ----- migration 005: project soft-delete (owner/manager, reversible) -----
    // A fresh linked project so archiving never disturbs the shop-app fixtures.
    process.env.MEMBRIDGE_HOME = HOME_A;
    const projArch = path.join(ROOT, 'projects', 'archive-app');
    fs.mkdirSync(projArch, { recursive: true });
    fs.writeFileSync(path.join(projArch, 'CLAUDE.md'), '# Archive app\n');
    const stArch = util.loadState();
    stArch.projects[projArch] = {
      events: [{ ts: '2026-07-13T09:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'Draft the archive feature', session: 'arch1' }],
    };
    util.saveState(stArch);
    const archLink = await teamsync.linkProject(util.getConfig(), projArch, team.team_id, 'Acme');
    await teamsync.syncTeams({ project: projArch }); // push the entry so it appears in the feed

    // A plain member (Dana, home-d) cannot archive: the RPC is manager-gated.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    let memberArchErr = null;
    try {
      await teamsync.archiveProject(util.getConfig(), archLink.projectId);
    } catch (err) {
      memberArchErr = err;
    }
    check('archive: a plain member cannot delete a shared project for the team', () => {
      assert.ok(memberArchErr && /owner or admin/i.test(memberArchErr.message), `said: ${memberArchErr && memberArchErr.message}`);
      assert.ok(!mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'project was archived by a non-manager');
    });

    // The owner archives it: gone from the projects payload and the feed.
    process.env.MEMBRIDGE_HOME = HOME_A;
    await teamsync.archiveProject(util.getConfig(), archLink.projectId);
    const projsAfterArchive = await teamProjectsPayload(team.team_id);
    const feedAfterArchive = await teamsync.teamFeed(util.getConfig(), team.team_id, { limit: 100 });
    check('archive: owner archive hides the project from the projects payload and the feed', () => {
      assert.ok(mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'archived_at not set');
      assert.ok(!projsAfterArchive.some(r => r.project_id === archLink.projectId), 'archived project still listed');
      assert.ok(!feedAfterArchive.some(e => e.project_id === archLink.projectId), 'archived project rows still in the feed');
    });

    // Reversible: unarchive brings it back.
    await teamsync.unarchiveProject(util.getConfig(), archLink.projectId);
    const projsAfterRestore = await teamProjectsPayload(team.team_id);
    check('archive: unarchive restores the project (reversible)', () => {
      assert.ok(!mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'archived_at not cleared');
      assert.ok(projsAfterRestore.some(r => r.project_id === archLink.projectId), 'restored project missing from payload');
    });

    // The dashboard route. A plain member (Dana) can only unlink their own
    // machine — never archive for the team.
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-d');
    const danaClone = path.join(ROOT, 'projects-d', 'archive-app');
    fs.mkdirSync(danaClone, { recursive: true });
    const stDana = util.loadState();
    stDana.projects = { ...(stDana.projects || {}), [danaClone]: { events: [] } };
    util.saveState(stDana);
    await teamsync.linkProject(util.getConfig(), danaClone, team.team_id, 'Acme'); // same project row
    const MEMBER_PORT = 17948;
    const memberSrv = startServer(MEMBER_PORT, { retries: 0 });
    await waitForHttp(`http://127.0.0.1:${MEMBER_PORT}/api/status`);
    const memberDel = await (await fetch(`http://127.0.0.1:${MEMBER_PORT}/api/team/archive-project`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: danaClone }),
    })).json();
    await new Promise(r => memberSrv.close(r));
    check('archive route: a plain member only unlinks locally, never archives for the team', () => {
      assert.strictEqual(memberDel.scope, 'local');
      assert.strictEqual(memberDel.archived, false);
      assert.ok(memberDel.unlinked, 'member path did not unlink');
      assert.ok(!fs.existsSync(path.join(danaClone, '.membridge', 'team.json')), 'member team.json survived');
      assert.ok(!mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'member call archived for the whole team');
    });

    // The owner deletes the shared project over the route: archived for the
    // team AND fully cleaned up locally (team.json gone, project out of state).
    process.env.MEMBRIDGE_HOME = HOME_A;
    const OWNER_PORT = 17949;
    const ownerSrv = startServer(OWNER_PORT, { retries: 0 });
    await waitForHttp(`http://127.0.0.1:${OWNER_PORT}/api/status`);
    const ownerDel = await (await fetch(`http://127.0.0.1:${OWNER_PORT}/api/team/archive-project`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: projArch }),
    })).json();
    await new Promise(r => ownerSrv.close(r));
    check('archive route: owner delete archives for the team and cleans up locally', () => {
      assert.strictEqual(ownerDel.scope, 'team');
      assert.strictEqual(ownerDel.archived, true);
      assert.ok(mock.projects.find(p => p.id === archLink.projectId).archivedAt, 'backend project not archived via the route');
      assert.ok(!fs.existsSync(path.join(projArch, '.membridge', 'team.json')), 'team.json survived the archive');
      assert.ok(!util.loadState().projects[projArch], 'project still in local state after delete');
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
    { // legacy plaintext home: explicit hatch (and keeps Mallory off the real keychain)
      const cfgC = util.loadUserConfig();
      cfgC.team = { ...(cfgC.team || {}), encrypt: false };
      util.saveUserConfig(cfgC);
    }
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
  fs.mkdirSync(path.join(projR, '.membridge'), { recursive: true }); // tracked, so the gate ingests it
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
  // A shareable coding session (has an edit) that produced NO >=80-char summary:
  // exercises the fallback one-liner render + summary-null push under the
  // zero-edit suppression rule. Prompt-first so its edit attaches to its own
  // entry, not a neighbouring session's.
  fs.writeFileSync(path.join(rDir, 'sessEditNoSummary.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Bump the package version' }, cwd: projR, timestamp: '2026-07-12T09:16:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projR, 'package.json') } }] }, cwd: projR, timestamp: '2026-07-12T09:16:30.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Bumped.' }] }, cwd: projR, timestamp: '2026-07-12T09:17:00.000Z' },
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
  check('rich: renderBlock groups by session with Ask/Did/Tasks/Changes', () => {
    const md = richMd();
    assert.ok(md.includes('Ask: Refactor the payment retry queue with backoff'), 'Ask line missing');
    assert.ok(md.includes('Did: Refactored the payment retry queue'), 'Did line missing');
    assert.ok(md.includes('Tasks: 1/3 done'), 'Tasks line missing');
    assert.ok(md.includes('Changes: src/queue.js'), 'Changes line missing');
    // A shareable (edited) session with no summary keeps the one-line ask format.
    assert.ok(md.includes('Claude Code: Bump the package version'), 'fallback one-liner missing');
    // A zero-edit Claude Code session (readme tweak, no edit captured) is ops
    // noise and suppressed from the block entirely.
    assert.ok(!md.includes('Quick tweak to the readme'), 'zero-edit session should be suppressed');
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
  // A session whose only capture is the agent's self-report (no user prompt,
  // no edit). A zero-edit Claude Code session — suppressed under the rule.
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
    assert.ok(line && line.trim().startsWith('Did:'), 'flattened summary missing from the block');
    assert.ok(!/[*`|#]/.test(line), `markdown survived into the Did line: ${line}`);
  });
  check('fix: a zero-edit summary-only session is suppressed from the block', () => {
    // No prompt, no edit — only a harvested self-report. A Claude Code session
    // that changed nothing is ops noise now and never reaches the block.
    const md = richMd();
    assert.ok(!md.includes('finished wiring the webhook retries'), 'zero-edit summary-only session leaked into the block');
  });

  check('renderBlock: shows Intent/Did/Changes, no 240-char blob truncation', () => {
    const proj = { events: [
      { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'do the mcp thing' },
      { ts: '2026-07-16T00:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 's1', file: '/repo/lib/mcp.js' },
      { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
        text: 'Built a read-only MCP server with four tools.', goal: 'Expose memory to MCP clients',
        decisions: 'read-only by design', gotchas: '', highlights: [{ file: 'lib/mcp.js', note: 'the server' }] },
    ] };
    const block = digest.renderBlock('/repo', proj, { distill: { enabled: true }, team: {} }, 'CLAUDE.md');
    assert.ok(/Intent: Expose memory to MCP clients/.test(block), 'Intent line');
    assert.ok(/Did: Built a read-only MCP server/.test(block), 'Did line');
    assert.ok(/Notes:.*read-only by design/.test(block), 'Notes line');
    assert.ok(/Changes:.*lib\/mcp\.js/.test(block), 'Changes line');
    assert.ok(!/Result:/.test(block), 'no legacy Result label');
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

  check('scan: distilled summary keeps goal/decisions/gotchas/highlights separate', () => {
    const line = JSON.stringify({
      session: 's1', ts: '2026-07-16T00:00:00.000Z',
      goal: 'Expose memory to MCP clients', did: 'Built a read-only MCP server',
      decisions: 'read-only by design', gotchas: '', highlights: [{ file: 'lib/mcp.js', note: 'the server' }],
    }) + '\n';
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-scan-'));
    fs.mkdirSync(path.join(repo, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.membridge', 'summaries.jsonl'), line);
    const st = { projects: { [repo]: { events: [] } }, files: {} };
    const evs = require('../lib/scan').scanSummaries(st, { distill: { enabled: true } });
    const ev = evs.find(e => e.session === 's1');
    assert.ok(ev, 'summary event produced');
    assert.strictEqual(ev.text, 'Built a read-only MCP server'); // text = did only
    assert.strictEqual(ev.goal, 'Expose memory to MCP clients');
    assert.strictEqual(ev.decisions, 'read-only by design');
    assert.deepStrictEqual(ev.highlights, [{ file: 'lib/mcp.js', note: 'the server' }]);
  });

  check('headline: scanSummaries carries headline when present', () => {
    const proj = path.join(ROOT, 'projects', 'hl-scan'); fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.membridge', 'summaries.jsonl'),
      JSON.stringify({ session: 's1', ts: '2026-07-20T00:00:00Z', did: 'full did', headline: 'tight line' }) + '\n');
    const st = { projects: { [proj]: { events: [] } }, files: {} };
    const evs = require('../lib/scan').scanSummaries(st, {});
    const ev = evs.find(e => e.session === 's1');
    assert.ok(ev && ev.headline === 'tight line', 'headline not carried by scanSummaries');
  });
  check('headline: mergeEvents preserves headline on the stored summary event', () => {
    const state = { projects: {} };
    const ev = { ts: '2026-07-22T00:00:00Z', project: path.join(ROOT, 'projects', 'hl-merge'),
      source: 'Distilled', kind: 'summary', session: 's1', text: 'did text', headline: 'tight glance line' };
    digest.mergeEvents(state, [ev], {});
    const key = Object.keys(state.projects)[0];
    const stored = state.projects[key].events.find(e => e.kind === 'summary');
    assert.ok(stored, 'summary event stored');
    assert.strictEqual(stored.headline, 'tight glance line', 'headline dropped by mergeEvents (never reaches buildEntries)');
  });
  check('scanSummaries labels Codex fallback summaries as Codex, not Distilled', () => {
    const proj = path.join(ROOT, 'projects', 'codex-summary-source'); fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.membridge', 'summaries.jsonl'),
      JSON.stringify({ session: 'codex-standalone', ts: '2026-07-22T00:00:00Z', did: 'Codex finished the UI fix.' }) + '\n');
    const st = { projects: { [proj]: { events: [] } }, files: {} };
    const evs = require('../lib/scan').scanSummaries(st, {});
    const ev = evs.find(e => e.session === 'codex-standalone');
    assert.ok(ev, 'codex summary event missing');
    assert.strictEqual(ev.source, 'Codex');
    assert.strictEqual(ev.distilled, true);
  });

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
    assert.strictEqual(d.find(e => e.session === 'sessD').text, 'Hardened the webhook auth with HMAC and a replay window; rotated api_key=sk-distilled-secret-123.', 'text should be the did field only');
    assert.strictEqual(d.find(e => e.session === 'sessD').gotchas, 'Clock skew over 30s breaks verification.', 'gotchas should be kept as a separate structured field');
    const rec = util.loadState().files[summariesFile];
    assert.ok(rec && rec.adapter === 'distill' && rec.offset > 0, `summaries offset record was ${JSON.stringify(rec)}`);
  });
  check('distill: the block prefers Distilled over harvested in every session', () => {
    const md = richMd();
    assert.ok(md.includes('Rebuilt the retry queue end to end'), 'sessR distilled summary missing');
    const evR = richEvents().find(e => e.kind === 'summary' && e.source === 'Distilled' && e.session === 'sessR');
    assert.strictEqual(evR.decisions, 'Kept the queue schema; only consumers changed.', 'decisions should be a separate structured field, not folded into the rendered block');
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
    assert.strictEqual(afterSetup.hooks.Stop[1].hooks[0].command, hooks.hookCommand(), 'membridge command missing or not the resolved absolute form');
    assert.deepStrictEqual(afterSetup.hooks.PreToolUse, seedSettings.hooks.PreToolUse, 'unrelated hooks changed');
    assert.strictEqual(afterSetup.model, 'opus');
    assert.deepStrictEqual(afterSetup.feedbackSurveyState, seedSettings.feedbackSurveyState, 'unknown keys lost');
    assert.ok(/already installed/.test(setup2.stdout), `second run said: ${setup2.stdout}`);
    assert.strictEqual(afterSetup2.hooks.Stop.length, 2, 'setup-hooks duplicated the entry');
  });
  check('distill: hook command is absolute and needs no PATH', () => {
    const cmd = hooks.hookCommand();
    assert.ok(cmd.includes(`"${process.execPath}"`), `command lacks the quoted runtime binary: ${cmd}`);
    const script = cmd.match(/"([^"]*membridge-hook\.js)"/);
    assert.ok(script, `command lacks a quoted membridge-hook.js path: ${cmd}`);
    assert.ok(path.isAbsolute(script[1]), 'hook script path is not absolute');
    assert.ok(fs.existsSync(script[1]), 'hook script does not exist on disk');
  });
  check('distill: membridge-hook.js entry behaves like `membridge hook stop`', () => {
    const entry = path.join(__dirname, '..', 'lib', 'membridge-hook.js');
    const out = spawnSync(process.execPath, [entry], {
      input: JSON.stringify(stopPayload('sessNoSummaryYet')), encoding: 'utf8', env: { ...process.env },
    });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stdout, '', 'no-edit session should not block'); // worthiness gate
    const blocked = spawnSync(process.execPath, [entry], {
      input: 'garbage', encoding: 'utf8', env: { ...process.env },
    });
    assert.strictEqual(blocked.status, 0, 'entry must fail open on garbage stdin');
  });
  check('auto-register: ensureInstalled installs the Stop hook silently and is idempotent', () => {
    const arFile = path.join(ROOT, 'claude-settings-autoreg.json');
    fs.writeFileSync(arFile, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2));
    const prev = process.env.MEMBRIDGE_CLAUDE_SETTINGS;
    process.env.MEMBRIDGE_CLAUDE_SETTINGS = arFile;
    try {
      hooks.ensureInstalled();
      const after1 = JSON.parse(read(arFile));
      assert.strictEqual(after1.hooks.Stop.length, 1, 'Stop hook not auto-registered');
      assert.strictEqual(after1.hooks.Stop[0].hooks[0].command, hooks.hookCommand(), 'auto-registered command is not the resolved form');
      assert.strictEqual(after1.model, 'opus', 'unrelated settings key lost');
      hooks.ensureInstalled();
      const after2 = JSON.parse(read(arFile));
      assert.strictEqual(after2.hooks.Stop.length, 1, 'ensureInstalled duplicated the Stop entry');
    } finally {
      process.env.MEMBRIDGE_CLAUDE_SETTINGS = prev;
    }
  });
  check('auto-register: post-commit sweep runs once per version, then is skipped', () => {
    const repo = path.join(ROOT, 'autoreg-repo');
    fs.mkdirSync(path.join(repo, '.git', 'hooks'), { recursive: true });
    const st = util.loadState();
    util.saveState({ ...st, projects: { ...(st.projects || {}), [repo]: { events: [] } }, hooksInstalledVersion: 'v-stale' });

    hooks.ensurePostCommitForVersion();
    const hookFile = path.join(repo, '.git', 'hooks', 'post-commit');
    assert.ok(fs.existsSync(hookFile), 'post-commit hook not installed on the version-mismatch run');
    assert.strictEqual(util.loadState().hooksInstalledVersion, require('../package.json').version, 'version marker not stamped after sweep');

    fs.unlinkSync(hookFile); // a gated second run must NOT recreate it
    hooks.ensurePostCommitForVersion();
    assert.strictEqual(fs.existsSync(hookFile), false, 'sweep re-ran despite a matching version marker');
  });
  check('distill: setup-hooks upgrades a stale PATH-based command in place', () => {
    const staleFile = path.join(ROOT, 'claude-settings-stale.json');
    fs.writeFileSync(staleFile, JSON.stringify({
      hooks: { Stop: [
        { hooks: [{ type: 'command', command: 'echo user-stop' }] },
        { hooks: [{ type: 'command', command: 'membridge hook stop', timeout: 10 }] },
      ] },
    }, null, 2));
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: staleFile };
    const out = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    assert.strictEqual(out.status, 0, out.stderr);
    assert.ok(/Updated the MemBridge Stop hook command/.test(out.stdout), `said: ${out.stdout}`);
    const after = JSON.parse(read(staleFile));
    assert.strictEqual(after.hooks.Stop.length, 2, 'entry count changed');
    assert.strictEqual(after.hooks.Stop[0].hooks[0].command, 'echo user-stop', 'user hook touched');
    assert.strictEqual(after.hooks.Stop[1].hooks[0].command, hooks.hookCommand(), 'stale command not upgraded');
    assert.strictEqual(after.hooks.Stop[1].hooks[0].timeout, 10, 'sibling fields lost in upgrade');
    const again = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    assert.ok(/already installed/.test(again.stdout), `upgrade not idempotent: ${again.stdout}`);
  });
  check('distill: isHookInstalled is false when the hook executable does not resolve', () => {
    const deadFile = path.join(ROOT, 'claude-settings-dead.json');
    fs.writeFileSync(deadFile, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: '/nonexistent/bin/membridge hook stop', timeout: 10 }] }] },
    }, null, 2));
    const prev = process.env.MEMBRIDGE_CLAUDE_SETTINGS;
    process.env.MEMBRIDGE_CLAUDE_SETTINGS = deadFile;
    try {
      assert.strictEqual(hooks.isHookInstalled(), false, 'dead absolute path reported as installed');
      fs.writeFileSync(deadFile, JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'membridge-no-such-cli hook stop', timeout: 10 }] }] },
      }, null, 2));
      assert.strictEqual(hooks.isHookInstalled(), false, 'unresolvable PATH command reported as installed');
      fs.writeFileSync(deadFile, JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: hooks.hookCommand(), timeout: 10 }] }] },
      }, null, 2));
      assert.strictEqual(hooks.isHookInstalled(), true, 'resolvable absolute command reported as missing');
    } finally {
      process.env.MEMBRIDGE_CLAUDE_SETTINGS = prev;
    }
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
  check('distill: setup-hooks installs the append auto-approve rule; remove-hooks strips it, user rules survive', () => {
    const permFile = path.join(ROOT, 'claude-settings-perm.json');
    fs.writeFileSync(permFile, JSON.stringify({ permissions: { allow: ['Bash(npm run test:*)'] } }, null, 2));
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: permFile };
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    const after = JSON.parse(read(permFile));
    assert.ok(after.permissions.allow.includes(hooks.appendAllowRule()), 'allow rule missing after setup');
    assert.ok(after.permissions.allow.includes('Bash(npm run test:*)'), 'user rule dropped by setup');
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' }); // idempotent
    const after2 = JSON.parse(read(permFile));
    assert.strictEqual(after2.permissions.allow.filter(r => /membridge/i.test(r)).length, 1, 'rule duplicated on re-run');
    spawnSync(process.execPath, [BIN, 'remove-hooks'], { env, encoding: 'utf8' });
    const after3 = JSON.parse(read(permFile));
    const allow3 = ((after3.permissions || {}).allow) || [];
    assert.ok(!allow3.some(r => /membridge/i.test(r)), 'rule not removed by remove-hooks');
    assert.ok(allow3.includes('Bash(npm run test:*)'), 'user rule dropped by remove-hooks');
  });
  check('distill: remove-hooks preserves a user allow rule that merely contains "membridge"', () => {
    const f = path.join(ROOT, 'claude-settings-usermembridge.json');
    const userRule = 'Bash(npm test --prefix /Users/x/Documents/Membridge:*)';
    fs.writeFileSync(f, JSON.stringify({ permissions: { allow: [userRule] } }, null, 2));
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: f };
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    let allow = JSON.parse(read(f)).permissions.allow;
    assert.ok(allow.includes(userRule) && allow.includes(hooks.appendAllowRule()), 'setup should add ours and keep the user rule');
    spawnSync(process.execPath, [BIN, 'remove-hooks'], { env, encoding: 'utf8' });
    allow = ((JSON.parse(read(f)).permissions || {}).allow) || [];
    assert.ok(allow.includes(userRule), 'remove-hooks deleted a user rule that only contains "membridge"');
    assert.ok(!allow.includes(hooks.appendAllowRule()), 'our append rule should be gone');
  });
  check('distill: setup-hooks upgrades a stale append allow rule in place', () => {
    const staleFile = path.join(ROOT, 'claude-settings-stale-rule.json');
    fs.writeFileSync(staleFile, JSON.stringify({
      permissions: { allow: ['Bash("/old/node" "/old/lib/membridge-hook.js" append:*)'] },
    }, null, 2));
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: staleFile };
    spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    const after = JSON.parse(read(staleFile));
    assert.deepStrictEqual(after.permissions.allow.filter(r => /membridge/i.test(r)), [hooks.appendAllowRule()], 'stale rule not rewritten to current form');
  });
  check('distill: setup-hooks refuses a settings file whose permissions shape is malformed', () => {
    const badFile = path.join(ROOT, 'claude-settings-badperm.json');
    const badBody = JSON.stringify({ permissions: [] });
    fs.writeFileSync(badFile, badBody);
    const env = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: badFile };
    const out = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env, encoding: 'utf8' });
    assert.ok(/refusing/i.test(out.stdout + out.stderr), 'expected a refusal message');
    assert.strictEqual(read(badFile), badBody, 'malformed file must not be rewritten');
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
    // projR still carries RichTeam's team.json from the mock2 pass above, and
    // a link now adopts an existing team.json rather than re-minting — unlink
    // first, as a user moving a project between teams would.
    teamsync.unlinkProject(projR);
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

  check('teamsync: isShared is per-session, default off, with legacy fallback', () => {
    const proj = { sharedSessions: ['s1'] };
    assert.strictEqual(teamsync.isShared({}, proj, 's1'), true);
    assert.strictEqual(teamsync.isShared({}, proj, 's2'), false);
    assert.strictEqual(teamsync.isShared({}, {}, 's1'), false);            // default off
    assert.strictEqual(teamsync.isShared({}, {}, null), false);            // no session id
    assert.strictEqual(teamsync.isShared({ team: { sharePrompts: true } }, {}, 's1'), true);       // legacy fallback
    assert.strictEqual(teamsync.isShared({ team: { sharePrompts: true } }, { sharedSessions: [] }, 's1'), false); // list wins
  });

  // Task 6: goal is gated by sharePrompts (same convention as ask), and the
  // change model (buildEntries' e.changes) ships inside the `files` column
  // instead of a plain filename list, when present.
  const mockG = createMockSupabase();
  await new Promise(r => mockG.server.listen(17949, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17949';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    const projG = path.join(ROOT, 'projects', 'goal-app');
    fs.mkdirSync(projG, { recursive: true });
    await teamsync.signup(util.getConfig(), 'goal@test.dev', 'pw-g', 'Goalie');
    const teamG = await teamsync.createTeam(util.getConfig(), 'GoalTeam');
    await teamsync.linkProject(util.getConfig(), projG, teamG.team_id, 'GoalTeam');

    const gTsAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
    // Builds one prompt+edit+Distilled-summary entry directly in state (same
    // shorthand as the trim-app/stateB fixtures above) so buildEntries yields
    // an entry with both e.goal and e.changes (the highlight matches the
    // edited file, so deriveChanges produces a non-empty change model).
    const setGoalEntry = (sec, session, ask, note) => {
      const st = util.loadState();
      st.projects[projG] = {
        events: [
          { ts: gTsAgo(sec + 20), source: 'Claude Code', kind: 'prompt', session, text: ask },
          { ts: gTsAgo(sec + 10), source: 'Claude Code', kind: 'edit', session, file: path.join(projG, 'src', 'goal.js') },
          {
            ts: gTsAgo(sec), source: 'Distilled', kind: 'summary', session,
            text: 'Shipped goal tracking end to end.',
            goal: 'Add persistent goal field to team push',
            decisions: '', gotchas: '',
            highlights: [{ file: 'src/goal.js', note }],
          },
        ],
      };
      util.saveState(st);
    };

    // setupFixtures opted the main test home into sharePrompts for the legacy
    // team tests (see the comment near the top of the file) — clear it here
    // so this first push exercises the gated-off path, like the prompt-gate
    // section below does for `ask`.
    {
      const rc = util.loadUserConfig();
      if (rc.team) delete rc.team.sharePrompts;
      util.saveUserConfig(rc);
    }
    setGoalEntry(90, 'gsess1', 'Wire up goal tracking', 'the goal field plumbing');
    await teamsync.syncTeams({ project: projG });
    check('teamsync: goal gated by sharePrompts; change model ships in its own column', () => {
      const row = mockG.entries.find(e => e.session === 'gsess1');
      assert.ok(row, 'entry not pushed');
      assert.strictEqual(row.goal, null, 'goal leaked with sharePrompts off');
      // files stays a plain string[] (filenames), never objects.
      assert.ok(Array.isArray(row.files) && row.files.length, 'files missing');
      assert.ok(row.files.every(f => typeof f === 'string'),
        `files must stay string[], got: ${JSON.stringify(row.files)}`);
      assert.ok(row.files.includes('src/goal.js'), 'expected filename missing from files');
      // the change model rides in a dedicated `changes` column, as objects.
      assert.ok(Array.isArray(row.changes) && row.changes.length,
        `changes column missing the model, got: ${JSON.stringify(row.changes)}`);
      assert.ok(row.changes.every(c => c && typeof c === 'object' && 'file' in c),
        `changes should be objects, got: ${JSON.stringify(row.changes)}`);
      assert.ok(row.changes.some(c => c.file === 'src/goal.js'), 'expected file missing from change model');
      assert.ok(row.changes.some(c => c.note && c.note.includes('goal field plumbing')), 'change note missing');
    });

    // Flip sharePrompts on: a fresh entry's goal must ship, scrubbed.
    const cfgG = util.loadUserConfig();
    cfgG.team = { ...(cfgG.team || {}), sharePrompts: true, encrypt: false };
    util.saveUserConfig(cfgG);
    setGoalEntry(30, 'gsess2', 'Wire up goal tracking take 2', 'the second goal field plumbing');
    await teamsync.syncTeams({ project: projG });
    check('teamsync: goal ships (scrubbed) once sharePrompts is on', () => {
      const row2 = mockG.entries.find(e => e.session === 'gsess2');
      assert.ok(row2, 'second entry not pushed');
      assert.ok(row2.goal && row2.goal.includes('Add persistent goal field'), `goal was: ${row2.goal}`);
    });

    // A secret planted in a change note must be scrubbed at the push boundary,
    // exactly like ask/summary — the note leaves the machine redacted.
    setGoalEntry(20, 'gsess3', 'Rotate the deploy secret', 'rotate api_key=sk-change-note-SECRET77 in the vault');
    await teamsync.syncTeams({ project: projG });
    check('teamsync: a secret in a change note is redacted before push', () => {
      const row3 = mockG.entries.find(e => e.session === 'gsess3');
      assert.ok(row3, 'third entry not pushed');
      assert.ok(Array.isArray(row3.changes) && row3.changes[0], 'change model missing');
      assert.ok(row3.changes[0].note && row3.changes[0].note.includes('[redacted'),
        `change note not redacted: ${row3.changes[0].note}`);
      assert.ok(!JSON.stringify(mockG.entries).includes('sk-change-note-SECRET77'),
        'secret from a change note reached the server');
    });

    // A backend missing BOTH the goal and changes columns must still recover:
    // the push loop drops each missing column, one round-trip at a time, until
    // the insert lands. Exercises the multi-drop path end to end.
    setGoalEntry(15, 'gsess4', 'Wire up goal tracking take 4', 'the fourth goal field plumbing');
    mockG.flags.rejectColumns = new Set(['goal', 'changes']);
    let multiDropThrew = null;
    try {
      await teamsync.syncTeams({ project: projG });
    } catch (err) {
      multiDropThrew = err;
    }
    mockG.flags.rejectColumns = new Set();
    check('teamsync: push recovers when both goal and changes columns are missing', () => {
      assert.strictEqual(multiDropThrew, null, `push threw instead of recovering: ${multiDropThrew && multiDropThrew.message}`);
      const row4 = mockG.entries.find(e => e.session === 'gsess4');
      assert.ok(row4, 'entry never landed despite the drop-and-retry loop');
      // the two rejected columns were dropped from the accepted row ...
      assert.ok(!('goal' in row4), 'goal column was not dropped');
      assert.ok(!('changes' in row4), 'changes column was not dropped');
      // ... while every column the backend DOES have still shipped.
      assert.ok('summary' in row4 && row4.summary, 'summary was dropped too');
      assert.ok('files' in row4 && Array.isArray(row4.files), 'files was dropped too');
      assert.ok('ask' in row4 && row4.ask, 'ask was dropped too');
    });

    // Pull: a second identity joins the team and pulls Goalie's rows back —
    // goal and the change-model files must survive the round trip.
    const projGB = path.join(ROOT, 'projects-gb', 'goal-app');
    fs.mkdirSync(projGB, { recursive: true });
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-goalpull');
    util.ensureConfig();
    const stGB = util.loadState();
    stGB.projects = { ...(stGB.projects || {}), [projGB]: { events: [] } };
    util.saveState(stGB);
    await teamsync.signup(util.getConfig(), 'goalpull@test.dev', 'pw-gb', 'Puller');
    const joinedG = await teamsync.joinTeam(util.getConfig(), teamG.invite_code);
    await teamsync.linkProject(util.getConfig(), projGB, joinedG.team_id, joinedG.team_name);
    await teamsync.syncTeams({ project: projGB });
    check('teamsync: goal and the change model are pulled back intact', () => {
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => path.resolve(k) === path.resolve(projGB));
      assert.ok(key, 'pulled project missing from state');
      const pulled = (st.projects[key].teamEntries || []).find(e => e.session === 'gsess2');
      assert.ok(pulled, 'pulled entry missing');
      assert.ok(pulled.goal && pulled.goal.includes('Add persistent goal field'), `pulled goal was: ${pulled.goal}`);
      // files is string[]; the change model lands in its own `changes` field.
      assert.ok(Array.isArray(pulled.files) && pulled.files.every(f => typeof f === 'string'),
        `pulled files must stay string[], got: ${JSON.stringify(pulled.files)}`);
      assert.ok(pulled.files.includes('src/goal.js'), 'pulled filename missing');
      assert.ok(Array.isArray(pulled.changes) && pulled.changes.some(c => c.file === 'src/goal.js'),
        `pulled changes should carry the model, got: ${JSON.stringify(pulled.changes)}`);
    });
  } finally {
    process.env.MEMBRIDGE_HOME = HOME_A;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mockG.server.close(r));
  }

  // Task 4 (per-session prompt sharing): reshareSession re-pushes ONE
  // session's rows with the verbatim prompt forced on (backfill) or off
  // (scrub), overwriting already-synced rows via merge-duplicates.
  const mockRS = createMockSupabase();
  await new Promise(r => mockRS.server.listen(17955, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17955';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    const projRS = path.join(ROOT, 'projects', 'reshare-app');
    fs.mkdirSync(projRS, { recursive: true });
    await teamsync.signup(util.getConfig(), 'reshare@test.dev', 'pw-rs', 'Resha');
    const teamRS = await teamsync.createTeam(util.getConfig(), 'ReshareTeam');
    await teamsync.linkProject(util.getConfig(), projRS, teamRS.team_id, 'ReshareTeam');
    { const rc = util.loadUserConfig(); if (rc.team) delete rc.team.sharePrompts; util.saveUserConfig(rc); } // sharePrompts OFF
    const rsAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
    const st = util.loadState();
    st.projects[projRS] = { events: [
      { ts: rsAgo(50), source: 'Claude Code', kind: 'prompt', session: 'sA', text: 'do the thing' },
      { ts: rsAgo(40), source: 'Claude Code', kind: 'edit', session: 'sA', file: path.join(projRS, 'src', 'a.js') },
      { ts: rsAgo(30), source: 'Distilled', kind: 'summary', session: 'sA', text: 'Did the thing.', goal: 'the goal', decisions: '', gotchas: '', highlights: [{ file: 'src/a.js', note: 'a note' }] },
    ] };
    util.saveState(st);
    await teamsync.syncTeams({ project: projRS });
    const creds = await teamsync.getAccessToken(util.getConfig());
    await check('teamsync: reshareSession backfills then scrubs a session prompt (plaintext)', async () => {
      let row = mockRS.entries.filter(e => e.session === 'sA')[0];
      assert.ok(row, 'precondition: entry pushed');
      assert.strictEqual(row.ask, null, 'precondition: unshared (ask should be null)');
      await teamsync.reshareSession(util.getConfig(), projRS, 'sA', true, { creds, crypto: null });
      row = mockRS.entries.filter(e => e.session === 'sA')[0];
      assert.ok(row.ask && /do the thing/.test(row.ask), 'backfill did not populate ask: ' + JSON.stringify(row.ask));
      await teamsync.reshareSession(util.getConfig(), projRS, 'sA', false, { creds, crypto: null });
      row = mockRS.entries.filter(e => e.session === 'sA')[0];
      assert.strictEqual(row.ask, null, 'scrub did not clear ask');
    });
    // Regression: a reshare batch mixes entries that have a distilled goal with
    // entries that don't. entryToRow must never emit an `undefined`-valued key —
    // JSON.stringify drops those, so a goal-less row would ship WITHOUT the `goal`
    // key while a goaled row ships WITH it, and PostgREST rejects the mixed-shape
    // array with "All object keys must match" (the "share doesn't work" bug).
    await check('teamsync: entryToRow emits a stable key set across mixed entries (no undefined keys)', () => {
      const rx = digest.compileRedactions(util.getConfig());
      const cr = { userId: 'u1', displayName: 'Resha' };
      const withGoal = { ts: rsAgo(30), source: 'Claude Code', session: 'sM', ask: 'do it', goal: 'the goal', files: [] };
      const noGoal = { ts: rsAgo(20), source: 'Claude Code', session: 'sM', ask: '(file edits)', files: [] };
      const rowA = JSON.parse(JSON.stringify(teamsync.entryToRow(withGoal, 'p1', cr, true, rx)));
      const rowB = JSON.parse(JSON.stringify(teamsync.entryToRow(noGoal, 'p1', cr, true, rx)));
      const keysA = Object.keys(rowA).sort();
      const keysB = Object.keys(rowB).sort();
      assert.deepStrictEqual(keysB, keysA, 'goal-less row is missing keys present on the goaled row: ' +
        JSON.stringify({ onlyOnGoaled: keysA.filter(k => !keysB.includes(k)) }));
      assert.ok('goal' in rowB, 'goal key dropped from the goal-less row (undefined value)');
      assert.strictEqual(rowB.goal, null, 'goal should serialize as null, not vanish');
    });
    // Fail-closed: on an encrypted team with no usable key, reshareSession must
    // refuse rather than push a plaintext-only row (which merge-duplicates would
    // apply while leaving any prior ciphertext — still holding the real prompt —
    // untouched, and would silently downgrade E2E). crypto:null + encrypt:true
    // exercises the guard deterministically without touching the OS keychain.
    await check('teamsync: reshareSession fails closed on an encrypted team without a key', async () => {
      const rc = util.loadUserConfig();
      rc.team = { ...(rc.team || {}), encrypt: true };
      util.saveUserConfig(rc);
      try {
        const res = await teamsync.reshareSession(util.getConfig(), projRS, 'sA', true, { creds, crypto: null });
        assert.strictEqual(res.ok, false, 'reshare should fail closed when it cannot encrypt');
        assert.ok(/encryption/i.test(res.error || ''), 'error should mention encryption: ' + res.error);
        const row = mockRS.entries.filter(e => e.session === 'sA')[0];
        assert.strictEqual(row.ask, null, 'fail-closed must not backfill the prompt in plaintext');
      } finally {
        const rc2 = util.loadUserConfig();
        if (rc2.team) rc2.team.encrypt = false; // encryption defaults ON — restore the legacy home's explicit hatch
        util.saveUserConfig(rc2);
      }
    });
  } finally {
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mockRS.server.close(r));
  }

  // Task 5 (per-session prompt sharing): reshareSession with an explicit
  // opts.crypto runs each row through encryptRow, so the re-pushed row
  // carries ciphertext/nonce whose decrypted payload holds the new
  // (backfilled or scrubbed) ask. Proves the encrypted reshare path, not
  // just the plaintext one above. Skips as a pass if libsodium isn't
  // installed in this environment.
  {
    const tc = require('../lib/teamcrypto');
    const mockRE = createMockSupabase();
    await new Promise(r => mockRE.server.listen(17956, '127.0.0.1', r));
    process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17956';
    process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
    try {
      const projRE = path.join(ROOT, 'projects', 'reshare-enc-app');
      fs.mkdirSync(projRE, { recursive: true });
      await teamsync.signup(util.getConfig(), 'reshareenc@test.dev', 'pw-re', 'ReshaEnc');
      const teamRE = await teamsync.createTeam(util.getConfig(), 'ReshareEncTeam');
      await teamsync.linkProject(util.getConfig(), projRE, teamRE.team_id, 'ReshareEncTeam');
      { const rc = util.loadUserConfig(); if (rc.team) delete rc.team.sharePrompts; util.saveUserConfig(rc); }
      const reAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
      const st = util.loadState();
      st.projects[projRE] = { events: [
        { ts: reAgo(50), source: 'Claude Code', kind: 'prompt', session: 'sB', text: 'do the encrypted thing' },
        { ts: reAgo(40), source: 'Claude Code', kind: 'edit', session: 'sB', file: path.join(projRE, 'src', 'b.js') },
        { ts: reAgo(30), source: 'Distilled', kind: 'summary', session: 'sB', text: 'Did it.', goal: 'g', decisions: '', gotchas: '', highlights: [{ file: 'src/b.js', note: 'n' }] },
      ] };
      util.saveState(st);
      await teamsync.syncTeams({ project: projRE }); // plaintext push, ask=null (unshared)
      const creds = await teamsync.getAccessToken(util.getConfig());
      await check('teamsync: reshareSession encrypts the backfilled prompt', async () => {
        if (!tc.available()) return; // libsodium unavailable in this env — skip as pass
        await tc.ready();
        const teamKey = tc.genTeamKey();
        await teamsync.reshareSession(util.getConfig(), projRE, 'sB', true, { creds, crypto: { teamKey, epoch: 1, teamcrypto: tc } });
        const row = mockRE.entries.filter(e => e.session === 'sB')[0];
        assert.ok(row.ciphertext && row.nonce, 'row was not encrypted');
        const payload = tc.decrypt(row.ciphertext, row.nonce, teamKey);
        assert.ok(payload && /do the encrypted thing/.test(payload.ask), 'encrypted payload missing the shared prompt');
        await teamsync.reshareSession(util.getConfig(), projRE, 'sB', false, { creds, crypto: { teamKey, epoch: 1, teamcrypto: tc } });
        const row2 = mockRE.entries.filter(e => e.session === 'sB')[0];
        const payload2 = tc.decrypt(row2.ciphertext, row2.nonce, teamKey);
        assert.strictEqual(payload2.ask, null, 'scrub left the prompt in the ciphertext');
      });
    } finally {
      delete process.env.MEMBRIDGE_TEAM_URL;
      delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
      await new Promise(r => mockRE.server.close(r));
    }
  }

  // Task 6 (per-session prompt sharing): POST /api/share-session persists the
  // per-session flag into proj.sharedSessions (authoritative for future
  // normal pushes) and calls teamsync.reshareSession to retroactively
  // backfill (share=true) or scrub (share=false) already-synced rows.
  {
    const mockSE = createMockSupabase();
    const MOCK_PORT_SE = 17958, SRV_PORT_SE = 17957;
    await new Promise(r => mockSE.server.listen(MOCK_PORT_SE, '127.0.0.1', r));
    process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:' + MOCK_PORT_SE;
    process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
    let srvSE;
    try {
      const projSE = path.join(ROOT, 'projects', 'share-ep-app');
      fs.mkdirSync(projSE, { recursive: true });
      await teamsync.signup(util.getConfig(), 'shareep@test.dev', 'pw-se', 'Sharee');
      const teamSE = await teamsync.createTeam(util.getConfig(), 'ShareEpTeam');
      await teamsync.linkProject(util.getConfig(), projSE, teamSE.team_id, 'ShareEpTeam');
      { const rc = util.loadUserConfig(); if (rc.team) delete rc.team.sharePrompts; util.saveUserConfig(rc); }
      const seAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
      const st = util.loadState();
      st.projects[projSE] = { events: [
        { ts: seAgo(50), source: 'Claude Code', kind: 'prompt', session: 'sC', text: 'share this prompt' },
        { ts: seAgo(40), source: 'Claude Code', kind: 'edit', session: 'sC', file: path.join(projSE, 'src', 'c.js') },
        { ts: seAgo(30), source: 'Distilled', kind: 'summary', session: 'sC', text: 'Did.', goal: 'g', decisions: '', gotchas: '', highlights: [{ file: 'src/c.js', note: 'n' }] },
      ] };
      util.saveState(st);
      await teamsync.syncTeams({ project: projSE }); // unshared push (ask=null)
      srvSE = startServer(SRV_PORT_SE, { retries: 0 });
      await waitForHttp('http://127.0.0.1:' + SRV_PORT_SE + '/api/status');

      const on = await httpPost(SRV_PORT_SE, '/api/share-session', { project: projSE, session: 'sC', share: true });
      await check('server: /api/share-session ON persists the flag and backfills the row', () => {
        assert.strictEqual(on.ok, true);
        assert.strictEqual(on.shared, true);
        const state = util.loadState();
        const proj = state.projects[projSE] || state.projects[path.resolve(projSE)];
        assert.ok(proj, 'project missing from state after ON');
        assert.ok((proj.sharedSessions || []).includes('sC'), 'sharedSessions should include sC after ON');
        const row = mockSE.entries.filter(e => e.session === 'sC')[0];
        assert.ok(row, 'row missing after ON');
        assert.ok(row.ask && /share this prompt/.test(row.ask), 'backfill did not populate ask: ' + JSON.stringify(row.ask));
      });

      const off = await httpPost(SRV_PORT_SE, '/api/share-session', { project: projSE, session: 'sC', share: false });
      await check('server: /api/share-session OFF persists the flag and scrubs the row', () => {
        assert.strictEqual(off.ok, true);
        assert.strictEqual(off.shared, false);
        const state = util.loadState();
        const proj = state.projects[projSE] || state.projects[path.resolve(projSE)];
        assert.ok(proj, 'project missing from state after OFF');
        assert.ok(!(proj.sharedSessions || []).includes('sC'), 'sharedSessions should not include sC after OFF');
        const row = mockSE.entries.filter(e => e.session === 'sC')[0];
        assert.ok(row, 'row missing after OFF');
        assert.strictEqual(row.ask, null, 'row ask should be null after OFF');
      });
    } finally {
      if (srvSE) await new Promise(r => srvSE.close(r));
      mockSE.server.close();
      delete process.env.MEMBRIDGE_TEAM_URL;
      delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    }
  }

  // SECURITY (fix/dashboard-csrf): the local dashboard API binds 127.0.0.1, which
  // stops remote attackers but NOT cross-site ones — any page the user's browser
  // loads while the daemon runs can fire a form POST at 127.0.0.1:<port> and drive
  // a mutating endpoint (e.g. overwrite team.url so the next sync ships the Supabase
  // refresh token to an attacker). The guard runs before route dispatch: a POST
  // whose Origin is present and cross-site, an opaque "null" Origin, or a non-JSON
  // content-type is refused with 403; same-origin and no-Origin (CLI/tests) pass;
  // reads (GET) are never blocked. We assert against /api/projects/add because it
  // 400s on a missing path, so a passed guard is observable as 400 (not a mutation).
  {
    const CSRF_PORT = 17983;
    const srvCsrf = startServer(CSRF_PORT, { retries: 0 });
    try {
      const base = 'http://127.0.0.1:' + CSRF_PORT;
      await waitForHttp(base + '/api/status');
      const raw = (p, opts) => fetch(base + p, opts);

      const cross = await raw('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' },
        body: JSON.stringify({ path: '/tmp/whatever' }),
      });
      await check('server(csrf): cross-origin POST is blocked before the route (403)', () => {
        assert.strictEqual(cross.status, 403);
      });

      const nullOrigin = await raw('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'null' },
        body: JSON.stringify({ path: '/tmp/whatever' }),
      });
      await check('server(csrf): opaque "null" Origin POST is blocked (403)', () => {
        assert.strictEqual(nullOrigin.status, 403);
      });

      const wrongType = await raw('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', Origin: base },
        body: JSON.stringify({ path: '/tmp/whatever' }),
      });
      await check('server(csrf): non-JSON content-type POST is blocked (403)', () => {
        assert.strictEqual(wrongType.status, 403);
      });

      const same = await raw('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({}),
      });
      await check('server(csrf): same-origin POST passes the guard (reaches route → 400)', () => {
        assert.strictEqual(same.status, 400);
      });

      const noOrigin = await raw('/api/projects/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await check('server(csrf): POST without an Origin is allowed (non-browser client → 400)', () => {
        assert.strictEqual(noOrigin.status, 400);
      });

      const readCross = await raw('/api/status', { headers: { Origin: 'http://evil.example' } });
      await check('server(csrf): cross-origin GET is still served (reads are safe → 200)', () => {
        assert.strictEqual(readCross.status, 200);
      });
    } finally {
      if (srvCsrf) await new Promise(r => srvCsrf.close(r));
    }
  }

  // BUG 1 (fix/share-live-and-clamp): sharing a LIVE / never-pushed session.
  // reshareSession must refresh stale credentials like every other
  // authenticated call (it used raw loadCredentials, so an expired JWT made
  // every reshare 401 while the 60s sync kept quietly refreshing creds for
  // everything else), must INSERT rows for a session the backend has never
  // seen, and /api/share-session must refuse honestly when a session has no
  // local rows (it used to persist the flag as a silent no-op) — and the
  // dashboard must surface a share failure inline, never via the offline pill.
  {
    const mockLV = createMockSupabase();
    const MOCK_PORT_LV = 17961, SRV_PORT_LV = 17962;
    await new Promise(r => mockLV.server.listen(MOCK_PORT_LV, '127.0.0.1', r));
    process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:' + MOCK_PORT_LV;
    process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
    let srvLV;
    try {
      const projLV = path.join(ROOT, 'projects', 'share-live-app');
      fs.mkdirSync(projLV, { recursive: true });
      await teamsync.signup(util.getConfig(), 'sharelive@test.dev', 'pw-lv', 'Liver');
      const teamLV = await teamsync.createTeam(util.getConfig(), 'ShareLiveTeam');
      await teamsync.linkProject(util.getConfig(), projLV, teamLV.team_id, 'ShareLiveTeam');
      { const rc = util.loadUserConfig(); if (rc.team) delete rc.team.sharePrompts; util.saveUserConfig(rc); }
      // A LIVE session: one prompt seconds ago, no summary — and deliberately
      // NO syncTeams, so the backend has zero rows for it.
      const stLV = util.loadState();
      stLV.projects[projLV] = { events: [
        { ts: new Date(Date.now() - 5000).toISOString(), source: 'Claude Code', kind: 'prompt', session: 'sLive', text: 'working right now' },
      ] };
      util.saveState(stLV);

      await check('teamsync: reshareSession inserts + shares a session the backend has never seen', async () => {
        const creds = await teamsync.getAccessToken(util.getConfig());
        assert.strictEqual(mockLV.entries.filter(e => e.session === 'sLive').length, 0, 'precondition: no backend row');
        const res = await teamsync.reshareSession(util.getConfig(), projLV, 'sLive', true, { creds, crypto: null });
        assert.strictEqual(res.ok, true, 'reshare must succeed for a never-pushed session: ' + JSON.stringify(res));
        const row = mockLV.entries.filter(e => e.session === 'sLive')[0];
        assert.ok(row, 'the share must insert the missing backend row');
        assert.ok(row.ask && /working right now/.test(row.ask), 'inserted row must carry the shared prompt');
      });

      await check('teamsync: reshareSession refreshes a stale token instead of failing with it', async () => {
        // Expire the stored access token but keep the refresh token valid. The
        // old code sent the dead token verbatim (raw loadCredentials, never a
        // refresh), so the whole reshare 401ed — the live-session share bug.
        const saved = JSON.parse(fs.readFileSync(teamsync.credentialsPath(), 'utf8'));
        fs.writeFileSync(teamsync.credentialsPath(), JSON.stringify({
          ...saved, accessToken: 'expired-dead-token', expiresAt: Date.now() - 60000,
        }));
        const res = await teamsync.reshareSession(util.getConfig(), projLV, 'sLive', false);
        assert.strictEqual(res.ok, true, 'reshare with a stale stored token must refresh and succeed: ' + JSON.stringify(res));
        const row = mockLV.entries.filter(e => e.session === 'sLive')[0];
        assert.strictEqual(row.ask, null, 'the refreshed reshare must still apply (scrub)');
      });

      srvLV = startServer(SRV_PORT_LV, { retries: 0 });
      await waitForHttp('http://127.0.0.1:' + SRV_PORT_LV + '/api/status');
      const onLive = await httpPost(SRV_PORT_LV, '/api/share-session', { project: projLV, session: 'sLive', share: true });
      await check('server: /api/share-session ok:true for a previously-unpushed session', () => {
        assert.strictEqual(onLive.ok, true, JSON.stringify(onLive));
        const row = mockLV.entries.filter(e => e.session === 'sLive')[0];
        assert.ok(row && row.ask && /working right now/.test(row.ask), 'live row must be inserted + shared via the endpoint');
        const state = util.loadState();
        const proj = state.projects[projLV] || state.projects[path.resolve(projLV)];
        assert.ok((proj.sharedSessions || []).includes('sLive'), 'flag persists once the backend accepted');
      });

      const onGhost = await httpPost(SRV_PORT_LV, '/api/share-session', { project: projLV, session: 'sGhost', share: true });
      await check('server: /api/share-session refuses a rowless session instead of silently persisting the flag', () => {
        assert.strictEqual(onGhost.ok, false, 'a session with no local rows must not report success: ' + JSON.stringify(onGhost));
        const state = util.loadState();
        const proj = state.projects[projLV] || state.projects[path.resolve(projLV)];
        assert.ok(!((proj.sharedSessions || []).includes('sGhost')), 'flag must not persist when nothing was shared');
      });

      await check('teamsync: an unlinked project short-circuits reshare before any credential/network work', async () => {
        // A solo (team-unlinked) project must keep its local-flag toggle even
        // when the stored token is stale and the auth backend is unreachable —
        // the unlinked path needs no creds at all, so it must be checked first.
        const savedCreds = fs.readFileSync(teamsync.credentialsPath(), 'utf8');
        const savedUrl = process.env.MEMBRIDGE_TEAM_URL;
        const projSolo = path.join(ROOT, 'projects', 'solo-unlinked-app');
        fs.mkdirSync(projSolo, { recursive: true });
        const stSolo = util.loadState();
        stSolo.projects[projSolo] = { events: [
          { ts: new Date(Date.now() - 5000).toISOString(), source: 'Claude Code', kind: 'prompt', session: 'sSolo', text: 'solo work' },
        ] };
        util.saveState(stSolo);
        try {
          const parsed = JSON.parse(savedCreds);
          fs.writeFileSync(teamsync.credentialsPath(), JSON.stringify({ ...parsed, accessToken: 'stale', expiresAt: Date.now() - 60000 }));
          process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:1'; // unreachable: any refresh attempt fails loudly
          const res = await teamsync.reshareSession(util.getConfig(), projSolo, 'sSolo', true);
          assert.strictEqual(res.ok, true, 'unlinked reshare must succeed without touching the network: ' + JSON.stringify(res));
          assert.strictEqual(res.unlinked, true, 'unlinked marker missing');
        } finally {
          fs.writeFileSync(teamsync.credentialsPath(), savedCreds);
          process.env.MEMBRIDGE_TEAM_URL = savedUrl;
        }
      });

      const pageLV = await (await fetch('http://127.0.0.1:' + SRV_PORT_LV + '/')).text();
      const scriptLV = (pageLV.match(/<script>\n([\s\S]*)\n<\/script>/) || [])[1] || '';
      await check('dashboard: share-toggle failure is inline (couldn’t share — retry), never the offline pill', () => {
        const marks = [];
        let at = -1;
        while ((at = scriptLV.indexOf("closest('[data-share-toggle]')", at + 1)) !== -1) marks.push(at);
        assert.strictEqual(marks.length, 3, 'expected the three share handlers (feed, day, project), got ' + marks.length);
        for (const m of marks) {
          const block = scriptLV.slice(m, scriptLV.indexOf('.catch', m) + 220);
          assert.ok(/shareFailUI\(/.test(block), 'handler at ' + m + ' does not route failure to the inline affordance');
          assert.ok(!/setPill\(false\)/.test(block), 'handler at ' + m + ' still flips the global pill on a share failure');
        }
        assert.ok(/couldn&rsquo;t share/.test(scriptLV), 'inline failure copy missing');
      });
    } finally {
      if (srvLV) await new Promise(r => srvLV.close(r));
      mockLV.server.close();
      delete process.env.MEMBRIDGE_TEAM_URL;
      delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    }
  }

  // Task 8: ship decisions/gotchas to teammates end to end, and pull must
  // survive a backend still missing goal/changes (or any optional column).
  const mockS = createMockSupabase();
  await new Promise(r => mockS.server.listen(17951, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17951';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  try {
    const projS = path.join(ROOT, 'projects', 'summary-app');
    fs.mkdirSync(projS, { recursive: true });
    await teamsync.signup(util.getConfig(), 'summary@test.dev', 'pw-s', 'Summarizer');
    const teamS = await teamsync.createTeam(util.getConfig(), 'SummaryTeam');
    await teamsync.linkProject(util.getConfig(), projS, teamS.team_id, 'SummaryTeam');
    {
      const rc = util.loadUserConfig();
      rc.team = { ...(rc.team || {}), sharePrompts: true };
      util.saveUserConfig(rc);
    }

    const sTsAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
    const setSummaryEntry = (sec, session, ask, decisions, gotchas) => {
      const st = util.loadState();
      st.projects[projS] = {
        events: [
          { ts: sTsAgo(sec + 20), source: 'Claude Code', kind: 'prompt', session, text: ask },
          { ts: sTsAgo(sec + 10), source: 'Claude Code', kind: 'edit', session, file: path.join(projS, 'src', 'summary.js') },
          {
            ts: sTsAgo(sec), source: 'Distilled', kind: 'summary', session,
            text: 'Shipped the summary fields end to end.',
            goal: 'Ship summary fields to teammates',
            decisions, gotchas,
            highlights: [{ file: 'src/summary.js', note: 'the plumbing' }],
          },
        ],
      };
      util.saveState(st);
    };

    setSummaryEntry(60, 'ssess1', 'Wire up decisions/gotchas',
      'Kept decisions/gotchas as separate columns.', 'A pre-migration backend must not break the pull.');
    await teamsync.syncTeams({ project: projS });
    check('teamsync: push ships decisions and gotchas (scrubbed), ungated by sharePrompts', () => {
      const row = mockS.entries.find(e => e.session === 'ssess1');
      assert.ok(row, 'entry not pushed');
      assert.ok(row.decisions && row.decisions.includes('separate columns'), `decisions was: ${row.decisions}`);
      assert.ok(row.gotchas && row.gotchas.includes('pre-migration backend'), `gotchas was: ${row.gotchas}`);
    });

    // Second identity joins the team and pulls Summarizer's rows back.
    const projSB = path.join(ROOT, 'projects-sb', 'summary-app');
    fs.mkdirSync(projSB, { recursive: true });
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-summarypull');
    util.ensureConfig();
    const stSB = util.loadState();
    stSB.projects = { ...(stSB.projects || {}), [projSB]: { events: [] } };
    util.saveState(stSB);
    await teamsync.signup(util.getConfig(), 'summarypull@test.dev', 'pw-sb', 'PullerS');
    const joinedS = await teamsync.joinTeam(util.getConfig(), teamS.invite_code);
    await teamsync.linkProject(util.getConfig(), projSB, joinedS.team_id, joinedS.team_name);
    await teamsync.syncTeams({ project: projSB });
    check('teamsync: decisions/gotchas pulled back intact and render as a Notes line', () => {
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => path.resolve(k) === path.resolve(projSB));
      assert.ok(key, 'pulled project missing from state');
      const pulled = (st.projects[key].teamEntries || []).find(e => e.session === 'ssess1');
      assert.ok(pulled, 'pulled entry missing');
      assert.ok(pulled.decisions && pulled.decisions.includes('separate columns'), `pulled decisions: ${pulled.decisions}`);
      assert.ok(pulled.gotchas && pulled.gotchas.includes('pre-migration backend'), `pulled gotchas: ${pulled.gotchas}`);
      const block = digest.renderBlock(projSB, st.projects[key], {}, 'CLAUDE.md');
      assert.ok(/Notes:.*separate columns.*pre-migration backend/.test(block),
        `expected a Notes line combining decisions + gotchas, got:\n${block}`);
    });

    // Pull fallback: a backend still missing goal/changes (pre-008-migration)
    // must not break the pull — the client should drop those columns from
    // `select` and retry, degrading (null/empty) rather than throwing and
    // stopping ALL teammate ingestion.
    process.env.MEMBRIDGE_HOME = HOME_A;
    setSummaryEntry(30, 'ssess2', 'A second checkpoint',
      'Second decisions.', 'Second gotchas.');
    await teamsync.syncTeams({ project: projS }); // push ssess2 from the original identity

    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-summarypull');
    mockS.flags.rejectColumns = new Set(['goal', 'changes']);
    let pullFallbackThrew = null;
    try {
      await teamsync.syncTeams({ project: projSB });
    } catch (err) {
      pullFallbackThrew = err;
    }
    mockS.flags.rejectColumns = new Set();
    check('teamsync: pull survives a backend still missing goal/changes columns', () => {
      assert.strictEqual(pullFallbackThrew, null, `pull threw instead of degrading: ${pullFallbackThrew && pullFallbackThrew.message}`);
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => path.resolve(k) === path.resolve(projSB));
      assert.ok(key, 'pulled project missing from state');
      const pulled2 = (st.projects[key].teamEntries || []).find(e => e.session === 'ssess2');
      assert.ok(pulled2, 'entry never landed despite the column-drop-and-retry loop');
      assert.ok(pulled2.summary, 'summary should still be present (not one of the dropped columns)');
      assert.ok(Array.isArray(pulled2.files) && pulled2.files.length, 'files should still be present');
      assert.strictEqual(pulled2.goal, null, 'goal should degrade to null when the column is missing');
      assert.ok(pulled2.changes === null || (Array.isArray(pulled2.changes) && pulled2.changes.length === 0),
        `changes should degrade to null/empty, got: ${JSON.stringify(pulled2.changes)}`);
      // decisions/gotchas were not in the rejected set, so they must survive.
      assert.ok(pulled2.decisions && pulled2.decisions.includes('Second decisions'), `pulled2.decisions: ${pulled2.decisions}`);
      assert.ok(pulled2.gotchas && pulled2.gotchas.includes('Second gotchas'), `pulled2.gotchas: ${pulled2.gotchas}`);
    });
  } finally {
    process.env.MEMBRIDGE_HOME = HOME_A;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    await new Promise(r => mockS.server.close(r));
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
  check('checkpoint: blockReason asks every checkpoint for a cumulative whole-session line', () => {
    const first = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 0);
    const later = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 2);
    assert.ok(/whole session/i.test(first), 'first checkpoint asks for the whole session');
    assert.ok(/whole session/i.test(later), 'later checkpoint asks for the whole session');
    assert.ok(/supersed/i.test(later), 'later checkpoint declares it supersedes earlier lines');
    assert.ok(later.includes('2 earlier lines'), 'later checkpoint states the count');
    assert.ok(/never modify existing lines/i.test(later), 'append-only rule preserved');
    assert.ok(!/only the work done since/i.test(later), 'delta scoping must be gone');
    const one = hooks.blockReason('/p/.membridge/summaries.jsonl', 'ck1', 1);
    assert.ok(one.includes('1 earlier line ') && !/1 earlier lines/.test(one), 'n=1 uses singular "earlier line"');
  });
  check('checkpoint: blockReason demands outcome phrasing and the discreet append command', () => {
    const r = hooks.blockReason('/p/.membridge/summaries.jsonl', 'sess-x', 0);
    assert.ok(/what changed in the project/i.test(r), 'outcome phrasing present');
    assert.ok(/never a list of files edited/i.test(r), 'activity-list phrasing forbidden');
    assert.ok(r.includes(hooks.hookCommand() + ' append "/p/.membridge/summaries.jsonl"'), 'canonical append command with quoted target');
    assert.ok(/no commentary/i.test(r), 'no-commentary instruction present');
    assert.ok(/exactly ONE command/.test(r), 'single-command instruction present');
    assert.ok(r.includes('"sess-x"'), 'session id present in the template');
    assert.ok(/"goal"/.test(r) && /"did"/.test(r) && /"highlights"/.test(r), 'field template intact');
    assert.ok(/escape it for the shell/i.test(r), 'shell-escaping guidance present');
    assert.ok(r.includes(String.raw`'\''`), 'shows the apostrophe escape sequence');
  });
  check('headline: blockReason asks for a character-bounded headline', () => {
    const r = hooks.blockReason('/p/.membridge/summaries.jsonl', 's1', 0);
    assert.ok(/"headline"/.test(r), 'JSON template includes headline');
    assert.strictEqual(hooks.HEADLINE_MAX, 80, 'HEADLINE_MAX is the 80-char card budget');
    assert.ok(r.includes(hooks.HEADLINE_MAX + ' characters'), 'headline character max stated in the prompt');
    assert.ok(!/10 words/.test(r), 'word-count phrasing replaced by the character max');
    assert.ok(/glance/i.test(r), 'glance-outcome guidance still present');
  });
  check('purpose: blockReason frames every field as teammate communication — what was done and why', () => {
    const r = hooks.blockReason('/p/.membridge/summaries.jsonl', 'sess-p', 0);
    assert.ok(/teammate|team member/i.test(r.slice(0, 250)), 'purpose leads: a team member reads this, stated before the mechanics');
    assert.ok(/what was done and why/i.test(r), 'names the reader\'s need: what was done and why');
    assert.ok(/goal:[^;]*(intent|why)/i.test(r), 'goal field tied to the why/intent behind the session');
    assert.ok(/decisions:[^;]*why/i.test(r), 'decisions field asks for the reasoning, not just the choice');
    assert.ok(/gotchas:[^;]*teammate/i.test(r), 'gotchas field framed as sparing a teammate the same pitfall');
    const mentions = (r.match(/teammate|team member/gi) || []).length;
    assert.ok(mentions >= 5, `teammate framing reinforced across the fields (found ${mentions}, want >= 5)`);
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
  const HOOK_SCRIPT = path.join(__dirname, '..', 'lib', 'membridge-hook.js');
  const runAppendCli = args => spawnSync(process.execPath, [HOOK_SCRIPT, 'append', ...args], { encoding: 'utf8' });
  check('append: writes one validated line, creates .membridge, never truncates', () => {
    const proj = path.join(ROOT, 'projects', 'append-app');
    fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const line = f => JSON.stringify({ session: 'ap1', ts: '2026-07-17T00:00:00Z', goal: 'g', did: 'shipped the thing', decisions: '', gotchas: '', highlights: [], ...f });
    const out = runAppendCli([target, line({})]);
    assert.strictEqual(out.status, 0, out.stderr);
    assert.strictEqual(out.stdout, '', 'append must be silent on success');
    const rows = read(target).trim().split('\n');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(JSON.parse(rows[0]).did, 'shipped the thing');
    const out2 = runAppendCli([target, line({ did: 'second line' })]);
    assert.strictEqual(out2.status, 0, out2.stderr);
    const rows2 = read(target).trim().split('\n');
    assert.strictEqual(rows2.length, 2, 'second append must not truncate the first');
    assert.strictEqual(JSON.parse(rows2[1]).did, 'second line');
  });
  check('append: rejects bad input loudly and writes nothing', () => {
    const proj = path.join(ROOT, 'projects', 'append-bad');
    fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const mk = f => JSON.stringify({ session: 's1', did: 'real work', ...f });
    for (const [args, why] of [
      [[target, 'not json {'], 'malformed JSON'],
      [[target, '["array"]'], 'JSON but not an object'],
      [[target, mk({ session: '  ' })], 'blank session'],
      [[target, mk({ did: '' })], 'empty did'],
      [[path.join(proj, 'elsewhere.jsonl'), mk({})], 'target not a .membridge/summaries.jsonl path'],
      [[path.join(proj, 'evil.membridge', 'summaries.jsonl'), mk({})], 'suffix match but not a real .membridge dir'],
      [[target], 'missing json argument'],
    ]) {
      const out = runAppendCli(args);
      assert.notStrictEqual(out.status, 0, `${why}: expected non-zero exit`);
      assert.ok(out.stderr.trim(), `${why}: expected a stderr message`);
    }
    assert.ok(!fs.existsSync(target), 'invalid input must write nothing');
  });
  check('headline: append accepts a line with headline and one without; rejects non-string headline', () => {
    const proj = path.join(ROOT, 'projects', 'hl-app'); fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const base = { session: 's1', ts: '2026-07-20T00:00:00Z', did: 'did a thing' };
    const run = obj => spawnSync(process.execPath, [HOOK_SCRIPT, 'append', target, JSON.stringify(obj)], { encoding: 'utf8' });
    assert.strictEqual(run({ ...base, headline: 'Short outcome' }).status, 0, 'headline line rejected');
    assert.strictEqual(run(base).status, 0, 'headline-less line rejected');
    assert.notStrictEqual(run({ ...base, headline: 42 }).status, 0, 'non-string headline accepted');
  });
  check('headline: append enforces the character max loudly and writes nothing over it', () => {
    const proj = path.join(ROOT, 'projects', 'hl-max'); fs.mkdirSync(proj, { recursive: true });
    const target = path.join(proj, '.membridge', 'summaries.jsonl');
    const base = { session: 's1', ts: '2026-07-21T00:00:00Z', did: 'did a thing' };
    const run = obj => spawnSync(process.execPath, [HOOK_SCRIPT, 'append', target, JSON.stringify(obj)], { encoding: 'utf8' });
    assert.strictEqual(run({ ...base, headline: 'h'.repeat(hooks.HEADLINE_MAX) }).status, 0, 'exactly-max headline rejected');
    assert.strictEqual(run({ ...base, headline: '  ' + 'h'.repeat(hooks.HEADLINE_MAX) + '  ' }).status, 0,
      'padding must not count against the max (trimmed length governs)');
    const over = run({ ...base, headline: 'h'.repeat(hooks.HEADLINE_MAX + 1) });
    assert.notStrictEqual(over.status, 0, 'over-max headline accepted');
    assert.ok(over.stderr.includes(String(hooks.HEADLINE_MAX)), 'error names the limit');
    assert.ok(over.stderr.includes(String(hooks.HEADLINE_MAX + 1)), 'error names the actual length');
    assert.ok(/"did"/.test(over.stderr), 'error points the agent at did for the longer text');
    assert.strictEqual(read(target).trim().split('\n').length, 2, 'rejected line must not be written');
  });
  check('append: bare invocation still runs the stop hook (allows on garbage stdin)', () => {
    const out = spawnSync(process.execPath, [HOOK_SCRIPT], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(out.status, 0);
    assert.strictEqual(out.stdout, '');
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

  check('hooks: stop targets the resolved project, not the launch cwd', () => {
    const parent = path.dirname(proj1);
    fs.mkdirSync(path.join(proj1, '.membridge'), { recursive: true });
    const state = util.loadState();
    state.projects[proj1] = state.projects[proj1] || { events: [] };
    state.projects[proj1].events.push(
      { ts: '2026-07-16T12:00:00.000Z', source: 'Claude Code', kind: 'edit', session: 'hook-sess', file: path.join(proj1, 'src', 'login.js') });
    util.saveState(state);
    const payload = JSON.stringify({ session_id: 'hook-sess', cwd: parent });
    const res = spawnSync('node', [BIN, 'hook', 'stop'], { input: payload, env: process.env, encoding: 'utf8' });
    // Must BLOCK (non-empty stdout) — pre-fix, cwd=parent isn't a tracked project so the
    // hook returned early with no output; this assertion is the red state.
    assert.ok(res.stdout && res.stdout.trim(), 'hook must block by resolving the session edits to proj1');
    const out = JSON.parse(res.stdout.trim());
    assert.strictEqual(out.decision, 'block', 'decision is block');
    assert.ok(out.reason.includes(path.join(proj1, '.membridge', 'summaries.jsonl')), 'targets resolved proj1');
    assert.ok(!out.reason.includes(path.join(parent, '.membridge')), 'not the cwd');
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
    assert.ok(claude.includes('Did: Checkpoint three'), 'block should show the latest checkpoint');
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

  // Regression: a real multi-prompt session — two distilled checkpoints
  // written while DIFFERENT prompts were current. The sequence exists only at
  // the session level, so it must be collected per session and attached to one
  // representative entry, never scattered across (or duplicated onto) the
  // prompts that happened to be current as each line landed.
  const projMp = path.join(ROOT, 'projects', 'multi-prompt-app');
  fs.mkdirSync(path.join(projMp, 'src'), { recursive: true });
  const mpCDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-multi-prompt-app');
  fs.mkdirSync(mpCDir, { recursive: true });
  fs.writeFileSync(path.join(mpCDir, 'mp1.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'Build the export pipeline for weekly reports' }, cwd: projMp, timestamp: '2026-07-14T05:00:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projMp, 'src', 'export.js') } }] }, cwd: projMp, timestamp: '2026-07-14T05:01:00.000Z' },
    { type: 'user', message: { role: 'user', content: 'confirm which file holds the cron config' }, cwd: projMp, timestamp: '2026-07-14T05:10:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(projMp, 'src', 'cron.js') } }] }, cwd: projMp, timestamp: '2026-07-14T05:11:00.000Z' },
  ]));
  fs.mkdirSync(path.join(projMp, '.membridge'), { recursive: true });
  fs.writeFileSync(path.join(projMp, '.membridge', 'summaries.jsonl'),
    JSON.stringify({ session: 'mp1', ts: '2026-07-14T05:05:00.000Z', did: 'Checkpoint alpha: built the report exporter and wired the weekly scheduler.' }) + '\n' +
    JSON.stringify({ session: 'mp1', ts: '2026-07-14T05:15:00.000Z', did: 'Checkpoint beta: moved the cron config into its own module and covered it with tests.' }) + '\n');
  syncOnce();

  check('checkpoint: multi-prompt session — memory.json carries the ordered sequence on one entry', () => {
    const db = JSON.parse(read(path.join(projMp, '.membridge', 'memory.json')));
    const withSeq = db.entries.filter(e => Array.isArray(e.checkpoints));
    assert.strictEqual(withSeq.length, 1, `expected exactly one entry with checkpoints, got ${withSeq.length}`);
    const entry = withSeq[0];
    assert.strictEqual(entry.checkpoints.length, 2, `expected 2 checkpoints, got ${entry.checkpoints.length}`);
    assert.ok(entry.checkpoints[0].includes('Checkpoint alpha'), `first checkpoint was: ${entry.checkpoints[0]}`);
    assert.ok(entry.checkpoints[1].includes('Checkpoint beta'), `second checkpoint was: ${entry.checkpoints[1]}`);
    // attached to the session's latest summary-bearing entry (the second prompt)
    assert.strictEqual(entry.ts, '2026-07-14T05:10:00.000Z', `sequence attached to the wrong entry: ${entry.ts}`);
    // no checkpoint text duplicated or mis-attributed onto any other entry
    const others = JSON.stringify(db.entries.filter(e => e !== entry));
    assert.ok(!others.includes('Checkpoint alpha') && !others.includes('Checkpoint beta'),
      'checkpoint text leaked onto another entry');
  });
  check('checkpoint: multi-prompt session — memory.md renders one Checkpoints block, in order', () => {
    const mem = read(path.join(projMp, '.membridge', 'memory.md'));
    assert.strictEqual(count(mem, 'Checkpoints:'), 1, `expected exactly one Checkpoints block, got ${count(mem, 'Checkpoints:')}`);
    const i1 = mem.indexOf('1. Checkpoint alpha'), i2 = mem.indexOf('2. Checkpoint beta');
    assert.ok(i1 > -1 && i2 > i1, `numbered checkpoints missing or out of order: ${[i1, i2]}`);
    assert.strictEqual(count(mem, 'Checkpoint alpha'), 1, 'first checkpoint text duplicated in memory.md');
    assert.strictEqual(count(mem, 'Checkpoint beta'), 1, 'second checkpoint text duplicated in memory.md');
    assert.ok(!mem.includes('Result: Checkpoint'), 'a checkpoint also rendered as a Result line');
  });
  check('checkpoint: multi-prompt session — injected block shows only the latest checkpoint', () => {
    const claude = read(path.join(projMp, 'CLAUDE.md'));
    assert.ok(claude.includes('Did: Checkpoint beta'), 'block missing the latest checkpoint');
    assert.ok(!claude.includes('Checkpoint alpha'), 'block leaked an earlier checkpoint');
    assert.strictEqual(count(claude, 'Checkpoint beta'), 1, 'block repeated the checkpoint');
  });

  // --- prompt-sharing gate: verbatim asks stay local unless opted in ---
  // Every assertion inspects the rows the mock server actually received: the
  // gate is about what crosses the wire, not what the client believes it sent.
  const mockPg = createMockSupabase();
  await new Promise(r => mockPg.server.listen(17950, '127.0.0.1', r));
  process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17950';
  process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
  const pgTs = sec => new Date(Date.now() - sec * 1000).toISOString();
  const projPg = path.join(ROOT, 'projects', 'prompt-gate-app');
  fs.mkdirSync(projPg, { recursive: true });
  try {
    // setupFixtures opted this home in for the legacy team tests; the gate's
    // shipped DEFAULT (no sharePrompts key at all) is what (a) must pin.
    {
      const rc = util.loadUserConfig();
      if (rc.team) delete rc.team.sharePrompts;
      util.saveUserConfig(rc);
    }
    {
      const st = util.loadState();
      st.projects[projPg] = { events: [
        { ts: pgTs(600), source: 'Claude Code', kind: 'prompt', text: 'Wire the payment gateway timeout retries', session: 'pg1' },
        { ts: pgTs(550), source: 'Distilled', kind: 'summary', text: 'Gate summary: retries wired with capped backoff and a dead-letter path.', session: 'pg1' },
      ] };
      util.saveState(st);
    }
    await teamsync.signup(util.getConfig(), 'gina@test.dev', 'pw-g', 'Gina');
    const teamPg = await teamsync.createTeam(util.getConfig(), 'GateTeam');
    await teamsync.linkProject(util.getConfig(), projPg, teamPg.team_id, 'GateTeam');

    await teamsync.syncTeams({ project: projPg });
    check('privacy: default push uploads ask=null; summary and files still upload', () => {
      const rows = mockPg.entries;
      assert.ok(rows.length >= 1, `no rows pushed (${rows.length})`);
      assert.ok(rows.every(r => r.ask === null), `an ask left the machine: ${JSON.stringify(rows.map(r => r.ask))}`);
      assert.ok(rows.some(r => r.summary && r.summary.includes('capped backoff')), 'summary stopped uploading');
      assert.ok(rows.every(r => Array.isArray(r.files)), 'files field missing from pushed rows');
      assert.ok(!JSON.stringify(rows).includes('payment gateway'), 'verbatim prompt text reached the server');
    });

    // Opt in, then push a later entry (past the push cursor) from a second
    // session, with a planted secret to prove redaction still runs on the ask.
    {
      const st = util.loadState();
      st.projects[projPg].events.push(
        { ts: pgTs(120), source: 'Codex', kind: 'prompt', text: 'Ship the billing exporter, api_key=sk-gate-secret-99', session: 'pg2' },
        { ts: pgTs(60), source: 'Distilled', kind: 'summary', text: 'Exporter shipped behind the nightly cron with checksum verification.', session: 'pg2' },
      );
      util.saveState(st);
    }
    {
      const rc = util.loadUserConfig();
      rc.team = { ...(rc.team || {}), sharePrompts: true };
      util.saveUserConfig(rc);
    }
    await teamsync.syncTeams({ project: projPg });
    check('privacy: sharePrompts=true uploads the ask, still redacted', () => {
      const row = mockPg.entries.find(e => e.ask && e.ask.includes('Ship the billing exporter'));
      assert.ok(row, `opted-in ask not uploaded: ${JSON.stringify(mockPg.entries.map(e => e.ask))}`);
      assert.ok(row.ask.includes('[redacted'), `shared ask skipped redaction: ${row.ask}`);
      assert.ok(!JSON.stringify(mockPg.entries).includes('sk-gate-secret-99'), 'secret reached the server');
      assert.ok(mockPg.entries.some(r => r.ask === null), 'earlier gated rows should stay ask=null');
    });

    // Pull side: a teammate must see the gated row render cleanly — a
    // placeholder, never a crash or a literal "null"/"undefined".
    const projPgB = path.join(ROOT, 'projects-pg', 'prompt-gate-app');
    fs.mkdirSync(projPgB, { recursive: true });
    fs.writeFileSync(path.join(projPgB, 'CLAUDE.md'), '# PG clone\n\nHank notes.\n');
    process.env.MEMBRIDGE_HOME = path.join(ROOT, 'home-pg');
    util.ensureConfig();
    {
      const st = util.loadState();
      st.projects = { [projPgB]: { events: [
        { ts: pgTs(30), source: 'Claude Code', kind: 'prompt', text: 'Hank reviewing the exporter rollout', session: 'h1' },
      ] } };
      util.saveState(st);
    }
    await teamsync.signup(util.getConfig(), 'hank@test.dev', 'pw-h', 'Hank');
    const joinedPg = await teamsync.joinTeam(util.getConfig(), teamPg.invite_code);
    await teamsync.linkProject(util.getConfig(), projPgB, joinedPg.team_id, joinedPg.team_name);
    const rPg = await teamsync.syncTeams();
    for (const k of rPg.changed) syncOnce({ project: k });
    check('privacy: a pulled null-ask row renders a placeholder, no crash, no null/undefined', () => {
      const st = util.loadState();
      const key = Object.keys(st.projects).find(k => k.toLowerCase() === projPgB.toLowerCase());
      const pulled = st.projects[key].teamEntries || [];
      assert.ok(pulled.some(e => e.ask === null), `no null-ask row pulled: ${JSON.stringify(pulled.map(e => e.ask))}`);
      const md = read(path.join(projPgB, 'CLAUDE.md'));
      assert.ok(md.startsWith('# PG clone'), 'local notes lost');
      assert.ok(md.includes("Teammates' AI activity"), 'team section missing');
      const gatedLine = md.split('\n').find(l => l.includes('· Gina · Claude Code'));
      assert.ok(gatedLine, 'gated teammate entry not injected');
      assert.ok(gatedLine.includes('(prompt not shared)'), `placeholder missing: ${gatedLine}`);
      assert.ok(!gatedLine.includes('undefined') && !/\bnull\b/.test(gatedLine), `null leaked into the line: ${gatedLine}`);
      assert.ok(md.includes('capped backoff'), 'summary Result line missing for the gated entry');
      assert.ok(md.includes('Ship the billing exporter'), 'opted-in ask missing from the pull');
    });

    check('privacy: CLI team share-prompts toggles the config flag', () => {
      const homeCli = path.join(ROOT, 'home-pg-cli');
      const env = { ...process.env, MEMBRIDGE_HOME: homeCli };
      const on = spawnSync(process.execPath, [BIN, 'team', 'share-prompts', 'on'], { env, encoding: 'utf8' });
      assert.strictEqual(on.status, 0, on.stderr);
      assert.ok(/Prompt sharing ON/.test(on.stdout), `on said: ${on.stdout}`);
      assert.strictEqual(JSON.parse(read(path.join(homeCli, 'config.json'))).team.sharePrompts, true, 'flag not saved');
      const off = spawnSync(process.execPath, [BIN, 'team', 'share-prompts', 'off'], { env, encoding: 'utf8' });
      assert.strictEqual(off.status, 0, off.stderr);
      assert.strictEqual(JSON.parse(read(path.join(homeCli, 'config.json'))).team.sharePrompts, false, 'flag not cleared');
      const bad = spawnSync(process.execPath, [BIN, 'team', 'share-prompts', 'maybe'], { env, encoding: 'utf8' });
      assert.strictEqual(bad.status, 1, 'invalid value was accepted');
    });
  } finally {
    process.env.MEMBRIDGE_HOME = HOME_A;
    delete process.env.MEMBRIDGE_TEAM_URL;
    delete process.env.MEMBRIDGE_TEAM_ANON_KEY;
    {
      // Restore the suite-wide opt-in for the sections that follow.
      const rc = util.loadUserConfig();
      rc.team = { ...(rc.team || {}), sharePrompts: true };
      util.saveUserConfig(rc);
    }
    await new Promise(r => mockPg.server.close(r));
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
  const STRIPE_KEY = 'sk_live_' + 'ABCDEFGHIJKLMNOP1234567890';
  const STRIPE_WEBHOOK = 'whsec_' + 'ABCDEFGHIJKLMNOPabcdefghij1234';
  const GOOGLE_OAUTH_SECRET = 'GOCSPX-' + 'ABCDEFGHIJKLMNOP1234567890';
  const SENDGRID_KEY = 'SG.' + 'ABCDEFGHIJKLMNOP1234' + '.' + 'abcdefghijklmnop1234ABCDEFGHIJKLMNOP567';
  const NPM_TOKEN = 'npm_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'; // npm_ + 36
  // Split across a + so no full webhook-URL literal appears contiguously in
  // source — GitHub push protection flags the shape even for obviously-fake
  // tokens. The runtime value (what the redactor is tested against) is identical.
  const SLACK_WEBHOOK = 'https://hooks.slack.com' + '/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX';
  const DISCORD_WEBHOOK = 'https://discord.com/api' + '/webhooks/123456789012345678/AbC-dEf_1234567890AbCdEfGhIjKlMnOpQrStUvWx';
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
    ['stripe-key', `pay ${STRIPE_KEY} now`, STRIPE_KEY],
    ['stripe-webhook-secret', `sig ${STRIPE_WEBHOOK} end`, STRIPE_WEBHOOK],
    ['google-oauth-secret', `oauth ${GOOGLE_OAUTH_SECRET} end`, GOOGLE_OAUTH_SECRET],
    ['sendgrid-key', `mail ${SENDGRID_KEY} sent`, SENDGRID_KEY],
    ['npm-token', `registry ${NPM_TOKEN} used`, NPM_TOKEN],
    ['slack-webhook-url', `post ${SLACK_WEBHOOK} now`, SLACK_WEBHOOK],
    ['discord-webhook-url', `hook ${DISCORD_WEBHOOK} set`, DISCORD_WEBHOOK],
    ['high-entropy', `blob ${ENTROPY_TOKEN} done`, ENTROPY_TOKEN],
  ];
  // E2E crypto primitives (libsodium sealed-box + secretbox). Load once so the
  // sync check body can use the primitives directly (check() doesn't await).
  const teamcrypto = require('../lib/teamcrypto');
  await teamcrypto.ready();
  check('teamcrypto: seal/unseal + secretbox round trip, wrong-key safe, file paths inside ciphertext', () => {
    const a = teamcrypto.genKeypair(), b = teamcrypto.genKeypair();
    const teamKey = teamcrypto.genTeamKey();
    const sealed = teamcrypto.sealTeamKey(teamKey, b.publicKey);
    assert.strictEqual(teamcrypto.unsealTeamKey(sealed, b.publicKey, b.privateKey), teamKey, 'unseal round trip');
    const payload = { ask: 'q', summary: 's', goal: null, decisions: null, gotchas: null, files: ['src/login.js'], changes: null };
    const enc = teamcrypto.encrypt(payload, teamKey);
    assert.deepStrictEqual(teamcrypto.decrypt(enc.ciphertext, enc.nonce, teamKey), payload, 'secretbox round trip');
    assert.strictEqual(teamcrypto.unsealTeamKey(sealed, a.publicKey, a.privateKey), null, 'wrong keypair -> null');
    assert.strictEqual(teamcrypto.decrypt(enc.ciphertext, enc.nonce, teamcrypto.genTeamKey()), null, 'wrong team key -> null');
    assert.ok(!Buffer.from(enc.ciphertext, 'base64').toString('latin1').includes('src/login.js'), 'file path leaked into ciphertext');
    assert.notStrictEqual(teamcrypto.encrypt(payload, teamKey).ciphertext, enc.ciphertext, 'nonce reused');
  });
  // Fingerprints (E2E completion Task 1): a short human-comparable digest of a
  // box pubkey for Signal-style out-of-band verification. The format is a
  // contract — it is what two humans read aloud to each other — so it is
  // asserted exactly: eight 4-hex groups.
  check('teamcrypto: fingerprint is stable, formatted, and key-specific', () => {
    const kp = teamcrypto.genKeypair();
    const fp = teamcrypto.fingerprint(kp.publicKey);
    assert.strictEqual(fp, teamcrypto.fingerprint(kp.publicKey), 'same key -> same fingerprint');
    assert.match(fp, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/, 'eight 4-hex groups');
    assert.notStrictEqual(fp, teamcrypto.fingerprint(teamcrypto.genKeypair().publicKey), 'different key -> different fingerprint');
  });
  // TOFU pin store (E2E completion Task 1): first sight pins, change alerts,
  // and the pinned key is never silently replaced — `membridge team trust` is
  // the only way to re-pin. check() is pure; load/save go through the
  // MEMBRIDGE_HOME-isolated pins.json.
  const teampins = require('../lib/teampins');
  check('teampins: TOFU pins unseen keys, alerts on change, load/save round trip', () => {
    const kA = teamcrypto.genKeypair(), kB = teamcrypto.genKeypair(), kEvil = teamcrypto.genKeypair();
    const fetched = [
      { user_id: 'u-a', public_key: kA.publicKey, display_name: 'Alice' },
      { user_id: 'u-b', public_key: kB.publicKey, display_name: 'Bob' },
    ];
    const first = teampins.check({}, fetched, '2026-07-21T00:00:00Z');
    assert.strictEqual(first.allowed.length, 2, 'all first-sight keys allowed (TOFU)');
    assert.strictEqual(first.alerts.length, 0, 'no alerts on first sight');
    assert.strictEqual(first.pins['u-a'].publicKey, kA.publicKey, 'pinned A');
    assert.strictEqual(first.pins['u-b'].name, 'Bob', 'pin carries the display name');
    // The server swaps Bob's key: Bob is excluded and alerted, Alice unaffected,
    // and Bob's PIN keeps the original key.
    const swapped = [fetched[0], { user_id: 'u-b', public_key: kEvil.publicKey, display_name: 'Bob' }];
    const second = teampins.check(first.pins, swapped, '2026-07-22T00:00:00Z');
    assert.deepStrictEqual(second.allowed.map(m => m.user_id), ['u-a'], 'changed key excluded from allowed');
    assert.strictEqual(second.alerts.length, 1, 'exactly one alert');
    assert.strictEqual(second.alerts[0].user_id, 'u-b', 'alert names the member');
    assert.strictEqual(second.alerts[0].pinned, kB.publicKey, 'alert carries the pinned key');
    assert.strictEqual(second.alerts[0].fetched, kEvil.publicKey, 'alert carries the fetched key');
    assert.strictEqual(second.pins['u-b'].publicKey, kB.publicKey, 'pin NOT overwritten by a changed key');
    assert.strictEqual(first.pins['u-b'].publicKey, kB.publicKey, 'input pins object never mutated');
    teampins.save(second.pins);
    assert.deepStrictEqual(teampins.load(), second.pins, 'save/load round trip');
    fs.writeFileSync(teampins.pinsPath(), '{nope');
    assert.deepStrictEqual(teampins.load(), {}, 'corrupt pins file -> empty, never a crash');
    teampins.save(second.pins); // leave a valid file behind for later sections
  });
  // Private-key storage. The real keychain only exists on macOS, so off-darwin
  // this asserts the fail-closed contract instead of skipping blind.
  const keychain = require('../lib/keychain');
  // argv hardening (E2E completion Task 2): argv is world-readable via `ps`,
  // so the secret must travel to `security` on stdin, never as an argument.
  // Runner-injected so the assertion is about command construction, not the
  // real keychain; the darwin round-trip check below exercises the real path.
  check('keychain: store passes the secret via stdin, never argv', () => {
    if (process.platform !== 'darwin') return; // store() fails closed off-darwin by design
    const calls = [];
    const prev = keychain._setRunner((args, input) => { calls.push({ args, input: input || '' }); return { status: 0, stdout: '' }; });
    try {
      const secret = 'U0VDUkVULXZh+bHVl/wow==';
      assert.ok(keychain.store('membridge.test.stdin', secret), 'store failed');
      assert.ok(calls.every(c => !c.args.join(' ').includes(secret)), 'secret leaked into argv');
      const store = calls.find(c => c.args[0] === '-i');
      assert.ok(store, 'store must run security in -i (stdin command) mode');
      assert.ok(store.input.includes(secret), 'secret travels on stdin');
      assert.ok(/add-generic-password/.test(store.input), 'stdin carries the add command');
      assert.ok(/-U/.test(store.input), 'idempotent update flag preserved');
    } finally { keychain._setRunner(prev); }
  });
  check('keychain: store/load/remove round trip on macOS; fails closed elsewhere', () => {
    if (!keychain.available()) {
      assert.strictEqual(keychain.load('anything'), null, 'unavailable load must be null');
      assert.strictEqual(keychain.store('a', 'b'), false, 'unavailable store must be false');
      return; // no `security` binary: fail-closed contract verified, nothing more to test
    }
    const acct = 'membridge.test.' + Date.now();
    assert.ok(keychain.store(acct, 'SECRET-VALUE'), 'store failed');
    assert.strictEqual(keychain.load(acct), 'SECRET-VALUE', 'load round trip');
    assert.ok(keychain.store(acct, 'SECOND'), 're-store (update) failed');
    assert.strictEqual(keychain.load(acct), 'SECOND', 'update round trip');
    assert.ok(keychain.remove(acct), 'remove failed');
    assert.strictEqual(keychain.load(acct), null, 'load after remove must be null');
  });
  // Identity bootstrap (ensureIdentity, plan Task 4): pure by injection, so
  // every scenario runs offline against fakes — no network, no real keychain.
  // Awaits happen at block level (check() doesn't await), wrapped so a missing
  // helper fails the checks instead of killing the runner.
  {
    const mkIdFakes = (opts = {}) => {
      const stored = new Map(opts.preload || []);
      const calls = { store: [], upload: [], gen: 0 };
      return {
        stored, calls,
        deps: {
          keychain: {
            available: () => opts.keychainAvailable !== false,
            load: a => (stored.has(a) ? stored.get(a) : null),
            store: (a, s) => {
              calls.store.push(a);
              if (opts.storeFails) return false;
              stored.set(a, s);
              return true;
            },
            remove: a => stored.delete(a),
          },
          teamcrypto: {
            available: () => opts.cryptoAvailable !== false,
            ready: async () => {},
            genKeypair: () => {
              calls.gen++;
              return { publicKey: 'PUB' + calls.gen, privateKey: 'PRIV' + calls.gen };
            },
          },
          uploadPubkey: async row => { calls.upload.push(row); },
        },
      };
    };
    const idCreds = { userId: 'user-1', accessToken: 'tok' };
    let idErr = null;
    const fresh = mkIdFakes();
    const noCrypto = mkIdFakes({ cryptoAvailable: false });
    const noChain = mkIdFakes({ keychainAvailable: false });
    const halfPair = mkIdFakes({ preload: [['membridge.box.privatekey', 'ORPHAN-PRIV']] });
    const badStore = mkIdFakes({ storeFails: true });
    let id1, id2, idNoCrypto, idNoChain, idNoCreds, idHalf, idBadStore;
    try {
      id1 = await teamsync.ensureIdentity(idCreds, fresh.deps);
      id2 = await teamsync.ensureIdentity(idCreds, fresh.deps);
      idNoCrypto = await teamsync.ensureIdentity(idCreds, noCrypto.deps);
      idNoChain = await teamsync.ensureIdentity(idCreds, noChain.deps);
      idNoCreds = await teamsync.ensureIdentity(null, fresh.deps);
      idHalf = await teamsync.ensureIdentity(idCreds, halfPair.deps);
      idBadStore = await teamsync.ensureIdentity(idCreds, badStore.deps);
    } catch (e) { idErr = e; }

    check('teamsync: ensureIdentity first call generates a pair, stores both halves, uploads the pubkey once', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.deepStrictEqual(id1, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(fresh.calls.gen, 1, 'expected exactly one keypair generation');
      assert.strictEqual(fresh.stored.get('membridge.box.privatekey'), 'PRIV1', 'private key not stored');
      assert.strictEqual(fresh.stored.get('membridge.box.publickey'), 'PUB1', 'public key not stored');
      // Both block-level calls have already run by check time; the FIRST
      // upload is the generation-time one (the second is the self-heal
      // upsert asserted below).
      assert.deepStrictEqual(fresh.calls.upload[0], { user_id: 'user-1', public_key: 'PUB1' },
        'first call must upload { user_id, public_key }');
    });

    check('teamsync: ensureIdentity second call reuses the stored pair and re-upserts the pubkey (self-heal)', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.deepStrictEqual(id2, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(fresh.calls.gen, 1, 'second call must not regenerate');
      // The upsert is idempotent (merge-duplicates on user_id) and MUST run
      // every call: a locally-persisted identity whose first upload failed
      // (e.g. keypair generated before the backend migrated) would otherwise
      // never publish its pubkey and the team key could never seal to it.
      assert.strictEqual(fresh.calls.upload.length, 2, 'every call must (re)upsert the pubkey');
      assert.strictEqual(fresh.calls.upload[1].public_key, 'PUB1', 'the re-upsert must carry the stored pubkey');
    });

    check('teamsync: ensureIdentity fails closed — unavailable crypto/keychain or missing creds return null, nothing stored or uploaded', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.strictEqual(idNoCrypto, null);
      assert.strictEqual(noCrypto.calls.store.length + noCrypto.calls.upload.length, 0, 'unavailable crypto must be a no-op');
      assert.strictEqual(idNoChain, null);
      assert.strictEqual(noChain.calls.store.length + noChain.calls.upload.length, 0, 'unavailable keychain must be a no-op');
      assert.strictEqual(idNoCreds, null, 'missing creds must return null');
    });

    check('teamsync: ensureIdentity self-heals a half-missing pair by regenerating and re-uploading', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.deepStrictEqual(idHalf, { publicKey: 'PUB1', privateKey: 'PRIV1' });
      assert.strictEqual(halfPair.stored.get('membridge.box.privatekey'), 'PRIV1', 'orphaned private key must be replaced');
      assert.strictEqual(halfPair.calls.upload.length, 1, 'regenerated pubkey must be uploaded');
    });

    check('teamsync: ensureIdentity returns null and uploads nothing when the keychain cannot persist the key', () => {
      assert.ok(!idErr, `ensureIdentity threw: ${idErr && idErr.message}`);
      assert.strictEqual(idBadStore, null, 'a key we cannot retain must not be reported as an identity');
      assert.strictEqual(badStore.calls.upload.length, 0, 'must not upload a pubkey whose private half was not persisted');
    });
  }

  // Team-key handling (resolveTeamKey, plan Task 5): same injected-deps
  // convention as ensureIdentity above. deps.teamId names the team the
  // closures are bound to (inserted rows carry it), deps.cache is the
  // caller-owned per-sync-run Map — injection, not module state, so the
  // "one pass" lifetime is the caller's by construction.
  {
    const mkKeyFakes = (opts = {}) => {
      const calls = { fetchRow: 0, fetchRowEpochs: [], fetchMembers: 0, inserts: [], gen: 0, seal: [], unseal: 0 };
      return {
        calls,
        deps: {
          teamId: opts.teamId || 'team-1',
          cache: opts.cache,
          teamcrypto: {
            available: () => opts.cryptoAvailable !== false,
            ready: async () => {},
            genTeamKey: () => { calls.gen++; return 'RAWKEY' + calls.gen; },
            sealTeamKey: (key, pub) => { calls.seal.push([key, pub]); return `SEALED(${key}->${pub})`; },
            unsealTeamKey: sealed => { calls.unseal++; return opts.unsealFails ? null : 'UNSEALED-' + sealed; },
          },
          fetchMySealedRow: async epoch => {
            calls.fetchRow++;
            calls.fetchRowEpochs.push(epoch);
            return opts.myRow || null;
          },
          fetchMemberPubkeys: async () => { calls.fetchMembers++; return opts.members || []; },
          insertSealedRows: async rows => { calls.inserts.push(rows); },
        },
      };
    };
    const keyIdentity = { publicKey: 'MYPUB', privateKey: 'MYPRIV' };
    const twoMembers = [
      { user_id: 'u-a', public_key: 'PUB-A' },
      { user_id: 'u-b', public_key: 'PUB-B' },
    ];
    let tkErr = null;
    const mint = mkKeyFakes({ members: twoMembers, teamId: 'team-mint' });
    const have = mkKeyFakes({ myRow: { sealed_team_key: 'BLOB' }, teamId: 'team-have' });
    const cached = mkKeyFakes({ myRow: { sealed_team_key: 'BLOB2' }, teamId: 'team-cache', cache: new Map() });
    const badUnseal = mkKeyFakes({ myRow: { sealed_team_key: 'BAD' }, unsealFails: true, teamId: 'team-bad', cache: new Map() });
    const noCrypto = mkKeyFakes({ cryptoAvailable: false, teamId: 'team-off' });
    let kMint, kHave, kC1, kC2, kC3, kBad, kBadAgain, kOff, kNoId;
    try {
      kMint = await teamsync.resolveTeamKey(keyIdentity, 3, mint.deps);
      kHave = await teamsync.resolveTeamKey(keyIdentity, 1, have.deps);
      kC1 = await teamsync.resolveTeamKey(keyIdentity, 1, cached.deps);
      kC2 = await teamsync.resolveTeamKey(keyIdentity, 1, cached.deps);   // same epoch: cache hit
      kC3 = await teamsync.resolveTeamKey(keyIdentity, 2, cached.deps);   // new epoch: cache miss
      kBad = await teamsync.resolveTeamKey(keyIdentity, 1, badUnseal.deps);
      kBadAgain = await teamsync.resolveTeamKey(keyIdentity, 1, badUnseal.deps); // failure must not be cached
      kOff = await teamsync.resolveTeamKey(keyIdentity, 1, noCrypto.deps);
      kNoId = await teamsync.resolveTeamKey(null, 1, mkKeyFakes().deps);
    } catch (e) { tkErr = e; }

    check('teamsync: resolveTeamKey (pull side) with no sealed row fails closed — never mints', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kMint, null, 'an epoch I was never sealed into is unreadable, full stop');
      assert.strictEqual(mint.calls.gen, 0, 'pull-side resolution must never generate a key');
      assert.deepStrictEqual(mint.calls.fetchRowEpochs, [3], 'fetchMySealedRow must receive the epoch');
      assert.strictEqual(mint.calls.inserts.length, 0, 'pull-side resolution must never insert');
    });

    check('teamsync: resolveTeamKey with an existing sealed row unseals it — no generation, no insert', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kHave, 'UNSEALED-BLOB');
      assert.strictEqual(have.calls.gen, 0, 'must not generate when a sealed row exists');
      assert.strictEqual(have.calls.inserts.length, 0, 'must not insert when a sealed row exists');
      assert.strictEqual(have.calls.fetchMembers, 0, 'must not fetch member pubkeys when a sealed row exists');
    });

    check('teamsync: resolveTeamKey caches per (team, epoch) for the injected cache\'s lifetime', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kC1, 'UNSEALED-BLOB2');
      assert.strictEqual(kC2, 'UNSEALED-BLOB2', 'second call must return the same key');
      assert.strictEqual(cached.calls.fetchRow, 2, 'same epoch must be served from cache (1 fetch) + new epoch refetches (2nd)');
      assert.strictEqual(cached.calls.fetchRowEpochs[1], 2, 'only the new epoch may refetch');
      assert.strictEqual(kC3, 'UNSEALED-BLOB2', 'different epoch resolves independently (same fake blob)');
    });

    check('teamsync: resolveTeamKey fails closed — unseal failure or unavailable crypto/identity returns null with no inserts, and failures are never cached', () => {
      assert.ok(!tkErr, `resolveTeamKey threw: ${tkErr && tkErr.message}`);
      assert.strictEqual(kBad, null, 'unseal failure must return null');
      assert.strictEqual(kBadAgain, null);
      assert.strictEqual(badUnseal.calls.fetchRow, 2, 'a failed resolve must not be cached — second call refetches');
      assert.strictEqual(badUnseal.calls.inserts.length, 0, 'unseal failure must not insert');
      assert.strictEqual(kOff, null, 'unavailable crypto must return null');
      assert.strictEqual(noCrypto.calls.fetchRow, 0, 'unavailable crypto must not fetch');
      assert.strictEqual(kNoId, null, 'missing identity must return null');
    });
  }

  // Current-key resolution (E2E completion Task 3): epoch discovery from the
  // team-wide key rows, rotation when membership shrank, join-seal for members
  // missing at the current epoch, continuous TOFU gating of every seal target,
  // and lost mint races resolved by reading back my own sealed row. The fake
  // seal is a reversible string encoding (S(KEY->PUB)) so a concurrent
  // winner's key can round-trip without real crypto.
  {
    const teampins2 = require('../lib/teampins');
    const mkCur = (opts = {}) => {
      const calls = { rowFetches: 0, inserts: [], gen: 0, alerts: [], myRowEpochs: [] };
      let stored = opts.rows ? opts.rows.slice() : [];
      const pinsBox = { pins: opts.pins ? { ...opts.pins } : {} };
      return {
        calls, pinsBox,
        deps: {
          teamId: opts.teamId || 'team-cur', userId: 'me', cache: opts.cache,
          teamcrypto: {
            available: () => true, ready: async () => {},
            genTeamKey: () => 'RAW' + (++calls.gen),
            sealTeamKey: (key, pub) => `S(${key}->${pub})`,
            unsealTeamKey: sealed => { const m = /^S\((.+?)->/.exec(sealed || ''); return m ? m[1] : null; },
          },
          pins: { load: () => pinsBox.pins, save: p => { pinsBox.pins = p; }, check: teampins2.check },
          onAlert: a => calls.alerts.push(...a),
          fetchTeamKeyRows: async () => { calls.rowFetches++; return stored.map(r => ({ ...r })); },
          fetchMembers: async () => opts.members || [],
          fetchMemberPubkeys: async () => opts.pubkeys || [],
          fetchMySealedRow: async epoch => {
            calls.myRowEpochs.push(epoch);
            const mine = stored.find(r => r.epoch === epoch && r.member_user_id === 'me');
            if (mine) return mine;
            // A concurrent minter won the insert race: read-back sees THEIR
            // key sealed to me, not the rows this client tried to write.
            if (opts.raceWinnerKey) return { sealed_team_key: `S(${opts.raceWinnerKey}->MYPUB)` };
            return null;
          },
          insertSealedRows: async rows => {
            calls.inserts.push(rows);
            if (!opts.dropInserts) stored = stored.concat(rows);
          },
        },
      };
    };
    const me = { user_id: 'me', public_key: 'MYPUB', display_name: 'Me' };
    const bob = { user_id: 'u-b', public_key: 'PUB-B', display_name: 'Bob' };
    const idc = { publicKey: 'MYPUB', privateKey: 'MYPRIV' };
    const membersOf = list => list.map(m => ({ user_id: m.user_id, display_name: m.display_name }));
    const pubsOf = list => list.map(m => ({ user_id: m.user_id, public_key: m.public_key }));
    const bothRows = [
      { epoch: 1, member_user_id: 'me', sealed_team_key: 'S(K1->MYPUB)' },
      { epoch: 1, member_user_id: 'u-b', sealed_team_key: 'S(K1->PUB-B)' },
    ];

    const fresh = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]) });
    const have = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), rows: bothRows });
    const rotate = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]),
      rows: bothRows.concat([{ epoch: 1, member_user_id: 'u-gone', sealed_team_key: 'S(K1->PUB-GONE)' }]) });
    const joinCase = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), rows: [bothRows[0]] });
    const tofu = mkCur({ members: membersOf([me, bob]),
      pubkeys: [pubsOf([me])[0], { user_id: 'u-b', public_key: 'EVIL' }],
      pins: { 'u-b': { publicKey: 'PUB-B', name: 'Bob', firstSeen: 't0' } } });
    const race = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), dropInserts: true, raceWinnerKey: 'WINNER' });
    const wait = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]),
      rows: [{ epoch: 2, member_user_id: 'u-b', sealed_team_key: 'S(K2->PUB-B)' }] });
    const cachedCur = mkCur({ members: membersOf([me, bob]), pubkeys: pubsOf([me, bob]), cache: new Map(), rows: bothRows });

    let curErr = null, rFresh, rHave, rRotate, rJoin, rTofu, rRace, rWait, rCached1, rCached2;
    try {
      rFresh = await teamsync.resolveCurrentTeamKey(idc, fresh.deps);
      rHave = await teamsync.resolveCurrentTeamKey(idc, have.deps);
      rRotate = await teamsync.resolveCurrentTeamKey(idc, rotate.deps);
      rJoin = await teamsync.resolveCurrentTeamKey(idc, joinCase.deps);
      rTofu = await teamsync.resolveCurrentTeamKey(idc, tofu.deps);
      rRace = await teamsync.resolveCurrentTeamKey(idc, race.deps);
      rWait = await teamsync.resolveCurrentTeamKey(idc, wait.deps);
      rCached1 = await teamsync.resolveCurrentTeamKey(idc, cachedCur.deps);
      rCached2 = await teamsync.resolveCurrentTeamKey(idc, cachedCur.deps);
    } catch (e) { curErr = e; }

    check('teamsync: resolveCurrentTeamKey mints epoch 1 for a fresh team, sealed to every pinned member', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rFresh, { teamKey: 'RAW1', epoch: 1 });
      assert.strictEqual(fresh.calls.inserts.length, 1, 'one insert batch');
      assert.deepStrictEqual(fresh.calls.inserts[0].map(r => r.member_user_id).sort(), ['me', 'u-b'], 'sealed to both members');
      assert.ok(fresh.calls.inserts[0].every(r => r.epoch === 1), 'fresh team mints at epoch 1');
      assert.strictEqual(fresh.pinsBox.pins['u-b'].publicKey, 'PUB-B', 'TOFU pinned the teammate key');
    });

    check('teamsync: resolveCurrentTeamKey with my sealed row unseals it — no mint, no insert', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rHave, { teamKey: 'K1', epoch: 1 });
      assert.strictEqual(have.calls.gen, 0, 'must not generate');
      assert.strictEqual(have.calls.inserts.length, 0, 'must not insert');
    });

    check('teamsync: resolveCurrentTeamKey rotates to a new epoch when the current one is sealed to a removed member', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rRotate, { teamKey: 'RAW1', epoch: 2 });
      assert.strictEqual(rotate.calls.inserts.length, 1, 'one mint batch');
      assert.ok(rotate.calls.inserts[0].every(r => r.epoch === 2), 'rotation mints the NEXT epoch');
      assert.deepStrictEqual(rotate.calls.inserts[0].map(r => r.member_user_id).sort(), ['me', 'u-b'],
        'the removed member gets no sealed row at the new epoch');
    });

    check('teamsync: resolveCurrentTeamKey join-seals the current key to members missing at the current epoch', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rJoin, { teamKey: 'K1', epoch: 1 });
      assert.strictEqual(joinCase.calls.gen, 0, 'join is a seal of the EXISTING key, not a rotation');
      assert.strictEqual(joinCase.calls.inserts.length, 1, 'one join-seal insert');
      assert.deepStrictEqual(joinCase.calls.inserts[0],
        [{ team_id: 'team-cur', epoch: 1, member_user_id: 'u-b', sealed_team_key: 'S(K1->PUB-B)' }],
        'the joiner gets the current key sealed to their pinned pubkey');
    });

    check('teamsync: resolveCurrentTeamKey excludes a member whose fetched key contradicts the pin, and alerts', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rTofu, { teamKey: 'RAW1', epoch: 1 }, 'the mint itself proceeds for verified members');
      assert.deepStrictEqual(tofu.calls.inserts[0].map(r => r.member_user_id), ['me'], 'mismatched member NOT sealed to');
      assert.strictEqual(tofu.calls.alerts.length, 1, 'one alert');
      assert.strictEqual(tofu.calls.alerts[0].user_id, 'u-b');
      assert.strictEqual(tofu.calls.alerts[0].fetched, 'EVIL');
      assert.strictEqual(tofu.pinsBox.pins['u-b'].publicKey, 'PUB-B', 'pin survives the attack');
    });

    check('teamsync: resolveCurrentTeamKey losing a mint race adopts the winner\'s key via read-back', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rRace, { teamKey: 'WINNER', epoch: 1 },
        'the key that COUNTS is whatever my read-back row unseals to, never my candidate');
    });

    check('teamsync: resolveCurrentTeamKey with an epoch I am not sealed into waits (null) — no mint, fail closed', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.strictEqual(rWait, null, 'a teammate must join-seal me; minting would fork the team key');
      assert.strictEqual(wait.calls.gen, 0, 'must not mint over an existing epoch');
      assert.strictEqual(wait.calls.inserts.length, 0, 'must not insert');
    });

    check('teamsync: resolveCurrentTeamKey caches the resolution for the injected cache\'s lifetime', () => {
      assert.ok(!curErr, `resolveCurrentTeamKey threw: ${curErr && curErr.message}`);
      assert.deepStrictEqual(rCached1, { teamKey: 'K1', epoch: 1 });
      assert.deepStrictEqual(rCached2, rCached1, 'second call returns the same resolution');
      assert.strictEqual(cachedCur.calls.rowFetches, 1, 'second call must be served from cache');
    });
  }

  // Encrypt-on-push (encryptRow + syncTeams wiring, plan Task 6 Part A).
  // encryptRow is pure and tested with REAL libsodium (already ready()'d
  // above — no keychain involved, so no machine side effects); the wiring's
  // fail-closed path runs the real syncTeams against a fresh mock backend
  // with injected unavailable crypto deps.
  {
    const tcReal = require('../lib/teamcrypto');
    const pushRow = {
      project_id: 'p-1', author_id: 'u-1', author_name: 'Marco',
      ts: '2026-07-18T10:00:00.000Z', source: 'Claude Code', session: 's1',
      ask: 'redacted ask', goal: null, decisions: 'kept it', gotchas: null,
      files: ['src/a.js'], changes: null, summary: 'did the thing',
    };
    let encErr = null, encOff, encOn, encRound;
    try {
      encOff = teamsync.encryptRow(pushRow, null, 1, { teamcrypto: null });
      const teamKey = tcReal.genTeamKey();
      encOn = teamsync.encryptRow(pushRow, teamKey, 1, { teamcrypto: tcReal });
      encRound = tcReal.decrypt(encOn.ciphertext, encOn.nonce, teamKey);
    } catch (e) { encErr = e; }

    check('teamsync: encryptRow with no team key returns the row unchanged (flag-off byte-identical)', () => {
      assert.ok(!encErr, `encryptRow threw: ${encErr && encErr.message}`);
      assert.strictEqual(encOff, pushRow, 'flag-off must return the SAME row object, not a copy');
    });

    check('teamsync: encryptRow dual-writes — ciphertext/nonce/key_epoch added, plaintext intact, payload round-trips', () => {
      assert.ok(!encErr, `encryptRow threw: ${encErr && encErr.message}`);
      assert.ok(encOn.ciphertext && encOn.nonce, 'ciphertext/nonce missing');
      assert.strictEqual(encOn.key_epoch, 1);
      assert.strictEqual(encOn.ask, 'redacted ask', 'plaintext ask must still be present (dual-write)');
      assert.strictEqual(encOn.summary, 'did the thing', 'plaintext summary must still be present');
      assert.strictEqual(encOn.project_id, 'p-1', 'metadata must be untouched');
      assert.ok(!('ciphertext' in pushRow), 'input row must not be mutated');
      assert.deepStrictEqual(encRound, {
        ask: 'redacted ask', summary: 'did the thing', goal: null,
        decisions: 'kept it', gotchas: null, files: ['src/a.js'], changes: null,
      }, 'decrypting must return exactly the seven content fields');
    });

    // Cutover flag (E2E completion Task 5): plaintextOff strips every content
    // column — the row that crosses the wire is ciphertext + routing metadata
    // only, and the ciphertext still round-trips to the full payload.
    check('teamsync: encryptRow with plaintextOff ships ciphertext-only rows — content columns null, payload intact', () => {
      const teamKey = tcReal.genTeamKey();
      const off = teamsync.encryptRow(pushRow, teamKey, 2, { teamcrypto: tcReal, plaintextOff: true });
      for (const col of ['ask', 'goal', 'decisions', 'gotchas', 'summary', 'files', 'changes']) {
        assert.strictEqual(off[col], null, `${col} must be null under plaintextOff`);
      }
      assert.strictEqual(off.key_epoch, 2, 'epoch must ride along');
      assert.strictEqual(off.project_id, 'p-1', 'routing metadata must survive');
      assert.strictEqual(off.session, 's1', 'session id must survive for threading');
      const payload = tcReal.decrypt(off.ciphertext, off.nonce, teamKey);
      assert.strictEqual(payload.ask, 'redacted ask', 'payload must still carry the full content');
      assert.deepStrictEqual(payload.files, ['src/a.js'], 'files must live inside the ciphertext');
      assert.ok(!('ciphertext' in pushRow), 'input row must not be mutated');
    });

    // Fail-closed wiring: flag ON, crypto/keychain unavailable. The pass must
    // push today's plaintext rows, never throw — and must LOG the fallback,
    // which is what separates "the wiring engaged and failed closed" from
    // "the flag was silently ignored" (this is the assertion that fails
    // before the wiring exists).
    {
      const mockE = createMockSupabase();
      await new Promise(r => mockE.server.listen(17952, '127.0.0.1', r));
      const savedEnvUrl = process.env.MEMBRIDGE_TEAM_URL;
      const savedEnvKey = process.env.MEMBRIDGE_TEAM_ANON_KEY;
      process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17952';
      process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
      const projE = path.join(ROOT, 'projects', 'encrypt-app');
      fs.mkdirSync(projE, { recursive: true });
      // Fail-closed (E2E completion Task 4): with encryption on (the DEFAULT
      // — this home sets no encrypt flag at all) and crypto unavailable,
      // NOTHING may leave in plaintext. The pass pauses, records why, and a
      // later pass with working crypto pushes the held entries encrypted.
      let syncErr = null, syncRes = null, syncRes2 = null, logDelta = '';
      let pushedWhileUnavailable = -1, pausedFlag = null, pausedFlag2 = null;
      try {
        await teamsync.signup(util.getConfig(), 'enc@test.dev', 'pw-e', 'Enc');
        const teamE = await teamsync.createTeam(util.getConfig(), 'EncTeam');
        await teamsync.linkProject(util.getConfig(), projE, teamE.team_id, 'EncTeam');
        const st = util.loadState();
        st.projects[projE] = { events: [
          { ts: '2026-07-18T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'encrypt me maybe', session: 'e1' },
          { ts: '2026-07-18T10:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projE, 'src', 'x.js'), session: 'e1' },
        ] };
        util.saveState(st);
        const raw = util.loadUserConfig();
        if (raw.team) { delete raw.team.encrypt; util.saveUserConfig(raw); } // default-on is the point
        let logBefore = 0;
        try { logBefore = fs.statSync(util.logPath()).size; } catch {}
        syncRes = await teamsync.syncTeams({
          project: projE,
          cryptoDeps: {
            keychain: { available: () => false, load: () => null, store: () => false, remove: () => false },
            teamcrypto: { available: () => false },
            uploadPubkey: async () => { throw new Error('must not be called when unavailable'); },
          },
        });
        try { logDelta = fs.readFileSync(util.logPath(), 'utf8').slice(logBefore); } catch {}
        pushedWhileUnavailable = mockE.entries.length;
        pausedFlag = util.loadState().teamCryptoPaused || null;
        // Recovery pass: crypto works now (in-memory keychain, real libsodium).
        const kcMem = new Map();
        syncRes2 = await teamsync.syncTeams({
          project: projE,
          cryptoDeps: {
            keychain: { available: () => true, load: a => kcMem.get(a) || null, store: (a, s) => { kcMem.set(a, s); return true; }, remove: a => kcMem.delete(a) },
            teamcrypto: tcReal,
          },
        });
        pausedFlag2 = util.loadState().teamCryptoPaused || null;
      } catch (e) { syncErr = e; } finally {
        const raw = util.loadUserConfig();
        raw.team = { ...(raw.team || {}), encrypt: false }; // restore the legacy-home hatch
        util.saveUserConfig(raw);
        process.env.MEMBRIDGE_TEAM_URL = savedEnvUrl;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = savedEnvKey;
        mockE.server.close();
      }
      check('teamsync: encrypted push (default-on) with unavailable crypto fails closed — nothing leaves, pass pauses and says why', () => {
        assert.ok(!syncErr, `syncTeams threw: ${syncErr && syncErr.message}`);
        assert.strictEqual(pushedWhileUnavailable, 0, 'fail-closed push must upload NOTHING without a key');
        assert.ok(pausedFlag, 'state.teamCryptoPaused must record the pause');
        assert.ok((syncRes.errors || []).some(e => /encryption|paused/i.test(e)),
          `pass must surface a paused error, got: ${JSON.stringify(syncRes && syncRes.errors)}`);
        assert.ok(/team encrypt/.test(logDelta), 'expected a logged "team encrypt" line naming the pause');
      });
      check('teamsync: held entries push encrypted on the next pass with working crypto, and the pause clears', () => {
        assert.ok(!syncErr, `syncTeams threw: ${syncErr && syncErr.message}`);
        assert.deepStrictEqual(syncRes2.errors, [], `recovery errors: ${JSON.stringify(syncRes2 && syncRes2.errors)}`);
        assert.ok(mockE.entries.length >= 1, 'recovery pass must push the held entries');
        assert.ok(mockE.entries.every(r => r.ciphertext && r.nonce && r.key_epoch === 1),
          'recovered rows must carry ciphertext/nonce/key_epoch');
        assert.strictEqual(pausedFlag2, null, 'teamCryptoPaused must clear after a successful pass');
      });
    }
  }

  // Decrypt-on-pull + full round trip (plan Task 6 Part B). Two real homes
  // against one mock backend: Alice mints the epoch key and pushes encrypted
  // (dual-write), Bob unseals with his own keypair and pulls. Keychains are
  // in-memory fakes (never the real macOS keychain); libsodium is real.
  // cryptoDeps injects ONLY { keychain, teamcrypto } — uploadPubkey must be
  // inherited from the real wiring (merge, not replace), which is itself part
  // of what these tests pin.
  {
    const tcE2E = require('../lib/teamcrypto');
    const mkMemKeychain = () => {
      const m = new Map();
      return {
        available: () => true,
        load: a => m.get(a) || null,
        store: (a, s) => { m.set(a, s); return true; },
        remove: a => m.delete(a),
      };
    };
    const setTeamCfg = () => {
      util.ensureConfig();
      const raw = util.loadUserConfig();
      raw.team = { ...(raw.team || {}), sharePrompts: true, encrypt: true };
      util.saveUserConfig(raw);
    };
    const savedHome = process.env.MEMBRIDGE_HOME;
    const savedUrl2 = process.env.MEMBRIDGE_TEAM_URL;
    const savedKey2 = process.env.MEMBRIDGE_TEAM_ANON_KEY;
    const homeAlice = path.join(ROOT, 'home-e2ea');
    const homeBob = path.join(ROOT, 'home-e2eb');
    const projE2E = path.join(ROOT, 'projects', 'e2e-app');
    fs.mkdirSync(projE2E, { recursive: true });
    const kcAlice = mkMemKeychain();
    const kcBob = mkMemKeychain();
    const mockE2E = createMockSupabase();
    let e2eErr = null, resAlice = null, resBob = null, bobEntries = null, origRows = null;
    try {
      await new Promise(r => mockE2E.server.listen(17953, '127.0.0.1', r));
      process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17953';
      process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

      // Alice: account, team, linked project.
      process.env.MEMBRIDGE_HOME = homeAlice;
      setTeamCfg();
      await teamsync.signup(util.getConfig(), 'alice-e2e@test.dev', 'pw-a', 'Alice');
      const teamE = await teamsync.createTeam(util.getConfig(), 'E2E');
      const linkE = await teamsync.linkProject(util.getConfig(), projE2E, teamE.team_id, 'E2E');

      // Bob joins and bootstraps his identity FIRST, so Alice's epoch-1 mint
      // seals to both members.
      process.env.MEMBRIDGE_HOME = homeBob;
      setTeamCfg();
      await teamsync.signup(util.getConfig(), 'bob-e2e@test.dev', 'pw-b', 'Bob');
      await teamsync.joinTeam(util.getConfig(), teamE.invite_code);
      await teamsync.syncTeams({ cryptoDeps: { keychain: kcBob, teamcrypto: tcE2E } });

      // Alice: plant a session and push encrypted.
      process.env.MEMBRIDGE_HOME = homeAlice;
      const stA = util.loadState();
      stA.projects[projE2E] = { events: [
        { ts: '2026-07-18T12:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'Ship the E2E slice token=sk-e2e-alice-999', session: 'e2e1' },
        { ts: '2026-07-18T12:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projE2E, 'src', 'core.js'), session: 'e2e1' },
        { ts: '2026-07-18T12:02:00.000Z', source: 'Claude Code', kind: 'summary', text: 'Shipped the slice end to end', session: 'e2e1', decisions: 'sealed-box model kept' },
      ] };
      util.saveState(stA);
      resAlice = await teamsync.syncTeams({ project: projE2E, cryptoDeps: { keychain: kcAlice, teamcrypto: tcE2E } });
      origRows = mockE2E.entries.map(e => ({ ...e }));

      // Tamper every stored plaintext column: a correct pull must recover
      // content from the CIPHERTEXT, so the tampering must never surface.
      for (const e of mockE2E.entries) {
        if (e.ask) e.ask = 'TAMPERED ' + e.ask;
        if (e.summary) e.summary = 'TAMPERED ' + e.summary;
        if (e.decisions) e.decisions = 'TAMPERED';
      }
      // Plus one plaintext-only row (no ciphertext): must pull through as-is.
      const alice = mockE2E.users.get('alice-e2e@test.dev');
      mockE2E.entries.push({
        project_id: linkE.projectId, author_id: alice.id, author_name: 'Alice',
        ts: '2026-07-18T12:30:00.000Z', source: 'Codex', session: 'plain1',
        ask: 'plain only row', goal: null, decisions: null, gotchas: null,
        summary: 'no cipher here', files: ['docs/x.md'], changes: null,
        created_at: new Date(Date.now() + 60000).toISOString(),
      });

      // Bob: pull and decrypt.
      process.env.MEMBRIDGE_HOME = homeBob;
      const stB = util.loadState();
      stB.projects[projE2E] = { events: [] };
      util.saveState(stB);
      resBob = await teamsync.syncTeams({ project: projE2E, cryptoDeps: { keychain: kcBob, teamcrypto: tcE2E } });
      bobEntries = (util.loadState().projects[projE2E] || {}).teamEntries || [];
    } catch (e) { e2eErr = e; } finally {
      process.env.MEMBRIDGE_HOME = savedHome;
      process.env.MEMBRIDGE_TEAM_URL = savedUrl2;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey2;
      mockE2E.server.close();
    }

    check('teamsync: flag-on push dual-writes ciphertext rows and seals the epoch key to every member', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      assert.deepStrictEqual(resAlice.errors, [], `alice sync errors: ${JSON.stringify(resAlice && resAlice.errors)}`);
      assert.ok(origRows.length >= 1, 'expected pushed rows');
      for (const r of origRows) {
        assert.ok(r.ciphertext && r.nonce && r.key_epoch === 1, 'pushed row missing ciphertext/nonce/key_epoch');
        assert.ok(!Buffer.from(r.ciphertext, 'base64').toString('latin1').includes('src/core.js'),
          'file path visible in ciphertext bytes');
      }
      assert.ok(origRows.some(r => r.summary), 'plaintext summary must still be populated (dual-write)');
      assert.strictEqual(mockE2E.pubkeys.size, 2, 'both members must have uploaded pubkeys');
      assert.strictEqual(mockE2E.teamKeys.length, 2, 'epoch key must be sealed once to each member');
    });

    check('teamsync: pull decrypts ciphertext rows — tampered plaintext columns are ignored', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      assert.deepStrictEqual(resBob.errors, [], `bob sync errors: ${JSON.stringify(resBob && resBob.errors)}`);
      const enc = bobEntries.filter(e => e.session === 'e2e1');
      assert.ok(enc.length >= 1, `expected pulled encrypted-session entries, got ${JSON.stringify(bobEntries)}`);
      assert.ok(!JSON.stringify(enc).includes('TAMPERED'),
        'tampered plaintext surfaced — pull must take content from the ciphertext');
    });

    check('teamsync: pull keeps a plaintext-only row unchanged', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      const plain = bobEntries.find(e => e.session === 'plain1');
      assert.ok(plain, 'plaintext-only row missing from pull');
      assert.strictEqual(plain.ask, 'plain only row');
      assert.strictEqual(plain.summary, 'no cipher here');
      assert.deepStrictEqual(plain.files, ['docs/x.md']);
    });

    check('teamsync: round trip — Bob recovers exactly what Alice pushed, through the ciphertext', () => {
      assert.ok(!e2eErr, `e2e scenario threw: ${e2eErr && e2eErr.message}`);
      const orig = origRows.find(r => r.summary);
      const got = bobEntries.find(e => e.session === 'e2e1' && e.summary);
      assert.ok(orig && got, 'summary-bearing row missing on one side');
      assert.strictEqual(got.ask, orig.ask, 'ask must round-trip identically');
      assert.strictEqual(got.summary, orig.summary, 'summary must round-trip identically');
      assert.strictEqual(got.decisions, orig.decisions, 'decisions must round-trip identically');
      assert.deepStrictEqual(got.files, orig.files, 'files must round-trip identically');
      assert.ok(!JSON.stringify(bobEntries).includes('sk-e2e-alice-999'),
        'secret must have been redacted before encryption');
    });

    // Fail-closed pull (E2E completion Task 4): a ciphertext row that cannot
    // be decrypted must render OPAQUE — never its server-controlled plaintext
    // columns (a stripping/corrupting server would otherwise force a silent
    // downgrade). The explicit encrypt:false hatch restores the legacy
    // plaintext read for the same row.
    {
      const mockT = createMockSupabase();
      const homeD = path.join(ROOT, 'home-e2ed');
      const homeE = path.join(ROOT, 'home-e2ee');
      const projT = path.join(ROOT, 'projects', 'tamper-app');
      fs.mkdirSync(projT, { recursive: true });
      const kcDana = mkMemKeychain(), kcEve = mkMemKeychain();
      let tErr = null, eveEntriesClosed = null, eveEntriesHatch = null, resEveClosed = null, feedEve = null;
      let fpEve = null, trustRes = null, pinsAfterTrust = null, danaId = null, danaNewPub = null;
      try {
        await new Promise(r => mockT.server.listen(17955, '127.0.0.1', r));
        process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17955';
        process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

        process.env.MEMBRIDGE_HOME = homeD;
        setTeamCfg();
        await teamsync.signup(util.getConfig(), 'dana-e2e@test.dev', 'pw-d', 'Dana');
        const teamT = await teamsync.createTeam(util.getConfig(), 'TamperTeam');
        await teamsync.linkProject(util.getConfig(), projT, teamT.team_id, 'TamperTeam');

        process.env.MEMBRIDGE_HOME = homeE;
        setTeamCfg();
        await teamsync.signup(util.getConfig(), 'eve-e2e@test.dev', 'pw-v', 'Eve');
        await teamsync.joinTeam(util.getConfig(), teamT.invite_code);
        await teamsync.syncTeams({ cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });

        process.env.MEMBRIDGE_HOME = homeD;
        const stD = util.loadState();
        stD.projects[projT] = { events: [
          { ts: '2026-07-18T14:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'the real content', session: 't1' },
          { ts: '2026-07-18T14:01:00.000Z', source: 'Claude Code', kind: 'summary', text: 'real summary', session: 't1' },
        ] };
        util.saveState(stD);
        await teamsync.syncTeams({ project: projT, cryptoDeps: { keychain: kcDana, teamcrypto: tcE2E } });

        // The hostile server corrupts every ciphertext but leaves poisoned
        // plaintext columns in place.
        for (const e of mockT.entries) {
          if (e.ciphertext) e.ciphertext = Buffer.from('garbage-' + e.ciphertext).toString('base64');
          e.ask = 'POISONED ask';
          e.summary = 'POISONED summary';
        }

        process.env.MEMBRIDGE_HOME = homeE;
        const stE = util.loadState();
        stE.projects[projT] = { events: [] };
        util.saveState(stE);
        resEveClosed = await teamsync.syncTeams({ project: projT, cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });
        eveEntriesClosed = ((util.loadState().projects[projT] || {}).teamEntries || []).map(e => ({ ...e }));

        // Explicit hatch: encrypt:false rereads the same rows the legacy way.
        const rawE = util.loadUserConfig();
        rawE.team = { ...(rawE.team || {}), encrypt: false };
        util.saveUserConfig(rawE);
        const stE2 = util.loadState();
        stE2.projects[projT] = { events: [] }; // fresh pull cursor
        util.saveState(stE2);
        await teamsync.syncTeams({ project: projT });
        eveEntriesHatch = ((util.loadState().projects[projT] || {}).teamEntries || []).map(e => ({ ...e }));

        // Feed rewrite (E2E completion Task 6): the dashboard feed decrypts
        // locally through the same fail-closed path. Dana pushes a fresh
        // (uncorrupted) session, then Eve's feedPayload must decrypt it while
        // rendering the corrupted t1 rows opaque — POISONED never surfaces.
        process.env.MEMBRIDGE_HOME = homeD;
        const stD2 = util.loadState();
        stD2.projects[projT].events.push(
          { ts: '2026-07-18T15:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'fresh content after corruption', session: 't2' });
        util.saveState(stD2);
        await teamsync.syncTeams({ project: projT, cryptoDeps: { keychain: kcDana, teamcrypto: tcE2E } });

        process.env.MEMBRIDGE_HOME = homeE;
        const rawE2 = util.loadUserConfig();
        rawE2.team = { ...(rawE2.team || {}), encrypt: true };
        util.saveUserConfig(rawE2);
        feedEve = await feedPayload({ limit: 50, cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });

        // CLI surface (E2E completion Task 7): fingerprint report from Eve's
        // keychain + pins, then a deliberate trust re-pin after Dana rotates
        // her published key (the only path that ever replaces a pin).
        fpEve = await teamsync.fingerprintReport({ cryptoDeps: { keychain: kcEve, teamcrypto: tcE2E } });
        danaId = mockT.users.get('dana-e2e@test.dev').id;
        danaNewPub = tcE2E.genKeypair().publicKey;
        mockT.pubkeys.set(danaId, danaNewPub);
        trustRes = await teamsync.trustMember(util.getConfig(), 'Dana', { cryptoDeps: { teamcrypto: tcE2E } });
        pinsAfterTrust = require('../lib/teampins').load();
      } catch (e) { tErr = e; } finally {
        process.env.MEMBRIDGE_HOME = savedHome;
        process.env.MEMBRIDGE_TEAM_URL = savedUrl2;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey2;
        mockT.server.close();
      }

      check('teamsync: a ciphertext row that cannot decrypt renders opaque — plaintext columns never surface (fail-closed pull)', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.deepStrictEqual((resEveClosed || {}).errors, [], `eve sync errors: ${JSON.stringify(resEveClosed && resEveClosed.errors)}`);
        assert.ok(eveEntriesClosed.length >= 1, 'expected pulled entries');
        assert.ok(!JSON.stringify(eveEntriesClosed).includes('POISONED'),
          'server-controlled plaintext surfaced from an undecryptable ciphertext row');
        const t1 = eveEntriesClosed.filter(e => e.session === 't1');
        assert.ok(t1.length >= 1 && t1.every(e => e.undecryptable === true), 'row must be marked undecryptable');
        assert.ok(t1.every(e => e.ask == null && e.summary == null), 'content fields must be null on an undecryptable row');
      });

      check('teamsync: the explicit encrypt:false hatch restores the legacy plaintext read for the same rows', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(eveEntriesHatch.some(e => e.summary === 'POISONED summary'),
          'hatch pull must read the plaintext columns exactly as a legacy client would');
      });

      check('feed: feedPayload decrypts team rows locally — good rows readable, corrupted rows opaque, poisoned plaintext never surfaces', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(feedEve && Array.isArray(feedEve.entries), 'feedPayload must return entries');
        assert.ok(!JSON.stringify(feedEve.entries).includes('POISONED'),
          'poisoned plaintext surfaced in the feed');
        assert.ok(feedEve.entries.some(e => e.ask === 'fresh content after corruption'),
          `fresh encrypted row must decrypt in the feed, got: ${JSON.stringify(feedEve.entries.map(e => ({ ask: e.ask, undecryptable: e.undecryptable })))}`);
        assert.ok(feedEve.entries.some(e => e.undecryptable === true),
          'corrupted rows must carry the undecryptable marker through normalizeTeam');
      });

      check('teamsync: fingerprintReport shows my key and every pinned teammate in the human-readable format', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(fpEve && fpEve.ok, `report failed: ${fpEve && fpEve.error}`);
        assert.match(fpEve.mine, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/, 'own fingerprint format');
        const dana = fpEve.members.find(m => m.name === 'Dana');
        assert.ok(dana, `Dana must be pinned, members: ${JSON.stringify(fpEve.members)}`);
        assert.match(dana.fingerprint, /^[0-9a-f]{4}( [0-9a-f]{4}){7}$/, 'teammate fingerprint format');
      });

      check('teamsync: trustMember re-pins a rotated key, reporting old and new fingerprints', () => {
        assert.ok(!tErr, `tamper scenario threw: ${tErr && tErr.message}`);
        assert.ok(trustRes && trustRes.ok, `trust failed: ${trustRes && trustRes.error}`);
        assert.strictEqual(trustRes.userId, danaId, 'display-name lookup must resolve to the user id');
        assert.ok(trustRes.previous && trustRes.current && trustRes.previous !== trustRes.current,
          'old and new fingerprints must both be reported and differ');
        assert.strictEqual(pinsAfterTrust[danaId].publicKey, danaNewPub,
          'the pin must now hold the rotated key');
      });
    }

    // Pre-migration backend (no 009 columns): flag-on push must drop the
    // three new columns and land plaintext (PGRST204 retry), and the pull
    // select must degrade instead of erroring. Fresh mock + home.
    {
      const mockPre = createMockSupabase();
      mockPre.flags.rejectColumns.add('ciphertext');
      mockPre.flags.rejectColumns.add('nonce');
      mockPre.flags.rejectColumns.add('key_epoch');
      const homeCarol = path.join(ROOT, 'home-e2ec');
      const projPre = path.join(ROOT, 'projects', 'pre-app');
      fs.mkdirSync(projPre, { recursive: true });
      let preErr = null, resPre = null;
      try {
        await new Promise(r => mockPre.server.listen(17954, '127.0.0.1', r));
        process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17954';
        process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';
        process.env.MEMBRIDGE_HOME = homeCarol;
        setTeamCfg();
        await teamsync.signup(util.getConfig(), 'carol-e2e@test.dev', 'pw-c', 'Carol');
        const teamP = await teamsync.createTeam(util.getConfig(), 'PreTeam');
        await teamsync.linkProject(util.getConfig(), projPre, teamP.team_id, 'PreTeam');
        const stC = util.loadState();
        stC.projects[projPre] = { events: [
          { ts: '2026-07-18T13:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'premigration push', session: 'pre1' },
        ] };
        util.saveState(stC);
        resPre = await teamsync.syncTeams({ project: projPre, cryptoDeps: { keychain: mkMemKeychain(), teamcrypto: tcE2E } });
      } catch (e) { preErr = e; } finally {
        process.env.MEMBRIDGE_HOME = savedHome;
        process.env.MEMBRIDGE_TEAM_URL = savedUrl2;
        process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey2;
        mockPre.server.close();
      }
      check('teamsync: flag-on against a 009-less backend — push drops ciphertext/nonce/key_epoch and retries, pull select degrades, no errors', () => {
        assert.ok(!preErr, `premigration scenario threw: ${preErr && preErr.message}`);
        assert.deepStrictEqual(resPre.errors, [], `sync errors: ${JSON.stringify(resPre && resPre.errors)}`);
        assert.ok(mockPre.entries.length >= 1, 'expected the push to land after dropping the new columns');
        for (const r of mockPre.entries) {
          assert.ok(!('ciphertext' in r) && !('nonce' in r) && !('key_epoch' in r),
            'new columns must have been dropped for the old backend');
        }
        assert.ok(mockPre.entries.some(e => /premigration push/.test(e.ask || '')), 'plaintext content missing');
        assert.strictEqual(mockPre.teamKeys.length, 1, 'the epoch mint itself must still succeed (team_keys has no flag)');
      });
    }
  }
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

  await check('mock: merge-duplicates overwrites an existing row in place', async () => {
    const m = createMockSupabase();
    await new Promise(r => m.server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + m.server.address().port + '/rest/v1/';
    const uid = 'u1', pid = 'p1', tid = 't1';
    m.teams.set(tid, { id: tid, name: 'T', inviteCode: 'x' });
    m.projects.push({ id: pid, teamId: tid, name: 'proj', repoUrl: null });
    m.members.push({ teamId: tid, userId: uid, displayName: 'U', role: 'owner' });
    const token = 'at-merge-test'; m.sessions.set(token, uid);
    const row = { project_id: pid, author_id: uid, author_name: 'U', ts: '2026-01-01T00:00:00Z', source: 'Claude Code', session: 's1', ask: null };
    const post = (body, prefer) => fetch(base + 'memory_entries?on_conflict=project_id,author_id,ts,source', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, Prefer: prefer }, body: JSON.stringify([body]),
    });
    await post(row, 'resolution=ignore-duplicates,return=minimal');
    await post({ ...row, ask: 'the shared prompt' }, 'resolution=ignore-duplicates,return=minimal'); // ignored (dup)
    assert.strictEqual(m.entries.filter(e => e.session === 's1')[0].ask, null, 'ignore-duplicates wrongly overwrote');
    await post({ ...row, ask: 'the shared prompt' }, 'resolution=merge-duplicates,return=minimal'); // overwrites
    assert.strictEqual(m.entries.filter(e => e.session === 's1')[0].ask, 'the shared prompt', 'merge-duplicates did not overwrite');
    m.server.close();
  });

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

  // --- 13. feed read-model (lib/feed.js) ---
  check('feed.normalizeLocal maps a buildEntries entry to the normalized shape', () => {
    const e = { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'fix the bug',
      summary: 'Fixed the null deref', distilled: true, files: ['a.js', 'b.js'],
      tasks: { done: 1, total: 2, items: [] } };
    const n = feed.normalizeLocal(e, { projectPath: '/Users/x/proj', projectName: 'proj', projectId: 'uuid-1' });
    assert.strictEqual(n.origin, 'local');
    assert.strictEqual(n.self, true);
    assert.strictEqual(n.author, 'You');
    assert.strictEqual(n.summary, 'Fixed the null deref');
    assert.strictEqual(n.ask, 'fix the bug');
    assert.strictEqual(n.distilled, true);
    assert.strictEqual(n.project, 'proj');
    assert.strictEqual(n.projectPath, '/Users/x/proj');
    assert.strictEqual(n.projectId, 'uuid-1');
    assert.deepStrictEqual(n.files, ['a.js', 'b.js']);
    assert.strictEqual(n.cursor, null);
  });
  check('feed.normalizeLocal carries askFull through (unclipped twin, local rows only)', () => {
    const e = { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'fix the authentication chec…',
      askFull: 'fix the authentication checkpoints module', files: [] };
    const n = feed.normalizeLocal(e, { projectPath: '/p', projectName: 'p', projectId: null });
    assert.strictEqual(n.askFull, 'fix the authentication checkpoints module');
    const bare = feed.normalizeLocal({ ts: e.ts, source: e.source, ask: 'short', files: [] },
      { projectPath: '/p', projectName: 'p', projectId: null });
    assert.strictEqual(bare.askFull, null, 'no clipped ask -> askFull stays null');
  });
  check('feed.normalizeLocal picks up meta.authorId when provided', () => {
    const e = { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'x', files: [] };
    const withId = feed.normalizeLocal(e, { projectPath: '/p', projectName: 'p', projectId: null, authorId: 'me' });
    assert.strictEqual(withId.authorId, 'me');
    // Backward compatible: meta without authorId stays null (self identity unchanged).
    const noId = feed.normalizeLocal(e, { projectPath: '/p', projectName: 'p', projectId: null });
    assert.strictEqual(noId.authorId, null);
  });
  check('feed.normalizeLocal treats a missing summary as in-progress (summary=null)', () => {
    const n = feed.normalizeLocal({ ts: '2026-07-14T06:00:00Z', source: 'Codex', ask: 'do a thing', files: [] },
      { projectPath: '/p', projectName: 'p', projectId: null });
    assert.strictEqual(n.summary, null);
    assert.strictEqual(n.distilled, false);
    assert.strictEqual(n.projectId, null);
  });
  check('feed.normalizeTeam maps a team_feed row and detects self by author id', () => {
    const row = { id: 42, project_id: 'uuid-9', project_name: 'shared', author_id: 'me',
      author_name: 'Marco', ts: '2026-07-14T05:00:00Z', source: 'Claude Code',
      ask: 'ship it', summary: 'Shipped', files: ['x.js'], created_at: '2026-07-14T05:00:01Z' };
    const mine = feed.normalizeTeam(row, { selfUserId: 'me' });
    assert.strictEqual(mine.origin, 'team');
    assert.strictEqual(mine.self, true);
    assert.strictEqual(mine.author, 'You');
    assert.strictEqual(mine.summary, 'Shipped');
    assert.strictEqual(mine.projectId, 'uuid-9');
    assert.strictEqual(mine.projectPath, null);
    assert.deepStrictEqual(mine.cursor, { createdAt: '2026-07-14T05:00:01Z', id: 42 });
    const theirs = feed.normalizeTeam(row, { selfUserId: 'someone-else' });
    assert.strictEqual(theirs.self, false);
    assert.strictEqual(theirs.author, 'Marco');
  });
  // Option A — propagate the distilled flag over team sync. A team_feed row that
  // carries distilled:true must normalize to distilled:true (so a teammate's
  // distilled summary is treated as distilled, not lumped in with harvested);
  // a row without the column (pre-migration backend) stays false.
  check('feed.normalizeTeam carries the distilled flag from the row', () => {
    const base = { id: 7, project_id: 'p', project_name: 'p', author_id: 'a', author_name: 'A',
      ts: '2026-07-22T05:00:00Z', source: 'Claude Code', ask: 'q', summary: 'Real distilled brief',
      files: [], created_at: '2026-07-22T05:00:00Z' };
    assert.strictEqual(feed.normalizeTeam({ ...base, distilled: true }, { selfUserId: 'me' }).distilled, true);
    assert.strictEqual(feed.normalizeTeam({ ...base, distilled: false }, { selfUserId: 'me' }).distilled, false);
    assert.strictEqual(feed.normalizeTeam(base, { selfUserId: 'me' }).distilled, false,
      'a pre-migration row without the column must default to not-distilled');
  });
  // Option A — push side: entryToRow must copy the local entry's distilled bit
  // onto the uploaded row so the backend can persist it.
  check('teamsync.entryToRow carries the distilled flag onto the pushed row', () => {
    const creds = { userId: 'u1', displayName: 'Marco' };
    const distilled = teamsync.entryToRow({ ts: 't', source: 'Claude Code', summary: 's', distilled: true, files: [] },
      'proj-1', creds, true, []);
    const harvested = teamsync.entryToRow({ ts: 't', source: 'Claude Code', summary: 's', files: [] },
      'proj-1', creds, true, []);
    assert.strictEqual(distilled.distilled, true, 'distilled bit not sent on the pushed row');
    assert.strictEqual(harvested.distilled, false, 'a harvested entry must push distilled:false');
  });
  check('feed.normalizeTeam tolerates a summary-less row (pre-migration backend)', () => {
    const n = feed.normalizeTeam({ id: 1, project_id: 'p', project_name: 'p', author_id: 'a',
      author_name: 'A', ts: '2026-07-14T05:00:00Z', source: 'Codex', ask: 'q', files: [],
      created_at: '2026-07-14T05:00:00Z' }, { selfUserId: 'me' });
    assert.strictEqual(n.summary, null);
  });
  check('headline: feed normalizeLocal and normalizeTeam carry headline', () => {
    const local = feed.normalizeLocal(
      { session: 's', headline: 'H', did: 'D', summary: 'D', ts: '2026-07-20T00:00:00Z', files: [] },
      { projectPath: '/p', projectName: 'p', projectId: null });
    assert.strictEqual(local.headline, 'H', 'headline not carried by normalizeLocal');
    const team = feed.normalizeTeam(
      { id: 1, project_id: 'p', project_name: 'p', author_id: 'a', author_name: 'A',
        ts: '2026-07-20T00:00:00Z', source: 'Distilled', ask: 'q', headline: 'H', files: [],
        created_at: '2026-07-20T00:00:00Z' }, { selfUserId: 'me' });
    assert.strictEqual(team.headline, 'H', 'headline not carried by normalizeTeam');
  });
  check('feed: local self entries carry a shared flag', () => {
    const meta = { projectName: 'p', projectPath: '/p', authorId: 'u1' };
    const on = feed.normalizeLocal({ ts: '2026-01-01T00:00:00Z', session: 's1', ask: 'hi', shared: true }, meta);
    const off = feed.normalizeLocal({ ts: '2026-01-01T00:00:00Z', session: 's2', ask: 'hi', shared: false }, meta);
    assert.strictEqual(on.shared, true);
    assert.strictEqual(off.shared, false);
  });
  check('feed: local entry carries goal + changes', () => {
    const proj = { events: [
      { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'mcp thing' },
      { ts: '2026-07-16T00:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 's1', file: path.join(proj1, 'src', 'login.js') },
      { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
        text: 'Did the thing.', goal: 'Ship MCP', decisions: 'read-only', gotchas: '', highlights: [] },
    ] };
    const entries = memorydb.buildEntries(proj1, proj, {});
    const withSummary = entries.find(e => e.summary);
    assert.strictEqual(withSummary.goal, 'Ship MCP');
    assert.strictEqual(withSummary.decisions, 'read-only');
    assert.ok(Array.isArray(withSummary.changes), 'changes array attached');
    const norm = require('../lib/feed').normalizeLocal(withSummary, { projectName: 'p' });
    assert.strictEqual(norm.goal, 'Ship MCP');
    assert.ok(Array.isArray(norm.changes));
  });
  check('headline: buildEntries carries a distilled summary headline onto the entry and out through feed', () => {
    const proj = { events: [
      { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'ask' },
      { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
        text: 'Did a long thing that would otherwise be first-sentenced and truncated.',
        headline: 'Short glance line', goal: 'g', decisions: '', gotchas: '', highlights: [] },
    ] };
    const entries = memorydb.buildEntries(proj1, proj, {});
    const withSummary = entries.find(e => e.summary);
    assert.strictEqual(withSummary.headline, 'Short glance line', 'headline not carried onto the entry');
    const norm = require('../lib/feed').normalizeLocal(withSummary, { projectName: 'p' });
    assert.strictEqual(norm.headline, 'Short glance line', 'headline lost through normalizeLocal — card would fall back to first-sentence');
  });
  check('headline: buildEntries takes rep.headline from the latest checkpoint (multi-checkpoint session)', () => {
    const proj = { events: [
      { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'ask' },
      { ts: '2026-07-16T00:01:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
        text: 'First checkpoint.', headline: 'early headline', goal: 'g', decisions: '', gotchas: '', highlights: [] },
      { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
        text: 'Second checkpoint supersedes the first.', headline: 'latest headline', goal: 'g', decisions: '', gotchas: '', highlights: [] },
    ] };
    const entries = memorydb.buildEntries(proj1, proj, {});
    const withHeadline = entries.filter(e => e.headline);
    assert.strictEqual(withHeadline.length, 1, 'exactly one entry (the rep) should carry the headline');
    assert.strictEqual(withHeadline[0].headline, 'latest headline', 'rep.headline must be the latest checkpoint, not an earlier one');
  });
  check('feed: standalone Codex summary becomes a visible local entry labeled Codex', () => {
    const proj = { events: [
      { ts: '2026-07-22T01:58:13.000Z', source: 'Distilled', kind: 'summary', session: 'codex-standalone',
        text: 'Removed the persistent Activity back control.', goal: 'Remove the always-visible back button',
        decisions: 'Kept day-detail breadcrumbs.', gotchas: '', highlights: [] },
    ] };
    const entries = memorydb.buildEntries(proj1, proj, {});
    assert.strictEqual(entries.length, 1, `entries were ${JSON.stringify(entries)}`);
    assert.strictEqual(entries[0].source, 'Codex');
    assert.strictEqual(entries[0].ask, '(not captured)');
    assert.strictEqual(entries[0].summary, 'Removed the persistent Activity back control.');
    assert.strictEqual(entries[0].goal, 'Remove the always-visible back button');
    assert.strictEqual(entries[0].decisions, 'Kept day-detail breadcrumbs.');
    assert.strictEqual(entries[0].distilled, true);
    const norm = require('../lib/feed').normalizeLocal(entries[0], { projectName: 'Membridge', projectPath: proj1 });
    assert.strictEqual(norm.source, 'Codex');
    assert.strictEqual(norm.summary, 'Removed the persistent Activity back control.');
    assert.strictEqual(norm.session, 'codex-standalone');
  });
  check('feed: highlight note is redacted on the local path', () => {
    const proj = { events: [
      { ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's1', text: 'x' },
      { ts: '2026-07-16T00:01:00.000Z', source: 'Claude Code', kind: 'edit', session: 's1', file: path.join(proj1, 'src', 'login.js') },
      { ts: '2026-07-16T00:02:00.000Z', source: 'Distilled', kind: 'summary', session: 's1',
        text: 'did', highlights: [{ file: 'src/login.js', note: 'uses SECRET123 token' }] },
    ] };
    const entries = memorydb.buildEntries(proj1, proj, { redact: ['SECRET123'] });
    const e = entries.find(x => Array.isArray(x.changes) && x.changes.length);
    assert.ok(e, 'entry with changes exists');
    const noted = e.changes.find(c => c.note);
    assert.ok(noted, 'a change carries the highlight note');
    assert.ok(!/SECRET123/.test(noted.note), 'secret is redacted from the note');
  });
  // BUG 2 (fix/share-live-and-clamp): digest.clip cuts at a raw character
  // count, so a >300-char ask is stored ending mid-word ("…chec…"). The
  // day-detail view needs the full text — keep an unclipped, still-redacted
  // twin (askFull), exactly like summaryFull, and never let it cross the
  // team boundary.
  check('buildEntries: a clipped ask keeps its full text in askFull (local-only twin of summaryFull)', () => {
    const longAsk = ('please refactor the authentication checkpoints module carefully ').repeat(6).trim();
    const proj = { events: [
      { ts: '2026-07-16T01:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's-long', text: longAsk },
      { ts: '2026-07-16T01:01:00.000Z', source: 'Claude Code', kind: 'prompt', session: 's-short', text: 'short ask' },
    ] };
    const entries = memorydb.buildEntries(proj1, proj, {});
    const long = entries.find(x => x.session === 's-long');
    assert.ok(long.ask.length <= 300 && long.ask.endsWith('…'), 'precondition: the stored ask is clipped');
    assert.strictEqual(long.askFull, longAsk, 'askFull must carry the complete redacted text');
    const short = entries.find(x => x.session === 's-short');
    assert.ok(!('askFull' in short), 'an unclipped ask needs no askFull twin');
  });
  check('teamsync source never touches askFull — the unclipped ask stays on this machine', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'teamsync.js'), 'utf8');
    assert.ok(!/askFull/.test(src), 'teamsync must not push, pull, or reshare askFull');
  });
  // Task 9 perf fix: deriveChanges (which spawns git subprocesses) must only
  // run for entries that survive the maxEntries slice — never for distilled
  // entries discarded by it. Build more distilled entries than maxEntries
  // allows, then confirm the surviving one still gets a correct change model
  // and no returned entry leaks the temporary _highlights stash field.
  check('buildEntries: change model is derived only for entries surviving the maxEntries slice', () => {
    const mkEvents = (n, session, file, note) => ([
      { ts: `2026-07-16T00:${String(n).padStart(2, '0')}:00.000Z`, source: 'Claude Code', kind: 'prompt', session, text: `ask ${n}` },
      { ts: `2026-07-16T00:${String(n).padStart(2, '0')}:01.000Z`, source: 'Claude Code', kind: 'edit', session, file: path.join(proj1, 'src', file) },
      { ts: `2026-07-16T00:${String(n).padStart(2, '0')}:02.000Z`, source: 'Distilled', kind: 'summary', session,
        text: `did ${n}`, highlights: [{ file: `src/${file}`, note }] },
    ]);
    const events = [
      ...mkEvents(1, 'sA', 'discarded1.js', 'discarded change one'),
      ...mkEvents(2, 'sB', 'discarded2.js', 'discarded change two'),
      ...mkEvents(3, 'sC', 'login.js', 'surviving change'),
    ];
    const proj = { events };
    // Force slicing: maxEntries smaller than the 3 distilled entries above.
    const entries = memorydb.buildEntries(proj1, proj, { maxEntries: 2 });
    assert.strictEqual(entries.length, 2, `expected slice to cap at 2, got ${entries.length}`);
    assert.ok(!entries.some(e => 'discarded1.js' === (e.files || [])[0]), 'the oldest, sliced-away entry survived the slice');
    const survivor = entries.find(e => (e.files || []).includes('src/login.js'));
    assert.ok(survivor, 'surviving distilled entry missing its change model');
    assert.ok(survivor.changes.some(c => c.file === 'src/login.js'), 'surviving change model missing the edited file');
    assert.ok(survivor.changes.some(c => c.note && c.note.includes('surviving change')), 'surviving change model missing the highlight note');
    assert.ok(entries.every(e => !('_highlights' in e)), 'temporary _highlights field leaked into a returned entry');
  });
  check('feed: normalizeTeam carries goal + change-model from changes, redacted', () => {
    const redact = t => t.replace(/SECRET123/g, '[redacted]');
    const row = {
      author_name: 'Andrew', ts: '2026-07-16T00:00:00.000Z', source: 'Claude Code',
      goal: 'Ship SECRET123 feature', summary: 'did it',
      files: ['lib/mcp.js'],
      changes: [{ file: 'lib/mcp.js', status: 'new', add: 10, del: 0, note: 'uses SECRET123', dep: false }],
    };
    const out = require('../lib/feed').normalizeTeam(row, { redact });
    assert.ok(!/SECRET123/.test(out.goal), 'goal redacted');
    assert.deepStrictEqual(out.files, ['lib/mcp.js'], 'files stays string[]');
    assert.strictEqual(out.changes.length, 1, 'change-model read from the changes column');
    assert.strictEqual(out.changes[0].file, 'lib/mcp.js');
    assert.ok(!/SECRET123/.test(out.changes[0].note), 'note redacted');
  });
  check('feed: normalizeTeam legacy string files yields no change-model', () => {
    const out = require('../lib/feed').normalizeTeam(
      { author_name: 'A', ts: '2026-07-16T00:00:00.000Z', source: 'x', files: ['lib/a.js', 'lib/b.js'] }, {});
    assert.deepStrictEqual(out.changes, []);
    assert.deepStrictEqual(out.files, ['lib/a.js', 'lib/b.js']);
  });
  check('renderBlock: pulled teammate changes render, no [object Object]', () => {
    // relative ts: teamInjectSlice drops entries older than teamMaxAgeHours
    // (72h), so a hardcoded date turns into a time bomb.
    const proj = { events: [], teamEntries: [
      { author: 'Andrew', ts: new Date(Date.now() - 3600000).toISOString(), source: 'Claude Code',
        goal: 'Ship MCP', summary: 'Built the server.',
        files: ['lib/mcp.js'],
        changes: [{ file: 'lib/mcp.js', status: 'new', add: 10, del: 0, note: null, dep: false }] },
    ] };
    const block = digest.renderBlock('/repo', proj, { team: {} }, 'CLAUDE.md');
    assert.ok(/Changes:.*lib\/mcp\.js/.test(block), 'renders the change file');
    assert.ok(!/\[object Object\]/.test(block), 'no stringified objects');
  });
  check('feed.buildFeed merges newest-first and drops the team dup of local self work', () => {
    const local = [feed.normalizeLocal(
      { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'same ask', summary: 'local rich', files: [] },
      { projectPath: '/p', projectName: 'p', projectId: 'uuid-1' })];
    const team = [
      feed.normalizeTeam({ id: 5, project_id: 'uuid-1', project_name: 'p', author_id: 'me', author_name: 'Marco',
        ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'same ask', summary: 'team copy',
        files: [], created_at: '2026-07-14T06:00:02Z' }, { selfUserId: 'me' }),
      feed.normalizeTeam({ id: 6, project_id: 'uuid-2', project_name: 'other', author_id: 'you', author_name: 'Andrew',
        ts: '2026-07-14T07:00:00Z', source: 'Codex', ask: 'their ask', summary: 'their work',
        files: [], created_at: '2026-07-14T07:00:01Z' }, { selfUserId: 'me' }),
    ];
    const res = feed.buildFeed({ local, team, teamUnavailable: false, limit: 50 });
    assert.strictEqual(res.entries.length, 2, 'the duplicated self team row is dropped');
    assert.strictEqual(res.entries[0].ask, 'their ask', 'newest first');
    assert.strictEqual(res.entries[1].summary, 'local rich', 'local copy kept over team dup');
    assert.strictEqual(res.teamUnavailable, false);
  });
  check('feed.buildFeed honors limit and returns a nextBefore cursor', () => {
    const team = [1, 2, 3].map(i => feed.normalizeTeam(
      { id: i, project_id: 'p', project_name: 'p', author_id: 'x', author_name: 'X',
        ts: '2026-07-14T0' + i + ':00:00Z', source: 'Codex', ask: 'a' + i, summary: 's' + i,
        files: [], created_at: '2026-07-14T0' + i + ':00:00Z' }, { selfUserId: 'me' }));
    const res = feed.buildFeed({ local: [], team, teamUnavailable: false, limit: 2 });
    assert.strictEqual(res.entries.length, 2);
    assert.strictEqual(res.entries[0].ask, 'a3');
    assert.strictEqual(res.nextBefore, res.entries[1].ts, 'cursor is the ts of the last returned entry');
  });
  check('feed.buildFeed passes through the teamUnavailable degradation flag', () => {
    const res = feed.buildFeed({ local: [], team: [], teamUnavailable: true, limit: 50 });
    assert.strictEqual(res.teamUnavailable, true);
    assert.deepStrictEqual(res.entries, []);
    assert.strictEqual(res.nextBefore, null);
  });
  check('feed.buildFeed does not mutate its input arrays or their entries', () => {
    const local = [feed.normalizeLocal(
      { ts: '2026-07-14T06:00:00Z', source: 'Claude Code', ask: 'local ask', summary: 'l', files: ['a.js', 'b.js'] },
      { projectPath: '/p', projectName: 'p', projectId: 'uuid-1' })];
    const team = [feed.normalizeTeam(
      { id: 9, project_id: 'uuid-2', project_name: 'other', author_id: 'you', author_name: 'Andrew',
        ts: '2026-07-14T07:00:00Z', source: 'Codex', ask: 'team ask', summary: 't',
        files: ['x.js', 'y.js'], created_at: '2026-07-14T07:00:01Z' }, { selfUserId: 'me' })];
    const localCopy = local.slice();
    const teamCopy = team.slice();
    const localFilesCopy = local[0].files.slice();
    const teamFilesCopy = team[0].files.slice();
    feed.buildFeed({ local, team, teamUnavailable: false, limit: 50 });
    assert.deepStrictEqual(local, localCopy, 'local array was mutated');
    assert.deepStrictEqual(team, teamCopy, 'team array was mutated');
    assert.deepStrictEqual(local[0].files, localFilesCopy, 'a local entry files array was reordered/emptied');
    assert.deepStrictEqual(team[0].files, teamFilesCopy, 'a team entry files array was reordered/emptied');
  });
  check('feed.buildFeed returns nextBefore=null when merged length equals limit exactly', () => {
    const team = [1, 2].map(i => feed.normalizeTeam(
      { id: i, project_id: 'p', project_name: 'p', author_id: 'x', author_name: 'X',
        ts: '2026-07-14T0' + i + ':00:00Z', source: 'Codex', ask: 'a' + i, summary: 's' + i,
        files: [], created_at: '2026-07-14T0' + i + ':00:00Z' }, { selfUserId: 'me' }));
    const res = feed.buildFeed({ local: [], team, teamUnavailable: false, limit: 2 });
    assert.strictEqual(res.entries.length, 2);
    assert.strictEqual(res.nextBefore, null, 'no cursor when exactly limit entries remain');
  });
  // Rolling-window floor: windowStart (ISO) marks the oldest ts page one must
  // still include — the Activity view's "always show the last 24 hours".
  check('feed.buildFeed windowStart extends page one past limit to cover the window', () => {
    const team = [1, 2, 3, 4, 5].map(i => feed.normalizeTeam(
      { id: i, project_id: 'p', project_name: 'p', author_id: 'x', author_name: 'X',
        ts: '2026-07-14T0' + i + ':00:00Z', source: 'Codex', ask: 'a' + i, summary: 's' + i,
        files: [], created_at: '2026-07-14T0' + i + ':00:00Z' }, { selfUserId: 'me' }));
    const res = feed.buildFeed({ local: [], team, teamUnavailable: false, limit: 2, windowStart: '2026-07-14T02:00:00Z' });
    assert.strictEqual(res.entries.length, 4, 'page one must cover every entry inside the window');
    assert.strictEqual(res.entries[0].ask, 'a5', 'newest first');
    assert.strictEqual(res.entries[3].ask, 'a2', 'the windowStart boundary entry is inclusive');
    assert.strictEqual(res.nextBefore, res.entries[3].ts, 'cursor points at the page tail for View more');
  });
  check('feed.buildFeed windowStart keeps the limit floor when the window is sparse', () => {
    const team = [
      { id: 9, ts: '2026-07-14T10:00:00Z' }, // inside the window
      { id: 3, ts: '2026-07-12T03:00:00Z' },
      { id: 2, ts: '2026-07-12T02:00:00Z' },
      { id: 1, ts: '2026-07-12T01:00:00Z' },
    ].map(r => feed.normalizeTeam(
      { id: r.id, project_id: 'p', project_name: 'p', author_id: 'x', author_name: 'X',
        ts: r.ts, source: 'Codex', ask: 'a' + r.id, summary: 's' + r.id,
        files: [], created_at: r.ts }, { selfUserId: 'me' }));
    const res = feed.buildFeed({ local: [], team, teamUnavailable: false, limit: 3, windowStart: '2026-07-14T00:00:00Z' });
    assert.strictEqual(res.entries.length, 3, 'a sparse window still fills the page to the limit');
    assert.strictEqual(res.entries[0].ask, 'a9');
    assert.strictEqual(res.nextBefore, res.entries[2].ts, 'filler tail still yields a View more cursor');
  });
  check('feed.buildFeed windowStart covering everything returns all entries and no cursor', () => {
    const team = [1, 2, 3].map(i => feed.normalizeTeam(
      { id: i, project_id: 'p', project_name: 'p', author_id: 'x', author_name: 'X',
        ts: '2026-07-14T0' + i + ':00:00Z', source: 'Codex', ask: 'a' + i, summary: 's' + i,
        files: [], created_at: '2026-07-14T0' + i + ':00:00Z' }, { selfUserId: 'me' }));
    const res = feed.buildFeed({ local: [], team, teamUnavailable: false, limit: 2, windowStart: '2026-07-14T00:00:00Z' });
    assert.strictEqual(res.entries.length, 3, 'the whole stream is inside the window');
    assert.strictEqual(res.nextBefore, null, 'nothing older remains, so no cursor');
  });

  // --- 14. MCP server (lib/mcp.js): read-only, no side effects ---
  {
    const mcpTsAgo = sec => new Date(Date.now() - sec * 1000).toISOString();
    const projMcp = path.join(ROOT, 'projects', 'mcp-app');
    fs.mkdirSync(path.join(projMcp, '.membridge'), { recursive: true }); // tracked, so the gate ingests it
    const mcpTxDir = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-mcp-app');
    fs.mkdirSync(mcpTxDir, { recursive: true });
    fs.writeFileSync(path.join(mcpTxDir, 'sessM.jsonl'), jsonl([
      { type: 'user', message: { role: 'user', content: 'Rotate the webhook secret api_key=sk-test1234567890abcdef' }, cwd: projMcp, timestamp: mcpTsAgo(120) },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Rotated the webhook secret end to end and confirmed the deploy is green across every environment.' }] }, cwd: projMcp, timestamp: mcpTsAgo(60) },
    ]));
    syncOnce();

    // A paused project must never surface through any MCP tool.
    const projPaused = path.join(ROOT, 'projects', 'mcp-paused-app');
    fs.mkdirSync(projPaused, { recursive: true });
    fs.writeFileSync(path.join(projPaused, '.membridge-off'), '');

    // A planted teammate entry with its own secret: proj.teamEntries is never
    // pre-redacted at rest (only the push side scrubs before upload), so this
    // specifically exercises the MCP layer's own redaction pass rather than
    // something buildEntries/pull already guaranteed.
    {
      const state = util.loadState();
      const mcpKey = Object.keys(state.projects).find(k => path.resolve(k) === path.resolve(projMcp));
      state.projects[mcpKey].teamEntries = [{
        author: 'Priya', ts: mcpTsAgo(30), source: 'Codex', session: 'p1',
        ask: 'rotate creds token=sk-tamper-mcp-999',
        summary: 'stored the new token api_key=sk-tamper-mcp-888 in the vault',
        files: ['infra/vault.tf'],
        changes: [{ file: 'infra/vault.tf', status: 'edited', add: 3, del: 1, note: 'rotated token=sk-tamper-mcp-777', dep: false }],
      }];
      state.projects[projPaused] = { events: [{ ts: mcpTsAgo(10), source: 'Claude Code', kind: 'prompt', text: 'paused project work', session: 'x1' }] };
      util.saveState(state);
    }

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpMod.createServer();
    const client = new McpClient({ name: 'mcp-test-client', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const callJson = async (name, args) => {
      const res = await client.callTool({ name, arguments: args || {} });
      return { res, data: JSON.parse(res.content[0].text) };
    };

    const toolsList = await client.listTools();
    check('mcp: exposes exactly the five read-only tools, all marked readOnlyHint', () => {
      const names = toolsList.tools.map(t => t.name).sort();
      assert.deepStrictEqual(names, ['get_project_memory', 'get_recent_activity', 'list_projects', 'search_memory', 'why']);
      assert.ok(toolsList.tools.every(t => t.annotations && t.annotations.readOnlyHint === true), 'a tool is missing readOnlyHint');
      assert.ok(toolsList.tools.every(t => t.annotations.destructiveHint === false), 'a tool is missing destructiveHint:false');
    });

    const { data: lp } = await callJson('list_projects', {});
    check('mcp: list_projects returns tracked projects with basic metadata, excludes paused', () => {
      assert.ok(Array.isArray(lp.projects), 'projects is not an array');
      const mine = lp.projects.find(p => path.resolve(p.path) === path.resolve(projMcp));
      assert.ok(mine, 'mcp-app project missing');
      assert.strictEqual(mine.name, 'mcp-app');
      assert.ok(mine.lastActivity, 'lastActivity missing');
      assert.ok(mine.tools.includes('Claude Code'), 'tools list missing Claude Code');
      assert.ok(!lp.projects.some(p => path.resolve(p.path) === path.resolve(projPaused)), 'paused project leaked into list_projects');
    });

    const { data: gpm } = await callJson('get_project_memory', { project: projMcp });
    check('mcp: get_project_memory mirrors the CLAUDE.md sections and redacts local + teammate secrets', () => {
      assert.strictEqual(gpm.project, path.resolve(projMcp));
      assert.ok(Array.isArray(gpm.recentAsks) && gpm.recentAsks.length >= 1, 'recentAsks missing');
      assert.ok(Array.isArray(gpm.teammates) && gpm.teammates.length === 1, 'teammates missing');
      assert.strictEqual(gpm.teammates[0].author, 'Priya');
      const blob = JSON.stringify(gpm);
      assert.ok(!blob.includes('sk-test1234567890abcdef'), 'local secret leaked');
      assert.ok(!blob.includes('sk-tamper-mcp-999') && !blob.includes('sk-tamper-mcp-888') && !blob.includes('sk-tamper-mcp-777'),
        'teammate secret leaked');
      assert.ok(count(blob, '[redacted') >= 2, 'expected redaction markers for both the local and teammate secret');
      // the teammate change model is surfaced (with its note re-redacted)
      assert.ok(Array.isArray(gpm.teammates[0].changes) && gpm.teammates[0].changes.some(c => c.file === 'infra/vault.tf'),
        'teammate change model not surfaced');
    });

    const { res: unknownRes, data: unknownData } = await callJson('get_project_memory', { project: path.join(ROOT, 'projects', 'does-not-exist') });
    check('mcp: get_project_memory handles an unknown project gracefully (no throw, isError)', () => {
      assert.strictEqual(unknownRes.isError, true);
      assert.ok(/unknown project/.test(unknownData.error), `error said: ${unknownData.error}`);
    });

    const { data: pausedData } = await callJson('get_project_memory', { project: projPaused });
    check('mcp: get_project_memory refuses a paused project', () => {
      assert.ok(/paused|excluded/.test(pausedData.error), `error said: ${pausedData.error}`);
    });

    const { data: recent } = await callJson('get_recent_activity', { limit: 20 });
    check('mcp: get_recent_activity merges local + teammate entries newest-first and redacts secrets', () => {
      assert.ok(Array.isArray(recent.entries) && recent.entries.length >= 2, 'entries missing');
      const tsList = recent.entries.map(e => e.ts);
      assert.deepStrictEqual(tsList, [...tsList].sort().reverse(), 'entries not sorted newest-first');
      const priya = recent.entries.find(e => e.author === 'Priya');
      assert.ok(priya, 'teammate entry missing');
      assert.ok(Array.isArray(priya.changes) && priya.changes.some(c => c.file === 'infra/vault.tf'),
        'teammate change model missing from get_recent_activity');
      const blob = JSON.stringify(recent);
      assert.ok(!blob.includes('sk-test1234567890abcdef') && !blob.includes('sk-tamper-mcp-999') && !blob.includes('sk-tamper-mcp-777'),
        'secret leaked into recent activity');
    });

    const { data: search } = await callJson('search_memory', { query: 'webhook' });
    check('mcp: search_memory finds a keyword match across ask/summary and redacts it', () => {
      assert.ok(search.results.length >= 1, 'expected at least one match');
      assert.ok(search.results.some(r => /webhook/i.test(r.ask || '') || /webhook/i.test(r.summary || '')), 'expected match missing');
      assert.ok(!JSON.stringify(search).includes('sk-test1234567890abcdef'), 'secret leaked into search results');
    });

    const { data: searchNone } = await callJson('search_memory', { query: 'zzz-no-such-keyword-zzz' });
    check('mcp: search_memory returns no results for a non-matching query', () => {
      assert.deepStrictEqual(searchNone.results, []);
    });

    await client.close();
  }

  // Smoke test: the real CLI command over real stdio, spawned as a
  // subprocess — proves `membridge mcp`'s wiring (bin/membridge.js ->
  // lib/mcp.js) actually starts a working server, not just that lib/mcp.js's
  // exports work when called in-process.
  {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      env: process.env,
    });
    const client = new McpClient({ name: 'mcp-smoke-client', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    check('mcp: `membridge mcp` starts a real stdio server and lists its tools', () => {
      assert.strictEqual(tools.tools.length, 5);
      assert.ok(tools.tools.some(t => t.name === 'list_projects'));
      assert.ok(tools.tools.some(t => t.name === 'why'));
    });
    await client.close();
  }

  // Missing-dependency path: MODULE_NOT_FOUND must produce one clear,
  // actionable line on stderr and a non-zero exit — never a raw stack trace.
  // Spawned as a subprocess because loadSdkDeps() calls process.exit(1) on
  // this path, which must not kill the real test runner. The injectable
  // requireFn simulates the SDK/zod genuinely being absent without actually
  // uninstalling them from this test environment (they're needed by every
  // other mcp test above).
  {
    const mcpPath = path.join(__dirname, '..', 'lib', 'mcp.js');
    const script = `
      const { loadSdkDeps } = require(${JSON.stringify(mcpPath)});
      const fakeRequire = () => {
        const err = new Error("Cannot find module '@modelcontextprotocol/sdk/server/mcp.js'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      };
      loadSdkDeps(fakeRequire);
      console.log('UNREACHABLE');
    `;
    const out = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    check('mcp: a missing @modelcontextprotocol/sdk or zod produces exactly the friendly message on stderr and a non-zero exit', () => {
      assert.notStrictEqual(out.status, 0, `expected non-zero exit, got ${out.status}`);
      assert.strictEqual(out.stderr.trim(), mcpMod.MISSING_DEPS_MESSAGE.trim(), `stderr was: ${out.stderr}`);
      assert.ok(out.stderr.includes('npm install @modelcontextprotocol/sdk zod'), 'missing the actionable install command');
      assert.ok(!out.stdout.includes('UNREACHABLE'), 'execution continued past process.exit');
    });
  }

  // --- 15. Provenance (lib/provenance.js): `membridge why <file>` ---
  // File-level only: which sessions edited a file, newest first. Event
  // fixtures are passed as plain proj objects (same planting style as the
  // teamEntries block above) — provenance is a pure reduction, so no scan
  // pass is needed and a fixed `now` keeps the live flag deterministic.
  {
    const projWhy = path.join(ROOT, 'projects', 'why-app');
    fs.mkdirSync(path.join(projWhy, 'src'), { recursive: true });
    const whyNow = Date.parse('2026-07-18T12:00:00Z');
    const whyEvents = [
      { ts: '2026-07-18T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'Refactor auth token=sk-why-secret-111 flow', session: 'w1' },
      { ts: '2026-07-18T09:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projWhy, 'src', 'auth.js'), session: 'w1' },
      { ts: '2026-07-18T09:02:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projWhy, 'src', 'other.js'), session: 'w1' },
      { ts: '2026-07-18T09:03:00.000Z', source: 'Claude Code', kind: 'summary', text: 'Rewrote auth around token=sk-why-secret-222 rotation', session: 'w1', decisions: 'kept the sync API', gotchas: 'mind the token cache' },
      { ts: '2026-07-18T10:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'Docs pass', session: 'w3' },
      { ts: '2026-07-18T10:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projWhy, 'README.md'), session: 'w3' },
      { ts: '2026-07-18T11:50:00.000Z', source: 'Codex', kind: 'prompt', text: 'Tighten auth error handling', session: 'w2' },
      { ts: '2026-07-18T11:52:00.000Z', source: 'Codex', kind: 'edit', file: path.join(projWhy, 'src', 'auth.js'), session: 'w2' },
    ];
    const whyTeam = [
      { author: 'Priya', ts: '2026-07-18T11:58:00.000Z', source: 'Codex', session: 'tp1', ask: 'harden auth token=sk-why-team-333', summary: 'refreshed session handling', files: ['src/auth.js'] },
      { author: 'Priya', ts: '2026-07-17T08:00:00.000Z', source: 'Codex', session: 'tp2', ask: null, summary: 'unrelated docs work', files: ['docs/notes.md'] },
    ];
    const cfgWhy = util.getConfig();

    let prov = null;
    check('provenance: a multi-session file returns one row per session, newest first, with session fields', () => {
      prov = require('../lib/provenance');
      const rows = prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/auth.js', whyNow);
      assert.strictEqual(rows.length, 2, `expected 2 rows, got ${rows.length}`);
      assert.strictEqual(rows[0].session, 'w2');
      assert.strictEqual(rows[0].tool, 'Codex');
      assert.strictEqual(rows[0].who, 'You');
      assert.ok(/Tighten auth/.test(rows[0].ask), `w2 ask was: ${rows[0].ask}`);
      assert.strictEqual(rows[0].summary, null, 'w2 has no summary');
      assert.strictEqual(rows[1].session, 'w1');
      assert.ok(/Rewrote auth/.test(rows[1].summary), `w1 summary was: ${rows[1].summary}`);
      assert.ok(/kept the sync API/.test(rows[1].decisions), `w1 decisions was: ${rows[1].decisions}`);
      assert.ok(/mind the token cache/.test(rows[1].gotchas), `w1 gotchas was: ${rows[1].gotchas}`);
      assert.ok(String(rows[0].ts) > String(rows[1].ts), 'rows are not newest-first');
    });

    check('provenance: live is a time claim — only sessions active inside the stale window', () => {
      assert.ok(prov, 'lib/provenance.js missing');
      const rows = prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/auth.js', whyNow);
      assert.strictEqual(rows[0].live, true, 'w2 (10 min old) should be live');
      assert.strictEqual(rows[1].live, false, 'w1 (3 h old) should not be live');
    });

    check('provenance: redacts secrets in ask and summary through the standard pipeline', () => {
      assert.ok(prov, 'lib/provenance.js missing');
      const rows = prov.fileProvenance(projWhy, { events: whyEvents, teamEntries: whyTeam }, cfgWhy, 'src/auth.js', whyNow);
      const blob = JSON.stringify(rows);
      assert.ok(!blob.includes('sk-why-secret-111') && !blob.includes('sk-why-secret-222') && !blob.includes('sk-why-team-333'),
        'secret leaked into provenance');
      assert.ok(count(blob, '[redacted') >= 3, 'expected redaction markers in local ask, local summary and teammate ask');
    });

    check('provenance: unknown or out-of-project file returns empty', () => {
      assert.ok(prov, 'lib/provenance.js missing');
      assert.deepStrictEqual(prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/nope.js', whyNow), []);
      assert.deepStrictEqual(prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, '../outside.js', whyNow), []);
    });

    check('provenance: teammate sessions carrying the file appear with who=author, without team-slice trimming', () => {
      assert.ok(prov, 'lib/provenance.js missing');
      const rows = prov.fileProvenance(projWhy, { events: whyEvents, teamEntries: whyTeam }, cfgWhy, 'src/auth.js', whyNow);
      assert.strictEqual(rows.length, 3, `expected 3 rows, got ${rows.length}`);
      assert.strictEqual(rows[0].who, 'Priya');
      assert.strictEqual(rows[0].session, 'tp1');
      assert.ok(!rows.some(r => r.session === 'tp2'), 'a teammate row for a different file leaked in');
    });

    check('provenance: ./-prefixed and absolute in-project paths normalize to the same file', () => {
      assert.ok(prov, 'lib/provenance.js missing');
      const base = prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/auth.js', whyNow);
      const dot = prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, './src/auth.js', whyNow);
      const abs = prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, path.join(projWhy, 'src', 'auth.js'), whyNow);
      assert.deepStrictEqual(dot, base);
      assert.deepStrictEqual(abs, base);
    });

    // --- Phase 3 Task 2: blameLine (line → SHA) ---------------------------
    const mkBlameGit = handler => {
      const calls = [];
      return { calls, deps: { runGit: args => { calls.push(args); return handler(args); } } };
    };
    check('provenance: blameLine extracts the 40-hex SHA from --porcelain blame', () => {
      const commitsMod = require('../lib/commits');
      assert.ok(commitsMod.blameLine, 'blameLine missing');
      const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4';
      const g = mkBlameGit(() => `${sha} 12 42 1\nauthor Me\n\tsome code line\n`);
      assert.strictEqual(commitsMod.blameLine(projWhy, 'src/auth.js', 42, g.deps), sha);
      assert.ok(g.calls[0].includes('blame') && g.calls[0].includes('-L') && g.calls[0].some(a => a === '42,42'),
        'must run git blame -L <line>,<line>');
      assert.ok(g.calls[0].includes('--porcelain'), 'must use --porcelain');
    });
    check('provenance: blameLine returns null for an all-zero (uncommitted) SHA, garbage, and a throwing runner', () => {
      const commitsMod = require('../lib/commits');
      assert.strictEqual(commitsMod.blameLine(projWhy, 'src/auth.js', 1, mkBlameGit(() => `${'0'.repeat(40)} 1 1 1\n`).deps), null,
        'all-zero blame SHA = not committed yet → null');
      assert.strictEqual(commitsMod.blameLine(projWhy, 'src/auth.js', 1, mkBlameGit(() => 'not a sha at all\n').deps), null);
      assert.strictEqual(commitsMod.blameLine(projWhy, 'src/auth.js', 1, mkBlameGit(() => '').deps), null);
      assert.strictEqual(commitsMod.blameLine(projWhy, 'src/auth.js', 1, mkBlameGit(() => { throw new Error('fatal'); }).deps), null,
        'a git failure degrades to null, never throws');
    });
    check('provenance: blameLine guards a non-positive / non-integer line before touching git', () => {
      const commitsMod = require('../lib/commits');
      for (const bad of [0, -1, 2.5, 'foo', null, undefined]) {
        const g = mkBlameGit(() => `${'a'.repeat(40)} 1 1 1\n`);
        assert.strictEqual(commitsMod.blameLine(projWhy, 'src/auth.js', bad, g.deps), null, `line ${bad} must be null`);
        assert.strictEqual(g.calls.length, 0, `must not run git for a bad line (${bad})`);
      }
    });

    // --- Phase 3 Task 2: lineProvenance (SHA → map → session row) ----------
    const SHA_W1 = '1'.repeat(40);
    const SHA_MERGE = '2'.repeat(40);
    const SHA_MISSING = '3'.repeat(40);
    const SHA_PENDING = '4'.repeat(40);
    const lineMap = [
      { sha: SHA_W1, ts: '2026-07-18T09:05:00.000Z', project: projWhy,
        sessions: [{ session: 'w1', files: ['src/auth.js'] }], unattributed: [] },
      { sha: SHA_MERGE, ts: '2026-07-18T09:06:00.000Z', project: projWhy, sessions: [], unattributed: [] },
      // Provisional-only: recorded by the hook, not yet settled by the daemon.
      { sha: SHA_PENDING, ts: '2026-07-18T09:07:00.000Z', project: projWhy,
        sessions: [], unattributed: ['src/auth.js'], provisional: true },
    ];
    const lineDeps = (sha, opts = {}) => ({
      blameLine: opts.throw ? () => { throw new Error('git down'); } : () => sha,
      loadCommitMap: () => lineMap,
    });

    check('lineProvenance: a mapped line yields one fileProvenance-shaped row for the owning session', () => {
      assert.ok(prov.lineProvenance, 'lineProvenance missing');
      const res = prov.lineProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/auth.js', 2, whyNow, lineDeps(SHA_W1));
      assert.strictEqual(res.fallback, null, `expected no fallback, got ${res.fallback}`);
      assert.strictEqual(res.sha, SHA_W1);
      assert.strictEqual(res.line, 2);
      assert.ok(res.session, 'expected a session row');
      assert.strictEqual(res.session.who, 'You');
      assert.strictEqual(res.session.session, 'w1');
      assert.ok(/Rewrote auth/.test(res.session.summary), `row summary was: ${res.session.summary}`);
      // Row shape is EXACTLY fileProvenance's row for that session — no extras.
      const fileRow = prov.fileProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/auth.js', whyNow)
        .find(r => r.session === 'w1');
      assert.deepStrictEqual(res.session, fileRow, 'line row must match the file-level row for that session');
    });

    check('lineProvenance: every fallback path sets the right reason with a null session', () => {
      assert.ok(prov.lineProvenance, 'lineProvenance missing');
      const call = (line, deps) => prov.lineProvenance(projWhy, { events: whyEvents }, cfgWhy, 'src/auth.js', line, whyNow, deps);
      // no / bad line
      for (const bad of [null, 0, 'foo']) {
        const r = call(bad, lineDeps(SHA_W1));
        assert.strictEqual(r.fallback, 'no-line', `line ${bad} → no-line`);
        assert.strictEqual(r.session, null);
      }
      // all-zero blame (blameLine returns null) → uncommitted
      const unc = call(2, { blameLine: () => null, loadCommitMap: () => lineMap });
      assert.strictEqual(unc.fallback, 'uncommitted');
      assert.strictEqual(unc.session, null);
      // SHA present in blame but not in the map → unmapped
      const unm = call(2, lineDeps(SHA_MISSING));
      assert.strictEqual(unm.fallback, 'unmapped');
      assert.strictEqual(unm.session, null);
      // merge record (files:[]) → merge
      const mrg = call(2, lineDeps(SHA_MERGE));
      assert.strictEqual(mrg.fallback, 'merge');
      assert.strictEqual(mrg.session, null);
      // Test 5 (brief's list): a provisional-only commit record → 'pending',
      // never 'unmapped'/'merge' even though sessions:[] would otherwise read
      // exactly like one of those.
      const pend = call(2, lineDeps(SHA_PENDING));
      assert.strictEqual(pend.fallback, 'pending', `expected pending, got ${pend.fallback}`);
      assert.strictEqual(pend.session, null);
      assert.strictEqual(pend.sha, SHA_PENDING);
      // throwing git → git-unavailable
      const dead = call(2, lineDeps(SHA_W1, { throw: true }));
      assert.strictEqual(dead.fallback, 'git-unavailable');
      assert.strictEqual(dead.session, null);
    });

    check('provenance: parseFileLineArg splits <file>:<line>, tolerating drive-colons and column paste', () => {
      assert.ok(prov.parseFileLineArg, 'parseFileLineArg missing');
      assert.deepStrictEqual(prov.parseFileLineArg('src/a.js:42'), { file: 'src/a.js', line: 42 });
      assert.deepStrictEqual(prov.parseFileLineArg('src/a.js'), { file: 'src/a.js', line: null });
      assert.deepStrictEqual(prov.parseFileLineArg('C:\\x.js:10'), { file: 'C:\\x.js', line: 10 },
        'a Windows drive colon must not be mistaken for the line separator');
      assert.deepStrictEqual(prov.parseFileLineArg('a.js:42:7'), { file: 'a.js', line: 42 },
        'an editor "file:line:col" paste keeps the LINE, drops the column');
      assert.deepStrictEqual(prov.parseFileLineArg('a.js:foo'), { file: 'a.js:foo', line: null },
        'a non-numeric suffix is part of the filename, not a line');
    });

    // CLI wiring: spawn the real binary from a project SUBDIR — resolveRoot
    // must walk up to the tracked root, and output must be newest-first and
    // redacted. State is planted on disk for the subprocess to read.
    {
      const st = util.loadState();
      st.projects[projWhy] = { events: whyEvents, teamEntries: whyTeam };
      util.saveState(st);
      const out = spawnSync(process.execPath, [BIN, 'why', 'auth.js'],
        { cwd: path.join(projWhy, 'src'), encoding: 'utf8', env: process.env });
      check('why: `membridge why <file>` prints newest-first, redacted provenance from a subdir', () => {
        assert.strictEqual(out.status, 0, `exit ${out.status}, stderr: ${out.stderr}`);
        assert.ok(out.stdout.includes('src/auth.js'), `stdout: ${out.stdout}`);
        const iPriya = out.stdout.indexOf('Priya');
        const iCodex = out.stdout.indexOf('Codex');
        const iClaude = out.stdout.indexOf('Claude Code');
        assert.ok(iPriya !== -1 && iCodex !== -1 && iClaude !== -1, `stdout: ${out.stdout}`);
        assert.ok(iPriya < iClaude, 'teammate (newest) should print before the oldest local session');
        assert.ok(!out.stdout.includes('sk-why-secret-111') && !out.stdout.includes('sk-why-team-333'), 'secret leaked into CLI output');
        assert.ok(out.stdout.includes('[redacted'), 'no redaction marker in CLI output');
      });
      const miss = spawnSync(process.execPath, [BIN, 'why', 'no-such-file.js'],
        { cwd: projWhy, encoding: 'utf8', env: process.env });
      check('why: unknown file inside a tracked project prints a friendly empty result', () => {
        assert.strictEqual(miss.status, 0, `exit ${miss.status}, stderr: ${miss.stderr}`);
        assert.ok(/No recorded AI edits/i.test(miss.stdout), `stdout: ${miss.stdout}`);
      });
    }

    // MCP round trip: the 5th read-only tool over the same provenance module,
    // redacted at the boundary exactly like the other four.
    {
      const [whyCt, whySt] = InMemoryTransport.createLinkedPair();
      const whyServer = mcpMod.createServer();
      const whyClient = new McpClient({ name: 'why-test-client', version: '1.0.0' });
      await Promise.all([whyServer.connect(whySt), whyClient.connect(whyCt)]);
      const callJson = async (name, a) => {
        const res = await whyClient.callTool({ name, arguments: a || {} });
        return { res, data: JSON.parse(res.content[0].text) };
      };
      let whyErr = null, whyData = null, whyMissData = null, whyBadRes = null;
      try {
        whyData = (await callJson('why', { project: projWhy, file: 'src/auth.js' })).data;
        whyMissData = (await callJson('why', { project: projWhy, file: 'src/nope.js' })).data;
        whyBadRes = (await callJson('why', { project: path.join(ROOT, 'projects', 'nope-app'), file: 'x.js' })).res;
      } catch (e) { whyErr = e; }
      check('mcp: why(file) round trip — sessions newest-first, redacted, empty for unknown file, isError for unknown project', () => {
        assert.ok(!whyErr, `why call failed: ${whyErr && whyErr.message}`);
        assert.strictEqual(whyData.file, 'src/auth.js');
        assert.strictEqual(whyData.sessions.length, 3, `expected 3 sessions, got ${whyData.sessions.length}`);
        assert.strictEqual(whyData.sessions[0].who, 'Priya');
        assert.strictEqual(whyData.sessions[2].session, 'w1');
        const blob = JSON.stringify(whyData);
        assert.ok(!blob.includes('sk-why-secret-111') && !blob.includes('sk-why-secret-222') && !blob.includes('sk-why-team-333'),
          'secret leaked through the MCP boundary');
        assert.deepStrictEqual(whyMissData.sessions, []);
        assert.strictEqual(whyBadRes.isError, true);
      });
      await whyClient.close();
    }
  }

  // --- 15b. Line-level `why <file>:<line>` end-to-end (Phase 3 Task 2) ------
  // A REAL repo so `git blame` resolves a real SHA; a planted commit map ties
  // that SHA to a session; events give the session its ask/summary. Exercises
  // the CLI (spawned) and the MCP boundary (in-process) over the same data.
  {
    const projLine = path.join(ROOT, 'projects', 'line-why-app');
    fs.mkdirSync(path.join(projLine, 'src'), { recursive: true });
    const gl = args => spawnSync('git', ['-C', projLine, ...args], { encoding: 'utf8' });
    gl(['init', '-q']);
    gl(['config', 'user.email', 'me@local.dev']);
    gl(['config', 'user.name', 'Me']);
    fs.writeFileSync(path.join(projLine, 'src', 'auth.js'), 'const token = rotate();\n');
    gl(['add', '-A']);
    gl(['commit', '-q', '-m', 'auth line']);
    const lineSha = gl(['rev-parse', 'HEAD']).stdout.trim();
    // An extra, UNCOMMITTED line in the working tree — blame of it is all-zero.
    fs.appendFileSync(path.join(projLine, 'src', 'auth.js'), 'const scratch = 1;\n');
    const lineEvents = [
      { ts: '2026-07-18T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'Add token=sk-line-secret rotation', session: 'L1' },
      { ts: '2026-07-18T09:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projLine, 'src', 'auth.js'), session: 'L1' },
      { ts: '2026-07-18T09:02:00.000Z', source: 'Claude Code', kind: 'summary', text: 'Rotated the auth token each request', session: 'L1', decisions: 'per-request rotation', gotchas: '' },
    ];
    {
      const st = util.loadState();
      st.projects[projLine] = { events: lineEvents };
      util.saveState(st);
    }
    const commitsMod = require('../lib/commits');
    commitsMod.recordCommit(projLine, {
      sha: lineSha, ts: '2026-07-18T09:05:00.000Z', project: projLine,
      sessions: [{ session: 'L1', files: ['src/auth.js'] }], unattributed: [],
    });

    const cliLine = spawnSync(process.execPath, [BIN, 'why', 'src/auth.js:1'],
      { cwd: projLine, encoding: 'utf8', env: process.env });
    check('why: `membridge why <file>:<line>` resolves the line to its session, redacted, with the short SHA', () => {
      assert.strictEqual(cliLine.status, 0, `exit ${cliLine.status}, stderr: ${cliLine.stderr}`);
      assert.ok(cliLine.stdout.includes('src/auth.js:1'), `stdout: ${cliLine.stdout}`);
      assert.ok(cliLine.stdout.includes(lineSha.slice(0, 10)), `expected short sha ${lineSha.slice(0, 10)} in: ${cliLine.stdout}`);
      assert.ok(/Rotated the auth token/.test(cliLine.stdout), `expected the session summary in: ${cliLine.stdout}`);
      assert.ok(!cliLine.stdout.includes('sk-line-secret'), 'secret leaked into line-level CLI output');
    });

    const cliUncommitted = spawnSync(process.execPath, [BIN, 'why', 'src/auth.js:2'],
      { cwd: projLine, encoding: 'utf8', env: process.env });
    check('why: an uncommitted line prints the fallback annotation AND the file-level history', () => {
      assert.strictEqual(cliUncommitted.status, 0, `exit ${cliUncommitted.status}, stderr: ${cliUncommitted.stderr}`);
      assert.ok(/not committed yet|not yet attributable/i.test(cliUncommitted.stdout), `expected an uncommitted annotation in: ${cliUncommitted.stdout}`);
      assert.ok(/Rotated the auth token/.test(cliUncommitted.stdout), `expected file-level history in the fallback: ${cliUncommitted.stdout}`);
    });

    const cliPlain = spawnSync(process.execPath, [BIN, 'why', 'src/auth.js'],
      { cwd: projLine, encoding: 'utf8', env: process.env });
    check('why: `membridge why <file>` (no line) is unchanged file-level output', () => {
      assert.strictEqual(cliPlain.status, 0, cliPlain.stderr);
      assert.ok(/Why src\/auth\.js —/.test(cliPlain.stdout), `stdout: ${cliPlain.stdout}`);
      assert.ok(!/commit [0-9a-f]/.test(cliPlain.stdout), 'plain why must not print a commit line');
    });

    // Test 5 (brief's list), CLI half: a provisional-only commit (just
    // committed, not yet settled) prints the explicit "pending" annotation
    // AND falls back to file-level history — the same rendering path as the
    // uncommitted fallback above. A SEPARATE file (not auth.js) so this in no
    // way disturbs auth.js's still-uncommitted line 2 used above/below.
    fs.writeFileSync(path.join(projLine, 'src', 'pending.js'), 'const p = 1;\n');
    gl(['add', 'src/pending.js']);
    gl(['commit', '-q', '-m', 'pending file']);
    const pendingSha = gl(['rev-parse', 'HEAD']).stdout.trim();
    {
      const st = util.loadState();
      st.projects[projLine].events.push(
        { ts: '2026-07-18T09:10:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projLine, 'src', 'pending.js'), session: 'L1' });
      util.saveState(st);
    }
    commitsMod.recordCommit(projLine, {
      sha: pendingSha, ts: '2026-07-18T09:11:00.000Z', project: projLine,
      sessions: [], unattributed: ['src/pending.js'], provisional: true,
    });
    const cliPending = spawnSync(process.execPath, [BIN, 'why', 'src/pending.js:1'],
      { cwd: projLine, encoding: 'utf8', env: process.env });
    check('why: a provisional (just-committed, not-yet-settled) line prints "attribution pending" AND file-level history', () => {
      assert.strictEqual(cliPending.status, 0, `exit ${cliPending.status}, stderr: ${cliPending.stderr}`);
      assert.ok(/attribution pending/i.test(cliPending.stdout), `expected the pending annotation in: ${cliPending.stdout}`);
      // A row can stay pending for a full grace window (or longer, while a
      // credited candidate catches up) — the annotation must not promise
      // recency it cannot know.
      assert.ok(!/just committed/i.test(cliPending.stdout), `annotation must not claim "just committed": ${cliPending.stdout}`);
      assert.ok(/Why src\/pending\.js —/.test(cliPending.stdout), `expected file-level history fallback in: ${cliPending.stdout}`);
    });

    // MCP boundary: the why tool gains an optional line param.
    {
      const [ct, stx] = InMemoryTransport.createLinkedPair();
      const server = mcpMod.createServer();
      const client = new McpClient({ name: 'why-line-client', version: '1.0.0' });
      await Promise.all([server.connect(stx), client.connect(ct)]);
      const callJson = async (a) => JSON.parse((await client.callTool({ name: 'why', arguments: a })).content[0].text);
      let lineData = null, uncData = null, err = null;
      try {
        lineData = await callJson({ project: projLine, file: 'src/auth.js', line: 1 });
        uncData = await callJson({ project: projLine, file: 'src/auth.js', line: 2 });
      } catch (e) { err = e; }
      check('mcp: why with a line returns a redacted single session row + sha, fallback carried through', () => {
        assert.ok(!err, `why(line) failed: ${err && err.message}`);
        assert.strictEqual(lineData.line, 1);
        assert.strictEqual(lineData.sha, lineSha);
        assert.strictEqual(lineData.fallback, null);
        assert.ok(lineData.session && lineData.session.session === 'L1', `session: ${JSON.stringify(lineData.session)}`);
        assert.ok(!JSON.stringify(lineData).includes('sk-line-secret'), 'secret leaked through the MCP line boundary');
        // Uncommitted line: fallback carried through, no session.
        assert.strictEqual(uncData.fallback, 'uncommitted');
        assert.strictEqual(uncData.session, null);
      });
      await client.close();
    }
  }

  // --- 16. Commit↔session attribution (lib/commits.js, provenance Phase 2) ---
  // Pure fixtures — no git, no wall clock. Events carry ABSOLUTE file paths
  // (as the real stream does) and are normalized against opts.projectPath;
  // changed files arrive repo-relative (as git reports them).
  {
    const projC = path.join(ROOT, 'projects', 'commits-app');
    const editEv = (session, ts, rel) =>
      ({ ts, source: 'Claude Code', kind: 'edit', file: path.join(projC, rel), session });
    const commitEvts = [
      editEv('sA', '2026-07-18T10:00:00.000Z', 'src/a.js'),
      editEv('sA', '2026-07-18T10:01:00.000Z', 'src/b.js'),
      editEv('sB', '2026-07-18T10:05:00.000Z', 'src/b.js'),
      editEv('sB', '2026-07-18T10:06:00.000Z', 'src/c.js'),
      { ts: '2026-07-18T10:07:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'noise', session: 'sB' },
      editEv('', '2026-07-18T10:08:00.000Z', 'docs/orphan.md'),
      editEv('sC', '2026-07-18T11:30:00.000Z', 'src/a.js'), // after the commit
    ];
    const COMMIT_TS = '2026-07-18T11:00:00.000Z';
    const cOpts = { projectPath: projC };

    let commits = null;
    check('commits: one session that edited every changed file owns them all', () => {
      commits = require('../lib/commits');
      const soloEvts = [
        editEv('sA', '2026-07-18T10:00:00.000Z', 'src/a.js'),
        editEv('sA', '2026-07-18T10:01:00.000Z', 'src/b.js'),
      ];
      const res = commits.attributeCommit(['src/a.js', 'src/b.js'], COMMIT_TS, soloEvts, cOpts);
      assert.deepStrictEqual(res, {
        sessions: [{ session: 'sA', files: ['src/a.js', 'src/b.js'] }],
        unattributed: [],
      });
      // ms-epoch commit time is accepted and equivalent
      const resMs = commits.attributeCommit(['src/a.js', 'src/b.js'], Date.parse(COMMIT_TS), soloEvts, cOpts);
      assert.deepStrictEqual(resMs, res);
    });

    check('commits: files split across the sessions that own them, newest-owning session first', () => {
      assert.ok(commits, 'lib/commits.js missing');
      const res = commits.attributeCommit(['src/a.js', 'src/c.js'], COMMIT_TS, commitEvts, cOpts);
      assert.deepStrictEqual(res.sessions, [
        { session: 'sB', files: ['src/c.js'] },     // last edit 10:06 — newest first
        { session: 'sA', files: ['src/a.js'] },     // last edit 10:00
      ]);
      assert.deepStrictEqual(res.unattributed, []);
    });

    check('commits: when two sessions edited the same file before the commit, the most recent wins', () => {
      assert.ok(commits, 'lib/commits.js missing');
      const res = commits.attributeCommit(['src/b.js'], COMMIT_TS, commitEvts, cOpts);
      assert.deepStrictEqual(res.sessions, [{ session: 'sB', files: ['src/b.js'] }]);
    });

    check('commits: a changed file with no qualifying edit — or only a sessionless one — is unattributed', () => {
      assert.ok(commits, 'lib/commits.js missing');
      const res = commits.attributeCommit(['src/zzz.js', 'docs/orphan.md'], COMMIT_TS, commitEvts, cOpts);
      assert.deepStrictEqual(res.sessions, []);
      assert.deepStrictEqual(res.unattributed, ['src/zzz.js', 'docs/orphan.md']);
    });

    check('commits: edits dated after the commit never attribute', () => {
      assert.ok(commits, 'lib/commits.js missing');
      // At 11:00, sC's 11:30 edit of a.js must not steal ownership from sA…
      const late = commits.attributeCommit(['src/a.js'], COMMIT_TS, commitEvts, cOpts);
      assert.deepStrictEqual(late.sessions, [{ session: 'sA', files: ['src/a.js'] }]);
      // …and with a commit time before every edit, nothing qualifies at all.
      const early = commits.attributeCommit(['src/a.js'], '2026-07-18T09:00:00.000Z', commitEvts, cOpts);
      assert.deepStrictEqual(early.sessions, []);
      assert.deepStrictEqual(early.unattributed, ['src/a.js']);
    });

    check('commits: absolute and ./-prefixed changed-file spellings normalize and still match', () => {
      assert.ok(commits, 'lib/commits.js missing');
      const res = commits.attributeCommit(
        ['./src/a.js', path.join(projC, 'src', 'b.js')], COMMIT_TS, commitEvts, cOpts);
      const owned = res.sessions.flatMap(s => s.files).sort();
      assert.deepStrictEqual(owned, ['src/a.js', 'src/b.js'], 'both spellings must normalize to repo-relative and match');
      assert.deepStrictEqual(res.unattributed, []);
    });

    // --- Phase 2 Task 2: the git commit reader, injected runGit only -------
    // Canned git output, no real repo. The fake records every args array so
    // tests can pin WHICH git commands run (the -n 50 cap, the ranges).
    const mkGit = handler => {
      const calls = [];
      return { calls, deps: { runGit: args => { calls.push(args); return handler(args); } } };
    };

    check('commits: readCommit parses committer ts, committer email, and changed files from git show --numstat', () => {
      assert.ok(commits && commits.readCommit, 'readCommit missing');
      // Real shape of `git show --numstat --format=%cI|%ce|%P`: the format line
      // (date|committer-email|parents), a blank line, then numstat rows. The
      // committer email is what the authorship gate compares against.
      const g = mkGit(() => '2026-07-18T14:00:00+02:00|me@local.dev|p0000aa\n\n3\t1\tsrc/a.js\n10\t0\tsrc/b.js\n');
      const res = commits.readCommit(projC, 'abc1234', g.deps);
      assert.deepStrictEqual(res, {
        sha: 'abc1234',
        ts: '2026-07-18T14:00:00+02:00',
        email: 'me@local.dev',
        files: ['src/a.js', 'src/b.js'],
      });
      assert.strictEqual(g.calls.length, 1);
      assert.ok(g.calls[0].includes('abc1234'), 'sha missing from the git invocation');
      assert.ok(g.calls[0].includes('--no-show-signature'),
        'must pass --no-show-signature: log.showSignature=true would otherwise prepend signature text to stdout and corrupt ts');
      assert.ok(g.calls[0].some(a => a.includes('%cI|%ce|%P')), 'format must carry committer email + parent list');
    });

    check('commits: readCommit unquotes a C-quoted spaced path and decodes octal UTF-8 bytes', () => {
      assert.ok(commits && commits.readCommit, 'readCommit missing');
      const g = mkGit(() => '2026-07-18T14:00:00Z|dev@x.io|p0000aa\n\n2\t0\t"docs/read me.md"\n1\t0\t"\\303\\244.txt"\n');
      const res = commits.readCommit(projC, 'beef111', g.deps);
      assert.deepStrictEqual(res.files, ['docs/read me.md', 'ä.txt'],
        'octal escapes are UTF-8 bytes, not Latin-1 chars');
      assert.strictEqual(res.email, 'dev@x.io', 'committer email must survive alongside quoted paths');
      // the shared changes.js helper is the thing that decodes
      assert.strictEqual(changesLib.unquote('"\\303\\244.txt"'), 'ä.txt');
      assert.strictEqual(changesLib.unquote('plain.js'), 'plain.js');
    });

    check('commits: readCommit on a merge returns empty files even though git prints first-parent numstat rows', () => {
      assert.ok(commits && commits.readCommit, 'readCommit missing');
      // Modern git (>=2.31) DOES print numstat rows for merges (first-parent
      // diff) — verified on this repo. The merge contract must therefore be
      // enforced from the parent list, never inferred from empty output.
      const merge = commits.readCommit(projC, 'mmm2222',
        mkGit(() => '2026-07-18T15:00:00Z|dev@x.io|p0000aa p0000bb\n\n748\t0\tdocs/upstream.md\n12\t3\tlib/other.js\n').deps);
      assert.deepStrictEqual(merge, { sha: 'mmm2222', ts: '2026-07-18T15:00:00Z', email: 'dev@x.io', files: [] });
      const broken = commits.readCommit(projC, 'eee3333',
        mkGit(() => { throw new Error('fatal: bad object'); }).deps);
      assert.deepStrictEqual(broken, { sha: 'eee3333', ts: null, email: null, files: [] });
    });

    // --- Phase 3 Task 1: authorship gate (committer email == local user.email) ---
    check('commits: gitUserEmail reads local user.email, trims it, and degrades to null', () => {
      assert.ok(commits && commits.gitUserEmail, 'gitUserEmail missing');
      const g = mkGit(() => 'me@local.dev\n');
      assert.strictEqual(commits.gitUserEmail(projC, g.deps), 'me@local.dev');
      assert.ok(g.calls[0].includes('config') && g.calls[0].includes('user.email'), 'must read git config user.email');
      // Unset user.email: git prints nothing / exits non-zero → null (fail closed)
      assert.strictEqual(commits.gitUserEmail(projC, mkGit(() => '').deps), null);
      assert.strictEqual(commits.gitUserEmail(projC, mkGit(() => { throw new Error('no email'); }).deps), null);
    });

    check('commits: isLocalCommitter is true only for a matching identity, fail-closed otherwise', () => {
      assert.ok(commits && commits.isLocalCommitter, 'isLocalCommitter missing');
      assert.strictEqual(commits.isLocalCommitter('me@local.dev', 'me@local.dev'), true);
      assert.strictEqual(commits.isLocalCommitter(' me@local.dev ', 'me@local.dev'), true, 'surrounding whitespace ignored');
      assert.strictEqual(commits.isLocalCommitter('teammate@remote.dev', 'me@local.dev'), false, 'a foreign committer is never local');
      assert.strictEqual(commits.isLocalCommitter('me@local.dev', null), false, 'missing local user.email fails closed');
      assert.strictEqual(commits.isLocalCommitter(null, 'me@local.dev'), false, 'missing committer email fails closed');
      assert.strictEqual(commits.isLocalCommitter(null, null), false);
    });

    check('commits: newCommitsSince returns post-cursor commits oldest-first, excluding merges', () => {
      assert.ok(commits && commits.newCommitsSince, 'newCommitsSince missing');
      const g = mkGit(args => {
        if (args.includes('merge-base')) return ''; // ancestor check passes
        return 'c3new\nc2mid\nc1old\n';             // git log: newest first
      });
      const res = commits.newCommitsSince(projC, 'cursor99', g.deps);
      assert.deepStrictEqual(res, ['c1old', 'c2mid', 'c3new'], 'must be oldest-first');
      const logCall = g.calls.find(a => a.includes('log'));
      assert.ok(logCall, 'expected a git log call');
      assert.ok(logCall.includes('--no-merges'), 'merges must be excluded');
      assert.ok(logCall.some(a => a === 'cursor99..HEAD'), 'expected the sinceSha..HEAD range');
    });

    check('commits: first run (no cursor) is capped at the last 50 commits, never the whole history', () => {
      assert.ok(commits && commits.newCommitsSince, 'newCommitsSince missing');
      const g = mkGit(() => 'n2\nn1\n');
      const res = commits.newCommitsSince(projC, null, g.deps);
      assert.deepStrictEqual(res, ['n1', 'n2']);
      const logCall = g.calls.find(a => a.includes('log'));
      assert.ok(logCall.includes('-n') && logCall.includes('50'), `expected -n 50, got: ${logCall}`);
      assert.ok(!logCall.some(a => a.includes('..')), 'first run must not use a range');
      // An unknown / non-ancestor cursor falls back to the SAME bounded run.
      const g2 = mkGit(args => {
        if (args.includes('merge-base')) throw new Error('not an ancestor');
        return 'n2\nn1\n';
      });
      const res2 = commits.newCommitsSince(projC, 'gone000', g2.deps);
      assert.deepStrictEqual(res2, ['n1', 'n2']);
      const log2 = g2.calls.find(a => a.includes('log'));
      assert.ok(log2.includes('-n') && log2.includes('50'), 'bad cursor must fall back to the bounded first run');
    });

    check('commits: any git failure in newCommitsSince returns [], never throws', () => {
      assert.ok(commits && commits.newCommitsSince, 'newCommitsSince missing');
      const dead = mkGit(() => { throw new Error('fatal: not a git repository'); });
      assert.deepStrictEqual(commits.newCommitsSince(projC, null, dead.deps), []);
      assert.deepStrictEqual(commits.newCommitsSince(projC, 'cursor99', dead.deps), []);
    });

    // --- Phase 2 Task 3: persist the map + populate during sync ------------

    check('commits: recordCommit/loadCommitMap round-trip skips garbage lines; lastRecordedSha is the newest', () => {
      assert.ok(commits && commits.recordCommit, 'recordCommit missing');
      const projStore = path.join(ROOT, 'projects', 'commit-store-app');
      fs.mkdirSync(projStore, { recursive: true });
      const rec1 = { sha: 's1', ts: 't1', project: projStore, sessions: [{ session: 'w1', files: ['a.js'] }], unattributed: [] };
      const rec2 = { sha: 's2', ts: 't2', project: projStore, sessions: [], unattributed: ['b.js'] };
      commits.recordCommit(projStore, rec1);
      fs.appendFileSync(path.join(projStore, '.membridge', 'commits.jsonl'), 'NOT JSON {{{\n');
      commits.recordCommit(projStore, rec2);
      assert.deepStrictEqual(commits.loadCommitMap(projStore), [rec1, rec2], 'round trip with garbage line skipped');
      assert.strictEqual(commits.lastRecordedSha(projStore), 's2');
      const nowhere = path.join(ROOT, 'projects', 'no-such-app');
      assert.deepStrictEqual(commits.loadCommitMap(nowhere), []);
      assert.strictEqual(commits.lastRecordedSha(nowhere), null);
    });

    check('commits: recordCommit lands on a fresh line after a torn (newline-less) tail instead of gluing', () => {
      assert.ok(commits && commits.recordCommit, 'recordCommit missing');
      const projTorn = path.join(ROOT, 'projects', 'commit-torn-app');
      fs.mkdirSync(path.join(projTorn, '.membridge'), { recursive: true });
      // A crash/ENOSPC mid-append leaves a partial line with no trailing \n.
      fs.writeFileSync(path.join(projTorn, '.membridge', 'commits.jsonl'), '{"sha":"aaa","ts":"2026-0');
      const rec = { sha: 'bbb', ts: 't', project: projTorn, sessions: [], unattributed: [] };
      commits.recordCommit(projTorn, rec);
      assert.deepStrictEqual(commits.loadCommitMap(projTorn), [rec],
        'the healthy record must survive beside the torn line, not be glued into it');
      assert.strictEqual(commits.lastRecordedSha(projTorn), 'bbb');
    });

    // --- Task 3: O(1) idempotency check + dedupe-by-sha on read -------------

    check('commits: lastRecordedSha is a cheap tail read — never parses the whole file', () => {
      const projTail = path.join(ROOT, 'projects', 'commit-tail-app');
      fs.mkdirSync(path.join(projTail, '.membridge'), { recursive: true });
      const file = path.join(projTail, '.membridge', 'commits.jsonl');
      // A large garbage line planted early would be observed by a full-file
      // parse (loadCommitMap already tolerates it, but a cheap check must
      // never even read this far back into the file).
      fs.writeFileSync(file, 'NOT JSON ' + 'x'.repeat(20000) + '\n');
      for (let i = 0; i < 500; i++) {
        fs.appendFileSync(file, JSON.stringify({ sha: `s${i}`, ts: 't', project: projTail, sessions: [], unattributed: [] }) + '\n');
      }
      const origReadFile = fs.readFileSync;
      let readFileCalls = 0;
      fs.readFileSync = function (...args) { readFileCalls++; return origReadFile.apply(fs, args); };
      try {
        assert.strictEqual(commits.lastRecordedSha(projTail), 's499');
      } finally {
        fs.readFileSync = origReadFile;
      }
      assert.strictEqual(readFileCalls, 0, `lastRecordedSha must not full-parse the file (readFileSync called ${readFileCalls}x)`);
    });

    check('commits: lastRecordedSha stays correct even when the last record is bigger than the tail window', () => {
      const projBig = path.join(ROOT, 'projects', 'commit-bigrec-app');
      fs.mkdirSync(path.join(projBig, '.membridge'), { recursive: true });
      const file = path.join(projBig, '.membridge', 'commits.jsonl');
      fs.writeFileSync(file, JSON.stringify({ sha: 'small1', ts: 't', project: projBig, sessions: [], unattributed: [] }) + '\n');
      // A record that alone exceeds any reasonable tail-read window (many
      // files in one commit) — the cheap path must fall back to a full parse
      // rather than return a wrong/partial answer.
      const manyFiles = Array.from({ length: 2000 }, (_, i) => `src/file${i}.js`);
      const bigRec = { sha: 'bigrecordsha', ts: 't', project: projBig, sessions: [{ session: 'w1', files: manyFiles }], unattributed: [] };
      fs.appendFileSync(file, JSON.stringify(bigRec) + '\n');
      assert.strictEqual(commits.lastRecordedSha(projBig), 'bigrecordsha');
      assert.deepStrictEqual(commits.loadCommitMap(projBig).map(r => r.sha), ['small1', 'bigrecordsha']);
    });

    check('commits: lastRecordedSha fallback tracks the physically-last write, not dedup-by-sha order', () => {
      // A pathological but possible file: sha A, then sha B, then sha A again
      // (a legitimate non-consecutive duplicate — see the division-of-labor
      // comment) as the physically LAST line, made big enough to force the
      // tail-read into its full-parse fallback. Dedup-by-sha's first-seen
      // ordering would put A before B and answer 'B' here; the physically
      // last write is really 'A', and that's what a writer's idempotency
      // check must see.
      const projOrder = path.join(ROOT, 'projects', 'commit-fallback-order-app');
      fs.mkdirSync(path.join(projOrder, '.membridge'), { recursive: true });
      const file = path.join(projOrder, '.membridge', 'commits.jsonl');
      const manyFiles = Array.from({ length: 2000 }, (_, i) => `src/file${i}.js`);
      fs.writeFileSync(file, JSON.stringify({ sha: 'A', ts: 't1', project: projOrder, sessions: [], unattributed: [] }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ sha: 'B', ts: 't2', project: projOrder, sessions: [], unattributed: ['b.js'] }) + '\n');
      fs.appendFileSync(file, JSON.stringify({ sha: 'A', ts: 't3', project: projOrder, sessions: [{ session: 'w1', files: manyFiles }], unattributed: [] }) + '\n');
      assert.strictEqual(commits.lastRecordedSha(projOrder), 'A');
    });

    check('commits: lastRecordedSha degrades to null (never throws) for a missing/unreadable file', () => {
      const projMissing = path.join(ROOT, 'projects', 'commit-idem-missing-app');
      assert.strictEqual(commits.lastRecordedSha(projMissing), null);
    });

    check('commits: dedupe-by-sha keeps one row — a real-session row beats an empty-session row, either write order', () => {
      const projDedupA = path.join(ROOT, 'projects', 'commit-dedupe-a-app');
      fs.mkdirSync(path.join(projDedupA, '.membridge'), { recursive: true });
      const empty = { sha: 'dup1', ts: 't1', project: projDedupA, sessions: [], unattributed: ['x.js'] };
      const real = { sha: 'dup1', ts: 't2', project: projDedupA, sessions: [{ session: 'w1', files: ['x.js'] }], unattributed: [] };
      commits.recordCommit(projDedupA, empty);
      commits.recordCommit(projDedupA, real);
      const mapA = commits.loadCommitMap(projDedupA);
      assert.strictEqual(mapA.length, 1, `expected 1 deduped row, got ${JSON.stringify(mapA)}`);
      assert.deepStrictEqual(mapA[0], real, 'the real-session row must win over the empty one');

      const projDedupB = path.join(ROOT, 'projects', 'commit-dedupe-b-app');
      fs.mkdirSync(path.join(projDedupB, '.membridge'), { recursive: true });
      commits.recordCommit(projDedupB, real);
      commits.recordCommit(projDedupB, empty);
      const mapB = commits.loadCommitMap(projDedupB);
      assert.strictEqual(mapB.length, 1, `expected 1 deduped row, got ${JSON.stringify(mapB)}`);
      assert.deepStrictEqual(mapB[0], real, 'the real-session row must win over the empty one, reverse write order too');
    });

    check('commits: dedupe-by-sha — two consecutive identical writes for the same sha produce one row', () => {
      const projDedupC = path.join(ROOT, 'projects', 'commit-dedupe-c-app');
      fs.mkdirSync(path.join(projDedupC, '.membridge'), { recursive: true });
      const rec = { sha: 'dup2', ts: 't1', project: projDedupC, sessions: [{ session: 'w1', files: ['a.js'] }], unattributed: [] };
      commits.recordCommit(projDedupC, rec);
      commits.recordCommit(projDedupC, rec);
      const mapC = commits.loadCommitMap(projDedupC);
      assert.strictEqual(mapC.length, 1, `expected 1 row for a consecutive duplicate write, got ${JSON.stringify(mapC)}`);
      assert.deepStrictEqual(mapC[0], rec);
    });

    check('commits: dedupe-by-sha does not disturb an otherwise duplicate-free map (regression)', () => {
      const projNoDup = path.join(ROOT, 'projects', 'commit-nodupe-app');
      fs.mkdirSync(path.join(projNoDup, '.membridge'), { recursive: true });
      const r1 = { sha: 'n1', ts: 't1', project: projNoDup, sessions: [{ session: 'w1', files: ['a.js'] }], unattributed: [] };
      const r2 = { sha: 'n2', ts: 't2', project: projNoDup, sessions: [], unattributed: ['b.js'] };
      commits.recordCommit(projNoDup, r1);
      commits.recordCommit(projNoDup, r2);
      assert.deepStrictEqual(commits.loadCommitMap(projNoDup), [r1, r2]);
    });

    // Test 3 (brief's list) + the full precedence rule: a SETTLED row (real
    // or empty) always beats a PROVISIONAL one for the same sha, regardless
    // of write order — this is the invariant a provisional-hook-row-never-
    // wins reconciliation design leans on.
    check('commits: isProvisionalCommit reads the flag; absent/falsy means settled', () => {
      assert.ok(commits.isProvisionalCommit, 'isProvisionalCommit missing');
      assert.strictEqual(commits.isProvisionalCommit({ sha: 'x', provisional: true }), true);
      assert.strictEqual(commits.isProvisionalCommit({ sha: 'x', provisional: false }), false);
      assert.strictEqual(commits.isProvisionalCommit({ sha: 'x' }), false, 'absent provisional means settled');
      assert.strictEqual(commits.isProvisionalCommit(null), false);
    });

    check('commits: dedupe-by-sha — a settled row always beats a provisional row, either write order', () => {
      const projSettleDedupe = path.join(ROOT, 'projects', 'commit-settle-dedupe-app');
      fs.mkdirSync(path.join(projSettleDedupe, '.membridge'), { recursive: true });

      // provisional written, then settled-real arrives — settled wins.
      const provA = { sha: 'pv1', ts: 't1', project: projSettleDedupe, sessions: [], unattributed: ['a.js'], provisional: true };
      const settledRealA = { sha: 'pv1', ts: 't1', project: projSettleDedupe, sessions: [{ session: 'w1', files: ['a.js'] }], unattributed: [], provisional: false };
      commits.recordCommit(projSettleDedupe, provA);
      commits.recordCommit(projSettleDedupe, settledRealA);
      assert.deepStrictEqual(commits.loadCommitMap(projSettleDedupe).find(r => r.sha === 'pv1'), settledRealA,
        'settled-real must win over an earlier provisional row');

      // settled-real written FIRST, then a stray provisional for the same sha
      // arrives later — settled must still win (order must not matter).
      const settledRealB = { sha: 'pv2', ts: 't1', project: projSettleDedupe, sessions: [{ session: 'w1', files: ['b.js'] }], unattributed: [], provisional: false };
      const provB = { sha: 'pv2', ts: 't2', project: projSettleDedupe, sessions: [], unattributed: ['b.js'], provisional: true };
      commits.recordCommit(projSettleDedupe, settledRealB);
      commits.recordCommit(projSettleDedupe, provB);
      assert.deepStrictEqual(commits.loadCommitMap(projSettleDedupe).find(r => r.sha === 'pv2'), settledRealB,
        'a LATER-arriving provisional row must never overwrite an already-settled row');

      // provisional, then settled-EMPTY (foreign/unattributable) — settled,
      // even though uninformative, still beats provisional.
      const provC = { sha: 'pv3', ts: 't1', project: projSettleDedupe, sessions: [], unattributed: ['c.js'], provisional: true };
      const settledEmptyC = { sha: 'pv3', ts: 't1', project: projSettleDedupe, sessions: [], unattributed: ['c.js'], provisional: false };
      commits.recordCommit(projSettleDedupe, provC);
      commits.recordCommit(projSettleDedupe, settledEmptyC);
      assert.deepStrictEqual(commits.loadCommitMap(projSettleDedupe).find(r => r.sha === 'pv3'), settledEmptyC,
        'settled-empty must still beat provisional');

      // two provisional rows for the same sha (should not happen, but the
      // existing later-wins tie-break must still hold within the tier).
      const provD1 = { sha: 'pv4', ts: 't1', project: projSettleDedupe, sessions: [], unattributed: ['d.js'], provisional: true };
      const provD2 = { sha: 'pv4', ts: 't2', project: projSettleDedupe, sessions: [], unattributed: ['d.js', 'e.js'], provisional: true };
      commits.recordCommit(projSettleDedupe, provD1);
      commits.recordCommit(projSettleDedupe, provD2);
      assert.deepStrictEqual(commits.loadCommitMap(projSettleDedupe).find(r => r.sha === 'pv4'), provD2,
        'within the provisional tier, later append still wins');

      // Discriminating case: today's writers never produce a provisional row
      // with a REAL session list (the hook only ever writes provisional with
      // sessions:[]), but the precedence rule is defined to hold even then —
      // settled ALWAYS outranks provisional, even settled-EMPTY vs
      // provisional-REAL. (Under the old real-beats-empty-only rule, ignoring
      // the provisional flag, provisional-real would have incorrectly won.)
      const provRealE = { sha: 'pv5', ts: 't1', project: projSettleDedupe, sessions: [{ session: 'x', files: ['e.js'] }], unattributed: [], provisional: true };
      const settledEmptyE = { sha: 'pv5', ts: 't2', project: projSettleDedupe, sessions: [], unattributed: ['e.js'], provisional: false };
      commits.recordCommit(projSettleDedupe, provRealE);
      commits.recordCommit(projSettleDedupe, settledEmptyE);
      assert.deepStrictEqual(commits.loadCommitMap(projSettleDedupe).find(r => r.sha === 'pv5'), settledEmptyE,
        'settled-empty must beat provisional-real — settled always outranks provisional, not just real-vs-empty');

      const settledEmptyF = { sha: 'pv6', ts: 't1', project: projSettleDedupe, sessions: [], unattributed: ['f.js'], provisional: false };
      const provRealF = { sha: 'pv6', ts: 't2', project: projSettleDedupe, sessions: [{ session: 'x', files: ['f.js'] }], unattributed: [], provisional: true };
      commits.recordCommit(projSettleDedupe, settledEmptyF);
      commits.recordCommit(projSettleDedupe, provRealF);
      assert.deepStrictEqual(commits.loadCommitMap(projSettleDedupe).find(r => r.sha === 'pv6'), settledEmptyF,
        'reverse order: a later provisional-real must not overwrite an earlier settled-empty');
    });

    // Backfill through the real syncOnce over a real repo (git init prior
    // art: the auto-link and gitignore tests above). Events are planted a
    // minute in the past so they predate the commits made now.
    {
      const projCap = path.join(ROOT, 'projects', 'commit-cap-app');
      fs.mkdirSync(path.join(projCap, 'src'), { recursive: true });
      const gitCap = args => spawnSync('git',
        ['-C', projCap, '-c', 'user.email=t@t.t', '-c', 'user.name=T', ...args],
        { encoding: 'utf8' });
      gitCap(['init', '-q']);
      // Persist the local identity so the authorship gate (committer email ==
      // local user.email) recognises these commits as locally authored.
      gitCap(['config', 'user.email', 't@t.t']);
      gitCap(['config', 'user.name', 'T']);
      const past = ms => new Date(Date.now() - ms).toISOString();
      {
        const st = util.loadState();
        st.projects[projCap] = { events: [
          { ts: past(120000), source: 'Claude Code', kind: 'edit', file: path.join(projCap, 'src', 'one.js'), session: 'cap1' },
          { ts: past(60000), source: 'Codex', kind: 'edit', file: path.join(projCap, 'src', 'two.js'), session: 'cap2' },
        ] };
        util.saveState(st);
      }
      fs.writeFileSync(path.join(projCap, 'src', 'one.js'), 'one\n');
      gitCap(['add', '-A']);
      gitCap(['commit', '-q', '-m', 'c1']);
      const sha1 = gitCap(['rev-parse', 'HEAD']).stdout.trim();
      syncOnce({ project: projCap });

      // Round 3, commit 2: the WALK no longer attributes either — the same
      // stale-evidence audit bug the hook had survives verbatim in the walk
      // (daemon-off commits, rebases, non-hook repos are discovered here
      // against events that may not include the committing session's edits
      // yet). A walk-discovered LOCAL commit lands provisional and goes
      // through the same settle gates as a hook-recorded one.
      check('commits: syncOnce records a walk-discovered local commit PROVISIONALLY and advances the cursor', () => {
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        assert.strictEqual(map.length, 1, `expected 1 record, got ${JSON.stringify(map)}`);
        assert.strictEqual(map[0].sha, sha1);
        assert.ok(map[0].ts, 'record missing commit ts');
        assert.strictEqual(map[0].provisional, true,
          'the walk must not attribute from possibly-stale events — provisional, settle gates decide');
        assert.deepStrictEqual(map[0].sessions, []);
        assert.deepStrictEqual(map[0].unattributed, ['src/one.js']);
        assert.strictEqual(util.loadState().projects[projCap].lastCommitSha, sha1, 'cursor not advanced');
      });

      // cap1's own post-commit activity arrives — the same settle fast path
      // that serves hook-recorded rows now settles the walk-discovered one.
      {
        const st = util.loadState();
        st.projects[projCap].events.push(
          { ts: new Date(Date.now() + 5000).toISOString(), source: 'Claude Code', kind: 'prompt', text: 'cap1 continues', session: 'cap1' });
        util.saveState(st);
      }
      syncOnce({ project: projCap });
      check('commits: a walk-discovered commit settles attributed once its session\'s own events pass it', () => {
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        assert.strictEqual(map.length, 1, 'settle must dedupe, not grow the map');
        assert.notStrictEqual(map[0].provisional, true, 'must be settled now');
        assert.deepStrictEqual(map[0].sessions, [{ session: 'cap1', files: ['src/one.js'] }]);
        assert.deepStrictEqual(map[0].unattributed, []);
      });

      fs.writeFileSync(path.join(projCap, 'src', 'two.js'), 'two\n');
      gitCap(['add', '-A']);
      gitCap(['commit', '-q', '-m', 'c2']);
      const sha2 = gitCap(['rev-parse', 'HEAD']).stdout.trim();
      syncOnce({ project: projCap });
      syncOnce({ project: projCap }); // and once more with nothing new

      check('commits: a second sync appends only the new commit (provisional); a third adds nothing (idempotent)', () => {
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        assert.strictEqual(map.length, 2, `expected 2 records, got ${JSON.stringify(map.map(r => r.sha))}`);
        assert.strictEqual(map[0].sha, sha1, 'first record must be untouched');
        assert.strictEqual(map[1].sha, sha2);
        assert.strictEqual(map[1].provisional, true, 'walk-discovered c2 must land provisional too');
        assert.deepStrictEqual(map[1].sessions, []);
        assert.strictEqual(util.loadState().projects[projCap].lastCommitSha, sha2);
      });

      {
        const st = util.loadState();
        st.projects[projCap].events.push(
          { ts: new Date(Date.now() + 5000).toISOString(), source: 'Codex', kind: 'prompt', text: 'cap2 continues', session: 'cap2' });
        util.saveState(st);
      }
      syncOnce({ project: projCap });
      check('commits: walk-discovered c2 settles to cap2; MemBridge\'s own swept-in files stay unattributed', () => {
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        assert.strictEqual(map.length, 2);
        const rec = map.find(r => r.sha === sha2);
        assert.notStrictEqual(rec.provisional, true);
        assert.deepStrictEqual(rec.sessions, [{ session: 'cap2', files: ['src/two.js'] }]);
        // c2's `git add -A` also swept .membridge/* (no .gitignore in this
        // fixture) — those stay unattributed; two.js must not be among them.
        assert.ok(!rec.unattributed.includes('src/two.js'), `two.js must be attributed, got ${JSON.stringify(rec.unattributed)}`);
      });

      check('commits: a non-repo project leaves sync green with zero commit rows', () => {
        syncOnce(); // full pass over every tracked project, incl. non-repos
        assert.ok(!fs.existsSync(path.join(proj1, '.membridge', 'commits.jsonl')),
          'a project without a git repo must get no commit map');
      });

      // --- Phase 2 Task 4: instant capture via the git post-commit hook ----
      {
        const st = util.loadState();
        st.projects[projCap].events.push(
          { ts: past(30000), source: 'Claude Code', kind: 'edit', file: path.join(projCap, 'src', 'three.js'), session: 'cap3' });
        util.saveState(st);
      }
      fs.writeFileSync(path.join(projCap, 'src', 'three.js'), 'three\n');
      gitCap(['add', '-A']);
      gitCap(['commit', '-q', '-m', 'c3']);
      const sha3 = gitCap(['rev-parse', 'HEAD']).stdout.trim();
      const hookEnv = { ...process.env };
      const hook1 = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projCap, env: hookEnv, encoding: 'utf8' });
      const hook2 = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projCap, env: hookEnv, encoding: 'utf8' });

      // --- Provenance reconciliation (fix/provenance-reconciliation) -------
      // Test 1 (brief's list): the hook writes a PROVISIONAL, unattributed
      // row — it must never call attributeCommit itself anymore, because
      // state.json at commit time is exactly the stale data that used to
      // cause mis-attribution (see the dedicated core-scenario test below).
      check('commits: `membridge hook post-commit` records HEAD once, PROVISIONALLY — second run is a no-op', () => {
        assert.strictEqual(hook1.status, 0, `exit ${hook1.status}, stderr: ${hook1.stderr}`);
        assert.strictEqual(hook1.stdout, '', 'a git hook must be silent');
        assert.strictEqual(hook2.status, 0);
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        assert.strictEqual(map.length, 3, `expected 3 records, got ${JSON.stringify(map.map(r => r.sha))}`);
        assert.strictEqual(map[2].sha, sha3);
        assert.strictEqual(map[2].provisional, true, 'a fresh local-committer commit must be recorded provisional, not attributed');
        assert.deepStrictEqual(map[2].sessions, [], 'the hook must not attribute — that is now the daemon settle step\'s job');
        // `git add -A` on this fixture also sweeps in .membridge/* (no
        // .gitignore is installed here), so c3's diff is src/three.js plus
        // MemBridge's own housekeeping files — only assert what matters.
        assert.ok(map[2].unattributed.includes('src/three.js'), `expected src/three.js in ${JSON.stringify(map[2].unattributed)}`);
      });

      check('commits: daemon sync after the hook adds no duplicate row and advances the cursor, but leaves it provisional (no newer events yet)', () => {
        syncOnce({ project: projCap });
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        assert.strictEqual(map.length, 3, 'sync duplicated a hook-recorded commit');
        assert.strictEqual(util.loadState().projects[projCap].lastCommitSha, sha3, 'cursor must advance over hook-recorded shas');
        const rec = map.find(r => r.sha === sha3);
        assert.strictEqual(rec.provisional, true,
          'no event exists AFTER the commit yet, so the daemon has not necessarily caught up — must stay provisional, not force-settle');
      });

      // Settle happy path: once the CREDITED session's OWN events include
      // activity after the commit (a session's file is read sequentially by
      // offset, so its newer scanned event proves its older edits were
      // scanned), the next pass settles the attribution. The pushed event is
      // deliberately cap3's own — an UNRELATED session's newer event must
      // NOT trigger settling (see the cross-session race block below).
      {
        const st = util.loadState();
        st.projects[projCap].events.push(
          { ts: new Date(Date.now() + 5000).toISOString(), source: 'Claude Code', kind: 'edit', file: path.join(projCap, 'src', 'four.js'), session: 'cap3' });
        util.saveState(st);
      }
      syncOnce({ project: projCap });
      check('commits: settle pass attributes a provisional row once the credited session\'s own events pass the commit', () => {
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projCap);
        const rec = map.find(r => r.sha === sha3);
        assert.ok(rec, 'settled row missing');
        assert.notStrictEqual(rec.provisional, true, 'row must be settled after the daemon catches up');
        assert.deepStrictEqual(rec.sessions, [{ session: 'cap3', files: ['src/three.js'] }]);
        assert.ok(!rec.unattributed.includes('src/three.js'), 'src/three.js must now be attributed, not unattributed');
      });

      check('commits: hook outside a tracked project exits 0, silent, records nothing', () => {
        const stray = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-stray-'));
        spawnSync('git', ['-C', stray, 'init', '-q'], { encoding: 'utf8' });
        const out = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: stray, env: hookEnv, encoding: 'utf8' });
        assert.strictEqual(out.status, 0, `exit ${out.status}, stderr: ${out.stderr}`);
        assert.strictEqual(out.stdout, '', 'must be silent outside a tracked project');
        assert.ok(!fs.existsSync(path.join(stray, '.membridge')), 'stray repo must get no .membridge');
      });

      // Install/remove, mirroring the Stop-hook safety: fresh settings file,
      // one repo with a pre-existing user hook (projCap), one bare tracked
      // repo (projHook) that gets a fresh membridge-only hook file.
      const projHook = path.join(ROOT, 'projects', 'hook-app');
      fs.mkdirSync(projHook, { recursive: true });
      spawnSync('git', ['-C', projHook, 'init', '-q'], { encoding: 'utf8' });
      {
        const st = util.loadState();
        st.projects[projHook] = { events: [] };
        util.saveState(st);
      }
      const userHook = '#!/bin/sh\necho user-post-commit\n';
      fs.mkdirSync(path.join(projCap, '.git', 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(projCap, '.git', 'hooks', 'post-commit'), userHook);
      const pcSettings = path.join(ROOT, 'claude-settings-pc.json');
      const envPc = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: pcSettings };
      const pcSetup1 = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: envPc, encoding: 'utf8' });
      const pcSetup2 = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: envPc, encoding: 'utf8' });

      check('commits: setup-hooks installs an executable post-commit hook with the absolute command', () => {
        assert.strictEqual(pcSetup1.status, 0, pcSetup1.stderr);
        const f = path.join(projHook, '.git', 'hooks', 'post-commit');
        assert.ok(fs.existsSync(f), 'post-commit hook not written to a tracked repo');
        const body = read(f);
        assert.ok(body.startsWith('#!/bin/sh'), 'fresh hook file needs a shebang');
        assert.ok(body.includes('membridge-hook.js') && body.includes('post-commit'), `hook body: ${body}`);
        assert.ok(body.includes(`"${process.execPath}"`), 'command must be absolute (quoted runtime binary)');
        if (process.platform !== 'win32') {
          assert.ok(fs.statSync(f).mode & 0o111, 'hook file not executable');
        }
      });

      check('commits: setup-hooks preserves an existing user post-commit byte-for-byte and never duplicates', () => {
        assert.strictEqual(pcSetup2.status, 0, pcSetup2.stderr);
        const body = read(path.join(projCap, '.git', 'hooks', 'post-commit'));
        assert.ok(body.startsWith(userHook), 'user hook bytes changed');
        assert.strictEqual(count(body, 'membridge-hook.js'), 1, 'membridge line missing or duplicated across two setup runs');
      });

      const pcRemove = spawnSync(process.execPath, [BIN, 'remove-hooks'], { env: envPc, encoding: 'utf8' });
      check('commits: remove-hooks strips only the membridge line; a membridge-only hook file is deleted', () => {
        assert.strictEqual(pcRemove.status, 0, pcRemove.stderr);
        assert.ok(/post-commit/.test(pcRemove.stdout), `remove-hooks must report the post-commit cleanup, said: ${pcRemove.stdout}`);
        assert.strictEqual(read(path.join(projCap, '.git', 'hooks', 'post-commit')), userHook,
          'user hook must be restored byte-for-byte');
        assert.ok(!fs.existsSync(path.join(projHook, '.git', 'hooks', 'post-commit')),
          'a hook file that was only ours must be deleted');
      });

      // A user hook whose OWN line mentions membridge (their script calling
      // the CLI) is theirs: install must append, never replace it; remove
      // must leave it untouched. Only lines invoking our shim are ours.
      const userMb = '#!/bin/sh\nmembridge sync --project . &\n';
      fs.writeFileSync(path.join(projHook, '.git', 'hooks', 'post-commit'), userMb);
      const mbSetup = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: envPc, encoding: 'utf8' });
      check('commits: a user hook line that merely mentions membridge is appended-to, never replaced', () => {
        assert.strictEqual(mbSetup.status, 0, mbSetup.stderr);
        const body = read(path.join(projHook, '.git', 'hooks', 'post-commit'));
        assert.ok(body.startsWith(userMb), `user's membridge-mentioning line was replaced; body: ${body}`);
        assert.ok(body.includes('membridge-hook.js'), 'our line must still be appended');
      });
      const mbRemove = spawnSync(process.execPath, [BIN, 'remove-hooks'], { env: envPc, encoding: 'utf8' });
      check('commits: remove-hooks leaves a user line that merely mentions membridge intact', () => {
        assert.strictEqual(mbRemove.status, 0, mbRemove.stderr);
        assert.strictEqual(read(path.join(projHook, '.git', 'hooks', 'post-commit')), userMb,
          'the user-owned membridge-mentioning line must survive removal');
      });

      // One unwritable hooks dir must not abort the whole install for every
      // other repo (or block the Stop-hook settings write).
      const projRo = path.join(ROOT, 'projects', 'ro-hook-app');
      fs.mkdirSync(projRo, { recursive: true });
      spawnSync('git', ['-C', projRo, 'init', '-q'], { encoding: 'utf8' });
      {
        const st = util.loadState();
        st.projects[projRo] = { events: [] };
        util.saveState(st);
      }
      fs.chmodSync(path.join(projRo, '.git', 'hooks'), 0o555);
      const roSetup = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: envPc, encoding: 'utf8' });
      fs.chmodSync(path.join(projRo, '.git', 'hooks'), 0o755);
      check('commits: one unwritable hooks dir does not abort setup-hooks for the other repos', () => {
        assert.strictEqual(roSetup.status, 0, `setup-hooks aborted: ${roSetup.stderr}`);
        assert.ok(read(path.join(projHook, '.git', 'hooks', 'post-commit')).includes('membridge-hook.js'),
          'healthy repos must still get their hook');
        const settings = JSON.parse(read(pcSettings));
        assert.ok((settings.hooks.Stop || []).length >= 1, 'the Stop hook settings write must still happen');
      });

      // A big backlog behind a VALID cursor drains in bounded per-pass slices
      // (the first-run 50 cap alone does not cover this path), converging
      // over passes instead of stalling one sync on hundreds of git calls.
      const projMany = path.join(ROOT, 'projects', 'many-commits-app');
      fs.mkdirSync(projMany, { recursive: true });
      spawnSync('sh', ['-c',
        `cd "${projMany}" && git init -q && git config user.email t@t.t && git config user.name T && git -c user.email=t@t.t -c user.name=T commit -q --allow-empty -m c0`],
        { encoding: 'utf8' });
      {
        const st = util.loadState();
        st.projects[projMany] = { events: [] };
        util.saveState(st);
      }
      syncOnce({ project: projMany }); // cursor now at c0
      spawnSync('sh', ['-c',
        `cd "${projMany}" && for i in $(seq 1 54); do git -c user.email=t@t.t -c user.name=T commit -q --allow-empty -m c$i; done`],
        { encoding: 'utf8' });
      syncOnce({ project: projMany });
      check('commits: a valid-cursor backlog is capped per pass and converges over passes', () => {
        const commitsMod = require('../lib/commits');
        assert.strictEqual(commitsMod.loadCommitMap(projMany).length, 51,
          'second pass must record at most 50 new commits (1 + 50)');
        syncOnce({ project: projMany });
        assert.strictEqual(commitsMod.loadCommitMap(projMany).length, 55, 'third pass must drain the rest');
        const head = spawnSync('git', ['-C', projMany, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
        assert.strictEqual(util.loadState().projects[projMany].lastCommitSha, head, 'cursor must converge to HEAD');
      });

      // Test 4 (brief's list): a commit with no matching (or no newer) events
      // must stay provisional, not be force-settled to empty — recording a
      // blind empty row here would be indistinguishable from "the daemon
      // hasn't caught up yet". It settles once a newer event exists.
      spawnSync('sh', ['-c',
        `cd "${projMany}" && echo x > later.js && git add later.js && git -c user.email=t@t.t -c user.name=T commit -q -m c55`],
        { encoding: 'utf8' });
      const provRun = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projMany, env: hookEnv, encoding: 'utf8' });
      check('commits: the hook records an unattributable-so-far commit PROVISIONALLY, never a frozen blind row', () => {
        assert.strictEqual(provRun.status, 0, provRun.stderr);
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projMany);
        assert.strictEqual(map.length, 56, 'the hook must record a provisional row for a new local commit');
        assert.strictEqual(map[55].provisional, true);
        assert.deepStrictEqual(map[55].sessions, []);
      });

      check('commits: a settle pass with NO newer events leaves the commit provisional (not force-settled empty)', () => {
        syncOnce({ project: projMany }); // projMany has zero events, ever — nothing is "newer" than the commit
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projMany);
        assert.strictEqual(map.length, 56, 'no duplicate row from the settle pass');
        assert.strictEqual(map[55].provisional, true,
          'with no events at all, the daemon cannot know it has caught up — must not guess "unattributed"');
      });

      // Grace window (validator regression, test b): when attributeCommit
      // credits NOBODY, a newer event from an UNRELATED session is NOT proof
      // the committing session's edits were scanned — cross-file discovery
      // order is not ts-ordered, so the real author's edit may still be
      // sitting unscanned in its own session file. Settling unattributed
      // therefore waits out a grace window (SETTLE_GRACE_MS past the commit
      // ts, measured in DATA timestamps, no wall clock) that bounds the
      // cross-file scan race; only past it does "nobody" become the settled
      // answer.
      check('commits: within the grace window, an unrelated session\'s newer event must NOT settle the commit unattributed', () => {
        const st = util.loadState();
        st.projects[projMany] = st.projects[projMany] || { events: [] };
        st.projects[projMany].events = [
          ...(st.projects[projMany].events || []),
          { ts: new Date(Date.now() + 5000).toISOString(), source: 'Claude Code', kind: 'edit', file: path.join(projMany, 'unrelated.js'), session: 'later-session' },
        ];
        util.saveState(st);
        syncOnce({ project: projMany });
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projMany);
        assert.strictEqual(map.length, 56, 'settling must never grow the deduped view');
        assert.strictEqual(map[55].provisional, true,
          'an unrelated session newer by seconds is NOT proof the author\'s edits were scanned — must stay provisional inside the grace window');
      });

      check('commits: beyond the grace window with still no candidate session, the commit settles unattributed (not stuck forever)', () => {
        const scanMod = require('../lib/scan');
        assert.ok(Number.isFinite(scanMod.SETTLE_GRACE_MS), 'SETTLE_GRACE_MS missing from lib/scan.js');
        const st = util.loadState();
        st.projects[projMany].events.push(
          { ts: new Date(Date.now() + scanMod.SETTLE_GRACE_MS + 60000).toISOString(), source: 'Claude Code', kind: 'prompt', text: 'much later', session: 'later-session' });
        util.saveState(st);
        syncOnce({ project: projMany });
        const commitsMod = require('../lib/commits');
        const map = commitsMod.loadCommitMap(projMany);
        assert.strictEqual(map.length, 56, 'settling must never grow the deduped view');
        assert.notStrictEqual(map[55].provisional, true, 'past the grace window, no-candidate must settle unattributed');
        assert.deepStrictEqual(map[55].sessions, []);
        assert.deepStrictEqual(map[55].unattributed, ['later.js'], 'settled row carries the real attribution result');
      });
    }
  }

  // --- Provenance reconciliation, Test 2 (brief's list) — THE core scenario:
  // stale state that WOULD have mis-attributed under the old hook. Session A
  // has an OLD edit to shared.js already in state.json when the commit
  // lands. Session B is the session that ACTUALLY made the commit's edit to
  // shared.js — but B's edit event has NOT been scanned into state.json yet
  // at commit time (exactly the daemon-hasn't-caught-up-yet window the audit
  // describes). Under the OLD hook, attributeCommit would run against
  // state.json as it stood at commit time — which only has A's edit — and
  // credit A. The new hook must not attribute at all (provisional, sessions
  // empty); only once B's edit is scanned in (plus a later event proving the
  // daemon has caught up) does the settle pass attribute the commit, and it
  // must attribute to B, never A.
  {
    const projCore = path.join(ROOT, 'projects', 'core-scenario-app');
    fs.mkdirSync(path.join(projCore, 'src'), { recursive: true });
    const gc = args => spawnSync('git', ['-C', projCore, '-c', 'user.email=core@local.dev', '-c', 'user.name=Core', ...args], { encoding: 'utf8' });
    gc(['init', '-q']);
    gc(['config', 'user.email', 'core@local.dev']);
    gc(['config', 'user.name', 'Core']);
    const past = ms => new Date(Date.now() - ms).toISOString();
    // Session A's stale edit is the ONLY thing in state.json at commit time —
    // this is the data the OLD hook would have (mis)attributed from.
    {
      const st = util.loadState();
      st.projects[projCore] = { events: [
        { ts: past(600000), source: 'Claude Code', kind: 'edit', file: path.join(projCore, 'src', 'shared.js'), session: 'sessionA' },
      ] };
      util.saveState(st);
    }
    // Session B makes the REAL edit that produces the commit — its event is
    // deliberately NOT in state yet (not scanned this tick).
    fs.writeFileSync(path.join(projCore, 'src', 'shared.js'), 'export const shared = () => "B";\n');
    gc(['add', '-A']);
    gc(['commit', '-q', '-m', 'B commits']);
    const coreSha = gc(['rev-parse', 'HEAD']).stdout.trim();

    const coreHookEnv = { ...process.env };
    const coreHook = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projCore, env: coreHookEnv, encoding: 'utf8' });
    check('provenance reconciliation: the hook does NOT credit stale session A at commit time — provisional, unattributed', () => {
      assert.strictEqual(coreHook.status, 0, coreHook.stderr);
      const map = require('../lib/commits').loadCommitMap(projCore);
      const rec = map.find(r => r.sha === coreSha);
      assert.ok(rec, 'commit not recorded');
      assert.strictEqual(rec.provisional, true);
      assert.deepStrictEqual(rec.sessions, [], 'the OLD hook would have credited sessionA here — the new hook must credit nobody yet');
    });

    // Now the daemon catches up: B's edit is scanned in (timestamped just
    // before the commit, exactly like a real edit-then-commit), plus a
    // trailing event proving the daemon has scanned PAST the commit's ts.
    {
      const st = util.loadState();
      st.projects[projCore].events.push(
        { ts: past(2000), source: 'Claude Code', kind: 'edit', file: path.join(projCore, 'src', 'shared.js'), session: 'sessionB' },
        { ts: new Date(Date.now() + 5000).toISOString(), source: 'Claude Code', kind: 'prompt', text: 'next prompt', session: 'sessionB' },
      );
      util.saveState(st);
    }
    syncOnce({ project: projCore });
    check('provenance reconciliation: the settle pass attributes the commit to the ACTUAL session B, never stale session A', () => {
      const map = require('../lib/commits').loadCommitMap(projCore);
      const rec = map.find(r => r.sha === coreSha);
      assert.ok(rec, 'settled commit missing');
      assert.notStrictEqual(rec.provisional, true, 'must be settled by now');
      assert.deepStrictEqual(rec.sessions, [{ session: 'sessionB', files: ['src/shared.js'] }],
        'the commit must be credited to sessionB (the real author), not sessionA (the stale one)');
      assert.deepStrictEqual(rec.unattributed, []);
    });
  }

  // --- Cross-session premature-settle race (validator regression, test a) --
  // The settle gate must be PER-CREDITED-SESSION, not global: an UNRELATED
  // session C's newer scanned event says nothing about whether the true
  // author B's edit was scanned — event discovery across different session
  // files is not ts-ordered (only WITHIN one session's file does sequential
  // offset reading guarantee order). A global newest-event-ts gate would fire
  // on C's event and settle the commit to stale session A while B's edit is
  // still unscanned — permanently, since settled rows are never reprocessed.
  {
    const projX = path.join(ROOT, 'projects', 'cross-session-app');
    fs.mkdirSync(path.join(projX, 'src'), { recursive: true });
    const gx = args => spawnSync('git', ['-C', projX, '-c', 'user.email=x@local.dev', '-c', 'user.name=X', ...args], { encoding: 'utf8' });
    gx(['init', '-q']);
    gx(['config', 'user.email', 'x@local.dev']);
    gx(['config', 'user.name', 'X']);
    const past = ms => new Date(Date.now() - ms).toISOString();
    const future = ms => new Date(Date.now() + ms).toISOString();
    // Session A's STALE edit to shared.js is scanned; that is ALL state
    // holds at commit time.
    {
      const st = util.loadState();
      st.projects[projX] = { events: [
        { ts: past(600000), source: 'Claude Code', kind: 'edit', file: path.join(projX, 'src', 'shared.js'), session: 'sessionA' },
      ] };
      util.saveState(st);
    }
    // Session B makes the real edit and commits.
    fs.writeFileSync(path.join(projX, 'src', 'shared.js'), 'export const shared = () => "B";\n');
    gx(['add', '-A']);
    gx(['commit', '-q', '-m', 'B commits']);
    const xSha = gx(['rev-parse', 'HEAD']).stdout.trim();
    const xHook = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projX, env: { ...process.env }, encoding: 'utf8' });
    // An UNRELATED session C's event NEWER than the commit is scanned
    // (within the grace window); B's edit is still unscanned — the exact
    // cross-file race the validator reproduced.
    {
      const st = util.loadState();
      st.projects[projX].events.push(
        { ts: future(5000), source: 'Codex', kind: 'prompt', text: 'unrelated work', session: 'sessionC' });
      util.saveState(st);
    }
    syncOnce({ project: projX });
    check('cross-session race: an unrelated session\'s newer event must NOT settle the commit to stale session A', () => {
      assert.strictEqual(xHook.status, 0, xHook.stderr);
      const rec = require('../lib/commits').loadCommitMap(projX).find(r => r.sha === xSha);
      assert.ok(rec, 'commit not recorded');
      assert.strictEqual(rec.provisional, true,
        `must stay provisional: the only credited candidate (stale sessionA) has no post-commit events of its own, so B's real edit may still be unscanned — got ${JSON.stringify(rec)}`);
      assert.deepStrictEqual(rec.sessions, [], 'stale sessionA must never be credited');
    });
    // Now B's real edit — and B's own post-commit activity, proving B's file
    // was read past the commit — is scanned in.
    {
      const st = util.loadState();
      st.projects[projX].events.push(
        { ts: past(2000), source: 'Claude Code', kind: 'edit', file: path.join(projX, 'src', 'shared.js'), session: 'sessionB' },
        { ts: future(6000), source: 'Claude Code', kind: 'prompt', text: 'B continues', session: 'sessionB' });
      util.saveState(st);
    }
    syncOnce({ project: projX });
    check('cross-session race: once the true author\'s own events pass the commit, it settles to B — never A', () => {
      const rec = require('../lib/commits').loadCommitMap(projX).find(r => r.sha === xSha);
      assert.ok(rec, 'row missing');
      assert.notStrictEqual(rec.provisional, true, 'must be settled once B\'s own events pass the commit');
      assert.deepStrictEqual(rec.sessions, [{ session: 'sessionB', files: ['src/shared.js'] }],
        'the settled row must credit sessionB, the true author');
      assert.deepStrictEqual(rec.unattributed, []);
    });
  }

  // --- Attributed-gate starvation (panel regression, round 3) --------------
  // Commit-as-last-act: the session's edit is scanned, the commit lands, and
  // the chat ENDS — the session never produces a post-commit event, so the
  // strict per-credited-session gate can never fire. Without a bounded
  // escape, the row stays provisional forever (why: "pending" indefinitely,
  // churn excludes it) and — worse — once the events cap evicts the
  // session's edit, attributeCommit credits nobody and the no-candidate
  // grace settles the row PERMANENTLY unattributed, destroying provenance
  // the daemon had already scanned. The escape: once the GLOBAL newest
  // scanned event is past commit + SETTLE_GRACE_MS, settle WITH the current
  // attribution — grace (minutes of data time) vastly precedes cap eviction
  // (hundreds of events).
  {
    const projLA = path.join(ROOT, 'projects', 'last-act-app');
    fs.mkdirSync(path.join(projLA, 'src'), { recursive: true });
    const gla = args => spawnSync('git', ['-C', projLA, '-c', 'user.email=la@local.dev', '-c', 'user.name=LA', ...args], { encoding: 'utf8' });
    gla(['init', '-q']);
    gla(['config', 'user.email', 'la@local.dev']);
    gla(['config', 'user.name', 'LA']);
    // The session's edit IS scanned before the commit — evidence is complete.
    {
      const st = util.loadState();
      st.projects[projLA] = { events: [
        { ts: new Date(Date.now() - 2000).toISOString(), source: 'Claude Code', kind: 'edit', file: path.join(projLA, 'src', 'only.js'), session: 'lastS' },
      ] };
      util.saveState(st);
    }
    fs.writeFileSync(path.join(projLA, 'src', 'only.js'), 'export const only = 1;\n');
    gla(['add', '-A']);
    gla(['commit', '-q', '-m', 'last act of the session']);
    const laSha = gla(['rev-parse', 'HEAD']).stdout.trim();
    const laHook = spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projLA, env: { ...process.env }, encoding: 'utf8' });
    // The session ends here: NO post-commit lastS event, ever. Other,
    // unrelated activity moves data time past the grace window.
    {
      const scanMod = require('../lib/scan');
      const st = util.loadState();
      st.projects[projLA].events.push(
        { ts: new Date(Date.now() + scanMod.SETTLE_GRACE_MS + 60000).toISOString(), source: 'Codex', kind: 'prompt', text: 'unrelated later work', session: 'otherU' });
      util.saveState(st);
    }
    syncOnce({ project: projLA });
    check('last-act: a credited session with no post-commit events settles ATTRIBUTED once data time passes the grace window', () => {
      assert.strictEqual(laHook.status, 0, laHook.stderr);
      const rec = require('../lib/commits').loadCommitMap(projLA).find(r => r.sha === laSha);
      assert.ok(rec, 'commit not recorded');
      assert.notStrictEqual(rec.provisional, true,
        'must not stay provisional forever — the session\'s last act was the commit, so its own post-commit event will never come');
      assert.deepStrictEqual(rec.sessions, [{ session: 'lastS', files: ['src/only.js'] }],
        'must settle WITH the scanned attribution, to lastS');
      assert.deepStrictEqual(rec.unattributed, []);
    });

    check('last-act: eviction of the credited session\'s events can no longer flip the row to unattributed', () => {
      // Simulate the events-cap eviction that, under the starved gate, used
      // to destroy the attribution: drop every lastS event, then settle
      // again. The row settled ATTRIBUTED before eviction could happen, and
      // settled rows are final — the attribution must survive.
      const st = util.loadState();
      st.projects[projLA].events = st.projects[projLA].events.filter(e => e.session !== 'lastS');
      util.saveState(st);
      syncOnce({ project: projLA });
      const rec = require('../lib/commits').loadCommitMap(projLA).find(r => r.sha === laSha);
      assert.ok(rec, 'row missing');
      assert.deepStrictEqual(rec.sessions, [{ session: 'lastS', files: ['src/only.js'] }],
        'the settled attribution must survive eviction — never be replaced by a settled-unattributed row');
      assert.notStrictEqual(rec.provisional, true);
    });
  }

  // --- Corrupt-future-timestamp clamp (panel hardening, round 3) -----------
  // One garbage event ts far in the future would otherwise satisfy every
  // data-time grace comparison instantly, voiding the window's protection
  // (premature unattributed — or, with the escape above, premature
  // attributed — settling). Events absurdly past the pending commits' own
  // ts must be ignored by the settle gates.
  {
    const projCl = path.join(ROOT, 'projects', 'clamp-app');
    fs.mkdirSync(projCl, { recursive: true });
    const gcl = args => spawnSync('git', ['-C', projCl, '-c', 'user.email=cl@local.dev', '-c', 'user.name=CL', ...args], { encoding: 'utf8' });
    gcl(['init', '-q']);
    gcl(['config', 'user.email', 'cl@local.dev']);
    gcl(['config', 'user.name', 'CL']);
    {
      const st = util.loadState();
      st.projects[projCl] = { events: [
        // Corrupt: decades in the future. Must not count as "caught up".
        { ts: '2099-01-01T00:00:00.000Z', source: 'Codex', kind: 'prompt', text: 'corrupt clock', session: 'corruptS' },
      ] };
      util.saveState(st);
    }
    fs.writeFileSync(path.join(projCl, 'solo.js'), 'solo\n');
    gcl(['add', 'solo.js']);
    gcl(['commit', '-q', '-m', 'nobody\'s commit']);
    const clSha = gcl(['rev-parse', 'HEAD']).stdout.trim();
    spawnSync(process.execPath, [BIN, 'hook', 'post-commit'], { cwd: projCl, env: { ...process.env }, encoding: 'utf8' });
    check('clamp: one corrupt far-future event ts must not void the grace window and settle the commit prematurely', () => {
      syncOnce({ project: projCl });
      const commitsMod = require('../lib/commits');
      let rec = commitsMod.loadCommitMap(projCl).find(r => r.sha === clSha);
      assert.ok(rec, 'commit not recorded');
      assert.strictEqual(rec.provisional, true,
        'a 2099 timestamp is corruption, not proof the daemon caught up — must stay provisional');
      // Sane data time really passing the grace window still settles.
      const scanMod = require('../lib/scan');
      const st = util.loadState();
      st.projects[projCl].events.push(
        { ts: new Date(Date.now() + scanMod.SETTLE_GRACE_MS + 60000).toISOString(), source: 'Codex', kind: 'prompt', text: 'legit later work', session: 'otherV' });
      util.saveState(st);
      syncOnce({ project: projCl });
      rec = commitsMod.loadCommitMap(projCl).find(r => r.sha === clSha);
      assert.notStrictEqual(rec.provisional, true, 'legitimate post-grace data time must still settle');
      assert.deepStrictEqual(rec.sessions, []);
      assert.deepStrictEqual(rec.unattributed, ['solo.js']);
    });
  }

  // --- Weekend gap (validator/attacker regression, round 4) ----------------
  // The sanity clamp must be anchored to the WALL CLOCK, not to the newest
  // pending commit: a Friday-evening last-act commit followed by a legit
  // >24h quiet gap must not turn Monday's real events into "corrupt future"
  // timestamps — that froze settling (and stretched the eviction window)
  // until the NEXT local commit happened to move the old anchor. Corruption
  // is an event claiming to be from the machine's own future, nothing else.
  {
    const HOUR = 3600 * 1000;
    const T0 = Date.now() - 63 * HOUR; // Friday evening, ~2.6 days ago
    const projWk = path.join(ROOT, 'projects', 'weekend-gap-app');
    fs.mkdirSync(path.join(projWk, 'src'), { recursive: true });
    const gwk = (args, env) => spawnSync('git', ['-C', projWk, ...args],
      { encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
    gwk(['init', '-q']);
    gwk(['config', 'user.email', 'wk@local.dev']);
    gwk(['config', 'user.name', 'WK']);
    // The author's edit is scanned, then the commit lands Friday evening as
    // the session's last act.
    {
      const st = util.loadState();
      st.projects[projWk] = { events: [
        { ts: new Date(T0 - 60000).toISOString(), source: 'Claude Code', kind: 'edit', file: path.join(projWk, 'src', 'only.js'), session: 'authorS' },
      ] };
      util.saveState(st);
    }
    fs.writeFileSync(path.join(projWk, 'src', 'only.js'), 'friday work\n');
    gwk(['add', '-A']);
    gwk(['commit', '-q', '-m', 'friday last act'],
      { GIT_AUTHOR_DATE: new Date(T0).toISOString(), GIT_COMMITTER_DATE: new Date(T0).toISOString() });
    const wkSha = gwk(['rev-parse', 'HEAD']).stdout.trim();
    syncOnce({ project: projWk }); // walk records provisional; nothing newer than the commit yet
    // Monday: the author's own session resumes (>24h after the commit) plus
    // fresh unrelated activity — all with correct clocks, all in the PAST.
    {
      const st = util.loadState();
      st.projects[projWk].events.push(
        { ts: new Date(Date.now() - 2 * HOUR).toISOString(), source: 'Claude Code', kind: 'prompt', text: 'resume Monday', session: 'authorS' },
        { ts: new Date(Date.now() - 60000).toISOString(), source: 'Codex', kind: 'prompt', text: 'other work', session: 'otherS' });
      util.saveState(st);
    }
    syncOnce({ project: projWk });
    check('weekend gap: a legit >24h quiet gap must not freeze settling — the resumed session settles the row attributed, no next commit needed', () => {
      const rec = require('../lib/commits').loadCommitMap(projWk).find(r => r.sha === wkSha);
      assert.ok(rec, 'commit not recorded');
      assert.notStrictEqual(rec.provisional, true,
        'Monday events are real, past-tense data — the clamp must not discard them just because the last pending commit was Friday');
      assert.deepStrictEqual(rec.sessions, [{ session: 'authorS', files: ['src/only.js'] }],
        'the author\'s own resumed event satisfies the per-session fast path');
    });
  }

  // --- Phase 3 Task 1: authorship gate end-to-end over a real repo ---------
  // A commit whose committer is the local identity is attributed; a commit
  // pulled from a teammate (foreign committer) is recorded unattributed-locally
  // and NEVER falsely credited; a repo with no local user.email fails closed.
  {
    const projGate = path.join(ROOT, 'projects', 'authorship-gate-app');
    fs.mkdirSync(path.join(projGate, 'src'), { recursive: true });
    const rawGit = args => spawnSync('git', ['-C', projGate, ...args], { encoding: 'utf8' });
    rawGit(['init', '-q']);
    rawGit(['config', 'user.email', 'me@local.dev']);
    rawGit(['config', 'user.name', 'Me']);
    const past = ms => new Date(Date.now() - ms).toISOString();
    {
      const st = util.loadState();
      st.projects[projGate] = { events: [
        { ts: past(120000), source: 'Claude Code', kind: 'edit', file: path.join(projGate, 'src', 'mine.js'), session: 'gLocal' },
        { ts: past(120000), source: 'Claude Code', kind: 'edit', file: path.join(projGate, 'src', 'pulled.js'), session: 'gForeign' },
      ] };
      util.saveState(st);
    }
    // A local commit (committer == me@local.dev).
    fs.writeFileSync(path.join(projGate, 'src', 'mine.js'), 'mine\n');
    rawGit(['add', '-A']);
    rawGit(['commit', '-q', '-m', 'local edit']);
    const shaLocal = rawGit(['rev-parse', 'HEAD']).stdout.trim();
    // A commit whose committer is a teammate (as after a `git pull`).
    fs.writeFileSync(path.join(projGate, 'src', 'pulled.js'), 'pulled\n');
    rawGit(['add', '-A']);
    spawnSync('git', ['-C', projGate, '-c', 'user.email=teammate@remote.dev', '-c', 'user.name=Teammate',
      'commit', '-q', '-m', 'teammate edit'], { encoding: 'utf8' });
    const shaForeign = rawGit(['rev-parse', 'HEAD']).stdout.trim();
    syncOnce({ project: projGate });

    check('gate: a walk-discovered local-committer commit lands provisional (attribution deferred to the settle gates)', () => {
      const map = require('../lib/commits').loadCommitMap(projGate);
      const rec = map.find(r => r.sha === shaLocal);
      assert.ok(rec, 'local commit not recorded');
      assert.strictEqual(rec.provisional, true, 'the walk must not attribute from possibly-stale events');
      assert.deepStrictEqual(rec.sessions, []);
    });

    check('gate: a foreign-committer (pulled) commit is recorded settled-unattributed, never credited, never provisional', () => {
      const map = require('../lib/commits').loadCommitMap(projGate);
      const rec = map.find(r => r.sha === shaForeign);
      assert.ok(rec, 'foreign commit not recorded');
      assert.deepStrictEqual(rec.sessions, [], 'a foreign committer must never be credited to a local session');
      assert.deepStrictEqual(rec.unattributed, ['src/pulled.js'], 'its files are unattributed-locally');
      assert.notStrictEqual(rec.provisional, true,
        'a foreign commit must be settled at discovery — provisional would leave a path to attributing it later');
    });

    // The local commit settles attributed once gLocal's own events pass it —
    // the walk feeds the same gates as the hook.
    {
      const st = util.loadState();
      st.projects[projGate].events.push(
        { ts: new Date(Date.now() + 5000).toISOString(), source: 'Claude Code', kind: 'prompt', text: 'g continues', session: 'gLocal' });
      util.saveState(st);
    }
    syncOnce({ project: projGate });
    check('gate: the walk-discovered local commit settles attributed to its session; the foreign row is untouched', () => {
      const map = require('../lib/commits').loadCommitMap(projGate);
      const rec = map.find(r => r.sha === shaLocal);
      assert.notStrictEqual(rec.provisional, true, 'must be settled now');
      assert.deepStrictEqual(rec.sessions, [{ session: 'gLocal', files: ['src/mine.js'] }]);
      assert.deepStrictEqual(rec.unattributed, []);
      const foreign = map.find(r => r.sha === shaForeign);
      assert.deepStrictEqual(foreign.sessions, [], 'the settled foreign row must never be revisited into attribution');
    });

    check('gate: a repo with no local user.email fails closed (no throw, nothing credited)', () => {
      const projNoId = path.join(ROOT, 'projects', 'no-identity-app');
      fs.mkdirSync(path.join(projNoId, 'src'), { recursive: true });
      const g = args => spawnSync('git', ['-C', projNoId, ...args], { encoding: 'utf8' });
      g(['init', '-q']);
      // Deliberately no user.email config. Commit with an ad-hoc identity.
      {
        const st = util.loadState();
        st.projects[projNoId] = { events: [
          { ts: past(120000), source: 'Claude Code', kind: 'edit', file: path.join(projNoId, 'src', 'x.js'), session: 'nLocal' },
        ] };
        util.saveState(st);
      }
      fs.writeFileSync(path.join(projNoId, 'src', 'x.js'), 'x\n');
      g(['add', '-A']);
      spawnSync('git', ['-C', projNoId, '-c', 'user.email=whoever@nowhere.dev', '-c', 'user.name=W',
        'commit', '-q', '-m', 'c'], { encoding: 'utf8' });
      const sha = g(['rev-parse', 'HEAD']).stdout.trim();
      assert.doesNotThrow(() => syncOnce({ project: projNoId }));
      const rec = require('../lib/commits').loadCommitMap(projNoId).find(r => r.sha === sha);
      assert.ok(rec, 'commit should still be recorded');
      assert.deepStrictEqual(rec.sessions, [], 'fail closed: nothing credited without a local identity');
    });
  }

  // --- Phase 3 Task 3: churn — landed-vs-reverted diagnostic (local-only) ---
  // Pure, injected: a fixture commit map + a fake runGit answering `git show
  // --numstat` (additions per commit) and `git blame HEAD` (which HEAD lines
  // still originate from the session's commits). No real repo, no wall clock,
  // and — by design — NO author/teammate parameter anywhere in the signature.
  {
    const { churn } = require('../lib/churn');
    const C1 = '1'.repeat(40), C2 = '2'.repeat(40), OTHER = '9'.repeat(40);
    const DAY = 24 * 60 * 60 * 1000;
    const NOW = Date.parse('2026-07-18T00:00:00Z');
    const settledTs = new Date(NOW - 30 * DAY).toISOString(); // 30d old = settled
    const recentTs = new Date(NOW - 1 * DAY).toISOString();   // 1d old = too recent
    // A porcelain blame block: one header line per source line, sha first.
    const blame = shas => shas.map((s, i) => `${s} ${i + 1} ${i + 1} 1\nauthor X\ncommitter X\n\tcode ${i}\n`).join('');
    const mapSettled = [
      { sha: C1, ts: settledTs, project: '/repo', sessions: [{ session: 'S', files: ['a.js'] }], unattributed: [] },
      { sha: C2, ts: settledTs, project: '/repo', sessions: [{ session: 'S', files: ['b.js'] }], unattributed: [] },
    ];
    const numstat = { [C1]: '10\t0\ta.js\n', [C2]: '6\t0\tb.js\n' };
    const blameByFile = {
      'a.js': blame([...Array(7).fill(C1), OTHER]), // 7 of 10 introduced lines survive
      'b.js': blame(Array(6).fill(C2)),             // all 6 survive
    };
    const mkRun = () => {
      const calls = [];
      const runGit = args => {
        calls.push(args);
        if (args[0] === 'show') {
          const sha = args.find(a => /^[0-9a-f]{40}$/.test(a));
          return numstat[sha] || '';
        }
        if (args[0] === 'blame') return blameByFile[args[args.length - 1]] || '';
        throw new Error(`unexpected git ${args.join(' ')}`);
      };
      return { calls, runGit };
    };

    check('churn: landed-vs-written is computed from numstat additions and HEAD blame survival', () => {
      const { runGit } = mkRun();
      const res = churn('/repo', { session: 'S', sinceDays: 7, now: NOW }, { loadCommitMap: () => mapSettled, runGit });
      assert.strictEqual(res.status, 'ok', `status: ${res.status}`);
      assert.strictEqual(res.written, 16, 'written = 10 + 6 additions');
      assert.strictEqual(res.landed, 13, 'landed = 7 (a.js) + 6 (b.js) surviving lines');
      assert.ok(Math.abs(res.fraction - 13 / 16) < 1e-9, `fraction: ${res.fraction}`);
      assert.strictEqual(res.commits, 2, 'two settled commits evaluated');
    });

    check('churn: a session whose commits are all within the window is too-recent (not yet judgeable)', () => {
      const recentMap = mapSettled.map(r => ({ ...r, ts: recentTs }));
      const res = churn('/repo', { session: 'S', sinceDays: 7, now: NOW }, { loadCommitMap: () => recentMap, runGit: mkRun().runGit });
      assert.strictEqual(res.status, 'too-recent');
      assert.strictEqual(res.fraction, null);
    });

    check('churn: an empty commit set is insufficient, never a divide-by-zero', () => {
      const res = churn('/repo', { session: 'ghost', sinceDays: 7, now: NOW }, { loadCommitMap: () => mapSettled, runGit: mkRun().runGit });
      assert.strictEqual(res.status, 'insufficient');
      assert.strictEqual(res.fraction, null);
      assert.strictEqual(res.written, 0);
    });

    check('churn: any git failure degrades to unavailable and never throws', () => {
      const dead = () => { throw new Error('fatal: not a git repository'); };
      let res;
      assert.doesNotThrow(() => { res = churn('/repo', { session: 'S', sinceDays: 7, now: NOW }, { loadCommitMap: () => mapSettled, runGit: dead }); });
      assert.strictEqual(res.status, 'unavailable');
      assert.strictEqual(res.fraction, null);
    });

    check('churn: has no author/teammate parameter — cross-person input is impossible by construction', () => {
      // The signature is churn(projectPath, {session, sinceDays, now}, deps):
      // an author-like option is simply not read, so it can never scope results.
      const { runGit } = mkRun();
      const base = churn('/repo', { session: 'S', sinceDays: 7, now: NOW }, { loadCommitMap: () => mapSettled, runGit });
      const withAuthor = churn('/repo', { session: 'S', sinceDays: 7, now: NOW, author: 'marco', teammate: 'x' }, { loadCommitMap: () => mapSettled, runGit: mkRun().runGit });
      assert.deepStrictEqual(withAuthor, base, 'an author/teammate option must be ignored, not honored');
      assert.ok(!('author' in base) && !('who' in base), 'the churn result exposes no person dimension');
    });

    // --- Phase 3 Task 3: churn CLI renderer + wiring -----------------------
    const churnLib = require('../lib/churn');
    check('churn: parseSince reads "7d"/bare numbers and defaults to 7 days', () => {
      assert.strictEqual(churnLib.parseSince('7d'), 7);
      assert.strictEqual(churnLib.parseSince('30d'), 30);
      assert.strictEqual(churnLib.parseSince('14'), 14);
      assert.strictEqual(churnLib.parseSince(null), 7);
      assert.strictEqual(churnLib.parseSince('garbage'), 7);
    });

    const CAVEAT_RE = /diagnostic.*not a target|never compared across (people|teammates)/i;
    check('churn: renderChurn always ships the fixed caveat, and shows numbers only when ok', () => {
      assert.ok(churnLib.renderChurn, 'renderChurn missing');
      const ok = churnLib.renderChurn({ commits: 2, written: 16, landed: 13, fraction: 13 / 16, status: 'ok' }, { session: 'S', sinceDays: 7 });
      assert.ok(/16/.test(ok) && /13/.test(ok), `ok render must show written/landed: ${ok}`);
      assert.ok(/8[01]%|0\.8/.test(ok), `ok render must show the fraction: ${ok}`);
      assert.ok(CAVEAT_RE.test(ok), `caveat missing from ok render: ${ok}`);
      assert.ok(/approximate/i.test(ok), `pre-gate approximate note missing: ${ok}`);
      for (const status of ['too-recent', 'insufficient', 'unavailable']) {
        const out = churnLib.renderChurn({ commits: 0, written: 0, landed: 0, fraction: null, status }, { session: 'S', sinceDays: 7 });
        assert.ok(CAVEAT_RE.test(out), `caveat missing from ${status} render: ${out}`);
        assert.ok(out.length > 0 && !/NaN|undefined/.test(out), `${status} render must be an honest message: ${out}`);
      }
    });

    // CLI wiring: real spawn. churn over projWhy (a tracked non-repo) degrades
    // to 'unavailable' but must still exit 0 and print the caveat; an author-
    // like flag must be REJECTED rather than silently scoping to a teammate.
    const churnRun = spawnSync(process.execPath, [BIN, 'churn'], { cwd: proj1, encoding: 'utf8', env: process.env });
    check('churn: `membridge churn` exits 0 and always prints the diagnostic caveat', () => {
      assert.strictEqual(churnRun.status, 0, `exit ${churnRun.status}, stderr: ${churnRun.stderr}`);
      assert.ok(CAVEAT_RE.test(churnRun.stdout), `caveat missing from CLI: ${churnRun.stdout}`);
    });
    const churnBad = spawnSync(process.execPath, [BIN, 'churn', '--teammate', 'marco'], { cwd: proj1, encoding: 'utf8', env: process.env });
    check('churn: an author/teammate-like flag is rejected, never honored', () => {
      assert.notStrictEqual(churnBad.status, 0, 'churn must reject an unknown per-person flag');
      assert.ok(/no.*(per-person|teammate|author)|unknown option/i.test(churnBad.stderr + churnBad.stdout),
        `expected a rejection message, got: ${churnBad.stderr}${churnBad.stdout}`);
    });
  }

  // --- Phase 3 Task 4: spine hardening -------------------------------------
  // (a) honor core.hooksPath; (b) atomic O_APPEND on commits.jsonl; (c) skip a
  // repo whose HEAD is unchanged since the cursor last caught up.
  {
    // (a) A repo with a custom core.hooksPath must get its post-commit hook in
    // THAT directory (else those users get no capture), and lose it on removal.
    const projHP = path.join(ROOT, 'projects', 'hookspath-app');
    fs.mkdirSync(projHP, { recursive: true });
    const ghp = args => spawnSync('git', ['-C', projHP, ...args], { encoding: 'utf8' });
    ghp(['init', '-q']);
    ghp(['config', 'core.hooksPath', '.myhooks']);
    { const st = util.loadState(); st.projects[projHP] = { events: [] }; util.saveState(st); }
    const hpSettings = path.join(ROOT, 'claude-settings-hp.json');
    const hpEnv = { ...process.env, MEMBRIDGE_CLAUDE_SETTINGS: hpSettings };
    const hpSetup = spawnSync(process.execPath, [BIN, 'setup-hooks'], { env: hpEnv, encoding: 'utf8' });
    check('spine: setup-hooks honors core.hooksPath (writes into the configured hooks dir)', () => {
      assert.strictEqual(hpSetup.status, 0, hpSetup.stderr);
      const custom = path.join(projHP, '.myhooks', 'post-commit');
      assert.ok(fs.existsSync(custom), `hook not written to core.hooksPath dir; expected ${custom}`);
      assert.ok(read(custom).includes('membridge-hook.js'), 'membridge line missing from the custom hooks dir');
      assert.ok(!fs.existsSync(path.join(projHP, '.git', 'hooks', 'post-commit')),
        'must NOT fall back to .git/hooks when core.hooksPath is set');
    });
    const hpRemove = spawnSync(process.execPath, [BIN, 'remove-hooks'], { env: hpEnv, encoding: 'utf8' });
    check('spine: remove-hooks honors core.hooksPath (strips from the configured hooks dir)', () => {
      assert.strictEqual(hpRemove.status, 0, hpRemove.stderr);
      assert.ok(!fs.existsSync(path.join(projHP, '.myhooks', 'post-commit')),
        'a membridge-only hook in the custom dir must be removed');
    });

    // (b) Two processes appending concurrently to commits.jsonl must not
    // interleave or tear a line — a single atomic O_APPEND write per record.
    const projAppend = path.join(ROOT, 'projects', 'concurrent-append-app');
    fs.mkdirSync(path.join(projAppend, '.membridge'), { recursive: true });
    const commitsPath = path.join(__dirname, '..', 'lib', 'commits.js');
    const childSrc = tag => `const c=require(${JSON.stringify(commitsPath)});` +
      `for(let i=0;i<200;i++){c.recordCommit(${JSON.stringify(projAppend)},{sha:'${tag}'+i,ts:'t',project:'p',sessions:[],unattributed:[]});}`;
    const p1 = spawn(process.execPath, ['-e', childSrc('A')], { encoding: 'utf8' });
    const p2 = spawn(process.execPath, ['-e', childSrc('B')], { encoding: 'utf8' });
    await Promise.all([p1, p2].map(p => new Promise(res => p.on('close', res))));
    check('spine: concurrent appends to commits.jsonl never interleave or tear a line', () => {
      const raw = read(path.join(projAppend, '.membridge', 'commits.jsonl'));
      const lines = raw.split('\n').filter(l => l.trim());
      assert.strictEqual(lines.length, 400, `expected 400 intact lines, got ${lines.length}`);
      let bad = 0;
      for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
      assert.strictEqual(bad, 0, `${bad} torn/interleaved line(s) — appends were not atomic`);
      assert.strictEqual(require('../lib/commits').loadCommitMap(projAppend).length, 400);
    });

    // (c) An unchanged HEAD (cursor already at HEAD) must skip the git-log
    // backfill entirely — proven by spying on newCommitsSince.
    const projTick = path.join(ROOT, 'projects', 'tick-skip-app');
    fs.mkdirSync(path.join(projTick, 'src'), { recursive: true });
    const gt = args => spawnSync('git', ['-C', projTick, ...args], { encoding: 'utf8' });
    gt(['init', '-q']); gt(['config', 'user.email', 'me@local.dev']); gt(['config', 'user.name', 'Me']);
    { const st = util.loadState(); st.projects[projTick] = { events: [] }; util.saveState(st); }
    fs.writeFileSync(path.join(projTick, 'src', 't.js'), 't\n');
    gt(['add', '-A']); gt(['commit', '-q', '-m', 'c1']);
    syncOnce({ project: projTick }); // cursor now caught up to HEAD
    const cm = require('../lib/commits');
    const origNCS = cm.newCommitsSince;
    let ncsCalls = 0;
    cm.newCommitsSince = (...a) => { ncsCalls++; return origNCS(...a); };
    try {
      syncOnce({ project: projTick }); // HEAD unchanged since cursor caught up
      check('spine: an unchanged HEAD skips the git-log backfill (cheap rev-parse compare)', () => {
        assert.strictEqual(ncsCalls, 0, 'newCommitsSince must NOT run when HEAD is unchanged and the cursor is at HEAD');
      });
      fs.writeFileSync(path.join(projTick, 'src', 't2.js'), 't2\n');
      gt(['add', '-A']); gt(['commit', '-q', '-m', 'c2']);
      const sha2 = gt(['rev-parse', 'HEAD']).stdout.trim();
      ncsCalls = 0;
      syncOnce({ project: projTick }); // HEAD moved: backfill must run again
      check('spine: a moved HEAD resumes the backfill and records the new commit', () => {
        assert.ok(ncsCalls > 0, 'newCommitsSince must run once HEAD moves');
        assert.ok(cm.loadCommitMap(projTick).some(r => r.sha === sha2), 'the new commit must be recorded');
      });
    } finally {
      cm.newCommitsSince = origNCS;
    }
  }

  check('project-resolve: resolveRoot returns nearest tracked ancestor, else null', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-resolve-'));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.membridge'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const tracked = new Set([require('../lib/util').normPath(repo)]);
    assert.strictEqual(
      projectResolve.resolveRoot(path.join(repo, 'src', 'a.js'), tracked), repo);
    assert.strictEqual(
      projectResolve.resolveRoot(path.join(base, 'loose', 'b.js'), new Set()), null);
    assert.strictEqual(
      projectResolve.resolveRoot(path.join(repo, 'src', 'a.js'), new Set()), repo);
  });

  check('project-resolve: rehomeEvents splits edits by root, prompt follows dominant', () => {
    const A = '/root/repoA', B = '/root/repoB';
    const tracked = new Set([require('../lib/util').normPath(A), require('../lib/util').normPath(B)]);
    const resolveRoot = f => (f.startsWith(A) ? A : f.startsWith(B) ? B : null);
    const events = [
      { kind: 'prompt', project: '/home', session: 's1', text: 'go' },
      { kind: 'edit', project: '/home', session: 's1', file: A + '/x.js' },
      { kind: 'edit', project: '/home', session: 's1', file: A + '/y.js' },
      { kind: 'edit', project: '/home', session: 's1', file: B + '/z.js' },
      { kind: 'summary', project: '/home', session: 's1', text: 'did' },
      { kind: 'edit', project: '/home', session: 's2', file: '/elsewhere/u.js' },
    ];
    projectResolve.rehomeEvents(events, tracked, { resolveRoot });
    const by = k => events.filter(e => e.kind === k);
    assert.deepStrictEqual(by('edit').map(e => e.project), [A, A, B, '/home']);
    assert.strictEqual(by('prompt')[0].project, A);
    assert.strictEqual(by('summary')[0].project, A);
  });

  check('project-resolve: rehomeEvents breaks dominant ties toward the first-touched root', () => {
    const A = '/tie/repoA', B = '/tie/repoB';
    const tracked = new Set([require('../lib/util').normPath(A), require('../lib/util').normPath(B)]);
    const resolveRoot = f => (f.startsWith(A) ? A : f.startsWith(B) ? B : null);
    const events = [
      { kind: 'prompt', project: '/home', session: 's1', text: 'go' },
      { kind: 'edit', project: '/home', session: 's1', file: B + '/1.js' }, // B touched first
      { kind: 'edit', project: '/home', session: 's1', file: A + '/1.js' }, // A second — 1-1 tie
    ];
    projectResolve.rehomeEvents(events, tracked, { resolveRoot });
    assert.strictEqual(events[0].project, B, 'tie resolves to first-touched root (B)');
  });

  check('project-resolve: resolveRoot matches when the file sits directly in the tracked root', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-zerohop-'));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    const tracked = new Set([require('../lib/util').normPath(repo)]);
    assert.strictEqual(projectResolve.resolveRoot(path.join(repo, 'top.js'), tracked), repo);
  });

  check('project-resolve: rehomeEvents resolves a relative edit path against the event project', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-relpath-'));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.membridge'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    const events = [
      { kind: 'edit', project: repo, session: 's1', file: 'src/rel.js' }, // relative to repo
    ];
    projectResolve.rehomeEvents(events, new Set());
    assert.strictEqual(events[0].project, repo, 'relative edit resolves under its project');
  });

  check('project-resolve: untracked git repo under a tracked parent is a boundary, not captured', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-boundary-'));
    const parent = path.join(base, 'workspace');
    fs.mkdirSync(path.join(parent, '.membridge'), { recursive: true }); // tracked parent
    const child = path.join(parent, 'newrepo');
    fs.mkdirSync(path.join(child, '.git'), { recursive: true });        // untracked git repo
    fs.mkdirSync(path.join(child, 'src'), { recursive: true });
    const tracked = new Set([require('../lib/util').normPath(parent)]);
    // the .git boundary stops the walk — child work does NOT get captured by the parent
    assert.strictEqual(projectResolve.resolveRoot(path.join(child, 'src', 'a.js'), tracked), null);
    // a file directly under the tracked parent (no nearer marker) still resolves to it
    assert.strictEqual(projectResolve.resolveRoot(path.join(parent, 'top.js'), tracked), parent);
    // if the child later becomes tracked, it wins over its own .git boundary
    const trackedChild = new Set([require('../lib/util').normPath(parent), require('../lib/util').normPath(child)]);
    assert.strictEqual(projectResolve.resolveRoot(path.join(child, 'src', 'a.js'), trackedChild), child);
  });

  check('project-resolve: sessionDominantRoot resolves relative edits against their project', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-sdr-'));
    const repo = path.join(base, 'repo');
    fs.mkdirSync(path.join(repo, '.membridge'), { recursive: true });
    const events = [
      { kind: 'edit', session: 's1', project: repo, file: 'src/rel.js' },  // relative
      { kind: 'edit', session: 's1', project: repo, file: path.join(repo, 'src', 'abs.js') },
      { kind: 'edit', session: 's2', project: '/nope', file: '/untracked/x.js' },
    ];
    assert.strictEqual(projectResolve.sessionDominantRoot(events, 's1', new Set()), repo);
    assert.strictEqual(projectResolve.sessionDominantRoot(events, 's2', new Set()), null);
  });

  // --- 30. ingestion gate: only sessions landing in a tracked root are kept ---
  // Pure cases mirror syncOnce's pipeline: rehomeEvents first, then
  // filterTrackedSessions with the same tracked set. hasMembridge is injected
  // so nothing touches the disk.
  check('gate: session editing a file inside a tracked root keeps all its events', () => {
    const A = '/gate/repoA';
    const tracked = new Set([util.normPath(A)]);
    const events = [
      { kind: 'prompt', project: A, session: 's1', ts: '2026-07-10T10:00:00.000Z', text: 'go' },
      { kind: 'edit', project: A, session: 's1', ts: '2026-07-10T10:01:00.000Z', file: A + '/src/x.js' },
      { kind: 'summary', project: A, session: 's1', ts: '2026-07-10T10:02:00.000Z', text: 'did' },
    ];
    projectResolve.rehomeEvents(events, tracked, { resolveRoot: f => (f.startsWith(A) ? A : null) });
    const kept = filterTrackedSessions(events, tracked, { hasMembridge: () => false });
    assert.strictEqual(kept.length, 3, 'all events of a tracked-root session survive');
    assert.ok(kept.every(e => util.normPath(e.project) === util.normPath(A)));
  });

  check('gate: prompt-only session in an untracked cwd is dropped entirely', () => {
    const tracked = new Set([util.normPath('/gate/repoA')]);
    const events = [
      { kind: 'prompt', project: '/home/personal', session: 's1', ts: '2026-07-10T10:00:00.000Z', text: 'life advice pls' },
      { kind: 'summary', project: '/home/personal', session: 's1', ts: '2026-07-10T10:05:00.000Z', text: 'chatted' },
    ];
    projectResolve.rehomeEvents(events, tracked, { resolveRoot: () => null });
    const kept = filterTrackedSessions(events, tracked, { hasMembridge: () => false });
    assert.deepStrictEqual(kept, [], 'no event of an untracked personal session survives');
  });

  check('gate: session editing only files under an untracked cwd is dropped', () => {
    const tracked = new Set([util.normPath('/gate/repoA')]);
    const events = [
      { kind: 'prompt', project: '/home/personal', session: 's1', ts: '2026-07-10T10:00:00.000Z', text: 'tweak my notes' },
      { kind: 'edit', project: '/home/personal', session: 's1', ts: '2026-07-10T10:01:00.000Z', file: '/home/personal/notes.txt' },
    ];
    projectResolve.rehomeEvents(events, tracked, { resolveRoot: () => null });
    const kept = filterTrackedSessions(events, tracked, { hasMembridge: () => false });
    assert.deepStrictEqual(kept, [], 'untracked edits must not spawn a project');
  });

  check('gate: multi-repo session keeps only its tracked-root portion', () => {
    const A = '/gate/repoA';
    const tracked = new Set([util.normPath(A)]);
    const events = [
      { kind: 'prompt', project: '/home', session: 's1', ts: '2026-07-10T10:00:00.000Z', text: 'go' },
      { kind: 'edit', project: '/home', session: 's1', ts: '2026-07-10T10:01:00.000Z', file: A + '/x.js' },
      { kind: 'edit', project: '/home', session: 's1', ts: '2026-07-10T10:02:00.000Z', file: A + '/y.js' },
      { kind: 'edit', project: '/home', session: 's1', ts: '2026-07-10T10:03:00.000Z', file: '/elsewhere/u.js' },
      { kind: 'summary', project: '/home', session: 's1', ts: '2026-07-10T10:04:00.000Z', text: 'did' },
    ];
    projectResolve.rehomeEvents(events, tracked, { resolveRoot: f => (f.startsWith(A) ? A : null) });
    const kept = filterTrackedSessions(events, tracked, { hasMembridge: () => false });
    assert.strictEqual(kept.length, 4, 'tracked edits + prompt + summary survive, untracked edit dropped');
    assert.ok(kept.every(e => util.normPath(e.project) === util.normPath(A)), 'kept events all file under the tracked root');
    assert.ok(!kept.some(e => e.file === '/elsewhere/u.js'), 'the untracked edit is gone');
  });

  check('gate: a dir with .membridge counts as tracked even before it is a state key', () => {
    const M = '/gate/marker-repo';
    const events = [
      { kind: 'prompt', project: M, session: 's1', ts: '2026-07-10T10:00:00.000Z', text: 'go' },
    ];
    const kept = filterTrackedSessions(events, new Set(), { hasMembridge: d => util.normPath(d) === util.normPath(M) });
    assert.strictEqual(kept.length, 1, '.membridge marker keeps the session');
  });

  check('gate: defensive — bad events or a throwing resolver drop, never throw', () => {
    const tracked = new Set([util.normPath('/gate/repoA')]);
    assert.deepStrictEqual(filterTrackedSessions(null, tracked, {}), [], 'null events -> []');
    assert.deepStrictEqual(filterTrackedSessions(undefined, tracked, {}), [], 'undefined events -> []');
    const events = [
      null,
      { kind: 'prompt', session: 's1', ts: '2026-07-10T10:00:00.000Z', text: 'no project field' },
      { kind: 'prompt', project: '/boom', session: 's2', ts: '2026-07-10T10:01:00.000Z', text: 'resolver throws' },
    ];
    let kept;
    assert.doesNotThrow(() => {
      kept = filterTrackedSessions(events, tracked, { hasMembridge: () => { throw new Error('disk on fire'); } });
    });
    assert.deepStrictEqual(kept, [], 'unresolvable events are dropped, not thrown');
  });

  // e2e: a personal session in an untracked dir must neither create a project
  // nor surface in the feed; a tracked project's session still ingests.
  const untrackedDir = path.join(ROOT, 'untracked-dir');
  fs.mkdirSync(untrackedDir, { recursive: true });
  const gateSlug = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-untracked-dir');
  fs.mkdirSync(gateSlug, { recursive: true });
  fs.writeFileSync(path.join(gateSlug, 'gate-personal.jsonl'), jsonl([
    { type: 'user', message: { role: 'user', content: 'GATE-PERSONAL what should I cook tonight' }, cwd: untrackedDir, timestamp: '2026-07-10T09:00:00.000Z' },
  ]));
  const gateRegSess = path.join(process.env.MEMBRIDGE_CLAUDE_DIR, 'slug-shop-app', 'gate-regression.jsonl');
  fs.writeFileSync(gateRegSess, jsonl([
    { type: 'user', message: { role: 'user', content: 'GATE-REGRESSION polish the checkout page' }, cwd: proj1, timestamp: '2026-07-10T09:10:00.000Z' },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(proj1, 'src', 'login.js') } }] }, cwd: proj1, timestamp: '2026-07-10T09:11:00.000Z' },
  ]));
  syncOnce();
  const gateState = util.loadState();
  const gateFeed = await feedPayload({ limit: 200 });

  check('gate e2e: untracked-dir session creates no state.projects entry', () => {
    const hit = Object.keys(gateState.projects || {}).find(k => util.normPath(k) === util.normPath(untrackedDir));
    assert.ok(!hit, `untracked cwd became a project: ${hit}`);
    const leaked = Object.values(gateState.projects || {}).some(p =>
      (p.events || []).some(e => (e.text || '').includes('GATE-PERSONAL')));
    assert.ok(!leaked, 'personal prompt leaked into some project history');
  });

  check('gate e2e: /api/feed shows nothing from the untracked session', () => {
    const entries = gateFeed.entries || gateFeed.local || [];
    const leaked = JSON.stringify(entries).includes('GATE-PERSONAL');
    assert.ok(!leaked, 'personal session surfaced in the feed');
    assert.ok(!JSON.stringify(gateFeed).includes(util.normPath(untrackedDir) + '"'), 'untracked dir appears as a feed project');
  });

  check('gate e2e: tracked project session still ingests exactly as before', () => {
    const key = Object.keys(gateState.projects || {}).find(k => util.normPath(k) === util.normPath(proj1));
    assert.ok(key, 'proj1 missing from state');
    const evs = gateState.projects[key].events || [];
    assert.ok(evs.some(e => (e.text || '').includes('GATE-REGRESSION')), 'tracked prompt missing');
    assert.ok(evs.some(e => e.kind === 'edit' && (e.file || '').includes('login.js') && e.ts === '2026-07-10T09:11:00.000Z'), 'tracked edit missing');
  });

  // --- 31. saveState: atomic write (temp file + rename) ---
  // The app and CLI daemons can both rewrite state.json; a crash or a write
  // error mid-save must never destroy the previously-good file. We prove
  // this by letting the real write actually land (so old direct-write code
  // truly mutates the file) and then forcing the underlying call to raise —
  // an atomic (write-temp, then rename) implementation only ever writes the
  // temp path, so the real state.json is untouched no matter when the
  // injected failure fires.
  {
    const priorRaw = read(util.statePath());

    check('saveState: a failed write leaves the previous state.json byte-for-byte intact', () => {
      const realWriteFileSync = fs.writeFileSync;
      fs.writeFileSync = function (...args) {
        const result = realWriteFileSync.apply(fs, args); // the write itself really happens...
        throw new Error('simulated disk failure after write'); // ...but the call still reports failure
      };
      try {
        assert.throws(
          () => util.saveState({ version: util.STATE_VERSION, files: {}, projects: { marker: { events: [] } } }),
          /simulated disk failure/,
          'saveState swallowed the write failure instead of propagating it'
        );
      } finally {
        fs.writeFileSync = realWriteFileSync;
      }
      assert.strictEqual(read(util.statePath()), priorRaw,
        'state.json changed even though the save reported failure — writes are not atomic');
      const leftovers = fs.readdirSync(util.homeDir()).filter(f => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'a temp file was left behind after a failed save');
    });

    check('saveState: happy path still round-trips through loadState', () => {
      const fresh = {
        version: util.STATE_VERSION,
        files: {},
        projects: { '/tmp/atomic-roundtrip-project': { events: [{ kind: 'prompt', session: 's1', ts: '2026-07-18T00:00:00.000Z', text: 'atomic write check' }] } },
        catchup: { ...util.DEFAULT_CATCHUP },
        feedback: { ...util.DEFAULT_FEEDBACK },
      };
      util.saveState(fresh);
      assert.deepStrictEqual(util.loadState(), fresh, 'state did not round-trip through save/load');
      const leftovers = fs.readdirSync(util.homeDir()).filter(f => f.endsWith('.tmp'));
      assert.deepStrictEqual(leftovers, [], 'a temp file was left behind after a successful save');
    });

    // Restore the real accumulated state so nothing after this section (just
    // the summary print below) is affected by these probes.
    fs.writeFileSync(util.statePath(), priorRaw);
  }

  // --- ops-noise suppression (classify + feed/push/block filters) ---
  {
    const classify = require('../lib/classify');
    // Edit file lives OUTSIDE the project so it is dropped from rendered files
    // (no git/deriveChanges on a fake path) — the edit EVENT still marks the
    // session shareable, which is what these filters key on.
    const opsProj = { events: [
      { ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'ops', text: 'open browser' },
      { ts: '2026-07-20T09:01:00.000Z', source: 'Claude Code', kind: 'summary', session: 'ops', text: 'the tab is open now' }, // no edit -> ops noise
      { ts: '2026-07-20T09:02:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'code', text: 'fix bug' },
      { ts: '2026-07-20T09:03:00.000Z', source: 'Claude Code', kind: 'edit', session: 'code', file: '/outside-proj/a.js' },
      // Codex never emits edit events, so its zero-edit sessions must still show.
      { ts: '2026-07-20T09:04:00.000Z', source: 'Codex', kind: 'prompt', session: 'cx', text: 'refactor the parser' },
      { ts: '2026-07-20T09:05:00.000Z', source: 'Codex', kind: 'summary', session: 'cx', text: 'parser refactor done' },
    ] };

    check('classify: suppresses zero-edit sessions from edit-capturing tools, exempts Codex', () => {
      const set = classify.shareableSessions(opsProj.events);
      assert.ok(!set.has('ops'), 'zero-edit Claude Code session must be suppressed');
      assert.ok(set.has('code'), 'a Claude Code session with an edit must be shareable');
      assert.ok(set.has('cx'), 'a Codex session (never emits edits) must always be shareable');
      assert.strictEqual(classify.isShareableLocal(opsProj.events, 'ops'), false);
      assert.strictEqual(classify.isShareableLocal(opsProj.events, 'cx'), true);
      const filtered = classify.filterShareableEntries(
        [{ session: 'ops' }, { session: 'code' }, { session: 'cx' }], opsProj.events);
      assert.deepStrictEqual(filtered.map(e => e.session), ['code', 'cx']);
      // Fail-open: garbage never throws.
      assert.deepStrictEqual([...classify.shareableSessions(null)], []);
      assert.strictEqual(classify.isShareableLocal(null, 'x'), false);
    });

    check('feed/push: buildEntries source drops zero-edit Claude Code sessions, keeps edits and Codex', () => {
      const all = memorydb.buildEntries(ROOT, opsProj, util.getConfig());
      const sessions = new Set(classify.filterShareableEntries(all, opsProj.events).map(e => e.session));
      assert.ok(!sessions.has('ops'), 'ops-noise session leaked into the feed/push source');
      assert.ok(sessions.has('code'), 'edit session missing from feed/push source');
      assert.ok(sessions.has('cx'), 'Codex session missing from feed/push source');
    });

    check('block: sessionGroups drops zero-edit Claude Code sessions, keeps edits and Codex', () => {
      const groups = digest.sessionGroups(ROOT, opsProj, util.getConfig());
      const asks = new Set(groups.map(g => (g.prompts[0] && g.prompts[0].text) || ''));
      assert.ok(!asks.has('open browser'), 'ops-noise session leaked into the context block');
      assert.ok(asks.has('fix bug'), 'edit session missing from the context block');
      assert.ok(asks.has('refactor the parser'), 'Codex session missing from the context block');
    });
  }

  // --- git worktrees fold into their main repo's project ---
  {
    const pr = require('../lib/project-resolve');
    const scan = require('../lib/scan');
    const np = util.normPath;

    check('worktree: worktreeMain parses a .git pointer, ignores real .git dirs', () => {
      const wt = path.join(ROOT, 'wt-parse');
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /some/main/repo/.git/worktrees/feat-x\n');
      assert.strictEqual(pr.worktreeMain(wt), '/some/main/repo', 'main repo root not derived');
      const real = path.join(ROOT, 'wt-real');
      fs.mkdirSync(path.join(real, '.git'), { recursive: true });
      assert.strictEqual(pr.worktreeMain(real), null, 'a real .git dir must not read as a worktree');
      const sub = path.join(ROOT, 'wt-sub');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, '.git'), 'gitdir: /x/.git/modules/foo\n');
      assert.strictEqual(pr.worktreeMain(sub), null, 'a submodule pointer must not read as a worktree');
    });

    check('worktree: resolveRoot redirects a worktree file to its main repo', () => {
      const main = '/repo';
      const wt = '/repo/.claude/worktrees/feat-x';
      const trackedRoots = new Set([np(main)]);
      const opts = {
        worktreeMain: dir => (np(dir) === np(wt) ? main : null),
        hasMembridge: () => false,
        hasGit: dir => np(dir) === np(main), // main is the only real repo root
      };
      assert.strictEqual(pr.resolveRoot(wt + '/lib/a.js', trackedRoots, opts), main,
        'a worktree file must resolve to the main repo project');
    });

    check('worktree: foldWorktreeProjects merges a fragment into its main project', () => {
      const main = '/repo';
      const wt = '/repo/.claude/worktrees/gone'; // deleted from disk -> path fallback
      const state = { projects: {
        [main]: { events: [
          { ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'edit', session: 'm', file: '/repo/a.js', project: main }] },
        [wt]: { events: [
          { ts: '2026-07-20T09:01:00.000Z', source: 'Claude Code', kind: 'prompt', session: 'w', text: 'do it', project: wt },
          { ts: '2026-07-20T09:02:00.000Z', source: 'Claude Code', kind: 'edit', session: 'w', file: '/repo/.claude/worktrees/gone/b.js', project: wt }] },
      }, files: {} };
      const folded = scan.foldWorktreeProjects(state, util.getConfig());
      assert.strictEqual(folded.length, 1, `expected one fold, got ${JSON.stringify(folded)}`);
      assert.ok(!state.projects[wt], 'worktree fragment was not removed');
      const sessions = new Set((state.projects[main].events || []).map(e => e.session));
      assert.ok(sessions.has('w') && sessions.has('m'), 'worktree events not merged into main (or main lost)');
      // idempotent: a second pass folds nothing.
      assert.strictEqual(scan.foldWorktreeProjects(state, util.getConfig()).length, 0, 'fold is not idempotent');
    });

    check('worktree: fold never touches a real nested project (no worktrees segment)', () => {
      const state = { projects: {
        '/repo': { events: [] },
        '/repo/packages/api': { events: [{ ts: '2026-07-20T09:00:00.000Z', source: 'Claude Code', kind: 'edit', session: 's', file: '/repo/packages/api/x.js', project: '/repo/packages/api' }] },
      }, files: {} };
      const folded = scan.foldWorktreeProjects(state, util.getConfig());
      assert.strictEqual(folded.length, 0, 'a normal nested project must not be folded');
      assert.ok(state.projects['/repo/packages/api'], 'nested project was wrongly removed');
    });
  }

  // --- update check (version compare + cached, fail-silent release lookup) ---
  {
    const uc = require('../lib/update-check');
    const clearCache = () => { try { fs.unlinkSync(uc.cachePath()); } catch {} };
    const mkFetch = tag => async () => ({ ok: true, json: async () => ({ tag_name: tag }) });
    const failFetch = () => async () => { throw new Error('offline'); };

    check('update-check: parseVersion + numeric (not lexical) compare', () => {
      assert.deepStrictEqual(uc.parseVersion('v1.2.3'), [1, 2, 3]);
      assert.deepStrictEqual(uc.parseVersion('1.2'), [1, 2, 0]);
      assert.strictEqual(uc.parseVersion('garbage'), null);
      assert.ok(uc.compareVersions('0.1.10', '0.1.9') > 0, '0.1.10 must beat 0.1.9');
      assert.ok(uc.compareVersions('1.0.0', '0.9.9') > 0);
      assert.strictEqual(uc.isNewer('0.1.1', '0.1.1'), false);
      assert.strictEqual(uc.isNewer('0.1.0', '0.1.1'), false);
    });

    await check('update-check: reports an available update from the API', async () => {
      clearCache();
      const r = await uc.check({ current: '0.1.1', force: true, now: 1000, fetchImpl: mkFetch('v0.2.0') });
      assert.strictEqual(r.latest, '0.2.0');
      assert.strictEqual(r.updateAvailable, true);
    });

    await check('update-check: no update when already on latest', async () => {
      clearCache();
      const r = await uc.check({ current: '0.2.0', force: true, now: 1000, fetchImpl: mkFetch('v0.2.0') });
      assert.strictEqual(r.updateAvailable, false);
    });

    await check('update-check: offline is fail-silent (null latest, no throw)', async () => {
      clearCache();
      const r = await uc.check({ current: '0.1.1', force: true, now: 1000, fetchImpl: failFetch() });
      assert.strictEqual(r.latest, null);
      assert.strictEqual(r.updateAvailable, false);
    });

    await check('update-check: TTL caches the result; force bypasses it', async () => {
      clearCache();
      let calls = 0;
      const counting = async () => { calls++; return { ok: true, json: async () => ({ tag_name: 'v0.3.0' }) }; };
      await uc.check({ current: '0.1.1', now: 1000, fetchImpl: counting });      // fetch #1
      await uc.check({ current: '0.1.1', now: 2000, fetchImpl: counting });      // within TTL -> cached
      assert.strictEqual(calls, 1, 'second call within TTL must not re-fetch');
      await uc.check({ current: '0.1.1', now: 3000, force: true, fetchImpl: counting }); // force -> re-fetch
      assert.strictEqual(calls, 2, 'force must re-fetch');
      // ...and past the TTL it re-fetches on its own.
      await uc.check({ current: '0.1.1', now: 3000 + uc.CACHE_TTL_MS + 1, fetchImpl: counting });
      assert.strictEqual(calls, 3, 'a check past the TTL must re-fetch');
    });

    check('update-check: once-per-version notification guard', () => {
      clearCache();
      assert.strictEqual(uc.alreadyNotified('0.2.0'), false);
      uc.markNotified('0.2.0');
      assert.strictEqual(uc.alreadyNotified('0.2.0'), true);
      assert.strictEqual(uc.alreadyNotified('0.3.0'), false, 'a newer version must notify again');
      clearCache();
    });

    check('update-check: updateCommand matches install kind', () => {
      assert.strictEqual(uc.updateCommand('app'), 'curl -fsSL https://membridge.me/install.sh | sh');
      assert.strictEqual(uc.updateCommand('npm'), 'npm install -g @membridgeai/membridge');
    });
  }

  // New-device key recovery: a member whose keypair rotated (new machine /
  // reset key store) is otherwise stuck forever — their stale sealed row is
  // never overwritten and join-seal skips them. Two paths must recover them:
  // (1) self-heal drops the stale row so a re-trusting holder re-seals the
  // SAME key (history recovered); (2) an owner can `rekey` to a fresh epoch.
  {
    const tcR = require('../lib/teamcrypto');
    const mkMemKc = () => { const m = new Map(); return {
      available: () => true, load: a => m.get(a) || null,
      store: (a, s) => { m.set(a, s); return true; }, remove: a => m.delete(a), _m: m }; };
    const setCfg = () => { util.ensureConfig(); const raw = util.loadUserConfig();
      raw.team = { ...(raw.team || {}), sharePrompts: true, encrypt: true }; util.saveUserConfig(raw); };
    const savedHome = process.env.MEMBRIDGE_HOME;
    const savedUrl = process.env.MEMBRIDGE_TEAM_URL;
    const savedKey = process.env.MEMBRIDGE_TEAM_ANON_KEY;
    const homeA = path.join(ROOT, 'home-recA');
    const homeB = path.join(ROOT, 'home-recB');
    const projR = path.join(ROOT, 'projects', 'rec-app');
    fs.mkdirSync(projR, { recursive: true });
    const kcA = mkMemKc();
    const kcBold = mkMemKc();      // Bob's original device
    const kcBnew = mkMemKc();      // Bob's NEW device (fresh keypair)
    const mockR = createMockSupabase();
    let err = null;
    let bobStaleDropped = null, bobRecovered = null, rekeyRes = null, rekeyEpoch = null;
    let nonOwnerRekey = null, aliceUserId = null, bobUserId = null;
    try {
      await new Promise(r => mockR.server.listen(17961, '127.0.0.1', r));
      process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17961';
      process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

      // Alice owns the team; Bob joins and bootstraps his ORIGINAL identity.
      process.env.MEMBRIDGE_HOME = homeA; setCfg();
      await teamsync.signup(util.getConfig(), 'a-rec@test.dev', 'pw', 'Alice');
      const teamR = await teamsync.createTeam(util.getConfig(), 'REC');
      await teamsync.linkProject(util.getConfig(), projR, teamR.team_id, 'REC');
      aliceUserId = mockR.users.get('a-rec@test.dev').id;

      process.env.MEMBRIDGE_HOME = homeB; setCfg();
      await teamsync.signup(util.getConfig(), 'b-rec@test.dev', 'pw', 'Bob');
      await teamsync.joinTeam(util.getConfig(), teamR.invite_code);
      bobUserId = mockR.users.get('b-rec@test.dev').id;
      // Bob bootstraps his identity first WITHOUT a linked project (uploads his
      // pubkey, does not mint), so Alice's epoch-1 mint seals to BOTH members.
      await teamsync.syncTeams({ cryptoDeps: { keychain: kcBold, teamcrypto: tcR } });

      // Alice mints epoch-1 sealed to both (she pushes a session).
      process.env.MEMBRIDGE_HOME = homeA;
      const stA = util.loadState();
      stA.projects[projR] = { events: [
        { ts: '2026-07-18T12:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'do the thing', session: 'r1' },
        { ts: '2026-07-18T12:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projR, 'a.js'), session: 'r1' },
        { ts: '2026-07-18T12:02:00.000Z', source: 'Claude Code', kind: 'summary', text: 'did the thing', session: 'r1' },
      ] };
      util.saveState(stA);
      await teamsync.syncTeams({ project: projR, cryptoDeps: { keychain: kcA, teamcrypto: tcR } });

      // Bob switches to a NEW device: fresh keychain, same home/creds. Give
      // his home the project, then sync — uploads a new pubkey (overwriting the
      // old) and must self-heal the now-unopenable epoch-1 row.
      process.env.MEMBRIDGE_HOME = homeB;
      { const st = util.loadState(); st.projects[projR] = { events: [] }; util.saveState(st); }
      await teamsync.syncTeams({ project: projR, cryptoDeps: { keychain: kcBnew, teamcrypto: tcR } });
      bobStaleDropped = !mockR.teamKeys.some(k => k.member_user_id === bobUserId);

      // Alice re-trusts Bob's rotated key (out-of-band verified) and syncs:
      // join-seal re-seals epoch-1 to Bob's NEW key.
      process.env.MEMBRIDGE_HOME = homeA;
      await teamsync.trustMember(util.getConfig(), bobUserId);
      await teamsync.syncTeams({ project: projR, cryptoDeps: { keychain: kcA, teamcrypto: tcR } });

      // Bob syncs again on the new device: he can now open the team key.
      process.env.MEMBRIDGE_HOME = homeB;
      const rb = await teamsync.syncTeams({ project: projR, cryptoDeps: { keychain: kcBnew, teamcrypto: tcR } });
      bobRecovered = (rb.errors || []).length === 0 && !util.loadState().teamCryptoPaused;

      // Owner rekey path: Alice rekeys; a fresh epoch seals to both trusted
      // members and she can open her own new row.
      process.env.MEMBRIDGE_HOME = homeA;
      rekeyRes = await teamsync.rekeyTeam(util.getConfig(), teamR.team_id,
        { cryptoDeps: { keychain: kcA, teamcrypto: tcR } });
      rekeyEpoch = rekeyRes.epoch;

      // Non-owner rekey is refused.
      process.env.MEMBRIDGE_HOME = homeB;
      nonOwnerRekey = await teamsync.rekeyTeam(util.getConfig(), teamR.team_id,
        { cryptoDeps: { keychain: kcBnew, teamcrypto: tcR } });
    } catch (e) { err = e; } finally {
      process.env.MEMBRIDGE_HOME = savedHome;
      process.env.MEMBRIDGE_TEAM_URL = savedUrl;
      process.env.MEMBRIDGE_TEAM_ANON_KEY = savedKey;
      mockR.server.close();
    }

    check('teamsync: a rotated-key device self-heals — its stale sealed row is dropped so a holder can re-seal', () => {
      assert.ok(!err, `recovery scenario threw: ${err && err.message}`);
      assert.strictEqual(bobStaleDropped, true, 'Bob\'s stale epoch-1 row must be deleted on his new device');
    });
    check('teamsync: after the holder re-trusts + syncs, the rotated-key device recovers the same key (history included)', () => {
      assert.ok(!err, `recovery scenario threw: ${err && err.message}`);
      assert.ok(mockR.teamKeys.some(k => k.member_user_id === bobUserId && String(k.epoch) === '1'),
        'epoch-1 must be re-sealed to Bob\'s new key');
      assert.strictEqual(bobRecovered, true, 'Bob must resolve the key with no pause after recovery');
    });
    check('teamsync: owner rekey mints a fresh epoch sealed to every trusted member, openable by the owner', () => {
      assert.ok(!err, `recovery scenario threw: ${err && err.message}`);
      assert.ok(rekeyRes && rekeyRes.ok, `rekey failed: ${rekeyRes && rekeyRes.error}`);
      assert.strictEqual(rekeyEpoch, 2, 'rekey must advance to epoch 2');
      assert.strictEqual(rekeyRes.sealed, 2, 'new epoch must seal to both members');
      assert.ok(mockR.teamKeys.filter(k => String(k.epoch) === '2').length === 2, 'two epoch-2 rows expected');
    });
    check('teamsync: rekey is owner/admin only — a plain member is refused', () => {
      assert.ok(!err, `recovery scenario threw: ${err && err.message}`);
      assert.ok(nonOwnerRekey && nonOwnerRekey.ok === false, 'non-owner rekey must fail');
      assert.ok(/owner or admin/i.test(nonOwnerRekey.error || ''), `expected role error, got: ${nonOwnerRekey && nonOwnerRekey.error}`);
    });
  }

  // Multi-device FULL-HISTORY recovery: a new device must recover EVERY past
  // epoch it's entitled to, not just the current one — the platform behavior
  // that makes "log in on a new machine, see all your history" actually work.
  {
    const tcM = require('../lib/teamcrypto');
    const mkKc = () => { const m = new Map(); return {
      available: () => true, load: a => m.get(a) || null,
      store: (a, s) => { m.set(a, s); return true; }, remove: a => m.delete(a) }; };
    const setCfg = () => { util.ensureConfig(); const raw = util.loadUserConfig();
      raw.team = { ...(raw.team || {}), sharePrompts: true, encrypt: true }; util.saveUserConfig(raw); };
    const sHome = process.env.MEMBRIDGE_HOME, sUrl = process.env.MEMBRIDGE_TEAM_URL, sKey = process.env.MEMBRIDGE_TEAM_ANON_KEY;
    const hA = path.join(ROOT, 'home-mdA'), hB = path.join(ROOT, 'home-mdB');
    const projM = path.join(ROOT, 'projects', 'md-app');
    fs.mkdirSync(projM, { recursive: true });
    const kcA = mkKc(), kcBold = mkKc(), kcBnew = mkKc();
    const mockM = createMockSupabase();
    let err = null, bobUserId = null, openEpochs = null, teamId = null;
    try {
      await new Promise(r => mockM.server.listen(17974, '127.0.0.1', r));
      process.env.MEMBRIDGE_TEAM_URL = 'http://127.0.0.1:17974';
      process.env.MEMBRIDGE_TEAM_ANON_KEY = 'anon-test';

      process.env.MEMBRIDGE_HOME = hA; setCfg();
      await teamsync.signup(util.getConfig(), 'a-md@test.dev', 'pw', 'Alice');
      const t = await teamsync.createTeam(util.getConfig(), 'MD'); teamId = t.team_id;
      await teamsync.linkProject(util.getConfig(), projM, t.team_id, 'MD');

      process.env.MEMBRIDGE_HOME = hB; setCfg();
      await teamsync.signup(util.getConfig(), 'b-md@test.dev', 'pw', 'Bob');
      await teamsync.joinTeam(util.getConfig(), t.invite_code);
      bobUserId = mockM.users.get('b-md@test.dev').id;
      // Bob bootstraps his identity WITHOUT a linked project, so he only
      // uploads his pubkey and does NOT mint — Alice's epoch-1 mint then seals
      // to BOTH members (mirrors the real join-before-first-content order).
      await teamsync.syncTeams({ cryptoDeps: { keychain: kcBold, teamcrypto: tcM } });

      // Alice mints epoch-1 (push), then rekeys to epoch-2 — both sealed to
      // Bob's ORIGINAL key. Now there is real multi-epoch history.
      process.env.MEMBRIDGE_HOME = hA;
      const stA = util.loadState();
      stA.projects[projM] = { events: [
        { ts: '2026-07-18T12:00:00.000Z', source: 'Claude Code', kind: 'prompt', text: 'epoch one work', session: 'm1' },
        { ts: '2026-07-18T12:01:00.000Z', source: 'Claude Code', kind: 'edit', file: path.join(projM, 'a.js'), session: 'm1' },
      ] };
      util.saveState(stA);
      await teamsync.syncTeams({ project: projM, cryptoDeps: { keychain: kcA, teamcrypto: tcM } });
      await teamsync.rekeyTeam(util.getConfig(), t.team_id, { cryptoDeps: { keychain: kcA, teamcrypto: tcM } });

      // Bob's NEW device: give his home the project now, both his epoch-1 and
      // epoch-2 rows are stale against his fresh keypair.
      process.env.MEMBRIDGE_HOME = hB;
      { const st = util.loadState(); st.projects[projM] = { events: [] }; util.saveState(st); }
      await teamsync.syncTeams({ project: projM, cryptoDeps: { keychain: kcBnew, teamcrypto: tcM } });

      // Alice re-trusts Bob's new key and syncs: reconcile re-seals BOTH epochs.
      process.env.MEMBRIDGE_HOME = hA;
      await teamsync.trustMember(util.getConfig(), bobUserId);
      await teamsync.syncTeams({ project: projM, cryptoDeps: { keychain: kcA, teamcrypto: tcM } });

      // Prove Bob's NEW key can open every epoch sealed to him.
      await tcM.ready();
      const priv = kcBnew.load('membridge.box.privatekey'), pub = kcBnew.load('membridge.box.publickey');
      const bobRows = mockM.teamKeys.filter(k => k.member_user_id === bobUserId);
      openEpochs = bobRows
        .filter(k => tcM.unsealTeamKey(k.sealed_team_key, pub, priv))
        .map(k => Number(k.epoch)).sort();
    } catch (e) { err = e; } finally {
      process.env.MEMBRIDGE_HOME = sHome; process.env.MEMBRIDGE_TEAM_URL = sUrl; process.env.MEMBRIDGE_TEAM_ANON_KEY = sKey;
      mockM.server.close();
    }

    check('teamsync: a new device recovers ALL past epochs (full history), not just the current one', () => {
      assert.ok(!err, `multi-epoch scenario threw: ${err && err.message}`);
      assert.deepStrictEqual(openEpochs, [1, 2],
        `Bob's new device must open epoch 1 AND 2 after recovery, opened: ${JSON.stringify(openEpochs)}`);
    });
  }

  // --- post-install feedback nudges (feat/feedback-hook) ---
  // Local-only: these exercise lib/prompts against the sandbox state, toggling
  // isTTY / CI / config.prompts and capturing console output. No network.
  {
    const prompts = require('../lib/prompts');
    const origTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const origCI = process.env.CI;
    const savedState = read(util.statePath());
    let out = [];
    const origLog = console.log;
    const cap = () => { out = []; console.log = (...a) => out.push(a.join(' ')); };
    const uncap = () => { console.log = origLog; };
    const printed = () => out.join('\n');
    const setTTY = v => Object.defineProperty(process.stdout, 'isTTY', { value: v, configurable: true });
    const withEvents = fb => ({
      version: util.STATE_VERSION, files: {},
      projects: { '/tmp/fb-proj': { events: [{ kind: 'prompt', session: 'fb-s1', ts: '2026-07-18T00:00:00.000Z', text: 'x' }] } },
      catchup: { ...util.DEFAULT_CATCHUP }, feedback: { ...util.DEFAULT_FEEDBACK, ...fb },
    });

    try {
      delete process.env.CI;
      setTTY(true);

      check('feedback: first-run message A prints once under a TTY, then never again', () => {
        util.saveState(withEvents({ firstRunShown: false }));
        cap(); prompts.maybeFirstRun(util.getConfig()); uncap();
        const first = printed();
        assert.ok(/MemBridge is running/.test(first), 'message A not printed');
        assert.ok(/membridge\.me\/feedback\?ref=cli/.test(first), 'message A missing the feedback link');
        assert.ok(/MembridgeAi\/membridge/.test(first) && !/andrewb-eng/.test(first), 'links must use MembridgeAi/membridge only');
        cap(); prompts.maybeFirstRun(util.getConfig()); uncap();
        assert.strictEqual(printed(), '', 'message A must not print a second time');
        assert.strictEqual(util.loadState().feedback.firstRunShown, true, 'firstRunShown not persisted');
      });

      check('feedback: no message without a TTY, or when CI is set (state untouched)', () => {
        util.saveState(withEvents({ firstRunShown: false }));
        setTTY(false);
        cap(); prompts.maybeFirstRun(util.getConfig()); uncap();
        assert.strictEqual(printed(), '', 'must not print without a TTY');
        setTTY(true);
        process.env.CI = '1';
        cap(); prompts.maybeFirstRun(util.getConfig()); uncap();
        assert.strictEqual(printed(), '', 'must not print under CI');
        delete process.env.CI;
        assert.strictEqual(util.loadState().feedback.firstRunShown, false, 'a suppressed call must not mark firstRunShown');
      });

      check('feedback: value moment B prints once after 5 amendments (with a real session count), then never again', () => {
        util.saveState(withEvents({ firstRunShown: true, valueShown: false, amendments: 5 }));
        cap(); prompts.flushValueMoment(util.getConfig()); uncap();
        const b = printed();
        assert.ok(/synced 1 sessions/.test(b), 'message B must carry the real session count: ' + b);
        assert.ok(/ref=cli-value/.test(b), 'message B missing the value link');
        assert.ok(!/ 0 sessions/.test(b), 'message B must never say 0 sessions');
        cap(); prompts.flushValueMoment(util.getConfig()); uncap();
        assert.strictEqual(printed(), '', 'message B must not print a second time');
        assert.strictEqual(util.loadState().feedback.valueShown, true, 'valueShown not persisted');
      });

      check('feedback: below 5 amendments the value moment stays silent', () => {
        util.saveState(withEvents({ firstRunShown: true, valueShown: false, amendments: 4 }));
        cap(); prompts.flushValueMoment(util.getConfig()); uncap();
        assert.strictEqual(printed(), '', 'B must not print before the 5th amendment');
      });

      check('feedback: config prompts:false suppresses both messages', () => {
        util.saveState(withEvents({ firstRunShown: false, valueShown: false, amendments: 5 }));
        const cfg = { ...util.getConfig(), prompts: false };
        cap(); prompts.maybeFirstRun(cfg); prompts.flushValueMoment(cfg); uncap();
        assert.strictEqual(printed(), '', 'prompts:false must suppress both A and B');
        assert.strictEqual(util.loadState().feedback.firstRunShown, false, 'suppressed A must not mark shown');
      });

      check('feedback: countAmendments counts only updated context-file writes, not memory.md/db', () => {
        const cfg = util.getConfig();
        const target = util.effectiveTargets(cfg)[0]; // e.g. CLAUDE.md
        const changes = [
          { file: '/p/' + target, action: 'updated' },
          { file: '/p/' + target, action: 'would update' },        // dry-run action: not counted
          { file: '/p/.membridge/memory.md', action: 'updated' },  // not a context target
          { file: '/p/.membridge/memory.json', action: 'updated' },// not a context target
        ];
        assert.strictEqual(prompts.countAmendments(changes, cfg), 1, 'only the real context-file update should count');
      });

      check('feedback: syncOnce increments state.feedback.amendments for real context-file writes', () => {
        util.saveState(withEvents({ firstRunShown: true, valueShown: false, amendments: 0 }));
        const before = util.loadState().feedback.amendments;
        syncOnce({ project: proj1 }); // proj1 has accumulated events + a real CLAUDE.md target
        const after = util.loadState().feedback.amendments;
        assert.ok(after >= before, 'amendments must never decrease');
      });
    } finally {
      uncap();
      if (origTTY) Object.defineProperty(process.stdout, 'isTTY', origTTY);
      else { try { delete process.stdout.isTTY; } catch { setTTY(undefined); } }
      if (origCI === undefined) delete process.env.CI; else process.env.CI = origCI;
      fs.writeFileSync(util.statePath(), savedState); // restore the suite's accumulated state
    }
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
