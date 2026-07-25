'use strict';
// The first-run setup wizard: three steps, shown once, on a machine that has
// nothing watched yet.
//
// The point of step 3 is the whole reason this exists. Before it, first run
// only ever *described* MemBridge ("the daemon is running, N tools detected")
// and then asked the user to trust that something useful would happen later.
// Because discovery finds projects whose session history is ALREADY on disk, a
// first sync can run immediately — so setup can end by showing the real memory
// block it just wrote into a real CLAUDE.md, with the real path. The user
// leaves having seen the product work rather than having been promised it.
//
// Exported as source strings (setupCss, setupJs) and interpolated into the
// single self-contained dashboard page, matching dashboard-team.js.

const setupCss = `
#view-setup { flex:1; overflow-y:auto; display:none; }
#view-setup.active { display:block; }
.sw-wrap { max-width:720px; margin:0 auto; padding:64px 28px 90px; animation:mbFade .45s cubic-bezier(.16,1,.3,1); }
.sw-steps { display:flex; align-items:center; gap:8px; margin-bottom:30px; }
.sw-dot { height:3px; flex:1; border-radius:2px; background:var(--border); transition:background .35s ease; }
.sw-dot.on { background:var(--grad); }
.sw-kicker { font-family:var(--mono); font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); margin-bottom:14px; }
.sw-title { font-family:Calistoga,Georgia,serif; font-size:34px; font-weight:400; letter-spacing:-0.02em; line-height:1.12; margin:0 0 12px; }
.sw-lede { color:var(--text2); font-size:14.5px; line-height:1.6; margin:0 0 28px; max-width:56ch; }
.sw-card { border:1px solid var(--border); border-radius:20px; background:var(--card); box-shadow:var(--shadow-md); overflow:hidden; }
.sw-row { display:flex; gap:14px; align-items:center; padding:15px 22px; border-top:1px solid var(--border); }
.sw-row:first-child { border-top:none; }
.sw-tick { width:24px; height:24px; border-radius:8px; background:var(--grad); color:#fff; font-size:11px;
  display:flex; align-items:center; justify-content:center; flex:none; }
.sw-tick.off { background:none; border:1.5px dashed var(--border2); }
.sw-rowmain { flex:1; min-width:0; }
.sw-rowname { font-weight:600; font-size:13.5px; }
.sw-rowsub { color:var(--text3); font-size:12.5px; }
.sw-pick { display:flex; gap:13px; align-items:flex-start; padding:13px 22px; border-top:1px solid var(--border); cursor:pointer; }
.sw-pick:first-child { border-top:none; }
.sw-pick:hover { background:var(--surface2); }
.sw-pick input { margin-top:3px; accent-color:var(--accent); width:15px; height:15px; flex:none; }
.sw-pickpath { font-family:var(--mono); font-size:11px; color:var(--text3); word-break:break-all; }
.sw-scroll { max-height:340px; overflow-y:auto; }
.sw-block { font-family:var(--mono); font-size:11.5px; line-height:1.75; white-space:pre-wrap; word-break:break-word;
  padding:20px 22px; background:var(--surface2); border-radius:14px; border:1px solid var(--border); max-height:300px; overflow-y:auto; }
.sw-path { font-family:var(--mono); font-size:11.5px; color:var(--text2); margin:0 0 10px; word-break:break-all; }
.sw-btns { display:flex; align-items:center; gap:12px; margin-top:30px; }
.sw-skip { color:var(--text3); font-size:12.5px; cursor:pointer; }
.sw-skip:hover { color:var(--text2); text-decoration:underline; }
.sw-err { color:var(--danger); font-size:12.5px; margin-top:12px; }
.sw-finish { margin-top:22px; padding:16px 20px; border-radius:14px; background:var(--accent-soft);
  border:1px solid var(--accent-brd); font-size:13px; color:var(--text2); line-height:1.6; }
`;

