'use strict';
// Extracted verbatim from test/run-tests.js. Shared plumbing lives in
// test/harness.js; run this file directly, or via `node test/run.js mcp-config`.
// ---- MCP JSON config merge (mcp spec §5.3) ----
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, BIN, jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

async function main() {
  // ---- MCP JSON config merge (mcp spec §5.3) ----
  const mcpJson = require('../../lib/mcp-json');

  {
    const jRoot = path.join(ROOT, 'mcpjson');
    fs.mkdirSync(jRoot, { recursive: true });
    const ENTRY = { command: '/usr/bin/node', args: ['/opt/membridge/bin/membridge.js', 'mcp'] };

    check('mcp-json: a missing file reads as empty-but-writable', () => {
      const r = mcpJson.readConfig(path.join(jRoot, 'absent.json'));
      assert.ok(r, 'a missing file is writable, not a refusal');
      assert.strictEqual(r.existed, false);
      assert.deepStrictEqual(r.data, {});
    });

    check('mcp-json: invalid JSON is a REFUSAL (null), never treated as empty', () => {
      const f = path.join(jRoot, 'broken.json');
      fs.writeFileSync(f, '{not json');
      assert.strictEqual(mcpJson.readConfig(f), null);
    });

    check('mcp-json: mcpServers present but not an object is a refusal', () => {
      const f = path.join(jRoot, 'wrongshape.json');
      fs.writeFileSync(f, JSON.stringify({ mcpServers: ['nope'] }));
      assert.strictEqual(mcpJson.readConfig(f), null);
    });

    check('mcp-json: a file holding literally null is a refusal', () => {
      const f = path.join(jRoot, 'null.json');
      fs.writeFileSync(f, 'null\n');
      assert.strictEqual(mcpJson.readConfig(f), null);
    });

    check('mcp-json: a config with no mcpServers key at all is usable, not a refusal', () => {
      const f = path.join(jRoot, 'nokey.json');
      fs.writeFileSync(f, JSON.stringify({ somethingElse: true }));
      const r = mcpJson.readConfig(f);
      assert.ok(r, 'an absent mcpServers key is a config we can add to');
      assert.strictEqual(r.existed, true);
      assert.strictEqual(r.data.somethingElse, true);
      const { data, changed } = mcpJson.upsertServer(r.data, 'membridge', ENTRY);
      assert.strictEqual(changed, true);
      assert.strictEqual(data.somethingElse, true, 'the rest of their config must survive');
      assert.deepStrictEqual(data.mcpServers.membridge, ENTRY);
    });

    // The clobber this module exists to prevent. readConfig must not decide
    // "missing" from "readFileSync threw" — only ENOENT is missing. A config
    // we cannot READ can still be renamed over (rename needs the directory
    // writable, not the file), so mis-reading it as {} destroys it.
    check('mcp-json: an existing but unreadable config is a refusal, never "missing"', () => {
      const asDir = path.join(jRoot, 'isdir.json');
      fs.mkdirSync(asDir, { recursive: true });
      assert.strictEqual(mcpJson.readConfig(asDir), null, 'a directory in the config slot is not an absent file');

      const locked = path.join(jRoot, 'locked.json');
      fs.writeFileSync(locked, JSON.stringify({ mcpServers: { theirs: { command: 'x' } } }));
      fs.chmodSync(locked, 0o000);
      let unreadable = false;
      try { fs.readFileSync(locked, 'utf8'); } catch { unreadable = true; }
      try {
        // root can read anything, so only assert where the OS actually denied us
        if (unreadable) assert.strictEqual(mcpJson.readConfig(locked), null, 'an unreadable config must never read as empty-and-writable');
      } finally {
        fs.chmodSync(locked, 0o600);
      }
    });

    check('mcp-json: upsert adds ours and preserves foreign servers', () => {
      const { data, changed } = mcpJson.upsertServer({ mcpServers: { other: { command: 'x' } }, unrelated: 7 }, 'membridge', ENTRY);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(data.mcpServers.other, { command: 'x' });
      assert.strictEqual(data.unrelated, 7, 'unrelated top-level keys must survive');
      assert.deepStrictEqual(data.mcpServers.membridge, ENTRY);
    });

    check('mcp-json: upsert is idempotent', () => {
      const first = mcpJson.upsertServer({}, 'membridge', ENTRY);
      const second = mcpJson.upsertServer(first.data, 'membridge', ENTRY);
      assert.strictEqual(second.changed, false);
    });

    check('mcp-json: upsert updates a stale command', () => {
      const stale = { mcpServers: { membridge: { command: '/old/node', args: [] } } };
      const { data, changed } = mcpJson.upsertServer(stale, 'membridge', ENTRY);
      assert.strictEqual(changed, true);
      assert.strictEqual(data.mcpServers.membridge.command, '/usr/bin/node');
    });

    check('mcp-json: upsert leaves the caller\'s config untouched', () => {
      const theirs = Object.freeze({ mcpServers: Object.freeze({ other: Object.freeze({ command: 'x' }) }) });
      const { changed } = mcpJson.upsertServer(theirs, 'membridge', ENTRY);
      assert.strictEqual(changed, true);
      assert.deepStrictEqual(theirs.mcpServers, { other: { command: 'x' } }, 'a caller that then refuses to write must be holding what it started with');
    });

    check('mcp-json: removeServer only removes what isOurs approves', () => {
      // The real shape: node is the command, OUR path lives in argv. Ownership
      // therefore has to look at the whole invocation (mcp spec §5.4).
      const isOurs = e => [e.command, ...(e.args || [])].some(s => /(^|\/)bin\/membridge\.js$/.test(String(s)));

      const unrelated = { command: '/somebody/elses/thing' };
      const kept = mcpJson.removeServer({ mcpServers: { membridge: unrelated, other: { command: 'x' } } }, 'membridge', isOurs);
      assert.strictEqual(kept.changed, false, 'a foreign server merely NAMED membridge must survive');
      assert.deepStrictEqual(kept.data.mcpServers.membridge, unrelated, 'and must still be present in the returned config');

      // The nastier foreign case: it name-drops membridge but is not our binary.
      const lookalike = { command: '/usr/bin/node', args: ['/home/them/my-membridge-helper.js'] };
      const kept2 = mcpJson.removeServer({ mcpServers: { membridge: lookalike } }, 'membridge', isOurs);
      assert.strictEqual(kept2.changed, false, 'merely mentioning membridge is not ownership');
      assert.deepStrictEqual(kept2.data.mcpServers.membridge, lookalike);

      const ours = mcpJson.removeServer({ mcpServers: { membridge: ENTRY, other: { command: 'x' } } }, 'membridge', isOurs);
      assert.strictEqual(ours.changed, true);
      assert.strictEqual(ours.data.mcpServers.membridge, undefined);
      assert.deepStrictEqual(ours.data.mcpServers.other, { command: 'x' }, 'removing ours must not disturb theirs');
    });

    // Asserting "no strays" alone proves nothing — a plain writeFileSync never
    // makes a temp file either, so that test passes against the non-atomic
    // implementation (measured). Watch the rename instead: the complete bytes
    // must already be staged in a SIBLING temp when it fires, and the
    // destination must not have been touched before then.
    check('mcp-json: write stages the whole file in a sibling temp and lands it by rename', () => {
      const f = path.join(jRoot, 'out.json');
      const payload = { mcpServers: { membridge: ENTRY } };
      const expected = `${JSON.stringify(payload, null, 2)}\n`;
      const realRename = fs.renameSync;
      const renames = [];
      fs.renameSync = (from, to) => {
        renames.push({ from, to, staged: fs.readFileSync(from, 'utf8'), destExisted: fs.existsSync(to) });
        return realRename(from, to);
      };
      try {
        mcpJson.writeConfig(f, payload);
      } finally {
        fs.renameSync = realRename;
      }
      assert.strictEqual(renames.length, 1, 'the config must arrive via exactly one rename, not a direct write');
      assert.strictEqual(renames[0].to, f);
      assert.strictEqual(path.dirname(renames[0].from), path.dirname(f), 'the temp must be a sibling — a cross-filesystem rename is not atomic');
      assert.ok(/\.tmp$/.test(renames[0].from), `temp file should be marked .tmp, got ${renames[0].from}`);
      assert.strictEqual(renames[0].staged, expected, 'every byte must be staged BEFORE the rename');
      assert.strictEqual(renames[0].destExisted, false, 'nothing may be written at the destination before the rename');
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers.membridge, ENTRY);
      const strays = fs.readdirSync(jRoot).filter(n => n.includes('.tmp'));
      assert.deepStrictEqual(strays, []);
    });

    check('mcp-json: write creates missing parent directories', () => {
      const f = path.join(jRoot, 'deep', 'nested', 'mcp.json');
      mcpJson.writeConfig(f, { mcpServers: {} });
      assert.ok(fs.existsSync(f));
    });
  }

  // ---- Codex TOML block surgery (mcp spec §5.2) ----
  const mcpToml = require('../../lib/mcp-toml');

  {
    // A fixture with the shapes that actually break naive parsers.
    const REAL = [
      '# my codex config',
      '[plugins."github@openai-curated"]',
      'enabled = true',
      '',
      '[projects."/Users/marco/Documents/AI Shit/CopyNigga"]',
      'trust = "full"',
      '',
      '[mcp_servers.node_repl]',
      'command = "node"',
      '',
      '[mcp_servers.node_repl.env]',
      'FOO = "bar"',
      '',
    ].join('\n');

    const BLOCK = ['command = "/usr/bin/node"', 'args = ["/opt/membridge/bin/membridge.js", "mcp"]'];

    check('mcp-toml: appends a new block and leaves every other byte alone', () => {
      const { text, changed } = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK);
      assert.strictEqual(changed, true);
      assert.ok(text.startsWith(REAL), 'existing content must be a byte-identical prefix');
      assert.ok(text.includes('[mcp_servers.membridge]'));
      assert.ok(text.includes('args = ["/opt/membridge/bin/membridge.js", "mcp"]'));
    });

    check('mcp-toml: quoted keys with spaces, slashes and @ survive verbatim', () => {
      const { text } = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK);
      assert.ok(text.includes('[plugins."github@openai-curated"]'), 'the @ key must be untouched');
      assert.ok(text.includes('[projects."/Users/marco/Documents/AI Shit/CopyNigga"]'), 'the spaced path key must be untouched');
      assert.ok(text.includes('# my codex config'), 'comments must survive');
    });

    check('mcp-toml: replaces only our block, keeping neighbours', () => {
      const once = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK).text;
      const twice = mcpToml.upsertBlock(once, 'mcp_servers.membridge', ['command = "/new/node"']);
      assert.strictEqual(twice.changed, true);
      assert.strictEqual((twice.text.match(/\[mcp_servers\.membridge\]/g) || []).length, 1, 'exactly one block');
      assert.ok(twice.text.includes('command = "/new/node"'));
      assert.ok(!twice.text.includes('/usr/bin/node'), 'the old body must be gone');
      assert.ok(twice.text.includes('[mcp_servers.node_repl]'), 'the neighbouring server must survive');
      assert.ok(twice.text.includes('FOO = "bar"'), 'its sub-table must survive');
    });

    check('mcp-toml: re-running with identical content reports changed:false', () => {
      const once = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK).text;
      const again = mcpToml.upsertBlock(once, 'mcp_servers.membridge', BLOCK);
      assert.strictEqual(again.changed, false, 'idempotent: no rewrite when nothing differs');
      assert.strictEqual(again.text, once);
    });

    check('mcp-toml: a block at end of file replaces cleanly', () => {
      const atEnd = REAL + '\n[mcp_servers.membridge]\ncommand = "old"\n';
      const { text } = mcpToml.upsertBlock(atEnd, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.includes('command = "new"'));
      assert.ok(!text.includes('command = "old"'));
      assert.strictEqual((text.match(/\[mcp_servers\.membridge\]/g) || []).length, 1);
    });

    check('mcp-toml: our own sub-table is replaced with the block, not orphaned', () => {
      const withSub = REAL + '\n[mcp_servers.membridge]\ncommand = "old"\n\n[mcp_servers.membridge.env]\nA = "1"\n\n[other]\nx = 1\n';
      const { text } = mcpToml.upsertBlock(withSub, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(!text.includes('A = "1"'), 'our stale sub-table must not survive');
      assert.ok(text.includes('[other]'), 'a foreign table after it must survive');
    });

    check('mcp-toml: findBlock returns null when absent', () => {
      assert.strictEqual(mcpToml.findBlock(REAL, 'mcp_servers.membridge'), null);
    });

    check('mcp-toml: removeBlock strips only ours', () => {
      const once = mcpToml.upsertBlock(REAL, 'mcp_servers.membridge', BLOCK).text;
      const { text, changed } = mcpToml.removeBlock(once, 'mcp_servers.membridge');
      assert.strictEqual(changed, true);
      assert.ok(!text.includes('[mcp_servers.membridge]'));
      assert.ok(text.includes('[mcp_servers.node_repl]'));
    });

    check('mcp-toml: empty input yields just our block', () => {
      const { text } = mcpToml.upsertBlock('', 'mcp_servers.membridge', BLOCK);
      assert.ok(text.trim().startsWith('[mcp_servers.membridge]'));
    });

    // ---- shapes a real config contains that naive line-scanning gets wrong ----

    // Windows is explicitly in scope (Global Constraints: "Cover Linux (XDG)
    // and Windows"). A CRLF file whose header we fail to SEE is not a cosmetic
    // bug: we append a second [mcp_servers.membridge], and a duplicate table is
    // a TOML parse error -- we would break the config we were registering into.
    check('mcp-toml: CRLF line endings -- our block is replaced, not duplicated', () => {
      const crlf = '# c\r\n[mcp_servers.membridge]\r\ncommand = "old"\r\n\r\n[other]\r\nx = 1\r\n';
      const { text, changed } = mcpToml.upsertBlock(crlf, 'mcp_servers.membridge', ['command = "new"']);
      assert.strictEqual(changed, true);
      assert.strictEqual((text.match(/\[mcp_servers\.membridge\]/g) || []).length, 1, 'exactly one block, not an appended duplicate');
      assert.ok(!text.includes('command = "old"'), 'the old body must be gone');
      assert.ok(text.includes('[other]\r\nx = 1\r\n'), "the neighbour's CRLF bytes must survive");
      assert.ok(!/[^\r]\n/.test(text), 'no bare LF may be introduced into a CRLF file');
      const again = mcpToml.upsertBlock(text, 'mcp_servers.membridge', ['command = "new"']);
      assert.strictEqual(again.changed, false, 'CRLF upsert must be idempotent too');
    });

    // The whole point of the module: bytes we did not write are not ours to
    // reformat. A user's double blank line is a byte outside our block.
    check('mcp-toml: blank-line runs elsewhere in the file are not reflowed', () => {
      const spaced = '[alpha]\na = 1\n\n\n[beta]\nb = 2\n\n[mcp_servers.membridge]\ncommand = "old"\n\n[gamma]\ng = 1\n';
      const { text } = mcpToml.upsertBlock(spaced, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.includes('a = 1\n\n\n[beta]'), "the user's double blank line must survive untouched");
      assert.ok(text.startsWith('[alpha]\na = 1\n\n\n[beta]\nb = 2\n\n'), 'everything before our block must be a byte-identical prefix');
      assert.ok(text.endsWith('[gamma]\ng = 1\n'), 'everything after our block must be byte-identical');
    });

    // A header we fail to RECOGNISE is swallowed into our span and deleted.
    // Both of these are legal TOML and both terminate our block.
    check('mcp-toml: a trailing comment on the next header does not swallow it', () => {
      const src = '[mcp_servers.membridge]\ncommand = "old"\n\n[keepme] # do not touch\nk = 1\n';
      const { text } = mcpToml.upsertBlock(src, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.includes('[keepme] # do not touch'), 'a commented header must survive verbatim');
      assert.ok(text.includes('k = 1'), 'its body must survive');
    });

    check('mcp-toml: an indented next header does not swallow it', () => {
      const src = '[mcp_servers.membridge]\ncommand = "old"\n\n  [keepme]\n  k = 1\n';
      const { text } = mcpToml.upsertBlock(src, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.includes('  [keepme]'), 'an indented header must survive verbatim');
      assert.ok(text.includes('  k = 1'), 'its body must survive');
    });

    // The dot boundary is what makes prefix matching safe; without a test the
    // comment claiming it is just a comment.
    check('mcp-toml: a name that merely shares our prefix is not ours', () => {
      const src = '[mcp_servers.membridge]\ncommand = "old"\n\n[mcp_servers.membridgeous]\nmine = false\n';
      const { text } = mcpToml.upsertBlock(src, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.includes('[mcp_servers.membridgeous]'), 'a lookalike server must not be absorbed');
      assert.ok(text.includes('mine = false'));
      assert.strictEqual(mcpToml.findBlock('[mcp_servers.membridgeous]\nx = 1\n', 'mcp_servers.membridge'), null);
    });

    // A `[` at the start of a line inside a multi-line array is not a table.
    check('mcp-toml: a multi-line array in a neighbour is not mistaken for a table', () => {
      const arr = '[neighbour]\nmatrix = [\n  ["a", "b"],\n  ["c", "d"]\n]\n\n[mcp_servers.membridge]\ncommand = "old"\n';
      const { text } = mcpToml.upsertBlock(arr, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.includes('matrix = [\n  ["a", "b"],\n  ["c", "d"]\n]'), 'the array must survive verbatim');
      assert.ok(text.includes('command = "new"'));
      assert.ok(!text.includes('command = "old"'));
    });

    check('mcp-toml: a file with no trailing newline is replaced cleanly', () => {
      const noNl = '[alpha]\na = 1\n\n[mcp_servers.membridge]\ncommand = "old"';
      const { text } = mcpToml.upsertBlock(noNl, 'mcp_servers.membridge', ['command = "new"']);
      assert.ok(text.startsWith('[alpha]\na = 1\n\n'), 'the neighbour must survive byte-identically');
      assert.strictEqual((text.match(/\[mcp_servers\.membridge\]/g) || []).length, 1);
      assert.ok(text.includes('command = "new"'));
      assert.ok(!text.includes('command = "old"'));
    });
  }

  // ---- MCP dependencies ship by default (mcp spec §7) ----
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));

    check('mcp-deps: the SDK and zod are real dependencies, not opt-in', () => {
      assert.ok(pkg.dependencies['@modelcontextprotocol/sdk'], '@modelcontextprotocol/sdk must be a dependency');
      assert.ok(pkg.dependencies.zod, 'zod must be a dependency');
    });

    check('mcp-deps: prepublishOnly no longer side-installs them', () => {
      const pre = pkg.scripts.prepublishOnly || '';
      assert.ok(!/modelcontextprotocol/.test(pre), 'prepublishOnly must not --no-save install the SDK');
      assert.ok(!/\bzod\b/.test(pre), 'prepublishOnly must not --no-save install zod');
    });

    check('mcp-deps: they resolve from a plain install', () => {
      assert.doesNotThrow(() => require.resolve('@modelcontextprotocol/sdk/server/mcp.js'));
      assert.doesNotThrow(() => require.resolve('zod'));
    });

    check('mcp-deps: lib/mcp.js no longer calls them opt-in', () => {
      const src = readSource(path.join(__dirname, '..', '..', 'lib', 'mcp.js'));
      assert.ok(!/opt-in/i.test(src), 'the opt-in message is now false and must be gone');
    });
  }

  // ---- claude binary resolution (mcp spec §5.1.1) ----
  const claudeBin = require('../../lib/claude-bin');

  {
    const cbRoot = path.join(ROOT, 'claudebin');
    fs.mkdirSync(cbRoot, { recursive: true });
    const mk = name => {
      const f = path.join(cbRoot, name);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '#!/bin/sh\n');
      return f;
    };
    const real = mk('bin/claude');
    const other = mk('elsewhere/claude');

    check('claude-bin: config override wins over everything', () => {
      const r = claudeBin.resolveClaudeBin({
        config: { mcp: { claudeBin: real } },
        recorded: other, env: {}, runShell: () => other,
      });
      assert.strictEqual(r.source, 'config');
      assert.strictEqual(r.path, real);
    });

    check('claude-bin: a recorded path is used when it still exists', () => {
      const r = claudeBin.resolveClaudeBin({ config: {}, recorded: real, env: {}, runShell: () => other });
      assert.strictEqual(r.source, 'recorded');
      assert.strictEqual(r.path, real);
    });

    check('claude-bin: a STALE recorded path is discarded, not returned', () => {
      const gone = path.join(cbRoot, 'deleted', 'claude');
      const r = claudeBin.resolveClaudeBin({ config: {}, recorded: gone, env: {}, runShell: () => other });
      assert.notStrictEqual(r && r.path, gone, 'a deleted binary must never be returned');
      assert.strictEqual(r.source, 'shell');
    });

    check('claude-bin: falls back to asking the login shell', () => {
      const r = claudeBin.resolveClaudeBin({ config: {}, recorded: null, env: {}, runShell: () => other });
      assert.strictEqual(r.source, 'shell');
      assert.strictEqual(r.path, other);
    });

    check('claude-bin: a shell that hangs or errors does not throw', () => {
      assert.doesNotThrow(() => {
        const r = claudeBin.resolveClaudeBin({
          config: {}, recorded: null, env: {},
          runShell: () => { throw new Error('timed out'); },
          candidates: [],
        });
        assert.strictEqual(r, null);
      });
    });

    check('claude-bin: probe list is the LAST resort, after the shell', () => {
      const r = claudeBin.resolveClaudeBin({
        config: {}, recorded: null, env: {},
        runShell: () => null,
        candidates: [other],
      });
      assert.strictEqual(r.source, 'probe');
      assert.strictEqual(r.path, other);
    });

    check('claude-bin: nothing found is null, never a bare "claude" guess', () => {
      const r = claudeBin.resolveClaudeBin({
        config: {}, recorded: null, env: {}, runShell: () => null, candidates: [],
      });
      assert.strictEqual(r, null);
    });

    check('claude-bin: the probe list is exported and non-empty', () => {
      assert.ok(Array.isArray(claudeBin.CANDIDATES) && claudeBin.CANDIDATES.length > 0);
    });

    // A hanging rc file is a DIFFERENT failure mode from a throwing shell: the
    // spawn returns normally with error/status set. Exercise the real
    // defaultRunShell against a stub shell so the timeout branch is covered.
    check('claude-bin: defaultRunShell returns null when the shell times out (never hangs the daemon)', () => {
      const slow = path.join(cbRoot, 'slow-shell.sh');
      fs.writeFileSync(slow, '#!/bin/sh\nsleep 30\n');
      fs.chmodSync(slow, 0o755);
      const t0 = Date.now();
      const r = claudeBin.resolveClaudeBin({
        config: {}, recorded: null, env: { SHELL: slow }, candidates: [],
      });
      assert.strictEqual(r, null, 'a shell that never answers must resolve to null');
      // The bound must sit BETWEEN the 5s timeout and the stub's 30s sleep: under
      // 30s proves the timeout actually fired rather than the sleep completing.
      // 20s looked like a comfortable 4x margin and still flaked under parallel
      // suites -- spawn plus node startup stretch a long way on a loaded box.
      // 25s keeps the discrimination (a missing timeout takes 30s+) without
      // failing for load.
      assert.ok(Date.now() - t0 < 25000, 'the shell query must be bounded by its timeout');
    });

    // A GUI-launched .app is the case this module exists for, and launchd does
    // not reliably export SHELL. Falling to /bin/sh there reads ~/.profile,
    // never ~/.zshrc -- losing exactly the version-manager shims we came for.
    check('claude-bin: with no SHELL in the env, the user record picks the shell, not /bin/sh', () => {
      assert.strictEqual(claudeBin.loginShell({ SHELL: '/opt/fish' }), '/opt/fish');
      let recorded = null;
      try { recorded = os.userInfo().shell; } catch { recorded = null; }
      assert.strictEqual(claudeBin.loginShell({}), recorded || '/bin/sh');
    });

    // The stub shell is a POSIX sh script; Windows cannot execute it (the
    // spawn fails before the stub runs), so the "noise around the answer"
    // scenario cannot be produced there at all. The login-shell query is a
    // POSIX concept to begin with -- on a real Windows install
    // resolveClaudeBin reaches this answer via config/recorded/probe instead.
    // Visible skip, keychain(win)-style, not a silent pass.
    if (process.platform === 'win32') {
      console.log('  skip  claude-bin: chatty rc file — the stub login shell is a POSIX script, not executable on win32');
    } else {
    check('claude-bin: a chatty rc file cannot displace the resolved path', () => {
      const chatty = path.join(cbRoot, 'chatty-shell.sh');
      // Emits rc-file noise on both sides of the answer, as a real .zshrc can.
      fs.writeFileSync(chatty, `#!/bin/sh\necho "nvm: using v20"\necho "${other}"\necho "welcome back"\n`);
      fs.chmodSync(chatty, 0o755);
      const r = claudeBin.resolveClaudeBin({
        config: {}, recorded: null, env: { SHELL: chatty }, candidates: [],
      });
      assert.ok(r, 'a path printed among rc-file noise must still be found');
      assert.strictEqual(r.source, 'shell');
      assert.strictEqual(r.path, other);
    });
    }
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
