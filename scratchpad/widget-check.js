'use strict';
// Fixture harness for the pure feed functions in lib/dashboard.js. The embedded
// dashboard script can't run under the suite (no DOM), so we extract the named
// functions and drive them with stubs. Run: node scratchpad/widget-check.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'dashboard.js'), 'utf8');

function extract(name) {
  const re = new RegExp('function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', m.index), depth = 0, j = i;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { j++; break; } } }
  return src.slice(m.index, j);
}

const names = ['normKeyPart', 'feedKey', 'threadKey', 'buildThreads', 'unitKeyOf', 'buildUnits', 'finalizeUnit', 'promptRowsHtml', 'threadHtml', 'unitHtml', 'feedDayGroupHtml', 'attributeSubagents', 'subagentLine', 'sessionPageHtml'];
// feedKey isn't in dashboard's feed section as a standalone? it is — but guard.
let bodies = '';
for (const n of names) { try { bodies += extract(n) + '\n'; } catch (e) { /* provide stub below */ } }

const harness = `
var BURST_GAP = 30 * 60 * 1000;
var STALE_GAP = 45 * 60 * 1000;
var SESS_BACK = '<button data-sess-back>Activity</button>';
var catchupExpanded = {};
var MONO = 'font-family:mono';
function ago() { return '1m'; }
function homeDayLabel(iso) { return String(iso).slice(0, 10); }
function personColor() { return '#000'; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
${/feedKey/.test(bodies) ? '' : 'function feedKey(e){ return String(e.ts)+"|"+(e.author||""); }'}
${bodies}
return { buildThreads: buildThreads, buildUnits: buildUnits, unitHtml: unitHtml, threadHtml: threadHtml, threadKey: threadKey, feedDayGroupHtml: feedDayGroupHtml, attributeSubagents: attributeSubagents, subagentLine: subagentLine, sessionPageHtml: sessionPageHtml };
`;
const api = new Function(harness)();
const { buildThreads, buildUnits, unitHtml, feedDayGroupHtml, attributeSubagents, subagentLine, sessionPageHtml } = api;

let pass = 0;
function check(name, fn) { try { fn(); pass++; console.log('  ok   ', name); } catch (e) { console.error('  FAIL ', name, '\n        ', e.message); process.exitCode = 1; } }

const mk = (session, tsISO, ask, summary, distilled, extra) =>
  Object.assign({ origin: 'team', author: 'marco', authorId: 'm', session, project: 'membridge', ts: tsISO, ask, summary, distilled: !!distilled, source: 'Claude Code' }, extra || {});
// Liveness is wall-clock-based (STALE_GAP), so live/stale fixtures must use
// now-relative timestamps, never fixed ISO strings.
const minAgo = min => new Date(Date.now() - min * 60000).toISOString();

check('subagent burst → one unit, N agent threads', () => {
  const entries = [
    mk('main', '2026-07-16T12:00:00Z', 'plan it', null, false),
    mk('sub-a', '2026-07-16T12:10:00Z', 'do A', 'Did A', true),
    mk('sub-b', '2026-07-16T12:20:00Z', 'do B', 'Did B', true),
  ];
  const units = buildUnits(buildThreads(entries));
  assert.strictEqual(units.length, 1, 'one unit');
  assert.strictEqual(units[0].agentCount, 3, 'three agents');
  assert.strictEqual(units[0].promptCount, 3, 'three prompts');
});

check('gap > 30min → two units', () => {
  const entries = [
    mk('main', '2026-07-16T12:00:00Z', 'plan', null, false),
    mk('sub-a', '2026-07-16T12:10:00Z', 'A', 'Did A', true),
    mk('later', '2026-07-16T13:00:00Z', 'resume', null, false),
  ];
  assert.strictEqual(buildUnits(buildThreads(entries)).length, 2);
});

check('different authors never merge', () => {
  const entries = [
    mk('s1', '2026-07-16T12:00:00Z', 'a', 'A', true),
    Object.assign(mk('s2', '2026-07-16T12:05:00Z', 'b', 'B', true), { author: 'andrew', authorId: 'a' }),
  ];
  assert.strictEqual(buildUnits(buildThreads(entries)).length, 2);
});

check('recent harvested-only unit → live (time-based), no distilled rep, reasoning line never the headline', () => {
  const entries = [mk('s', minAgo(5), 'go', 'Now let me look at the pipeline', false)];
  const u = buildUnits(buildThreads(entries))[0];
  assert.strictEqual(u.rep, null, 'no distilled rep');
  assert.strictEqual(u.live, true, 'activity 5 min ago must read as live');
  // A live run's headline is the amber Working-on line, not the harvested text.
  const html = unitHtml(buildUnits(buildThreads(entries.concat([mk('s', minAgo(4), 'go2', null, false)])))[0]);
  assert.ok(/Working on:/.test(html), 'live headline is Working on');
  assert.ok(!/sess-link[^>]*>Now let me look/.test(html), 'harvested reasoning line leaked into a live headline');
});

