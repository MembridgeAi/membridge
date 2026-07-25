'use strict';
// The guided team upgrade: four steps that end with a link you can send a
// teammate.
//
// Before this, a solo user clicking toward a team met teamScreenNone — a
// sign-in wall whose entire explanation was "A team is two or more people
// whose session memories sync". That asks someone to create an account before
// telling them what they get, and leaves the real work (create the team, link
// projects, make an invite) as three more separate discoveries afterwards.
//
// So: say what changes first, treat signing in as a step INSIDE the flow
// rather than a gate in front of it, make project sharing an explicit opt-in,
// and finish by handing over something sendable. Every failure leaves the user
// cleanly solo — there is no half-upgraded state to get stuck in.
//
// Exported as source strings and interpolated into the single self-contained
// dashboard page, matching dashboard-team.js and dashboard/setup.js.

const upgradeCss = `
#view-upgrade { flex:1; overflow-y:auto; display:none; }
#view-upgrade.active { display:block; }
.ug-wrap { max-width:660px; margin:0 auto; padding:60px 28px 90px; animation:mbFade .45s cubic-bezier(.16,1,.3,1); }
.ug-steps { display:flex; align-items:center; gap:8px; margin-bottom:28px; }
.ug-dot { height:3px; flex:1; border-radius:2px; background:var(--border); transition:background .35s ease; }
.ug-dot.on { background:var(--grad); }
.ug-kicker { font-family:var(--mono); font-size:10.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--accent); margin-bottom:14px; }
.ug-title { font-family:Calistoga,Georgia,serif; font-size:32px; font-weight:400; letter-spacing:-0.02em; line-height:1.14; margin:0 0 12px; }
.ug-lede { color:var(--text2); font-size:14.5px; line-height:1.6; margin:0 0 26px; max-width:56ch; }
.ug-card { border:1px solid var(--border); border-radius:20px; background:var(--card); box-shadow:var(--shadow-md); overflow:hidden; }
.ug-row { display:flex; gap:13px; align-items:flex-start; padding:15px 22px; border-top:1px solid var(--border); }
.ug-row:first-child { border-top:none; }
.ug-bullet { width:22px; height:22px; border-radius:7px; background:var(--grad); color:#fff; font-size:11px;
  display:flex; align-items:center; justify-content:center; flex:none; margin-top:1px; }
.ug-rowmain { flex:1; min-width:0; font-size:13.5px; line-height:1.55; }
.ug-rowname { font-weight:600; }
.ug-rowsub { color:var(--text3); }
.ug-field { margin-bottom:14px; }
.ug-label { display:block; font-size:12.5px; font-weight:600; color:var(--text2); margin-bottom:6px; }
.ug-input { width:100%; height:42px; padding:0 13px; border-radius:11px; border:1px solid var(--border);
  background:var(--bg2); color:var(--text); font-family:inherit; font-size:14px; outline:none; }
.ug-input:focus { border-color:var(--accent-brd); box-shadow:var(--shadow-accent); }
.ug-or { display:flex; align-items:center; gap:12px; margin:20px 0; color:var(--text3); font-size:12px; }
.ug-or::before, .ug-or::after { content:''; flex:1; height:1px; background:var(--border); }
.ug-gh { width:100%; height:46px; border-radius:12px; border:1px solid var(--border2); background:var(--surface2);
  color:var(--text); font-size:14px; font-weight:600; cursor:pointer; font-family:inherit;
  display:flex; align-items:center; justify-content:center; gap:9px; }
.ug-gh:hover { border-color:var(--accent-brd); }
.ug-pick { display:flex; gap:13px; align-items:flex-start; padding:13px 22px; border-top:1px solid var(--border); cursor:pointer; }
.ug-pick:first-child { border-top:none; }
.ug-pick:hover { background:var(--surface2); }
.ug-pick input { margin-top:3px; accent-color:var(--accent); width:15px; height:15px; flex:none; }
.ug-pickpath { font-family:var(--mono); font-size:11px; color:var(--text3); word-break:break-all; }
.ug-link { font-family:var(--mono); font-size:12.5px; padding:16px 18px; border-radius:13px; background:var(--surface2);
  border:1px solid var(--border); word-break:break-all; line-height:1.6; }
.ug-btns { display:flex; align-items:center; gap:12px; margin-top:26px; }
.ug-back { color:var(--text3); font-size:12.5px; cursor:pointer; }
.ug-back:hover { color:var(--text2); text-decoration:underline; }
.ug-err { color:var(--danger); font-size:13px; margin-top:14px; line-height:1.5; }
.ug-note { margin-top:20px; padding:15px 18px; border-radius:13px; background:var(--accent-soft);
  border:1px solid var(--accent-brd); font-size:12.5px; color:var(--text2); line-height:1.6; }
`;

