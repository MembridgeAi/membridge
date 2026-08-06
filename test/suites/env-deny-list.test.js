'use strict';
// --- env-value deny-list ---
//
// Alpha readiness Task 5B. Redact any literal string that appears as a value
// in the project's own .env files (`.env`, `.env.local`, `.env.development`,
// `.env.production`, `.env.*.local`). Deterministic — the realistic secret
// leak is a developer pasting a credential they already have on disk, not
// inventing one in chat.
//
// What is deliberately NOT tested here: cross-machine behavior. The compiled
// values must not persist ANYWHERE (state.json, logs, memory.json, cache
// files on disk). The last check greps the fixture root for the known secret
// after a full pipeline pass, and fails if it appears in any artifact the
// suite writes.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const digest = require('../../lib/digest');
const envDeny = require('../../lib/env-deny');

// A fixture project with a family of .env files. The MATCHING files should
// all contribute their values; the EXAMPLE/template files must not (their
// values are placeholders, and redacting placeholder text corrupts prose).
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'membridge-env-deny-'));
  fs.writeFileSync(path.join(root, '.env'),
    'API_KEY=hunter2corgi-abc\n' +
    'DB_PASSWORD=p@ss.w+rd\n' +      // metacharacters — must be escaped as a literal
    'TRUE_FLAG=true\n' +               // stop-list: skipped
    'PORT=3000\n' +                    // bare integer: skipped
    'HOST=localhost\n' +               // stop-list: skipped
    'URL_SCHEME_ONLY=https://\n' +     // scheme only: skipped
    'API_URL=https://api.example.com\n' + // URL: skipped
    'SHORTV=abc\n' +                   // 3 chars: skipped (< min length 8)
    'ENV=development\n' +              // stop-list: skipped
    'EMPTY=\n' +
    'MULTI_LINE=this_is_a_normal_secret\n');
  fs.writeFileSync(path.join(root, '.env.local'),
    'LOCAL_SECRET=super-secret-local-value\n');
  fs.writeFileSync(path.join(root, '.env.production.local'),
    'PROD_LOCAL=prod-only-token-abcdef\n');
  fs.writeFileSync(path.join(root, '.env.example'),
    'API_KEY=changeme_placeholder_1\n' +
    'DB_PASSWORD=changeme_placeholder_2\n');
  fs.writeFileSync(path.join(root, '.env.sample'),
    'ALT_KEY=changeme_placeholder_3\n');
  fs.writeFileSync(path.join(root, '.env.template'),
    'TMPL_KEY=changeme_placeholder_4\n');
  fs.writeFileSync(path.join(root, 'some-other.env.example'),
    'IGNORED=changeme_placeholder_5\n');
  return root;
}

const FIXTURE = makeFixture();

check('env-deny: compileForProject returns literals from real .env files only', () => {
  const literals = envDeny.compileForProject(FIXTURE);
  assert.ok(Array.isArray(literals), 'must return an array');
  const set = new Set(literals);
  assert.ok(set.has('hunter2corgi-abc'), 'API_KEY value missing');
  assert.ok(set.has('p@ss.w+rd'), 'DB_PASSWORD value missing (metacharacters)');
  assert.ok(set.has('this_is_a_normal_secret'), 'MULTI_LINE value missing');
  assert.ok(set.has('super-secret-local-value'), '.env.local value missing');
  assert.ok(set.has('prod-only-token-abcdef'), '.env.production.local value missing');
});

check('env-deny: never reads .env.example / .env.sample / .env.template / *.example', () => {
  const literals = envDeny.compileForProject(FIXTURE);
  const forbidden = ['changeme_placeholder_1', 'changeme_placeholder_2', 'changeme_placeholder_3',
    'changeme_placeholder_4', 'changeme_placeholder_5'];
  for (const v of forbidden) {
    assert.ok(!literals.includes(v),
      `example/sample/template value ${v} was compiled — redacting placeholder text corrupts prose`);
  }
});

check('env-deny: stop-list drops obvious non-secrets', () => {
  const literals = envDeny.compileForProject(FIXTURE);
  const forbidden = ['true', 'false', 'localhost', '3000', 'development', 'production',
    'test', 'https://', 'https://api.example.com', 'abc', ''];
  for (const v of forbidden) {
    assert.ok(!literals.includes(v),
      `stop-list value ${v} leaked into the deny-list — will destroy readability`);
  }
});

check('env-deny: values under 8 characters are skipped', () => {
  // "abc" is 3 chars. The min-length rule is what stops the deny-list from
  // redacting every word in the codebase.
  const literals = envDeny.compileForProject(FIXTURE);
  assert.ok(!literals.includes('abc'));
});

check('digest.compileRedactions accepts a projectPath option', () => {
  // Signature extension: opts is the new second arg, backward compatible.
  const compiled = digest.compileRedactions({}, { projectPath: FIXTURE });
  // Shape check: it produces something redactText can consume, and it
  // carries env literals. The exact field name is internal, so assert
  // through the effect (redactText behaviour below).
  assert.ok(compiled, 'compileRedactions must return a compiled object');
  const s = digest.redactText('the key is hunter2corgi-abc', compiled);
  assert.ok(/\[redacted:env\]/.test(s), 'env literal was not redacted');
  assert.ok(!/hunter2corgi-abc/.test(s), 'env literal survived redaction');
});