check('distilled summary becomes the unit headline; liveness is time, not summary', () => {
  const stale = buildUnits(buildThreads([
    mk('s', minAgo(180), 'go', 'Now let me look…', false),
    mk('s', minAgo(175), 'more', 'Shipped the feature', true),
  ]))[0];
  assert.ok(stale.rep && stale.rep.rep.summary === 'Shipped the feature');
  assert.strictEqual(stale.live, false, 'old unit must be stale');
  // A distilled summary no longer blocks liveness: same unit, recent activity.
  const fresh = buildUnits(buildThreads([mk('s', minAgo(3), 'more', 'Shipped the feature', true)]))[0];
  assert.strictEqual(fresh.live, true, 'a summarized unit active 3 min ago is still live');
});

check('clutter guard: single-run single-prompt → simple card, no agent chrome', () => {
  const entries = [mk('s', '2026-07-16T12:00:00Z', 'just one', 'A done', true)];
  const html = unitHtml(buildUnits(buildThreads(entries))[0]);
  assert.ok(!/Agent 1/.test(html), 'no agent label on a trivial unit');
});

check('multi-agent unit html shows agent threads + count', () => {
  const entries = [
    mk('main', '2026-07-16T12:00:00Z', 'plan', 'Planned it', true),
    mk('sub-a', '2026-07-16T12:10:00Z', 'A', 'Did A', true),
  ];
  const html = unitHtml(buildUnits(buildThreads(entries))[0]);
  assert.ok(/Agent 1/.test(html) && /Agent 2/.test(html), 'agent labels present');
  assert.ok(/2 agents/.test(html), 'agent count shown');
});

check('(a) unit idle > 45 min → live=false, html has NO working-now', () => {
  const entries = [mk('a', minAgo(120), 'x', null, false), mk('b', minAgo(115), 'y', null, false)];
  const u = buildUnits(buildThreads(entries))[0];
  assert.strictEqual(u.live, false, 'stale unit claimed live');
  assert.ok(!/working now/i.test(unitHtml(u)), 'stale card still says working now');
});

check('(b) unit active 5 min ago → live=true, working-now label, card wrapper, no accent border', () => {
  const entries = [mk('a', minAgo(5), 'x', null, false), mk('b', minAgo(6), 'y', null, false)];
  const u = buildUnits(buildThreads(entries))[0];
  assert.strictEqual(u.live, true, 'fresh unit not live');
  const html = unitHtml(u);
  assert.ok(/Working now/.test(html), 'working-now label missing');
  assert.ok(!/border-left:3px solid var\(--accent\)/.test(html), 'old accent left border still present');
  assert.ok(!/border-bottom:1px solid var\(--border\)/.test(html.match(/<article[^>]*>/)[0]), 'old border-bottom wrapper still present');
  assert.ok(/border:0\.5px solid var\(--border\);border-radius:14px;background:var\(--card\);padding:16px 18px;margin-bottom:14px/.test(html), 'self-contained card wrapper missing');
});

check('(c) finished unit, harvested but no distilled → harvested headline PLAIN, no Working on', () => {
  const entries = [
    mk('s', minAgo(90), 'go', null, false),
    mk('s', minAgo(85), 'more', 'Refactored the parser and fixed two tests', false),
  ];
  const html = unitHtml(buildUnits(buildThreads(entries))[0]);
  assert.ok(/sess-link[^>]*>Refactored the parser and fixed two tests</.test(html), 'harvested text not the plain headline');
  assert.ok(!/Working on:/.test(html) && !/working now/i.test(html), 'finished card still amber');
});

check('(d) finished unit with neither summary nor shared ask → session ended line', () => {
  const entries = [mk('s', minAgo(90), null, null, false), mk('s', minAgo(85), null, null, false)];
  const html = unitHtml(buildUnits(buildThreads(entries))[0]);
  assert.ok(/session ended · no summary shared/.test(html), 'session-ended fallback missing');
  assert.ok(!/Working on:/.test(html), 'finished card says Working on');
});