const upgradeJs = `
/* ===================== guided team upgrade =====================
   Reached from the header CTA. Four steps: what changes -> account ->
   name the team and choose what to share -> the invite link. */
var ugStep = 1, ugBusy = false, ugErr = '', ugMode = 'signup';
var ugProjects = [], ugShare = {}, ugTeam = null, ugInvite = null, ugPoll = null;

// Pure: where the flow should resume from, given who the user already is.
// Someone already signed in must not be shown a sign-up form, and someone
// already on a team is not upgrading at all — they want the Team screen.
function ugResumeStep(teamState) {
  if (!teamState || typeof teamState !== 'object') return 1;
  if (((teamState.teams || []).length)) return 0;   // 0 = not an upgrade; go to Team
  return teamState.authenticated ? 3 : 1;
}
// Pure: a failure at any step must leave the user solo rather than stranded.
// Only a created team survives a failure, and it is carried forward so a
// retry never creates a second one.
function ugRecover(state, err) {
  return {
    step: state && state.team ? 3 : (state && state.step) || 1,
    team: (state && state.team) || null,
    err: (err && err.message) || String(err || 'Something went wrong.'),
  };
}

function ugEnter() {
  ugErr = ''; ugBusy = false; ugInvite = null;
  location.hash = '#upgrade';
  apiGet('/api/team').then(function (t) {
    var next = ugResumeStep(t);
    if (next === 0) { location.hash = '#team'; return; }   // already on a team
    ugStep = next;
    if (ugStep === 3) ugLoadProjects();
    ugRender();
  }).catch(function () { ugStep = 1; ugRender(); });
}
function ugLoadProjects() {
  fetch('/api/projects').then(function (r) { return r.json(); }).catch(function () { return []; })
    .then(function (list) {
      // Only unshared projects can be opted in; anything already on a team is
      // not a choice this flow gets to make.
      ugProjects = (list || []).filter(function (p) { return !p.team; });
      ugRender();
    });
}
function ugDots() {
  var out = '';
  for (var i = 1; i <= 4; i++) out += '<div class="ug-dot' + (i <= ugStep ? ' on' : '') + '"></div>';
  return '<div class="ug-steps">' + out + '</div>';
}
function ugPrimary(label, act, disabled) {
  return '<button data-ug="' + act + '"' + (disabled || ugBusy ? ' disabled' : '') +
    ' style="height:44px;padding:0 22px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:' +
    (disabled || ugBusy ? 'default' : 'pointer') + ';opacity:' + (disabled || ugBusy ? '.5' : '1') +
    ';font-family:inherit;box-shadow:var(--shadow-accent)">' + esc(ugBusy ? 'Working\\u2026' : label) + '</button>';
}
function ugRender() {
  var host = document.getElementById('upgradeRoot'); if (!host) return;
  var body = ugStep === 1 ? ugStep1() : ugStep === 2 ? ugStep2() : ugStep === 3 ? ugStep3() : ugStep4();
  host.innerHTML = '<div class="ug-wrap">' + ugDots() + body +
    (ugErr ? '<div class="ug-err">' + esc(ugErr) + '</div>' : '') + '</div>';
}

/* Step 1 — what actually changes. Stated before anything is asked for. */
function ugStep1() {
  return '<div class="ug-kicker">Invite a teammate \\u00b7 1 of 4</div>' +
    '<h1 class="ug-title">Share the memory, not the noise</h1>' +
    '<p class="ug-lede">Right now your project memory is yours alone. On a team, each person\\u2019s distilled session memory lands in the other\\u2019s context files \\u2014 so their Claude Code starts knowing what your Codex just did.</p>' +
    '<div class="ug-card">' +
      '<div class="ug-row"><span class="ug-bullet">\\u2713</span><div class="ug-rowmain">' +
        '<span class="ug-rowname">You choose what is shared</span> ' +
        '<span class="ug-rowsub">\\u2014 projects stay local until you opt each one in.</span></div></div>' +
      '<div class="ug-row"><span class="ug-bullet">\\u2713</span><div class="ug-rowmain">' +
        '<span class="ug-rowname">Sealed before it leaves</span> ' +
        '<span class="ug-rowsub">\\u2014 end-to-end encrypted, and secrets and private paths are scrubbed first.</span></div></div>' +
      '<div class="ug-row"><span class="ug-bullet">\\u2713</span><div class="ug-rowmain">' +
        '<span class="ug-rowname">Summaries, not transcripts</span> ' +
        '<span class="ug-rowsub">\\u2014 a short brief per session, never your raw prompts or code.</span></div></div>' +
    '</div>' +
    '<div class="ug-btns">' + ugPrimary('Continue', 'to-account') +
      '<span class="ug-back" data-ug="cancel">Not now</span></div>';
}

/* Step 2 — the account, framed as what it is for. */
function ugStep2() {
  var signup = ugMode === 'signup';
  return '<div class="ug-kicker">Invite a teammate \\u00b7 2 of 4</div>' +
    '<h1 class="ug-title">' + (signup ? 'Create your account' : 'Sign in') + '</h1>' +
    '<p class="ug-lede">A team needs an identity your teammates can be invited by. This is the only part of MemBridge that needs an account \\u2014 your local memory never did.</p>' +
    '<button class="ug-gh" data-ug="github">Continue with GitHub</button>' +
    '<div class="ug-or">or use email</div>' +
    '<form data-ug-form="account">' +
      (signup ? '<div class="ug-field"><label class="ug-label" for="ugName">Your name</label>' +
        '<input class="ug-input" id="ugName" type="text" autocomplete="name" placeholder="How teammates will see you"></div>' : '') +
      '<div class="ug-field"><label class="ug-label" for="ugEmail">Email</label>' +
        '<input class="ug-input" id="ugEmail" type="email" autocomplete="email"></div>' +
      '<div class="ug-field"><label class="ug-label" for="ugPass">Password</label>' +
        '<input class="ug-input" id="ugPass" type="password" autocomplete="' + (signup ? 'new-password' : 'current-password') + '">' +
        (signup ? '<div class="ug-rowsub" style="margin-top:6px;font-size:12px">A new password for MemBridge \\u2014 at least 6 characters.</div>' : '') +
      '</div>' +
      '<div class="ug-btns">' + ugPrimary(signup ? 'Create account' : 'Sign in', 'account') +
        '<span class="ug-back" data-ug="mode">' + (signup ? 'I already have an account' : 'Create one instead') + '</span></div>' +
    '</form>';
}

/* Step 3 — name the team and opt projects in. Nothing shares by default. */
function ugStep3() {
  var rows = ugProjects.length
    ? ugProjects.map(function (p) {
        return '<label class="ug-pick"><input type="checkbox" data-ug-share="' + esc(p.path) + '"' +
          (ugShare[p.path] ? ' checked' : '') + '>' +
          '<span class="ug-rowmain"><span class="ug-rowname">' + esc(p.name || p.path) + '</span>' +
          '<div class="ug-pickpath">' + esc(p.path) + '</div></span></label>';
      }).join('')
    : '<div class="ug-row"><div class="ug-rowmain ug-rowsub">No local projects to share yet. You can share them later from the Team screen.</div></div>';
  var n = Object.keys(ugShare).filter(function (k) { return ugShare[k]; }).length;
  return '<div class="ug-kicker">Invite a teammate \\u00b7 3 of 4</div>' +
    '<h1 class="ug-title">' + (ugTeam ? 'Choose what to share' : 'Name your team') + '</h1>' +
    '<p class="ug-lede">Pick which projects your teammates see. Nothing is shared unless you tick it, and you can change any of this later.</p>' +
    (ugTeam ? '' :
      '<div class="ug-field"><label class="ug-label" for="ugTeamName">Team name</label>' +
      '<input class="ug-input" id="ugTeamName" type="text" placeholder="Your company or squad"></div>') +
    '<div class="ug-card">' + rows + '</div>' +
    '<div class="ug-btns">' + ugPrimary(n ? 'Create team and share ' + n : 'Create team', 'create') +
      '<span class="ug-back" data-ug="cancel">Cancel</span></div>';
}

/* Step 4 — something sendable. */
function ugStep4() {
  var link = (ugInvite && (ugInvite.url || ugInvite.token)) || '';
  return '<div class="ug-kicker">Invite a teammate \\u00b7 4 of 4</div>' +
    '<h1 class="ug-title">Send this to your teammate</h1>' +
    '<p class="ug-lede">They install MemBridge, open this link, and your shared projects start syncing both ways. Until someone joins, nothing changes for you.</p>' +
    '<div class="ug-link">' + esc(link) + '</div>' +
    '<div class="ug-note">Keep this link private \\u2014 anyone who opens it joins your team. You can revoke it any time from the Team screen.</div>' +
    '<div class="ug-btns">' + ugPrimary('Copy link', 'copy') +
      '<span class="ug-back" data-ug="done">Done</span></div>';
}

// --- actions -------------------------------------------------------------
function ugFail(err) {
  var r = ugRecover({ step: ugStep, team: ugTeam }, err);
  ugBusy = false; ugStep = r.step; ugErr = r.err;
  ugRender();
}
function ugAccount() {
  var signup = ugMode === 'signup';
  var email = (document.getElementById('ugEmail') || {}).value || '';
  var pass = (document.getElementById('ugPass') || {}).value || '';
  var name = (document.getElementById('ugName') || {}).value || '';
  if (!email.trim() || !pass) { ugErr = 'Email and password are required.'; ugRender(); return; }
  if (signup && !name.trim()) { ugErr = 'Your name is required so teammates can recognise you.'; ugRender(); return; }
  ugBusy = true; ugErr = ''; ugRender();
  var url = signup ? '/api/team/signup' : '/api/team/login';
  var payload = signup
    ? { email: email.trim(), password: pass, displayName: name.trim() }
    : { email: email.trim(), password: pass };
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
    .then(function (r) { return r.json().then(function (d) { if (!r.ok || d.error) throw new Error(d.error || 'Sign-in failed.'); return d; }); })
    .then(function (d) {
      ugBusy = false;
      // A backend that requires email confirmation cannot proceed to team
      // creation yet — say so plainly instead of failing at the next step.
      if (d && d.needsConfirmation) {
        ugErr = 'Check ' + (d.email || 'your inbox') + ' to confirm the account, then come back and sign in.';
        ugMode = 'login'; ugRender(); return;
      }
      ugStep = 3; ugLoadProjects(); ugRender();
    })
    .catch(ugFail);
}
function ugGithub() {
  window.open('/team/oauth/github', 'membridge-github-oauth', 'width=620,height=760');
  if (ugPoll) clearInterval(ugPoll);
  var tries = 0;
  ugPoll = setInterval(function () {
    if (++tries > 200) { clearInterval(ugPoll); ugPoll = null; return; }
    apiGet('/api/team').then(function (d) {
      if (d && d.authenticated) {
        clearInterval(ugPoll); ugPoll = null;
        ugErr = ''; ugStep = 3; ugLoadProjects(); ugRender();
      }
    }).catch(function () {});
  }, 1500);
}
// Create the team, link the ticked projects, then mint the invite. A team that
// was already created is reused, so a retry after a link failure never leaves
// two teams behind.
function ugCreate() {
  var name = ugTeam ? ugTeam.name : ((document.getElementById('ugTeamName') || {}).value || '').trim();
  if (!ugTeam && !name) { ugErr = 'Give the team a name.'; ugRender(); return; }
  var paths = Object.keys(ugShare).filter(function (k) { return ugShare[k]; });
  ugBusy = true; ugErr = ''; ugRender();
  var made = ugTeam
    ? Promise.resolve(ugTeam)
    : fetch('/api/team/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok || d.error) throw new Error(d.error || 'Could not create the team.'); return d; }); })
        .then(function (d) { ugTeam = { teamId: d.team_id, name: name }; return ugTeam; });
  made
    .then(function (team) {
      // Link failures must not lose the team: each is reported, none aborts
      // the invite, and unlinked projects simply stay local.
      return paths.reduce(function (chain, p) {
        return chain.then(function (failed) {
          return fetch('/api/team/link', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: p, teamId: team.teamId, teamName: team.name }),
          }).then(function (r) { return r.ok ? failed : failed.concat([p]); })
            .catch(function () { return failed.concat([p]); });
        });
      }, Promise.resolve([])).then(function (failed) { return { team: team, failed: failed }; });
    })
    .then(function (out) {
      return fetch('/api/team/invite', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teamId: out.team.teamId }),
      }).then(function (r) { return r.json().then(function (d) { if (!r.ok || d.error) throw new Error(d.error || 'Could not create an invite.'); return d; }); })
        .then(function (inv) { return { invite: inv, failed: out.failed }; });
    })
    .then(function (out) {
      ugBusy = false; ugInvite = out.invite; ugStep = 4;
      ugErr = out.failed.length
        ? out.failed.length + ' project(s) could not be shared and stayed local. Share them from the Team screen.'
        : '';
      ugRender();
    })
    .catch(ugFail);
}
document.getElementById('view-upgrade').addEventListener('click', function (e) {
  var btn = e.target.closest('[data-ug]');
  if (!btn || btn.disabled) return;
  var act = btn.getAttribute('data-ug');
  if (act === 'to-account') { ugStep = 2; ugErr = ''; ugRender(); return; }
  if (act === 'mode') { ugMode = ugMode === 'signup' ? 'login' : 'signup'; ugErr = ''; ugRender(); return; }
  if (act === 'account') { ugAccount(); return; }
  if (act === 'github') { ugGithub(); return; }
  if (act === 'create') { ugCreate(); return; }
  if (act === 'copy') {
    var link = (ugInvite && (ugInvite.url || ugInvite.token)) || '';
    if (link && navigator.clipboard) navigator.clipboard.writeText(link).catch(function () {});
    btn.textContent = 'Copied';
    return;
  }
  if (act === 'cancel') { location.hash = '#home'; return; }
  if (act === 'done') { location.hash = '#team'; return; }
});
document.getElementById('view-upgrade').addEventListener('submit', function (e) {
  if (e.target.closest('[data-ug-form="account"]')) { e.preventDefault(); ugAccount(); }
});
document.getElementById('view-upgrade').addEventListener('change', function (e) {
  var box = e.target.closest('[data-ug-share]');
  if (!box) return;
  ugShare[box.getAttribute('data-ug-share')] = !!box.checked;
  ugRender();
});
`;

module.exports = { upgradeCss, upgradeJs };
