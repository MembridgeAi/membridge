'use strict';

const { teamCss, teamJs } = require('./dashboard-team');

// Self-contained dashboard page: no build step, no external assets, no CDN,
// works fully offline. Served by lib/server.js at / and loaded inside the
// Electron BrowserWindow. The warm, high-contrast visual system uses only
// local font fallbacks so the app remains complete without a network.
//
// Views switched client-side via location.hash: #home (unified feed),
// #project=<path> (one project), #settings, plus the signed-out auth view.
function dashboardPage() {
  // Brand mark, inlined so the page stays self-contained. Sources of truth:
  // docs/brand/svg/membridge-mark-{blue,white}.svg and membridge-app-icon.svg.
  var MARK_BLUE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#3E63F0" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 22.5 V11 L16 18 L23 11 V22.5"/><path d="M5 16.5 H27"/></svg>';
  var MARK_WHITE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 22.5 V11 L16 18 L23 11 V22.5"/><path d="M5 16.5 H27"/></svg>';
  // Rounded-square app icon (gradient field, white mark) for the favicon —
  // matches the membridge.me site logo and app/assets/brand/membridge-app-icon.svg.
  var ICON_DATAURI = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="mgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3E63F0"/><stop offset="1" stop-color="#16219B"/></linearGradient></defs><rect x="1" y="1" width="30" height="30" rx="8.5" fill="url(#mgrad)" stroke="#4A78FF" stroke-width="1.6"/><path d="M9 22.5 V11 L16 18 L23 11 V22.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 16.5 H27" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemBridge</title>
<link rel="icon" href="${ICON_DATAURI}">
<script>try{var t=localStorage.getItem('mb-theme');
  var d=(t==='light'||t==='dark')?t:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
  document.documentElement.dataset.theme=d; }catch(e){}</script>
<style>
* { box-sizing: border-box; }
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
${teamCss}
</style>
</head>
<body>

<div id="view-auth">
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;position:relative;overflow:hidden">
    <div style="position:absolute;top:-180px;right:-120px;width:480px;height:480px;border-radius:50%;background:var(--accent);opacity:.05;filter:blur(150px)"></div>
    <div style="position:absolute;bottom:-180px;left:-120px;width:420px;height:420px;border-radius:50%;background:var(--accent2);opacity:.05;filter:blur(150px)"></div>
    <div style="width:350px;text-align:center;animation:mbFade .5s cubic-bezier(.16,1,.3,1);position:relative">
      <div style="display:flex;justify-content:center;margin-bottom:18px">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="brand-mark auth-mark">${MARK_WHITE}</div>
          <div style="font-family:Calistoga,Georgia,serif;font-size:30px;letter-spacing:-0.01em">Mem<span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">Bridge</span></div>
        </div>
      </div>
      <div style="color:var(--text2);margin:10px 0 30px;font-size:14.5px">Shared memory for the AI tools your team codes with.</div>
      <div id="authRoot"></div>
      <div style="color:var(--text3);font-size:12px;margin-top:26px">Your session memories stay on your machine until you join a team.</div>
    </div>
  </div>
</div>

<header style="position:sticky;top:0;z-index:40;background:var(--bg);border-bottom:1px solid var(--border)">
  <div style="max-width:1080px;margin:0 auto;padding:0 28px;height:56px;display:flex;align-items:center;gap:10px">
    <div id="goHome" title="Projects" style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 9px;margin-left:-9px;border-radius:10px;transition:background .2s" style-hover="background:var(--surface2)">
      <div class="brand-mark">${MARK_WHITE}</div>
      <span class="brand-word">MemBridge</span>
    </div>
    <nav id="mbNav" style="display:flex;align-items:stretch;gap:22px;margin-left:26px;height:56px">
      <span data-nav="projects" style="position:relative;display:flex;align-items:center;font-size:13px;cursor:pointer;letter-spacing:.01em;transition:color .2s">Projects<span class="nav-bar" style="position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px 1px 0 0;background:transparent"></span></span>
      <span data-nav="feed" style="position:relative;display:flex;align-items:center;font-size:13px;cursor:pointer;letter-spacing:.01em;transition:color .2s">Activity<span class="nav-bar" style="position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px 1px 0 0;background:transparent"></span></span>
      <span data-nav="team" style="position:relative;display:flex;align-items:center;font-size:13px;cursor:pointer;letter-spacing:.01em;transition:color .2s">Team<span class="nav-bar" style="position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px 1px 0 0;background:transparent"></span></span>
    </nav>
    <div style="flex:1"></div>
    <div id="e2eBadge" title="" style="display:none;align-items:center;gap:6px;padding:6px 11px;border-radius:99px;border:1px solid var(--border);background:transparent;cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:var(--text3);transition:all .2s">
      <span id="e2eIcon" style="display:flex;align-items:center"></span><span id="e2eLabel"></span>
    </div>
    <div id="pill" title="Click to sync now" style="display:flex;align-items:center;gap:8px;padding:6px 13px;border-radius:99px;border:1px solid var(--accent-brd);background:var(--accent-soft);cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);transition:all .2s" style-hover="box-shadow:var(--shadow-accent)">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:mbPulse 2s ease infinite"></span><span id="pillLabel">Synced</span>
    </div>
    <button id="openInvite" title="Invite teammates" style="height:34px;padding:0 15px;border-radius:10px;border:none;background:var(--grad);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-1px);box-shadow:var(--shadow-accent-lg)" style-active="transform:scale(.98)">Invite</button>
    <button id="themeToggle" title="Toggle theme" aria-label="Toggle theme" style="width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">&#9790;</button>
    <button id="openSettings" title="Settings" aria-label="Settings" style="width:38px;height:38px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
    </button>
  </div>
</header>
<div id="syncBanner"></div>

<div class="overlay" id="addOverlay">
  <div class="modal">
    <h3>Add a project</h3>
    <p class="m-help">Paste the full path to a project folder. MemBridge will watch it and
    share AI activity there between your tools.</p>
    <input id="addPath" type="text" placeholder="/Users/you/code/my-project" autocomplete="off" spellcheck="false">
    <p class="m-err" id="addErr"></p>
    <div class="m-btns">
      <button class="btn" id="addCancel">Cancel</button>
      <button class="btn primary" id="addSubmit">Add project</button>
    </div>
  </div>
</div>

<div class="overlay" id="delOverlay">
  <div class="modal">
    <h3 id="delTitle"></h3>
    <p class="m-help">This deletes its shared memory block from your context files
    (CLAUDE.md, AGENTS.md) and its .membridge folder. Your project files are untouched.
    If an AI tool is used here again, the project reappears &mdash; use Pause instead if you
    just want to stop syncing but keep the history.</p>
    <div class="m-btns">
      <button class="btn" id="delCancel">Cancel</button>
      <button class="btn danger" id="delConfirm">Delete</button>
    </div>
  </div>
</div>

<div class="overlay" id="removeOverlay">
  <div class="modal">
    <h3 id="removeTitle"></h3>
    <p class="m-help">This strips the MemBridge block from CLAUDE.md and AGENTS.md here.
    Its .membridge history is kept &mdash; if an AI tool is used here again, the block
    reappears on the next sync. Use Pause first if you want it to stay gone.</p>
    <div class="m-btns">
      <button class="btn" id="removeCancel">Cancel</button>
      <button class="btn danger" id="removeConfirm">Remove block</button>
    </div>
  </div>
</div>

<div class="overlay" id="scanOverlay">
  <div class="modal wide">
    <h3>Detected tools</h3>
    <p class="m-help">Read-only &mdash; nothing is written. Shows which adapters MemBridge looked for
    and which projects it found AI activity in, scanned fresh from every session file.</p>
    <div id="scanBody"><div class="empty">Scanning&hellip;</div></div>
    <div class="m-btns">
      <button class="btn primary" id="scanClose">Close</button>
    </div>
  </div>
</div>

<div class="overlay" id="promptOverlay">
  <div class="modal">
    <h3 id="promptTitle"></h3>
    <p class="m-help" id="promptLabel"></p>
    <input id="promptInput" type="text" autocomplete="off" spellcheck="false">
    <div class="m-btns">
      <button class="btn" id="promptCancel">Cancel</button>
      <button class="btn primary" id="promptConfirm">Confirm</button>
    </div>
  </div>
</div>

<div id="view-home"><div id="homeCatchup"></div></div>

<div id="view-feed"><div id="feedRoot"></div></div>

<div id="view-session"><div id="sessionRoot"></div></div>
<div id="view-day"><div id="dayRoot"></div></div>

<div id="teamScreen"><div id="teamScreenRoot"></div></div>

<div id="view-project">
  <div class="inner" id="pjRoot"></div>
</div>

<div id="view-settings"><div id="settingsRoot"></div></div>

<script>
'use strict';
/* ================= shared helpers ================= */
var esc = function (s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
};
var ago = function (iso) {
  if (!iso) return 'never';
  var s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 90) return Math.round(s) + 's ago';
  if (s < 5400) return Math.round(s / 60) + 'm ago';
  if (s < 129600) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
};
// Tool colors stay inside the electric-blue family for a coherent UI while
// remaining distinct in badges.
var toolHex = function (src) {
  if (/claude/i.test(src || '')) return '#0052ff';
  if (/codex/i.test(src || '')) return '#4d7cff';
  return '#7c3aed';
};
var hexRgb = function (hex) {
  var v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
var rgba = function (rgb, a) {
  return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')';
};
var badgeHtml = function (src) {
  var c = toolHex(src);
  return '<span class="badge" style="color:' + c + ';background:' + rgba(hexRgb(c), 0.12) +
    '">' + esc(src) + '</span>';
};
var pillEl = document.getElementById('pill');
var pillLabelEl = document.getElementById('pillLabel');
// Remember the last known team sync time so the many bare setPill(true) callers
// (home/project load, mutations) keep showing "Synced · Nm ago" between polls;
// a fresh /api/status poll (refreshStatus) updates it. Absent field => plain "Synced".
var lastTeamSync = null;
var setPill = function (ok, teamLastSync) {
  if (!ok) { pillLabelEl.textContent = 'Offline'; return; }
  if (teamLastSync !== undefined) lastTeamSync = teamLastSync;
  pillLabelEl.textContent = lastTeamSync ? 'Synced · ' + ago(lastTeamSync) : 'Synced';
};
// The header E2E badge — the at-a-glance answer to "is my team sync
// encrypted?". Four states, most urgent first: a changed teammate key
// (danger), fail-closed pause (amber), healthy encrypted (green), and the
// explicit plaintext hatch (muted). Icons are inline so there's no asset
// fetch. Clicking jumps to Team, where key management lives.
var LOCK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>';
var UNLOCK_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path></svg>';
var WARN_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
function setE2EBadge(enc) {
  var el = document.getElementById('e2eBadge');
  if (!el) return;
  if (!enc) { el.style.display = 'none'; return; }
  var icon = document.getElementById('e2eIcon');
  var label = document.getElementById('e2eLabel');
  var color, svg, text, title;
  if (enc.keyAlerts > 0) {
    color = 'var(--danger)'; svg = WARN_SVG;
    text = enc.keyAlerts + ' key alert' + (enc.keyAlerts > 1 ? 's' : '');
    title = "A teammate's key changed since you first saw it — sync is withholding the team key from them. Verify with 'membridge team fingerprint' on both machines, then 'membridge team trust <name>'.";
  } else if (enc.paused) {
    color = 'var(--amber)'; svg = WARN_SVG; text = 'Encryption paused';
    title = 'Team push is paused fail-closed: ' + enc.paused + '. Nothing is uploaded in plaintext. It resumes automatically once a key is available.';
  } else if (enc.enabled) {
    color = 'var(--green)'; svg = LOCK_SVG;
    text = 'Encrypted';
    title = enc.plaintextOff
      ? 'End-to-end encrypted (ciphertext-only). Your team content is sealed on this machine before upload; the server never sees readable text or any key.'
      : 'End-to-end encrypted. Your team content is sealed on this machine before upload; the server only ever holds ciphertext.';
  } else {
    color = 'var(--text3)'; svg = UNLOCK_SVG; text = 'Not encrypted';
    title = 'Plaintext team sync (team.encrypt=false). Content is readable by the backend. Remove the hatch to re-enable end-to-end encryption.';
  }
  icon.innerHTML = svg;
  label.textContent = text;
  el.style.color = color;
  el.style.borderColor = color;
  el.title = title;
  el.style.display = 'flex';
}
document.getElementById('e2eBadge').onclick = function () { location.hash = '#team'; };
// One lightweight status poll; degrades to plain "Synced" when teamLastSync is absent.
function refreshStatus() {
  return fetch('/api/status').then(function (r) { return r.json(); })
    .then(function (s) {
      if (s && s.teamLastSync) lastTeamSync = s.teamLastSync;
      if (s && s.encryption) setE2EBadge(s.encryption);
      return s;
    })
    .catch(function () {});
}
// Global sync-health poll — the single source of truth for the degraded banner
// AND the header pill, running on a timer regardless of which screen is active.
// Per-screen loaders can stall or not run (Team/Settings load once), which used
// to leave the "Team sync unreachable" banner stuck while the pill still read
// "Synced". This reconciles both to the CURRENT reachability every tick. Cheap
// (limit=1). teamUnavailable is the real signal; a network error is left as-is.
function pollSyncHealth() {
  refreshStatus();
  return fetch('/api/feed?limit=1').then(function (r) { return r.json(); })
    .then(function (f) { renderSyncBanner(!!(f && f.teamUnavailable)); })
    .catch(function () {});
}

/* ---- slow-load spinner: shared by the Projects/Activity/Team loaders. A
   view's fetch arms a per-view 3s timer; if the load is still pending then, a
   spinner drops into that view's content host. Cleared on render OR error, so
   a sub-3s load never flashes it. spinnerTokens guards races: a second load
   re-arms (bumps the token and clears the previous timer), and a stale load
   settling late fails the token check, so it can never cancel a newer load's
   pending spinner.
   spinnerPainted is the crucial second signal: the paint REPLACES the host's
   live content, which the loaders' fp-dedup guards (fp unchanged &&
   host.firstChild => skip render) cannot see — without it, a slow-but-
   unchanged poll tick would strand the spinner over previously-valid content
   forever. So the paint records a per-view "painted over" debt; clearSpinner
   reports it (the dedup branches then fall through to a real render even on
   an fp match) and ONLY a real render clears it (spinnerRendered) — an error
   path that renders nothing keeps the debt for the next successful load.
   skipPaint lets a view veto the paint at fire time (the Projects index
   passes its open ⋯ menu state: the menu outranks a loading hint). ---- */
var SPINNER_DELAY_MS = 3000;
var spinnerTokens = {}, spinnerTimers = {}, spinnerPainted = {};
function spinnerHtml() {
  return '<div style="display:flex;justify-content:center;padding:56px 0">' +
    '<div style="width:24px;height:24px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:mbSpin .8s linear infinite"></div></div>';
}
function armSpinner(viewKey, hostId, skipPaint) {
  var token = (spinnerTokens[viewKey] = (spinnerTokens[viewKey] || 0) + 1);
  if (spinnerTimers[viewKey]) clearTimeout(spinnerTimers[viewKey]);
  spinnerTimers[viewKey] = setTimeout(function () {
    if (spinnerTokens[viewKey] !== token) return; // superseded by a newer load
    if (skipPaint && skipPaint()) return; // the view vetoed the paint (e.g. an open ⋯ menu)
    var host = document.getElementById(hostId);
    if (host) { host.innerHTML = spinnerHtml(); spinnerPainted[viewKey] = true; }
  }, SPINNER_DELAY_MS);
  return token;
}
// Cancels the pending timer (token-guarded) and reports whether the timer
// already FIRED and painted over the host. Deliberately does NOT reset the
// painted flag — only a real render does (spinnerRendered below) — so a
// catch path that renders nothing leaves the debt standing and the next
// successful load still falls through its fp-dedup skip.
function clearSpinner(viewKey, token) {
  if (spinnerTokens[viewKey] === token && spinnerTimers[viewKey]) { clearTimeout(spinnerTimers[viewKey]); spinnerTimers[viewKey] = null; }
  return !!spinnerPainted[viewKey];
}
function spinnerRendered(viewKey) { spinnerPainted[viewKey] = false; } // a real render replaced whatever the spinner painted

/* ================= tabs & lifecycle ================= */
// Views: #home (unified feed), #project=<path> (one project, level 2 of
// max 2), #settings. Hash routing means browser-back exits a project page.
var currentTab = function () {
  // The auth view is reachable only at #signin — being signed-out no longer
  // takes over the app. Everything else (header, Home, Project, Settings) stays
  // usable with no account (local-first).
  if (location.hash === '#signin') return 'auth';
  if (location.hash === '#settings') return 'settings';
  if (location.hash === '#everything') return 'feed';
  if (location.hash === '#team') return 'team';
  if (location.hash.indexOf('#project=') === 0) return 'project';
  if (location.hash.indexOf('#session=') === 0) return 'session';
  if (location.hash.indexOf('#day=') === 0) return 'day';
  return 'home';
};
var currentProjPath = function () {
  try { return decodeURIComponent(location.hash.slice(9)); } catch (err) { return ''; }
};
// '#session=' is 9 chars, same as '#project=' — the value is a thread key.
var currentSessionKey = function () {
  try { return decodeURIComponent(location.hash.slice(9)); } catch (err) { return ''; }
};
// '#day=' is 5 chars — the value is a day-card key (author|project|day).
var currentDayKey = function () {
  try { return decodeURIComponent(location.hash.slice(5)); } catch (err) { return ''; }
};
// Just toggle which view is visible. Split from applyTab so renderTeam can show
// the auth view WITHOUT re-running applyRun -> loadTeam (that recursion floods
// /api/team and rebuilds the sign-in form under the cursor, killing focus).
function showView() {
  var t = currentTab();
  document.getElementById('view-auth').className = t === 'auth' ? 'active' : '';
  document.getElementById('view-home').className = t === 'home' ? 'active' : '';
  document.getElementById('view-feed').className = t === 'feed' ? 'active' : '';
  document.getElementById('view-session').className = t === 'session' ? 'active' : '';
  document.getElementById('view-day').className = t === 'day' ? 'active' : '';
  document.getElementById('teamScreen').className = t === 'team' ? 'active' : '';
  document.getElementById('view-project').className = t === 'project' ? 'active' : '';
  document.getElementById('view-settings').className = t === 'settings' ? 'active' : '';
  applyNav(t);
}
// Persistent nav (Projects / Everything / Team) active-underline treatment.
// Projects → #home (projects index), Everything → #everything feed, Team → #team.
function applyNav(t) {
  // v3: Projects stays active on the project drill-down too (match projects+project);
  // Activity stays active on the session and day drill-downs for the same reason.
  var map = { projects: t === 'home' || t === 'project', feed: t === 'feed' || t === 'session' || t === 'day', team: t === 'team' };
  var spans = document.querySelectorAll('#mbNav [data-nav]');
  for (var i = 0; i < spans.length; i++) {
    var active = !!map[spans[i].getAttribute('data-nav')];
    spans[i].style.color = active ? 'var(--text)' : 'var(--text2)';
    spans[i].style.fontWeight = active ? '600' : '400';
    var bar = spans[i].querySelector('.nav-bar');
    if (bar) bar.style.background = active ? 'var(--grad)' : 'transparent';
  }
  var gear = document.getElementById('openSettings');
  if (gear) gear.style.borderColor = t === 'settings' ? 'var(--accent-brd)' : 'var(--border)';
}
// Nav routing: one delegated listener maps each item to its hash.
document.getElementById('mbNav').addEventListener('click', function (e) {
  var item = e.target.closest('[data-nav]');
  if (!item) return;
  var k = item.getAttribute('data-nav');
  location.hash = k === 'projects' ? '#home' : k === 'feed' ? '#everything' : '#team';
});
function applyTab() {
  showView();
  applyRun();
}
// Start/stop polling and the render loop for whichever view is active.
function applyRun() {
  stopHome();
  stopProject();
  stopFeed();
  stopSession();
  stopDay();
  if (document.hidden) return;
  var t = currentTab();
  if (t === 'home') startHome();
  else if (t === 'feed') startFeed();
  else if (t === 'session') startSession(); // same 5s cadence: a live session grows in place
  else if (t === 'day') startDay(); // the day view polls like the session page
  else if (t === 'team') renderTeamScreen();
  else if (t === 'project') startProject();
  else if (t === 'settings') loadSettings(); // one fetch, no polling: it would clobber typing
  else if (t === 'auth') loadTeam();
}
// v3 Team screen — the dedicated home for team management (members, roles,
// invite code, switch/rename/leave). Built from /api/team (+ its teams[] and
// caller role) and /api/team/members. Reuses the shared teamRequest/endpoints
// from the team module; refreshes itself (renderTeamScreen) after each mutation
// instead of going through the Settings-bound loadTeam wrapper.
var tsTeamState = null;   // last /api/team payload
var tsMembers = [];       // last /api/team/members
var tsSwitcherOpen = false;
var tsNotice = '';        // failure banner for Team screen actions ('' = none)
var tsNoticeAuth = false; // the failure was an auth failure -> add the sign-in CTA

function renderTeamScreen() {
  var host = document.getElementById('teamScreenRoot');
  if (!host) return;
  if (!host.innerHTML) {
    host.innerHTML = '<main style="max-width:820px;margin:0 auto;padding:52px 32px 110px"><div class="empty">Loading&hellip;</div></main>';
  }
  var tsLoadToken = armSpinner('team', 'teamScreenRoot');
  fetch('/api/team').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (t) {
    tsTeamState = t;
    teamState = t;
    var tid = (t && t.authenticated) ? pickTeamId(t) : '';
    var membersP = (t && t.authenticated && tid)
      ? apiGet('/api/team/members?teamId=' + encodeURIComponent(tid)).catch(function () { return { members: [] }; })
      : Promise.resolve({ members: [] });
    return membersP;
  }).then(function (res) {
    if (currentTab() !== 'team') { clearSpinner('team', tsLoadToken); return; } // navigated away mid-fetch
    setPill(true);
    tsMembers = (res && res.members) || [];
    // A fresh REAL payload clears any stale failure banner. The /api/team
    // fetch above coerces a failure to null and still lands here (pre-existing
    // degrade path), and that must not wipe a just-painted error.
    if (tsTeamState) { tsNotice = ''; tsNoticeAuth = false; }
    clearSpinner('team', tsLoadToken);
    renderTeamScreenView(); // always renders (no fp-dedup here), so any painted debt is settled
    spinnerRendered('team');
  }).catch(function () { setPill(false); clearSpinner('team', tsLoadToken); });
}

// Failure banner for Team screen actions. Auth failures get actionable copy
// plus a sign-in link; anything else shows the server's own error text. Never
// a silent no-op: teamsync rejects create/join without a signed-in account,
// and the old argument-less catch just re-rendered the same empty screen.
function tsNoticeHtml() {
  if (!tsNotice) return '';
  return '<div class="notice error" style="margin-bottom:16px">' + esc(tsNotice) +
    (tsNoticeAuth ? ' <a href="#signin" style="color:inherit;font-weight:600;text-decoration:underline">Sign in</a>' : '') +
  '</div>';
}
function tsFail(err, signinCopy) {
  var msg = (err && err.message) || '';
  var signedOut = (tsTeamState && tsTeamState.authenticated === false) || /not logged in/i.test(msg);
  tsNoticeAuth = !!signedOut;
  tsNotice = signedOut ? signinCopy : (msg || 'Something went wrong — try again.');
  renderTeamScreenView();
}

// The has-team state renders its own page head (the team name IS the title),
// so the generic "Team" h1 lives in teamScreenNone only.
function renderTeamScreenView() {
  var host = document.getElementById('teamScreenRoot');
  if (!host) return;
  host.innerHTML =
    '<main style="max-width:820px;margin:0 auto;padding:52px 32px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">' +
      tsNoticeHtml() +
      teamScreenBody() +
    '</main>';
}

function teamScreenBody() {
  var t = tsTeamState;
  var team = (t && t.authenticated) ? pickTeam(t) : null;
  if (!team) return teamScreenNone();
  return teamScreenSome(t, team);
}

// No-team state. Create/join REQUIRE a signed-in MemBridge account (teamsync
// rejects otherwise), so signed out the CTA is sign-in — not two buttons that
// can only fail. Signed in (or auth state unknown), the create-or-join pair.
function teamScreenNone() {
  var signedOut = !!(tsTeamState && tsTeamState.authenticated === false);
  var copy = signedOut
    ? 'A team is two or more people whose session memories sync. Sign in to your MemBridge account to create or join one.'
    : 'A team is two or more people whose session memories sync. Create one and hand your partner the join code &mdash; or enter theirs.';
  var buttons = signedOut
    ? '<button data-ts-signin style="height:48px;padding:0 22px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-2px);box-shadow:var(--shadow-accent-lg)" style-active="transform:scale(.98)">Sign in</button>'
    : '<button data-ts-create style="height:48px;padding:0 22px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-2px);box-shadow:var(--shadow-accent-lg)" style-active="transform:scale(.98)">Create a team</button>' +
      '<button data-ts-join style="height:48px;padding:0 22px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="border-color:var(--accent-brd);box-shadow:var(--shadow-md)">Join with a code</button>';
  return '<h1 style="margin:0 0 22px;font-family:Calistoga,Georgia,serif;font-size:36px;font-weight:400;letter-spacing:-0.02em">Team</h1>' +
    '<div style="border:1px solid var(--border);border-radius:20px;background:var(--card);padding:44px 36px;text-align:center;box-shadow:var(--shadow-md)">' +
      // Same brand mark + tile as the header logo (class="brand-mark", MARK_WHITE svg).
      '<div style="display:flex;justify-content:center;margin-bottom:18px"><div class="brand-mark">${MARK_WHITE}</div></div>' +
      '<div style="font-family:Calistoga,Georgia,serif;font-size:22px">No team yet</div>' +
      '<div style="color:var(--text2);font-size:13.5px;max-width:400px;margin:10px auto 24px">' + copy + '</div>' +
      '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' + buttons + '</div>' +
    '</div>';
}