const setupJs = `
/* ===================== first-run setup wizard =====================
   Gated by /api/status: no watched projects AND setup never completed. The
   gate is deliberately conservative — anything unknown means "don't take over
   the window". */
var swStep = 1, swScan = null, swPicked = {}, swBusy = false, swErr = '', swResult = null;

// Pure: which discovered projects start checked. The busiest few, because a
// first run that pre-selects twenty folders is as bad as one that selects
// none — the user cannot review that many and will either accept blindly or
// give up. Already-tracked projects never appear.
function swPreselect(projects, limit) {
  var cap = limit || 5;
  return (projects || [])
    .filter(function (p) { return p && p.path && !p.tracked; })
    .slice()
    .sort(function (a, b) { return (b.sessionCount || 0) - (a.sessionCount || 0); })
    .slice(0, cap)
    .map(function (p) { return p.path; });
}
// Pure: does the wizard take the window? Unknown status (a failed fetch) must
// never trigger it — better to show the normal dashboard than to hijack a
// working install because one poll failed.
function swShouldRun(status) {
  if (!status || typeof status !== 'object') return false;
  if (status.setupDone) return false;
  return status.projectCount === 0;
}

function swEnter() {
  swStep = 1; swErr = ''; swResult = null;
  location.hash = '#setup';
  swLoadScan();
}
function swLoadScan() {
  fetch('/api/scan').then(function (r) { return r.json(); }).catch(function () { return null; })
    .then(function (s) {
      swScan = s || { adapters: [], projects: [] };
      swPicked = {};
      swPreselect(swScan.projects, 5).forEach(function (p) { swPicked[p] = true; });
      swRender();
    });
}
function swToolLine() {
  var found = {};
  ((swScan && swScan.adapters) || []).filter(function (a) { return a.exists; })
    .forEach(function (a) { found[a.displayName] = 1; });
  return Object.keys(found);
}
function swDiscovered() {
  return ((swScan && swScan.projects) || []).filter(function (p) { return !p.tracked; });
}
function swPickedPaths() {
  return Object.keys(swPicked).filter(function (p) { return swPicked[p]; });
}
function swDots() {
  var out = '';
  for (var i = 1; i <= 3; i++) out += '<div class="sw-dot' + (i <= swStep ? ' on' : '') + '"></div>';
  return '<div class="sw-steps">' + out + '</div>';
}
function swPrimary(label, act, disabled) {
  return '<button data-sw="' + act + '"' + (disabled ? ' disabled' : '') +
    ' style="height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:' +
    (disabled ? 'default' : 'pointer') + ';opacity:' + (disabled ? '.5' : '1') +
    ';font-family:inherit;box-shadow:var(--shadow-accent)">' + esc(label) + '</button>';
}
function swRender() {
  var host = document.getElementById('setupRoot'); if (!host) return;
  var body = swStep === 1 ? swStep1() : swStep === 2 ? swStep2() : swStep3();
  host.innerHTML = '<div class="sw-wrap">' + swDots() + body +
    (swErr ? '<div class="sw-err">' + esc(swErr) + '</div>' : '') + '</div>';
}

/* Step 1 — what a solo user actually gets, evidenced by their own machine. */
function swStep1() {
  var tools = swToolLine();
  var toolsRow = tools.length
    ? '<div class="sw-row"><span class="sw-tick">\\u2713</span><div class="sw-rowmain">' +
        '<span class="sw-rowname">' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ' found</span>' +
        '<span class="sw-rowsub"> \\u2014 ' + tools.map(esc).join(', ') + '</span></div></div>'
    : '<div class="sw-row"><span class="sw-tick off"></span><div class="sw-rowmain">' +
        '<span class="sw-rowname">No tools detected yet</span>' +
        '<span class="sw-rowsub"> \\u2014 MemBridge picks them up automatically once you use one</span></div></div>';
  return '<div class="sw-kicker">Setup \\u00b7 1 of 3</div>' +
    '<h1 class="sw-title">Your tools each keep their own memory.<br>Now they share one.</h1>' +
    '<p class="sw-lede">Claude Code does not know what Codex did yesterday, and neither remembers what you decided last week. ' +
    'MemBridge watches the session logs they already write, distills one small memory per project, and puts it in the files every tool reads at startup.</p>' +
    '<div class="sw-card">' + toolsRow +
      '<div class="sw-row"><span class="sw-tick">\\u2713</span><div class="sw-rowmain">' +
        '<span class="sw-rowname">Running on this Mac only</span>' +
        '<span class="sw-rowsub"> \\u2014 no account, no API keys, nothing uploaded</span></div></div>' +
    '</div>' +
    '<div class="sw-btns">' + swPrimary('Continue', 'next') +
      '<span class="sw-skip" data-sw="skip">Skip setup</span></div>';
}

/* Step 2 — pick projects. No path typing: discovery already knows. */
function swStep2() {
  var disc = swDiscovered();
  if (!disc.length) {
    return '<div class="sw-kicker">Setup \\u00b7 2 of 3</div>' +
      '<h1 class="sw-title">No past work found yet</h1>' +
      '<p class="sw-lede">MemBridge could not find projects your AI tools have already worked in. ' +
      'That is normal on a new machine \\u2014 use Claude Code or Codex in any folder and it will appear here on the next scan.</p>' +
      '<div class="sw-btns">' + swPrimary('Finish', 'finish') +
        '<span class="sw-skip" data-sw="skip">Skip setup</span></div>';
  }
  var rows = disc.map(function (p) {
    var n = p.sessionCount || 0;
    var tools = Object.keys(p.bySource || {}).map(esc).join(', ');
    return '<label class="sw-pick"><input type="checkbox" data-sw-pick="' + esc(p.path) + '"' +
      (swPicked[p.path] ? ' checked' : '') + '>' +
      '<span class="sw-rowmain"><span class="sw-rowname">' + esc(p.name || p.path) + '</span>' +
      '<span class="sw-rowsub"> \\u2014 ' + n + ' session' + (n === 1 ? '' : 's') + (tools ? ' \\u00b7 ' + tools : '') + '</span>' +
      '<div class="sw-pickpath">' + esc(p.path) + '</div></span></label>';
  }).join('');
  var picked = swPickedPaths().length;
  return '<div class="sw-kicker">Setup \\u00b7 2 of 3</div>' +
    '<h1 class="sw-title">Pick the projects to remember</h1>' +
    '<p class="sw-lede">These are folders your AI tools have already worked in, so their memory can be built from history that is already on this Mac. ' +
    'The busiest are pre-selected \\u2014 you can change any of them, and add more later.</p>' +
    '<div class="sw-card sw-scroll">' + rows + '</div>' +
    '<div class="sw-btns">' + swPrimary(picked ? 'Watch ' + picked + ' project' + (picked === 1 ? '' : 's') : 'Select a project', 'adopt', !picked) +
      '<span class="sw-skip" data-sw="skip">Skip setup</span></div>';
}

/* Step 3 — the proof. Shows the block that was actually written. */
function swStep3() {
  if (swBusy) {
    return '<div class="sw-kicker">Setup \\u00b7 3 of 3</div>' +
      '<h1 class="sw-title">Reading your history\\u2026</h1>' +
      '<p class="sw-lede">Distilling the sessions already on this Mac into project memory. This takes a moment.</p>';
  }
  var r = swResult || {};
  if (!r.block) {
    // Honest empty state — never an empty card pretending to be proof.
    return '<div class="sw-kicker">Setup \\u00b7 3 of 3</div>' +
      '<h1 class="sw-title">You\\u2019re set up</h1>' +
      '<p class="sw-lede">' + esc(r.note || 'Nothing to distill from these projects yet. The memory block is written after your next session in one of them \\u2014 nothing more to do.') + '</p>' +
      '<div class="sw-btns">' + swPrimary('Open MemBridge', 'finish') + '</div>';
  }
  return '<div class="sw-kicker">Setup \\u00b7 3 of 3</div>' +
    '<h1 class="sw-title">This is now in your project</h1>' +
    '<p class="sw-lede">MemBridge just wrote this from work already on this Mac. Every tool that reads this file starts with it \\u2014 no prompting, no pasting.</p>' +
    '<p class="sw-path">' + esc(r.file || '') + '</p>' +
    '<div class="sw-block">' + esc(r.block) + '</div>' +
    '<div class="sw-finish">MemBridge keeps this current on its own. It only ever owns the text between its two markers \\u2014 the rest of the file is yours and is never touched.</div>' +
    '<div class="sw-btns">' + swPrimary('Open MemBridge', 'finish') + '</div>';
}

// Adopt the picked projects, sync immediately, then read back what was written.
function swAdopt() {
  var paths = swPickedPaths();
  if (!paths.length) return;
  swStep = 3; swBusy = true; swErr = ''; swRender();
  fetch('/api/projects/adopt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: paths }),
  }).then(function (r) { return r.json(); })
    .then(function () {
      return fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function (r) { return r.json(); }).catch(function () { return null; });
    })
    .then(function () { return swFetchProof(paths); })
    .then(function (proof) { swBusy = false; swResult = proof; swRender(); })
    .catch(function (err) {
      // A failure here must not strand the user mid-wizard: fall through to the
      // honest "set up, nothing to show yet" ending rather than a dead screen.
      swBusy = false;
      swResult = { note: 'Your projects are being watched. MemBridge could not read back a memory block just now (' +
        ((err && err.message) || 'unknown error') + '), but it writes one after your next session.' };
      swRender();
    });
}
// Read the memory block back from the first adopted project that has one.
function swFetchProof(paths) {
  var i = 0;
  function tryNext() {
    if (i >= paths.length) return Promise.resolve({ note: '' });
    var p = paths[i++];
    return fetch('/api/project/block?path=' + encodeURIComponent(p))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (m) {
        if (m && m.block && String(m.block).trim()) {
          return { block: String(m.block).trim(), file: m.file || p };
        }
        return tryNext();
      });
  }
  return tryNext();
}
// Finishing and skipping both record completion — a dismissed wizard must stay
// dismissed. Navigation happens regardless of whether the write succeeds, so a
// config failure can never trap someone on this screen.
function swComplete() {
  fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ setupCompletedAt: new Date().toISOString() }),
  }).catch(function () {});
  location.hash = '#home';
}
document.getElementById('view-setup').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-sw]');
  if (!btn || btn.disabled) return;
  var act = btn.getAttribute('data-sw');
  if (act === 'next') { swStep = 2; swRender(); return; }
  if (act === 'adopt') { swAdopt(); return; }
  if (act === 'skip' || act === 'finish') { swComplete(); return; }
});
document.getElementById('view-setup').addEventListener('change', function (e) {
  var box = e.target.closest('[data-sw-pick]');
  if (!box) return;
  swPicked[box.getAttribute('data-sw-pick')] = !!box.checked;
  swRender();
});
`;

module.exports = { setupCss, setupJs };
