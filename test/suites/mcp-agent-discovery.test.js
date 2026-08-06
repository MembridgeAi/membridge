'use strict';
// Extracted verbatim from test/run-tests.js. Shared plumbing lives in
// test/harness.js; run this file directly, or via `node test/run.js mcp-agent-discovery`.
// ---- MCP agent config discovery (mcp spec §4.1) ----
//
// NO_UNOWNED_FILE_READS: os.homedir() only appears in an assertion that a resolver's returned path equals path.join(os.homedir(), '.codex'). No fs.<read> uses that path. See test/suites/tests-own-their-state.test.js.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT, P, BIN, jsonl, read, readSource, count, notRoot, realCanon,
  startJsonMock, waitForHttp, post, httpGet, httpPost } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('../../lib/util');

async function main() {
  // ---- MCP agent config discovery (mcp spec §4.1) ----
  const agentConfig = require('../../lib/agent-config');

  {
    const acRoot = path.join(ROOT, 'agentcfg');
    const mkHome = name => {
      const h = path.join(acRoot, name);
      fs.mkdirSync(h, { recursive: true });
      return h;
    };

    check('agent-config: default locations under a bare home', () => {
      const home = mkHome('bare');
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      const r = agentConfig.resolveAgentConfig('codex', { home, env: {}, config: {} });
      assert.strictEqual(r.source, 'default');
      assert.strictEqual(r.file, path.join(home, '.codex', 'config.toml'));
      assert.strictEqual(r.exists, true);
    });

    check('agent-config: a missing agent directory reports exists:false, not null', () => {
      const home = mkHome('empty');
      const r = agentConfig.resolveAgentConfig('cursor', { home, env: {}, config: {} });
      assert.ok(r, 'must still resolve a candidate path');
      assert.strictEqual(r.exists, false);
    });

    check('agent-config: the tool\'s own env var beats the default', () => {
      const home = mkHome('envvar');
      const moved = path.join(acRoot, 'moved-codex');
      fs.mkdirSync(moved, { recursive: true });
      const r = agentConfig.resolveAgentConfig('codex', { home, env: { CODEX_HOME: moved }, config: {} });
      assert.strictEqual(r.source, 'env');
      assert.strictEqual(r.dir, moved);
      assert.strictEqual(r.exists, true);
    });

    check('agent-config: MemBridge config override beats everything', () => {
      const home = mkHome('override');
      const custom = path.join(acRoot, 'custom', 'my.toml');
      fs.mkdirSync(path.dirname(custom), { recursive: true });
      const r = agentConfig.resolveAgentConfig('codex', {
        home, env: { CODEX_HOME: path.join(acRoot, 'moved-codex') },
        config: { mcp: { codex: { configPath: custom } } },
      });
      assert.strictEqual(r.source, 'config');
      assert.strictEqual(r.file, custom);
    });

    check('agent-config: XDG_CONFIG_HOME is honoured on linux', () => {
      const home = mkHome('xdg');
      const xdg = path.join(acRoot, 'xdgroot');
      fs.mkdirSync(path.join(xdg, 'cursor'), { recursive: true });
      const r = agentConfig.resolveAgentConfig('cursor', {
        home, env: { XDG_CONFIG_HOME: xdg }, config: {}, platform: 'linux',
      });
      assert.strictEqual(r.source, 'xdg');
      assert.strictEqual(r.dir, path.join(xdg, 'cursor'));
    });

    check('agent-config: XDG is ignored on darwin (it is not the convention there)', () => {
      const home = mkHome('xdgmac');
      const xdg = path.join(acRoot, 'xdgroot');
      const r = agentConfig.resolveAgentConfig('cursor', {
        home, env: { XDG_CONFIG_HOME: xdg }, config: {}, platform: 'darwin',
      });
      assert.strictEqual(r.source, 'default');
      assert.strictEqual(r.dir, path.join(home, '.cursor'));
    });

    check('agent-config: installedAgents lists only agents whose dir exists', () => {
      const home = mkHome('mixed');
      fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
      const list = agentConfig.installedAgents({ home, env: {}, config: {}, platform: 'darwin' });
      const names = list.map(a => a.agent).sort();
      assert.deepStrictEqual(names, ['codex']);
    });

    check('agent-config: an unknown agent is null, never a guessed path', () => {
      assert.strictEqual(agentConfig.resolveAgentConfig('nonesuch', { home: mkHome('u'), env: {}, config: {} }), null);
    });

    check('agent-config: every known agent resolves to a file, never a bare dir', () => {
      const home = mkHome('all');
      for (const a of agentConfig.AGENTS) {
        const r = agentConfig.resolveAgentConfig(a, { home, env: {}, config: {}, platform: 'darwin' });
        assert.ok(r && r.file && path.isAbsolute(r.file), `${a} must resolve an absolute file path`);
      }
    });

    // --- regressions for defects found while verifying the plan's SPECS table ---

    // util.homeDir() is MEMBRIDGE's home (~/.membridge, or MEMBRIDGE_HOME), NOT
    // the OS home. Falling back to it would resolve ~/.membridge/.codex/config.toml
    // in production -- a path Codex will never read. Tests always inject `home`,
    // so only a test that omits it can catch this. The suite sets MEMBRIDGE_HOME
    // to a temp dir, which makes the wrong answer trivially detectable.
    check('agent-config: the real-home fallback is the OS home, not MemBridge home', () => {
      assert.ok(process.env.MEMBRIDGE_HOME, 'suite must have MEMBRIDGE_HOME set for this to mean anything');
      const r = agentConfig.resolveAgentConfig('codex', { env: {}, config: {}, platform: 'darwin' });
      assert.strictEqual(r.dir, path.join(os.homedir(), '.codex'));
      assert.ok(!r.dir.startsWith(process.env.MEMBRIDGE_HOME), 'must not resolve under MemBridge home');
    });

    // Verified behaviourally 2026-07-29: `CLAUDE_CONFIG_DIR=<d> claude mcp list`
    // creates <d>/.claude.json. The dotted name is the real one; the plan's
    // table said `claude.json`.
    check('agent-config: CLAUDE_CONFIG_DIR holds a dot-prefixed .claude.json', () => {
      const dir = path.join(acRoot, 'ccd');
      fs.mkdirSync(dir, { recursive: true });
      const r = agentConfig.resolveAgentConfig('claude-code', {
        home: mkHome('ccdhome'), env: { CLAUDE_CONFIG_DIR: dir }, config: {}, platform: 'darwin',
      });
      assert.strictEqual(r.source, 'env');
      assert.strictEqual(r.file, path.join(dir, '.claude.json'));
    });

    // By default Claude Code's config is ~/.claude.json -- a SIBLING of ~/.claude,
    // not a file inside it. ~/.claude is still the right install-detection
    // directory, so dir and file legitimately diverge here.
    check('agent-config: claude-code defaults to ~/.claude.json beside ~/.claude, not inside it', () => {
      const home = mkHome('claudedefault');
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      const r = agentConfig.resolveAgentConfig('claude-code', { home, env: {}, config: {}, platform: 'darwin' });
      assert.strictEqual(r.source, 'default');
      assert.strictEqual(r.dir, path.join(home, '.claude'));
      assert.strictEqual(r.file, path.join(home, '.claude.json'));
      assert.strictEqual(r.exists, true);
    });

    // Verified 2026-07-29 against the real binary: with XDG_CONFIG_HOME set,
    // `codex doctor` still reported CODEX_HOME as ~/.codex. Codex has no XDG
    // support for its own home, so writing $XDG_CONFIG_HOME/codex/config.toml on
    // Linux would leave a file Codex never reads.
    check('agent-config: codex ignores XDG even on linux (it has no XDG support)', () => {
      const home = mkHome('codexxdg');
      const xdg = path.join(acRoot, 'xdgroot');
      // The XDG codex dir must EXIST, or the exists-guard in step 3 would make
      // this pass even for a spec that wrongly claimed xdg: 'codex'.
      fs.mkdirSync(path.join(xdg, 'codex'), { recursive: true });
      const r = agentConfig.resolveAgentConfig('codex', {
        home, env: { XDG_CONFIG_HOME: xdg }, config: {}, platform: 'linux',
      });
      assert.strictEqual(r.source, 'default');
      assert.strictEqual(r.file, path.join(home, '.codex', 'config.toml'));
    });

    // Every envVar left in the table must be one a tool actually honours.
    check('agent-config: no fabricated env var survives in SPECS', () => {
      const verified = { 'claude-code': 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', cursor: 'CURSOR_CONFIG_DIR' };
      for (const a of agentConfig.AGENTS) {
        assert.strictEqual(agentConfig.SPECS[a].envVar, verified[a] || null, `${a} envVar must be verified or null`);
      }
    });

    // A tool that gains an env var later, or renames one and keeps the old
    // name alive, must be a one-line data edit -- never a code change.
    check('agent-config: envVar accepts a list, first one set wins', () => {
      const home = mkHome('envlist');
      const moved = path.join(acRoot, 'moved-legacy');
      fs.mkdirSync(moved, { recursive: true });
      const saved = agentConfig.SPECS.codex.envVar;
      try {
        agentConfig.SPECS.codex.envVar = ['CODEX_HOME_NEW', 'CODEX_HOME'];
        const r = agentConfig.resolveAgentConfig('codex', { home, env: { CODEX_HOME: moved }, config: {} });
        assert.strictEqual(r.source, 'env');
        assert.strictEqual(r.dir, moved);
      } finally { agentConfig.SPECS.codex.envVar = saved; }
    });

    // A null envVar (the honest answer for a tool with none) must simply fall
    // through, not throw and not read a variable literally named "null".
    check('agent-config: a null envVar falls through to the default', () => {
      const home = mkHome('nullenv');
      const saved = agentConfig.SPECS.codex.envVar;
      try {
        agentConfig.SPECS.codex.envVar = null;
        const r = agentConfig.resolveAgentConfig('codex', { home, env: { CODEX_HOME: '/nope' }, config: {} });
        assert.strictEqual(r.source, 'default');
        assert.strictEqual(r.dir, path.join(home, '.codex'));
      } finally { agentConfig.SPECS.codex.envVar = saved; }
    });

    // A Linux user with XDG_CONFIG_HOME set (most of them) but Cursor installed
    // at ~/.cursor must still be found. Resolving an empty XDG path would report
    // exists:false and silently skip the agent forever.
    check('agent-config: XDG is skipped when the XDG dir does not exist, so ~/.cursor still wins', () => {
      const home = mkHome('xdgmissing');
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
      const r = agentConfig.resolveAgentConfig('cursor', {
        home, env: { XDG_CONFIG_HOME: path.join(acRoot, 'no-such-xdg') }, config: {}, platform: 'linux',
      });
      assert.strictEqual(r.source, 'default');
      assert.strictEqual(r.dir, path.join(home, '.cursor'));
      assert.strictEqual(r.exists, true);
    });

    // The registrar must dispatch on data, never on `switch (agent)`.
    check('agent-config: every resolution carries a format', () => {
      const home = mkHome('fmt');
      const want = { 'claude-code': 'claude-cli', codex: 'toml', cursor: 'json' };
      for (const a of agentConfig.AGENTS) {
        const r = agentConfig.resolveAgentConfig(a, { home, env: {}, config: {}, platform: 'darwin' });
        assert.strictEqual(r.format, want[a], `${a} must carry its write format`);
      }
    });

    // There will always be more agents than MemBridge has been taught. Someone
    // on a tool we have not added should not be stuck waiting for a release.
    check('agent-config: a user can declare an agent MemBridge has never heard of', () => {
      const home = mkHome('windsurf');
      const dir = path.join(acRoot, 'windsurf-cfg');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'mcp_config.json');
      const config = { mcp: { windsurf: { configPath: file } } };
      const r = agentConfig.resolveAgentConfig('windsurf', { home, env: {}, config, platform: 'darwin' });
      assert.strictEqual(r.source, 'config');
      assert.strictEqual(r.file, file);
      assert.strictEqual(r.format, 'json', 'format must be inferred from the extension');
      assert.strictEqual(r.exists, true);
      assert.ok(agentConfig.knownAgents({ config }).includes('windsurf'));
      assert.ok(agentConfig.installedAgents({ home, env: {}, config, platform: 'darwin' })
        .some(a => a.agent === 'windsurf'), 'a declared, present agent must be installed');
      assert.deepStrictEqual(agentConfig.AGENTS, ['claude-code', 'codex', 'cursor'],
        'AGENTS stays the built-in list; user agents arrive via knownAgents');
    });

    // An extension we cannot read is format:null, not a guess. The registrar
    // reports it rather than writing a file in the wrong syntax.
    check('agent-config: a declared agent with an unknown extension gets format:null, never a guess', () => {
      const home = mkHome('weirdext');
      const file = path.join(acRoot, 'weird-cfg', 'servers.conf');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const r = agentConfig.resolveAgentConfig('zed', { home, env: {}, config: { mcp: { zed: { configPath: file } } } });
      assert.strictEqual(r.format, null);
      const explicit = agentConfig.resolveAgentConfig('zed', {
        home, env: {}, config: { mcp: { zed: { configPath: file, format: 'json' } } },
      });
      assert.strictEqual(explicit.format, 'json', 'an explicit format must be honoured');
    });

    // config.mcp also holds plain knobs (autoRegister, claudeBin). None of them
    // may be mistaken for a user-declared agent.
    check('agent-config: non-agent keys under config.mcp are not treated as agents', () => {
      const config = { mcp: { autoRegister: false, claudeBin: '/usr/local/bin/claude' } };
      assert.deepStrictEqual(agentConfig.knownAgents({ config }), ['claude-code', 'codex', 'cursor']);
      assert.strictEqual(agentConfig.resolveAgentConfig('autoRegister', { home: mkHome('knobs'), env: {}, config }), null);
    });
  }

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