function teamScreenSome(t, team) {
  var teams = t.teams || [];
  var isOwner = team.role === 'owner';
  var myRoleLabel = isOwner ? 'the owner' : 'a member';
  var count = (typeof team.memberCount === 'number' && team.memberCount) ? team.memberCount : tsMembers.length;
  var created = '';
  if (team.createdAt) {
    var dt = new Date(team.createdAt);
    if (!isNaN(dt.getTime())) created = ' &middot; created ' + dt.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }

  // --- page head: eyebrow + serif team name as the title, actions top-right ---
  var actions = '';
  if (isOwner) {
    actions += '<button data-ts-rename style="height:42px;padding:0 20px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="border-color:var(--accent-brd);box-shadow:var(--shadow-md)">Rename</button>';
  }
  // Always available (even with one team): the dropdown is also the only way
  // into "+ Create or join a team" from this screen.
  actions += '<button data-ts-switch style="height:42px;padding:0 20px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:13.5px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="border-color:var(--accent-brd);box-shadow:var(--shadow-md)">Switch team <span style="font-size:10px;vertical-align:1px">&#9662;</span></button>';
  if (tsSwitcherOpen) {
    var opts = teams.map(function (tm) {
      if (tm.team_id === team.team_id) {
        return '<div style="padding:9px 12px;border-radius:10px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;background:var(--surface2)">' + esc(tm.team_name) + ' <span style="margin-left:auto;color:var(--accent)">&check;</span></div>';
      }
      return '<div data-ts-switchto="' + esc(tm.team_id) + '" style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;color:var(--text2);transition:background .15s" style-hover="background:var(--surface2)">' + esc(tm.team_name) + '</div>';
    }).join('');
    actions += '<div style="position:absolute;right:0;top:calc(100% + 8px);width:230px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-xl);padding:6px;z-index:50;animation:mbFade .2s cubic-bezier(.16,1,.3,1)">' +
      opts +
      '<div style="height:1px;background:var(--border);margin:6px 8px"></div>' +
      '<div data-ts-createjoin style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;color:var(--accent);font-weight:600;transition:background .15s" style-hover="background:var(--surface2)">+ Create or join a team</div>' +
    '</div>';
  }
  var head = '<div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:38px">' +
    '<div style="flex:1;min-width:0">' +
      '<div style="' + MONO + ';font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:12px">Team</div>' +
      '<h1 style="margin:0;font-family:Calistoga,Georgia,serif;font-size:46px;font-weight:400;letter-spacing:-.02em;line-height:1.05;overflow-wrap:anywhere">' + esc(team.team_name) + '</h1>' +
      '<div style="margin-top:12px;color:var(--text2);font-size:14.5px">' + count + ' member' + (count === 1 ? '' : 's') + created + ' &middot; you are ' + myRoleLabel + '</div>' +
    '</div>' +
    (actions ? '<div style="position:relative;display:flex;gap:10px;flex:none;padding-top:38px">' + actions + '</div>' : '') +
  '</div>';

  // --- members card: tinted MEMBERS strip with the invite link, then rows ---
  var strip = '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 20px;background:var(--accent-soft);border-bottom:1px solid var(--border)">' +
    '<span style="' + MONO + ';font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--text2);font-weight:600">Members</span>' +
    '<span data-ts-invitejump style="font-size:13px;color:var(--accent);cursor:pointer;font-weight:600">+ Invite someone</span>' +
  '</div>';

  var self = t.user;
  var rows = tsMembers.map(function (m, i) {
    var name = m.display_name || '';
    var isSelf = self && self.userId === m.user_id;
    var owner = m.role === 'owner';
    var color = /^marco$/i.test(name) ? 'var(--marco)' : /^andrew$/i.test(name) ? 'var(--andrew)' : avColor(m.user_id);
    var initial = ((name || '?').charAt(0) || '?').toUpperCase();
    var jd = m.joined_at ? new Date(m.joined_at) : null;
    var joined = (jd && !isNaN(jd.getTime())) ? jd.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
    var badge = owner
      ? 'color:var(--accent);background:var(--accent-soft);border:1px solid transparent'
      : 'color:var(--text2);background:transparent;border:1px solid var(--border2)';
    var youLabel = isSelf ? ' <span style="font-size:13px;color:var(--text3);font-weight:400">&middot; you</span>' : '';
    var showControls = isOwner && !isSelf;
    var h = '<div style="display:flex;align-items:center;gap:14px;padding:16px 20px' + (i ? ';border-top:1px solid var(--border)' : '') + '">' +
      '<div style="width:38px;height:38px;border-radius:12px;background:' + color + ';color:#fff;font-size:14px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none">' + esc(initial) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;font-weight:600">' + esc(name) + youLabel + '</div>' +
        (joined ? '<div style="font-size:12.5px;color:var(--text3);margin-top:2px">joined ' + esc(joined) + '</div>' : '') +
      '</div>' +
      '<span style="' + MONO + ';font-size:10px;letter-spacing:.12em;text-transform:uppercase;' + badge + ';border-radius:99px;padding:5px 12px;flex:none">' + esc(m.role) + '</span>';
    if (showControls) {
      var roleAction = owner ? 'Make member' : 'Make owner';
      var nextRole = owner ? 'member' : 'owner';
      h += '<span data-ts-role data-user-id="' + esc(m.user_id) + '" data-role="' + nextRole + '" style="font-size:13px;color:var(--text2);cursor:pointer;font-weight:500;flex:none;transition:color .2s" style-hover="color:var(--text)">' + roleAction + '</span>' +
        '<span data-ts-remove data-user-id="' + esc(m.user_id) + '" style="font-size:13px;color:var(--text3);cursor:pointer;flex:none;transition:color .2s" style-hover="color:#DC2626">Remove</span>';
    }
    return h + '</div>';
  }).join('');

  // Owners get no foot row (the screenshot card ends on the last member);
  // members keep the Leave-team escape hatch.
  var foot = !isOwner
    ? '<div style="display:flex;justify-content:flex-end;padding:12px 20px;border-top:1px solid var(--border)">' +
        '<span data-ts-leave style="font-size:12.5px;color:var(--text3);cursor:pointer;transition:color .2s" style-hover="color:#DC2626">Leave team</span>' +
      '</div>'
    : '';

  var card = '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);margin-bottom:38px;overflow:hidden;box-shadow:var(--shadow-md)">' +
    strip + rows + foot + '</div>';

  // --- join code: dark brand card (code + COPY, helper strip with owner actions) ---
  var joinLabel = '<div style="' + MONO + ';font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);font-weight:600;margin-bottom:12px">Join code</div>';
  var hasCode = !!team.invite_code;
  var joinBody;
  if (hasCode) {
    joinBody = '<div style="display:flex;align-items:center;gap:14px;padding:24px 26px">' +
      '<div style="flex:1;min-width:0;' + MONO + ';font-size:16.5px;letter-spacing:.05em;color:var(--inv-text);overflow-wrap:anywhere">' + esc(team.invite_code) + '</div>' +
      '<button data-team-action="copy-invite" data-code="' + esc(team.invite_code) + '" style="' + MONO + ';flex:none;height:38px;padding:0 18px;border-radius:10px;border:1px solid rgba(248,250,252,.25);background:rgba(248,250,252,.06);color:var(--inv-text);font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;cursor:pointer;transition:all .2s" style-hover="border-color:rgba(248,250,252,.5)">Copy</button>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:18px;padding:14px 26px;border-top:1px solid rgba(248,250,252,.12)">' +
      '<span style="flex:1;font-size:12.5px;color:var(--inv-text2)">Anyone with this code joins as a member. Regenerating invalidates the old code.</span>' +
      (isOwner ? '<span data-ts-regen style="flex:none;font-size:13px;color:var(--inv-text);cursor:pointer;font-weight:500">Regenerate</span>' +
        '<span data-ts-revoke data-token="' + esc(team.invite_code) + '" style="flex:none;font-size:13px;color:var(--inv-text2);cursor:pointer;transition:color .2s" style-hover="color:#F87171">Revoke</span>' : '') +
    '</div>';
  } else {
    joinBody = '<div style="display:flex;align-items:center;gap:12px;padding:20px 26px">' +
      '<span style="flex:1;font-size:13px;color:var(--inv-text2)">Invites are off &mdash; no active join code.</span>' +
      (isOwner ? '<button data-ts-regen style="flex:none;height:38px;padding:0 16px;border-radius:10px;border:none;background:var(--grad);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent)">Generate a code</button>' : '') +
    '</div>';
  }
  var joinCard = joinLabel + '<div id="ts-joincode" style="border-radius:16px;background:var(--inv);overflow:hidden;box-shadow:var(--shadow-xl)">' + joinBody + '</div>';

  var memberNote = !isOwner
    ? '<div style="color:var(--text3);font-size:12px;margin-top:14px">You&rsquo;re a member &mdash; only the owner can rename the team, change roles, or manage the join code.</div>'
    : '';

  return head + card + joinCard + memberNote;
}

// Team screen delegated handlers. Mutations reuse the shared teamRequest +
// endpoints, then re-render the team screen (not the Settings-bound loadTeam).
document.getElementById('teamScreen').addEventListener('click', function (e) {
  var team = (tsTeamState && tsTeamState.authenticated) ? pickTeam(tsTeamState) : null;

  if (e.target.closest('[data-ts-signin]')) { location.hash = '#signin'; return; }
  // Create/join require a signed-in account: gate a known-signed-out click
  // with the notice instead of a doomed round-trip; a resolved error body or
  // a rejection surfaces the same way — never the old silent setPill(false).
  if (e.target.closest('[data-ts-create]')) {
    if (tsTeamState && tsTeamState.authenticated === false) { tsFail(null, 'Sign in to create a team.'); return; }
    openPrompt({
      title: 'Create a team', label: 'New team name',
      onConfirm: function (tn) {
        teamRequest('/api/team/create', { name: tn }).then(function (r) {
          if (r && r.error) return tsFail(new Error(r.error), 'Sign in to create a team.');
          if (r.team_id) { rememberTeam(r.team_id); resetFeedFilterUnions(); }
          renderTeamScreen();
        }).catch(function (err) { setPill(false); tsFail(err, 'Sign in to create a team.'); });
      }
    });
    return;
  }
  if (e.target.closest('[data-ts-join]') || e.target.closest('[data-ts-createjoin]')) {
    if (tsTeamState && tsTeamState.authenticated === false) { tsFail(null, 'Sign in to join a team.'); return; }
    openPrompt({
      title: 'Join a team', label: 'Paste an invite code',
      onConfirm: function (code) {
        teamRequest('/api/team/join', { inviteCode: code }).then(function (r) {
          if (r && r.error) return tsFail(new Error(r.error), 'Sign in to join a team.');
          if (r.team_id) { rememberTeam(r.team_id); resetFeedFilterUnions(); }
          tsSwitcherOpen = false; renderTeamScreen();
        }).catch(function (err) { setPill(false); tsFail(err, 'Sign in to join a team.'); });
      }
    });
    return;
  }
  if (!team) return;
  if (e.target.closest('[data-ts-rename]')) {
    openPrompt({
      title: 'Rename team', label: 'Team name', initial: team.team_name,
      onConfirm: function (name) {
        if (name === team.team_name) return;
        teamRequest('/api/team/rename', { teamId: team.team_id, name: name })
          .then(function () { renderTeamScreen(); }).catch(function () { setPill(false); });
      }
    });
    return;
  }
  if (e.target.closest('[data-ts-switch]')) { tsSwitcherOpen = !tsSwitcherOpen; renderTeamScreenView(); return; }
  var swto = e.target.closest('[data-ts-switchto]');
  if (swto) { rememberTeam(swto.getAttribute('data-ts-switchto')); resetFeedFilterUnions(); tsSwitcherOpen = false; renderTeamScreen(); return; }
  var roleEl = e.target.closest('[data-ts-role]');
  if (roleEl) {
    teamRequest('/api/team/set-role', { teamId: team.team_id, userId: roleEl.getAttribute('data-user-id'), role: roleEl.getAttribute('data-role') })
      .then(function () { renderTeamScreen(); }).catch(function () { setPill(false); });
    return;
  }
  var remEl = e.target.closest('[data-ts-remove]');
  if (remEl) {
    if (!armed(remEl)) return;
    remEl.style.pointerEvents = 'none';
    teamRequest('/api/team/remove-member', { teamId: team.team_id, userId: remEl.getAttribute('data-user-id') })
      .then(function () { renderTeamScreen(); }).catch(function () { setPill(false); });
    return;
  }
  if (e.target.closest('[data-ts-leave]')) {
    var leaveEl = e.target.closest('[data-ts-leave]');
    if (!armed(leaveEl)) return;
    leaveEl.style.pointerEvents = 'none';
    teamRequest('/api/team/leave', { teamId: team.team_id })
      .then(function () { rememberTeam(''); resetFeedFilterUnions(); renderTeamScreen(); }).catch(function () { setPill(false); });
    return;
  }
  if (e.target.closest('[data-ts-invitejump]')) {
    var jc = document.getElementById('ts-joincode');
    if (jc && jc.scrollIntoView) jc.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  if (e.target.closest('[data-ts-regen]')) {
    teamRequest('/api/team/rotate-invite', { teamId: team.team_id })
      .then(function () { renderTeamScreen(); }).catch(function () { setPill(false); });
    return;
  }
  var revEl = e.target.closest('[data-ts-revoke]');
  if (revEl) {
    if (!armed(revEl)) return;
    revEl.style.pointerEvents = 'none';
    teamRequest('/api/team/revoke-invite', { token: revEl.getAttribute('data-token') })
      .then(function () { renderTeamScreen(); }).catch(function () { setPill(false); });
    return;
  }
});
// copy-invite is handled by the team module's handler; bind it here too so the
// join-code Copy button toggles its "Copied" label.
document.getElementById('teamScreen').addEventListener('click', handleTeamClick);
window.addEventListener('hashchange', applyTab);
document.addEventListener('visibilitychange', applyRun);

/* ================= header actions ================= */
// The status pill doubles as the sync control: one poke syncs, then Home
// refreshes if it is the active view.
var pillBtn = document.getElementById('pill');
function syncNow() {
  if (pillBtn.classList.contains('busy')) return;
  pillBtn.classList.add('busy');
  fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function () {
      renderSyncBanner(false); // a successful sync clears the degraded banner
      refreshStatus();         // pick up the fresh teamLastSync for the pill
      if (currentTab() === 'home') { homeFp = ''; loadHome(); }
    })
    .catch(function () { setPill(false); })
    .then(function () { pillBtn.classList.remove('busy'); });
}
document.getElementById('goHome').onclick = function () { location.hash = '#home'; };
pillBtn.onclick = syncNow;
// Invites now live on the dedicated Team screen (moved out of Settings in v3).
document.getElementById('openInvite').onclick = function () { location.hash = '#team'; };
document.getElementById('openSettings').onclick = function () { location.hash = '#settings'; };
// "Sign in" shows only when signed-out. Signing in is non-blocking: it routes
// to the dedicated #signin auth view without taking over the whole app.
var signinBtn = document.getElementById('openSignin');
if (signinBtn) signinBtn.onclick = function () { location.hash = '#signin'; };

// Degraded "team sync unreachable" banner, rendered under the header. The Home/
// Project loaders call renderSyncBanner(true) on a degraded fetch; a successful
// sync clears it. Retry is delegated so it survives re-renders.
function renderSyncBanner(unreachable) {
  // Keep the header pill in lockstep with the banner so they can never disagree
  // (the old bug: banner "unreachable" while the pill still said "Synced · 5m ago").
  if (pillLabelEl) pillLabelEl.textContent = unreachable
    ? 'Offline' : (lastTeamSync ? 'Synced · ' + ago(lastTeamSync) : 'Synced');
  var el = document.getElementById('syncBanner');
  if (!el) return;
  el.innerHTML = unreachable
    ? '<div style="background:var(--amber-soft);border-bottom:1px solid var(--border)">'
      + '<div style="max-width:1080px;margin:0 auto;padding:9px 28px;font-size:12.5px;color:var(--text2);display:flex;gap:9px;align-items:center">'
      + '<span style="width:7px;height:7px;border-radius:50%;background:var(--amber);flex:none;animation:mbPulse 2s ease infinite"></span>'
      + 'Team sync unreachable — showing your local sessions only. Teammate activity will appear when the connection returns.'
      + '<span id="sbRetry" style="color:var(--accent);cursor:pointer;font-weight:600">Retry</span>'
      + '</div></div>' : '';
}
document.getElementById('syncBanner').addEventListener('click', function (e) {
  if (e.target && e.target.id === 'sbRetry') syncNow();
});

// Header theme glyph: flip light/dark and swap the moon/sun icon.
var themeToggleBtn = document.getElementById('themeToggle');
themeToggleBtn.onclick = function () {
  var next = (document.body.dataset.theme === 'dark') ? 'light' : 'dark';
  applyTheme(next);
  this.innerHTML = next === 'dark' ? '&#9728;' /* ☀ */ : '&#9790;' /* ☾ */;
};
// Initialise the glyph from the resolved boot theme (sun when dark, moon when light).
themeToggleBtn.innerHTML = resolveTheme(themePref()) === 'dark' ? '&#9728;' : '&#9790;';

