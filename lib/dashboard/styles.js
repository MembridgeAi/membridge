'use strict';
// CSS design system for the dashboard page, extracted verbatim from
// dashboard.js (no build step, kept as a string so the page stays self-
// contained). ICON_DATAURI (favicon dot) and teamCss (team-screen styles from
// dashboard-team.js) are the two interpolations this block carries.
module.exports = function dashboardStyles(ICON_DATAURI, teamCss) {
  return `* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
  display: flex; flex-direction: column; overflow: hidden;
}
body:not(.session-ready) > * { visibility: hidden; }
body.session-ready > * { visibility: visible; }

/* ---------- header ---------- */
header {
  flex: none; display: flex; align-items: center; gap: 28px;
  padding: 0 26px; height: 58px;
  background: var(--bg2); border-bottom: 1px solid var(--border);
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 650; letter-spacing: .2px; }
.brand .dot {
  width: 9px; height: 9px; border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 0 10px color-mix(in srgb, var(--accent) 55%, transparent);
}
.pill {
  font-size: 12.5px; padding: 4px 14px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent); white-space: nowrap;
}
.pill.off {
  border-color: color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent);
}
button.btn {
  font: inherit; font-size: 13.5px; padding: 7px 18px; cursor: pointer;
  border-radius: 10px; border: 1px solid var(--border);
  background: transparent; color: var(--text);
}
button.btn:hover { border-color: var(--muted); }
button.btn.primary {
  border-color: color-mix(in srgb, var(--accent) 40%, transparent); color: var(--accent);
}
button.btn.primary:hover { box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 25%, transparent); }
button.btn.danger {
  border-color: color-mix(in srgb, var(--danger) 45%, transparent); color: var(--danger);
}
button.btn.danger:hover { box-shadow: 0 0 14px color-mix(in srgb, var(--danger) 25%, transparent); }
button.btn.del { color: var(--muted); }
button.btn.del:hover { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
button.btn:disabled { opacity: .5; cursor: default; box-shadow: none; }
header .grow { flex: 1; }
#goHome { cursor: pointer; }
#pill { cursor: pointer; }

/* ---------- modals ---------- */
.overlay {
  position: fixed; inset: 0; z-index: 50; display: none;
  align-items: center; justify-content: center;
  background: rgba(0, 0, 0, .6);
}
.overlay.open { display: flex; }
.modal {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 22px 24px;
  width: 460px; max-width: calc(100vw - 48px);
  box-shadow: 0 12px 48px rgba(0, 0, 0, .55);
}
.modal h3 { font-size: 16px; font-weight: 600; margin: 0 0 8px; line-height: 1.4; word-break: break-word; }
.modal .m-help { font-size: 13px; color: var(--muted); line-height: 1.55; margin: 0 0 14px; }
.modal input {
  width: 100%; font-size: 13px; color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: 10px; padding: 9px 12px; outline: none;
}
.modal input::placeholder { color: var(--muted); }
.modal input:focus { border-color: color-mix(in srgb, var(--accent) 45%, transparent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 15%, transparent); }
.modal .m-err { display: none; font-size: 12.5px; color: var(--danger); margin: 8px 0 0; }
.modal .m-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.modal.wide { width: 560px; max-height: calc(100vh - 80px); overflow-y: auto; }
.scan-group { margin: 0 0 16px; }
.scan-group h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 8px; }
.scan-row { display: flex; align-items: baseline; gap: 8px; font-size: 13px; padding: 4px 0; }
.scan-row .tool { min-width: 96px; font-weight: 600; }
.scan-row .root { color: var(--muted); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.scan-row .missing { color: var(--danger); font-size: 12px; }
.scan-proj { padding: 8px 0; border-top: 1px solid var(--border); }
.scan-proj:first-child { border-top: none; }
.scan-proj .name { font-weight: 600; font-size: 13.5px; }
.scan-proj .paused { color: var(--danger); font-size: 12px; font-weight: 400; }
.scan-proj .sources { color: var(--muted); font-size: 12.5px; margin-top: 2px; }

/* ---------- home feed ---------- */
#view-home { flex: 1; overflow-y: auto; display: none; }
#view-home.active { display: block; }
#view-home .inner { max-width: 720px; margin: 0 auto; padding: 40px 28px 64px; }
#view-feed { flex: 1; overflow-y: auto; display: none; }
#view-feed.active { display: block; }
#view-session { flex: 1; overflow-y: auto; display: none; }
#view-session.active { display: block; }
#view-day { flex: 1; overflow-y: auto; display: none; }
#view-day.active { display: block; }
/* Activity session widgets: elements that route to the session page get a real
   hover affordance — the template's style-hover attributes are inert, so this
   must be CSS. */
.sess-link { cursor: pointer; }
#teamScreen { flex: 1; overflow-y: auto; display: none; }
#teamScreen.active { display: block; }
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: 20px; padding: 20px 24px; margin-bottom: 16px;
  box-shadow: var(--shadow-md);
}
.card.paused { opacity: .55; }
.card h2 { font-size: 15.5px; font-weight: 600; margin: 0; }
.row { display: flex; align-items: center; gap: 12px; }
.row .grow { flex: 1; min-width: 0; }
.path {
  font-size: 12px; color: var(--muted);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.entries { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 12px; font-size: 13.5px; }
.entry { display: flex; gap: 10px; align-items: baseline; padding: 4px 0; }
.entry .t { color: var(--muted); white-space: nowrap; font-size: 12px; }
.badge {
  display: inline-block; font-size: 11px; padding: 2px 9px;
  border-radius: 999px; white-space: nowrap;
}
.files { margin-top: 10px; font-size: 12.5px; color: var(--muted); }
.footer { font-size: 12.5px; color: var(--muted); margin-top: 28px; }
.footer code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px; }
.empty { color: var(--muted); font-size: 14px; padding: 48px 0; text-align: center; }

.pcard { cursor: pointer; transition: border-color .15s ease; }
.pcard:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
.chip {
  display: inline-block; font-size: 11px; padding: 2px 10px; border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); color: var(--danger);
  background: color-mix(in srgb, var(--danger) 8%, transparent); white-space: nowrap;
}
.meta { font-size: 12.5px; color: var(--muted); margin-top: 10px; }

/* ---------- project page ---------- */
#view-project { flex: 1; overflow-y: auto; display: none; }
#view-project.active { display: block; }
#view-project .inner { max-width: 780px; margin: 0 auto; padding: 48px 28px 110px; }
.pj-back { color:var(--text3); font-size:12.5px; cursor:pointer; margin-bottom:16px; display:inline-block; }
.pj-back:hover { color:var(--text2); }
.pj-head { display: flex; align-items: flex-start; gap: 14px; flex-wrap:wrap; }
.pj-head .grow { min-width: 0; } /* let the nowrap path shrink, not push the buttons out */
.pj-head h2 { margin:0; font:400 34px/1.1 var(--display); letter-spacing:-.02em; }
.pj-head h2 .chip, .pj-head h2 .team-chip { font:inherit; font-size:12px; vertical-align:middle; margin-left:6px; }
.pj-members { display:flex; align-items:center; gap:10px; margin-top:14px; font-size:12.5px; color:var(--text2); }
.pj-avs { display:flex; }
.pj-avs .avatar { width:22px; height:22px; border-radius:50%; font-size:10px; border:2px solid var(--bg); box-shadow:none; }
.pj-avs .avatar + .avatar { margin-left:-7px; }
.pj-stats { display:flex; margin:28px 0 10px; border:1px solid var(--border); border-radius:16px; background:var(--card); box-shadow:var(--shadow-md); overflow:hidden; flex-wrap:wrap; }
.pj-stat { flex:1; min-width:120px; padding:16px 20px; border-right:1px solid var(--border); }
.pj-stat:last-child { border-right:none; }
.pj-stat b { font:400 24px/1 var(--display); }
.pj-stat.grad b { background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
.pj-stat span { display:block; margin-top:2px; font:600 9.5px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--text3); }
.pj-head .chip { margin-left: 10px; vertical-align: 3px; }
.pj-close {
  flex: none; background: none; border: 1px solid var(--border); border-radius: 10px;
  color: var(--muted); cursor: pointer; font-size: 19px; line-height: 1; padding: 7px 13px;
}
.pj-close:hover { color: var(--text); border-color: var(--muted); }
/* ---- project page: header actions, ⋯ menu, load-more, collapsed roadmap ---- */
#view-project .pj-menu-wrap { position: relative; flex: none; }
#view-project .pj-menu-btn {
  background: none; border: 1px solid var(--border); border-radius: 10px;
  color: var(--muted); cursor: pointer; font-size: 18px; line-height: 1; padding: 7px 12px;
}
#view-project .pj-menu-btn:hover { color: var(--text); border-color: var(--muted); }
#view-project .pj-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: 30; min-width: 232px;
  background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  box-shadow: var(--shadow-xl); padding: 6px; display: none;
}
#view-project .pj-menu.open { display: block; }
#view-project .pj-menu a.pj-mi, #view-project .pj-menu button.pj-mi {
  display: block; width: 100%; text-align: left; box-sizing: border-box;
  background: none; border: none; border-radius: 8px; cursor: pointer;
  font: inherit; font-size: 13px; color: var(--text); padding: 8px 10px; text-decoration: none;
}
#view-project .pj-menu button.pj-mi[data-armed] { color: var(--danger); }
#view-project .pj-menu .pj-mi:hover { background: var(--surface-subtle); }
#view-project .pj-menu .pj-mi.danger { color: var(--danger); }
#view-project .pj-menu .pj-mi-sep { height: 1px; margin: 6px 4px; background: var(--border); }
#view-project .pj-menu .pj-mi-info {
  padding: 6px 10px 4px; font: 600 9.5px/1.4 var(--mono); letter-spacing: .06em;
  text-transform: uppercase; color: var(--muted);
}
#view-project .pj-menu .pj-mi-file {
  padding: 2px 10px; font-family: var(--mono); font-size: 11.5px; color: var(--muted);
  word-break: break-all;
}
#view-project .pj-menu .pj-link-row { display: flex; gap: 6px; padding: 6px 10px; }
#view-project .pj-menu .pj-link-row select { flex: 1; min-width: 0; }
#view-project .pjMore:not(:empty) { margin-top: 18px; text-align: center; }
.aentry { padding: 10px 2px; border-bottom: 1px solid var(--border); }
.aentry:last-child { border-bottom: none; }
.afiles {
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px;
  color: var(--muted); margin-top: 4px; word-break: break-all;
}
.aresult { font-size: 12.5px; color: var(--muted); margin-top: 4px; }
.aresult .distilled {
  display: inline-block; font-size: 10px; padding: 1px 7px; margin-right: 5px;
  border: 1px solid var(--border); border-radius: 999px; color: var(--accent);
  text-transform: uppercase; letter-spacing: 0.04em; vertical-align: 1px;
}
a.mlink { color: var(--accent); text-decoration: none; }
a.mlink:hover { text-decoration: underline; }
/* ---------- v2 session-card feed entry (avatar tile + summary + meta row +
   click-expandable detail). Reused by Home headlines, the Everything feed and
   the Project stream. ---------- */
.grow { flex:1; min-width:0; }
.fentry { border-bottom:1px solid var(--border); }
.fentry:last-child { border-bottom:none; }
.fentry-head { display:flex; gap:14px; align-items:flex-start; padding:16px 12px 16px 4px; margin:0 -12px 0 -4px;
  cursor:pointer; border-radius:14px; transition:background .2s; }
.fentry-head:hover { background:var(--surface2); }
.favatar { flex:none; margin-top:1px; width:22px; height:22px; border-radius:7px; color:#fff;
  display:inline-flex; align-items:center; justify-content:center; font:600 11px/1 var(--mono); }
.fsummary { font-size:15px; font-weight:600; letter-spacing:-.01em; line-height:1.45; color:var(--text); }
.fworking-lbl { color:var(--amber); }
.fmeta { display:flex; align-items:center; gap:9px; margin-top:7px; font-size:12px; color:var(--text3); flex-wrap:wrap; }
.fperson { background:none; border:none; padding:0; font:inherit; font-size:12.5px; font-weight:500; color:var(--text2); cursor:pointer; }
.fperson:hover { color:var(--accent); }
.fproj { background:none; border:none; padding:0; font:inherit; font-family:var(--mono); font-size:10.5px; color:var(--text3); cursor:pointer; }
.fproj:hover { color:var(--accent); }
.fwip { display:flex; align-items:center; gap:5px; color:var(--amber); font-weight:600; font-size:11.5px; }
.fwip-dot { width:6px; height:6px; border-radius:50%; background:var(--amber); animation:mbPulse 2s ease infinite; }
.fago { margin-left:auto; white-space:nowrap; }
.fchev { color:var(--text3); font-size:10px; transition:transform .2s; }
.fentry.open .fchev { transform:rotate(180deg); }
.fdetail { display:none; margin:2px 0 20px 42px; padding:20px 22px; border-radius:16px; background:var(--card);
  border:1px solid var(--border); box-shadow:var(--shadow-md); animation:mbFade .25s ease; }
.fentry.open .fdetail { display:block; }
.fd-label { font:600 10px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; color:var(--text3); margin:0 0 9px; }
.fd-ask { margin:0 0 18px; font-size:13.5px; font-style:italic; color:var(--text2); line-height:1.65; max-width:58ch; }
.fd-checks { display:grid; gap:8px; margin-bottom:18px; }
.fd-check { display:flex; gap:11px; font-size:13px; color:var(--text2); }
.fd-n { font:500 10.5px/1 var(--mono); background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; margin-top:2px; }
.fd-bar { height:4px; border-radius:2px; background:var(--surface3); max-width:220px; margin-bottom:11px; }
.fd-bar span { display:block; height:4px; border-radius:2px; transition:width .4s; }
.fd-todos { display:grid; gap:6px; margin-bottom:18px; }
.fd-todo { display:flex; gap:9px; font-size:13px; align-items:baseline; color:var(--text); }
.fd-todo.done { color:var(--text3); }
.fd-todo.done span:last-child { text-decoration:line-through; }
.fd-files { display:flex; flex-wrap:wrap; gap:6px; }
.fd-file { font-family:var(--mono); font-size:10.5px; padding:4px 9px; border-radius:8px; background:var(--surface2); color:var(--text2); }
.fmeta-row { margin-top:6px; font-size:12.5px; color:var(--text2); line-height:1.5; }
.flabel { font:600 9.5px/1 var(--mono); letter-spacing:.13em; text-transform:uppercase; color:var(--text3); margin-right:7px; vertical-align:1px; }
.fsub { margin-top:5px; font-size:12.5px; color:var(--text3); line-height:1.5; }
.fchanges { display:grid; gap:5px; }
.fchange { font-family:var(--mono); font-size:11.5px; color:var(--text2); display:flex; align-items:baseline; gap:6px; }
.fchange.fdep { opacity:.5; }
.fchange code { font-family:inherit; }
.fcount { color:var(--text3); }
.fnote { color:var(--text3); }
.feed-day { margin:28px 0 4px; font:600 10px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; color:var(--text3); }
.feed-day:first-child { margin-top:0; }
/* ---------- Projects index — compact scan (design 1c): one grid row per
   project (name | latest session | who | 14d sparkline | menu) so ~15
   projects read at a glance. Paused/dormant rows dim and collapse to one
   status line. ---------- */
.px-hdr, .px-row { display:grid; grid-template-columns:176px minmax(0,1fr) 62px 56px 32px; gap:0 14px; align-items:center; }
.px-hdr { font:600 9.5px/1 var(--mono); letter-spacing:.1em; text-transform:uppercase; color:var(--text3); padding:6px 4px 9px; border-bottom:1px solid var(--border); }
.px-row { padding:13px 4px; border-bottom:1px solid var(--border); position:relative; transition:background .15s; }
.px-row:hover { background:var(--surface2); }
.px-row.dim { opacity:.62; }
.px-row.dim:hover { opacity:1; }
.px-cell { min-width:0; cursor:pointer; }
.px-name { display:flex; align-items:center; gap:6px; min-width:0; }
.px-name b { font-size:13.5px; font-weight:600; letter-spacing:-.01em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.px-row.dim .px-name b { color:var(--text2); }
.px-dot { width:6px; height:6px; border-radius:50%; background:var(--accent); animation:mbPulse 2s ease infinite; flex:none; }
.px-sub { font:500 9px/1.6 var(--mono); letter-spacing:.05em; text-transform:uppercase; color:var(--text3); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.px-sub.team { color:var(--accent); }
.px-latest .t { font-size:13px; line-height:1.4; color:var(--text); display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
.px-latest.quiet .t { color:var(--text2); -webkit-line-clamp:1; }
.px-latest .t.none { color:var(--text3); }
.px-latest .m { font-size:11px; color:var(--text3); margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.px-latest .m .todo { color:var(--accent); }
.px-status { font-size:12px; color:var(--text3); display:flex; align-items:center; gap:8px; min-width:0; }
.px-status > span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.px-chip { font:600 9px/1 var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--amber); background:var(--amber-soft); border-radius:5px; padding:3px 7px; flex:none; }
.px-who { display:flex; min-width:0; }
.px-av { width:20px; height:20px; border-radius:50%; color:#fff; font:500 8px/1 var(--mono); display:flex; align-items:center; justify-content:center; border:2px solid var(--bg); flex:none; }
.px-av + .px-av { margin-left:-6px; }
.px-spark { display:flex; align-items:flex-end; gap:1.5px; height:14px; }
.px-spark span { width:2.5px; border-radius:1px; background:var(--surface3); }
.px-spark span.on { background:var(--accent2); }
.px-menu-btn { width:28px; height:28px; border-radius:9px; border:none; background:transparent; color:var(--text3); cursor:pointer; font-size:14px; line-height:1; transition:all .15s; }
.px-menu-btn:hover { background:var(--surface3); color:var(--text); }
.px-foot { margin-top:18px; padding-top:14px; border-top:1px solid var(--border); font-size:12.5px; color:var(--text2); }
.px-foot span[data-px-goteam] { color:var(--accent); cursor:pointer; font-weight:600; }
#homeSuggest:not(:empty) { margin-bottom: 16px; }
#homeNotice:not(:empty) { margin-bottom: 14px; }
#homeMore:not(:empty) { margin-top: 18px; text-align: center; }
/* ---------- quiet home filter chips (scoped .chips .chip so it wins over the
   danger-styled .chip pill used elsewhere) ---------- */
.chips:not(:empty) { margin-bottom: 18px; }
.chiprow { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 7px; }
.chiprow:last-child { margin-bottom: 0; }
.chips .chip {
  display: inline-block; cursor: pointer; white-space: nowrap;
  font: inherit; font-size: 11.5px; padding: 4px 12px; border-radius: 999px;
  border: 1px solid var(--border); background: transparent; color: var(--text2);
}
.chips .chip:hover { color: var(--text); border-color: var(--text3); }
.chips .chip.on {
  color: #fff; border-color: transparent;
  background: var(--grad); box-shadow: var(--shadow-accent);
}
/* ---------- The Catch-Up band (top of #home) ---------- */
.cu-head { display:flex; align-items:flex-end; gap:16px; flex-wrap:wrap; margin:18px 0 0; }
.cu-title { margin:0; flex:1; font:400 42px/1.05 var(--display); letter-spacing:-.02em; }
.cu-accent { position:relative; background:var(--grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
.cu-since { color:var(--text3); font-size:12.5px; margin:14px 0 32px; }
.cu-section { margin:40px 0; }
.cu-section-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.cu-see { background:none; border:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; }
.cu-projs { display:grid; gap:2px; }
.cu-brief-actions { margin:0 0 40px; }
/* Inverted AI-briefing spotlight card */
.brief-card { position:relative; overflow:hidden; border-radius:20px; background:var(--inv); color:var(--inv-text);
  padding:28px 30px 26px; margin:8px 0 40px; box-shadow:var(--shadow-xl); }
.brief-grid { position:absolute; inset:0; opacity:.04; pointer-events:none;
  background-image:radial-gradient(circle,#fff 1px,transparent 1px); background-size:32px 32px; }
.brief-head { position:relative; display:flex; align-items:center; gap:9px; margin-bottom:15px; }
.brief-spark { background:linear-gradient(135deg,#6E93FF,#9DB7FF); -webkit-background-clip:text; background-clip:text; color:transparent; }
.brief-kicker { font:600 10.5px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; color:var(--inv-text2); }
.brief-regen { margin-left:auto; background:none; border:none; color:var(--inv-text2); font:inherit; font-size:12px; cursor:pointer; }
.brief-body { position:relative; margin:0; font-size:16.5px; line-height:1.7; color:var(--inv-text); }
.brief-when { margin-top:10px; font:600 9.5px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; color:var(--inv-text2); }
.brief-nokey { padding:12px 16px; border:1px dashed var(--border2); border-radius:12px; color:var(--text3); font-size:12.5px; margin-bottom:40px; }
.linklike { background:none; border:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; padding:0; }
/* what-changed project rows */
.mem-row { display:flex; align-items:center; gap:12px; padding:11px 8px; border-bottom:1px solid var(--border); }
.mem-row:last-child { border-bottom:none; }
.mem-row.click { cursor:pointer; border-radius:10px; transition:background .2s; }
.mem-row.click:hover { background:var(--surface2); }
.mem-row strong { font-weight:600; font-size:13.5px; }
/* empty / welcome states */
.cu-empty { text-align:center; padding:60px 24px 70px; }
.cu-tile { width:52px; height:52px; margin:0 auto 20px; border-radius:16px; background:var(--grad);
  display:flex; align-items:center; justify-content:center; color:#fff; font-size:20px; box-shadow:var(--shadow-accent-lg); }
.cu-empty-title { font:400 23px/1.15 var(--display); }
.cu-empty-sub { color:var(--text2); margin:8px auto 0; font-size:14px; max-width:410px; line-height:1.6; }
.cu-undo { margin-top:16px; display:inline-block; font-size:13px; }
.cu-noteam { text-align:center; padding:44px 36px; }
.cu-noteam .cu-empty-sub { margin-bottom:24px; }
.cu-avs2 { display:flex; justify-content:center; margin-bottom:18px; }
.cu-av-solid { width:34px; height:34px; border-radius:50%; background:var(--grad); box-shadow:var(--shadow-accent); }
.cu-av-dash { width:34px; height:34px; border-radius:50%; border:2px dashed var(--border2); margin-left:-9px; background:var(--bg); }
.cu-join { color:var(--text3); font-size:12px; margin-top:16px; }
.cu-steps { display:grid; gap:0; margin-top:22px; }
.cu-step { display:flex; gap:14px; align-items:center; padding:14px 0; border-top:1px solid var(--border); }
.cu-step strong { font-weight:600; font-size:13.5px; }
.cu-ok { flex:none; width:24px; height:24px; border-radius:8px; background:var(--grad); color:#fff;
  font-size:11px; display:flex; align-items:center; justify-content:center; }
.cu-box { flex:none; width:24px; height:24px; border-radius:8px; border:1.5px dashed var(--border2); }
.cu-dim { color:var(--text3); font-size:12.5px; }
/* ---------- slim inline card (no-team nudge + suggested links) ---------- */
.slim-team, .slim-suggest {
  display: flex; align-items: center; gap: 16px; margin-bottom: 16px;
}
.slim-team .grow, .slim-suggest .grow { min-width: 0; }
.slim-team strong, .slim-suggest strong { display: block; font-size: 14px; }
.slim-team small, .slim-suggest small { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; line-height: 1.5; }
.slim-suggest .btn { flex: none; }
/* ---------- settings ---------- */
#openSettings { font-size: 15px; padding: 6px 12px; }
#view-settings { flex: 1; overflow-y: auto; display: none; }
#view-settings.active { display: block; }
#view-settings .inner { max-width: 640px; margin: 0 auto; padding: 32px 28px 64px; }
#view-settings input {
  font-size: 13px; color: var(--text);
  font-family: ui-monospace, Menlo, Consolas, monospace;
  background: var(--bg2); border: 1px solid var(--border);
  border-radius: 10px; padding: 9px 12px; outline: none; width: 100%;
}
#view-settings input:focus { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
#view-settings input::placeholder { color: var(--muted); }
.st-btns { display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap; }
.st-result { font-size: 13px; }
.st-result.ok { color: var(--accent); }
.st-result.err { color: var(--danger); }
.st-row { display: flex; align-items: center; gap: 10px; margin-top: 10px; font-size: 13.5px; }
.st-row label { flex: none; width: 110px; color: var(--muted); }
#view-settings .st-row input { flex: 1; width: auto; }
#view-settings .st-row input[type=number] { flex: none; width: 90px; }
.radio {
  display: flex; align-items: center; gap: 10px; padding: 10px 14px; margin-top: 8px;
  border: 1px solid var(--border); border-radius: 10px; cursor: pointer; font-size: 13.5px;
}
.radio:hover { border-color: var(--muted); }
.radio.sel { border-color: color-mix(in srgb, var(--accent) 50%, transparent); }
#view-settings .radio input { flex: none; width: auto; accent-color: var(--accent); }
/* team-management panels are always visible inside Settings — no panel to close */
#teamSettingsRoot [data-team-action="panel-close"] { display: none; }
#teamSettingsRoot .hub-switch { font-size: 22px; margin-bottom: 6px; }
#stProjectList .mem-row { padding: 9px 8px; border-bottom: 1px solid var(--border); border-radius: 0; }
#stProjectList .mem-row:last-child { border-bottom: none; }

/* ---------- v2 Catch-Up design system ---------- */
html, body { margin: 0; padding: 0; }
body {
  --bg:#FAFAFA; --card:#FFFFFF; --surface2:#F1F5F9; --surface3:#E2E8F0;
  --text:#0F172A; --text2:#64748B; --text3:#94A3B8;
  --border:#E2E8F0; --border2:#CBD5E1;
  --accent:#0052FF; --accent2:#4D7CFF;
  --accent-soft:rgba(0,82,255,.06); --accent-brd:rgba(0,82,255,.3);
  --grad:linear-gradient(135deg,#0052FF,#4D7CFF);
  --inv:#0F172A; --inv-text:#F8FAFC; --inv-text2:rgba(248,250,252,.68);
  --marco:#0052FF; --andrew:#0D9673;
  --amber:#C77414; --amber-soft:rgba(199,116,20,.09);
  --green:#0D9673;
  --shadow-md:0 4px 6px rgba(0,0,0,.07);
  --shadow-xl:0 20px 25px rgba(0,0,0,.1);
  --shadow-accent:0 4px 14px rgba(0,82,255,.25);
  --shadow-accent-lg:0 8px 24px rgba(0,82,255,.35);

  /* --- compatibility aliases: existing component CSS + teamCss reference the
     legacy Minimalist tokens; map them onto the v2 system so nothing we keep
     (feed rows, team panels, modals) breaks. New v2 component CSS below uses
     the v2 names directly. --- */
  --muted: var(--text2);
  --danger:#DC2626;
  --ok: var(--green); --ok-dot: var(--green);
  --bg2: var(--card);
  --surface-subtle: var(--surface2); --surface-raised: var(--surface2);
  --glass: color-mix(in srgb, var(--bg) 84%, transparent);
  --glass-border: var(--border);
  --btn-bg: var(--card);
  --warn: var(--amber);
  --radius:16px;
  --shadow-sm: var(--shadow-md); --shadow-lg: var(--shadow-xl);
  --display: Calistoga, Georgia, "Times New Roman", serif;
  --mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  background: var(--bg); color: var(--text);
  font-family: Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 15px; line-height: 1.55; -webkit-font-smoothing: antialiased;
  min-height:100%; display:flex; flex-direction:column; overflow:hidden;
}
body[data-theme="dark"] {
  --bg:#0B1120; --card:#111A2E; --surface2:#16213A; --surface3:#1E293B;
  --text:#F1F5F9; --text2:#94A3B8; --text3:#5B6B84;
  --border:#1E293B; --border2:#334155;
  --accent:#4D7CFF; --accent2:#7A9DFF;
  --accent-soft:rgba(77,124,255,.1); --accent-brd:rgba(77,124,255,.35);
  --grad:linear-gradient(135deg,#2E63FF,#6E93FF);
  --inv:#111A2E; --inv-text:#F8FAFC; --inv-text2:rgba(248,250,252,.6);
  --marco:#4D7CFF; --andrew:#22C08F;
  --amber:#E79A3C; --amber-soft:rgba(231,154,60,.12);
  --green:#22C08F;
  --shadow-md:0 4px 10px rgba(0,0,0,.35);
  --shadow-xl:0 20px 30px rgba(0,0,0,.45);
  --shadow-accent:0 4px 14px rgba(46,99,255,.35);
  --shadow-accent-lg:0 8px 24px rgba(46,99,255,.45);
  --danger:#F87171;
}
a { color: var(--accent); text-decoration: none; }
a:hover { color: var(--accent2); text-decoration: underline; }
@keyframes mbPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.3);opacity:.7}}
@keyframes mbSpin{to{transform:rotate(360deg)}}
@keyframes mbFade{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
@keyframes mbFadeQuick{from{opacity:0}to{opacity:1}}
/* Per-session share control (shareToggleHtml). A real button affordance — border
   + hover — so it reads as a control, not the passive tool badge beside it. */
.share-ctl { display:inline-flex; align-items:center; gap:5px; flex:none; padding:3px 10px;
  border-radius:8px; border:1px solid var(--border2); background:transparent; color:var(--text2);
  font-family:inherit; font-size:11px; font-weight:600; line-height:1.4; cursor:pointer;
  transition:border-color .15s ease, color .15s ease, background .15s ease; }
.share-ctl svg { width:13px; height:13px; }
.share-ctl:hover { border-color:var(--accent-brd); color:var(--text); }
.share-ctl.on { border-color:color-mix(in srgb, var(--green) 40%, transparent);
  background:color-mix(in srgb, var(--green) 12%, transparent); color:var(--green); }
.share-ctl.on:hover { border-color:color-mix(in srgb, var(--green) 62%, transparent); }
.share-ctl.share-err { border-color:color-mix(in srgb, var(--danger) 45%, transparent);
  background:color-mix(in srgb, var(--danger) 10%, transparent); color:var(--danger); }
::selection { background: rgba(0,82,255,.18); }
header { flex:none; position:sticky; top:0; z-index:40; height:56px; padding:0 28px; gap:10px;
  display:flex; align-items:center; background:var(--bg); border-bottom:1px solid var(--border); }
.brand { display:flex; align-items:center; gap:9px; cursor:pointer; padding:6px 9px; margin-left:-9px;
  border-radius:10px; transition:background .2s; }
.brand:hover { background:var(--surface2); }
/* Logo tile — mirrors the membridge.me site mark: fixed brand gradient + border,
   independent of the app's --accent UI theme so the logo reads identically. */
.brand-mark { width:28px; height:28px; border-radius:8px;
  background:linear-gradient(135deg,#3E63F0,#16219B); border:1px solid #4A78FF;
  box-shadow:var(--shadow-accent); display:inline-flex; align-items:center; justify-content:center; }
.brand-mark svg { width:24px; height:24px; }
/* Wordmark beside the tile — matches the membridge.me nav lockup
   (system sans, 650 weight), not the app's serif display font. */
.brand-word { font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
  font-weight:650; font-size:17px; letter-spacing:-.01em; color:var(--text); }
/* Auth-card logo lockup: the header mark enlarged next to the wordmark, so at
   card scale it reads as the MemBridge logo, never a toggle. */
.auth-mark { width:42px; height:42px; border-radius:11px; }
.auth-mark svg { width:36px; height:36px; }
/* Auth view still renders a square mark tile via .auth-brand .dot. */
.auth-brand .dot { background: url("${ICON_DATAURI}") center/contain no-repeat; }
.pill { display:inline-flex; align-items:center; gap:8px; border:1px solid var(--accent-brd); background:var(--accent-soft);
  color:var(--accent); padding:6px 13px; border-radius:99px; cursor:pointer;
  font:600 10.5px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
.pill::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--green); animation:mbPulse 3s ease infinite; }
.pill.off { border-color:color-mix(in srgb,var(--amber) 45%,transparent); background:var(--amber-soft); color:var(--amber); }
.pill.off::before { background:var(--amber); }
#openSignin { display:none; } body.signed-out #openSignin { display:inline-flex; } body.signed-out #openInvite { display:none; }
.sync-banner { display:flex; align-items:center; gap:9px; max-width:1080px; margin:0 auto; padding:9px 28px;
  background:var(--amber-soft); border-bottom:1px solid var(--border); font-size:12.5px; color:var(--text2); }
.sb-dot { width:7px; height:7px; border-radius:50%; background:var(--amber); flex:none; animation:mbPulse 2s ease infinite; }
.sb-retry { margin-left:auto; background:none; border:none; color:var(--accent); font:inherit; font-weight:600; cursor:pointer; }
button.btn {
  font: inherit; font-size:13px; font-weight:600; min-height:34px; padding:0 15px;
  border-radius:10px; border:1px solid var(--border); background:var(--card); color:var(--text);
  cursor:pointer; display:inline-flex; align-items:center; gap:6px;
  transition: transform .2s ease-out, box-shadow .2s, border-color .2s;
}
button.btn:hover { border-color: var(--accent-brd); box-shadow: var(--shadow-md); }
button.btn:active { transform: scale(.98); }
button.btn.primary { border:none; color:#fff; background:var(--grad); box-shadow:var(--shadow-accent); }
button.btn.primary:hover { transform: translateY(-1px); box-shadow: var(--shadow-accent-lg); }
button.btn.ghost { background:transparent; border-color:transparent; box-shadow:none; color:var(--text2); }
button.btn.del, button.btn.danger { color:var(--text2); background:var(--card); border-color:var(--border); }
button.btn.del:hover, button.btn.danger:hover { color:var(--danger); border-color:color-mix(in srgb,var(--danger) 45%,transparent); }
button.btn:disabled { opacity:.5; cursor:default; box-shadow:none; }
button.btn:focus-visible, input:focus-visible, select:focus-visible {
  outline:3px solid var(--accent-soft); outline-offset:2px;
}
.overlay { background: color-mix(in srgb, var(--inv) 54%, transparent); backdrop-filter: blur(6px); }
.modal { border-radius: 20px; padding: 28px; box-shadow: var(--shadow-xl); }
.modal h3 { font-family: var(--display); font-size: 24px; font-weight: 400; letter-spacing: -.025em; }
.modal .m-help, .m-help { color: var(--muted); line-height: 1.65; }
.modal input, .field, #view-settings input, .team-form input, .team-form select {
  width: 100%; min-height: 46px; padding: 0 13px; border: 1px solid var(--border); border-radius: 11px;
  background: var(--card); color: var(--text); font: 14px/1.4 inherit; outline: none; transition: border-color .2s, box-shadow .2s;
}
.modal input:focus, .field:focus, #view-settings input:focus, .team-form input:focus, .team-form select:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 10%, transparent); }
.modal .m-err { color: var(--danger); }
#view-project .inner { max-width: 1120px; padding: 48px 34px 72px; }
#view-settings .inner { max-width: 980px; padding: 48px 34px 72px; }
.section-label { display:inline-flex; align-items:center; gap:10px; padding:6px 16px;
  border-radius:99px; border:1px solid var(--accent-brd); background:var(--accent-soft); color:var(--accent);
  font:600 11px/1 var(--mono); letter-spacing:.15em; text-transform:uppercase; }
.section-label::before { content:''; width:7px; height:7px; border-radius:50%; background:var(--accent);
  animation:mbPulse 2s ease infinite; }
.page-title { margin: 15px 0 12px; font: 400 clamp(38px,5vw,60px)/1.02 var(--display); letter-spacing: -.04em; }
.gradient-text { font-style: normal; color: transparent; background: var(--grad); -webkit-background-clip: text; background-clip: text; }
.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin: 0 0 16px; }
.section-head h2 { margin: 0; font: 400 29px/1.15 var(--display); letter-spacing: -.025em; }
.section-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.card { border-radius: 20px; box-shadow: var(--shadow-md); }
.pcard { min-height: 182px; padding: 22px; position: relative; overflow: hidden; transition: transform .25s,box-shadow .25s,border-color .25s; }
.pcard::after { content: '→'; position: absolute; right: 20px; bottom: 18px; color: var(--accent); font-size: 19px; transition: transform .2s; }
.pcard:hover { border-color: color-mix(in srgb, var(--accent) 30%, transparent); transform: translateY(-3px); box-shadow: var(--shadow-lg); }
.pcard:hover::after { transform: translateX(4px); }
.pcard h2 { font-size: 17px; letter-spacing: -.02em; }
.path, .afiles { font-family: var(--mono); }
.badge { font: 600 10px/1.5 var(--mono); border: 1px solid currentColor; }
/* Local-only red pill (kept semantic) + Shared team pill (accent). */
.chip { display:inline-block; font:600 9.5px/1.5 var(--mono); letter-spacing:.08em; text-transform:uppercase;
  padding:1px 8px; border-radius:99px; border:1px dashed var(--border2); color:var(--text3); background:none; }
.team-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 11px; border-radius:99px;
  color:var(--accent); background:var(--accent-soft); border:1px solid var(--accent-brd);
  font:600 9.5px/1 var(--mono); letter-spacing:.08em; text-transform:uppercase; }
.team-chip::before { content:''; width:5px; height:5px; border-radius:50%; background:var(--accent); }
.pj-head h2 { font: 400 35px/1.1 var(--display); letter-spacing: -.03em; }
.pj-close { width: 42px; height: 42px; padding: 0; border-radius: 12px; background: var(--card); box-shadow: var(--shadow-sm); }
.aentry { padding: 14px 2px; }
.entry { align-items: flex-start; }
.footer { line-height: 1.7; }
#view-auth { flex: 1; overflow-y: auto; display: none; }
#view-auth.active { display: block; }
.auth-page { min-height: 100%; display: grid; grid-template-columns: 1.08fr .92fr; }
.auth-story { position: relative; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; padding: 54px clamp(38px,6vw,84px); color: #fff; background: #0f172a; }
.auth-story::before { content:''; position:absolute; inset:0; opacity:.1; background-image:radial-gradient(circle,#fff 1px,transparent 1px); background-size:30px 30px; }
.auth-story::after { content:''; position:absolute; width:540px; height:540px; right:-250px; top:15%; border-radius:50%; background:var(--accent); filter:blur(130px); opacity:.28; }
.auth-story > * { position:relative; z-index:1; }
.auth-brand { display:flex; align-items:center; gap:12px; font-size:17px; font-weight:780; }
.auth-brand .dot { width:32px; height:32px; border-radius:10px; box-shadow:0 10px 28px rgba(0,82,255,.4); }
.auth-copy { max-width:650px; }
.auth-copy h1 { margin:18px 0 18px; font:400 clamp(48px,6.4vw,78px)/.98 var(--display); letter-spacing:-.055em; }
.auth-copy p { max-width:560px; margin:0; color:rgba(255,255,255,.68); font-size:17px; line-height:1.7; }
.auth-proof { display:flex; flex-wrap:wrap; gap:10px; margin-top:28px; }
.auth-proof span { padding:8px 11px; border:1px solid rgba(255,255,255,.12); border-radius:999px; background:rgba(255,255,255,.06); color:rgba(255,255,255,.78); font:500 10px/1 var(--mono); letter-spacing:.04em; }
.auth-panel { display:grid; place-items:center; padding:52px clamp(28px,6vw,86px); background:var(--bg); }
.auth-panel-inner { width:100%; max-width:430px; }
.auth-panel-inner > h2 { margin:14px 0 8px; font:400 40px/1.1 var(--display); letter-spacing:-.04em; }
.auth-panel-inner > p { margin:0 0 24px; color:var(--muted); }
.auth-panel .team-form { gap:14px; }
.auth-panel .team-form label { gap:8px; }
.auth-panel .team-form input { min-height:50px; }
.auth-panel .team-form button.primary { min-height:50px; margin-top:2px; }
.auth-security { display:flex; align-items:flex-start; gap:9px; margin-top:22px; color:var(--muted); font-size:11px; line-height:1.55; }
.auth-security::before { content:'✓'; flex:none; display:grid; place-items:center; width:18px; height:18px; border-radius:50%; color:#fff; background:linear-gradient(135deg,var(--accent),var(--accent2)); font-size:10px; }
.team-form { display: grid; gap: 11px; }
.team-form.cols { grid-template-columns: 1fr 1fr; align-items: end; }
.team-form label { display: grid; gap: 6px; color: var(--muted); font: 600 10px/1.3 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
.team-form .full { grid-column: 1/-1; }
.invite-options { flex-basis: 100%; display: grid; grid-template-columns: 1fr 1fr auto; gap: 10px; align-items: end; padding-top: 2px; }
.invite-options input { min-height: 40px; }
.auth-switch { display: flex; gap: 7px; margin-bottom: 16px; }
.auth-switch button { min-height: 34px; }
.team-list { display: grid; gap: 10px; }
.team-row { display: flex; gap: 14px; align-items: center; padding: 14px; border: 1px solid var(--border); border-radius: 13px; background: var(--card); }
.team-row .grow { min-width: 0; }
.team-row strong { display: block; font-size: 14px; }
.team-row small { color: var(--muted); }
.invite { font-family: var(--mono); font-size: 10px; color: var(--accent); }
.notice { padding: 12px 14px; border-radius: 11px; background: color-mix(in srgb, var(--accent) 8%, transparent); color: var(--accent); font-size: 12px; line-height: 1.5; }
.notice.error { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
.notice.success { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--ok); }
.profile { display: flex; align-items: center; gap: 12px; }
/* Author avatar tile: --marco / --andrew wins for known authors, avColor() otherwise. */
.favatar, .avatar { flex:none; display:inline-flex; align-items:center; justify-content:center; color:#fff;
  font:600 11px/1 var(--mono); border-radius:10px; box-shadow:var(--shadow-md); }
.favatar { width:28px; height:28px; }
.avatar { width:42px; height:42px; border-radius:14px; background:var(--grad); font:700 15px/1 var(--mono); }
#view-settings .card { padding: 25px; }
@keyframes pulse { 0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.28);opacity:.66} }
@media (max-width: 850px) {
  header { padding: 0 14px; gap: 8px; }
  .brand { font-size: 0; }
  .auth-page { grid-template-columns:1fr; }
  .auth-story { min-height:330px; padding:38px 34px; }
  .auth-story .auth-brand { margin-bottom:70px; }
  .auth-copy h1 { font-size:48px; }
  .auth-story > .path { display:none; }
  .auth-panel { padding:46px 28px 62px; }
}
@media (max-width: 590px) {
  header { overflow-x:auto; }
  #view-home .inner, #view-project .inner, #view-settings .inner { padding: 32px 18px 60px; }
  .team-form.cols { grid-template-columns:1fr; }
  .invite-options { grid-template-columns:1fr; }
  .team-form .full { grid-column:auto; }
  .pj-head { flex-wrap:wrap; }
}
@media (prefers-reduced-motion: reduce) { *,*::before,*::after { animation-duration:.01ms!important; animation-iteration-count:1!important; scroll-behavior:auto!important; transition-duration:.01ms!important; } }
${teamCss}`;
};
