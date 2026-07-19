'use strict';
// Pure change-model derivation. Given a project root and the relative file
// paths a session edited, ask git for status + line counts (best-effort) and
// return an ordered, grouped model the renderers share. Any git failure
// degrades to a filename-only list — never throws into a render path.
const { execFileSync } = require('child_process');

const DEP_RE = /(^|\/)(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|Gemfile(\.lock)?|poetry\.lock|Cargo\.lock|go\.(sum|mod)|requirements\.txt|composer\.(json|lock))$/;
const STATUS_RANK = { new: 0, edited: 1, deleted: 2 };

function defaultRunGit(projectPath) {
  return args => execFileSync('git', args, {
    cwd: projectPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
}

// git wraps paths with spaces/specials in C-quoted double quotes ("...").
// Octal escapes are raw UTF-8 BYTES (core.quotePath escapes every non-ASCII
// byte), so they must be collected and decoded as one UTF-8 buffer — decoding
// each escape via String.fromCharCode reads them as Latin-1 code points and
// turns "ä.txt" into "Ã¤.txt".
function unquote(p) {
  if (!(p.length >= 2 && p[0] === '"' && p[p.length - 1] === '"')) return p;
  const inner = p.slice(1, -1);
  const SIMPLE = { t: 9, n: 10, r: 13, b: 8, f: 12, a: 7, v: 11, '"': 34, '\\': 92 };
  const bytes = [];
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (inner[i] === '\\' && i + 1 < inner.length) {
      const c = inner[i + 1];
      bytes.push(SIMPLE[c] !== undefined ? SIMPLE[c] : c.charCodeAt(0));
      i += 1;
    } else {
      bytes.push(inner.charCodeAt(i)); // unescaped chars are plain ASCII
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function parseStatus(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3).trim();
    // Rename/copy: "old -> new" — attribute to the destination.
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4).trim();
    file = unquote(file);
    if (!file) continue;
    map.set(file, code.includes('D') ? 'deleted' : (code.includes('?') || code.includes('A')) ? 'new' : 'edited');
  }
  return map;
}

function parseNumstat(out) {
  const map = new Map();
  for (const line of String(out).split('\n')) {
    const m = line.split('\t');
    if (m.length < 3) continue;
    const pathField = m.slice(2).join('\t').trim();
    // Rename line ("{old => new}/x" or "old => new"): counts aren't reliably
    // attributable without -z, so record the destination with null counts.
    if (pathField.includes(' => ')) {
      const brace = pathField.match(/^(.*)\{.* => (.*)\}(.*)$/);
      const dest = brace ? (brace[1] + brace[2] + brace[3]).replace(/\/\//g, '/')
        : pathField.slice(pathField.indexOf(' => ') + 4);
      map.set(unquote(dest.trim()), { add: null, del: null });
      continue;
    }
    const add = m[0] === '-' ? null : parseInt(m[0], 10);
    const del = m[1] === '-' ? null : parseInt(m[1], 10);
    map.set(unquote(pathField), { add: Number.isFinite(add) ? add : null, del: Number.isFinite(del) ? del : null });
  }
  return map;
}

// files: relative path strings. highlights: [{file, note}] (relative paths).
function deriveChanges(projectPath, files, highlights = [], opts = {}) {
  const rels = [...new Set(files.filter(Boolean))];
  if (!rels.length) return [];
  const noteFor = new Map((highlights || []).filter(h => h && h.file).map(h => [h.file, String(h.note || '').trim() || null]));
  let status = new Map(), stat = new Map();
  try {
    const runGit = opts.runGit || defaultRunGit(projectPath);
    status = parseStatus(runGit(['status', '--porcelain', '--untracked-files=all', '--', ...rels]));
    stat = parseNumstat(runGit(['diff', 'HEAD', '--numstat', '--', ...rels]));
  } catch { /* not a repo / git missing → filename-only */ }

  const model = rels.map(file => {
    const dep = DEP_RE.test(file);
    const s = stat.get(file) || {};
    return {
      file,
      status: status.get(file) || 'edited',
      add: dep ? null : (s.add != null ? s.add : null),
      del: dep ? null : (s.del != null ? s.del : null),
      note: noteFor.get(file) || null,
      dep,
    };
  });
  return model.sort((a, b) =>
    (a.dep - b.dep) ||
    (STATUS_RANK[a.status] - STATUS_RANK[b.status]) ||
    a.file.localeCompare(b.file));
}

// unquote/parseNumstat/defaultRunGit are shared with lib/commits.js (the
// provenance commit reader) — same git-output conventions, one parser.
module.exports = { deriveChanges, DEP_RE, unquote, parseNumstat, defaultRunGit };