/* ================= theme ================= */
function themePref() {
  try {
    var t = localStorage.getItem('mb-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch (e) { return 'system'; }
}
function resolveTheme(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  try { return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
}
function applyTheme(pref) {
  document.body.dataset.theme = resolveTheme(pref);
  try {
    if (pref === 'light' || pref === 'dark') localStorage.setItem('mb-theme', pref);
    else localStorage.removeItem('mb-theme');
  } catch (e) { /* non-persistent session */ }
}
(function initTheme() {
  applyTheme(themePref());
  function syncThemeSel() {
    var rows = document.querySelectorAll('#stTheme .radio');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('sel', rows[i].querySelector('input').checked);
    }
  }
  var radios = document.querySelectorAll('input[name=stTheme]');
  for (var i = 0; i < radios.length; i++) {
    radios[i].checked = radios[i].value === themePref();
    radios[i].onchange = function () { applyTheme(this.value); syncThemeSel(); };
  }
  syncThemeSel();
})();

// Patch relative times in place so unchanged polls never rebuild the DOM.
function refreshAgo(rootId) {
  var els = document.querySelectorAll('#' + rootId + ' [data-ago]');
  for (var i = 0; i < els.length; i++) els[i].textContent = ago(els[i].getAttribute('data-ago'));
}

/* ================= home feed view ================= */
// One unified, summary-first stream: local work + every team, day-grouped,
// filterable by person / project / tool, paged with a deduped "Load more".
var homeTimer = null, homeFp = '', homeFilters = { author: null, project: null, source: null };
var homeEntries = [];  // the full list currently on screen (base page + appended pages)
function startHome() { pxFp = ''; loadProjectsIndex(); homeTimer = setInterval(loadProjectsIndex, 5000); }
function stopHome() { if (homeTimer) { clearInterval(homeTimer); homeTimer = null; } }
function feedUrl() {
  var q = ['limit=50'];
  if (homeFilters.author) q.push('author=' + encodeURIComponent(homeFilters.author));
  if (homeFilters.project) q.push('project=' + encodeURIComponent(homeFilters.project));
  if (homeFilters.source) q.push('source=' + encodeURIComponent(homeFilters.source));
  return '/api/feed?' + q.join('&');
}
// Home is the Projects index; syncNow and modal flows call loadHome to refresh it.
function loadHome() { pxFp = ''; loadProjectsIndex(); }

/* ===================== The Projects index (#home, template lines 131–234) =====
   The default landing: every watched project as an editorial row with badge,
   last-touched, the three stats (from /api/project), a paused flag and a
   "N new sessions since you last looked" pill. New-since is computed from the
   GLOBAL catch-up pointer (/api/catchup lastViewedTs) against the recent feed —
   the only read-state we have. Filters/sort are client-side; the row ⋯ menu
   pauses/resumes and deletes (role-gated: shared+manager archives for the team,
   a member unlinks their machine, local deletes). Poll-deduped via pxFp so an
   open menu survives the 5s poll. */
var pxFp = '', pxData = null, pxMenuId = null, pxConfirmId = null;
var pxFilter = { show: 'All', person: 'All', sort: 'Recent' };
function pxEntryInProject(e, p) {
  return (!!e.projectPath && e.projectPath === p.path) || (!!e.project && e.project === p.name);
}
// Pure (offline-testable, deleteProjectsBulk style — deps injected): which
// projects survive the Person filter. Recent-window authorship keeps any
// project, and a SHARED project is also kept when the person is a MEMBER of
// its team — membership is project-scoped truth, the recent feed window is
// not, so a member with no local recent activity must not blank the list.
// Membership is TEAM-scoped via p.team.teamId; no member map degrades to the
// activity-only match, never a throw.
function pxPersonFilter(projects, person, recent, membersByTeam, entryInProject) {
  if (!person || person === 'All') return projects;
  return projects.filter(function (p) {
    var byActivity = (recent || []).some(function (e) { return e.author === person && entryInProject(e, p); });
    if (byActivity) return true;
    if (!p.team || !p.team.teamId) return false;
    var names = (membersByTeam || {})[p.team.teamId] || [];
    return names.indexOf(person) !== -1;
  });
}
function loadProjectsIndex() {
  var host = document.getElementById('homeCatchup'); if (!host) return;
  // The open-⋯-menu guard: painting the spinner would wipe the menu the
  // fp-dedup branch below deliberately protects, so the paint is vetoed.
  var pxLoadToken = armSpinner('projects', 'homeCatchup', function () { return !!(pxMenuId || pxConfirmId); });
  ensureFeedMembers(); // non-blocking; feeds the Person filter's membership match + options
  fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
    projects = projects || [];
    if (!projects.length) { clearSpinner('projects', pxLoadToken); pxData = null; pxFp = ''; renderProjectsEmpty(host); spinnerRendered('projects'); return; }
    var localPaths = projects.filter(function (p) { return p.path.charAt(0) === '/'; }).map(function (p) { return p.path; });
    var detailPs = localPaths.map(function (pp) {
      return fetch('/api/project?path=' + encodeURIComponent(pp)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    });
    Promise.all([
      fetch('/api/catchup').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      fetch('/api/team').then(function (r) { return r.json(); }).catch(function () { return { teams: [] }; }),
      fetch('/api/feed?limit=100').then(function (r) { return r.json(); }).catch(function () { return { entries: [] }; })
    ].concat(detailPs)).then(function (arr) {
      var spinnerPaintedOver = clearSpinner('projects', pxLoadToken);
      setPill(true);
      var cu = arr[0] || {}, team = arr[1] || {}, feed = arr[2] || {};
      var statsByPath = {};
      for (var i = 0; i < localPaths.length; i++) {
        var d = arr[3 + i];
        if (d && d.stats) statsByPath[localPaths[i]] = d.stats;
      }
      var offline = !!feed.teamUnavailable;
      renderSyncBanner(offline);
      pxData = {
        projects: projects,
        statsByPath: statsByPath,
        recent: (feed.entries || []),
        lastViewedTs: cu.lastViewedTs || null,
        onTeam: !!((team.teams || []).length),
        offline: offline,
      };
      // Member ids ride in the fingerprint (same idiom as the feed) so the
      // async member load repaints the Person dropdown/filter when it lands.
      var fp = JSON.stringify({ p: projects, s: statsByPath, e: pxData.recent, ts: pxData.lastViewedTs, t: pxData.onTeam, off: offline, m: (feedMembers || []).map(function (x) { return x.id; }) });
      // An open menu/confirm must survive the poll; only patch relative times.
      // But a painted-over host (the spinner replaced the rows) must fall
      // through to a real render even on an fp match — the fingerprint
      // can't see that the DOM was clobbered.
      if (fp === pxFp && host.firstChild && !spinnerPaintedOver && (pxMenuId || pxConfirmId)) { refreshAgo('view-home'); return; }
      if (fp === pxFp && host.firstChild && !spinnerPaintedOver) { refreshAgo('view-home'); return; }
      pxFp = fp;
      renderProjectsIndex();
      spinnerRendered('projects');
    }).catch(function () { setPill(false); clearSpinner('projects', pxLoadToken); });
  }).catch(function () { setPill(false); clearSpinner('projects', pxLoadToken); });
}
// Filter controls, one shape per set size. FIXED small sets (Show, Sort) get a
// labeled segmented control: options in one bordered pill-group, the active one
// filled with the accent tint. GROWING sets (Person — scales with the team) get
// a labeled dropdown instead of an ever-longer chip row. Same data-px-filter /
// pxFilter contract as the old chips, so filtering behavior is unchanged.
function pxSegment(group, label, opts, current) {
  var seg = opts.map(function (v) {
    var active = v === current;
    return '<span data-px-filter="' + group + '" data-val="' + esc(v) + '" style="padding:4px 13px;border-radius:99px;font-size:12px;cursor:pointer;white-space:nowrap;transition:all .15s;' +
      (active ? 'background:var(--accent-soft);color:var(--accent);font-weight:600' : 'color:var(--text2)') + '" style-hover="color:var(--text)">' + esc(v) + '</span>';
  }).join('');
  return '<div style="display:flex;gap:9px;align-items:center">' +
    '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">' + esc(label) + '</span>' +
    '<div style="display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--border);border-radius:99px;background:var(--card)">' + seg + '</div></div>';
}
function pxSelectCtl(group, label, opts, current) {
  var os = opts.map(function (v) {
    return '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
  }).join('');
  return '<div style="display:flex;gap:9px;align-items:center">' +
    '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">' + esc(label) + '</span>' +
    '<select data-px-select="' + group + '" style="height:30px;padding:0 9px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer;outline:none">' + os + '</select></div>';
}
// One project row (template lines 184–230), bound to live data.
function pxRowHtml(p) {
  var glyph = esc((p.name || '?').slice(0, 2).toUpperCase());
  var badge = p.team
    ? 'shared · ' + ((p.team.teamName || '').trim() || 'team')
    : 'local only';
  var newN = pxNewCount(p);
  var stats = pxData.statsByPath[p.path];
  var menuOpen = pxMenuId === p.path;
  var confirming = pxConfirmId === p.path;
  // Delete gating: local → delete; shared+manager → archive for the team; shared
  // member → unlink this machine. The backend re-enforces this.
  var manager = !!(p.team && p.team.teamId && (function (r) { return r === 'owner' || r === 'admin'; })(teamRoleFor(p.team.teamId)));
  var delMode = !p.team ? 'delete' : (manager ? 'archive' : 'unlink');
  var confirmText = delMode === 'archive' ? 'Delete for the whole team?' : delMode === 'unlink' ? 'Remove from your machine?' : 'Delete this project?';
  var pathAttr = esc(p.path);

  var titleRow = '<div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap">' +
    '<span style="font-size:15.5px;font-weight:600;letter-spacing:-0.01em">' + esc(p.name) + '</span>' +
    '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3)">' + esc(badge) + '</span>' +
    (p.paused ? '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--amber)">paused</span>' : '') +
    '</div>';
  var pathLine = '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;color:var(--text3);margin-top:3px">' + esc(p.path) + '</div>';
  var newPill = (newN > 0)
    ? '<div style="display:flex;align-items:center;gap:7px;margin-top:9px;font-size:13px;color:var(--accent);font-weight:600"><span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:mbPulse 2s ease infinite;flex:none"></span>' +
      newN + (newN === 1 ? ' new session' : ' new sessions') + ' since you last looked</div>'
    : '';
  var statsRow = stats
    ? '<div style="display:flex;align-items:center;gap:14px;margin-top:9px;font-size:12.5px;color:var(--text2);flex-wrap:wrap">' +
        '<span><strong style="font-weight:600;color:var(--text)">' + (stats.sessionsThisWeek || 0) + '</strong> sessions this week</span>' +
        '<span style="color:var(--border2)">·</span>' +
        '<span><strong style="font-weight:600;color:var(--text)">' + (stats.filesTouched || 0) + '</strong> files touched</span>' +
        '<span style="color:var(--border2)">·</span>' +
        '<span><strong style="font-weight:600;color:var(--text)">' + (stats.openTodos || 0) + '</strong> open todos</span>' +
      '</div>'
    : '';

  var lastTouched = p.lastActivity
    ? '<span style="font-size:12px;color:var(--text3)" data-ago="' + esc(p.lastActivity) + '">' + esc(ago(p.lastActivity)) + '</span>'
    : '<span style="font-size:12px;color:var(--text3)">no activity yet</span>';

  var menu = '';
  if (menuOpen) {
    menu = '<div data-px-menu-pop style="position:absolute;right:0;top:60px;width:220px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-xl);padding:6px;z-index:50;animation:mbFade .2s cubic-bezier(.16,1,.3,1)">' +
      '<div data-px-open="' + pathAttr + '" style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;transition:background .15s" style-hover="background:var(--surface2)">Open</div>' +
      '<div data-px-pause="' + pathAttr + '" style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;transition:background .15s" style-hover="background:var(--surface2)">' + (p.paused ? 'Resume watching' : 'Pause watching') + '</div>' +
      '<div data-px-open="' + pathAttr + '" style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;transition:background .15s" style-hover="background:var(--surface2)">Roadmap</div>' +
      '<div style="height:1px;background:var(--border);margin:6px 8px"></div>' +
      (confirming
        ? '<div style="padding:9px 12px;font-size:12.5px;color:var(--text2)">' + esc(confirmText) +
            '<div style="display:flex;gap:10px;margin-top:9px">' +
              '<span data-px-dodel="' + pathAttr + '" data-mode="' + delMode + '" style="color:#DC2626;font-weight:600;cursor:pointer">Delete</span>' +
              '<span data-px-canceldel style="color:var(--text3);cursor:pointer">Cancel</span>' +
            '</div></div>'
        : '<div data-px-askdel="' + pathAttr + '" style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;color:#DC2626;transition:background .15s" style-hover="background:var(--surface2)">Delete project…</div>') +
      '</div>';
  }

  return '<div style="display:flex;gap:15px;align-items:flex-start;padding:20px 4px;border-bottom:1px solid var(--border);position:relative">' +
    '<div data-px-open="' + pathAttr + '" style="width:30px;height:30px;border-radius:10px;background:var(--grad);display:flex;align-items:center;justify-content:center;font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;color:#fff;flex:none;margin-top:2px;cursor:pointer;box-shadow:var(--shadow-accent)">' + glyph + '</div>' +
    '<div data-px-open="' + pathAttr + '" style="flex:1;min-width:0;cursor:pointer">' + titleRow + pathLine + newPill + statsRow + '</div>' +
    '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:none">' + lastTouched +
      '<button data-px-menu="' + pathAttr + '" style="width:30px;height:30px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;font-size:15px;line-height:1;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">⋯</button>' +
    '</div>' + menu +
  '</div>';
}
function pxNewCount(p) {
  if (!pxData || pxData.offline || !pxData.lastViewedTs) return 0;
  var solo = pxIsSolo();
  if (solo) return 0;
  var ts = String(pxData.lastViewedTs);
  return pxData.recent.filter(function (e) {
    return e.self === false && String(e.ts) > ts && pxEntryInProject(e, p);
  }).length;
}
function pxIsSolo() {
  return !!pxData && !pxData.onTeam && pxData.projects.every(function (p) { return !p.team; });
}
function pxAuthors() {
  var seen = {}, out = [];
  (pxData.recent || []).forEach(function (e) { if (e.author && !seen[e.author]) { seen[e.author] = 1; out.push(e.author); } });
  return out;
}
function renderProjectsIndex() {
  var host = document.getElementById('homeCatchup'); if (!host || !pxData) return;
  var projects = pxData.projects;
  var solo = pxIsSolo();

  // visible = filtered + sorted
  var vis = projects.filter(function (p) {
    return pxFilter.show === 'All' || (pxFilter.show === 'Shared' ? !!p.team : !p.team);
  });
  vis = pxPersonFilter(vis, pxFilter.person, pxData.recent, feedMembersByTeam, pxEntryInProject);
  vis = vis.slice().sort(pxFilter.sort === 'Name'
    ? function (a, b) { return String(a.name).localeCompare(String(b.name)); }
    : function (a, b) { return String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')); });

  // subline
  var totalNew = 0, newAuthors = {};
  projects.forEach(function (p) {
    var n = pxNewCount(p);
    totalNew += n;
    if (n) pxData.recent.forEach(function (e) {
      if (e.self === false && pxData.lastViewedTs && String(e.ts) > String(pxData.lastViewedTs) && pxEntryInProject(e, p) && e.author) newAuthors[e.author] = 1;
    });
  });
  var who = Object.keys(newAuthors);
  var subline = pxData.offline ? 'Offline — teammate activity paused'
    : solo ? (projects.length + ' project' + (projects.length === 1 ? '' : 's') + ', all local')
    : totalNew > 0 ? (totalNew + ' new session' + (totalNew === 1 ? '' : 's') + ' from ' + (who.length === 1 ? who[0] : 'your teammates') + ' across your projects')
    : 'All caught up across your projects';

  // filters row: Show/Sort are fixed sets → segmented controls; Person grows
  // with the team → dropdown. Options are recent authors UNION team members,
  // so a member with no local recent activity is still selectable (their
  // shared projects match by membership in pxPersonFilter).
  var personOpts = ['All'].concat(pxAuthors());
  (feedMembers || []).forEach(function (m) { if (m.name && personOpts.indexOf(m.name) === -1) personOpts.push(m.name); });
  var filters =
    '<div style="display:flex;flex-wrap:wrap;gap:10px 22px;align-items:center;margin-bottom:10px;padding-bottom:14px;border-bottom:1px solid var(--border)">' +
      pxSegment('show', 'Show', ['All', 'Shared', 'Local'], pxFilter.show) +
      pxSelectCtl('person', 'Person', personOpts, pxFilter.person) +
      pxSegment('sort', 'Sort', ['Recent', 'Name'], pxFilter.sort) +
    '</div>';

  var soloBanner = solo
    ? '<div style="color:var(--text3);font-size:12.5px;margin:10px 0 4px;padding:11px 15px;border:1px dashed var(--border2);border-radius:12px">All projects are local — <span data-px-goteam style="color:var(--accent);cursor:pointer;font-weight:600">create or join a team</span> to share their memory with a teammate.</div>'
    : '';

  host.innerHTML =
    '<main style="max-width:780px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">' +
      '<div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:8px">' +
        '<h1 style="margin:0;font-family:Calistoga,Georgia,serif;font-size:40px;font-weight:400;letter-spacing:-0.02em;line-height:1.05">Projects</h1>' +
        '<div style="flex:1"></div>' +
        '<button data-px-add style="height:38px;padding:0 16px;border-radius:12px;border:1px solid var(--accent-brd);background:var(--accent-soft);color:var(--accent);font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;margin-bottom:4px;transition:all .2s" style-hover="box-shadow:var(--shadow-accent)">+ Add a project</button>' +
      '</div>' +
      '<div style="color:var(--text3);font-size:12.5px;margin-bottom:30px">' + esc(subline) + '</div>' +
      filters + soloBanner +
      vis.map(pxRowHtml).join('') +
    '</main>';
}
// Empty / first-run Projects state (template lines 143–162). Binds detected tools.
function renderProjectsEmpty(host) {
  Promise.all([
    fetch('/api/status').then(function (r) { return r.json(); }).catch(function () { return {}; }),
    fetch('/api/scan').then(function (r) { return r.json(); }).catch(function () { return { adapters: [] }; })
  ]).then(function (res) {
    setPill(true);
    var scan = res[1] || {};
    var found = {}; (scan.adapters || []).filter(function (a) { return a.exists; }).forEach(function (a) { found[a.displayName] = 1; });
    var names = Object.keys(found), n = names.length;
    var toolsLine = n ? (n + ' tool' + (n === 1 ? '' : 's') + ' detected') : 'No tools detected yet';
    var toolsDetail = n ? names.map(esc).join(', ') : 'MemBridge will pick them up automatically';
    var checkTile = '<span style="width:24px;height:24px;border-radius:8px;background:var(--grad);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;flex:none">✓</span>';
    host.innerHTML =
      '<main style="max-width:780px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">' +
        '<div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:8px">' +
          '<h1 style="margin:0;font-family:Calistoga,Georgia,serif;font-size:40px;font-weight:400;letter-spacing:-0.02em;line-height:1.05">Projects</h1>' +
        '</div>' +
        '<div style="color:var(--text3);font-size:12.5px;margin-bottom:30px">Nothing watched yet</div>' +
        '<div style="border:1px solid var(--border);border-radius:20px;background:var(--card);padding:36px;box-shadow:var(--shadow-md)">' +
          '<div style="font-family:Calistoga,Georgia,serif;font-size:22px">Welcome to MemBridge</div>' +
          '<div style="color:var(--text2);font-size:13.5px;margin:8px 0 26px">The daemon is running. A project&rsquo;s memory starts building from your very next session in it.</div>' +
          '<div style="display:grid;gap:0">' +
            '<div style="display:flex;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">' + checkTile +
              '<div style="flex:1"><span style="font-weight:600;font-size:13.5px">Daemon running</span><span style="color:var(--text3);font-size:12.5px"> — watching for sessions</span></div></div>' +
            '<div style="display:flex;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">' + checkTile +
              '<div style="flex:1"><span style="font-weight:600;font-size:13.5px">' + esc(toolsLine) + '</span><span style="color:var(--text3);font-size:12.5px"> — ' + toolsDetail + '</span></div></div>' +
            '<div style="display:flex;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">' +
              '<span style="width:24px;height:24px;border-radius:8px;border:1.5px dashed var(--border2);flex:none"></span>' +
              '<div style="flex:1"><span style="font-weight:600;font-size:13.5px">Add your first project</span><span style="color:var(--text3);font-size:12.5px"> — point MemBridge at a folder you code in</span></div>' +
              '<button data-px-add style="height:38px;padding:0 15px;border-radius:10px;border:none;background:var(--grad);color:#fff;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-1px)" style-active="transform:scale(.98)">Add project</button></div>' +
          '</div></div></main>';
  });
}
// Delegated listener for the Projects index (survives every poll rebuild).
document.getElementById('view-home').addEventListener('click', function (e) {
  // A click outside the open ⋯ menu (and off its trigger) closes it, then falls
  // through so the click still does its normal work. The trigger is excluded
  // because its own branch below toggles; item clicks land inside the popover.
  // closest() still works on the re-render-detached target: it walks the old
  // tree, and the branches below only read attributes from it.
  if (pxMenuId && !e.target.closest('[data-px-menu-pop]') && !e.target.closest('[data-px-menu]')) {
    pxMenuId = null; pxConfirmId = null; renderProjectsIndex();
  }
  var add = e.target.closest('[data-px-add]');
  if (add) { openAdd(); return; }
  var goteam = e.target.closest('[data-px-goteam]');
  if (goteam) { location.hash = '#team'; return; }
  var filt = e.target.closest('[data-px-filter]');
  if (filt) { pxFilter[filt.getAttribute('data-px-filter')] = filt.getAttribute('data-val'); renderProjectsIndex(); return; }
  var menuBtn = e.target.closest('[data-px-menu]');
  if (menuBtn) { var mp = menuBtn.getAttribute('data-px-menu'); pxMenuId = (pxMenuId === mp) ? null : mp; pxConfirmId = null; renderProjectsIndex(); return; }
  var pause = e.target.closest('[data-px-pause]');
  if (pause) {
    pause.style.pointerEvents = 'none';
    fetch('/api/projects/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: pause.getAttribute('data-px-pause') }) })
      .then(function () { pxMenuId = null; pxFp = ''; loadProjectsIndex(); }).catch(function () { setPill(false); });
    return;
  }
  var ask = e.target.closest('[data-px-askdel]');
  if (ask) { pxConfirmId = ask.getAttribute('data-px-askdel'); renderProjectsIndex(); return; }
  if (e.target.closest('[data-px-canceldel]')) { pxConfirmId = null; renderProjectsIndex(); return; }
  var dodel = e.target.closest('[data-px-dodel]');
  if (dodel) {
    var mode = dodel.getAttribute('data-mode');
    var url = mode === 'archive' ? '/api/team/archive-project' : mode === 'unlink' ? '/api/team/unlink' : '/api/projects/delete';
    dodel.style.pointerEvents = 'none';
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: dodel.getAttribute('data-px-dodel') }) })
      .then(function () { pxMenuId = null; pxConfirmId = null; pxFp = ''; loadProjectsIndex(); }).catch(function () { setPill(false); });
    return;
  }
  var open = e.target.closest('[data-px-open]');
  if (open) { location.hash = '#project=' + encodeURIComponent(open.getAttribute('data-px-open')); return; }
});
// The Person dropdown mirrors the segment clicks: same pxFilter state, same
// re-render. Delegated so it survives every poll rebuild.
document.getElementById('view-home').addEventListener('change', function (e) {
  var sel = e.target.closest('[data-px-select]');
  if (sel) { pxFilter[sel.getAttribute('data-px-select')] = sel.value; renderProjectsIndex(); }
});
// Stable key for one entry: the server pages the before boundary inclusively,
// so that boundary entry re-appears on the next page — dedupe it on append.
function feedKey(e) {
  return (e.projectId || e.projectPath || e.project || '') + '|' + (e.ts || '') + '|' + (e.ask || '');
}
function renderHome(d) {
  // A changed-data poll intentionally collapses any loaded-more pages back to
  // the base page (accepted tradeoff, same as losing expanded-summary state).
  homeEntries = (d.entries || []).slice();
  renderChips(homeEntries);
  document.getElementById('homeSuggest').innerHTML = suggestCardHtml(d);
  // Degraded notice renders above the feed only — it never replaces local work.
  document.getElementById('homeNotice').innerHTML = d.teamUnavailable
    ? '<div class="notice">Team activity unavailable — showing local work.</div>' : '';
  renderSyncBanner(!!d.teamUnavailable); // amber under-header banner mirrors the degraded state
  var feed = document.getElementById('homeFeed');
  if (!homeEntries.length) { feed.innerHTML = emptyHomeHtml(d); document.getElementById('homeMore').innerHTML = ''; return; }
  feed.innerHTML = dayGroupHtml(homeEntries, {});
  document.getElementById('homeMore').innerHTML = d.nextBefore
    ? '<button class="btn" id="homeMoreBtn" data-before="' + esc(d.nextBefore) + '">Load more</button>' : '';
}
function loadMoreHome(btn) {
  var before = btn.getAttribute('data-before');
  if (!before || btn.disabled) return;
  btn.disabled = true;
  fetch(feedUrl() + '&before=' + encodeURIComponent(before)).then(function (r) { return r.json(); }).then(function (d) {
    setPill(true);
    var seen = {};
    for (var i = 0; i < homeEntries.length; i++) seen[feedKey(homeEntries[i])] = true;
    var fresh = (d.entries || []).filter(function (e) { return !seen[feedKey(e)]; });
    // No new entries after dedupe => end of stream; drop the button so a stale
    // inclusive boundary can never loop.
    if (!fresh.length) { document.getElementById('homeMore').innerHTML = ''; return; }
    homeEntries = homeEntries.concat(fresh);
    document.getElementById('homeFeed').innerHTML = dayGroupHtml(homeEntries, {});
    document.getElementById('homeMore').innerHTML = d.nextBefore
      ? '<button class="btn" id="homeMoreBtn" data-before="' + esc(d.nextBefore) + '">Load more</button>' : '';
  }).catch(function () { setPill(false); btn.disabled = false; });
}
// Self-contained day grouping (no dependency on the team module): order by the
// time the work happened, then emit a header per calendar day.
function homeDayLabel(iso) {
  var d = new Date(iso);
  if (isNaN(d)) return 'Earlier';
  var now = new Date();
  var diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) -
    new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  var label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return d.getFullYear() === now.getFullYear() ? label : label + ', ' + d.getFullYear();
}
function dayGroupHtml(entries, opts) {
  opts = opts || {};
  var rows = entries.slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  var h = '', lastDay = '';
  for (var i = 0; i < rows.length; i++) {
    var day = homeDayLabel(rows[i].ts);
    if (day !== lastDay) { h += '<div class="feed-day">' + esc(day) + '</div>'; lastDay = day; }
    h += feedEntryHtml(rows[i], opts);
  }
  return h;
}
// Quiet filter chips derived from whatever the current feed contains. A row with
// one distinct value tells the reader nothing, so it is omitted.
function renderChips(entries) {
  var people = {}, projects = {}, tools = {};
  entries.forEach(function (e) {
    people[e.authorId || e.author] = e.author;
    if (e.project) projects[e.projectId || e.projectPath] = e.project;
    if (e.source) tools[e.source] = e.source;
  });
  var el = document.getElementById('homeChips');
  el.innerHTML =
    chipRow('author', people, homeFilters.author) +
    chipRow('project', projects, homeFilters.project) +
    chipRow('source', tools, homeFilters.source);
}
function chipRow(kind, map, active) {
  var keys = Object.keys(map); if (keys.length <= 1) return '';
  return '<div class="chiprow">' + keys.map(function (k) {
    return '<button class="chip' + (active === k ? ' on' : '') + '" data-chip="' + kind + '" data-val="' + esc(k) + '">'
      + esc(map[k]) + '</button>';
  }).join('') + '</div>';
}
// Slim suggested-links card(s) atop the feed. Nothing is shared until the user
// confirms; both actions POST to the shared suggestion endpoint then refresh.
function suggestCardHtml(d) {
  var list = (d && d.suggestions) || [];
  if (!list.length) return '';
  return list.map(function (s) {
    return '<div class="card slim-suggest"><div class="grow">' +
      '<strong>Link ' + esc(s.name) + '?</strong>' +
      '<small class="path">Same git remote as a project your team \\u201c' + esc(s.teamName) +
      '\\u201d already shares (' + esc(s.repoUrl) + '). Nothing is shared until you confirm.</small>' +
      '</div>' +
      '<button class="btn primary sug-accept" data-path="' + esc(s.path) + '">Link &amp; share</button>' +
      '<button class="btn sug-dismiss" data-path="' + esc(s.path) + '">Keep local</button></div>';
  }).join('');
}
/* ===================== The Catch-Up band (top of #home) =====================
   Loaded once per Home entry (not on the 5 s poll — a since-count churning each
   tick is noise). renderCatchup selects first-run -> not-on-a-team ->
   all-caught-up -> active. All fetches degrade gracefully. */
/* ===================== The Catch-Up home (template lines 125–338) =====================
   The whole home surface is the isCatchup <main>. Rendered from /api/projects +
   /api/catchup + /api/feed?since. Poll-deduped via catchupFp so an expanded card
   survives the 5s poll; only relative times are patched in place on no-op ticks. */
var catchupSince = null, catchupFp = '', catchupExpanded = {};
function loadCatchup() {
  var host = document.getElementById('homeCatchup'); if (!host) return;
  fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
    projects = projects || [];
    if (!projects.length) { renderWelcome(host); return; }
    Promise.all([
      fetch('/api/catchup').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      fetch('/api/team').then(function (r) { return r.json(); }).catch(function () { return { teams: [] }; }),
      fetch('/api/settings').then(function (r) { return r.json(); }).catch(function () { return { hasKey: false }; })
    ]).then(function (arr) {
      var cu = arr[0] || {}, team = arr[1] || {}, settings = arr[2] || {};
      catchupSince = cu.lastViewedTs || null;
      // renderVals flags mapped to real data: noTeam = /api/team teams empty,
      // noKey = /api/settings hasKey false.
      var onTeam = !!((team.teams || []).length);
      var noKey = !settings.hasKey;
      var feedP = catchupSince
        ? fetch('/api/feed?since=' + encodeURIComponent(catchupSince) + '&limit=50').then(function (r) { return r.json(); }).catch(function () { return { entries: [] }; })
        : Promise.resolve({ entries: [] });
      feedP.then(function (f) {
        setPill(true);
        var entries = (f && f.entries) || [];
        var offline = !!(f && f.teamUnavailable); // renderVals isOffline
        renderSyncBanner(offline);
        var fp = JSON.stringify({ cu: cu, e: entries, p: projects, off: offline, t: onTeam, k: noKey });
        if (fp === catchupFp && host.firstChild) { refreshAgo('view-home'); return; }
        catchupFp = fp;
        renderCatchup(host, cu, entries, projects, offline, onTeam, noKey);
      });
    }).catch(function () { setPill(false); });
  }).catch(function () { setPill(false); });
}
// section label pill (template lines 129–132)
function cuSectionLabel() {
  return '<div style="display:inline-flex;align-items:center;gap:10px;border-radius:99px;border:1px solid var(--accent-brd);background:var(--accent-soft);padding:6px 16px;margin-bottom:18px">' +
    '<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:mbPulse 2s ease infinite"></span>' +
    '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)">The Catch-Up</span>' +
    '</div>';
}
// title row (template lines 134–140)
function cuTitle(pre, accent, markBtn) {
  return '<div style="display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap">' +
    '<h1 style="margin:0;font-family:Calistoga,Georgia,serif;font-size:42px;font-weight:400;letter-spacing:-0.02em;line-height:1.05">' + esc(pre) +
      ' <span style="position:relative;display:inline-block"><span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">' + esc(accent) + '</span>' +
      '<span style="position:absolute;bottom:-2px;left:0;height:10px;width:100%;border-radius:2px;background:linear-gradient(to right,rgba(0,82,255,.15),rgba(77,124,255,.08))"></span></span></h1>' +
    '<div style="flex:1"></div>' +
    (markBtn ? '<button data-catchup="mark" style="height:38px;padding:0 16px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text2);font-size:13px;font-weight:500;cursor:pointer;font-family:inherit;margin-bottom:4px;transition:all .2s ease-out" style-hover="border-color:var(--accent-brd);color:var(--text);box-shadow:var(--shadow-md)" style-active="transform:scale(.98)">Mark as caught up</button>' : '') +
    '</div>';
}
// since-line (template lines 141–147; read-receipt clause dropped per skip-list)
function cuSince(cu) {
  return '<div style="display:flex;align-items:center;gap:7px;color:var(--text3);font-size:12.5px;margin:14px 0 40px;flex-wrap:wrap">' +
    (cu.lastViewedTs ? '<span>Since you last looked — <span data-ago="' + esc(cu.lastViewedTs) + '">' + esc(ago(cu.lastViewedTs)) + '</span></span>' : '') +
    '</div>';
}
function cuMainOpen() {
  return '<main style="max-width:780px;margin:0 auto;padding:52px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">';
}
// First-run Welcome (template isFresh block, lines 181–201). Binds real detected tools.
function renderWelcome(host) {
  Promise.all([
    fetch('/api/status').then(function (r) { return r.json(); }).catch(function () { return {}; }),
    fetch('/api/scan').then(function (r) { return r.json(); }).catch(function () { return { adapters: [] }; })
  ]).then(function (res) {
    var scan = res[1] || {};
    var found = {}; (scan.adapters || []).filter(function (a) { return a.exists; }).forEach(function (a) { found[a.displayName] = 1; });
    var names = Object.keys(found), n = names.length;
    var toolsLine = n ? (n + ' tool' + (n === 1 ? '' : 's') + ' detected') : 'No tools detected yet';
    var toolsDetail = n ? names.map(esc).join(', ') : 'MemBridge will pick them up automatically';
    var checkTile = '<span style="width:24px;height:24px;border-radius:8px;background:var(--grad);color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;flex:none">✓</span>';
    host.innerHTML = cuMainOpen() + cuSectionLabel() + cuTitle('Good morning,', 'Marco', false) +
      '<div style="margin-top:28px;border:1px solid var(--border);border-radius:20px;background:var(--card);padding:36px;box-shadow:var(--shadow-md)">' +
        '<div style="font-family:Calistoga,Georgia,serif;font-size:22px">Welcome to MemBridge</div>' +
        '<div style="color:var(--text2);font-size:13.5px;margin:8px 0 26px">The daemon is running. Your first briefing appears after a work session in a watched project.</div>' +
        '<div style="display:grid;gap:0">' +
          '<div style="display:flex;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">' + checkTile +
            '<div style="flex:1"><span style="font-weight:600;font-size:13.5px">Daemon running</span><span style="color:var(--text3);font-size:12.5px"> — watching for sessions</span></div></div>' +
          '<div style="display:flex;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">' + checkTile +
            '<div style="flex:1"><span style="font-weight:600;font-size:13.5px">' + esc(toolsLine) + '</span><span style="color:var(--text3);font-size:12.5px"> — ' + toolsDetail + '</span></div></div>' +
          '<div style="display:flex;gap:14px;align-items:center;padding:14px 0;border-top:1px solid var(--border)">' +
            '<span style="width:24px;height:24px;border-radius:8px;border:1.5px dashed var(--border2);flex:none"></span>' +
            '<div style="flex:1"><span style="font-weight:600;font-size:13.5px">Add your first project</span><span style="color:var(--text3);font-size:12.5px"> — point MemBridge at a folder you code in</span></div>' +
            '<button data-catchup="add-project" style="height:38px;padding:0 15px;border-radius:10px;border:1px solid var(--accent-brd);background:var(--accent-soft);color:var(--accent);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="box-shadow:var(--shadow-accent)">Add project</button></div>' +
        '</div></div></main>';
  });
}
function renderCatchup(host, cu, sinceEntries, projects, offline, onTeam, noKey) {
  var others = sinceEntries.filter(function (e) { return e.self === false; });
  var changed = projects.filter(function (p) { return cu.lastViewedTs && p.lastActivity && String(p.lastActivity) > String(cu.lastViewedTs); });
  // renderVals flags: caughtUp = on a team with no teammate sessions since
  // lastViewedTs (or marked caught up); noKey = /api/settings hasKey false;
  // isOffline = feed teamUnavailable.
  var caughtUp = onTeam && !others.length;

  // ---- ALL CAUGHT UP (template lines 150–161; title renderVals ~743 "All clear") ----
  if (caughtUp) {
    host.innerHTML = cuMainOpen() + cuSectionLabel() + cuTitle('All', 'clear', false) +
      '<div style="text-align:center;padding:60px 24px 70px">' +
        '<div style="display:flex;justify-content:center;margin-bottom:20px">' +
          '<div style="width:52px;height:52px;border-radius:16px;background:var(--grad);display:flex;align-items:center;justify-content:center;color:#fff;font-size:20px;box-shadow:var(--shadow-accent-lg)">✓</div></div>' +
        '<div style="font-family:Calistoga,Georgia,serif;font-size:24px">You’re all caught up</div>' +
        '<div style="color:var(--text2);margin-top:8px;font-size:14px;max-width:390px;margin-left:auto;margin-right:auto">Nothing new since ' + esc(cu.lastViewedTs ? ago(cu.lastViewedTs) : 'you last looked') + '. New work will collect here as it happens.</div>' +
        (cu.prevViewedTs ? '<div data-catchup="undo" style="margin-top:16px;color:var(--accent);font-size:13px;font-weight:600;cursor:pointer;display:inline-block">Undo</div>' : '') +
      '</div></main>';
    return;
  }

  // ---- NO TEAM (template lines 164–178; title renderVals ~745 "Good morning, Marco") ----
  if (!onTeam) {
    host.innerHTML = cuMainOpen() + cuSectionLabel() + cuTitle('Good morning,', 'Marco', false) +
      '<div style="border:1px solid var(--border);border-radius:20px;background:var(--card);padding:44px 36px;text-align:center;box-shadow:var(--shadow-md);position:relative;overflow:hidden">' +
        '<div style="position:absolute;top:-120px;right:-80px;width:320px;height:320px;border-radius:50%;background:var(--accent);opacity:.04;filter:blur(100px)"></div>' +
        '<div style="display:flex;justify-content:center;margin-bottom:18px;position:relative"><div style="display:flex">' +
          '<div style="width:34px;height:34px;border-radius:50%;background:var(--grad);box-shadow:var(--shadow-accent)"></div>' +
          '<div style="width:34px;height:34px;border-radius:50%;border:2px dashed var(--border2);margin-left:-9px;background:var(--bg)"></div></div></div>' +
        '<div style="font-family:Calistoga,Georgia,serif;font-size:22px">You’re not on a team yet</div>' +
        '<div style="color:var(--text2);font-size:13.5px;max-width:410px;margin:10px auto 24px">The catch-up comes alive when a teammate joins — their sessions get distilled into your briefing, and yours into theirs. Until then, MemBridge keeps syncing memory into your own tools.</div>' +
        '<button data-catchup="go-team" style="height:48px;padding:0 24px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-2px);box-shadow:var(--shadow-accent-lg)" style-active="transform:scale(.98)">Create an invite link</button>' +
        '<div style="color:var(--text3);font-size:12px;margin-top:16px">or <span data-catchup="go-team" style="color:var(--accent);cursor:pointer;font-weight:600">join an existing team</span> with a code</div>' +
      '</div></main>';
    return;
  }

  // ---- ACTIVE / new updates (template showCatchupBody, lines 203–333) ----
  // headlineSrc (renderVals ~142): offline shows YOUR own recent sessions;
  // normal shows teammates'. headlinesTitle (renderVals ~246).
  var headlineSrc = foldHeadlineSessions(offline ? sinceEntries.filter(function (e) { return e.self === true; }) : others);
  var headlineCards = headlineSrc.map(function (e) { return catchupCardHtml(e); }).join('');
  var headlinesTitle = offline ? 'Your local sessions' : ('What happened · ' + headlineSrc.length + (headlineSrc.length === 1 ? ' session' : ' sessions'));
  var offlineNote = offline
    ? '<div style="color:var(--text3);font-size:12.5px;margin:8px 0 4px">Teammate sessions are unavailable offline. Your own recent work:</div>' : '';
  var projRows = (changed.length ? changed : projects.slice(0, 5)).map(projectRowHtml).join('');

  host.innerHTML = cuMainOpen() + cuSectionLabel() + cuTitle('While you were', 'out', !offline) + cuSince(cu) +
    // B · HEADLINES (template lines 223–295)
    '<section style="margin-bottom:56px">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
        '<div style="display:inline-flex;align-items:center;gap:8px;border-radius:99px;border:1px solid var(--accent-brd);background:var(--accent-soft);padding:4px 13px">' +
          '<span style="width:6px;height:6px;border-radius:50%;background:var(--accent)"></span>' +
          '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)">' + esc(headlinesTitle) + '</span></div>' +
        '<div style="flex:1"></div>' +
        '<span data-catchup="see-everything" style="font-size:13px;color:var(--accent);cursor:pointer;font-weight:600;display:inline-flex;align-items:center;gap:4px" style-hover="color:var(--accent2)">See everything <span style="display:inline-block;transition:transform .2s">→</span></span>' +
      '</div>' + offlineNote + headlineCards +
    '</section>' +
    // C · PROJECT STATE (template lines 297–333)
    '<section>' +
      '<div style="display:inline-flex;align-items:center;gap:8px;border-radius:99px;border:1px solid var(--accent-brd);background:var(--accent-soft);padding:4px 13px;margin-bottom:10px">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:var(--accent)"></span>' +
        '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)">Projects — what changed</span></div>' +
      '<div style="display:grid;gap:14px">' + projRows + '</div>' +
    '</section></main>';
}
// Fold a flat entry list into one headline card per SESSION. A teammate pushes
// several entries per session (checkpoints + intermediate work) and most carry
// no summary and no shared ask — rendered raw, they become dozens of empty
// "no summary" cards (the "54 sessions" bug). So: drop entries with neither a
// summary nor a shared ask, group the rest by session id, and keep each
// session's newest summary-bearing entry (falling back to its newest entry) as
// the single headline. Entries without a session id stand alone. Newest-first.
function foldHeadlineSessions(entries) {
  var bySession = {}, order = [];
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.summary && !e.ask) continue;                 // nothing to show
    var key = e.session || ('__solo__' + i);            // sessionless entries stay separate
    if (!bySession[key]) { bySession[key] = []; order.push(key); }
    bySession[key].push(e);
  }
  var out = [];
  for (var j = 0; j < order.length; j++) {
    var g = bySession[order[j]], rep = null;
    for (var k = 0; k < g.length; k++) {                // prefer the newest summarized entry
      if (g[k].summary && (!rep || String(g[k].ts) > String(rep.ts))) rep = g[k];
    }
    if (!rep) { rep = g[0]; for (var m = 1; m < g.length; m++) if (String(g[m].ts) > String(rep.ts)) rep = g[m]; }
    out.push(rep);
  }
  out.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  return out;
}

