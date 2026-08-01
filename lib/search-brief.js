'use strict';
// Ranked memory entries -> the short block lib/hooks-search.js puts in front
// of a Grep/Glob, or null when there is nothing worth saying.
//
// Pure (one clip helper aside): no fs, no state, no payload. Split out so the
// output cap -- the property that decides whether this feature is a help or a
// tax -- can be pinned directly, without driving a whole hook to observe it.
const digest = require('./digest');

// THE CAP. This block rides on EVERY qualifying search, so its size is not a
// display preference, it is the feature's entire cost model. Unbounded memory
// injected in front of every Grep would cost more than the re-derivation it
// exists to prevent, and that is true whether or not anyone is measuring it.
//
// MAX_CHARS 900 is roughly 225 tokens. A Grep result is commonly 1,000 to
// 5,000 tokens, so the block stays a small fraction of the call it rides on
// and can never dominate it. Picked as a ceiling on the WHOLE block rather
// than per entry, because per-entry limits multiply and the total is the only
// number that actually bounds anything.
const MAX_CHARS = 900;

// MAX_RESULTS 3: enough to establish that prior work exists and who did it,
// which is the entire job here. A fourth entry turns a pointer into a digest,
// and an agent that wants the long tail already has search_memory, which
// reads the durable archive this hook deliberately never touches.
const MAX_RESULTS = 3;

// Per-line clips, so one entry with a 300-character summary cannot eat the
// whole budget and starve the two entries behind it.
const TITLE_CHARS = 120;
const WHY_CHARS = 160;

// Score floor. lib/search.js's field weights run 1 to 4, and its relaxed
// second pass (one term matching anywhere) can return very weak hits. A score
// of 1 or 2 means the query matched only `project` or `author` -- fields every
// entry in this project shares, so matching them is evidence of nothing. 3 is
// the first score reachable by a real content field (files, goal), and 4 by a
// deliberate one (headline, decisions, gotchas).
const MIN_SCORE = 3;

const firstOf = (...vals) => vals.find(v => typeof v === 'string' && v.trim()) || null;

// One entry as at most two lines: what it was, and why it went that way.
// `ts` is sliced to the day because the hour of a session six weeks ago tells
// the reader nothing and costs characters the cap is short of.
function lineFor(entry) {
  const day = String(entry.ts || '').slice(0, 10);
  const who = entry.author || 'You';
  const title = digest.clip(firstOf(entry.headline, entry.ask, entry.goal, entry.summary) || '(no summary shared)', TITLE_CHARS);
  const head = `- ${day} · ${who}: ${title}`;
  const why = firstOf(entry.decisions, entry.gotchas, entry.summary);
  if (!why) return head;
  const whyLine = digest.clip(why, WHY_CHARS);
  // A one-line entry whose only text is its title must not print that text
  // twice; clip() makes the two strings genuinely comparable.
  return whyLine === title ? head : `${head}\n  ${whyLine}`;
}

// ranked: lib/search.js rankEntries output (score-desc, each carrying .score).
// Returns { text, entries } -- `entries` being exactly what `text` mentions,
// so the caller records as served only what the agent was actually handed.
// null means "say nothing", which is the common answer and must stay silent:
// a "no results" line on every search would be pure noise forever.
function build(ranked) {
  const worthy = (ranked || []).filter(e => e && e.score >= MIN_SCORE);
  if (!worthy.length) return null;

  const header = `MemBridge memory · past work matching this search:`;
  const lines = [];
  const entries = [];
  let used = header.length;
  for (const entry of worthy.slice(0, MAX_RESULTS)) {
    const line = lineFor(entry);
    // Budget checked BEFORE the line is added, never trimmed after: a line
    // sliced mid-sentence reads as corruption, and dropping the entry whole
    // keeps every line that does appear complete and attributable.
    if (used + 1 + line.length > MAX_CHARS) break;
    used += 1 + line.length;
    lines.push(line);
    entries.push(entry);
  }
  if (!lines.length) return null;
  return { text: [header, ...lines].join('\n'), entries };
}

module.exports = { build, lineFor, MAX_CHARS, MAX_RESULTS, MIN_SCORE };
