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
  var MARK_BLUE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#3B82F6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/></svg>';
  var MARK_WHITE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/></svg>';
  // Rounded-square app icon (blue field, white mark) for the favicon.
  var ICON_DATAURI = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="4.5" fill="#3B82F6"/><g fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" transform="translate(12 12) scale(0.72) translate(-12 -12)"><path d="M5 20V4l7 9 7-9v16"/><path d="M1 14h22"/></g></svg>');
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
#view-project .roadmap {
  margin-top: 28px; border-top: 1px solid var(--border); padding-top: 8px;
}
#view-project .roadmap > summary {
  cursor: pointer; list-style: none; padding: 10px 2px; color: var(--muted);
  font: 600 11px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
  display: flex; align-items: center; gap: 8px;
}
#view-project .roadmap > summary::-webkit-details-marker { display: none; }
#view-project .roadmap > summary::before { content: '▸'; font-size: 10px; }
#view-project .roadmap[open] > summary::before { content: '▾'; }
#view-project .roadmap > summary:hover { color: var(--text); }
#view-project .roadmap .rm-sub { text-transform:none; letter-spacing:0; font-weight:500; color:var(--text3); }
#view-project .roadmap .rm-key { color:var(--accent); }
#view-project .roadmap .card { margin-top: 12px; }
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
.locked { text-align: center; padding: 44px 24px; }
.locked h3 { margin: 0; font-size: 16px; font-weight: 600; }
.locked p { color: var(--muted); max-width: 460px; margin: 10px auto 0; font-size: 14px; }