// One teammate headline session card (template lines 237–293). Checkpoints/Todos
// only render when the entry carries them (teammate cards omit them per skip-list).
function catchupCardHtml(e) {
  var who = e.self ? 'You' : (e.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(e.authorId || 'you');
  var wip = !e.summary;
  var initial = esc((who[0] || '?').toUpperCase());
  var todos = e.todos || [];
  var done = todos.filter(function (t) { return t[1]; }).length;
  var todoLabel = todos.length ? (done + ' of ' + todos.length + ' todos done') : '';
  var id = esc(feedKey(e));
  var open = !!catchupExpanded[feedKey(e)];

  var head = '<div data-card-toggle="' + id + '" style="display:flex;gap:14px;align-items:flex-start;padding:17px 12px 17px 4px;margin:0 -12px 0 -4px;cursor:pointer;border-radius:14px;transition:background .2s" style-hover="background:var(--surface2)">' +
    '<div style="width:28px;height:28px;border-radius:10px;background:' + color + ';color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px;box-shadow:var(--shadow-md)">' + initial + '</div>' +
    '<div style="flex:1;min-width:0">' +
      (e.goal ? '<div class="fmeta-row"><span class="flabel">Intent</span>' + esc(e.goal) + '</div>' : '') +
      '<div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.45;text-wrap:pretty">' +
        (wip ? '<span style="color:var(--amber)">Working on:&nbsp;</span>' : '') + esc(e.summary || e.ask || '') + '</div>' +
      ((e.decisions || e.gotchas) ? '<div class="fsub">' + esc([e.decisions, e.gotchas].filter(Boolean).join(' · ')) + '</div>' : '') +
      '<div style="display:flex;align-items:center;gap:9px;margin-top:7px;font-size:12px;color:var(--text3);flex-wrap:wrap">' +
        '<span style="color:var(--text2);font-weight:500">' + esc(who) + '</span>' +
        (e.source ? '<span style="padding:2px 9px;border-radius:99px;border:1px solid var(--border);font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.04em;color:var(--text2)">' + esc(e.source) + '</span>' : '') +
        (e.project ? '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;color:var(--text3)">' + esc(e.project) + '</span>' : '') +
        (wip && todoLabel ? '<span style="display:flex;align-items:center;gap:5px;color:var(--amber);font-weight:600;font-size:11.5px"><span style="width:6px;height:6px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite"></span>in progress · ' + esc(todoLabel) + '</span>' : '') +
        '<span style="margin-left:auto;flex:none" data-ago="' + esc(e.ts) + '">' + esc(ago(e.ts)) + '</span>' +
        '<span style="color:var(--text3);font-size:10px;transform:' + (open ? 'rotate(180deg)' : 'none') + ';transition:transform .2s">▾</span>' +
      '</div>' +
    '</div></div>';

  // expanded detail (template lines 258–292); wrapped so toggling never mutates the inner markup
  var detail = '';
  if (e.ask) detail += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">The ask</div>' +
    '<p style="margin:0 0 18px;font-size:13.5px;color:var(--text2);line-height:1.65;max-width:58ch;border-left:none;font-style:italic">“' + esc(e.ask) + '”</p>';
  if (e.checkpoints && e.checkpoints.length) detail += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:9px">Checkpoints</div>' +
    '<div style="margin:0 0 18px;display:grid;gap:8px">' + e.checkpoints.map(function (c, i) {
      return '<div style="display:flex;gap:11px;font-size:13px;color:var(--text2);line-height:1.5">' +
        '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;flex:none;margin-top:2px;font-weight:500">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span>' + esc(c) + '</span></div>';
    }).join('') + '</div>';
  if (todos.length) detail += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:9px">Todos · ' + esc(todoLabel) + '</div>' +
    '<div style="height:4px;border-radius:2px;background:var(--surface3);max-width:220px;margin-bottom:11px"><div style="height:4px;border-radius:2px;background:' + (wip ? 'var(--amber)' : 'var(--grad)') + ';width:' + Math.round(100 * done / todos.length) + '%;transition:width .4s"></div></div>' +
    '<div style="display:grid;gap:6px;margin-bottom:18px">' + todos.map(function (t) {
      return '<div style="display:flex;gap:9px;font-size:13px;align-items:baseline;color:' + (t[1] ? 'var(--text3)' : 'var(--text)') + '">' +
        '<span style="font-size:11px;flex:none">' + (t[1] ? '✓' : '○') + '</span><span style="text-decoration:' + (t[1] ? 'line-through' : 'none') + '">' + esc(t[0]) + '</span></div>';
    }).join('') + '</div>';
  if (Array.isArray(e.changes) && e.changes.length) {
    detail += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:9px">Changes</div>' + changesHtml(e.changes);
  } else if (e.files && e.files.length) {
    detail += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:9px">Files touched</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + e.files.map(function (f) {
        return '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;padding:4px 9px;border-radius:8px;background:var(--surface2);color:var(--text2)">' + esc(f) + '</span>';
      }).join('') + '</div>';
  }
  var detailBlock = '<div data-card-detail="' + id + '" style="display:' + (open ? 'block' : 'none') + '">' +
    '<div style="margin:2px 0 20px 42px;padding:20px 22px;border-radius:16px;background:var(--card);border:1px solid var(--border);box-shadow:var(--shadow-md);animation:mbFade .25s cubic-bezier(.16,1,.3,1)">' + detail + '</div></div>';

  return '<article style="border-bottom:1px solid var(--border)">' + head + detailBlock + '</article>';
}
// One "Projects — what changed" row (template lines 305–330).
function projectRowHtml(p) {
  var glyph = esc((p.name || '?').slice(0, 2).toUpperCase());
  var badge = p.team
    ? '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3)">shared</span>'
    : '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);border:1px dashed var(--border2);border-radius:99px;padding:1px 8px">local only</span>';
  var lastTouched = p.lastActivity
    ? '<span style="margin-left:auto;font-size:12px;color:var(--text3);flex:none" data-ago="' + esc(p.lastActivity) + '">' + esc(ago(p.lastActivity)) + '</span>'
    : '<span style="margin-left:auto;font-size:12px;color:var(--text3);flex:none">no activity yet</span>';
  var delta = p.lastActivity ? ('Updated ' + ago(p.lastActivity)) : 'No recent activity';
  return '<div data-catchup-open="' + esc(p.path) + '" style="display:flex;gap:15px;padding:18px 20px;border:1px solid var(--border);border-radius:16px;background:var(--card);cursor:pointer;align-items:flex-start;box-shadow:var(--shadow-md);transition:all .25s ease-out" style-hover="box-shadow:var(--shadow-xl);transform:translateY(-2px);border-color:var(--accent-brd)">' +
    '<div style="width:30px;height:30px;border-radius:10px;background:var(--grad);display:flex;align-items:center;justify-content:center;font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;color:#fff;flex:none;margin-top:1px;box-shadow:var(--shadow-accent)">' + glyph + '</div>' +
    '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap">' +
        '<span style="font-size:15px;font-weight:600;letter-spacing:-0.01em">' + esc(p.name) + '</span>' + badge + lastTouched +
      '</div>' +
      '<div style="font-size:13px;color:var(--text2);margin-top:4px">' + esc(delta) + '</div>' +
    '</div></div>';
}
// The two nothing-states. Signed in but genuinely team-less: nudge toward a
// team. A transient team outage (teamUnavailable) is NOT "no team" — fall
// through to the neutral copy so we never misreport a degraded fetch.
function emptyHomeHtml(d) {
  var base = '<div class="empty">No AI activity found yet. Use Claude Code or Codex in any project and it will appear here after the next sync.</div>';
  if (d && d.signedIn && !d.hasTeam && !d.teamUnavailable) {
    return '<div class="card slim-team"><div class="grow">' +
      '<strong>You\\u2019re signed in, but not on a team yet</strong>' +
      '<small class="path">Create or join a team to see your teammates\\u2019 work in this same feed. Nothing is shared until you link a project.</small>' +
      '</div><button class="btn primary homeGoTeam">Create or join a team</button></div>' + base;
  }
  return base;
}
// One delegated listener outlives every poll rebuild.
document.getElementById('view-home').addEventListener('click', function (e) {
  var cu = e.target.closest('[data-catchup]');
  if (cu) {
    var act = cu.getAttribute('data-catchup');
    if (act === 'add-project') { openAdd(); return; }
    if (act === 'detected-tools') { openScan(); return; }
    if (act === 'go-team') { location.hash = '#team'; return; }
    if (act === 'see-everything') { location.hash = '#everything'; return; }
    if (act === 'mark') {
      cu.disabled = true;
      fetch('/api/catchup/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { loadCatchup(); }).catch(function () { cu.disabled = false; setPill(false); });
      return;
    }
    if (act === 'undo') {
      cu.disabled = true;
      fetch('/api/catchup/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { loadCatchup(); }).catch(function () { cu.disabled = false; setPill(false); });
      return;
    }
  }
  // Expand/collapse a headline session card (template's sc-if s.expanded).
  var cardToggle = e.target.closest('[data-card-toggle]');
  if (cardToggle) {
    var key = cardToggle.getAttribute('data-card-toggle');
    var det = cardToggle.nextElementSibling;
    var nowOpen = det && det.style.display === 'none';
    if (det) det.style.display = nowOpen ? 'block' : 'none';
    catchupExpanded[key] = !!nowOpen;
    var spans = cardToggle.getElementsByTagName('span');
    var chev = spans[spans.length - 1];
    if (chev) chev.style.transform = nowOpen ? 'rotate(180deg)' : 'none';
    return;
  }
  var cuOpen = e.target.closest('[data-catchup-open]');
  if (cuOpen) { location.hash = '#project=' + encodeURIComponent(cuOpen.getAttribute('data-catchup-open')); return; }
  var chip = e.target.closest('[data-chip]');
  if (chip) {
    var kind = chip.getAttribute('data-chip'), val = chip.getAttribute('data-val');
    homeFilters[kind] = (homeFilters[kind] === val) ? null : val;
    homeFp = ''; loadHome();
    return;
  }
  var person = e.target.closest('.fperson');
  if (person) {
    var a = person.getAttribute('data-author');
    homeFilters.author = (homeFilters.author === a) ? null : a;
    homeFp = ''; loadHome();
    return;
  }
  var proj = e.target.closest('.fproj');
  if (proj) {
    var target = proj.getAttribute('data-path') || proj.getAttribute('data-id');
    if (target) location.hash = '#project=' + encodeURIComponent(target);
    return;
  }
  var more = e.target.closest('#homeMoreBtn');
  if (more) { loadMoreHome(more); return; }
  var goTeam = e.target.closest('.homeGoTeam');
  if (goTeam) { location.hash = '#team'; return; }
  var acc = e.target.closest('.sug-accept'), dis = e.target.closest('.sug-dismiss');
  if (acc || dis) {
    var b = acc || dis;
    if (b.disabled) return;
    b.disabled = true;
    fetch('/api/team/suggestion', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: b.getAttribute('data-path'), accept: !!acc }),
    }).then(function () { homeFp = ''; loadHome(); })
      .catch(function () { b.disabled = false; setPill(false); });
    return;
  }
});

/* ===================== The Everything feed (#everything, template lines 340–367)
   A distinct view: the full unified feed with no since boundary, person /
   project / tool filter chips, and day-grouped session cards (the same headline
   card component as the Catch-Up). Chips filter via /api/feed query params. */
var feedTimer = null, feedFp = '', feedFilters = { author: null, project: null, source: null };
// No forced feedFp reset on entry: returning to Activity with unchanged data hits
// the fp-dedup in loadFeed, so the already-rendered feed shows instantly (no
// re-render, no fade, no flash). Real changes and first loads still render.
function startFeed() { loadFeed(); feedTimer = setInterval(loadFeed, 5000); }
function stopFeed() { if (feedTimer) { clearInterval(feedTimer); feedTimer = null; } }
function feedViewUrl() {
  var q = ['limit=100'];
  if (feedFilters.author) q.push('author=' + encodeURIComponent(feedFilters.author));
  if (feedFilters.project) q.push('project=' + encodeURIComponent(feedFilters.project));
  if (feedFilters.source) q.push('source=' + encodeURIComponent(feedFilters.source));
  return '/api/feed?' + q.join('&');
}
// Team members (id + name) for the person filter. The person chip must carry
// the user_id so the server can filter team_feed by author_id — filtering by a
// display name can't reach the DB (p_author is a uuid) and only names on the
// current page would ever appear as chips, hiding teammates whose recent entries
// are pushed below the page limit.
var feedMembers = null, feedMembersLoading = false;
var feedMembersByTeam = {}; // teamId -> display names; the Projects person filter matches shared projects by membership
function ensureFeedMembers() {
  if (feedMembers || feedMembersLoading) return;
  feedMembersLoading = true;
  fetch('/api/team').then(function (r) { return r.json(); }).then(function (t) {
    var teams = (t && t.teams) || [];
    if (!teams.length) { feedMembers = []; return null; }
    return Promise.all(teams.map(function (tm) {
      return fetch('/api/team/members?teamId=' + encodeURIComponent(tm.team_id))
        .then(function (r) { return r.json(); }).then(function (m) { return (m && m.members) || []; }).catch(function () { return []; });
    })).then(function (lists) {
      var seen = {}, out = [], byTeam = {};
      lists.forEach(function (ms, i) {
        byTeam[teams[i].team_id] = ms.map(function (m) { return m.display_name; }).filter(Boolean);
        ms.forEach(function (m) { if (m.user_id && !seen[m.user_id]) { seen[m.user_id] = 1; out.push({ id: m.user_id, name: m.display_name }); } });
      });
      feedMembers = out;
      feedMembersByTeam = byTeam;
    });
  }).catch(function () { feedMembers = []; }).then(function () { feedMembersLoading = false; });
}
function loadFeed() {
  var host = document.getElementById('feedRoot'); if (!host) return;
  // Veto the slow-load spinner whenever the feed already holds rendered content:
  // a slow poll (or an in-place filter change) must never blank a live feed.
  var feedLoadToken = armSpinner('feed', 'feedRoot', function () {
    var h = document.getElementById('feedRoot'); return !!(h && h.firstChild);
  });
  ensureFeedMembers(); // non-blocking; populates the person chips
  fetch(feedViewUrl()).then(function (r) { return r.json(); }).then(function (f) {
    var spinnerPaintedOver = clearSpinner('feed', feedLoadToken);
    setPill(true);
    var entries = (f && f.entries) || [];
    var offline = !!(f && f.teamUnavailable);
    renderSyncBanner(offline);
    // The filter chip menu is derived from the unfiltered feed so a selection
    // can't erase the other options; page fingerprint dedupes no-op polls.
    // The fingerprint serializes EVERY entry, so per-session prompt counts are
    // covered: a new prompt in an existing session changes fp and re-renders,
    // landing inside its widget (same thread key), while catchupExpanded keeps
    // an open dropdown open across the rebuild.
    // A painted-over host (the spinner replaced the feed) must fall through
    // to a real render even on an fp match — the fingerprint can't see that
    // the DOM was clobbered, and skipping here would strand the spinner.
    var fp = JSON.stringify({ e: entries, off: offline, f: feedFilters, m: (feedMembers || []).map(function (x) { return x.id; }) });
    if (fp === feedFp && host.firstChild && !spinnerPaintedOver) { refreshAgo('view-feed'); return; }
    feedFp = fp;
    renderFeed(host, entries);
    spinnerRendered('feed');
  }).catch(function () { setPill(false); clearSpinner('feed', feedLoadToken); });
}
// Filter bar, one control shape per set size (same rule as the Projects index):
// Tool is a fixed small set → labeled segmented control; Person and Project
// grow with the team / project count → labeled dropdowns. Values are what
// /api/feed actually matches (author = user_id, project = projectId else
// projectPath — never the display name, which matches neither the local
// filter nor the team_feed RPC; source = string; '' = All = null).
function feedSegment(kind, label, opts, current) {
  var seg = opts.map(function (o) {
    var active = (current || null) === (o.val || null);
    return '<span data-feed-chip="' + kind + '" data-val="' + esc(o.val || '') + '" style="padding:4px 13px;border-radius:99px;font-size:12px;cursor:pointer;white-space:nowrap;transition:all .15s;' +
      (active ? 'background:var(--accent-soft);color:var(--accent);font-weight:600' : 'color:var(--text2)') + '" style-hover="color:var(--text)">' + esc(o.label) + '</span>';
  }).join('');
  return '<div style="display:flex;gap:9px;align-items:center">' +
    '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">' + esc(label) + '</span>' +
    '<div style="display:inline-flex;align-items:center;gap:2px;padding:3px;border:1px solid var(--border);border-radius:99px;background:var(--card)">' + seg + '</div></div>';
}
function feedSelectCtl(kind, label, opts, current) {
  var os = opts.map(function (o) {
    return '<option value="' + esc(o.val || '') + '"' + ((current || null) === (o.val || null) ? ' selected' : '') + '>' + esc(o.label) + '</option>';
  }).join('');
  return '<div style="display:flex;gap:9px;align-items:center">' +
    '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">' + esc(label) + '</span>' +
    '<select data-feed-select="' + kind + '" style="height:30px;padding:0 9px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer;outline:none">' + os + '</select></div>';
}
// Tool/Project option sets accumulate a stable, never-shrinking union across
// every load in the session (mirrors how the Person filter draws from the
// team member list rather than the current entries). /api/feed's response is
// already narrowed by the active filters, so building the option set from
// THAT batch of entries made a selected tool erase every other tool's option
// — this way the full known set always renders, current selection highlighted.
var feedToolsSeen = {}, feedProjectsSeen = {};
// The unions are per-team-context: switching/joining/creating/leaving a team
// changes whose feed this is, so the Team screen handlers reset them (they
// repopulate from the next feed load; stale old-team options must not persist).
// The member cache resets with the unions: create/join/switch/leave changes
// who "members" are, and ensureFeedMembers caches even an empty no-team
// result forever — without this reset a mid-session join never loads the new
// team's members (blank Person filter until reload) and a leave keeps ghosts
// selectable. The next feed/projects tick refetches; the m:-fingerprint
// repaints when it lands. (A reset racing an in-flight load can re-cache the
// old team once; the next context change clears it again.)
function resetFeedFilterUnions() { feedToolsSeen = {}; feedProjectsSeen = {}; feedMembers = null; feedMembersByTeam = {}; }
function feedFilterBarHtml(entries) {
  entries.forEach(function (e) {
    // Project option value = projectId, else projectPath (the .fproj pill's
    // precedence; a linked project's local and team rows share the id, so one
    // project stays one option). The display name is ONLY the label: /api/feed
    // filters local rows on projectPath/projectId and the team_feed RPC takes
    // a uuid, so a name value returns "Nothing to show" for a real project.
    var pv = e.projectId || e.projectPath;
    if (e.project && pv) feedProjectsSeen[pv] = e.project;
    if (e.source) feedToolsSeen[e.source] = e.source;
  });
  // Person options come from the team member list (value = user_id) so every
  // teammate is selectable even when their entries are below the page limit,
  // and the filter queries team_feed by author_id (a name can't).
  var all = { label: 'All', val: null };
  var personOpts = [all].concat((feedMembers || []).map(function (m) { return { label: m.name, val: m.id }; }));
  var projOpts = [all].concat(Object.keys(feedProjectsSeen).sort(function (a, b) {
    return feedProjectsSeen[a].localeCompare(feedProjectsSeen[b]); // alphabetical by label, not by path/uuid
  }).map(function (k) { return { label: feedProjectsSeen[k], val: k }; }));
  var toolOpts = [all].concat(Object.keys(feedToolsSeen).sort().map(function (k) { return { label: feedToolsSeen[k], val: k }; }));
  return feedSelectCtl('author', 'Person', personOpts, feedFilters.author) +
    feedSelectCtl('project', 'Project', projOpts, feedFilters.project) +
    feedSegment('source', 'Tool', toolOpts, feedFilters.source);
}
function renderFeed(host, entries) {
  var groups = entries.length
    ? feedDayGroupHtml(entries)
    : '<div style="color:var(--text3);font-size:13px;padding:24px 4px">Nothing to show for these filters yet.</div>';
  host.innerHTML =
    '<main style="max-width:780px;margin:0 auto;padding:48px 28px 110px;animation:mbFadeQuick .18s ease">' +
      '<h1 style="margin:0 0 22px;font-family:Calistoga,Georgia,serif;font-size:36px;font-weight:400;letter-spacing:-0.02em">Activ<span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">ity</span></h1>' +
      '<div style="display:flex;gap:10px 22px;flex-wrap:wrap;align-items:center;margin-bottom:28px">' + feedFilterBarHtml(entries) + '</div>' +
      groups +
    '</main>';
  markClamped(host); // dropdowns re-rendered open need their "show more" links re-measured
}
/* ---- threaded feed: one session = one widget, day-grouped by newest entry.
   Grouping key = the session id the feed entries already carry (buildEntries
   locally, the session column on team rows); an entry without one stands alone
   as a single-prompt thread — old rows degrade, they never false-merge. ---- */
