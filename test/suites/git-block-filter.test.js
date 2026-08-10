'use strict';
// The git clean filter that keeps MemBridge's managed block out of the index.
// Run via `node test/run.js git-block-filter`, or directly.
//
// WHAT IS BEING PROVEN, and against REAL git (execFileSync, temp repos, a
// throwaway GIT_CONFIG_GLOBAL) rather than a mock — a mock of git would be a
// mock of exactly the behaviour in question, since the whole feature is "what
// does git store, and what does it say afterwards":
//
//   - configured   -> `git add` stores the file WITHOUT the block region, and
//                     the working-tree file is not touched at all.
//   - unconfigured -> the same `git add` stores it unchanged and exits 0. This
//                     is the property that makes committing the .gitattributes
//                     line safe for a teammate who has no MemBridge.
//   - a merge of two branches whose blocks disagree does not conflict, which
//                     is the failure this ticket exists for.
//
// AND WHAT IS NOT TRUE, pinned here so nobody has to rediscover it. `git
// status` is NOT unconditionally silent afterwards. git caches the WORKING
// TREE size in the index; when a block rewrite changes the file's byte length
// the size shortcut reports ` M` without ever running the filter. `git diff`
// (a real content comparison) is empty, the next `git add` stages nothing and
// clears the flag, and a rewrite that keeps the same length is silent
// throughout. Both halves are asserted below, so a future change that makes
// status quiet shows up as a FAILING expectation rather than as folklore.
//
// WHAT THESE CANNOT PROVE: that the filter is fast enough to sit in front of
// every `git add` on a large repo (nothing here measures it — it is one node
// startup per matched file, and only CLAUDE.md/AGENTS.md are matched); and
// nothing offline can prove the .gitattributes line behaves the same under a
// git older than the 2.39 on this machine.
//
// KNOWN_READS_UNOWNED_FILE: ~/.gitconfig — this suite calls `git config
// --global`, so it must prove it never wrote the developer's real one. A
// fixture cannot answer that question: the whole point is that the redirect to
// a temp GIT_CONFIG_GLOBAL held. Rarely written by anything else, so it is not
// the external-writer flake class the marker exists to flush out.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check, ROOT } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const gitFilter = require('../../lib/git-block-strip');
const blockSpan = require('../../lib/block-span');
const digest = require('../../lib/digest');

const { BEGIN, END } = blockSpan;
const SCRIPT = path.join(__dirname, '..', '..', 'lib', 'git-block-strip.js');
const REAL_GITCONFIG = path.join(os.homedir(), '.gitconfig');
const realGitconfigBefore = (() => {
  try { return fs.readFileSync(REAL_GITCONFIG, 'utf8'); } catch { return null; }
})();

// Every git invocation in this suite is redirected away from the developer's
// own config, both directions. GIT_CONFIG_GLOBAL is what makes `git config
// --global` — the real production code path, not a test-only branch — land in
// a throwaway file.
const GIT_HOME = path.join(ROOT, 'gitconfig');
const gitEnv = (globalFile = GIT_HOME) => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: globalFile,
  GIT_CONFIG_SYSTEM: path.join(ROOT, 'gitconfig-system'),
  GIT_AUTHOR_NAME: 'Filter Test', GIT_AUTHOR_EMAIL: 'filter@test.dev',
  GIT_COMMITTER_NAME: 'Filter Test', GIT_COMMITTER_EMAIL: 'filter@test.dev',
});
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const gitTry = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
};