check('digest.redactText: env literal in prose is redacted with [redacted:env]', () => {
  const compiled = digest.compileRedactions({}, { projectPath: FIXTURE });
  const before = 'I pasted the api key hunter2corgi-abc into the config';
  const after = digest.redactText(before, compiled);
  assert.ok(!/hunter2corgi-abc/.test(after), `literal survived: ${after}`);
  assert.ok(/\[redacted:env\]/.test(after), `no marker in output: ${after}`);
  assert.ok(/api key/.test(after), 'surrounding prose was destroyed');
});

check('digest.redactText: metacharacters in env value are matched literally, not as regex', () => {
  const compiled = digest.compileRedactions({}, { projectPath: FIXTURE });
  const before = 'the DB pass is p@ss.w+rd and nothing else';
  const after = digest.redactText(before, compiled);
  assert.ok(!/p@ss\.w\+rd/.test(after), `metacharacter literal not redacted: ${after}`);
  assert.ok(/\[redacted:env\]/.test(after));
  // A literal treated as a regex would ALSO match "pQssZwArd" or similar,
  // which is exactly what we do not want.
  const control = digest.redactText('unrelated pQssZwArd text', compiled);
  assert.ok(/pQssZwArd/.test(control),
    'metacharacter env value was compiled as a regex, matching unrelated text');
});

check('digest.redactText: env matching is case-sensitive (secrets are)', () => {
  const compiled = digest.compileRedactions({}, { projectPath: FIXTURE });
  const upper = digest.redactText('the key is HUNTER2CORGI-ABC nope', compiled);
  assert.ok(/HUNTER2CORGI-ABC/.test(upper),
    'case-insensitive env matching redacts unrelated text');
});

check('digest.redactText without projectPath still works (back-compat)', () => {
  const compiled = digest.compileRedactions({}); // no opts
  const s = digest.redactText('the key is hunter2corgi-abc', compiled);
  // No env deny-list is active — the string just passes through the default
  // pipeline (no marker, no crash).
  assert.strictEqual(s, 'the key is hunter2corgi-abc');
});

check('digest.compileRedactions: mtime cache re-reads when a .env file changes', () => {
  const first = digest.compileRedactions({}, { projectPath: FIXTURE });
  const s1 = digest.redactText('added-later-secret-value here', first);
  assert.ok(!/\[redacted:env\]/.test(s1), 'value not yet in .env matched somehow');
  // Add a new value and bump mtime by touching the file.
  fs.appendFileSync(path.join(FIXTURE, '.env'), 'NEW=added-later-secret-value\n');
  const future = Date.now() + 5000;
  fs.utimesSync(path.join(FIXTURE, '.env'), future / 1000, future / 1000);
  const second = digest.compileRedactions({}, { projectPath: FIXTURE });
  const s2 = digest.redactText('added-later-secret-value here', second);
  assert.ok(/\[redacted:env\]/.test(s2), 'mtime cache did not invalidate on file change');
});

check('env deny-list values NEVER persist to disk anywhere under the test root', () => {
  // The spec's non-negotiable: "Never write the compiled values to disk, to
  // logs, to state.json, or to an error message." Do a full pipeline pass on
  // a known value, then grep every regular file under MEMBRIDGE_HOME (test's
  // isolated tmpdir) for that literal.
  const known = 'hunter2corgi-abc';
  const compiled = digest.compileRedactions({}, { projectPath: FIXTURE });
  const _ignored = digest.redactText(`test ${known}`, compiled);
  const root = process.env.MEMBRIDGE_HOME;
  assert.ok(root, 'harness must have set MEMBRIDGE_HOME');
  // Walk every file under the isolated home.
  const found = [];
  function walk(p) {
    let ents;
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) {
        let text;
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        if (text.includes(known)) found.push(full);
      }
    }
  }
  walk(root);
  assert.deepStrictEqual(found, [],
    `deny-list value leaked to disk: ${found.join(', ')}`);
});

check('teamsync.entryToRow redacts an env value in ask when projectPath is passed', () => {
  const teamsync = require('../../lib/teamsync');
  const CREDS = { userId: '00000000-0000-0000-0000-000000000001', displayName: 'Marco' };
  const compiled = digest.compileRedactions({}, { projectPath: FIXTURE });
  const entry = {
    ts: '2026-08-06T10:00:00.000Z',
    source: 'Claude Code',
    session: 'session-abc',
    ask: 'I need to test with hunter2corgi-abc as the key',
    goal: 'goal',
    distilled: true,
  };
  const row = teamsync.entryToRow(entry, '00000000-0000-0000-0000-0000000000aa',
    CREDS, 'verbatim', compiled, FIXTURE);
  assert.ok(!/hunter2corgi-abc/.test(row.ask),
    `env literal survived the wire pipeline: ${row.ask}`);
  assert.ok(/\[redacted:env\]/.test(row.ask), `no env marker: ${row.ask}`);
});

h.finish();