// Key components are NORMALIZED (trim + lowercase): trivial differences must
// not fragment a session — seen live, a "Membridge" vs "membridge" project
// label split one session into two "1 prompt" cards. Origin is deliberately
// NOT in the key: your own pushed entries can come back via team_feed (see
// the echo note in buildThreads), and origin would split that one session
// into a local widget and a team widget.
function normKeyPart(v) { return String(v || '').trim().toLowerCase(); }
function threadKey(e) {
  if (!e.session) return 'solo|' + feedKey(e);
  return [
    normKeyPart(e.authorId || e.author),
    normKeyPart(e.projectId || e.projectPath || e.project),
    normKeyPart(e.session),
  ].join('|');
}
function buildThreads(entries) {
  // Newest-first; at an equal ts the LOCAL copy sorts first so the echo dedup
  // below keeps it over its synced-back team twin.
  var rows = entries.slice().sort(function (a, b) {
    return String(b.ts).localeCompare(String(a.ts)) ||
      (a.origin === b.origin ? 0 : a.origin === 'local' ? -1 : 1);
  });
  // Self-echo dedup. /api/feed's buildFeed drops a team row only when its
  // (project, ts, ask) EXACTLY matches a local one — but pushProject uploads
  // ask:null when sharePrompts is off (the default) and clips at 400 vs the
  // local 300, so your own synced-back row usually differs and leaks through,
  // rendering your session twice. Same (thread, ts) twice is never meaningful:
  // keep the first (local, per the sort above).
  var seenEntry = {}, byKey = {}, threads = [];
  rows.forEach(function (e) {
    var k = threadKey(e);
    var ek = k + '|' + String(e.ts);
    if (seenEntry[ek] && e.origin !== 'local') return;
    seenEntry[ek] = 1;
    if (!byKey[k]) { byKey[k] = { key: k, entries: [] }; threads.push(byKey[k]); }
    byKey[k].entries.push(e); // newest-first within the thread
  });
  threads.forEach(function (t) {
    t.ts = t.entries[0].ts; // the newest entry anchors the thread in time
    // Header summary: the same distilled-beats-harvested pick every other
    // surface uses (digest.pickSummary) — newest distilled summary first,
    // else the newest harvested one; none => the session is in progress.
    // Headline brief is DISTILLED-only: a harvested last-message (often a
    // mid-session reasoning line like "Now let me look at the pipeline…") must
    // never sit in the summary spot. Keep the newest harvested one as secondary
    // detail, but a run with no distilled summary reads as in-progress.
    var distilled = null, harvested = null;
    t.entries.forEach(function (e) {
      if (!distilled && e.summary && e.distilled) distilled = e;
      if (!harvested && e.summary && !e.distilled) harvested = e;
    });
    t.rep = distilled;
    t.repHarvested = harvested;
  });
  return threads;
}
// ---- work units: one author's runs on one project within a time burst. The
// feed shows one widget per unit; the individual agents (main + subagents) are
// threads INSIDE it, never separate cards. Deterministic (author+project+gap),
// so unlike a file-overlap matcher it is safe to drive feed structure. ----
var BURST_GAP = 30 * 60 * 1000; // runs within 30 min are one work unit
var STALE_GAP = 45 * 60 * 1000; // newest event older than this => not "working now"
function unitKeyOf(run) {
  var e = run.entries[0];
  // Tool is part of the key. A work unit is one agent run plus its subagents,
  // which are always the SAME tool — so two DIFFERENT tools (e.g. Claude Code
  // and Codex) active in one author+project burst are separate work and must
  // not collapse into one unit. Without this, finalizeUnit labels the merged
  // unit by its newest entry's source alone, hiding the other tool's work on
  // the unfiltered Activity view (it only reappears once the Tool filter is
  // narrowed to it). Threads are single-source, so keying on entries[0].source
  // is well-defined.
  return [normKeyPart(e.authorId || e.author), normKeyPart(e.projectId || e.projectPath || e.project), normKeyPart(e.source)].join('|');
}
function buildUnits(threads) {
  var byAuthorProj = {};
  threads.forEach(function (r) {
    var k = unitKeyOf(r);
    (byAuthorProj[k] = byAuthorProj[k] || []).push(r);
  });
  var units = [];
  Object.keys(byAuthorProj).forEach(function (k) {
    var runs = byAuthorProj[k].slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
    var cur = null;
    runs.forEach(function (r) {
      var t = Date.parse(r.ts) || 0;
      if (cur && Math.abs((Date.parse(cur.ts) || 0) - t) <= BURST_GAP) {
        cur.runs.push(r);
        if (String(r.ts) < String(cur.tsStart)) cur.tsStart = r.ts;
      } else {
        cur = { key: k + '|' + (r.entries[0].session || r.key), runs: [r], ts: r.ts, tsStart: r.ts };
        units.push(cur);
      }
    });
  });
  units.forEach(finalizeUnit);
  units.sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  return units;
}
// ---- day cards: one card per (author, project, local day), rolling up
// buildUnits' output into the Activity feed's daily digest. The key is author +
// project + local day ONLY — NOT tool: one person's Claude Code, Codex and
// Distilled work for a day collapse into a SINGLE card. Units stay per-tool
// (unitKeyOf keeps the tool, so nothing is hidden — commit 261fe74's reason),
// and each tool's work shows up as its own checklist row plus a tool badge in
// c.tools. units arrive already newest-first (buildUnits' contract), so a
// single grouping pass (first unit seen per key anchors the card's identity
// fields) both accumulates the rollup and leaves cards newest-first with no
// extra sort. Nothing on a unit is mutated; cards only hold references into the
// input array. ----
function buildDayCards(units) {
  var byKey = {}, cards = [];
  units.forEach(function (u) {
    var k = [normKeyPart(u.authorId || u.author), normKeyPart(u.projectId || u.projectPath || u.project), homeDayLabel(u.ts)].join('|');
    var c = byKey[k];
    if (!c) {
      c = byKey[k] = {
        key: k, day: homeDayLabel(u.ts), ts: u.ts,
        author: u.author, authorId: u.authorId, self: u.self, source: u.source,
        project: u.project, projectId: u.projectId, projectPath: u.projectPath,
        live: false, sessionCount: 0, promptCount: 0, headline: '', units: [], tools: []
      };
      cards.push(c);
    }
    c.units.push(u); // units arrive newest-first; pushing preserves that order
    // Tool badge set: every distinct tool the day used, in first-seen (newest-
    // first) order — nothing is hidden now that tools share one card.
    if (u.source && c.tools.indexOf(u.source) === -1) c.tools.push(u.source);
    c.sessionCount += u.agentCount;
    c.promptCount += u.promptCount;
    if (u.live) c.live = true;
  });
  // Headline: the highest-promptCount DISTILLED unit for the day (tie -> the
  // newer one, compared explicitly by ts so this is right regardless of input
  // order), called the same way unitHtml calls it one level up. A day with no
  // distilled unit at all never falls back to a per-unit ask (a day digest
  // showing one session's ask would misrepresent the whole day) — it gets a
  // plain rollup line instead.
  // The summary entry to display for a unit: its distilled rep, else — only for
  // a teammate (non-self) — its harvested rep. A teammate's summary can never be
  // distilled over sync, so without this every teammate card reads "no summaries
  // shared" though the text is right there; your own harvested-only days keep
  // the strict distilled-only headline, so mid-session noise never surfaces.
  function displayRep(u, self) {
    if (u.rep && u.rep.rep) return u.rep.rep;
    if (!self && u.repHarvested && u.repHarvested.repHarvested) return u.repHarvested.repHarvested;
    return null;
  }
  cards.forEach(function (c) {
    // Distilled beats harvested regardless of promptCount: prefer the best
    // distilled unit, and only when the whole day has none fall back to the
    // best harvested teammate unit.
    var bestOf = function (pred) {
      var p = null;
      c.units.forEach(function (u) {
        if (!pred(u)) return;
        if (!p || u.promptCount > p.promptCount ||
          (u.promptCount === p.promptCount && String(u.ts) > String(p.ts))) p = u;
      });
      return p;
    };
    var pick = bestOf(function (u) { return u.rep && u.rep.rep; });
    if (!pick && !c.self) pick = bestOf(function (u) { return u.repHarvested && u.repHarvested.repHarvested; });
    c.headline = pick
      ? runHeadline(displayRep(pick, c.self), pick.runs[0].entries[0], pick.live)
      : (c.live
        ? '<span style="color:var(--amber)">Working…</span>'
        : '<span style="color:var(--text3)">' + c.sessionCount + ' sessions · no summaries shared</span>');
  });
  // v2 card data (specs/2026-07-20-activity-day-cards-v2-design.md): checklist =
  // one {glyph, text, live} row per unit — live rows hoisted first; the hoist is
  // stable and units arrive newest-first, so each half stays newest-first. Glyph
  // by state: live ◐, distilled/finished ✓, finished-no-summary ○. text is that
  // unit's runHeadline, unitHtml's exact call shape (already-escaped HTML).
  // fileCount unions file paths with feedEntryHtml's per-entry precedence —
  // a changes list beats the files list — deduped across the whole day.
  cards.forEach(function (c) {
    var rows = [];
    var seen = {}, fileCount = 0;
    c.units.forEach(function (u) {
      var rep = displayRep(u, c.self);
      var glyph = u.live ? '◐' : (rep ? '✓' : '○');
      rows.push({ glyph: glyph, text: runHeadline(rep, u.runs[0].entries[0], u.live), live: !!u.live });
      (u.runs || []).forEach(function (r) {
        (r.entries || []).forEach(function (e) {
          var list = (Array.isArray(e.changes) && e.changes.length)
            ? e.changes.map(function (ch) { return ch && ch.file; })
            : (e.files || []);
          list.forEach(function (f) { if (f && !seen[f]) { seen[f] = 1; fileCount++; } });
        });
      });
    });
    c.checklist = rows.filter(function (r) { return r.live; }).concat(rows.filter(function (r) { return !r.live; }));
    c.fileCount = fileCount;
  });
  return cards;
}
// Headline = the newest run whose rep is DISTILLED (t.rep is distilled-only
// now); harvested-only runs never supply the unit brief, so a unit with no
// distilled summary reads as in-progress. Counts/copy come from the newest run.
function finalizeUnit(u) {
  var newest = u.runs[0].entries[0];
  u.author = newest.author; u.authorId = newest.authorId; u.self = newest.self;
  u.source = newest.source; u.project = newest.project;
  u.projectId = newest.projectId; u.projectPath = newest.projectPath;
  u.agentCount = u.runs.length;
  u.promptCount = u.runs.reduce(function (n, r) { return n + r.entries.length; }, 0);
  u.rep = null;
  u.runs.forEach(function (r) { if (!u.rep && r.rep) u.rep = r; });
  // A teammate's summary is never distilled (the distilled bit is only carried
  // for re-pushed rows; harvested is the norm over sync), so the day card also
  // needs the harvested rep to fall back to — buildDayCards uses it for
  // non-self units. Local self units keep the strict distilled-only headline.
  u.repHarvested = null;
  u.runs.forEach(function (r) { if (!u.repHarvested && r.repHarvested) u.repHarvested = r; });
  // "Live" is a TIME claim, not a summary claim: activity within STALE_GAP.
  // A unit can be live with a distilled summary (still going after a
  // checkpoint) or stale with none (abandoned before the Stop hook ran).
  u.live = (Date.now() - (Date.parse(u.ts) || 0)) < STALE_GAP;
}
// One session widget, a self-contained CARD. Collapsed = the brief (a
// .sess-link that routes to the session page) + meta row (author · tool pill ·
// project · time · "N prompts ▾") — no prompt peek. The headline is three-way:
// distilled summary; else, if LIVE (activity within STALE_GAP), the amber
// "Working on: <latest ask>"; else plain — harvested summary, then the ask,
// then a muted "session ended" line — so a finished unsummarized session never
// claims to be working. Live is signalled by a pulsing mono "Working now"
// label above the headline, not a full-height border. The dropdown reuses the
// data-card-toggle contract (header + next sibling + catchupExpanded), so an
// open dropdown survives the 5s poll and the chevron must stay the LAST span
// in the header; the headline's data-sess-open is matched BEFORE the toggle in
// the click handler, so clicking the brief navigates without toggling and
// clicking the count toggles without navigating.
// Collapse control at the foot of an expanded card — tall cards otherwise force
// a scroll back up to the header chevron to close. One document-level
// [data-card-close] listener handles it, so it works in every view (feed,
// project). The control lives INSIDE the toggled body, so it hides on collapse.
function cardCloseHtml(keyAttr) {
  return '<div data-card-close="' + keyAttr + '" style="display:flex;align-items:center;justify-content:center;gap:6px;margin-top:6px;padding:8px 0 2px;font-size:11.5px;font-weight:600;color:var(--text3);cursor:pointer;border-top:1px solid var(--border)"><span style="font-size:9px">&#9650;</span>Collapse</div>';
}
// One prompt-row's text cell. A present ask renders verbatim (quoted). An empty
// ask means different things by author: for a teammate it is a prompt they
// chose NOT to share ("(prompt not shared)"); for YOUR OWN entry the prompt is
// never gated from you, so an empty one only ever means the capture missed it
// ("(no prompt captured)") — never the sharing-implying label. Returns
// already-escaped HTML.
// Word-boundary tidy for text that arrived already clipped (digest.clip cuts
// at a raw character count, so a 300-char ask can end "…chec…"): drop the
// trailing partial word so the cut never lands mid-word. No-op for text that
// doesn't end with the clip's ellipsis.
function wordSafeTail(t) {
  return String(t == null ? '' : t).replace(/\\s+\\S*…$/, '…');
}
// full=true (the day-detail view) prefers the unclipped local askFull and
// word-safes a clipped-only ask (team rows); other surfaces keep the clipped
// text as-is — their CSS line-clamp hides the tail anyway.
function promptCellText(e, full) {
  var ask = e ? (full ? (e.askFull || wordSafeTail(e.ask)) : e.ask) : null;
  if (ask) return '&ldquo;' + esc(ask) + '&rdquo;';
  return (e && e.self) ? '(no prompt captured)' : '(prompt not shared)';
}
// A share/hide failure is a SESSION-scoped problem, not a sync-health one:
// surface it inline on the toggle itself and leave the global pill alone —
// the old setPill(false) made one rejected share flash the whole app
// offline. The button keeps its true (unflipped) server state, data-busy
// clears so the next click retries, and after a beat the label restores
// (the poll repaint also restores it whenever data changes).
function shareFailUI(el) {
  el.removeAttribute('data-busy');
  el.classList.add('share-err');
  var sp = el.querySelector('span');
  if (sp) sp.innerHTML = 'couldn&rsquo;t share &mdash; retry';
  setTimeout(function () {
    el.classList.remove('share-err');
    var sp2 = el.querySelector('span');
    if (sp2) sp2.innerHTML = el.getAttribute('data-share-on') === '1' ? 'Shared' : 'Share with team';
  }, 2600);
}
// The team-visibility toggle for one of YOUR OWN sessions. You always see your
// own prompt locally; this controls whether teammates do. Rendered only when
// the newest entry is self + has a session id + a local project path (needed to
// POST). Returns '' for teammates' cards.
function shareToggleHtml(newest) {
  if (!newest || !newest.self || !newest.session || !newest.projectPath) return '';
  var on = !!newest.shared;
  var label = on ? 'Shared' : 'Share with team';
  var title = on ? 'Stop sharing this session' : 'Share this session&rsquo;s prompts with your team';
  // Monochrome line icon (inline SVG, inherits currentColor) — eye when shared,
  // slashed eye when private. No icon font dependency, no emoji.
  var icon = on
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7c1.5 0 2.9.3 4.1.9M22 12s-3.5 7-10 7c-1.5 0-2.9-.3-4.1-.9"/><path d="M4 4 20 20"/></svg>';
  return '<button type="button" data-share-toggle class="share-ctl' + (on ? ' on' : '') + '" ' +
    'data-share-session="' + esc(newest.session) + '" data-share-project="' + esc(newest.projectPath) + '" data-share-on="' + (on ? '1' : '0') + '" title="' + title + '">' +
    icon + '<span>' + label + '</span></button>';
}
// One-glance helpers for card headlines (see specs/2026-07-20-activity-headline).
// Word-boundary cap for glance lines. Distilled headlines are bounded at
// capture (hooks HEADLINE_MAX = 80 < 90) and pass through untouched; this
// only degrades legacy/teammate rows and derived first sentences.
function capLine(s) {
  return s.length > 90 ? s.slice(0, 89).replace(/\\s+\\S*$/, '') + '…' : s;
}
function firstSentence(text) {
  var s = String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
  if (!s) return '';
  var m = s.match(/^(.+?[.!?])(\\s|$)/);
  return capLine(m ? m[1] : s);
}
// Returns the safe ask text for a live headline, or null to show "Working…".
function askHeadline(ask) {
  var raw = String(ask == null ? '' : ask);
  var s = raw.replace(/\\s+/g, ' ').trim();
  if (!s) return null;
  var noisy = s.length > 120
    || /(Error|Exception|failed:|Traceback|LOCKDOWN|at\\s+\\/)/.test(s)
    || (raw.match(/\\n/g) || []).length >= 3;
  return noisy ? null : firstSentence(s);
}
// The card's main line. Distilled headline/first-sentence wins; harvested prose
// is NEVER used; live shows a guarded ask; finished falls back to the ask's first
// sentence, else a plain placeholder. Returns already-escaped HTML.
function runHeadline(rep, newest, live) {
  if (rep) return esc(rep.headline ? capLine(rep.headline) : firstSentence(rep.summary));
  if (live) {
    var a = askHeadline(newest && newest.ask);
    return a
      ? '<span style="color:var(--amber)">Working on:&nbsp;</span>' + esc(a)
      : '<span style="color:var(--amber)">Working…</span>';
  }
  var ask = newest && newest.ask ? firstSentence(newest.ask) : '';
  return ask ? esc(ask) : '<span style="color:var(--text3)">session ended · no summary shared</span>';
}
function threadHtml(t, opts) {
  var newest = t.entries[0];
  var who = newest.self ? 'You' : (newest.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(newest.authorId || 'you');
  var initial = esc((who[0] || '?').toUpperCase());
  var live = (Date.now() - (Date.parse(t.ts) || 0)) < STALE_GAP;
  var open = !!catchupExpanded[t.key];
  var n = t.entries.length;
  var keyAttr = esc(t.key);
  var headline = runHeadline(t.rep, newest, live);
  var liveLabel = live
    ? '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;' + MONO + ';font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);font-weight:600"><span style="width:6px;height:6px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite;flex:none"></span>Working now</div>'
    : '';
  // Triad (Intent / decisions·gotchas): same fields + markup as feedEntryHtml's
  // summaryLine, sourced from the thread's representative entry (t.rep) so a
  // thread with no distilled/harvested summary yet renders exactly as before.
  var intentHtml = (t.rep && t.rep.goal) ? '<div class="fmeta-row" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span class="flabel">Intent</span>' + esc(t.rep.goal) + '</div>' : '';
  var subHtml = (t.rep && (t.rep.decisions || t.rep.gotchas))
    ? '<div class="fsub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc([t.rep.decisions, t.rep.gotchas].filter(Boolean).join(' · ')) + '</div>'
    : '';
  var head = '<div data-card-toggle="' + keyAttr + '" style="display:flex;gap:14px;align-items:flex-start;padding:2px 12px 2px 4px;margin:0 -12px 0 -4px;cursor:pointer;border-radius:14px;transition:background .2s" style-hover="background:var(--surface2)">' +
    '<div style="width:28px;height:28px;border-radius:10px;background:' + color + ';color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px;box-shadow:var(--shadow-md)">' + initial + '</div>' +
    '<div style="flex:1;min-width:0">' + liveLabel +
      '<div class="sess-link" data-sess-open="' + keyAttr + '" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.45;text-wrap:pretty;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + headline + '</div>' +
      intentHtml + subHtml +
      '<div style="display:flex;align-items:center;gap:9px;margin-top:7px;font-size:12px;color:var(--text3);flex-wrap:wrap">' +
        '<span style="color:var(--text2);font-weight:500">' + esc(who) + '</span>' +
        (newest.source ? '<span style="padding:2px 9px;border-radius:99px;border:1px solid var(--border);' + MONO + ';font-size:10px;letter-spacing:.04em;color:var(--text2)">' + esc(newest.source) + '</span>' : '') +
        // opts.hideProject: the project page is all one project, the pill is noise.
        (newest.project && !(opts && opts.hideProject) ? '<span style="' + MONO + ';font-size:10.5px;color:var(--text3)">' + esc(newest.project) + '</span>' : '') +
        shareToggleHtml(newest) +
        '<span style="margin-left:auto;flex:none" data-ago="' + esc(t.ts) + '">' + esc(ago(t.ts)) + '</span>' +
        '<span style="color:var(--accent);font-weight:600;font-size:11.5px;flex:none">' + n + (n === 1 ? ' prompt' : ' prompts') + '</span>' +
        '<span style="color:var(--text3);font-size:10px;transform:' + (open ? 'rotate(180deg)' : 'none') + ';transition:transform .2s">&#9662;</span>' +
      '</div>' +
    '</div></div>';
  // Full brief: the headline clamps to 2 lines, so the complete distilled
  // outcome (summaryFull when the entry carries it, else summary) moves here,
  // at the top of the expander — the glance stays short, the story is one click away.
  var fullBrief = (t.rep && (t.rep.summaryFull || t.rep.summary))
    ? '<div class="fd-label">Summary</div><div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:10px">' + esc(t.rep.summaryFull || t.rep.summary) + '</div>'
    : '';
  // Capped dropdown: the 3 most recent prompts, clamped, + "See all" — built by
  // the shared promptRowsHtml so the single-run card and agent threads stay in
  // lockstep. A display:none block measures as zero, so markClamped runs on
  // open (and after any re-render that restores an open dropdown).
  var kidsBlock = '<div style="display:' + (open ? 'block' : 'none') + '">' +
    fullBrief +
    '<div style="margin:2px 0 6px 13px;padding:2px 0 2px 25px;border-left:2px solid var(--border)">' + promptRowsHtml(t) + '</div>' + cardCloseHtml(keyAttr) + '</div>';
  return '<article style="border:0.5px solid var(--border);border-radius:14px;background:var(--card);padding:16px 18px;margin-bottom:14px">' + head + kidsBlock + '</article>';
}
// The capped prompt list for one run: the 3 most recent prompts (oldest→newest
// of those three), each clamped to 2 lines with a measured "show more", plus a
// "See all N prompts →" into the run's session page when there are more than 3.
// Shared by threadHtml (single-run card) and unitHtml (agent threads) so the
// clamp/show-more/see-all behavior can never drift between the two surfaces.
function promptRowsHtml(t) {
  var n = t.entries.length;
  var keyAttr = esc(t.key);
  var kids = t.entries.slice(0, 3).reverse().map(function (e) {
    return '<div style="display:flex;gap:10px;align-items:baseline;padding:6px 0">' +
      '<div style="flex:1;min-width:0">' +
        '<div data-clamp style="font-size:13px;line-height:1.55;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;' + (e.ask ? 'color:var(--text2);font-style:italic' : 'color:var(--text3)') + '">' +
          promptCellText(e) + '</div>' +
        '<span data-clamp-more style="display:none;margin-top:2px;font-size:11.5px;color:var(--accent);font-weight:600;cursor:pointer">show more</span>' +
      '</div>' +
      '<span style="font-size:11.5px;color:var(--text3);white-space:nowrap;flex:none" data-ago="' + esc(e.ts) + '">' + esc(ago(e.ts)) + '</span>' +
    '</div>';
  }).join('');
  var seeAll = n > 3
    ? '<div class="sess-link" data-sess-open="' + keyAttr + '" style="padding:7px 0 2px;font-size:12.5px;color:var(--accent);font-weight:600">See all ' + n + ' prompts →</div>'
    : '';
  return kids + seeAll;
}
// One work-unit widget, a self-contained CARD. Collapsed = the distilled brief
// (or the three-way fallback: live → amber "Working on:", finished → plain
// harvested/ask/"session ended") + a meta row that counts agents and prompts.
// Live = activity within STALE_GAP, signalled by a pulsing mono "Working now"
// label above the headline, never a full-height border. Expanded = one AGENT
// THREAD per run, oldest→newest, each headed by that run's own brief and
// carrying its capped prompts. The clutter guard keeps a trivial single-run
// single-prompt unit as today's simple one-line card. Reuses the
// data-card-toggle + catchupExpanded + markClamped contract unchanged, so the
// chevron must stay the LAST span in the header and the headline's data-sess-open
// is matched before the toggle.
function unitHtml(u, opts) {
  // Clutter guard: nothing to consolidate — render the plain card.
  if (u.runs.length === 1 && u.promptCount === 1) return threadHtml(u.runs[0], opts);
  var newestRun = u.runs[0];
  var newest = newestRun.entries[0];
  var who = u.self ? 'You' : (u.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(u.authorId || 'you');
  var initial = esc((who[0] || '?').toUpperCase());
  var open = !!catchupExpanded[u.key];
  var keyAttr = esc(u.key);
  var navKey = esc(newestRun.key); // the headline opens the newest run's session page
  var headline = runHeadline(u.rep && u.rep.rep, newest, u.live);
  var liveLabel = u.live
    ? '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;' + MONO + ';font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);font-weight:600"><span style="width:6px;height:6px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite;flex:none"></span>Working now</div>'
    : '';
  var count = u.agentCount > 1
    ? u.agentCount + ' agents &middot; ' + u.promptCount + ' prompts'
    : u.promptCount + (u.promptCount === 1 ? ' prompt' : ' prompts');
  // Triad (Intent / decisions·gotchas) from the unit's representative run
  // (u.rep is a run; u.rep.rep is its distilled summary entry), matching
  // threadHtml so a consolidated card surfaces the same fields as a single-run one.
  var repEntry = u.rep && u.rep.rep;
  var intentHtml = (repEntry && repEntry.goal) ? '<div class="fmeta-row" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span class="flabel">Intent</span>' + esc(repEntry.goal) + '</div>' : '';
  var subHtml = (repEntry && (repEntry.decisions || repEntry.gotchas))
    ? '<div class="fsub" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc([repEntry.decisions, repEntry.gotchas].filter(Boolean).join(' · ')) + '</div>'
    : '';
  var head = '<div data-card-toggle="' + keyAttr + '" style="display:flex;gap:14px;align-items:flex-start;padding:2px 12px 2px 4px;margin:0 -12px 0 -4px;cursor:pointer;border-radius:14px;transition:background .2s" style-hover="background:var(--surface2)">' +
    '<div style="width:28px;height:28px;border-radius:10px;background:' + color + ';color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px;box-shadow:var(--shadow-md)">' + initial + '</div>' +
    '<div style="flex:1;min-width:0">' + liveLabel +
      '<div class="sess-link" data-sess-open="' + navKey + '" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.45;text-wrap:pretty;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + headline + '</div>' +
      intentHtml + subHtml +
      '<div style="display:flex;align-items:center;gap:9px;margin-top:7px;font-size:12px;color:var(--text3);flex-wrap:wrap">' +
        '<span style="color:var(--text2);font-weight:500">' + esc(who) + '</span>' +
        (u.source ? '<span style="padding:2px 9px;border-radius:99px;border:1px solid var(--border);' + MONO + ';font-size:10px;letter-spacing:.04em;color:var(--text2)">' + esc(u.source) + '</span>' : '') +
        // opts.hideProject: the project page is all one project, the pill is noise.
        (u.project && !(opts && opts.hideProject) ? '<span style="' + MONO + ';font-size:10.5px;color:var(--text3)">' + esc(u.project) + '</span>' : '') +
        shareToggleHtml(newest) +
        '<span style="margin-left:auto;flex:none" data-ago="' + esc(u.ts) + '">' + esc(ago(u.ts)) + '</span>' +
        '<span style="color:var(--accent);font-weight:600;font-size:11.5px;flex:none">' + count + '</span>' +
        '<span style="color:var(--text3);font-size:10px;transform:' + (open ? 'rotate(180deg)' : 'none') + ';transition:transform .2s">&#9662;</span>' +
      '</div>' +
    '</div></div>';
  // Agent threads oldest→newest: each run gets its own brief header + capped
  // prompts, connected by a left line. Labels follow the same three-way rule as
  // the headline, on the RUN's own clock — a stale unit expanded must not say
  // "Working on:" one level down, and a harvested reasoning line still never
  // masquerades as a brief while the run is live.
  var threads = u.runs.slice().reverse().map(function (r, i) {
    var rlive = (Date.now() - (Date.parse(r.ts) || 0)) < STALE_GAP;
    var rlabel = runHeadline(r.rep, r.entries[0], rlive);
    return '<div style="margin-top:' + (i ? '16px' : '4px') + '">' +
      '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:3px">' +
        '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);flex:none">Agent ' + (i + 1) + '</span>' +
        '<span style="font-size:13px;font-weight:600;color:var(--text2);line-height:1.4;min-width:0">' + rlabel + '</span>' +
      '</div>' +
      '<div style="margin:2px 0 2px 2px;padding-left:16px;border-left:2px solid var(--border)">' + promptRowsHtml(r) + '</div>' +
    '</div>';
  }).join('');
  // Full brief: mirrors threadHtml's expander — the clamped headline pushes the
  // complete distilled outcome down here, above the per-run agent threads.
  var fullBrief = (repEntry && (repEntry.summaryFull || repEntry.summary))
    ? '<div class="fd-label">Summary</div><div style="font-size:13px;color:var(--text2);line-height:1.5;margin-bottom:10px">' + esc(repEntry.summaryFull || repEntry.summary) + '</div>'
    : '';
  var body = '<div style="display:' + (open ? 'block' : 'none') + '">' +
    '<div style="margin:2px 0 6px 13px;padding-left:12px">' + fullBrief + threads + '</div>' + cardCloseHtml(keyAttr) + '</div>';
  return '<article style="border:0.5px solid var(--border);border-radius:14px;background:var(--card);padding:16px 18px;margin-bottom:14px">' + head + body + '</article>';
}
// Reveal "show more" only under REAL overflow — measured, never guessed, so a
// short prompt keeps its single clean row. Measurement needs layout, so this
// runs after render for dropdowns that are already open, and again from the
// toggle handler the moment one opens (a display:none block measures as 0).
function markClamped(root) {
  var els = root.querySelectorAll('[data-clamp]');
  for (var i = 0; i < els.length; i++) {
    if (els[i].scrollHeight > els[i].clientHeight + 1) {
      var more = els[i].nextElementSibling;
      if (more) more.style.display = 'inline-block';
    }
  }
}
// One day's rollup CARD, mock v2 (specs/2026-07-20-activity-day-cards-v2-design.md):
// a one-sentence day headline + a checklist of the day's changes. Two-level
// drill: the whole HEADER (avatar + who/chip/proj/when + headline) is a
// data-day-open target routing to the day's session view — it NAVIGATES, so
// the data-card-toggle contract does not apply to this card. The checklist
// sits in the card body, always visible up to 4 rows; rows 5+ live in a
// data-day-more fold that starts hidden and is revealed in place by the
// bottom-right data-day-expand control. Expand state persists in
// catchupExpanded keyed by the day-card key, so an open fold survives the 5s
// poll repaint. Rows are display-only: glyph (◐ live / ✓ distilled /
// ○ finished-no-summary) + that unit's runHeadline (c.checklist[].text,
// already-escaped HTML — never re-escaped), live rows tagged "working now".
// Footer: stat row (sessions · prompts · files) bottom-left, expander
// bottom-right.
function dayCardHtml(c, opts) {
  var who = c.self ? 'You' : (c.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(c.authorId || 'you');
  var initial = esc((who[0] || '?').toUpperCase());
  var open = !!catchupExpanded[c.key];
  var keyAttr = esc(c.key);
  var rows = c.checklist || [];
  var rowHtml = function (r) {
    var glyphColor = r.live ? 'var(--amber)' : (r.glyph === '✓' ? 'var(--green)' : 'var(--text3)');
    var tag = r.live
      ? '<span style="flex:none;display:inline-flex;align-items:center;gap:5px;' + MONO + ';font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:var(--amber);font-weight:600"><span style="width:5px;height:5px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite"></span>working now</span>'
      : '';
    return '<div style="display:flex;gap:9px;align-items:baseline;padding:3.5px 0">' +
      '<span style="flex:none;font-size:11.5px;line-height:1.5;color:' + glyphColor + '">' + r.glyph + '</span>' +
      '<span style="flex:1;min-width:0;font-size:13px;color:var(--text2);line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + r.text + '</span>' +
      tag +
    '</div>';
  };
  var visibleRows = rows.slice(0, 4).map(rowHtml).join('');
  var foldRows = rows.length > 4 ? rows.slice(4).map(rowHtml).join('') : '';
  var fold = foldRows
    ? '<div data-day-more="' + keyAttr + '" style="display:' + (open ? 'block' : 'none') + '">' + foldRows + '</div>'
    : '';
  var stat = c.sessionCount + (c.sessionCount === 1 ? ' session' : ' sessions') +
    ' &middot; ' + c.promptCount + (c.promptCount === 1 ? ' prompt' : ' prompts') +
    ' &middot; ' + (c.fileCount || 0) + (c.fileCount === 1 ? ' file' : ' files');
  var expander = rows.length > 4
    ? '<span data-day-expand="' + keyAttr + '" data-day-count="' + rows.length + '" style="flex:none;cursor:pointer;color:var(--accent);font-weight:600;font-size:11.5px">' +
      (open ? 'Show fewer &#9652;' : 'Show all ' + rows.length + ' changes &#9662;') + '</span>'
    : '';
  var head = '<div data-day-open="' + keyAttr + '" style="display:flex;gap:14px;align-items:flex-start;padding:2px 12px 2px 4px;margin:0 -12px 0 -4px;cursor:pointer;border-radius:14px;transition:background .2s">' +
    '<div style="width:28px;height:28px;border-radius:10px;background:' + color + ';color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none;margin-top:1px;box-shadow:var(--shadow-md)">' + initial + '</div>' +
    '<div style="flex:1;min-width:0">' +
      '<div style="display:flex;align-items:center;gap:9px;font-size:12px;color:var(--text3);flex-wrap:wrap">' +
        '<span style="color:var(--text2);font-weight:500">' + esc(who) + '</span>' +
        // One badge per tool used that day (FIX 1). Falls back to c.source for a
        // card built before c.tools existed.
        (c.tools && c.tools.length ? c.tools : (c.source ? [c.source] : [])).map(function (tool) {
          return '<span style="padding:2px 9px;border-radius:99px;border:1px solid var(--border);' + MONO + ';font-size:10px;letter-spacing:.04em;color:var(--text2)">' + esc(tool) + '</span>';
        }).join('') +
        (c.project && !(opts && opts.hideProject) ? '<span style="' + MONO + ';font-size:10.5px;color:var(--text3)">' + esc(c.project) + '</span>' : '') +
        '<span style="margin-left:auto;flex:none" data-ago="' + esc(c.ts) + '">' + esc(ago(c.ts)) + '</span>' +
      '</div>' +
      '<div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.45;text-wrap:pretty;margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + c.headline + '</div>' +
    '</div>' +
  '</div>';
  var body = '<div style="margin:10px 0 0 42px">' + visibleRows + fold + '</div>';
  var foot = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:10px 0 0 42px">' +
    '<span style="font-size:11.5px;color:var(--text3)">' + stat + '</span>' + expander + '</div>';
  return '<article style="border:0.5px solid var(--border);border-radius:14px;background:var(--card);padding:16px 18px;margin-bottom:14px">' + head + body + foot + '</article>';
}
// Level 2 — the DAY-DETAIL session view (specs/2026-07-20-activity-day-cards-v2-design.md):
// what a day card's header opens. Breadcrumb (Activity › who — day) + the
// day's sentence headline, then one session card per unit, live-first — each
// card is the unit's runHeadline as its title, the 2–3 sentence distilled
// summary (summaryFull || summary — the headline alone is never the whole
// story here), and the unit's prompts behind a bottom-left "▾ show N prompts"
// toggle, oldest→newest, "(prompt not shared)" when unshared. Prompt rows are
// DISPLAY-ONLY — no data-sess-open / data-day-open / any deeper-open attribute
// renders anywhere in this view: the spec is two levels, there is no level 3.
// Fold state persists in catchupExpanded under 'prompts|'+unit key so an open
// fold survives the 5s poll repaint. A null card (day scrolled out of the
// feed window) degrades to the same friendly not-found shape as the session
// page.
function dayDetailHtml(c, opts) {
  var openMain = '<main style="max-width:780px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">';
  var backBtn = '<button data-day-back title="Back to Activity" style="display:inline-flex;align-items:center;gap:7px;width:auto;height:34px;padding:0 14px;margin-bottom:18px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text2);font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;box-shadow:none;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text);box-shadow:var(--shadow-md)">' +
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M15 18l-6-6 6-6"/></svg>Activity</button>';
  if (!c) {
    // FIX 2: while the day view's fetch is still in flight, show the slow-load
    // spinner — the not-found message renders ONLY after a resolved fetch with
    // no matching day (opts.loading falsy), so a normal drill-in never flashes
    // "not in feed" during the load.
    if (opts && opts.loading) {
      return openMain + backBtn +
        '<div style="display:flex;justify-content:center;padding:56px 0"><div style="width:24px;height:24px;border-radius:50%;border:2.5px solid var(--border);border-top-color:var(--accent);animation:mbSpin .8s linear infinite"></div></div>' +
        '</main>';
    }
    return openMain + backBtn +
      '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:10px">Day</div>' +
      '<div class="empty">This day isn&rsquo;t in the current feed &mdash; it may have scrolled past the recent window. Head back to Activity to see what&rsquo;s live.</div>' +
      '</main>';
  }
  var who = c.self ? 'You' : (c.author || 'Someone');
  var crumb = '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:10px">Activity &rsaquo; ' + esc(who) + ' &mdash; ' + esc(c.day) + '</div>';
  var headline = '<div style="font-size:20px;font-weight:600;letter-spacing:-0.015em;line-height:1.4;text-wrap:pretty;margin-bottom:24px">' + c.headline + '</div>';
  // Live-first, same stable hoist as the checklist: each half stays newest-first.
  var units = c.units || [];
  var ordered = units.filter(function (u) { return u.live; }).concat(units.filter(function (u) { return !u.live; }));
  var cards = ordered.map(function (u) {
    var repEntry = u.rep && u.rep.rep;
    var newest = u.runs[0].entries[0]; // newest entry of the unit: drives the share toggle
    // Never a mid-word cut in the title: feed runHeadline the full local ask
    // when we have it (firstSentence clamps it word-safely) or a word-safe
    // tail of a clipped-only one. runHeadline only reads .ask off this arg.
    var titleEntry = (newest && newest.ask)
      ? { ask: newest.askFull || wordSafeTail(newest.ask) }
      : newest;
    var title = runHeadline(repEntry, titleEntry, u.live);
    var liveLabel = u.live
      ? '<div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;' + MONO + ';font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);font-weight:600"><span style="width:6px;height:6px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite;flex:none"></span>Working now</div>'
      : '';
    // summaryFull is the known-complete local text; a summary that only exists
    // clipped (team rows) gets its tail tidied so it never ends mid-word.
    var summary = (repEntry && (repEntry.summaryFull || repEntry.summary))
      ? '<div style="font-size:13px;color:var(--text2);line-height:1.55;margin-top:6px">' + esc(repEntry.summaryFull || wordSafeTail(repEntry.summary)) + '</div>'
      : '';
    // Every entry across the unit's runs, oldest→newest — the day reads
    // chronologically one level down.
    var entries = [];
    (u.runs || []).forEach(function (r) { (r.entries || []).forEach(function (e2) { entries.push(e2); }); });
    entries.sort(function (a, b) { return String(a.ts).localeCompare(String(b.ts)); });
    var n = entries.length;
    var rows = entries.map(function (e2) {
      return '<div style="display:flex;gap:10px;align-items:baseline;padding:6px 0">' +
        '<div style="flex:1;min-width:0;font-size:13px;line-height:1.55;' + (e2.ask ? 'color:var(--text2);font-style:italic' : 'color:var(--text3)') + '">' +
          promptCellText(e2, true) + '</div>' +
        '<span style="font-size:11.5px;color:var(--text3);white-space:nowrap;flex:none" data-ago="' + esc(e2.ts) + '">' + esc(ago(e2.ts)) + '</span>' +
      '</div>';
    }).join('');
    var foldOpen = !!catchupExpanded['prompts|' + u.key];
    var keyAttr = esc(u.key);
    // Per-session share control (self units only; shareToggleHtml returns '' for
    // teammates). Restores the team-sharing affordance the day-cards v2 redesign
    // dropped from the Activity view — one session card is where a per-session
    // toggle belongs.
    var share = shareToggleHtml(newest);
    var foot = '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px">' +
      '<span data-prompts-toggle="' + keyAttr + '" data-prompts-count="' + n + '" style="cursor:pointer;color:var(--accent);font-weight:600;font-size:11.5px">' +
        (foldOpen ? '&#9652; hide ' : '&#9662; show ') + n + (n === 1 ? ' prompt' : ' prompts') + '</span>' +
      '<div style="display:flex;align-items:center;gap:10px;flex:none">' + share +
        '<span style="font-size:11.5px;color:var(--text3)" data-ago="' + esc(u.ts) + '">' + esc(ago(u.ts)) + '</span>' +
      '</div>' +
    '</div>';
    var fold = '<div data-prompts-fold="' + keyAttr + '" style="display:' + (foldOpen ? 'block' : 'none') + ';margin-top:6px;padding-left:14px;border-left:2px solid var(--border)">' + rows + '</div>';
    return '<article style="border:0.5px solid var(--border);border-radius:14px;background:var(--card);padding:16px 18px;margin-bottom:14px">' +
      liveLabel +
      '<div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.45;text-wrap:pretty">' + title + '</div>' +
      summary + foot + fold +
    '</article>';
  }).join('');
  return openMain + backBtn + crumb + headline + cards + '</main>';
}
// Day-grouped Activity stream (specs/2026-07-20-activity-day-cards-v2-design.md):
// the top level is buildDayCards' rollup — one dayCardHtml per (author,
// project, local day) under the same homeDayLabel separators as before.
// opts.unitCards is the project-page exception: that page keeps its original
// flat per-unit loop (day cards are Activity-only), so its callers pass
// unitCards:true alongside hideProject.
function feedDayGroupHtml(entries, opts) {
  var units = buildUnits(buildThreads(entries));
  var h = '', lastDay = '';
  if (opts && opts.unitCards) {
    for (var i = 0; i < units.length; i++) {
      var day = homeDayLabel(units[i].ts);
      if (day !== lastDay) {
        h += '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin:28px 0 4px">' + esc(day) + '</div>';
        lastDay = day;
      }
      h += unitHtml(units[i], opts);
    }
    return h;
  }
  var cards = buildDayCards(units);
  for (var j = 0; j < cards.length; j++) {
    var cday = homeDayLabel(cards[j].ts);
    if (cday !== lastDay) {
      h += '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin:28px 0 4px">' + esc(cday) + '</div>';
      lastDay = cday;
    }
    h += dayCardHtml(cards[j], opts);
  }
  return h;
}
// Delegated listener for the feed view: filter chips, session navigation,
// per-prompt "show more", and card toggles. Order matters: the
// headline's data-sess-open sits INSIDE the data-card-toggle header, so
// matching it first is what makes a brief click navigate without toggling
// (and a count/chevron click toggle without navigating) — no stopPropagation
// gymnastics, the branch order is the guarantee.
document.getElementById('view-feed').addEventListener('click', function (e) {
  var chip = e.target.closest('[data-feed-chip]');
  if (chip) {
    var kind = chip.getAttribute('data-feed-chip'), val = chip.getAttribute('data-val') || null;
    feedFilters[kind] = val;
    feedFp = ''; loadFeed();
    return;
  }
  // Day-card checklist expander: reveal rows 5+ in place. The label swaps
  // immediately; catchupExpanded (keyed by the day-card key) makes the state
  // stick across the 5s poll repaint. Matched before data-day-open so the
  // footer control can never fall through to the header's navigation branch.
  var dayExpand = e.target.closest('[data-day-expand]');
  if (dayExpand) {
    var dayKey = dayExpand.getAttribute('data-day-expand');
    var dayArt = dayExpand.closest('article');
    var fold = dayArt && dayArt.querySelector('[data-day-more]');
    var foldOpen = fold && fold.style.display === 'none';
    if (fold) fold.style.display = foldOpen ? 'block' : 'none';
    catchupExpanded[dayKey] = !!foldOpen;
    dayExpand.innerHTML = foldOpen ? 'Show fewer &#9652;' : 'Show all ' + dayExpand.getAttribute('data-day-count') + ' changes &#9662;';
    return;
  }
  // Day-card header: drill to the day's session view (Level 2 of Activity).
  var dayOpen = e.target.closest('[data-day-open]');
  if (dayOpen) { location.hash = '#day=' + encodeURIComponent(dayOpen.getAttribute('data-day-open')); return; }
  var sess = e.target.closest('[data-sess-open]');
  if (sess) { location.hash = '#session=' + encodeURIComponent(sess.getAttribute('data-sess-open')); return; }
  // "show more": unclamp just this one prompt, in place, no navigation.
  var more = e.target.closest('[data-clamp-more]');
  if (more) {
    var clamped = more.previousElementSibling;
    if (clamped) clamped.style.webkitLineClamp = 'unset';
    more.style.display = 'none';
    return;
  }
  // Share/hide a session's prompt from the team. Matched before data-card-toggle
  // (with stopPropagation as a second guard) so a toggle click never also
  // expands/collapses the card underneath it.
  var shareEl = e.target.closest('[data-share-toggle]');
  if (shareEl) {
    e.stopPropagation();
    if (shareEl.getAttribute('data-busy') === '1') return;
    shareEl.setAttribute('data-busy', '1');
    var makeShared = shareEl.getAttribute('data-share-on') !== '1';
    fetch('/api/share-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: shareEl.getAttribute('data-share-project'), session: shareEl.getAttribute('data-share-session'), share: makeShared }),
    }).then(function (r) { return r.json(); })
      .then(function (b) {
        // The server persists the flag only if the backend accepted the change.
        // A rejection is share-specific: surface it inline, never via the pill.
        if (b && b.ok === false) { shareFailUI(shareEl); return; }
        feedFp = ''; loadFeed(); // re-fetch the feed so the toggle + prompt visibility refresh
      })
      .catch(function () { shareFailUI(shareEl); });
    return;
  }
  var cardToggle = e.target.closest('[data-card-toggle]');
  if (cardToggle) {
    var key = cardToggle.getAttribute('data-card-toggle');
    var det = cardToggle.nextElementSibling;
    var nowOpen = det && det.style.display === 'none';
    if (det) det.style.display = nowOpen ? 'block' : 'none';
    catchupExpanded[key] = !!nowOpen;
    var spans = cardToggle.getElementsByTagName('span');
    var chev = spans[spans.length - 1];
    if (chev) chev.style.transform = nowOpen ? 'rotate(180deg)' : 'none';
    if (nowOpen && det) markClamped(det); // clamp overflow is only measurable once visible
    return;
  }
});
// The Person/Project dropdowns mirror the chip clicks: '' = All = null, same
// feedFilters state, same reload. Delegated so it survives every rebuild.
document.getElementById('view-feed').addEventListener('change', function (e) {
  var sel = e.target.closest('[data-feed-select]');
  if (sel) { feedFilters[sel.getAttribute('data-feed-select')] = sel.value || null; feedFp = ''; loadFeed(); }
});
// Foot-of-card "Collapse": one document-level listener collapses whichever card
// the control sits in, in any view. It mirrors the header toggle — hides the
// body, clears catchupExpanded, resets the header chevron — then scrolls the
// header into view so a long card doesn't leave you stranded mid-page.
document.addEventListener('click', function (e) {
  var close = e.target.closest('[data-card-close]');
  if (!close) return;
  var key = close.getAttribute('data-card-close');
  var art = close.closest('article');
  var tog = art && art.querySelector('[data-card-toggle]');
  var det = tog && tog.nextElementSibling;
  if (det) det.style.display = 'none';
  catchupExpanded[key] = false;
  if (tog) {
    var sp = tog.getElementsByTagName('span');
    var cv = sp[sp.length - 1];
    if (cv) cv.style.transform = 'none';
    if (tog.scrollIntoView) tog.scrollIntoView({ block: 'nearest' });
  }
});

/* ===================== The session page (#session=<thread key>) =============
   Level 2 of Activity, the way the project page is level 2 of Projects. The
   session is RECONSTRUCTED from the current feed by thread key — no new
   endpoint — so a deep link to a session that has scrolled out of the recent
   window degrades to a friendly not-found state, never a crash. Poll cadence
   matches the feed (5s) so an in-progress session grows in place. */
var sessTimer = null, sessFp = '';
function startSession() { sessFp = ''; loadSession(); sessTimer = setInterval(loadSession, 5000); }
function stopSession() { if (sessTimer) { clearInterval(sessTimer); sessTimer = null; } }
function loadSession() {
  var host = document.getElementById('sessionRoot'); if (!host) return;
  // Unfiltered fetch: a deep link must resolve regardless of active feed filters.
  fetch('/api/feed?limit=100').then(function (r) { return r.json(); }).then(function (f) {
    setPill(true);
    var entries = (f && f.entries) || [];
    var offline = !!(f && f.teamUnavailable);
    renderSyncBanner(offline);
    var key = currentSessionKey();
    var threads = buildThreads(entries);
    var t = null;
    for (var i = 0; i < threads.length; i++) if (threads[i].key === key) { t = threads[i]; break; }
    // Subagents = the OTHER runs in the same work unit as the clicked run,
    // oldest-first so agent numbering is chronological and stable.
    var subs = [];
    if (t) {
      var units = buildUnits(threads);
      for (var j = 0; j < units.length && !subs.length; j++) {
        for (var r = 0; r < units[j].runs.length; r++) {
          if (units[j].runs[r].key === key) {
            subs = units[j].runs.filter(function (x) { return x.key !== key; });
            break;
          }
        }
      }
      subs.sort(function (a, b) {
        return String(a.entries[a.entries.length - 1].ts).localeCompare(String(b.entries[b.entries.length - 1].ts));
      });
    }
    // Serializing the whole thread AND its sibling runs covers prompt count,
    // summary arrival, and a subagent spawning mid-poll — any of them lands
    // in place on the next tick. Liveness rides in the fingerprint too: it is
    // a wall-clock claim (STALE_GAP), so a session can cross to stale with no
    // new entries, and the badge must repaint to finished on that tick.
    var live = !!t && (Date.now() - (Date.parse(t.ts) || 0)) < STALE_GAP;
    var fp = JSON.stringify({ k: key, t: t && t.entries, s: subs.map(function (x) { return x.entries; }), off: offline, live: live });
    if (fp === sessFp && host.firstChild) { refreshAgo('view-session'); return; }
    sessFp = fp;
    host.innerHTML = sessionPageHtml(t, subs);
  }).catch(function () { setPill(false); });
}
// Bordered back control — same button family as the project-detail back button.
var SESS_BACK = '<button data-sess-back title="Back to Activity" style="display:inline-flex;align-items:center;gap:7px;width:auto;height:34px;padding:0 14px;margin-bottom:18px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text2);font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;box-shadow:none;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text);box-shadow:var(--shadow-md)">' +
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M15 18l-6-6 6-6"/></svg>Activity</button>';
// Attribute sibling subagent runs to the main session's prompts by TIMING: a
// subagent belongs under the latest main prompt whose ts is at or before the
// subagent's earliest ts (so the window is [P.ts, nextPrompt.ts), the last
// prompt catches everything after it, and a run starting before the first
// prompt attaches to it — the nearest-earlier rule). Pure: prompts are
// oldest→newest entries, subRuns are thread objects; returns one bucket array
// per prompt.
function attributeSubagents(prompts, subRuns) {
  var buckets = prompts.map(function () { return []; });
  if (!prompts.length) return buckets;
  (subRuns || []).forEach(function (r) {
    var start = String(r.entries[r.entries.length - 1].ts);
    var idx = 0;
    for (var i = 0; i < prompts.length; i++) {
      if (String(prompts[i].ts) <= start) idx = i; else break;
    }
    buckets[idx].push(r);
  });
  return buckets;
}
// One-line label for a subagent run: distilled headline/summary via the same
// runHeadline picker as the card headlines (never harvested prose), else what
// it touched. Never a prompt list — the detail lives on that run's page.
function subagentLine(r) {
  if (r.rep) return runHeadline(r.rep, null, false);
  var seen = {}, files = [];
  r.entries.forEach(function (e) { (e.files || []).forEach(function (f) { if (!seen[f]) { seen[f] = 1; files.push(f); } }); });
  return files.length
    ? 'worked on ' + esc(files.slice(0, 2).join(', ')) + (files.length > 2 ? ' +' + (files.length - 2) : '')
    : '<span style="color:var(--text3)">no summary</span>';
}
// Pure string builder (also exercised by the fixture checks): the FULL
// unclipped brief as the page header (this is the detail view — summaryFull
// when the entry carries it, the clipped summary otherwise) with the
// "working now" badge while LIVE (activity within STALE_GAP — the feed's
// time rule, never the no-summary rule), author · tool · project · started
// meta, the numbered prompt timeline oldest→newest with a collapsed
// per-prompt subagent dropdown (siblings from the same work unit, attributed
// by timing), a files section only when the entries carry files, and a
// "working…" tail only while live.
function sessionPageHtml(t, subs) {
  var openMain = '<main style="max-width:780px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">';
  if (!t) {
    return openMain + SESS_BACK +
      '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:10px">Session</div>' +
      '<div class="empty">This session isn&rsquo;t in the current feed &mdash; it may have scrolled past the recent window. Head back to Activity to see what&rsquo;s live.</div>' +
      '</main>';
  }
  subs = subs || [];
  var newest = t.entries[0], oldest = t.entries[t.entries.length - 1];
  var who = newest.self ? 'You' : (newest.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(newest.authorId || 'you');
  var initial = esc((who[0] || '?').toUpperCase());
  // "Live" is the feed renderers' TIME claim (activity within STALE_GAP),
  // never the old no-summary claim — a finished-but-undistilled session must
  // render finished here exactly as its feed card does. Same three-way
  // headline as threadHtml: distilled brief; else, if live, the amber
  // "Working on:"; else harvested summary → the ask → "session ended".
  // NOTE (specs/2026-07-20-activity-display-headline, Task 3): unlike the
  // clamped feed cards, this detail-page header is intentionally NOT routed
  // through runHeadline — it is covered by an existing, separate test
  // ("session page liveness…") that asserts this exact repHarvested fallback
  // stays in place, so it is left as-is rather than banning harvested prose
  // here too.
  var live = (Date.now() - (Date.parse(t.ts) || 0)) < STALE_GAP;
  var liveBadge = live
    ? '<span style="display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:99px;background:var(--amber-soft);color:var(--amber);font-weight:600;font-size:11px"><span style="width:6px;height:6px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite"></span>working now</span>'
    : '';
  var headline = t.rep
    ? esc(t.rep.summaryFull || t.rep.summary)
    : live
      ? '<span style="color:var(--amber)">Working on:&nbsp;</span>' + (newest.ask ? esc(newest.ask) : '<span style="color:var(--text3)">' + (newest.self ? '(no prompt captured)' : '(prompt not shared)') + '</span>')
      : (t.repHarvested ? esc(t.repHarvested.summaryFull || t.repHarvested.summary)
        : newest.ask ? esc(newest.ask)
        : '<span style="color:var(--text3)">session ended · no summary shared</span>');
  // Triad (Intent / decisions·gotchas), same fields as feedEntryHtml/threadHtml,
  // sourced from the session's representative entry (t.rep).
  var intentHtml = (t.rep && t.rep.goal) ? '<div class="fmeta-row"><span class="flabel">Intent</span>' + esc(t.rep.goal) + '</div>' : '';
  var subHtml = (t.rep && (t.rep.decisions || t.rep.gotchas))
    ? '<div class="fsub">' + esc([t.rep.decisions, t.rep.gotchas].filter(Boolean).join(' · ')) + '</div>'
    : '';
  var head =
    '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">' +
      '<span style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3)">Session</span>' + liveBadge +
    '</div>' +
    '<h1 style="margin:0 0 16px;font-family:Calistoga,Georgia,serif;font-size:30px;font-weight:400;letter-spacing:-0.02em;line-height:1.2;text-wrap:pretty">' + headline + '</h1>' +
    intentHtml + subHtml +
    '<div style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--text3);flex-wrap:wrap;padding-bottom:22px;border-bottom:1px solid var(--border);margin-top:' + ((intentHtml || subHtml) ? '12px' : '0') + '">' +
      '<span style="width:24px;height:24px;border-radius:8px;background:' + color + ';color:#fff;font-size:10.5px;font-weight:600;display:inline-flex;align-items:center;justify-content:center;box-shadow:var(--shadow-md)">' + initial + '</span>' +
      '<span style="color:var(--text2);font-weight:500">' + esc(who) + '</span>' +
      (newest.source ? '<span style="padding:2px 9px;border-radius:99px;border:1px solid var(--border);' + MONO + ';font-size:10px;letter-spacing:.04em;color:var(--text2)">' + esc(newest.source) + '</span>' : '') +
      (newest.project ? '<span style="' + MONO + ';font-size:10.5px;color:var(--text3)">' + esc(newest.project) + '</span>' : '') +
      '<span>started <span data-ago="' + esc(oldest.ts) + '">' + esc(ago(oldest.ts)) + '</span></span>' +
    '</div>';
  // Full timeline, oldest→newest, untruncated; null asks stay "(prompt not
  // shared)" — redaction already happened server-side. Each prompt is a thread
  // line; subagent runs spawned by it (attributed by timing) sit under it in a
  // COLLAPSED dropdown, one line per agent, numbered chronologically across
  // the unit. The nested left border stays var(--border), same as the prompt
  // threads — a subagent list is structure, not an alert.
  var prompts = t.entries.slice().reverse();
  var buckets = attributeSubagents(prompts, subs);
  var rows = prompts.map(function (e, i) {
    var row = '<div style="display:flex;gap:12px;padding:10px 0;align-items:baseline">' +
      '<span style="' + MONO + ';font-size:10.5px;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:500;flex:none">' + String(i + 1).padStart(2, '0') + '</span>' +
      '<div style="flex:1;min-width:0;font-size:13.5px;line-height:1.65;' + (e.ask ? 'color:var(--text2);font-style:italic' : 'color:var(--text3)') + '">' +
        promptCellText(e) + '</div>' +
      '<span style="font-size:11.5px;color:var(--text3);white-space:nowrap;flex:none" data-ago="' + esc(e.ts) + '">' + esc(ago(e.ts)) + '</span>' +
    '</div>';
    var bucket = buckets[i];
    if (bucket.length) {
      var lines = bucket.map(function (r) {
        return '<div style="padding:5px 0;font-size:12.5px;color:var(--text2);line-height:1.5">' +
          '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3)">Agent ' + (subs.indexOf(r) + 1) + '</span>' +
          ' <span style="color:var(--border2)">&mdash;</span> ' + subagentLine(r) +
        '</div>';
      }).join('');
      row += '<div data-subagents="p' + i + '" style="display:inline-flex;align-items:center;gap:6px;margin:-4px 0 6px 27px;font-size:11.5px;color:var(--text2);font-weight:600;cursor:pointer">' +
          '<span data-chev style="font-size:9px;color:var(--text3)">&#9656;</span>' + bucket.length + ' subagent' + (bucket.length === 1 ? '' : 's') + '</div>' +
        '<div style="display:none;margin:0 0 10px 27px;padding-left:14px;border-left:2px solid var(--border)">' + lines + '</div>';
    }
    return row;
  }).join('');
  var tail = live
    ? '<div style="display:flex;gap:12px;padding:10px 0;align-items:center;color:var(--amber);font-size:12.5px;font-weight:600">' +
        '<span style="width:6px;height:6px;border-radius:50%;background:var(--amber);animation:mbPulse 2s ease infinite;flex:none;margin-left:3px"></span>working&hellip;</div>'
    : '';
  var timeline =
    '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin:26px 0 6px">Prompts &middot; ' + t.entries.length + '</div>' +
    '<div style="margin-left:2px;padding-left:18px;border-left:2px solid var(--border)">' + rows + tail + '</div>';
  // Files: the union across the session's entries; omitted when none carry any.
  var seenF = {}, files = [];
  t.entries.forEach(function (e) { (e.files || []).forEach(function (f) { if (!seenF[f]) { seenF[f] = 1; files.push(f); } }); });
  var filesHtml = files.length
    ? '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin:30px 0 10px">Files touched</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px">' + files.map(function (f) {
        return '<span style="' + MONO + ';font-size:10.5px;padding:4px 9px;border-radius:8px;background:var(--surface2);color:var(--text2)">' + esc(f) + '</span>';
      }).join('') + '</div>'
    : '';
  // Changes: union across the session's entries, de-duped by file (first wins,
  // same convention as the files union above). Mirrors feedEntryHtml's
  // changes-vs-files fallback — Changes takes priority, Files touched is the
  // fallback when no entry in the session carries a changes list.
  var seenC = {}, changesUnion = [];
  t.entries.forEach(function (e) {
    (Array.isArray(e.changes) ? e.changes : []).forEach(function (c) {
      if (c && c.file && !seenC[c.file]) { seenC[c.file] = 1; changesUnion.push(c); }
    });
  });
  var changesSectionHtml = changesUnion.length
    ? '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin:30px 0 10px">Changes</div>' + changesHtml(changesUnion)
    : filesHtml;
  return openMain + SESS_BACK + head + timeline + changesSectionHtml + '</main>';
}
// Back to Activity + per-prompt subagent dropdowns; delegated so both survive
// the 5s re-render. The dropdown toggles the DOM directly (toggle + its next
// sibling): no persisted open-set — a data-changing poll re-renders collapsed,
// while a quiet poll is fingerprint-skipped and leaves open dropdowns alone.
document.getElementById('view-session').addEventListener('click', function (e) {
  if (e.target.closest('[data-sess-back]')) { location.hash = '#everything'; return; }
  var tog = e.target.closest('[data-subagents]');
  if (tog) {
    var body = tog.nextElementSibling;
    var nowOpen = body && body.style.display === 'none';
    if (body) body.style.display = nowOpen ? 'block' : 'none';
    var chev = tog.querySelector('[data-chev]');
    if (chev) chev.innerHTML = nowOpen ? '&#9662;' : '&#9656;';
  }
});

/* ===================== The day view (#day=<day-card key>) ===================
   Level 2 of Activity for a whole author-day (specs/2026-07-20-activity-day-
   cards-v2-design.md): reconstructed from the current feed by day-card key —
   no new endpoint — so a deep link to a day that has scrolled out of the
   recent window degrades to a friendly not-found state, never a crash. Poll
   cadence matches the feed (5s) so a live day grows in place. */
var dayTimer = null, dayFp = '';
function startDay() {
  dayFp = '';
  // FIX 2: paint the loading state synchronously on navigation, BEFORE the
  // first fetch resolves — so a slow load shows the spinner and a stale
  // not-found from a prior visit can never linger. loadDay replaces it with the
  // real card (or a genuine not-found) once the fetch settles.
  var host = document.getElementById('dayRoot');
  if (host) host.innerHTML = dayDetailHtml(null, { loading: true });
  loadDay();
  dayTimer = setInterval(loadDay, 5000);
}
function stopDay() { if (dayTimer) { clearInterval(dayTimer); dayTimer = null; } }
function loadDay() {
  var host = document.getElementById('dayRoot'); if (!host) return;
  // Unfiltered fetch: a deep link must resolve regardless of active feed filters.
  fetch('/api/feed?limit=100').then(function (r) { return r.json(); }).then(function (f) {
    setPill(true);
    var entries = (f && f.entries) || [];
    var offline = !!(f && f.teamUnavailable);
    renderSyncBanner(offline);
    var key = currentDayKey();
    var cards = buildDayCards(buildUnits(buildThreads(entries)));
    var card = null;
    for (var i = 0; i < cards.length; i++) if (cards[i].key === key) { card = cards[i]; break; }
    // Fingerprint mirrors loadSession: serialize enough of the card's units
    // (liveness included — it is a wall-clock claim that can flip with no new
    // entries) that prompt arrival, summary arrival, and live→stale all
    // repaint in place, while a quiet poll skips the repaint and leaves open
    // prompt folds alone.
    var fp = JSON.stringify({ k: key, off: offline, live: !!(card && card.live), u: card && card.units.map(function (u) {
      var newest = u.runs[0] && u.runs[0].entries[0];
      // Include the newest entry's shared flag so flipping the per-session share
      // toggle repaints the button (its prompt text is local and never changes).
      return [u.key, u.live, u.promptCount, u.rep && u.rep.rep && (u.rep.rep.summaryFull || u.rep.rep.summary), newest && !!newest.shared];
    }) });
    if (fp === dayFp && host.firstChild) { refreshAgo('view-day'); return; }
    dayFp = fp;
    host.innerHTML = dayDetailHtml(card);
  }).catch(function () { setPill(false); });
}
// Back to Activity + the per-session prompt folds; delegated so both survive
// the 5s re-render. Fold state mirrors the feed's day-card expander:
// catchupExpanded under 'prompts|'+unit key, so a data-changing repaint
// restores what was open.
document.getElementById('view-day').addEventListener('click', function (e) {
  if (e.target.closest('[data-day-back]')) { location.hash = '#everything'; return; }
  // Share/hide one of your own sessions' prompts from the team — same contract
  // as the feed's toggle (optimistic guard + POST + repaint), forced through the
  // day view's own fingerprint so the toggle state and prompt visibility refresh.
  var shareEl = e.target.closest('[data-share-toggle]');
  if (shareEl) {
    e.stopPropagation();
    if (shareEl.getAttribute('data-busy') === '1') return;
    shareEl.setAttribute('data-busy', '1');
    var makeShared = shareEl.getAttribute('data-share-on') !== '1';
    fetch('/api/share-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: shareEl.getAttribute('data-share-project'), session: shareEl.getAttribute('data-share-session'), share: makeShared }),
    }).then(function (r) { return r.json(); })
      .then(function (b) {
        // Share-specific rejection: inline on the toggle, never the pill.
        if (b && b.ok === false) { shareFailUI(shareEl); return; }
        dayFp = ''; loadDay(); // re-fetch so the toggle + prompt visibility refresh
      })
      .catch(function () { shareFailUI(shareEl); });
    return;
  }
  var tog = e.target.closest('[data-prompts-toggle]');
  if (tog) {
    var k = tog.getAttribute('data-prompts-toggle');
    var art = tog.closest('article');
    var fold = art && art.querySelector('[data-prompts-fold]');
    var opening = fold && fold.style.display === 'none';
    if (fold) fold.style.display = opening ? 'block' : 'none';
    catchupExpanded['prompts|' + k] = !!opening;
    var n = tog.getAttribute('data-prompts-count') || '0';
    tog.innerHTML = (opening ? '&#9652; hide ' : '&#9662; show ') + n + (n === '1' ? ' prompt' : ' prompts');
  }
});

/* ================= add / delete modals ================= */
var addOverlay = document.getElementById('addOverlay');
var addInput = document.getElementById('addPath');
var addErr = document.getElementById('addErr');
var addSubmit = document.getElementById('addSubmit');
function openAdd() {
  addInput.value = '';
  addErr.style.display = 'none';
  addOverlay.className = 'overlay open';
  addInput.focus();
}
function closeAdd() { addOverlay.className = 'overlay'; }
function submitAdd() {
  var p = addInput.value.trim();
  if (!p || addSubmit.disabled) return;
  addSubmit.disabled = true;
  fetch('/api/projects/add', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p }),
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, d: d }; });
  }).then(function (res) {
    addSubmit.disabled = false;
    if (res.ok) { closeAdd(); if (currentTab() === 'settings') loadSettings(); else loadHome(); return; } // added or already tracked
    addErr.textContent = res.d && res.d.error === 'not a directory'
      ? "That doesn't look like a folder on this Mac \\u2014 check the path and try again."
      : (res.d && res.d.error) || 'Something went wrong.';
    addErr.style.display = 'block';
  }).catch(function () { addSubmit.disabled = false; closeAdd(); setPill(false); });
}
// #addProject header button removed (Task 8); openAdd is re-wired from Settings in Task 16.
document.getElementById('addCancel').onclick = closeAdd;
addSubmit.onclick = submitAdd;
addInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAdd(); });
addOverlay.addEventListener('click', function (e) { if (e.target === addOverlay) closeAdd(); });