check('clutter-guard (threadHtml) card follows the same three-way rule + card wrapper', () => {
  // stale, no summaries, ask shared → the plain ask, nothing amber
  const stale = unitHtml(buildUnits(buildThreads([mk('s', minAgo(90), 'lone ask', null, false)]))[0]);
  assert.ok(/sess-link[^>]*>lone ask</.test(stale), 'stale single-prompt card lost its plain ask headline');
  assert.ok(!/Working on:/.test(stale) && !/working now/i.test(stale), 'stale single-prompt card still amber');
  assert.ok(/border:0\.5px solid var\(--border\);border-radius:14px/.test(stale), 'threadHtml card wrapper missing');
  // stale, nothing at all → session ended
  const bare = unitHtml(buildUnits(buildThreads([mk('s', minAgo(90), null, null, false)]))[0]);
  assert.ok(/session ended · no summary shared/.test(bare), 'threadHtml session-ended fallback missing');
  // live single prompt → Working on + label
  const live = unitHtml(buildUnits(buildThreads([mk('s', minAgo(2), 'busy ask', null, false)]))[0]);
  assert.ok(/Working on:/.test(live) && /Working now/.test(live), 'live single-prompt card lost its amber state');
});

check('XSS: hostile ask/summary/project escaped in unit html', () => {
  const entries = [
    mk('main', '2026-07-16T12:00:00Z', '<img src=x onerror=alert(1)>', 'Done <script>', true),
    mk('sub', '2026-07-16T12:05:00Z', 'ok', 'more', true, { project: '<b>proj</b>' }),
  ];
  const html = unitHtml(buildUnits(buildThreads(entries))[0]);
  assert.ok(!/<script>/.test(html) && !/<img src=x/.test(html), 'raw markup escaped');
  assert.ok(/&lt;/.test(html), 'escaped entities present');
});

check('new prompt lands in same unit (count bumps, still 1 unit)', () => {
  const base = [mk('main', '2026-07-16T12:00:00Z', 'plan', 'Planned', true), mk('sub', '2026-07-16T12:05:00Z', 'A', 'Did A', true)];
  const before = buildUnits(buildThreads(base))[0];
  const after = buildUnits(buildThreads(base.concat([mk('sub', '2026-07-16T12:06:00Z', 'A2', 'Did A2', true)])))[0];
  assert.strictEqual(before.promptCount, 2);
  assert.strictEqual(after.promptCount, 3);
});

// ---- session page: subagent attribution + per-prompt dropdowns + full summary ----
const mainAndSubs = () => {
  const entries = [
    mk('main', minAgo(60), 'P1 ask', null, false),
    mk('main', minAgo(40), 'P2 ask', 'Main done', true),
    mk('sub-mid', minAgo(50), 'x', 'Mid work', true),      // starts between P1 and P2
    mk('sub-late', minAgo(10), 'y', 'Late work', true),    // starts after the last prompt
    mk('sub-early', minAgo(90), 'z', 'Early work', true),  // starts before the first prompt
  ];
  const threads = buildThreads(entries);
  const main = threads.filter(r => r.entries[0].session === 'main')[0];
  const subs = threads.filter(r => r !== main)
    .sort((a, b) => String(a.entries[a.entries.length - 1].ts).localeCompare(String(b.entries[b.entries.length - 1].ts)));
  return { main, subs };
};

check('attribution: between P1/P2 → P1; after last → last; before first → nearest (first)', () => {
  const { main, subs } = mainAndSubs();
  const prompts = main.entries.slice().reverse();
  const buckets = attributeSubagents(prompts, subs);
  assert.strictEqual(buckets.length, 2, 'one bucket per prompt');
  const names = b => b.map(r => r.entries[0].session);
  assert.ok(names(buckets[0]).indexOf('sub-mid') !== -1, 'mid sub not under P1');
  assert.ok(names(buckets[0]).indexOf('sub-early') !== -1, 'pre-first sub not under first prompt');
  assert.ok(names(buckets[1]).indexOf('sub-late') !== -1, 'late sub not under last prompt');
  assert.strictEqual(names(buckets[0]).length, 2);
  assert.strictEqual(names(buckets[1]).length, 1);
});