/* ---------- plan tab ---------- */
#pjGoal {
  width: 100%; margin-top: 10px; font: inherit; font-size: 13.5px; color: var(--text);
  background: var(--bg2); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; outline: none; resize: vertical; min-height: 64px;
}
#pjGoal:focus { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
#pjGoal::placeholder { color: var(--muted); }
.stale {
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); background: color-mix(in srgb, var(--warn) 7%, transparent);
  color: var(--warn); border-radius: var(--radius); padding: 10px 16px;
  margin-bottom: 16px; font-size: 13px;
}
.psum { font-size: 14px; margin: 8px 0 0; line-height: 1.6; }
.ptask { padding: 12px 2px; border-bottom: 1px solid var(--border); font-size: 13.5px; }
.ptask:last-child { border-bottom: none; }
.pwhy { color: var(--muted); font-size: 12.5px; margin-top: 3px; }
.prow { display: flex; align-items: center; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
.prow .pwhy { margin-top: 0; }
.psize {
  display: inline-block; font-size: 10.5px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 5px; padding: 0 6px;
  margin-left: 6px; vertical-align: 1px;
}
.plist { margin: 8px 0 0; padding-left: 20px; font-size: 13.5px; }
.plist li { margin-top: 6px; }

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
::selection { background: rgba(0,82,255,.18); }
header { flex:none; position:sticky; top:0; z-index:40; height:56px; padding:0 28px; gap:10px;
  display:flex; align-items:center; background:var(--bg); border-bottom:1px solid var(--border); }
.brand { display:flex; align-items:center; gap:9px; cursor:pointer; padding:6px 9px; margin-left:-9px;
  border-radius:10px; transition:background .2s; }
.brand:hover { background:var(--surface2); }
.brand-mark { width:26px; height:26px; border-radius:8px; background:var(--grad); box-shadow:var(--shadow-accent);
  display:inline-flex; align-items:center; justify-content:center; }
.brand-mark svg { width:15px; height:15px; }
.brand-word { font-family:var(--display); font-size:16px; letter-spacing:0; }
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
      <div style="display:flex;justify-content:center;margin-bottom:22px">
        <div style="display:flex;align-items:center">
          <div style="width:24px;height:24px;border-radius:50%;background:var(--grad);box-shadow:var(--shadow-accent)"></div>
          <div style="width:24px;height:24px;border-radius:50%;border:2px solid var(--text);margin-left:-9px;background:var(--bg)"></div>
        </div>
      </div>
      <div style="font-family:Calistoga,Georgia,serif;font-size:28px;letter-spacing:-0.01em">Mem<span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">Bridge</span></div>
      <div style="color:var(--text2);margin:10px 0 30px;font-size:14.5px">Shared memory for the AI tools your team codes with.</div>
      <div id="authRoot"></div>
      <div style="color:var(--text3);font-size:12px;margin-top:26px">Your session memories stay on your machine until you join a team.</div>
    </div>
  </div>
</div>

<header style="position:sticky;top:0;z-index:40;background:var(--bg);border-bottom:1px solid var(--border)">
  <div style="max-width:1080px;margin:0 auto;padding:0 28px;height:56px;display:flex;align-items:center;gap:10px">
    <div id="goHome" title="Projects" style="display:flex;align-items:center;gap:9px;cursor:pointer;padding:6px 9px;margin-left:-9px;border-radius:10px;transition:background .2s" style-hover="background:var(--surface2)">
      <div style="display:flex;align-items:center">
        <div style="width:14px;height:14px;border-radius:50%;background:var(--grad)"></div>
        <div style="width:14px;height:14px;border-radius:50%;border:1.5px solid var(--text);margin-left:-5px;background:var(--bg)"></div>
      </div>
      <span style="font-family:Calistoga,Georgia,serif;font-size:16px;letter-spacing:0">MemBridge</span>
    </div>
    <nav id="mbNav" style="display:flex;align-items:stretch;gap:22px;margin-left:26px;height:56px">
      <span data-nav="projects" style="position:relative;display:flex;align-items:center;font-size:13px;cursor:pointer;letter-spacing:.01em;transition:color .2s">Projects<span class="nav-bar" style="position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px 1px 0 0;background:transparent"></span></span>
      <span data-nav="feed" style="position:relative;display:flex;align-items:center;font-size:13px;cursor:pointer;letter-spacing:.01em;transition:color .2s">Everything<span class="nav-bar" style="position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px 1px 0 0;background:transparent"></span></span>
      <span data-nav="team" style="position:relative;display:flex;align-items:center;font-size:13px;cursor:pointer;letter-spacing:.01em;transition:color .2s">Team<span class="nav-bar" style="position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:1px 1px 0 0;background:transparent"></span></span>
    </nav>
    <div style="flex:1"></div>
    <div id="pill" title="Click to sync now" style="display:flex;align-items:center;gap:8px;padding:6px 13px;border-radius:99px;border:1px solid var(--accent-brd);background:var(--accent-soft);cursor:pointer;font-family:'JetBrains Mono',monospace;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);transition:all .2s" style-hover="box-shadow:var(--shadow-accent)">
      <span style="width:6px;height:6px;border-radius:50%;background:var(--accent);animation:mbPulse 2s ease infinite"></span><span id="pillLabel">Synced</span>
    </div>
    <button id="openInvite" title="Invite teammates" style="height:34px;padding:0 15px;border-radius:10px;border:none;background:var(--grad);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-1px);box-shadow:var(--shadow-accent-lg)" style-active="transform:scale(.98)">Invite</button>
    <button id="themeToggle" title="Toggle theme" aria-label="Toggle theme" style="width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">&#9790;</button>
    <button id="openSettings" title="Settings" aria-label="Settings" style="width:34px;height:34px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.4"></circle><circle cx="8" cy="8" r="6" stroke-dasharray="1.8 2.4"></circle></svg>
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

<div id="view-home"><div id="homeCatchup"></div></div>

<div id="view-feed"><div id="feedRoot"></div></div>

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
// One lightweight status poll; degrades to plain "Synced" when teamLastSync is absent.
function refreshStatus() {
  return fetch('/api/status').then(function (r) { return r.json(); })
    .then(function (s) { if (s && s.teamLastSync) lastTeamSync = s.teamLastSync; return s; })
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
  return 'home';
};
var currentProjPath = function () {
  try { return decodeURIComponent(location.hash.slice(9)); } catch (err) { return ''; }
};
// Just toggle which view is visible. Split from applyTab so renderTeam can show
// the auth view WITHOUT re-running applyRun -> loadTeam (that recursion floods
// /api/team and rebuilds the sign-in form under the cursor, killing focus).
function showView() {
  var t = currentTab();
  document.getElementById('view-auth').className = t === 'auth' ? 'active' : '';
  document.getElementById('view-home').className = t === 'home' ? 'active' : '';
  document.getElementById('view-feed').className = t === 'feed' ? 'active' : '';
  document.getElementById('teamScreen').className = t === 'team' ? 'active' : '';
  document.getElementById('view-project').className = t === 'project' ? 'active' : '';
  document.getElementById('view-settings').className = t === 'settings' ? 'active' : '';
  applyNav(t);
}
// Persistent nav (Projects / Everything / Team) active-underline treatment.
// Projects → #home (projects index), Everything → #everything feed, Team → #team.
function applyNav(t) {
  // v3: Projects stays active on the project drill-down too (match projects+project).
  var map = { projects: t === 'home' || t === 'project', feed: t === 'feed', team: t === 'team' };
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
  if (document.hidden) return;
  var t = currentTab();
  if (t === 'home') startHome();
  else if (t === 'feed') startFeed();
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

function renderTeamScreen() {
  var host = document.getElementById('teamScreenRoot');
  if (!host) return;
  if (!host.innerHTML) {
    host.innerHTML = '<main style="max-width:660px;margin:0 auto;padding:48px 28px 110px"><div class="empty">Loading&hellip;</div></main>';
  }
  fetch('/api/team').then(function (r) { return r.json(); }).catch(function () { return null; }).then(function (t) {
    tsTeamState = t;
    teamState = t;
    var tid = (t && t.authenticated) ? pickTeamId(t) : '';
    var membersP = (t && t.authenticated && tid)
      ? apiGet('/api/team/members?teamId=' + encodeURIComponent(tid)).catch(function () { return { members: [] }; })
      : Promise.resolve({ members: [] });
    return membersP;
  }).then(function (res) {
    if (currentTab() !== 'team') return; // navigated away mid-fetch
    setPill(true);
    tsMembers = (res && res.members) || [];
    renderTeamScreenView();
  }).catch(function () { setPill(false); });
}

function renderTeamScreenView() {
  var host = document.getElementById('teamScreenRoot');
  if (!host) return;
  host.innerHTML =
    '<main style="max-width:660px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">' +
      '<h1 style="margin:0 0 22px;font-family:Calistoga,Georgia,serif;font-size:36px;font-weight:400;letter-spacing:-0.02em">Team</h1>' +
      teamScreenBody() +
    '</main>';
}

function teamScreenBody() {
  var t = tsTeamState;
  var team = (t && t.authenticated) ? pickTeam(t) : null;
  if (!team) return teamScreenNone();
  return teamScreenSome(t, team);
}

// No-team state: create-or-join CTA (reuses the prompt-driven create/join flow).
function teamScreenNone() {
  return '<div style="border:1px solid var(--border);border-radius:20px;background:var(--card);padding:44px 36px;text-align:center;box-shadow:var(--shadow-md)">' +
      '<div style="display:flex;justify-content:center;margin-bottom:18px"><div style="display:flex">' +
        '<div style="width:34px;height:34px;border-radius:50%;background:var(--grad);box-shadow:var(--shadow-accent)"></div>' +
        '<div style="width:34px;height:34px;border-radius:50%;border:2px dashed var(--border2);margin-left:-9px;background:var(--bg)"></div>' +
      '</div></div>' +
      '<div style="font-family:Calistoga,Georgia,serif;font-size:22px">No team yet</div>' +
      '<div style="color:var(--text2);font-size:13.5px;max-width:400px;margin:10px auto 24px">A team is two or more people whose session memories sync. Create one and hand your partner the join code &mdash; or enter theirs.</div>' +
      '<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">' +
        '<button data-ts-create style="height:48px;padding:0 22px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-2px);box-shadow:var(--shadow-accent-lg)" style-active="transform:scale(.98)">Create a team</button>' +
        '<button data-ts-join style="height:48px;padding:0 22px;border-radius:12px;border:1px solid var(--border);background:var(--card);color:var(--text);font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="border-color:var(--accent-brd);box-shadow:var(--shadow-md)">Join with a code</button>' +
      '</div>' +
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

  // --- header row ---
  var head = '<div style="display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--border);position:relative">' +
    '<div style="flex:1">' +
      '<div style="font-weight:600;font-size:15px">' + esc(team.team_name) + '</div>' +
      '<div style="font-size:12px;color:var(--text3)">' + count + ' member' + (count === 1 ? '' : 's') + created + ' &middot; you are ' + myRoleLabel + '</div>' +
    '</div>';
  if (isOwner) {
    head += '<button data-ts-rename style="height:34px;padding:0 13px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">Rename</button>';
  }
  if (teams.length > 1) {
    head += '<button data-ts-switch style="height:34px;padding:0 13px;border-radius:10px;border:1px solid var(--border);background:var(--card);color:var(--text2);font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="border-color:var(--accent-brd);color:var(--text)">Switch team &#9662;</button>';
    if (tsSwitcherOpen) {
      var opts = teams.map(function (tm) {
        if (tm.team_id === team.team_id) {
          return '<div style="padding:9px 12px;border-radius:10px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;background:var(--surface2)">' + esc(tm.team_name) + ' <span style="margin-left:auto;color:var(--accent)">&check;</span></div>';
        }
        return '<div data-ts-switchto="' + esc(tm.team_id) + '" style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;color:var(--text2);transition:background .15s" style-hover="background:var(--surface2)">' + esc(tm.team_name) + '</div>';
      }).join('');
      head += '<div style="position:absolute;right:16px;top:56px;width:230px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-xl);padding:6px;z-index:50;animation:mbFade .2s cubic-bezier(.16,1,.3,1)">' +
        opts +
        '<div style="height:1px;background:var(--border);margin:6px 8px"></div>' +
        '<div data-ts-createjoin style="padding:9px 12px;border-radius:10px;font-size:13px;cursor:pointer;color:var(--accent);font-weight:600;transition:background .15s" style-hover="background:var(--surface2)">+ Create or join a team</div>' +
      '</div>';
    }
  }
  head += '</div>';

  // --- members ---
  var self = t.user;
  var rows = tsMembers.map(function (m) {
    var name = m.display_name || '';
    var isSelf = self && self.userId === m.user_id;
    var owner = m.role === 'owner';
    var color = /^marco$/i.test(name) ? 'var(--marco)' : /^andrew$/i.test(name) ? 'var(--andrew)' : avColor(m.user_id);
    var initial = ((name || '?').charAt(0) || '?').toUpperCase();
    var jd = m.joined_at ? new Date(m.joined_at) : null;
    var joined = (jd && !isNaN(jd.getTime())) ? jd.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) : '';
    var roleColor = owner ? 'var(--accent)' : 'var(--text3)';
    var roleBorder = owner ? 'var(--accent-brd)' : 'var(--border)';
    var roleBg = owner ? 'var(--accent-soft)' : 'transparent';
    var youLabel = isSelf ? '&middot; you' : '';
    var showControls = isOwner && !isSelf;
    var h = '<div style="display:flex;align-items:center;gap:13px;padding:14px 18px;border-bottom:1px solid var(--border)">' +
      '<div style="width:30px;height:30px;border-radius:10px;background:' + color + ';color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center;flex:none">' + esc(initial) + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13.5px;font-weight:600">' + esc(name) + ' <span style="font-size:12px;color:var(--text3);font-weight:400">' + youLabel + '</span></div>' +
        '<div style="display:flex;align-items:center;gap:7px;font-size:12px;color:var(--text3);margin-top:2px">' +
          (joined ? '<span>joined ' + esc(joined) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<span style="' + MONO + ';font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:' + roleColor + ';border:1px solid ' + roleBorder + ';background:' + roleBg + ';border-radius:99px;padding:3px 10px;flex:none">' + esc(m.role) + '</span>';
    if (showControls) {
      var roleAction = owner ? 'Make member' : 'Make owner';
      var nextRole = owner ? 'member' : 'owner';
      h += '<span data-ts-role data-user-id="' + esc(m.user_id) + '" data-role="' + nextRole + '" style="font-size:12px;color:var(--text2);cursor:pointer;font-weight:500;flex:none;transition:color .2s" style-hover="color:var(--text)">' + roleAction + '</span>' +
        '<span data-ts-remove data-user-id="' + esc(m.user_id) + '" style="font-size:12px;color:var(--text3);cursor:pointer;flex:none;transition:color .2s" style-hover="color:#DC2626">Remove</span>';
    }
    return h + '</div>';
  }).join('');

  // --- card foot ---
  var foot = '<div style="display:flex;align-items:center;gap:12px;padding:13px 18px">' +
    '<span data-ts-invitejump style="font-size:13px;color:var(--accent);cursor:pointer;font-weight:600">+ Invite someone</span>' +
    '<div style="flex:1"></div>' +
    (!isOwner ? '<span data-ts-leave style="font-size:12.5px;color:var(--text3);cursor:pointer;transition:color .2s" style-hover="color:#DC2626">Leave team</span>' : '') +
  '</div>';

  var card = '<div style="border:1px solid var(--border);border-radius:16px;background:var(--card);margin-bottom:26px;overflow:hidden;box-shadow:var(--shadow-md)">' +
    head + rows + foot + '</div>';

  // --- join code panel ---
  var joinLabel = '<div style="' + MONO + ';font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:8px">Join code</div>';
  var hasCode = !!team.invite_code;
  var joinBody;
  if (hasCode) {
    joinBody = '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<div style="padding:11px 18px;border-radius:12px;background:var(--surface2);' + MONO + ';font-size:19px;letter-spacing:.18em;color:var(--text)">' + esc(team.invite_code) + '</div>' +
      '<button data-team-action="copy-invite" data-code="' + esc(team.invite_code) + '" style="height:40px;padding:0 16px;border-radius:12px;border:none;background:var(--grad);color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;box-shadow:var(--shadow-accent);transition:all .2s ease-out" style-hover="transform:translateY(-1px)" style-active="transform:scale(.98)">Copy</button>' +
      '<div style="flex:1"></div>' +
      (isOwner ? '<span data-ts-regen style="font-size:12.5px;color:var(--text2);cursor:pointer;font-weight:500;transition:color .2s" style-hover="color:var(--text)">Regenerate</span>' +
        '<span data-ts-revoke data-token="' + esc(team.invite_code) + '" style="font-size:12.5px;color:var(--text3);cursor:pointer;transition:color .2s" style-hover="color:#DC2626">Revoke</span>' : '') +
    '</div>' +
    '<div style="font-size:12px;color:var(--text3);margin-top:11px">Anyone with this code joins as a member. Regenerating invalidates the old code.</div>';
  } else {
    joinBody = '<div style="display:flex;align-items:center;gap:12px">' +
      '<span style="font-size:13px;color:var(--text2)">Invites are off &mdash; no active join code.</span>' +
      '<div style="flex:1"></div>' +
      (isOwner ? '<button data-ts-regen style="height:38px;padding:0 15px;border-radius:10px;border:1px solid var(--accent-brd);background:var(--accent-soft);color:var(--accent);font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s" style-hover="box-shadow:var(--shadow-accent)">Generate a code</button>' : '') +
    '</div>';
  }
  var joinCard = joinLabel + '<div id="ts-joincode" style="border:1px solid var(--border);border-radius:16px;background:var(--card);padding:18px;box-shadow:var(--shadow-md)">' + joinBody + '</div>';

  var memberNote = !isOwner
    ? '<div style="color:var(--text3);font-size:12px;margin-top:14px">You&rsquo;re a member &mdash; only the owner can rename the team, change roles, or manage the join code.</div>'
    : '';

  return card + joinCard + memberNote;
}

// Team screen delegated handlers. Mutations reuse the shared teamRequest +
// endpoints, then re-render the team screen (not the Settings-bound loadTeam).
document.getElementById('teamScreen').addEventListener('click', function (e) {
  var team = (tsTeamState && tsTeamState.authenticated) ? pickTeam(tsTeamState) : null;

  if (e.target.closest('[data-ts-create]')) {
    var tn = window.prompt('New team name');
    if (tn && tn.trim()) {
      teamRequest('/api/team/create', { name: tn.trim() }).then(function (r) {
        if (r.team_id) rememberTeam(r.team_id); renderTeamScreen();
      }).catch(function () { setPill(false); });
    }
    return;
  }
  if (e.target.closest('[data-ts-join]') || e.target.closest('[data-ts-createjoin]')) {
    var code = window.prompt('Paste an invite code');
    if (code && code.trim()) {
      teamRequest('/api/team/join', { inviteCode: code.trim() }).then(function (r) {
        if (r.team_id) rememberTeam(r.team_id); tsSwitcherOpen = false; renderTeamScreen();
      }).catch(function () { setPill(false); });
    }
    return;
  }
  if (!team) return;
  if (e.target.closest('[data-ts-rename]')) {
    var name = window.prompt('Rename team', team.team_name);
    if (name && name.trim() && name.trim() !== team.team_name) {
      teamRequest('/api/team/rename', { teamId: team.team_id, name: name.trim() })
        .then(function () { renderTeamScreen(); }).catch(function () { setPill(false); });
    }
    return;
  }
  if (e.target.closest('[data-ts-switch]')) { tsSwitcherOpen = !tsSwitcherOpen; renderTeamScreenView(); return; }
  var swto = e.target.closest('[data-ts-switchto]');
  if (swto) { rememberTeam(swto.getAttribute('data-ts-switchto')); tsSwitcherOpen = false; renderTeamScreen(); return; }
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
      .then(function () { rememberTeam(''); renderTeamScreen(); }).catch(function () { setPill(false); });
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
function loadProjectsIndex() {
  var host = document.getElementById('homeCatchup'); if (!host) return;
  fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
    projects = projects || [];
    if (!projects.length) { pxData = null; pxFp = ''; renderProjectsEmpty(host); return; }
    var localPaths = projects.filter(function (p) { return p.path.charAt(0) === '/'; }).map(function (p) { return p.path; });
    var detailPs = localPaths.map(function (pp) {
      return fetch('/api/project?path=' + encodeURIComponent(pp)).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    });
    Promise.all([
      fetch('/api/catchup').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; }),
      fetch('/api/team').then(function (r) { return r.json(); }).catch(function () { return { teams: [] }; }),
      fetch('/api/feed?limit=100').then(function (r) { return r.json(); }).catch(function () { return { entries: [] }; })
    ].concat(detailPs)).then(function (arr) {
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
      var fp = JSON.stringify({ p: projects, s: statsByPath, e: pxData.recent, ts: pxData.lastViewedTs, t: pxData.onTeam, off: offline });
      // An open menu/confirm must survive the poll; only patch relative times.
      if (fp === pxFp && host.firstChild && (pxMenuId || pxConfirmId)) { refreshAgo('view-home'); return; }
      if (fp === pxFp && host.firstChild) { refreshAgo('view-home'); return; }
      pxFp = fp;
      renderProjectsIndex();
    }).catch(function () { setPill(false); });
  }).catch(function () { setPill(false); });
}
// One filter option (template lines 172–174): active = text + gradient underline.
function pxOpt(group, val, current, label) {
  var active = val === current;
  return '<span data-px-filter="' + group + '" data-val="' + esc(val) + '" style="position:relative;font-size:13px;cursor:pointer;color:' +
    (active ? 'var(--text)' : 'var(--text3)') + ';font-weight:' + (active ? '600' : '400') + ';padding-bottom:4px;transition:color .2s" style-hover="color:var(--text)">' +
    esc(label || val) + '<span style="position:absolute;left:0;right:0;bottom:0;height:2px;border-radius:1px;background:' + (active ? 'var(--grad)' : 'transparent') + '"></span></span>';
}
function pxFilterGroup(label, opts) {
  return '<div style="display:flex;gap:16px;align-items:baseline">' +
    '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--text3)">' + esc(label) + '</span>' +
    opts + '</div>';
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
    menu = '<div style="position:absolute;right:0;top:60px;width:220px;background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:var(--shadow-xl);padding:6px;z-index:50;animation:mbFade .2s cubic-bezier(.16,1,.3,1)">' +
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
  if (pxFilter.person !== 'All') {
    vis = vis.filter(function (p) {
      return pxData.recent.some(function (e) { return e.author === pxFilter.person && pxEntryInProject(e, p); });
    });
  }
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

  // filters row
  var personOpts = ['All'].concat(pxAuthors());
  var filters =
    '<div style="display:flex;flex-wrap:wrap;gap:12px 34px;align-items:baseline;margin-bottom:10px;padding-bottom:14px;border-bottom:1px solid var(--border)">' +
      pxFilterGroup('show', ['All', 'Shared', 'Local'].map(function (v) { return pxOpt('show', v, pxFilter.show); }).join('')) +
      pxFilterGroup('person', personOpts.map(function (v) { return pxOpt('person', v, pxFilter.person); }).join('')) +
      pxFilterGroup('sort', ['Recent', 'Name'].map(function (v) { return pxOpt('sort', v, pxFilter.sort); }).join('')) +
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
  var headlineSrc = offline ? sinceEntries.filter(function (e) { return e.self === true; }) : others;
  var headlineCards = headlineSrc.map(function (e) { return catchupCardHtml(e); }).join('');
  var headlinesTitle = offline ? 'Your local sessions' : ('What happened · ' + headlineSrc.length + ' sessions');
  var offlineNote = offline
    ? '<div style="color:var(--text3);font-size:12.5px;margin:8px 0 4px">Teammate sessions are unavailable offline. Your own recent work:</div>' : '';
  var projRows = (changed.length ? changed : projects.slice(0, 5)).map(projectRowHtml).join('');

  // renderVals: showMarkCaughtUp = !caughtUp && !noTeam && !isOffline (here: !offline);
  // showBriefing = !noKey && !isOffline; showNoKeyHint = noKey && !isOffline.
  var briefingBlock = (!noKey && !offline)
    // A · AI BRIEFING (template lines 206–218)
    ? '<section style="position:relative;border-radius:20px;background:var(--inv);color:var(--inv-text);padding:28px 30px 26px;margin-bottom:48px;box-shadow:var(--shadow-xl);overflow:hidden">' +
        '<div style="position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,1) 1px,transparent 1px);background-size:32px 32px;opacity:.04;pointer-events:none"></div>' +
        '<div style="position:absolute;top:-140px;right:-100px;width:380px;height:380px;border-radius:50%;background:#4D7CFF;opacity:.14;filter:blur(120px);pointer-events:none"></div>' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:15px;position:relative">' +
          '<span style="background:linear-gradient(135deg,#6E93FF,#9DB7FF);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:12px">✦</span>' +
          '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:rgba(248,250,252,.5)">Briefing · AI-generated</span>' +
          '<div style="flex:1"></div>' +
          '<span data-catchup="brief" style="font-size:12px;color:rgba(248,250,252,.45);cursor:pointer;display:flex;align-items:center;gap:5px;transition:color .2s" style-hover="color:rgba(248,250,252,.8)"><span>↻</span>' + (cu.briefing ? 'Regenerate' : 'Generate') + '</span>' +
        '</div>' +
        '<p id="cuBriefingBody" style="margin:0;font-size:16.5px;line-height:1.7;color:var(--inv-text);text-wrap:pretty;position:relative;transition:opacity .3s">' +
          (cu.briefing && cu.briefing.text ? esc(cu.briefing.text) : 'No briefing yet — regenerate to get a written summary. The headlines below tell the same story.') + '</p>' +
      '</section>'
    // no-key hint (template lines 219–221)
    : (noKey && !offline
        ? '<div style="color:var(--text3);font-size:12.5px;margin-bottom:40px;padding:12px 16px;border:1px dashed var(--border2);border-radius:12px">AI briefing off — <span data-catchup="open-settings" style="color:var(--accent);cursor:pointer;font-weight:600">add an API key</span> in Settings to get a written summary here. The headlines below tell the same story.</div>'
        : '');

  host.innerHTML = cuMainOpen() + cuSectionLabel() + cuTitle('While you were', 'out', !offline) + cuSince(cu) +
    briefingBlock +
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
      '<div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.45;text-wrap:pretty">' +
        (wip ? '<span style="color:var(--amber)">Working on:&nbsp;</span>' : '') + esc(e.summary || e.ask || '') + '</div>' +
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
  if (e.files && e.files.length) detail += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin-bottom:9px">Files touched</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:6px">' + e.files.map(function (f) {
      return '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;padding:4px 9px;border-radius:8px;background:var(--surface2);color:var(--text2)">' + esc(f) + '</span>';
    }).join('') + '</div>';
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
function loadBriefing(btn) {
  if (btn.getAttribute('data-busy')) return; btn.setAttribute('data-busy', '1');
  var box = document.getElementById('cuBriefingBody'); if (box) box.textContent = 'Thinking…';
  fetch('/api/briefing/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: catchupSince }) })
    .then(function (r) { return r.json(); }).then(function (d) {
      btn.removeAttribute('data-busy');
      var nokey = document.getElementById('cuNoKey');
      if (d.degraded) {
        if (box) box.textContent = 'AI briefing off.';
        // template no-key hint (lines 219–221)
        if (nokey) nokey.innerHTML = '<div style="color:var(--text3);font-size:12.5px;margin-bottom:40px;padding:12px 16px;border:1px dashed var(--border2);border-radius:12px">AI briefing off — <span data-catchup="open-settings" style="color:var(--accent);cursor:pointer;font-weight:600">add an API key</span> in Settings to get a written summary here. The headlines below tell the same story.</div>';
        return;
      }
      if (nokey) nokey.innerHTML = '';
      if (box) box.textContent = d.text || '';
      catchupFp = ''; // let the next poll reconcile cached state
    }).catch(function () { btn.removeAttribute('data-busy'); if (box) box.textContent = 'Briefing unavailable right now.'; });
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
    if (act === 'open-settings') { location.hash = '#settings'; return; }
    if (act === 'go-team') { location.hash = '#team'; return; }
    if (act === 'see-everything') { location.hash = '#everything'; return; }
    if (act === 'brief') { loadBriefing(cu); return; }
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
function startFeed() { feedFp = ''; loadFeed(); feedTimer = setInterval(loadFeed, 5000); }
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
      var seen = {}, out = [];
      lists.forEach(function (ms) { ms.forEach(function (m) { if (m.user_id && !seen[m.user_id]) { seen[m.user_id] = 1; out.push({ id: m.user_id, name: m.display_name }); } }); });
      feedMembers = out;
    });
  }).catch(function () { feedMembers = []; }).then(function () { feedMembersLoading = false; });
}
function loadFeed() {
  var host = document.getElementById('feedRoot'); if (!host) return;
  ensureFeedMembers(); // non-blocking; populates the person chips
  fetch(feedViewUrl()).then(function (r) { return r.json(); }).then(function (f) {
    setPill(true);
    var entries = (f && f.entries) || [];
    var offline = !!(f && f.teamUnavailable);
    renderSyncBanner(offline);
    // The filter chip menu is derived from the unfiltered feed so a selection
    // can't erase the other options; page fingerprint dedupes no-op polls.
    var fp = JSON.stringify({ e: entries, off: offline, f: feedFilters, m: (feedMembers || []).map(function (x) { return x.id; }) });
    if (fp === feedFp && host.firstChild) { refreshAgo('view-feed'); return; }
    feedFp = fp;
    renderFeed(host, entries);
  }).catch(function () { setPill(false); });
}
// One filter chip (template chip(): active = gradient fill white, inactive = bordered).
function feedChipHtml(kind, label, val, active) {
  var border = active ? 'transparent' : 'var(--border)';
  var bg = active ? 'var(--grad)' : 'transparent';
  var color = active ? '#fff' : 'var(--text2)';
  var weight = active ? '600' : '400';
  var shadow = active ? 'var(--shadow-accent)' : 'none';
  return '<span data-feed-chip="' + kind + '" data-val="' + esc(val || '') + '" style="padding:5px 14px;border-radius:99px;font-size:12.5px;cursor:pointer;border:1px solid ' + border + ';background:' + bg + ';color:' + color + ';font-weight:' + weight + ';transition:all .2s;box-shadow:' + shadow + '" style-hover="border-color:var(--accent-brd)">' + esc(label) + '</span>';
}
// Chip rows for person / project / tool. The leading "All" clears that filter;
// the rest are the distinct values present in the feed.
function feedChipsHtml(entries) {
  var projects = {}, tools = {};
  entries.forEach(function (e) {
    if (e.project) projects[e.project] = e.project;
    if (e.source) tools[e.source] = e.source;
  });
  // Person chips come from the team member list (id = user_id) so every teammate
  // is selectable even when their entries are below the page limit, and the
  // filter queries team_feed by author_id (a name can't).
  var chips = '';
  chips += feedChipHtml('author', 'All', null, !feedFilters.author);
  (feedMembers || []).forEach(function (m) { chips += feedChipHtml('author', m.name, m.id, feedFilters.author === m.id); });
  chips += feedChipHtml('project', 'All projects', null, !feedFilters.project);
  Object.keys(projects).forEach(function (k) { chips += feedChipHtml('project', projects[k], k, feedFilters.project === k); });
  chips += feedChipHtml('source', 'All tools', null, !feedFilters.source);
  Object.keys(tools).forEach(function (k) { chips += feedChipHtml('source', tools[k], k, feedFilters.source === k); });
  return chips;
}
function renderFeed(host, entries) {
  var groups = entries.length
    ? feedDayGroupHtml(entries)
    : '<div style="color:var(--text3);font-size:13px;padding:24px 4px">Nothing to show for these filters yet.</div>';
  host.innerHTML =
    '<main style="max-width:780px;margin:0 auto;padding:48px 28px 110px;animation:mbFade .4s cubic-bezier(.16,1,.3,1)">' +
      '<div data-feed="back" style="font-size:12.5px;color:var(--text3);cursor:pointer;margin-bottom:16px;display:inline-block;transition:color .2s" style-hover="color:var(--text2)">← Catch-Up</div>' +
      '<h1 style="margin:0 0 22px;font-family:Calistoga,Georgia,serif;font-size:36px;font-weight:400;letter-spacing:-0.02em">Every<span style="background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent">thing</span></h1>' +
      '<div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:28px">' + feedChipsHtml(entries) + '</div>' +
      groups +
    '</main>';
}
// Day-grouped feed cards reuse the Catch-Up headline card component. The day
// header markup matches the template feed (lines 350).
function feedDayGroupHtml(entries) {
  var rows = entries.slice().sort(function (a, b) { return String(b.ts).localeCompare(String(a.ts)); });
  var h = '', lastDay = '';
  for (var i = 0; i < rows.length; i++) {
    var day = homeDayLabel(rows[i].ts);
    if (day !== lastDay) {
      h += '<div style="font-family:\\'JetBrains Mono\\',monospace;font-size:10px;letter-spacing:.15em;text-transform:uppercase;color:var(--text3);margin:28px 0 4px">' + esc(day) + '</div>';
      lastDay = day;
    }
    h += catchupCardHtml(rows[i]);
  }
  return h;
}
// Delegated listener for the feed view: back link, filter chips, and card toggles.
document.getElementById('view-feed').addEventListener('click', function (e) {
  var back = e.target.closest('[data-feed="back"]');
  if (back) { location.hash = '#home'; return; }
  var chip = e.target.closest('[data-feed-chip]');
  if (chip) {
    var kind = chip.getAttribute('data-feed-chip'), val = chip.getAttribute('data-val') || null;
    feedFilters[kind] = val;
    feedFp = ''; loadFeed();
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
    return;
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
function openDel(p, name) {
  delPath = p;
  // textContent, never innerHTML: the project name is user data
  document.getElementById('delTitle').textContent = 'Remove ' + name + ' from MemBridge?';
  delOverlay.className = 'overlay open';
}
function closeDel() { delOverlay.className = 'overlay'; delPath = null; }
document.getElementById('delCancel').onclick = closeDel;
delOverlay.addEventListener('click', function (e) { if (e.target === delOverlay) closeDel(); });
delConfirm.onclick = function () {
  if (!delPath || delConfirm.disabled) return;
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

window.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  var hadModal = addOverlay.className.indexOf('open') !== -1 || delOverlay.className.indexOf('open') !== -1 ||
    removeOverlay.className.indexOf('open') !== -1 || scanOverlay.className.indexOf('open') !== -1;
  closeAdd();
  closeDel();
  closeRemove();
  closeScan();
  // Esc backs out of a project page or Settings, but only once modals are dealt with.
  if (hadModal) return;
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
    settingsKeySection() +
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
  var rows = stProjects.map(function (p) {
    var badge = p.team ? 'shared' : 'local only';
    var pauseLabel = p.paused ? 'Resume' : 'Pause';
    return '<div style="display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--border)">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13.5px;font-weight:600">' + esc(p.name) + ' <span style="' + MONO + ';font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text3);font-weight:400">' + esc(badge) + '</span></div>' +
        '<div style="' + MONO + ';font-size:10.5px;color:var(--text3);margin-top:3px">' + esc(p.path) + (p.exists === false ? ' &middot; missing' : '') + '</div></div>' +
      '<span data-proj-toggle="' + esc(p.path) + '" style="font-size:12px;color:var(--text2);cursor:pointer;font-weight:500;transition:color .2s" style-hover="color:var(--text)">' + pauseLabel + '</span>' +
      '<span data-proj-del="' + esc(p.path) + '" data-name="' + esc(p.name) + '" style="font-size:12px;color:var(--text3);cursor:pointer;transition:color .2s" style-hover="color:#DC2626">Delete</span></div>';
  }).join('');
  if (!rows) {
    rows = '<div style="padding:14px 18px;font-size:12.5px;color:var(--text3);border-bottom:1px solid var(--border)">No projects watched yet. Add one below, or use an AI tool in a folder and it appears after the next sync.</div>';
  }
  var foot =
    '<div style="display:flex;align-items:center;gap:12px;padding:13px 18px">' +
      '<span data-st-add style="font-size:13px;color:var(--accent);cursor:pointer;font-weight:600">+ Add a project&hellip;</span>' +
      '<div style="flex:1"></div>' +
      '<span style="font-size:12px;color:var(--text3)">' + toolsDetectedLine() + '</span>' +
    '</div>';
  return lbl + '<div style="' + STCARD + ';margin-bottom:34px">' + rows + foot + '</div>';
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

function settingsKeySection() {
  var lbl = '<div style="' + STLABEL + '">AI briefings &amp; roadmaps</div>';
  var hasKey = !!(stSettings && (stSettings.keySource === 'config' || stSettings.keySource === 'env'));
  var keyStatus = hasKey ? 'active' : 'no key';
  var keyStatusColor = hasKey ? 'var(--green)' : 'var(--text3)';
  return lbl +
    '<div style="' + STCARD + ';margin-bottom:34px;padding:16px 18px">' +
      '<div style="font-size:13px;color:var(--text2);margin-bottom:12px">Bring your own key. Used only to write your briefing and roadmaps &mdash; session memories never leave your team&rsquo;s sync.</div>' +
      '<div style="display:flex;gap:9px;align-items:center">' +
        '<input data-st-key type="password" placeholder="sk-ant-&hellip;" spellcheck="false" autocomplete="off" style="flex:1;height:44px;padding:0 13px;border-radius:12px;border:1px solid var(--border);background:var(--bg);color:var(--text);' + MONO + ';font-size:12px;outline:none" />' +
        '<span id="stKeyStatus" style="' + MONO + ';font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:' + keyStatusColor + ';font-weight:500;flex:none">' + keyStatus + '</span>' +
      '</div>' +
      '<div id="stKeyHint" style="font-size:11.5px;color:var(--text3);margin-top:9px">Clear the key to see the dashboard degrade gracefully &mdash; headlines and project state stay.</div>' +
    '</div>';
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
  });
  // The API-key input: on change, clear (empty) or test-then-save the key, and
  // reflect the status inline (active / testing / invalid / no key).
  settingsRoot.addEventListener('change', function (e) {
    var input = e.target.closest('[data-st-key]');
    if (!input) return;
    var v = input.value.trim();
    var status = document.getElementById('stKeyStatus');
    if (!v) {
      fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: '' }) })
        .then(function () { loadSettings(); }).catch(function () { setPill(false); });
      return;
    }
    if (status) { status.textContent = 'testing'; status.style.color = 'var(--text3)'; }
    fetch('/api/settings/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: v }) })
      .then(function (r) { return r.json(); }).then(function (d) {
        if (!d.ok) {
          if (status) { status.textContent = 'invalid'; status.style.color = '#DC2626'; }
          return;
        }
        return fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey: v }) })
          .then(function () { input.value = ''; loadSettings(); });
      }).catch(function () {
        if (status) { status.textContent = 'error'; status.style.color = '#DC2626'; }
        setPill(false);
      });
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
var pjTimer = null, pjFp = '', pjEntries = [], pjMenuOpen = false;
// Per-project Catch-Up state. Our read-state is GLOBAL (one lastViewedTs), so
// "new since" is computed against that single pointer and mark/undo advance it
// for every project — a known approximation (no per-project persistence).
var pjCatchupSince = null;
function startProject() {
  pjFp = '';
  pjEntries = [];
  pjMenuOpen = false;
  pjRoot.innerHTML = '<div class="empty">Loading&hellip;</div>';
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
  if (pjBusy) return; // mid-generate: leave the Thinking… state alone
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
  // Per-project Catch-Up headline card expand/collapse (same class-based toggle
  // as Home so an open card survives the 5s poll rebuild).
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
    return;
  }
  var pjact = e.target.closest('[data-pjact]');
  if (pjact) {
    var act = pjact.getAttribute('data-pjact');
    if (act === 'settings') { location.hash = '#settings'; return; }
    if (act === 'brief') { loadProjBriefing(pjact); return; }
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
  var gen = e.target.closest('#pjGen');
  if (gen) { generateRoadmap(gen); return; }
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
    document.getElementById('pjStream').innerHTML = dayGroupHtml(pjEntries, { hideProject: true });
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


/* ---- plan tab: goal box -> roadmap with model routing (PLAN M3) ---- */
var pjBusy = false; // a generate call is in flight: don't let polls rebuild the panel
var CHIP_INFO = {
  haiku: ['Everyday — Haiku', '#2de0a7'],
  sonnet: ['Standard — Sonnet', '#38b6ff'],
  opus: ['Hard problem — Opus', '#b48cff'],
  fable: ['Frontier — Fable', '#ffd166'],
  'codex-check': ['Cross-check — Codex', '#ff9f43'],
};
var MODEL_NAMES = {
  'claude-haiku-4-5': 'Haiku (fast & cheap)',
  'claude-sonnet-5': 'Sonnet (smarter)',
  'claude-opus-4-8': 'Opus (deepest)',
};
function chipHtml(model) {
  var c = CHIP_INFO[model] || ['AI — ' + model, '#71827d'];
  return '<span class="badge" style="color:' + c[1] + ';background:' + rgba(hexRgb(c[1]), 0.12) + '">' + esc(c[0]) + '</span>';
}
function estMoney(n) {
  return '$' + Math.max(0.01, Math.round(n * 100) / 100).toFixed(2);
}
function actMoney(n) {
  return n < 0.01 ? 'under 1¢' : '$' + n.toFixed(2);
}
function planPanelHtml(d) {
  if (!d.hasKey) {
    return '<div class="card locked">' +
      '<h3>Roadmap lives here</h3>' +
      '<p>Tell MemBridge what you want to build next and it turns that into a step-by-step plan — with the right AI model recommended for each task, so the expensive models only do the hard parts.</p>' +
      '<p>Just add your Anthropic key in <a class="mlink" href="#settings">Settings</a> to unlock roadmaps.</p></div>';
  }
  var h = '<div class="card">' +
    '<h2 style="font-size:14px">What do you want to build next?</h2>' +
    '<textarea id="pjGoal" rows="3" placeholder="Example: ship user accounts — login, password reset and a profile page" spellcheck="false">' +
    esc(d.plan ? d.plan.goal : '') + '</textarea>' +
    '<div class="st-btns">' +
    '<button class="btn primary" id="pjGen" data-path="' + esc(d.path) + '">' +
    (d.plan ? 'Regenerate' : 'Generate roadmap') + ' · ≈ ' + estMoney(d.estimate.costUsd) + ' with your key</button>' +
    '<span id="pjGenErr" class="st-result err"></span></div>' +
    '<div class="files" style="margin-top:10px">Sends to Anthropic with your key: this project’s name, your goal, recent asks (redacted), file paths touched, and top-level folder names. Never file contents, never other projects.</div>' +
    '</div>';
  if (d.plan) h += planResultHtml(d);
  return h;
}
function planResultHtml(d) {
  var p = d.plan;
  var h = '';
  if (d.lastActivity && p.generatedAt && d.lastActivity > p.generatedAt) {
    h += '<div class="stale">There has been new AI activity since this plan was generated — regenerate when you’re ready.</div>';
  }
  h += '<div class="card"><h2 style="font-size:14px">Where this project stands</h2>' +
    '<p class="psum">' + esc(p.plan.summary) + '</p></div>';
  for (var i = 0; i < p.plan.phases.length; i++) {
    var ph = p.plan.phases[i];
    h += '<div class="card"><h2 style="font-size:14px">' + (i + 1) + '. ' + esc(ph.title) + '</h2>';
    for (var j = 0; j < ph.tasks.length; j++) {
      var t = ph.tasks[j];
      h += '<div class="ptask"><div>' + esc(t.task) + '<span class="psize">' + esc(t.size) + '</span></div>' +
        '<div class="pwhy">' + esc(t.why) + '</div>' +
        '<div class="prow">' + chipHtml(t.model) + '<span class="pwhy">' + esc(t.model_reason) + '</span></div></div>';
    }
    h += '</div>';
  }
  if (p.plan.questions && p.plan.questions.length) {
    h += '<div class="card"><h2 style="font-size:14px">Decisions this plan needs from you</h2><ul class="plist">' +
      p.plan.questions.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>';
  }
  if (p.plan.risks && p.plan.risks.length) {
    h += '<div class="card"><h2 style="font-size:14px">Risks to keep in mind</h2><ul class="plist">' +
      p.plan.risks.map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul></div>';
  }
  h += '<p class="footer">Generated <span data-ago="' + esc(p.generatedAt) + '">' + esc(ago(p.generatedAt)) +
    '</span> with ' + esc(MODEL_NAMES[p.model] || p.model) + ' · actual cost ' + actMoney(p.costUsd) +
    '. The roadmap is also written into the shared memory block, so your AI tools see it too.</p>';
  return h;
}
function generateRoadmap(btn) {
  var goal = (document.getElementById('pjGoal').value || '').trim();
  var errEl = document.getElementById('pjGenErr');
  if (!goal) { errEl.textContent = 'Tell MemBridge what you want to build first.'; return; }
  errEl.textContent = '';
  pjBusy = true;
  btn.disabled = true;
  var orig = btn.textContent;
  btn.textContent = 'Thinking… this usually takes 10–30 seconds';
  fetch('/api/plan/generate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: btn.dataset.path, goal: goal }),
  }).then(function (r) {
    return r.json().then(function (d) { return { ok: r.ok, d: d }; });
  }).then(function (res) {
    pjBusy = false;
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = orig;
      errEl.textContent = (res.d && res.d.error) || 'Something went wrong — try again.';
      return;
    }
    pjFp = ''; // force the rebuild that shows the fresh plan
    loadProject();
  }).catch(function () {
    pjBusy = false;
    btn.disabled = false;
    btn.textContent = orig;
    errEl.textContent = 'Could not reach MemBridge — is it running?';
    setPill(false);
  });
}
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
// Regenerate the per-project briefing. Advances the GLOBAL briefing (it briefs
// ALL teammate activity since lastViewedTs, not only this project — a known
// approximation). pjBusy pauses polling so the "Thinking…" state isn't wiped.
function loadProjBriefing(btn) {
  if (btn.getAttribute('data-busy')) return;
  btn.setAttribute('data-busy', '1');
  pjBusy = true;
  var box = document.getElementById('pjBriefingBody');
  if (box) box.textContent = 'Thinking…';
  fetch('/api/briefing/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ since: pjCatchupSince }) })
    .then(function (r) { return r.json(); }).then(function (d) {
      pjBusy = false;
      btn.removeAttribute('data-busy');
      if (d.degraded) { if (box) box.textContent = 'AI briefing off.'; return; }
      if (box) box.textContent = d.text || '';
      pjFp = ''; // let the next poll reconcile cached state
    }).catch(function () { pjBusy = false; btn.removeAttribute('data-busy'); if (box) box.textContent = 'Briefing unavailable right now.'; });
}
// The per-project Catch-Up section (template lines 453–585). Header pill + since
// anchor + Mark-as-caught-up, then either the caught-up card, an offline note,
// or the body (briefing / no-key hint + teammate headlines since the pointer).
function pjCatchupHtml(cx, shared) {
  var cu = cx.cu || {};
  var offline = cx.offline;
  var hasKey = cx.hasKey;
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
    // showProjCatchupBody (template lines 483–584): briefing / no-key hint + headlines
    var briefing = '';
    if (hasKey && shared) {
      // AI briefing inverted card (template lines 486–503). Briefs all teammate
      // activity since the pointer, not only this project (known approximation).
      briefing = '<div style="position:relative;border-radius:20px;background:var(--inv);color:var(--inv-text);padding:26px 28px 24px;margin-bottom:34px;box-shadow:var(--shadow-xl);overflow:hidden">' +
        '<div style="position:absolute;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,1) 1px,transparent 1px);background-size:32px 32px;opacity:.04;pointer-events:none"></div>' +
        '<div style="position:absolute;top:-140px;right:-100px;width:380px;height:380px;border-radius:50%;background:#4D7CFF;opacity:.14;filter:blur(120px);pointer-events:none"></div>' +
        '<div style="display:flex;align-items:center;gap:9px;margin-bottom:14px;position:relative">' +
          '<span style="background:linear-gradient(135deg,#6E93FF,#9DB7FF);-webkit-background-clip:text;background-clip:text;color:transparent;font-size:12px">&#10022;</span>' +
          '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:rgba(248,250,252,.5)">Briefing &middot; AI-generated</span>' +
          '<div style="flex:1"></div>' +
          '<span data-pjact="brief" style="font-size:12px;color:rgba(248,250,252,.45);cursor:pointer;display:flex;align-items:center;gap:5px;transition:color .2s" style-hover="color:rgba(248,250,252,.8)"><span>&#8635;</span>' + ((cu.briefing && cu.briefing.text) ? 'Regenerate' : 'Generate') + '</span>' +
        '</div>' +
        '<p id="pjBriefingBody" style="margin:0;font-size:16px;line-height:1.7;color:var(--inv-text);text-wrap:pretty;position:relative;transition:opacity .3s">' +
          ((cu.briefing && cu.briefing.text) ? esc(cu.briefing.text) : 'No briefing yet — regenerate to get a written summary. The headlines below tell the same story.') + '</p>' +
        '</div>';
    } else if (!hasKey) {
      // no-key hint (template lines 504–506)
      briefing = '<div style="color:var(--text3);font-size:12.5px;margin-bottom:26px;padding:12px 16px;border:1px dashed var(--border2);border-radius:12px">AI briefing off — <span data-pjact="settings" style="color:var(--accent);cursor:pointer;font-weight:600">add an API key</span> in Settings to get a written summary here. The headlines below tell the same story.</div>';
    }
    var headlines = newSessions.map(function (e) { return catchupCardHtml(e); }).join('');
    body = briefing + headlines;
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
    '<div class="pj-back pj-close" title="Back to projects" style="font-size:12.5px;color:var(--text3);cursor:pointer;margin-bottom:16px;display:inline-block">&larr; Projects</div>' +
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

  // One merged, day-grouped stream (local + team, deduped server-side).
  var stream = entries.length
    ? dayGroupHtml(entries, { hideProject: true })
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

  // Roadmap: collapsed at the bottom; team-only projects have no local key/plan.
  if (local) {
    h += '<details class="roadmap" style="border:1px solid var(--border);border-radius:16px;background:var(--card);margin:18px 0 8px;overflow:hidden;box-shadow:var(--shadow-md);border-top:1px solid var(--border);padding-top:0">' +
      '<summary style="display:flex;align-items:center;gap:11px;padding:15px 18px;cursor:pointer;color:var(--text);text-transform:none;letter-spacing:0">' +
        '<span style="font-size:13.5px;font-weight:600">Roadmap</span>' +
        '<span style="font-size:12px;color:var(--text3)">generated from this project&rsquo;s memory</span>' +
        '<div style="flex:1"></div>' +
        '<span style="font-family:\\'JetBrains Mono\\',monospace;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--accent)">&#10022; uses your API key</span>' +
      '</summary>' +
      '<div style="padding:4px 18px 20px;border-top:1px solid var(--border)">' + planPanelHtml(detail) + '</div>' +
      '</details>';
  }

  // A rebuild must not eat a goal the user is typing, nor snap a section shut.
  var oldGoal = document.getElementById('pjGoal');
  var goalDraft = oldGoal ? oldGoal.value : null;
  var goalHadFocus = oldGoal && document.activeElement === oldGoal;
  var oldRoadmap = document.querySelector('#view-project .roadmap');
  var roadmapWasOpen = !!(oldRoadmap && oldRoadmap.open);

  pjRoot.innerHTML = h;
  renderSyncBanner(!!feed.teamUnavailable); // amber under-header banner mirrors the degraded state
  // Click handling is delegated on pjRoot (survives this rebuild).
  var newRoadmap = document.querySelector('#view-project .roadmap');
  if (newRoadmap && roadmapWasOpen) newRoadmap.open = true;
  var newGoal = document.getElementById('pjGoal');
  if (newGoal && goalDraft !== null) newGoal.value = goalDraft;
  if (newGoal && goalHadFocus) newGoal.focus();
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