var delOverlay = document.getElementById('delOverlay');
var delConfirm = document.getElementById('delConfirm');
var delPath = null;
// Bulk variant of the same overlay: when set, delConfirm resolves every
// selected path through deleteProjectsBulk instead of the single delPath.
var delBulkPaths = null;
function openDel(p, name) {
  delPath = p;
  // textContent, never innerHTML: the project name is user data
  document.getElementById('delTitle').textContent = 'Remove ' + name + ' from MemBridge?';
  delOverlay.className = 'overlay open';
}
// Settings-only: multi-select bulk delete for local watched projects. Reuses
// the same confirm overlay as the single-project delete above.
function openBulkDel(paths) {
  delBulkPaths = paths;
  document.getElementById('delTitle').textContent = "Delete " + paths.length + " projects? This can't be undone.";
  delOverlay.className = 'overlay open';
}
function closeDel() { delOverlay.className = 'overlay'; delPath = null; delBulkPaths = null; }
document.getElementById('delCancel').onclick = closeDel;
delOverlay.addEventListener('click', function (e) { if (e.target === delOverlay) closeDel(); });
// Sequential, resilient delete: a failing path is recorded but never stops the
// loop, so one broken row cannot block the rest of the batch. A resolved but
// non-ok response (the server's top-level catch answers a throwing delete
// with an HTTP 500, which fetch RESOLVES on) counts as a failure too. Pure
// aside from the injected fetch-like dep — offline-testable, no DOM.
function deleteProjectsBulk(paths, fetchFn) {
  var deleted = [], failed = [];
  var i = 0;
  function next() {
    if (i >= paths.length) return Promise.resolve({ deleted: deleted, failed: failed });
    var p = paths[i++];
    return fetchFn('/api/projects/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p }),
    }).then(function (r) { (r && r.ok ? deleted : failed).push(p); return next(); })
      .catch(function () { failed.push(p); return next(); });
  }
  return next();
}
delConfirm.onclick = function () {
  if (delConfirm.disabled) return;
  if (delBulkPaths) {
    var paths = delBulkPaths;
    if (!paths.length) { closeDel(); return; }
    delConfirm.disabled = true;
    deleteProjectsBulk(paths, fetch).then(function (result) {
      delConfirm.disabled = false;
      closeDel();
      if (result.failed.length) {
        // Names when we still have them (stProjects is about to be refetched),
        // falling back to the raw path so a notice never renders blank.
        var names = result.failed.map(function (fp) {
          var hit = null;
          for (var j = 0; j < stProjects.length; j++) { if (stProjects[j].path === fp) { hit = stProjects[j]; break; } }
          return hit ? hit.name : fp;
        });
        stBulkNotice = "Couldn't delete: " + names.join(', ');
      }
      if (currentTab() === 'settings') loadSettings(); else loadHome();
    }).catch(function () { delConfirm.disabled = false; closeDel(); setPill(false); });
    return;
  }
  if (!delPath) return;
  delConfirm.disabled = true;
  fetch('/api/projects/delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: delPath }),
  }).then(function () {
    delConfirm.disabled = false;
    closeDel();
    // Deleting from inside the project page: the page is gone, go home.
    if (currentTab() === 'project') location.hash = '#home';
    else if (currentTab() === 'settings') loadSettings();
    else loadHome();
  }).catch(function () { delConfirm.disabled = false; closeDel(); setPill(false); });
};

