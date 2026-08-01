'use strict';
// A Grep/Glob PreToolUse tool_input turned into a memory search query, or
// null when the pattern holds nothing worth searching memory for.
//
// Pure: no fs, no state, no config. Split out of lib/hooks-search.js so the
// "is this pattern worth a search at all" rule can be pinned directly, and
// because it is the ONE gate that runs before the hook touches disk -- every
// pattern this module rejects costs the agent nothing but a process start.
//
// Why any translation is needed: a Grep pattern is a REGEX and a Glob pattern
// is a shell glob. Neither is a query. `function\s+parseAuth\(` and
// `**/*auth*.ts` both contain exactly one word a human meant, wrapped in
// syntax that means nothing to a prose index.
const { tokenize } = require('./search');

// An escaped LITERAL that is part of how identifiers and filenames are
// written keeps its character: `auth\.js` means the file auth.js, and blanking
// the dot would split it into "auth" and a two-letter fragment that the length
// floor below then throws away. Runs first, so the blanket rule underneath
// never sees these.
const ESCAPED_LITERAL_RE = /\\([.\-_])/g;

// Every other escape sequence goes whole, backslash and letter together. `\b`
// is a word boundary, not the letter b; stripping only the backslash would
// leave a stray "b" behind and put it into the query as if it had been typed.
const ESCAPE_RE = /\\./g;

// Everything lib/search.js's own tokenizer would not keep inside a token,
// minus whitespace. `.` and `-` survive so auth.js and kebab-case stay whole;
// tokenize() then trims them from token edges, which is precisely what turns
// a regex `.*` into nothing at all. `$` is deliberately NOT kept even though
// tokenize() would allow it: inside a pattern it is an end anchor far more
// often than part of an identifier, and a query term of `auth$` cannot
// substring-match the token `auth` that memory actually holds.
const SYNTAX_RE = /[^A-Za-z0-9_.\-\s]+/g;

// A term shorter than this is a filter, not a search. lib/search.js matches a
// query term as a SUBSTRING of a memory token, so "id" hits "identity",
// "invalid", "consider" and every uuid in a file list -- it would put a wall
// of unrelated memory in front of a search that had nothing to do with it.
// Four characters is roughly where an identifier fragment starts carrying
// meaning on its own ("auth", "sync", "team", "vault").
const MIN_TERM_CHARS = 4;

// Upper bound on terms taken from one pattern. A long alternation
// (`foo|bar|baz|...`) would otherwise become a 30-term query, which
// lib/search.js's majority rule makes match nothing at all while still
// costing a full scan of every entry.
const MAX_TERMS = 6;

// Above this the pattern is machine-generated (a giant alternation, an
// escaped blob) rather than search terms a person typed, and the words in it
// are not a question anyone is asking. Refusing outright keeps the regex
// passes below bounded no matter what arrives in the payload.
const MAX_PATTERN_CHARS = 2000;

// Strip pattern syntax, then hand the remainder to the SAME tokenizer the
// ranker will use -- lowercasing, stopword removal and edge trimming are its
// rules, and a second copy of them here would drift from the index it feeds.
function queryFromPattern(pattern) {
  if (typeof pattern !== 'string' || !pattern) return null;
  if (pattern.length > MAX_PATTERN_CHARS) return null;
  const plain = pattern
    .replace(ESCAPED_LITERAL_RE, '$1')
    .replace(ESCAPE_RE, ' ')
    .replace(SYNTAX_RE, ' ');
  const terms = [...new Set(tokenize(plain))].filter(t => t.length >= MIN_TERM_CHARS);
  if (!terms.length) return null;
  return terms.slice(0, MAX_TERMS).join(' ');
}

// Grep and Glob both carry the user's search string in `pattern`. Nothing
// else in the payload is a query: `path`/`glob` narrow WHERE to look, and
// feeding a directory name into a prose index would match on the project's
// own vocabulary rather than on what was being looked for.
function queryFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  return queryFromPattern(toolInput.pattern);
}

module.exports = { queryFromPattern, queryFromToolInput, MIN_TERM_CHARS, MAX_TERMS, MAX_PATTERN_CHARS };