check('session page: dropdowns collapsed by default, neutral border, none when promptless', () => {
  const { main, subs } = mainAndSubs();
  const html = sessionPageHtml(main, subs);
  assert.strictEqual((html.match(/data-subagents="/g) || []).length, 2, 'both prompts have attributed subs here');
  assert.ok(/2 subagents/.test(html) && /1 subagent</.test(html), 'counts wrong');
  assert.ok(/data-subagents="p0"[^>]*>[\s\S]*?&#9656;/.test(html), 'chevron-right collapsed marker missing');
  assert.ok(html.indexOf('display:none;margin:0 0 10px 27px;padding-left:14px;border-left:2px solid var(--border)') !== -1, 'nested thread not collapsed or not neutral-bordered');
  assert.ok(html.indexOf('border-left:2px solid var(--accent)') === -1 && html.indexOf('border-left:3px solid var(--accent)') === -1, 'accent border leaked into subagent thread');
  assert.ok(/Agent 1/.test(html) && /Agent 2/.test(html) && /Agent 3/.test(html), 'chronological agent numbering missing');
  assert.ok(/Mid work/.test(html) && /Late work/.test(html) && /Early work/.test(html), 'subagent one-line summaries missing');
  // a session with no sibling runs renders zero dropdowns
  const solo = sessionPageHtml(main, []);
  assert.strictEqual((solo.match(/data-subagents="/g) || []).length, 0, 'dropdown rendered with no subagents');
});

check('session page headline renders the FULL summary (summaryFull beats the clipped one)', () => {
  const full = 'The whole long summary. ' + 'F'.repeat(400) + ' The end, no ellipsis.';
  const t = buildThreads([mk('main', minAgo(30), 'ask', 'Clipped version…', true, { summaryFull: full })])[0];
  const html = sessionPageHtml(t, []);
  assert.ok(html.indexOf('F'.repeat(400)) !== -1 && /The end, no ellipsis\./.test(html), 'full summary not rendered');
  assert.ok(!/Clipped version…<\/h1>/.test(html), 'clipped text still the headline');
  // entries without summaryFull (team rows) fall back to the clipped summary
  const tOld = buildThreads([mk('main', minAgo(30), 'ask', 'Clipped version…', true)])[0];
  assert.ok(/Clipped version…/.test(sessionPageHtml(tOld, [])), 'fallback to clipped summary lost');
});

check('subagent line fallbacks: distilled > harvested > files > no summary', () => {
  const dist = buildThreads([mk('a', minAgo(10), 'x', 'Distilled done', true)])[0];
  assert.strictEqual(subagentLine(dist), 'Distilled done');
  const harv = buildThreads([mk('b', minAgo(10), 'x', 'Harvested tail', false)])[0];
  assert.strictEqual(subagentLine(harv), 'Harvested tail');
  const filesOnly = buildThreads([mk('c', minAgo(10), 'x', null, false, { files: ['a.js', 'b.js', 'c.js'] })])[0];
  assert.strictEqual(subagentLine(filesOnly), 'worked on a.js, b.js +1');
  const bare = buildThreads([mk('d', minAgo(10), 'x', null, false)])[0];
  assert.ok(/no summary/.test(subagentLine(bare)));
});

check('hideProject omits the project pill (unit card, clutter-guard card, and via feedDayGroupHtml)', () => {
  // Multi-prompt unit → unitHtml's own meta row.
  const multi = [mk('main', minAgo(60), 'p1', 'Done', true), mk('main', minAgo(55), 'p2', null, false)];
  const u = buildUnits(buildThreads(multi))[0];
  assert.ok(unitHtml(u).indexOf('>membridge</span>') !== -1, 'default unit card lost its project pill');
  assert.ok(unitHtml(u, { hideProject: true }).indexOf('>membridge</span>') === -1, 'hideProject leaked the pill on the unit card');
  // Single-run single-prompt → the clutter guard delegates to threadHtml with opts.
  const solo = buildUnits(buildThreads([mk('s', minAgo(60), 'just one', 'A done', true)]))[0];
  assert.ok(unitHtml(solo).indexOf('>membridge</span>') !== -1, 'default clutter-guard card lost its project pill');
  assert.ok(unitHtml(solo, { hideProject: true }).indexOf('>membridge</span>') === -1, 'hideProject leaked the pill on the clutter-guard card');
  // feedDayGroupHtml threads the option through (and stays default without it).
  assert.ok(feedDayGroupHtml(multi).indexOf('>membridge</span>') !== -1, 'feedDayGroupHtml default lost the pill');
  assert.ok(feedDayGroupHtml(multi, { hideProject: true }).indexOf('>membridge</span>') === -1, 'feedDayGroupHtml did not pass hideProject through');
});

check('XSS: hostile subagent summary/files escaped on the session page', () => {
  const { main } = mainAndSubs();
  const evil = buildThreads([mk('evil', minAgo(50), 'x', '<img src=x onerror=alert(1)>', true)])
    .filter(r => r.entries[0].session === 'evil');
  const html = sessionPageHtml(main, evil);
  assert.ok(html.indexOf('<img') === -1 && /&lt;img/.test(html), 'hostile subagent summary leaked');
});

console.log('\n' + pass + ' fixture checks passed');