var removeOverlay = document.getElementById('removeOverlay');
var removeConfirm = document.getElementById('removeConfirm');
var removePath = null;
function openRemove(p, name) {
  removePath = p;
  // textContent, never innerHTML: the project name is user data
  document.getElementById('removeTitle').textContent = 'Remove memory block from ' + name + '?';
  removeOverlay.className = 'overlay open';
}
function closeRemove() { removeOverlay.className = 'overlay'; removePath = null; }
document.getElementById('removeCancel').onclick = closeRemove;
removeOverlay.addEventListener('click', function (e) { if (e.target === removeOverlay) closeRemove(); });
removeConfirm.onclick = function () {
  if (!removePath || removeConfirm.disabled) return;
  removeConfirm.disabled = true;
  fetch('/api/projects/remove', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: removePath }),
  }).then(function () {
    removeConfirm.disabled = false;
    closeRemove();
    loadProject();
  }).catch(function () { removeConfirm.disabled = false; closeRemove(); setPill(false); });
};
/* ================= scan / discovery modal ================= */
var scanOverlay = document.getElementById('scanOverlay');
var scanBody = document.getElementById('scanBody');
function renderScan(d) {
  // Known tools registry: even unconfigured tools show a greyed "—" row so the
  // list reads as coverage, not gaps. Display-only — ingestion is unchanged.
  var KNOWN_TOOLS = ['Claude Code', 'Codex', 'Cursor'];
  var seen = {};
  var adapterRows = d.adapters.map(function (a) {
    seen[a.displayName] = true;
    return '<div class="scan-row"><span class="tool">' + esc(a.displayName) + '</span>' +
      '<span class="root">' + esc(a.root) + '</span>' +
      (a.exists ? '' : '<span class="missing">(not found)</span>') + '</div>';
  }).join('');
  adapterRows += KNOWN_TOOLS.filter(function (t) { return !seen[t]; }).map(function (t) {
    return '<div class="scan-row"><span class="tool">' + esc(t) + '</span>' +
      '<span class="root" style="color:var(--text3)">&mdash;</span>' +
      '<span class="missing" style="color:var(--text3)">(not configured)</span></div>';
  }).join('');
  if (!adapterRows) adapterRows = '<div class="scan-row"><span class="root">No adapters configured.</span></div>';
  var projectRows = d.projects.map(function (p) {
    var parts = Object.keys(p.bySource).map(function (s) { return s + ': ' + p.bySource[s]; }).join(', ');
    return '<div class="scan-proj"><div class="name">' + esc(p.name) +
      (p.paused ? ' <span class="paused">[paused]</span>' : '') + '</div>' +
      '<div class="sources">' + esc(parts) + '</div></div>';
  }).join('') || '<div class="scan-proj"><div class="sources">No projects with AI activity yet.</div></div>';
  scanBody.innerHTML =
    '<div class="scan-group"><h4>Adapters</h4>' + adapterRows + '</div>' +
    '<div class="scan-group"><h4>Projects with AI activity: ' + d.projectCount + '</h4>' + projectRows + '</div>';
}
function openScan() {
  scanOverlay.className = 'overlay open';
  scanBody.innerHTML = '<div class="empty">Scanning&hellip;</div>';
  fetch('/api/scan').then(function (r) { return r.json(); }).then(renderScan)
    .catch(function () { scanBody.innerHTML = '<div class="empty">Scan failed.</div>'; });
}
function closeScan() { scanOverlay.className = 'overlay'; }
// #openScan header button removed (Task 8); openScan is re-wired from Settings in Task 16.
document.getElementById('scanClose').onclick = closeScan;
scanOverlay.addEventListener('click', function (e) { if (e.target === scanOverlay) closeScan(); });

// Reusable replacement for window.prompt: Electron's BrowserWindow does not
// implement window.prompt/confirm/alert (window.prompt silently returns null,
// so the three team handlers below used to do nothing). Joins the same
// overlay + Escape idiom as add/del/remove/scan above.
var promptOverlay = document.getElementById('promptOverlay');
var promptTitleEl = document.getElementById('promptTitle');
var promptLabelEl = document.getElementById('promptLabel');
var promptInput = document.getElementById('promptInput');
var promptConfirmBtn = document.getElementById('promptConfirm');
var promptOnConfirm = null;
function openPrompt(opts) {
  opts = opts || {};
  promptTitleEl.textContent = opts.title || '';
  promptLabelEl.textContent = opts.label || '';
  promptInput.value = opts.initial || '';
  promptOnConfirm = typeof opts.onConfirm === 'function' ? opts.onConfirm : null;
  promptOverlay.className = 'overlay open';
  promptInput.focus();
  promptInput.select();
}
function closePrompt() { promptOverlay.className = 'overlay'; promptOnConfirm = null; }
function submitPrompt() {
  var v = promptInput.value.trim();
  var cb = promptOnConfirm;
  closePrompt();
  if (v && cb) cb(v); // trimmed; cancel/empty runs no callback, same as the old null-check behavior
}
promptConfirmBtn.onclick = submitPrompt;
document.getElementById('promptCancel').onclick = closePrompt;
promptInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPrompt(); });
promptOverlay.addEventListener('click', function (e) { if (e.target === promptOverlay) closePrompt(); });

window.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var hadModal = addOverlay.className.indexOf('open') !== -1 || delOverlay.className.indexOf('open') !== -1 ||
    removeOverlay.className.indexOf('open') !== -1 || scanOverlay.className.indexOf('open') !== -1 ||
    promptOverlay.className.indexOf('open') !== -1;
  closeAdd();
  closeDel();
  closeRemove();
  closeScan();
  closePrompt();
  // Esc backs out of a project page or Settings, but only once modals are dealt with.
  if (hadModal) return;
  // An open ⋯ project menu is next in the chain, before view navigation.
  if (pxMenuId || pxConfirmId) { pxMenuId = null; pxConfirmId = null; renderProjectsIndex(); return; }
  if (currentTab() === 'session') { location.hash = '#everything'; return; } // level 2 of Activity
  if (currentTab() === 'project' || currentTab() === 'settings') location.hash = '#home';
});

/* ================= copy for AI ================= */
// The manual bridge to web AIs: put a trimmed, already-redacted digest of one
// project on the clipboard, ready to paste into ChatGPT / claude.ai / any chat.
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(function () { return copyTextFallback(text); });
  }
  return Promise.resolve().then(function () { return copyTextFallback(text); });
}
function copyTextFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (err) {}
  document.body.removeChild(ta);
  if (!ok) throw new Error('clipboard unavailable');
}
function copyForAI(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  fetch('/api/projects/copy', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: btn.dataset.path }),
  }).then(function (r) {
    if (!r.ok) throw new Error('copy ' + r.status);
    return r.json();
  }).then(function (d) { return copyText(d.text); })
    .then(function () { copyDone(btn, 'Copied \\u2014 paste into ChatGPT / any AI'); })
    .catch(function () { copyDone(btn, 'Copy failed'); });
}
function copyDone(btn, label) {
  btn.disabled = false;
  btn.textContent = label;
  setTimeout(function () { btn.textContent = 'Copy for AI'; }, 2600);
}

${teamJs}

/* ================= settings ================= */
// Settings loads once (no polling — a poll would clobber the API-key field
// while typing). The template's Settings <main> is rebuilt from four live
// sources: /api/team (+ members), /api/projects, /api/settings, /api/scan.
var stTeam = null, stMembers = [], stProjects = [], stSettings = null, stScan = null;
// Set right before a bulk delete's post-refresh loadSettings() re-render;
// settingsProjectsSection() reads it once and clears it, so it surfaces the
// failure notice on the very next render and never lingers after that.
var stBulkNotice = null;
var MONO ='font-family:\\'JetBrains Mono\\',monospace';
var STLABEL = MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:8px';
var STCARD = 'border:1px solid var(--border);border-radius:16px;background:var(--card);overflow:hidden;box-shadow:var(--shadow-md)';

function loadSettings() {
  var host = document.getElementById('settingsRoot');
  if (!host) return;
  if (!host.innerHTML) {
    host.innerHTML = '<main style="max-width:660px;margin:0 auto;padding:48px 28px 110px"><div class="empty">Loading&hellip;</div></main>';
  }
  fetch('/api/team').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (t) {
    stTeam = t;
    teamState = t;
    var tid = pickTeamId(t);
    var membersP = (t && t.authenticated && tid)
      ? apiGet('/api/team/members?teamId=' + encodeURIComponent(tid)).catch(function () { return { members: [] }; })
      : Promise.resolve({ members: [] });
    return Promise.all([
      membersP,
      fetch('/api/projects').then(function (r) { return r.json(); }).catch(function () { return []; }),
      fetch('/api/settings').then(function (r) { return r.json(); }).catch(function () { return null; }),
      fetch('/api/scan').then(function (r) { return r.json(); }).catch(function () { return null; }),
    ]);
  }).then(function (res) {
    if (!res || currentTab() !== 'settings') return; // navigated away mid-fetch
    setPill(true);
    stMembers = (res[0] && res[0].members) || [];
    stProjects = res[1] || [];
    stSettings = res[2];
    stScan = res[3];
    hubMembers = stMembers; // keep the team module's view in sync
    renderSettingsView();
  }).catch(function () { setPill(false); });
}

// Which team is selected: the remembered id if it still exists, else the first.
function pickTeamId(t) {
  var teams = (t && t.teams) || [];
  if (!teams.length) return '';
  for (var i = 0; i < teams.length; i++) if (teams[i].team_id === teamSelId) return teams[i].team_id;
  rememberTeam(teams[0].team_id);
  return teams[0].team_id;
}
function pickTeam(t) {
  var teams = (t && t.teams) || [];
  for (var i = 0; i < teams.length; i++) if (teams[i].team_id === teamSelId) return teams[i];
  return teams[0] || null;
}

// renderTeamSettings keeps its old name: the team module calls it after every
// mutation (renderTeam / renderCurrent). It refreshes the whole Settings surface.
function renderTeamSettings(d) {
  teamState = d; stTeam = d;
  if (currentTab() !== 'settings') return;
  loadSettings();
}

function renderSettingsView() {
  var host = document.getElementById('settingsRoot');
  if (!host) return;
  host.innerHTML =
    '<main style="max-width:660px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">' +
    '<h1 style="margin:0 0 36px;font-family:Calistoga,Georgia,serif;font-size:36px;font-weight:400;letter-spacing:-0.02em">Settings</h1>' +
    settingsProjectsSection() +
    settingsTeamSection() +
    settingsAccountSection() +
    '</main>';
}

// v3: team management (members, roles, invites, rename, leave, switch) lives on
// the dedicated Team screen. Settings shows a compact card that links there.
function settingsTeamSection() {
  var lbl = '<div style="' + STLABEL + '">Team</div>';
  var card = 'border:1px solid var(--border);border-radius:16px;background:var(--card);margin-bottom:34px;padding:14px 18px;display:flex;align-items:center;gap:13px;box-shadow:var(--shadow-md)';
  var btn = 'height:34px;padding:0 13px;border-radius:10px;border:1px solid var(--accent-brd);background:var(--accent-soft);color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s';
  var t = stTeam;
  var team = (t && t.authenticated) ? pickTeam(t) : null;
  if (!team) {
    return lbl + '<div style="' + card + '">' +
      '<div style="flex:1"><div style="font-size:13.5px;font-weight:600">No team yet</div>' +
      '<div style="font-size:12px;color:var(--text3)">Create or join a team on the Team screen to share memory.</div></div>' +
      '<button data-go-team style="' + btn + '" style-hover="box-shadow:var(--shadow-accent)">Manage team &rarr;</button></div>';
  }
  var count = (typeof team.memberCount === 'number' && team.memberCount) ? team.memberCount : stMembers.length;
  var memberCountLabel = count + ' member' + (count === 1 ? '' : 's');
  return lbl + '<div style="' + card + '">' +
    '<div style="flex:1"><div style="font-size:13.5px;font-weight:600">' + esc(team.team_name) + '</div>' +
    '<div style="font-size:12px;color:var(--text3)">' + memberCountLabel + ' &middot; roles, invites and renaming live on the Team screen</div></div>' +
    '<button data-go-team style="' + btn + '" style-hover="box-shadow:var(--shadow-accent)">Manage team &rarr;</button></div>';
}

function settingsProjectsSection() {
  var lbl = '<div style="' + STLABEL + '">Watched projects</div>';
  var localCount = 0;
  var rows = stProjects.map(function (p) {
    var badge = p.team ? 'shared' : 'local only';
    var pauseLabel = p.paused ? 'Resume' : 'Pause';
    // Bulk delete is local-only (sidesteps the shared archive/unlink gating),
    // so the checkbox — same field the local-vs-shared badge above uses —
    // only ever appears on a row where !p.team.
    var isLocal = !p.team;
    if (isLocal) localCount++;
    var check = isLocal
      ? '<input type="checkbox" data-bulk-check="' + esc(p.path) + '" style="width:15px;height:15px;flex:none;cursor:pointer" />'
      : '<span style="width:15px;flex:none"></span>';
    return '<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border)">' +
      check +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13.5px;font-weight:600">' + esc(p.name) + ' <span style="' + MONO + ';font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);font-weight:400">' + esc(badge) + '</span></div>' +
        '<div style="' + MONO + ';font-size:10.5px;color:var(--text3);margin-top:3px">' + esc(p.path) + (p.exists === false ? ' &middot; missing' : '') + '</div></div>' +
      '<span data-proj-toggle="' + esc(p.path) + '" style="font-size:12px;color:var(--text2);cursor:pointer;font-weight:500;transition:color .2s" style-hover="color:var(--text)">' + pauseLabel + '</span>' +
      '<span data-proj-del="' + esc(p.path) + '" data-name="' + esc(p.name) + '" style="font-size:12px;color:var(--text3);cursor:pointer;transition:color .2s" style-hover="color:#DC2626">Delete</span></div>';
  }).join('');
  if (!rows) {
    rows = '<div style="padding:14px 18px;font-size:12.5px;color:var(--text3);border-bottom:1px solid var(--border)">No projects watched yet. Add one below, or use an AI tool in a folder and it appears after the next sync.</div>';
  }
  // A pending bulk-delete failure notice (set right before the post-delete
  // refresh) is read once here and cleared, so it shows on this render only.
  var notice = '';
  if (stBulkNotice) { notice = '<div class="notice error" style="margin-bottom:10px">' + esc(stBulkNotice) + '</div>'; stBulkNotice = null; }
  // "Select all local" + "Delete selected" only make sense with >=1 local row.
  var bulkBar = localCount > 0
    ? '<div style="display:flex;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid var(--border)">' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--text2);cursor:pointer;user-select:none">' +
          '<input type="checkbox" data-bulk-selectall style="width:15px;height:15px;cursor:pointer" />Select all local</label>' +
        '<div style="flex:1"></div>' +
        '<span data-bulk-delete style="display:none;font-size:12px;color:#DC2626;cursor:pointer;font-weight:600;transition:opacity .2s" style-hover="opacity:.7">Delete selected (<span data-bulk-count>0</span>)</span>' +
      '</div>'
    : '';
  var foot =
    '<div style="display:flex;align-items:center;gap:12px;padding:13px 18px">' +
      '<span data-st-add style="font-size:13px;color:var(--accent);cursor:pointer;font-weight:600">+ Add a project&hellip;</span>' +
      '<div style="flex:1"></div>' +
      '<span style="font-size:12px;color:var(--text3)">' + toolsDetectedLine() + '</span>' +
    '</div>';
  return lbl + notice + '<div style="' + STCARD + ';margin-bottom:34px">' + bulkBar + rows + foot + '</div>';
}
// Recomputes the "Delete selected (N)" affordance and the select-all checkbox
// state from the live DOM — called after every bulk-checkbox change so the
// count and visibility stay in sync without a full re-render.
function syncBulkUi() {
  var boxes = settingsRoot.querySelectorAll('[data-bulk-check]');
  var checked = settingsRoot.querySelectorAll('[data-bulk-check]:checked');
  var btn = settingsRoot.querySelector('[data-bulk-delete]');
  var countEl = settingsRoot.querySelector('[data-bulk-count]');
  if (countEl) countEl.textContent = String(checked.length);
  if (btn) btn.style.display = checked.length ? '' : 'none';
  var all = settingsRoot.querySelector('[data-bulk-selectall]');
  if (all) all.checked = boxes.length > 0 && checked.length === boxes.length;
}

// "Tools detected: Claude Code ✓ · Codex ✓ · Cursor —" from /api/scan against
// the known-tools registry: ✓ when an adapter exists, — when absent.
function toolsDetectedLine() {
  var KNOWN = ['Claude Code', 'Codex', 'Cursor'];
  var have = {};
  var adapters = (stScan && stScan.adapters) || [];
  for (var i = 0; i < adapters.length; i++) {
    if (adapters[i].exists) have[adapters[i].displayName] = true;
  }
  return 'Tools detected: ' + KNOWN.map(function (name) {
    return esc(name) + ' ' + (have[name] ? '&check;' : '&mdash;');
  }).join(' &middot; ');
}

function settingsAccountSection() {
  var t = stTeam;
  if (!t || !t.authenticated || !t.user) return '';
  var u = t.user;
  var lbl = '<div style="' + STLABEL + '">Account</div>';
  return lbl +
    '<div style="' + STCARD + ';padding:14px 18px;display:flex;align-items:center;gap:13px">' +
      '<div style="width:28px;height:28px;border-radius:10px;background:' + avColor(u.userId) + ';color:#fff;font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center">' + esc(((u.displayName || u.email || '?').charAt(0) || '?').toUpperCase()) + '</div>' +
      '<div style="flex:1"><div style="font-size:13.5px;font-weight:600">' + esc(u.email) + '</div><div style="font-size:12px;color:var(--text3)">Signed in via email</div></div>' +
      '<span data-team-action="logout" style="font-size:12.5px;color:var(--text2);cursor:pointer;font-weight:500;transition:color .2s" style-hover="color:var(--text)">Log out</span>' +
    '</div>';
}

// Settings-specific delegated handlers. Team actions (copy-invite, remove-member,
// leave, logout, set-role, switch) reuse the team module's handlers, also bound
// to settingsRoot below.
var settingsRoot = document.getElementById('settingsRoot');
if (settingsRoot) {
  settingsRoot.addEventListener('click', function (e) {
    if (e.target.closest('[data-go-team]')) { location.hash = '#team'; return; }
    if (e.target.closest('[data-st-add]')) { openAdd(); return; }
    var tog = e.target.closest('[data-proj-toggle]');
    if (tog) {
      if (!armed(tog)) return; // toggles server-side: guard against double-click revert
      tog.style.pointerEvents = 'none';
      fetch('/api/projects/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tog.getAttribute('data-proj-toggle') }),
      }).then(function () { loadSettings(); }).catch(function () { setPill(false); });
      return;
    }
    var del = e.target.closest('[data-proj-del]');
    if (del) { openDel(del.getAttribute('data-proj-del'), del.getAttribute('data-name') || del.getAttribute('data-proj-del')); return; }
    var bulkDel = e.target.closest('[data-bulk-delete]');
    if (bulkDel) {
      var chosen = Array.prototype.map.call(settingsRoot.querySelectorAll('[data-bulk-check]:checked'), function (el) {
        return el.getAttribute('data-bulk-check');
      });
      if (chosen.length) openBulkDel(chosen);
      return;
    }
  });
  // Bulk-select checkboxes: recompute the live count/visibility on every
  // toggle, and let "select all local" flip every per-row box at once.
  settingsRoot.addEventListener('change', function (e) {
    var all = e.target.closest('[data-bulk-selectall]');
    if (all) {
      var boxes = settingsRoot.querySelectorAll('[data-bulk-check]');
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = all.checked;
      syncBulkUi();
      return;
    }
    if (e.target.closest('[data-bulk-check]')) { syncBulkUi(); return; }
  });
  // Team management actions reuse the team module's delegated handlers.
  settingsRoot.addEventListener('click', handleTeamClick);
  settingsRoot.addEventListener('change', handleTeamChange);
  settingsRoot.addEventListener('submit', handleTeamSubmit);
}