let repoSeq = 0;
/** A fresh git repo with `.gitattributes` already routing CLAUDE.md at us. */
function newRepo(attributes = true) {
  const dir = path.join(ROOT, `repo-${++repoSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', '.');
  if (attributes) gitFilter.writeAttributes(dir, ['CLAUDE.md', 'AGENTS.md']);
  return dir;
}

const block = body => `${BEGIN}\n${body}\n${END}`;
const withBlock = (before, body) => `${before}\n\n${block(body)}\n`;
const stored = (dir, p = 'CLAUDE.md') => git(dir, 'cat-file', '-p', `:${p}`);

// The production entry point, driven exactly as git drives it: our script's
// path on argv, bytes on stdin, bytes on stdout.
function runFilterProcess(input) {
  const r = spawnSync(process.execPath, [SCRIPT], { input, encoding: null });
  assert.strictEqual(r.status, 0, `the filter must always exit 0, got ${r.status}: ${r.stderr}`);
  return r.stdout;
}

async function main() {
  // -------------------------------------------------------------------------
  // The filter's own contract, before any git is involved.

  check('a file with no block passes through byte-identical, even when it is not valid UTF-8', () => {
    const text = Buffer.from('# rules\n\nno block here\n', 'utf8');
    assert.deepStrictEqual(runFilterProcess(text), text);
    // 0x80 alone is invalid UTF-8; decoding it would replace it with U+FFFD.
    const binary = Buffer.from([0x23, 0x20, 0x72, 0x80, 0xfe, 0x0a]);
    assert.deepStrictEqual(runFilterProcess(binary), binary,
      'a buffer with no begin marker must never be decoded, let alone re-encoded');
  });

  check('the block region is removed and the file collapses to its pre-injection bytes', () => {
    const before = '# My rules\n\nBe nice.\n';
    const file = path.join(ROOT, 'parity.md');
    fs.writeFileSync(file, before);
    // Build the fixture with the real writer, then strip it with the real
    // remover, so "pre-injection bytes" is not this test's opinion of them.
    digest.inject(file, block('## Shared AI memory\nstuff'));
    const injected = fs.readFileSync(file);
    assert.notStrictEqual(injected.toString('utf8'), before, 'fixture did not actually inject');
    assert.strictEqual(runFilterProcess(injected).toString('utf8'), before);
  });

  check('the filter agrees with digest.removeBlock — the two strippers may not drift', () => {
    for (const body of ['one line', '## Shared AI memory\n\nmulti\nline\n\nbody']) {
      for (const before of ['# rules\n\nprose\n', '# rules\n', 'a\n\nb\n\nc\n']) {
        const file = path.join(ROOT, `parity-${repoSeq++}.md`);
        fs.writeFileSync(file, before);
        digest.inject(file, block(body));
        const injected = fs.readFileSync(file);
        digest.removeBlock(file);
        const removed = fs.readFileSync(file, 'utf8');
        assert.strictEqual(runFilterProcess(injected).toString('utf8'), removed,
          `filter and digest.removeBlock disagree for ${JSON.stringify(before)} + ${JSON.stringify(body)}`);
      }
    }
  });

  check('a DUPLICATED block (what a merge of a tracked CLAUDE.md produces) loses both blocks and keeps the lines between them', () => {
    const text = `# rules\n\n${block('first')}\n\nmy own paragraph\n\n${block('second')}\n`;
    const out = runFilterProcess(Buffer.from(text)).toString('utf8');
    assert.strictEqual(out.includes(BEGIN), false, 'a managed block survived');
    assert.strictEqual(out.includes(END), false, 'a managed end marker survived');
    assert.match(out, /my own paragraph/,
      'the user\'s lines BETWEEN the two blocks were eaten — that is the first-BEGIN-to-last-END bug block-span exists to prevent');
    assert.match(out, /# rules/);
  });

  check('a FORGED end marker inside the block does not leave the block\'s tail in the index', () => {
    // block-span closes at the last END before the next BEGIN, so the smuggled
    // marker does not end the block early and the whole region still goes.
    const text = `# rules\n\n${BEGIN}\nsafe\n${END}\nsmuggled tail\n${END}\n`;
    const out = runFilterProcess(Buffer.from(text)).toString('utf8');
    assert.strictEqual(out.includes('smuggled tail'), false,
      'content between a forged END and the real END leaked into the filtered output');
    assert.strictEqual(out.includes(BEGIN), false);
  });

  check('prose that merely MENTIONS the markers mid-line is not treated as a block', () => {
    const text = `# rules\n\nwe keep memory between ${BEGIN} and ${END} in this file.\n`;
    assert.strictEqual(runFilterProcess(Buffer.from(text)).toString('utf8'), text,
      'a marker that does not own its line must not delimit anything');
  });

  check('a CRLF file keeps its CRLF endings', () => {
    const text = `# rules\r\n\r\nprose\r\n\r\n${BEGIN}\r\nbody\r\n${END}\r\n`;
    const out = runFilterProcess(Buffer.from(text)).toString('utf8');
    assert.strictEqual(out, '# rules\r\n\r\nprose\r\n');
    assert.strictEqual(/(?<!\r)\n/.test(out), false, 'a bare LF was introduced into a CRLF file');
  });

  // -------------------------------------------------------------------------
  // Configuring it, and refusing to claim it worked when it did not.

  check('configureFilter points git at this script and reads the value back before reporting success', () => {
    const r = gitFilter.configureFilter({ env: gitEnv() });
    assert.strictEqual(r.ok, true, `configure failed: ${r.error}`);
    assert.strictEqual(gitFilter.configuredCommand({ env: gitEnv() }), gitFilter.filterCommand());
    assert.match(r.command, /git-block-strip\.js/);
    assert.strictEqual(/\brequired\b/.test(fs.readFileSync(GIT_HOME, 'utf8')), false,
      'filter.membridge.required must stay unset — true converts an uninstall into a repo where `git add` fails');
  });

  check('configureFilter reports FAILURE, not success, when git config could not write', () => {
    // A directory where the config file should be: git exits 128 and writes
    // nothing. This is the shape the codebase gets wrong — a fail-open path
    // plus an unconditional success flag.
    const asDir = path.join(ROOT, 'gitconfig-is-a-directory');
    fs.mkdirSync(asDir, { recursive: true });
    const r = gitFilter.configureFilter({ env: gitEnv(asDir) });
    assert.strictEqual(r.ok, false, 'configureFilter claimed success over a git config that failed');
    assert.ok(r.error, 'a failure must carry the reason git gave');
  });

  check('the off switch removes the git config, and says so only once it is really gone', () => {
    assert.ok(gitFilter.configuredCommand({ env: gitEnv() }), 'precondition: filter is on');
    const off = gitFilter.unconfigureFilter({ env: gitEnv() });
    assert.deepStrictEqual({ ok: off.ok, removed: off.removed }, { ok: true, removed: true });
    assert.strictEqual(gitFilter.configuredCommand({ env: gitEnv() }), null);
    // Turning off something already off is success with removed:false, not a
    // failure and not a claim that it removed something.
    const again = gitFilter.unconfigureFilter({ env: gitEnv() });
    assert.deepStrictEqual({ ok: again.ok, removed: again.removed }, { ok: true, removed: false });
  });

  check('writeAttributes is idempotent and appends without disturbing what is already there', () => {
    const dir = path.join(ROOT, 'attrs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.png binary\n');
    const first = gitFilter.writeAttributes(dir, ['CLAUDE.md', 'AGENTS.md']);
    assert.deepStrictEqual(first.added, ['CLAUDE.md', 'AGENTS.md']);
    const written = fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8');
    assert.match(written, /^\*\.png binary$/m, 'an existing rule was disturbed');
    assert.match(written, /^CLAUDE\.md filter=membridge$/m);
    const second = gitFilter.writeAttributes(dir, ['CLAUDE.md', 'AGENTS.md']);
    assert.deepStrictEqual(second.added, [], 'a second pass re-added lines that were already there');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'), written);
  });

  // -------------------------------------------------------------------------
  // End to end, through real `git add`.

  check('WITHOUT the filter configured, `git add` stores the block unchanged and exits 0', () => {
    const dir = newRepo();
    const text = withBlock('# My rules\n\nBe nice.', 'shared memory');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), text);
    const r = gitTry(dir, 'add', 'CLAUDE.md');
    assert.strictEqual(r.status, 0, `git add failed on an unconfigured filter: ${r.out}`);
    assert.strictEqual(stored(dir), text,
      'an unconfigured filter named in .gitattributes must be ignored by git — this is what makes the committed line safe for teammates without MemBridge');
  });

  check('WITH the filter configured, `git add` stores the file without the block and leaves the working tree untouched', () => {
    assert.strictEqual(gitFilter.configureFilter({ env: gitEnv() }).ok, true);
    const dir = newRepo();
    const file = path.join(dir, 'CLAUDE.md');
    const text = withBlock('# My rules\n\nBe nice.', 'shared memory');
    fs.writeFileSync(file, text);
    git(dir, 'add', 'CLAUDE.md');
    assert.strictEqual(stored(dir), '# My rules\n\nBe nice.\n', 'the block reached the index');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), text,
      'the working-tree file changed — every AI tool reads that file, so it must be byte-for-byte what MemBridge wrote');
  });

  check('`git diff` stays empty when MemBridge rewrites the block, and a re-add stages nothing', () => {
    const dir = newRepo();
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, withBlock('# My rules\n\nBe nice.', 'first memory'));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');
    assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '', 'precondition: clean tree');

    fs.writeFileSync(file, withBlock('# My rules\n\nBe nice.', 'a completely different memory, longer than before'));
    assert.strictEqual(git(dir, 'diff').trim(), '',
      'the block showed up in a diff — the entire point is that it never does');
    git(dir, 'add', 'CLAUDE.md');
    assert.strictEqual(git(dir, 'diff', '--cached').trim(), '',
      'staging the rewritten file produced something to commit');
    assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '');
  });

  check('KNOWN LIMIT: `git status` still flags the file when a rewrite changes its byte LENGTH (git\'s size shortcut), and is silent when it does not', () => {
    const dir = newRepo();
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, withBlock('# My rules', 'memory AAA'));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');

    fs.writeFileSync(file, withBlock('# My rules', 'memory BBB')); // same length
    assert.strictEqual(git(dir, 'status', '--porcelain').trim(), '',
      'a same-length block rewrite must be completely invisible — git runs the filter and sees identical content');

    fs.writeFileSync(file, withBlock('# My rules', 'memory BBB, now considerably longer'));
    assert.strictEqual(git(dir, 'status', '--porcelain').trim(), 'M CLAUDE.md',
      'if this ever goes quiet, git changed and the caveat in the docs can be dropped');
    assert.strictEqual(git(dir, 'diff').trim(), '',
      'but the diff must still be empty: status is reporting a stat mismatch, not content');
  });

  // The two branches touch the human's own prose in places FAR APART, which
  // git merges cleanly on its own. The only thing that can conflict is the
  // block region, so the pair below isolates it: same script, filter off then
  // filter on.
  const PROSE = ['# My rules', '', 'Line A.', 'Line B.', 'Line C.', 'Line D.', 'Line E.'];
  function divergingBranches(dir) {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, withBlock(PROSE.join('\n'), 'base memory'));
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base');

    git(dir, 'checkout', '-q', '-b', 'teammate');
    fs.writeFileSync(file, withBlock(PROSE.map(l => (l === 'Line A.' ? 'Line A, edited by my teammate.' : l)).join('\n'),
      'TEAMMATE memory, synced on their machine, quite different in length'));
    git(dir, 'add', 'CLAUDE.md');
    git(dir, 'commit', '-qm', 'teammate edit');

    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(file, withBlock(PROSE.map(l => (l === 'Line E.' ? 'Line E, edited by me.' : l)).join('\n'),
      'MY memory, synced on mine, also different'));
    git(dir, 'add', 'CLAUDE.md');
    git(dir, 'commit', '-qm', 'my edit');

    return gitTry(dir, 'merge', '--no-edit', 'teammate');
  }

  check('CONTROL: without the filter, two machines\' blocks conflict on merge — this is the reported failure', () => {
    assert.strictEqual(gitFilter.unconfigureFilter({ env: gitEnv() }).ok, true);
    const merge = divergingBranches(newRepo());
    assert.notStrictEqual(merge.status, 0,
      'the control merged cleanly, so the check below proves nothing about the filter');
    assert.match(merge.out, /CONFLICT \(content\): Merge conflict in CLAUDE\.md/);
  });

  check('two branches whose blocks disagree merge without a conflict — the failure this exists for', () => {
    assert.strictEqual(gitFilter.configureFilter({ env: gitEnv() }).ok, true);
    const dir = newRepo();
    const merge = divergingBranches(dir);
    assert.strictEqual(merge.status, 0, `the merge conflicted: ${merge.out}`);
    assert.strictEqual(stored(dir).includes(BEGIN), false, 'a block reached the merged index');
    assert.match(stored(dir), /Line A, edited by my teammate\./, 'the teammate\'s own edit was lost');
    assert.match(stored(dir), /Line E, edited by me\./, 'my own edit was lost');
  });

  // -------------------------------------------------------------------------
  // The setup wiring: silent, one line, and honest about failure.

  check('`membridge setup-hooks` turns the filter on with exactly one line of output and no prompt', () => {
    const home = path.join(ROOT, 'setup-home');
    const globalGit = path.join(ROOT, 'setup-gitconfig');
    const project = newRepo(false);
    fs.mkdirSync(home, { recursive: true });
    // version must match util.STATE_VERSION or loadState discards the file and
    // setup-hooks sees no tracked repos at all.
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
      version: require('../../lib/util').STATE_VERSION,
      projects: { [project]: { events: [] } },
    }));

    const r = spawnSync(process.execPath, [h.BIN, 'setup-hooks'], {
      encoding: 'utf8',
      env: {
        ...gitEnv(globalGit),
        MEMBRIDGE_HOME: home,
        MEMBRIDGE_CLAUDE_SETTINGS: path.join(ROOT, 'setup-claude-settings.json'),
      },
    });
    assert.strictEqual(r.status, 0, `setup-hooks failed: ${r.stdout}${r.stderr}`);
    const lines = r.stdout.split('\n').filter(l => /[Gg]it filter/.test(l));
    assert.strictEqual(lines.length, 1, `expected exactly one git-filter line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0], /membridge git-filter off/, 'the one line must name the off switch');
    assert.strictEqual(/\?\s*$|\[y\/n\]/i.test(r.stdout), false, 'setup must not prompt');

    assert.strictEqual(gitFilter.configuredCommand({ env: gitEnv(globalGit) }), gitFilter.filterCommand(),
      'setup-hooks printed its line but the git config is not actually set');
    assert.match(fs.readFileSync(path.join(project, '.gitattributes'), 'utf8'), /^CLAUDE\.md filter=membridge$/m,
      'setup-hooks did not mark the tracked repo\'s context files');
  });

  // -------------------------------------------------------------------------
  // The LAUNCH path (#5). `membridge setup-hooks` is a CLI command; Marco opens
  // the app and never types one. hooks.ensureInstalled() is the function both
  // real launches go through — bin/membridge.js's daemon boot and app/main.js —
  // so it is the only place that reaches a user who never uses the terminal.
  //
  // NOT setupHooks(): that is reached only by explicit user actions, one of
  // which is answering YES to an unrelated dialog about session summaries.
  // Answering "Not now" there would have meant never getting this at all.

  /** Run `fn` as a launch would: fresh MEMBRIDGE_HOME, its own git config. */
  function asLaunch(name, fn) {
    const home = path.join(ROOT, `launch-${name}`);
    const globalGit = path.join(ROOT, `launch-${name}-gitconfig`);
    const project = newRepo(false);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'state.json'), JSON.stringify({
      version: require('../../lib/util').STATE_VERSION,
      projects: { [project]: { events: [] } },
    }));
    const prev = {
      home: process.env.MEMBRIDGE_HOME,
      settings: process.env.MEMBRIDGE_CLAUDE_SETTINGS,
      git: process.env.GIT_CONFIG_GLOBAL,
    };
    process.env.MEMBRIDGE_HOME = home;
    process.env.MEMBRIDGE_CLAUDE_SETTINGS = path.join(ROOT, `launch-${name}-settings.json`);
    process.env.GIT_CONFIG_GLOBAL = globalGit;
    try {
      return fn({ home, globalGit, project, env: gitEnv(globalGit) });
    } finally {
      process.env.MEMBRIDGE_HOME = prev.home;
      process.env.MEMBRIDGE_CLAUDE_SETTINGS = prev.settings;
      process.env.GIT_CONFIG_GLOBAL = prev.git;
    }
  }

  check('a LAUNCH enables the filter — the app path, with no CLI command ever typed', () => {
    asLaunch('plain', ({ globalGit, project, env }) => {
      // require fresh so this is the real launch entry point, not a helper.
      const hooks = require('../../lib/hooks');
      assert.strictEqual(gitFilter.configuredCommand({ env }), null, 'precondition: nothing configured');
      const r = hooks.ensureInstalled();
      assert.strictEqual(r.gitFilter, 'wrote', `ensureInstalled did not enable the filter: ${JSON.stringify(r)}`);
      assert.strictEqual(gitFilter.configuredCommand({ env }), gitFilter.filterCommand(),
        'a launch reported the filter enabled but git has no such config');
      assert.match(fs.readFileSync(path.join(project, '.gitattributes'), 'utf8'), /^CLAUDE\.md filter=membridge$/m,
        'a launch left the tracked repo\'s context files unmarked, so the filter matches nothing');
    });
  });

  check('a second LAUNCH is a no-op — it asks git rather than trusting a stored flag', () => {
    asLaunch('twice', ({ env }) => {
      const hooks = require('../../lib/hooks');
      assert.strictEqual(hooks.ensureInstalled().gitFilter, 'wrote');
      assert.strictEqual(hooks.ensureInstalled().gitFilter, 'current',
        'the second launch rewrote a config that was already correct');
      // And the durability half: a config naming a script that no longer
      // exists is NOT "current" — git fails open on it, so a stored "installed"
      // would be a flag outliving the thing it claims.
      const dead = `"${process.execPath}" "${path.join(ROOT, 'deleted-membridge', 'git-block-strip.js')}"`;
      execFileSync('git', ['config', '--global', gitFilter.CLEAN_KEY, dead], { env, encoding: 'utf8' });
      assert.strictEqual(gitFilter.isCommandLive(dead), false);
      assert.strictEqual(hooks.ensureInstalled().gitFilter, 'wrote',
        'a launch left a dead filter command in place, so the block silently starts landing in commits again');
      assert.strictEqual(gitFilter.configuredCommand({ env }), gitFilter.filterCommand());
    });
  });

  check('a LAUNCH respects `git-filter off` — the off switch is not undone by opening the app', () => {
    asLaunch('off', ({ home, env }) => {
      const hooks = require('../../lib/hooks');
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ gitFilter: { enabled: false } }));
      assert.strictEqual(hooks.ensureInstalled().gitFilter, 'off');
      assert.strictEqual(gitFilter.configuredCommand({ env }), null,
        'opening the app re-enabled a filter the user had explicitly turned off');
    });
  });

  check('a LAUNCH reports the filter as failed, never as done, when git config could not be written', () => {
    asLaunch('broken', ({ env }) => {
      const hooks = require('../../lib/hooks');
      const asDir = path.join(ROOT, 'launch-broken-dir');
      fs.mkdirSync(asDir, { recursive: true });
      const prev = process.env.GIT_CONFIG_GLOBAL;
      process.env.GIT_CONFIG_GLOBAL = asDir;
      try {
        assert.strictEqual(hooks.ensureInstalled().gitFilter, 'failed',
          'a launch that could not configure git said something other than failed');
      } finally {
        process.env.GIT_CONFIG_GLOBAL = prev;
      }
      assert.strictEqual(gitFilter.configuredCommand({ env }), null);
    });
  });

  check('the suite never wrote to the developer\'s real ~/.gitconfig', () => {
    const after = (() => {
      try { return fs.readFileSync(REAL_GITCONFIG, 'utf8'); } catch { return null; }
    })();
    assert.strictEqual(after, realGitconfigBefore,
      'the real global git config changed during this run — a `git config --global` escaped GIT_CONFIG_GLOBAL');
  });

  h.finish();
}

main().catch(err => { console.error(err); process.exit(1); });