/* ================= project page ================= */
var pjRoot = document.getElementById('pjRoot');
// pjFp gates rebuilds; pjEntries backs the deduped project stream + Load more;
// pjMenuOpen survives a no-op poll so an open ⋯ menu is not yanked shut.
var pjTimer = null, pjFp = '', pjEntries = [], pjMenuOpen = false, pjLastPath = null;
// Per-project Catch-Up state. Our read-state is GLOBAL (one lastViewedTs), so
// "new since" is computed against that single pointer and mark/undo advance it
// for every project — a known approximation (no per-project persistence).
var pjCatchupSince = null;
function startProject() {
  var path = currentProjPath();
  pjMenuOpen = false;
  // Re-entering the SAME project keeps its rendered stream on screen (loadProject's
  // fp-dedup then skips the rebuild) so there's no Loading… blank or flash. A
  // DIFFERENT project is genuinely different content, so blank and reload it.
  if (path !== pjLastPath) {
    pjFp = '';
    pjEntries = [];
    pjRoot.innerHTML = '<div class="empty">Loading&hellip;</div>';
  }
  pjLastPath = path;
  loadProject();
  pjTimer = setInterval(loadProject, 5000);
}
function stopProject() {
  if (pjTimer) { clearInterval(pjTimer); pjTimer = null; }
}
// Stream URL for the project: the value may be a local path OR a team uuid; the
// server matches both against projectPath and projectId.
function pjFeedUrl(value) {
  return '/api/feed?project=' + encodeURIComponent(value) + '&limit=50';
}
function loadProject() {
  var p = currentProjPath();
  if (!p) { renderProjectGone(); return; }
  var isLocal = p.charAt(0) === '/';
  var feedP = fetch(pjFeedUrl(p)).then(function (r) { return r.json(); });
  // Metadata (header extras + roadmap + admin) only exists for a local folder.
  var detailP = isLocal
    ? fetch('/api/project?path=' + encodeURIComponent(p)).then(function (r) {
        if (r.status === 404) return { gone: true };
        if (!r.ok) throw new Error('project ' + r.status);
        return r.json();
      })
    : Promise.resolve(null);
  // Per-project Catch-Up inputs: the GLOBAL read pointer + whether a key is set.
  var catchupP = fetch('/api/catchup').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
  var settingsP = fetch('/api/settings').then(function (r) { return r.ok ? r.json() : { hasKey: false }; }).catch(function () { return { hasKey: false }; });
  Promise.all([feedP, detailP, catchupP, settingsP]).then(function (res) {
    setPill(true);
    var feed = res[0] || {};
    var detail = res[1];
    var cu = res[2] || {};
    var settings = res[3] || {};
    if (isLocal && detail && detail.gone) { renderProjectGone(); return; }
    var offline = !!feed.teamUnavailable;
    pjCatchupSince = cu.lastViewedTs || null;
    // projNewSessions: teammate (self===false) sessions in THIS project since the
    // global pointer. Derived from the already-fetched project feed (which is
    // ?project=<p>) rather than a second ?since request — same result, one poll.
    var newSessions = (feed.entries || []).filter(function (e) {
      return e.self === false && pjCatchupSince && String(e.ts) > String(pjCatchupSince);
    });
    var cx = { cu: cu, hasKey: !!settings.hasKey, offline: offline, newSessions: newSessions };
    // Fingerprint every response so polling still skips needless rebuilds.
    var fp = JSON.stringify({ feed: feed, detail: detail, cu: cu, k: cx.hasKey, off: offline });
    if (fp === pjFp) { refreshAgo('view-project'); return; }
    pjFp = fp;
    renderProject(feed, detail, p, cx);
  }).catch(function () { setPill(false); });
}
// One delegated listener outlives every rebuild: the panel re-renders on each
// poll, and a handler wired to a replaced node would silently drop clicks
// that race a rebuild.
pjRoot.addEventListener('click', function (e) {
  if (e.target.closest('.pj-close')) { location.hash = '#home'; return; }
  // The project stream renders the same session widgets as Activity, so the
  // same branches apply in the same ORDER as the view-feed handler: the
  // headline's data-sess-open sits INSIDE the data-card-toggle header, and
  // matching it first is what makes a brief click navigate without toggling.
  var sess = e.target.closest('[data-sess-open]');
  if (sess) { location.hash = '#session=' + encodeURIComponent(sess.getAttribute('data-sess-open')); return; }
  // "show more": unclamp just this one prompt, in place, no navigation.
  var more = e.target.closest('[data-clamp-more]');
  if (more) {
    var clamped = more.previousElementSibling;
    if (clamped) clamped.style.webkitLineClamp = 'unset';
    more.style.display = 'none';
    return;
  }
  // Share/hide a session's prompt from the team. Matched before data-card-toggle
  // (with stopPropagation as a second guard) so a toggle click never also
  // expands/collapses the card underneath it.
  var shareEl = e.target.closest('[data-share-toggle]');
  if (shareEl) {
    e.stopPropagation();
    if (shareEl.getAttribute('data-busy') === '1') return;
    shareEl.setAttribute('data-busy', '1');
    var makeShared = shareEl.getAttribute('data-share-on') !== '1';
    fetch('/api/share-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: shareEl.getAttribute('data-share-project'), session: shareEl.getAttribute('data-share-session'), share: makeShared }),
    }).then(function (r) { return r.json(); })
      .then(function (b) {
        // Share-specific rejection: inline on the toggle, never the pill.
        if (b && b.ok === false) { shareFailUI(shareEl); return; }
        pjFp = ''; loadProject(); // re-fetch the project stream so the toggle + prompt visibility refresh
      })
      .catch(function () { shareFailUI(shareEl); });
    return;
  }
  // Session-widget dropdowns AND the per-project Catch-Up headline cards share
  // this toggle (same contract), so an open card survives the 5s poll rebuild.
  var cardToggle = e.target.closest('[data-card-toggle]');
  if (cardToggle) {
    var ckey = cardToggle.getAttribute('data-card-toggle');
    var det = cardToggle.nextElementSibling;
    var nowOpen = det && det.style.display === 'none';
    if (det) det.style.display = nowOpen ? 'block' : 'none';
    catchupExpanded[ckey] = !!nowOpen;
    var cspans = cardToggle.getElementsByTagName('span');
    var cchev = cspans[cspans.length - 1];
    if (cchev) cchev.style.transform = nowOpen ? 'rotate(180deg)' : 'none';
    if (nowOpen && det) markClamped(det); // clamp overflow is only measurable once visible
    return;
  }
  var pjact = e.target.closest('[data-pjact]');
  if (pjact) {
    var act = pjact.getAttribute('data-pjact');
    // Mark/Undo advance the GLOBAL pointer (/api/catchup) — affects every
    // project's "since", because there is one read-state, not per-project.
    if (act === 'mark') {
      pjact.disabled = true;
      fetch('/api/catchup/mark', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { pjFp = ''; loadProject(); }).catch(function () { pjact.disabled = false; setPill(false); });
      return;
    }
    if (act === 'undo') {
      pjact.disabled = true;
      fetch('/api/catchup/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then(function () { pjFp = ''; loadProject(); }).catch(function () { pjact.disabled = false; setPill(false); });
      return;
    }
  }
  var menuBtn = e.target.closest('.pj-menu-btn');
  if (menuBtn) {
    pjMenuOpen = !pjMenuOpen;
    var menu = document.getElementById('pjMenu');
    if (menu) menu.className = 'pj-menu' + (pjMenuOpen ? ' open' : '');
    return;
  }
  var more = e.target.closest('.pjMoreBtn');
  if (more) { loadMoreProject(more); return; }
  var btn = e.target.closest('button[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'copy') { copyForAI(btn); return; }
  if (btn.dataset.act === 'team-page') { location.hash = '#settings'; return; }
  if (btn.dataset.act === 'link-folder') { location.hash = '#settings'; return; }
  if (btn.dataset.act === 'del') {
    pjMenuOpen = false; // close the ⋯ menu so it isn't left open behind the overlay
    openDel(btn.dataset.path, btn.dataset.name || btn.dataset.path);
    return;
  }
  if (btn.dataset.act === 'remove-block') {
    // openRemove is itself a confirm modal, so no separate arming here.
    pjMenuOpen = false; // close the ⋯ menu so it isn't left open behind the overlay
    openRemove(btn.dataset.path, btn.dataset.name || btn.dataset.path);
    return;
  }
  if (btn.dataset.act === 'archive') {
    if (!armed(btn)) return;
    if (!btn.dataset.path) { setPill(false); return; }
    btn.disabled = true;
    // The backend soft-archives for the team AND cleans up + unlinks locally,
    // so on success the project drops from the feed — return Home.
    fetch('/api/team/archive-project', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: btn.dataset.path }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'archive failed'); });
    }).then(function () { location.hash = '#home'; })
      .catch(function () { btn.disabled = false; setPill(false); });
    return;
  }
  if (btn.dataset.act === 'unlink') {
    if (!armed(btn)) return;
    btn.disabled = true;
    fetch('/api/team/unlink', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: btn.dataset.path }),
    }).then(function () { pjFp = ''; loadProject(); })
      .catch(function () { btn.disabled = false; setPill(false); });
    return;
  }
  if (btn.dataset.act === 'toggle') {
    if (!armed(btn)) return;
    btn.disabled = true; // the endpoint toggles: a double-click must not revert
    fetch('/api/projects/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: btn.dataset.path }),
    }).then(function () { pjFp = ''; loadProject(); }) // paused flips in the payload
      .catch(function () { btn.disabled = false; setPill(false); });
  }
});
// Click anywhere outside the ⋯ menu closes it (the menu button toggles above).
document.addEventListener('click', function (e) {
  if (!pjMenuOpen) return;
  if (e.target.closest && (e.target.closest('#pjMenu') || e.target.closest('.pj-menu-btn'))) return;
  pjMenuOpen = false;
  var menu = document.getElementById('pjMenu');
  if (menu) menu.className = 'pj-menu';
});
// Append the next page of project-stream entries, deduping the inclusive
// boundary the same way the Home feed does.
function loadMoreProject(btn) {
  var before = btn.getAttribute('data-before');
  var value = btn.getAttribute('data-project');
  if (!before || !value || btn.disabled) return;
  btn.disabled = true;
  fetch(pjFeedUrl(value) + '&before=' + encodeURIComponent(before)).then(function (r) { return r.json(); }).then(function (d) {
    setPill(true);
    var seen = {};
    for (var i = 0; i < pjEntries.length; i++) seen[feedKey(pjEntries[i])] = true;
    var fresh = (d.entries || []).filter(function (e) { return !seen[feedKey(e)]; });
    if (!fresh.length) { document.getElementById('pjMore').innerHTML = ''; return; }
    pjEntries = pjEntries.concat(fresh);
    // Same session-widget renderer as the initial stream — a Load more must
    // never flip the page back to the old per-prompt cards.
    var pjStreamEl = document.getElementById('pjStream');
    pjStreamEl.innerHTML = feedDayGroupHtml(pjEntries, { hideProject: true, unitCards: true });
    markClamped(pjStreamEl); // re-rendered open dropdowns need their clamps re-measured
    document.getElementById('pjMore').innerHTML = pjMoreBtnHtml(d.nextBefore, value);
  }).catch(function () { setPill(false); btn.disabled = false; });
}
function pjMoreBtnHtml(nextBefore, value) {
  return nextBefore
    ? '<button class="btn pjMoreBtn" data-before="' + esc(nextBefore) + '" data-project="' + esc(value) + '">Load more</button>' : '';
}
function renderProjectGone() {
  stopProject();
  pjRoot.innerHTML = '<div class="pj-head"><div class="grow"></div>' +
    '<button class="pj-close" title="Back to projects">&times;</button></div>' +
    '<div class="empty">This project is not tracked anymore.</div>';
}

/* ---- unified summary-first entry (Home feed + Project stream) ---- */
function personColor(id) {           // stable per-person avatar color
  var s = String(id || 'you'); var h = 0;
  for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return 'hsl(' + h + ',55%,55%)';
}
// Change model -> HTML rows for the feed card detail: icon per status, dimmed
// deps, +N -M counts, and a "-- note" for files the summarizer tagged.
function changesHtml(changes) {
  var icon = { new: '🆕', edited: '✏️', deleted: '🗑️' };
  var rows = changes.map(function (c) {
    var counts = (c.add != null || c.del != null) ? ' <span class="fcount">+' + (c.add || 0) + ' −' + (c.del || 0) + '</span>' : '';
    var note = c.note ? ' <span class="fnote">— ' + esc(c.note) + '</span>' : '';
    var cls = c.dep ? ' fdep' : '';
    return '<div class="fchange' + cls + '">' + (c.dep ? '📦' : (icon[c.status] || '✏️')) + ' <code>' + esc(c.file) + '</code>' + (c.dep ? ' <span class="fnote">(deps)</span>' : counts + note) + '</div>';
  });
  return '<div class="fchanges">' + rows.join('') + '</div>';
}
function feedEntryHtml(e, opts) {
  opts = opts || {};
  var who = e.self ? 'You' : (e.author || 'Someone');
  var color = /marco/i.test(who) ? 'var(--marco)' : /andrew/i.test(who) ? 'var(--andrew)' : personColor(e.authorId || 'you');
  var wip = !e.summary;
  var avatar = '<span class="favatar" style="background:' + color + '">' + esc((who[0] || '?').toUpperCase()) + '</span>';
  var todos = e.todos || [];
  var done = todos.filter(function (t) { return t[1]; }).length;
  var todoLabel = todos.length ? (done + ' of ' + todos.length + ' todos done') : '';
  var summaryLine =
    (e.goal ? '<div class="fmeta-row"><span class="flabel">Intent</span>' + esc(e.goal) + '</div>' : '') +
    '<div class="fsummary">' + (wip ? '<span class="fworking-lbl">Working on:&nbsp;</span>' : '') + esc(e.summary || e.ask || '') + '</div>' +
    ((e.decisions || e.gotchas) ? '<div class="fsub">' + esc([e.decisions, e.gotchas].filter(Boolean).join(' · ')) + '</div>' : '');
  var meta = '<div class="fmeta">'
    + '<button class="fperson" data-author="' + esc(e.authorId || who) + '">' + esc(who) + '</button>' + badgeHtml(e.source)
    + ((opts.hideProject || !e.project) ? '' : '<button class="fproj" data-project="' + esc(e.projectId || e.projectPath || '') + '" data-path="' + esc(e.projectPath || '') + '" data-id="' + esc(e.projectId || '') + '">' + esc(e.project) + '</button>')
    + (wip && todoLabel ? '<span class="fwip"><span class="fwip-dot"></span>in progress · ' + esc(todoLabel) + '</span>' : '')
    + '<span class="fago" data-ago="' + esc(e.ts) + '">' + esc(ago(e.ts)) + '</span>'
    + '<span class="fchev">&#9662;</span></div>';
  // detail (revealed by .fentry.open)
  var detail = '<div class="fdetail">';
  if (e.ask) detail += '<div class="fd-label">The ask</div><p class="fd-ask">&ldquo;' + esc(e.ask) + '&rdquo;</p>';
  if (e.checkpoints && e.checkpoints.length) detail += '<div class="fd-label">Checkpoints</div><div class="fd-checks">'
    + e.checkpoints.map(function (c, i) { return '<div class="fd-check"><span class="fd-n">' + String(i + 1).padStart(2, '0') + '</span><span>' + esc(c) + '</span></div>'; }).join('') + '</div>';
  if (todos.length) detail += '<div class="fd-label">Todos · ' + esc(todoLabel) + '</div>'
    + '<div class="fd-bar"><span style="width:' + Math.round(100 * done / todos.length) + '%;background:' + (wip ? 'var(--amber)' : 'var(--grad)') + '"></span></div>'
    + '<div class="fd-todos">' + todos.map(function (t) { return '<div class="fd-todo' + (t[1] ? ' done' : '') + '"><span>' + (t[1] ? '&#10003;' : '&#9675;') + '</span><span>' + esc(t[0]) + '</span></div>'; }).join('') + '</div>';
  if (Array.isArray(e.changes) && e.changes.length) {
    detail += '<div class="fd-label">Changes</div>' + changesHtml(e.changes);
  } else if (e.files && e.files.length) {
    detail += '<div class="fd-label">Files touched</div><div class="fd-files">'
      + e.files.map(function (f) { return '<span class="fd-file">' + esc(f) + '</span>'; }).join('') + '</div>';
  }
  detail += '</div>';
  return '<article class="fentry' + (wip ? ' pending' : '') + (opts.headline ? ' headline' : '') + '">'
    + '<div class="fentry-head">' + avatar + '<div class="grow">' + summaryLine + meta + '</div></div>' + detail + '</article>';
}
// Whole session card expands on click (not the person/project buttons). Class-based
// so unchanged polls (which do not rewrite innerHTML) keep whatever the reader opened.
document.addEventListener('click', function (e) {
  var head = e.target.closest ? e.target.closest('.fentry-head') : null;
  if (head && !e.target.closest('.fperson') && !e.target.closest('.fproj')) head.parentNode.classList.toggle('open');
});


// A team-only project (no local folder) has no tracked name; borrow it from the
// first stream row, falling back to a neutral label.
function pjDisplayName(entries) {
  for (var i = 0; i < entries.length; i++) if (entries[i].project) return entries[i].project;
  return 'Shared project';
}
// The ⋯ dropdown absorbs the old Memory tab + admin actions. Destructive items
// arm (click-again) or open a confirm modal; non-destructive ones act at once.
// Resolve the caller's role in a team from the last /api/team payload so the
// ⋯ menu can gate the destructive item (owner/admin = manager).
function teamRoleFor(teamId) {
  var teams = (teamState && teamState.teams) || [];
  for (var i = 0; i < teams.length; i++) if (teams[i].team_id === teamId) return teams[i].role;
  return null;
}
function pjMenuHtml(detail) {
  var items = '';
  if (detail) {
    var p = detail.path;
    if (detail.memory && detail.memory.exists) {
      items += '<a class="pj-mi" href="/api/project/memory?path=' + encodeURIComponent(p) + '" target="_blank">Open memory log</a>';
    }
    items += '<div class="pj-mi-info">Context files AI tools read</div>';
    items += (detail.targets || []).map(function (t) {
      return '<div class="pj-mi-file">' + (t.exists ? '&#10003; ' : '&middot; ') + esc(t.file) + '</div>';
    }).join('');
    items += '<div class="pj-mi-sep"></div>';
    items += '<button class="pj-mi" data-act="toggle" data-path="' + esc(p) + '">' +
      (detail.paused ? 'Resume sharing' : 'Pause sharing') + '</button>';
    if (detail.team) {
      // Shared project: gate the destructive item by the caller's role in this
      // team. A manager (owner/admin) can archive for the whole team; a plain
      // member can only unlink this machine. The backend re-enforces this.
      var manager = (function (r) { return r === 'owner' || r === 'admin'; })(teamRoleFor(detail.team.teamId));
      items += '<button class="pj-mi" data-act="unlink" data-path="' + esc(p) + '">Stop sharing with ' +
        esc(detail.team.teamName || 'team') + '</button>';
      items += '<button class="pj-mi" data-act="remove-block" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Remove memory block</button>';
      items += '<div class="pj-mi-sep"></div>';
      items += manager
        ? '<button class="pj-mi danger" data-act="archive" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Delete for the whole team</button>'
        : '<button class="pj-mi danger" data-act="unlink" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Remove from my machine</button>';
    } else {
      items += '<button class="pj-mi" data-act="team-page">Share with a team</button>';
      items += '<button class="pj-mi" data-act="remove-block" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Remove memory block</button>';
      items += '<div class="pj-mi-sep"></div>';
      items += '<button class="pj-mi danger" data-act="del" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Delete project</button>';
    }
  } else {
    // Team-only: the folder is not on this Mac. Send the user to the team hub,
    // which carries the team context needed to link a local folder.
    items += '<div class="pj-mi-info">Not on this Mac</div>' +
      '<button class="pj-mi" data-act="link-folder">Link a local folder&hellip;</button>';
  }
  return '<div class="pj-menu" id="pjMenu">' + items + '</div>';
}
// Avatar cluster for the header member line, styled verbatim from the template
// (22px circles, 2px --bg ring, -7px overlap). Degrades to '' with no members —
// we never invent names/avatars.
function pjAvatarsHtml(members) {
  return members.slice(0, 5).map(function (m, i) {
    var id = m.userId || m.id || m.email;
    var initial = ((m.displayName || m.email || '?').charAt(0) || '?').toUpperCase();
    return '<span style="width:22px;height:22px;border-radius:50%;background:' + avColor(id) +
      ';color:#fff;font-size:10px;font-weight:600;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg)' +
      (i ? ';margin-left:-7px' : '') + '">' + esc(initial) + '</span>';
  }).join('');
}
// The per-project Catch-Up section (template lines 453–585). Header pill + since
// anchor + Mark-as-caught-up, then either the caught-up card, an offline note,
// or the body (briefing / no-key hint + teammate headlines since the pointer).
function pjCatchupHtml(cx, shared) {
  var cu = cx.cu || {};
  var offline = cx.offline;
  var newSessions = cx.newSessions || [];
  var projCaughtUp = !offline && newSessions.length === 0;
  var showAnchor = !projCaughtUp && !!cu.lastViewedTs;
  var showMark = !projCaughtUp && !offline;
  var label = '<div style="display:inline-flex;align-items:center;gap:10px;border-radius:99px;border:1px solid var(--accent-brd);background:var(--accent-soft);padding:6px 16px">' +
    '<span style="width:7px;height:7px;border-radius:50%;background:var(--accent);animation:mbPulse 2s ease infinite"></span>' +
    '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:var(--accent)">The Catch-Up</span>' +
    '</div>';
  var header = '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;flex-wrap:wrap">' + label +
    (showAnchor ? '<span style="font-size:12.5px;color:var(--text3)">since you last looked — <span data-ago="' + esc(cu.lastViewedTs) + '">' + esc(ago(cu.lastViewedTs)) + '</span></span>' : '') +
    '<div style="flex:1"></div>' +
    (showMark ? '<button data-pjact="mark" style="height:36px;padding:0 15px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text2);font-size:12.5px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s ease-out" style-hover="border-color:var(--accent-brd);color:var(--text);box-shadow:var(--shadow-md)" style-active="transform:scale(.98)">Mark as caught up</button>' : '') +
    '</div>';

  var body;
  if (offline) {
    // isOffline note (template lines 507–509) — teammate feed unavailable.
    body = '<div style="color:var(--text3);font-size:12.5px">Teammate sessions are unavailable offline — showing what synced last.</div>';
  } else if (projCaughtUp) {
    // caught-up card (template lines 470–481)
    var sub = shared
      ? ('Nothing new since ' + (cu.lastViewedTs ? ago(cu.lastViewedTs) : 'you last looked') + '.')
      : 'This project is local only — only your own sessions land here.';
    var undo = cu.prevViewedTs ? '<span data-pjact="undo" style="color:var(--accent);font-size:13px;font-weight:600;cursor:pointer">Undo</span>' : '';
    body = '<div style="display:flex;align-items:center;gap:13px;padding:18px 20px;border:1px solid var(--border);border-radius:16px;background:var(--card);box-shadow:var(--shadow-md)">' +
      '<div style="width:34px;height:34px;border-radius:12px;background:var(--grad);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;box-shadow:var(--shadow-accent);flex:none">&#10003;</div>' +
      '<div style="flex:1"><div style="font-weight:600;font-size:14px">You&rsquo;re caught up here</div>' +
      '<div style="color:var(--text2);font-size:12.5px;margin-top:2px">' + esc(sub) + '</div></div>' + undo + '</div>';
  } else {
    // showProjCatchupBody (template lines 483–584): teammate headlines since the pointer.
    body = newSessions.map(function (e) { return catchupCardHtml(e); }).join('');
  }
  return '<section style="margin-top:40px">' + header + body + '</section>';
}
function renderProject(feed, detail, value, cx) {
  cx = cx || { cu: {}, hasKey: false, offline: false, newSessions: [] };
  feed = feed || {};
  var entries = (feed.entries || []).slice();
  pjEntries = entries;
  var local = !!detail;                       // metadata present => a folder we track
  var name = local ? detail.name : pjDisplayName(entries);
  var shared = local ? !!detail.team : true;  // team-only projects are shared by definition
  // Header badge: "shared · <team>" (template inline style) or a neutral "local only".
  var badge = shared
    ? '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);border:1px solid var(--accent-brd);background:var(--accent-soft);border-radius:99px;padding:3px 11px">shared &middot; ' +
        esc((local && detail.team && detail.team.teamName) || 'team') + '</span>'
    : '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--text3);border:1px solid var(--border);background:var(--card);border-radius:99px;padding:3px 11px">local only</span>';

  // Member-avatar cluster + "<names> · <lastTouched>". With no members list we
  // degrade to just the last-touched/active label (no fabricated names).
  var members = (detail && Array.isArray(detail.members)) ? detail.members : [];
  var avs = members.length
    ? '<span style="display:flex">' + pjAvatarsHtml(members) + '</span>' : '';
  var names = members.length
    ? esc(members.map(function (m) { return (m.displayName || m.email || '').split(/[ @]/)[0]; }).filter(Boolean).slice(0, 3).join(' & '))
    : '';
  var touched = (detail && (detail.activeLabel || detail.lastTouched)) ? esc(detail.activeLabel || detail.lastTouched) : '';
  var memberInner = names +
    (names && touched ? '<span style="color:var(--border2)">&middot;</span>' : '') +
    (touched ? '<span>' + touched + '</span>' : '');
  var memberLine = (avs || memberInner)
    ? '<div style="display:flex;align-items:center;gap:10px;margin-top:14px;font-size:12.5px;color:var(--text2)">' +
        avs + (memberInner ? '<span style="display:flex;align-items:center;gap:10px">' + memberInner + '</span>' : '') + '</div>'
    : '';

  var head =
    // Real control, not a floating link: bordered rounded box, chevron + label,
    // same button family as the header (.pj-close keeps the delegated handler;
    // width/height/padding inline so the 42px square .pj-close rule loses).
    '<button class="pj-back pj-close" title="Back to projects" style="display:inline-flex;align-items:center;gap:7px;width:auto;height:34px;padding:0 14px;margin-bottom:18px;border:1px solid var(--border);border-radius:10px;background:var(--card);color:var(--text2);font:inherit;font-size:13px;font-weight:500;line-height:1;cursor:pointer;box-shadow:none;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text);box-shadow:var(--shadow-md)">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M15 18l-6-6 6-6"/></svg>Projects</button>' +
    '<div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:260px">' +
        '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
          '<h1 style="margin:0;font-family:Calistoga,Georgia,serif;font-size:34px;font-weight:400;letter-spacing:-0.02em">' + esc(name) + '</h1>' +
          badge +
        '</div>' +
        (local ? '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:11.5px;color:var(--text3);margin-top:8px">' + esc(detail.path) + '</div>' : '') +
        memberLine +
      '</div>' +
      '<div style="display:flex;gap:8px;position:relative">' +
        (local ? '<button data-act="copy" data-path="' + esc(detail.path) +
          '" title="Copy a short digest of recent AI work here, ready to paste into any AI. Nothing is sent anywhere until you paste it." style="height:38px;padding:0 16px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent)">Copy for AI</button>' : '') +
        '<button class="pj-menu-btn" title="More" aria-haspopup="true" style="width:38px;height:38px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;font-size:16px;line-height:1">&#8943;</button>' +
        pjMenuHtml(detail) +
      '</div>' +
    '</div>';

  // Paused banner (amber) — Resume runs the same toggle endpoint as the ⋯ menu item.
  var pausedBanner = (local && detail.paused)
    ? '<div style="margin-top:18px;padding:10px 16px;border-radius:12px;background:var(--amber-soft);font-size:12.5px;color:var(--text2)">Watching is paused — new sessions in this project aren&rsquo;t being recorded. ' +
        '<button data-act="toggle" data-path="' + esc(detail.path) + '" style="background:none;border:none;padding:0;font:inherit;color:var(--accent);cursor:pointer;font-weight:600">Resume</button></div>'
    : '';

  // Stats strip: sessions this week / files touched / open todos (gradient number).
  var stats = '';
  if (local && detail.stats) {
    var s = detail.stats;
    var cell = 'flex:1;min-width:120px;padding:16px 20px';
    var lbl = 'font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--text3);margin-top:2px';
    stats = '<div style="display:flex;gap:0;margin:28px 0 10px;border:1px solid var(--border);border-radius:16px;background:var(--card);box-shadow:var(--shadow-md);overflow:hidden;flex-wrap:wrap">' +
      '<div style="' + cell + ';border-right:1px solid var(--border)"><div style="font-family:Calistoga,Georgia,serif;font-size:24px">' + (s.sessionsThisWeek || 0) + '</div><div style="' + lbl + '">sessions this week</div></div>' +
      '<div style="' + cell + ';border-right:1px solid var(--border)"><div style="font-family:Calistoga,Georgia,serif;font-size:24px">' + (s.filesTouched || 0) + '</div><div style="' + lbl + '">files touched</div></div>' +
      '<div style="' + cell + '"><div style="font-family:Calistoga,Georgia,serif;font-size:24px;background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent;display:inline-block">' + (s.openTodos || 0) + '</div><div style="' + lbl + '">open todos</div></div>' +
      '</div>';
  }

  // One merged, day-grouped stream (local + team, deduped server-side) —
  // the same session-widget renderer as Activity, minus the redundant
  // project pill (this whole page is one project).
  var stream = entries.length
    ? feedDayGroupHtml(entries, { hideProject: true, unitCards: true })
    : '<div class="empty">' + (local
        ? 'No AI activity captured here yet. Use Claude Code or Codex in this project and it will show up after the next sync.'
        : 'No activity has arrived from your team for this project yet.') + '</div>';

  // A degraded team fetch never replaces local work — same one-line notice Home
  // uses, shown above the stream so teammates' absence is explained, not silent.
  var notice = feed.teamUnavailable
    ? '<div class="notice">Team activity unavailable — showing local work.</div>' : '';

  // Per-project Catch-Up sits between the header/paused banner and the stats
  // strip (template: it precedes the state strip on the project page).
  var catchup = pjCatchupHtml(cx, shared);

  var h = head + pausedBanner + catchup + stats + notice +
    '<div id="pjStream">' + stream + '</div>' +
    '<div id="pjMore">' + pjMoreBtnHtml(feed.nextBefore, value) + '</div>';

  pjRoot.innerHTML = h;
  markClamped(pjRoot); // dropdowns re-rendered open need their "show more" links re-measured
  renderSyncBanner(!!feed.teamUnavailable); // amber under-header banner mirrors the degraded state
  // Click handling is delegated on pjRoot (survives this rebuild).
  if (pjMenuOpen) { var menu = document.getElementById('pjMenu'); if (menu) menu.className = 'pj-menu open'; }
}

/* ================= boot ================= */
loadTeam();
pollSyncHealth(); // seed pill + banner from the real current reachability
setInterval(pollSyncHealth, 10000); // self-heal the banner/pill on every screen
</script>
</body>
</html>`;
}

module.exports = { dashboardPage };
