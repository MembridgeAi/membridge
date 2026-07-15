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
<script>try { var mbTheme = localStorage.getItem('mb-theme'); if (mbTheme === 'light' || mbTheme === 'dark') document.documentElement.style.colorScheme = mbTheme; } catch (e) { /* storage unavailable: stay on system */ }</script>
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
body.signed-out header, body.signed-out #view-home, body.signed-out #view-project,
body.signed-out #view-settings { display: none !important; }

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
.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 20px 24px; margin-bottom: 16px;
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
#view-project .inner { max-width: 860px; margin: 0 auto; padding: 32px 28px 64px; }
.pj-head { display: flex; align-items: flex-start; gap: 12px; }
.pj-head .grow { min-width: 0; } /* let the nowrap path shrink, not push the buttons out */
.pj-head h2 { font-size: 20px; font-weight: 650; margin: 0; display: inline; }
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
  background: var(--card); border: 1px solid var(--border); border-radius: 12px;
  box-shadow: var(--shadow-sm); padding: 6px; display: none;
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
/* ---------- unified summary-first feed entry (scoped so the team module's
   own bare .fentry / .fask rules, injected later in the cascade, never bleed
   into the Home feed) ---------- */
#view-home .fentry, #view-project .fentry {
  display: block; padding: 14px 2px; border-bottom: 1px solid var(--border);
}
#view-home .fentry:last-child, #view-project .fentry:last-child { border-bottom: none; }
#view-home .fentry.pending, #view-project .fentry.pending {
  border-left: 2px dashed color-mix(in srgb, var(--accent) 45%, transparent);
  padding-left: 12px; opacity: .82;
}
#view-home .fmeta, #view-project .fmeta {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  color: var(--muted); font-size: 12px;
}
#view-home .favatar, #view-project .favatar {
  flex: none; width: 22px; height: 22px; border-radius: 7px; color: #fff;
  display: inline-flex; align-items: center; justify-content: center;
  font: 600 11px/1 var(--mono);
}
#view-home .fperson, #view-home .fproj,
#view-project .fperson, #view-project .fproj {
  background: none; border: none; padding: 0; margin: 0; cursor: pointer;
  font: inherit; font-size: 12.5px; color: var(--text);
}
#view-home .fperson, #view-project .fperson { font-weight: 650; }
#view-home .fperson:hover, #view-project .fperson:hover { color: var(--accent); }
#view-home .fproj, #view-project .fproj {
  color: var(--muted); border: 1px solid var(--border); border-radius: 999px;
  padding: 1px 9px; font-size: 11px;
}
#view-home .fproj:hover, #view-project .fproj:hover { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
#view-home .fago, #view-project .fago { margin-left: auto; white-space: nowrap; }
#view-home .fsummary, #view-project .fsummary {
  margin-top: 6px; font-size: 13.5px; line-height: 1.5; color: var(--text);
  cursor: pointer; overflow: hidden; display: -webkit-box;
  -webkit-box-orient: vertical; -webkit-line-clamp: 3;
}
#view-home .fsummary.expanded, #view-project .fsummary.expanded { -webkit-line-clamp: unset; }
#view-home .fsummary.distilled, #view-project .fsummary.distilled { border-left: 2px solid color-mix(in srgb, var(--accent) 55%, transparent); padding-left: 10px; }
#view-home .fask, #view-project .fask { margin-top: 4px; font-size: 12px; color: var(--muted); }
#view-home .fworking, #view-project .fworking { margin-top: 6px; font-size: 13.5px; font-style: italic; color: var(--text); }
#view-home .fhint, #view-project .fhint {
  font-style: normal; font: 600 9.5px/1 var(--mono); letter-spacing: .08em;
  text-transform: uppercase; color: var(--accent); margin-left: 4px;
}
#view-home .feed-day, #view-project .feed-day {
  margin: 18px 0 6px; color: var(--muted);
  font: 600 10px/1 var(--mono); letter-spacing: .1em; text-transform: uppercase;
}
#view-home .feed-day:first-child, #view-project .feed-day:first-child { margin-top: 0; }
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
  font: inherit; font-size: 11.5px; padding: 3px 11px; border-radius: 999px;
  border: 1px solid var(--border); background: transparent; color: var(--muted);
}
.chips .chip:hover { color: var(--text); border-color: var(--muted); }
.chips .chip.on {
  color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
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

/* ---------- Minimalist Modern design system ---------- */
:root {
  color-scheme: light dark;
  --bg: light-dark(#fafafa, #0a0e14);
  --bg2: light-dark(rgba(250,250,250,.88), rgba(10,14,20,.88));
  --card: light-dark(#fff, #111826);
  --border: light-dark(#e2e8f0, #1f2937);
  --text: light-dark(#0f172a, #e5eaf3);
  --muted: light-dark(#64748b, #8b96a8);
  --accent: light-dark(#0052ff, #4d7cff);
  --accent2: light-dark(#4d7cff, #7c9dff);
  --danger: light-dark(#dc2626, #f87171);
  --ok: light-dark(#047857, #34d399);
  --ok-dot: light-dark(#10b981, #34d399);
  --surface-subtle: light-dark(#f1f5f9, #1a2332);
  --surface-raised: light-dark(#f8fafc, #151d2b);
  --glass: light-dark(rgba(250,250,250,.84), rgba(10,14,20,.8));
  --glass-border: light-dark(rgba(226,232,240,.9), rgba(31,41,55,.9));
  --btn-bg: light-dark(rgba(255,255,255,.74), rgba(255,255,255,.06));
  --warn: light-dark(#b45309, #fbbf24);
  --radius: 16px;
  --shadow-sm: 0 1px 3px light-dark(rgba(15,23,42,.06), rgba(0,0,0,.45));
  --shadow-md: 0 8px 24px light-dark(rgba(15,23,42,.07), rgba(0,0,0,.5));
  --shadow-lg: 0 20px 45px light-dark(rgba(15,23,42,.1), rgba(0,0,0,.55));
  --shadow-accent: 0 12px 28px light-dark(color-mix(in srgb, var(--accent) 22%, transparent), rgba(77,124,255,.3));
  --display: Georgia, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
body {
  background:
    radial-gradient(700px 420px at 8% -8%, color-mix(in srgb, var(--accent) 7.5%, transparent), transparent 65%),
    radial-gradient(600px 380px at 92% 110%, color-mix(in srgb, var(--accent2) 5.5%, transparent), transparent 70%),
    var(--bg);
  color: var(--text); font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
header {
  height: 72px; padding: 0 28px; gap: 22px; z-index: 20;
  background: var(--glass); border-color: var(--glass-border);
  backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
}
.brand { gap: 11px; font-weight: 760; font-size: 16px; letter-spacing: -.02em; }
.brand .dot, .auth-brand .dot {
  background: url("${ICON_DATAURI}") center/contain no-repeat;
}
.brand .dot { width: 28px; height: 28px; border-radius: 9px; box-shadow: var(--shadow-accent); }
.pill { display: inline-flex; align-items: center; gap: 8px; border: 0; color: var(--ok); background: color-mix(in srgb, var(--ok) 12%, transparent); padding: 7px 11px; font: 600 11px/1 var(--mono); text-transform: uppercase; letter-spacing: .08em; }
.pill::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--ok-dot); animation: pulse 2.2s infinite; }
.pill.off { color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.pill.off::before { background: var(--danger); animation: none; }
button.btn { min-height: 40px; padding: 0 16px; border-radius: 11px; border-color: var(--border); background: var(--btn-bg); color: var(--text); font-weight: 650; box-shadow: var(--shadow-sm); transition: transform .2s ease, box-shadow .2s ease, border-color .2s ease; }
button.btn:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--accent) 28%, transparent); box-shadow: var(--shadow-md); }
button.btn.primary { color: #fff; border-color: transparent; background: linear-gradient(135deg,var(--accent),var(--accent2)); box-shadow: 0 6px 16px color-mix(in srgb, var(--accent) 20%, transparent); }
button.btn.primary:hover { box-shadow: var(--shadow-accent); filter: brightness(1.04); }
button.btn.ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--muted); }
button.btn.danger { color: var(--danger); background: var(--card); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
button.btn:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 22%, transparent); outline-offset: 2px; }
button.btn:active { transform: scale(.98); }
.overlay { background: light-dark(rgba(15,23,42,.54), rgba(0,0,0,.6)); backdrop-filter: blur(6px); }
.modal { border-radius: 20px; padding: 28px; box-shadow: 0 24px 80px light-dark(rgba(15,23,42,.22), rgba(0,0,0,.6)); }
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
.section-label { display: inline-flex; align-items: center; gap: 9px; padding: 7px 12px; border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--accent) 4.5%, transparent); color: var(--accent); font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.section-label::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 2.2s infinite; }
.page-title { margin: 15px 0 12px; font: 400 clamp(38px,5vw,60px)/1.02 var(--display); letter-spacing: -.04em; }
.gradient-text { font-style: normal; color: transparent; background: linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip: text; background-clip: text; }
.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin: 0 0 16px; }
.section-head h2 { margin: 0; font: 400 29px/1.15 var(--display); letter-spacing: -.025em; }
.section-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.card { border-radius: var(--radius); box-shadow: var(--shadow-sm); }
.pcard { min-height: 182px; padding: 22px; position: relative; overflow: hidden; transition: transform .25s,box-shadow .25s,border-color .25s; }
.pcard::after { content: '→'; position: absolute; right: 20px; bottom: 18px; color: var(--accent); font-size: 19px; transition: transform .2s; }
.pcard:hover { border-color: color-mix(in srgb, var(--accent) 30%, transparent); transform: translateY(-3px); box-shadow: var(--shadow-lg); }
.pcard:hover::after { transform: translateX(4px); }
.pcard h2 { font-size: 17px; letter-spacing: -.02em; }
.path, .afiles { font-family: var(--mono); }
.badge { font: 600 10px/1.5 var(--mono); border: 1px solid currentColor; }
.chip { border-color: color-mix(in srgb, var(--danger) 35%, transparent); color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent); }
.team-chip { display: inline-flex; align-items: center; gap: 6px; margin-top: 12px; padding: 5px 9px; border-radius: 999px; color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); font: 600 10px/1 var(--mono); }
.team-chip::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
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
.avatar { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 14px; color: #fff; background: linear-gradient(135deg,var(--accent),var(--accent2)); font-weight: 800; box-shadow: 0 7px 18px color-mix(in srgb, var(--accent) 20%, transparent); }
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
  <div class="auth-page">
    <section class="auth-story">
      <div class="auth-brand"><span class="dot"></span>MemBridge</div>
      <div class="auth-copy">
        <span class="section-label">Memory infrastructure for AI teams</span>
        <h1>One memory.<br><span class="gradient-text">Every agent.</span></h1>
        <p>Keep your team and every coding agent aligned with a living memory of what changed, why it changed, and what comes next.</p>
        <div class="auth-proof"><span>Private by default</span><span>Redacted before sync</span><span>Built for teams</span></div>
      </div>
      <div class="path" style="color:rgba(255,255,255,.38)">AI context, without the re-explaining.</div>
    </section>
    <section class="auth-panel"><div class="auth-panel-inner" id="authRoot"></div></section>
  </div>
</div>

<header>
  <div class="brand" id="goHome"><span class="dot"></span>MemBridge</div>
  <span class="grow"></span>
  <span class="pill" id="pill" title="Click to sync now">Running</span>
  <button class="btn" id="openInvite" title="Invite teammates">Invite</button>
  <button class="btn" id="openSettings" title="Settings">&#9881;</button>
</header>

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

<div id="view-home"><div class="inner">
  <div id="homeSuggest"></div>
  <div id="homeChips" class="chips"></div>
  <div id="homeNotice"></div>
  <div id="homeFeed"></div>
  <div id="homeMore"></div>
</div></div>

<div id="view-project">
  <div class="inner" id="pjRoot"></div>
</div>

<div id="view-settings">
  <div class="inner">
    <div class="pj-head">
      <div class="grow"><h2>Settings</h2>
        <div class="path" style="margin-top:4px">Everything here stays on this machine unless it says otherwise.</div></div>
      <button class="pj-close" id="stClose" title="Back">&times;</button>
    </div>

    <div id="teamSettingsRoot" style="margin-top:22px"></div>

    <div class="card" id="stProjects">
      <div class="hub-card-head"><h2 style="font-size:15px">Projects</h2></div>
      <p class="m-help" style="margin-top:2px">Folders MemBridge watches on this Mac. Add one, pause its
        syncing, open it, or remove it. This is the way to reach a project that has no recent activity.</p>
      <div class="st-btns" style="margin-top:12px">
        <button class="btn primary" id="stAddProject">Add a project</button>
        <button class="btn" id="stScan">Detected tools</button>
      </div>
      <div id="stProjectList" style="margin-top:14px"></div>
    </div>

    <div class="card" style="margin-top:22px">
      <h2 style="font-size:14px">Appearance</h2>
      <p class="m-help" style="margin-top:6px">System follows your OS light/dark setting.</p>
      <div id="stTheme">
        <label class="radio"><input type="radio" name="stTheme" value="system"> System</label>
        <label class="radio"><input type="radio" name="stTheme" value="light"> Light</label>
        <label class="radio"><input type="radio" name="stTheme" value="dark"> Dark</label>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size:14px">Anthropic API key</h2>
      <p class="m-help" style="margin-top:6px">Unlocks roadmaps on every project&rsquo;s Plan tab.
        Your key stays in <code>~/.membridge/config.json</code> on this machine. It is never written
        into any project folder and never synced.</p>
      <div id="stKeyStatus" class="files" style="margin:0 0 10px"></div>
      <input id="stKey" type="password" placeholder="sk-ant-..." autocomplete="off" spellcheck="false">
      <div class="st-btns">
        <button class="btn" id="stTest" title="Sends one tiny test request (just the word: hi) to the Anthropic API with this key. Nothing else leaves this machine.">Test key</button>
        <button class="btn primary" id="stSaveKey">Save key</button>
        <button class="btn del" id="stRemoveKey" style="display:none">Remove key</button>
        <span id="stKeyResult" class="st-result"></span>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size:14px">Planner model</h2>
      <p class="m-help" style="margin-top:6px">Which Claude model writes your roadmaps. Costs are per roadmap, paid with your key. Change it any time.</p>
      <div id="stModels"></div>
      <div class="st-btns"><span id="stModelResult" class="st-result"></span></div>
    </div>

    <div class="card">
      <h2 style="font-size:14px">Syncing</h2>
      <p class="m-help" style="margin-top:6px">How often MemBridge checks your AI tools for new activity,
        and which context files the shared memory is written into.</p>
      <div class="st-row"><label for="stInterval">Check every</label>
        <input id="stInterval" type="number" min="15" step="5"> <span class="files">seconds</span></div>
      <div class="st-row"><label for="stTargets">Context files</label>
        <input id="stTargets" type="text" placeholder="CLAUDE.md, AGENTS.md" spellcheck="false"></div>
      <div class="st-btns">
        <button class="btn primary" id="stSaveSync">Save</button>
        <span id="stSyncResult" class="st-result"></span>
      </div>
    </div>

    <div class="card">
      <h2 style="font-size:14px">Session summaries</h2>
      <p class="m-help" style="margin-top:6px">When an AI tool finishes work, MemBridge can ask it to leave a
        short note for your other tools.</p>
      <label class="radio" style="width:auto; display:inline-flex">
        <input id="stDistillEnabled" type="checkbox"><span>Summaries</span>
      </label>
      <div id="stHookStatus" class="files" style="margin:8px 0 0"></div>
      <div class="card" style="margin-top:16px; padding:16px">
        <h2 style="font-size:12.5px">Advanced</h2>
        <div class="st-row"><label for="stMinEdits">Ask after</label>
          <input id="stMinEdits" type="number" min="1" step="1"> <span class="files">edits</span></div>
        <div class="st-row"><label for="stCheckpointEvery">Re-ask every</label>
          <input id="stCheckpointEvery" type="number" min="1" step="1"> <span class="files">edits</span></div>
        <div class="st-btns">
          <button class="btn primary" id="stSaveDistill">Save</button>
          <span id="stDistillResult" class="st-result"></span>
        </div>
      </div>
    </div>

    <details class="card" id="stTeamBackendCard">
      <summary><h2 style="font-size:14px">Advanced: self-hosted backend</h2></summary>
      <p class="m-help" style="margin-top:10px">Point MemBridge at your own Supabase backend instead of the hosted one.</p>
      <div class="st-row"><label for="stTeamUrl">URL</label>
        <input id="stTeamUrl" type="url" placeholder="https://....supabase.co" spellcheck="false"></div>
      <div class="st-row"><label for="stTeamAnonKey">Anon key</label>
        <input id="stTeamAnonKey" type="password" placeholder="eyJ..." autocomplete="off" spellcheck="false"></div>
      <div id="stTeamBackendStatus" class="files" style="margin:0 0 10px"></div>
      <div class="st-btns">
        <button class="btn primary" id="stSaveTeamBackend">Save</button>
        <button class="btn" id="stResetTeamBackend">Reset to default</button>
        <span id="stTeamBackendResult" class="st-result"></span>
      </div>
    </details>
  </div>
</div>

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
var setPill = function (ok) {
  pillEl.textContent = ok ? 'Running' : 'Unreachable';
  pillEl.className = ok ? 'pill' : 'pill off';
};

/* ================= tabs & lifecycle ================= */
// Views: #home (unified feed), #project=<path> (one project, level 2 of
// max 2), #settings. Hash routing means browser-back exits a project page.
var currentTab = function () {
  if (document.body.className.indexOf('signed-out') !== -1) return 'auth';
  if (location.hash === '#settings') return 'settings';
  if (location.hash.indexOf('#project=') === 0) return 'project';
  return 'home';
};
var currentProjPath = function () {
  try { return decodeURIComponent(location.hash.slice(9)); } catch (err) { return ''; }
};
function applyTab() {
  var t = currentTab();
  document.getElementById('view-auth').className = t === 'auth' ? 'active' : '';
  document.getElementById('view-home').className = t === 'home' ? 'active' : '';
  document.getElementById('view-project').className = t === 'project' ? 'active' : '';
  document.getElementById('view-settings').className = t === 'settings' ? 'active' : '';
  applyRun();
}
// Start/stop polling and the render loop for whichever view is active.
function applyRun() {
  stopHome();
  stopProject();
  if (document.hidden) return;
  var t = currentTab();
  if (t === 'home') startHome();
  else if (t === 'project') startProject();
  else if (t === 'settings') loadSettings(); // one fetch, no polling: it would clobber typing
  else if (t === 'auth') loadTeam();
}
window.addEventListener('hashchange', applyTab);
document.addEventListener('visibilitychange', applyRun);

/* ================= header actions ================= */
// Jump the user to the invite/team section of Settings. The anchor is added by
// the Settings team section (Task 16); null-guard until then.
var pendingInviteScroll = false;
function scrollToInvite() {
  var el = document.getElementById('settings-invite');
  if (el && el.scrollIntoView) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
  return false;
}
// The status pill doubles as the sync control: one poke syncs, then Home
// refreshes if it is the active view.
var pillBtn = document.getElementById('pill');
function syncNow() {
  if (pillBtn.classList.contains('busy')) return;
  pillBtn.classList.add('busy');
  fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    .then(function () {
      if (currentTab() === 'home') { homeFp = ''; loadHome(); }
    })
    .catch(function () { setPill(false); })
    .then(function () { pillBtn.classList.remove('busy'); });
}
document.getElementById('goHome').onclick = function () { location.hash = '#home'; };
pillBtn.onclick = syncNow;
document.getElementById('openInvite').onclick = function () {
  pendingInviteScroll = true; // the invite anchor mounts after the async team render
  location.hash = '#settings';
  setTimeout(function () { if (scrollToInvite()) pendingInviteScroll = false; }, 0);
};
document.getElementById('openSettings').onclick = function () { location.hash = '#settings'; };

/* ================= theme ================= */
function themePref() {
  try {
    var t = localStorage.getItem('mb-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch (e) { return 'system'; }
}
function applyTheme(pref) {
  document.documentElement.style.colorScheme =
    pref === 'light' || pref === 'dark' ? pref : 'light dark';
  try {
    if (pref === 'light' || pref === 'dark') localStorage.setItem('mb-theme', pref);
    else localStorage.removeItem('mb-theme');
  } catch (e) { /* non-persistent session */ }
}
(function initTheme() {
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
function startHome() { homeFp = ''; loadHome(); homeTimer = setInterval(loadHome, 5000); }
function stopHome() { if (homeTimer) { clearInterval(homeTimer); homeTimer = null; } }
function feedUrl() {
  var q = ['limit=50'];
  if (homeFilters.author) q.push('author=' + encodeURIComponent(homeFilters.author));
  if (homeFilters.project) q.push('project=' + encodeURIComponent(homeFilters.project));
  if (homeFilters.source) q.push('source=' + encodeURIComponent(homeFilters.source));
  return '/api/feed?' + q.join('&');
}
function loadHome() {
  fetch(feedUrl()).then(function (r) { return r.json(); }).then(function (d) {
    setPill(true);
    // Rebuild only when the payload changed: rewriting innerHTML every poll
    // destroys text selection, hover, and any expanded summaries.
    var fp = JSON.stringify(d);
    if (fp === homeFp) { refreshAgo('view-home'); return; }
    homeFp = fp; renderHome(d);
  }).catch(function () { setPill(false); });
}
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
  if (goTeam) { location.hash = '#settings'; setTimeout(scrollToInvite, 0); return; }
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
    if (res.ok) { closeAdd(); if (currentTab() === 'settings') loadProjectsSettings(); else loadHome(); return; } // added or already tracked
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
    else if (currentTab() === 'settings') loadProjectsSettings();
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
  var adapterRows = d.adapters.map(function (a) {
    return '<div class="scan-row"><span class="tool">' + esc(a.displayName) + '</span>' +
      '<span class="root">' + esc(a.root) + '</span>' +
      (a.exists ? '' : '<span class="missing">(not found)</span>') + '</div>';
  }).join('') || '<div class="scan-row"><span class="root">No adapters configured.</span></div>';
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
function loadSettings() {
  loadTeamSettings();     // team management section (reuses the team module)
  loadProjectsSettings(); // watched-projects list
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) {
    setPill(true);
    renderSettings(d);
  }).catch(function () { setPill(false); });
}

/* ---- Settings: Team management (reuses lib/dashboard-team.js builders) ----
   The team-module handlers (handleTeamClick/Change/Submit) drive every action;
   on success they call loadTeam()/renderCurrent(), both of which route back to
   renderTeamSettings when the Settings tab is active. */
function loadTeamSettings() {
  var host = document.getElementById('teamSettingsRoot');
  if (!host) return;
  fetch('/api/team').then(function (r) { return r.json(); })
    .then(function (d) { renderTeamSettings(d); })
    .catch(function () {
      host.innerHTML = '<div class="card"><div class="notice error">Team workspace unavailable. ' +
        'Local sync keeps working; this recovers when the backend is reachable.</div></div>';
    });
}
function renderTeamSettings(d) {
  var host = document.getElementById('teamSettingsRoot');
  if (!host) return;
  teamState = d;
  if (!d || !d.authenticated) { host.innerHTML = ''; return; }
  var teams = d.teams || [];
  if (!teams.length) { curTeam = null; pendingInviteScroll = false; host.innerHTML = noTeamSettingsHtml(d); return; }
  var sel = null;
  for (var i = 0; i < teams.length; i++) if (teams[i].team_id === teamSelId) sel = teams[i];
  if (!sel) sel = teams[0];
  rememberTeam(sel.team_id);
  var tid = sel.team_id;
  Promise.all([
    apiGet('/api/team/members?teamId=' + encodeURIComponent(tid)),
    apiGet('/api/team/projects?teamId=' + encodeURIComponent(tid)),
  ]).then(function (res) {
    if (currentTab() !== 'settings') return; // navigated away mid-fetch
    curTeam = sel;
    curSub = { kind: 'hub' };
    hubMembers = res[0].members || [];
    hubProjects = res[1].projects || [];
    host.innerHTML = teamSettingsHtml(d, sel);
    if (pendingInviteScroll) { pendingInviteScroll = false; scrollToInvite(); }
  }).catch(function (err) {
    curTeam = sel;
    host.innerHTML = '<div class="card"><div class="notice error">' + esc(err.message) + '</div></div>';
  });
}
// Compose the management panels. Reuses the team-module builders verbatim
// (invitePanelHtml / settingsPanelHtml / createJoinPanelHtml / shareCardHtml);
// only the members list and the team switcher are settings-specific wrappers.
function teamSettingsHtml(d, team) {
  var teams = d.teams || [];
  var switcher;
  if (teams.length > 1) {
    switcher = '<select class="hub-switch" data-team-change="switch" aria-label="Switch team">' +
      teams.map(function (t) {
        return '<option value="' + esc(t.team_id) + '"' + (t.team_id === team.team_id ? ' selected' : '') +
          '>' + esc(t.team_name) + '</option>';
      }).join('') + '</select>';
  } else {
    switcher = '<h2 style="font-family:var(--display);font-size:26px;font-weight:400;margin:0 0 6px">' +
      esc(team.team_name) + '</h2>';
  }
  var stat = '<div class="hub-stat-line" style="margin-bottom:14px"><span class="role-badge">' + esc(team.role) + '</span>' +
    '<span>' + hubMembers.length + ' member' + (hubMembers.length === 1 ? '' : 's') + ' &middot; ' +
    hubProjects.length + ' project' + (hubProjects.length === 1 ? '' : 's') + '</span></div>';
  return switcher + stat + teamNoticeHtml() +
    membersSettingsHtml(d, team) +
    '<div id="settings-invite">' + invitePanelHtml(d, team) + '</div>' +
    settingsPanelHtml(d, team) +
    createJoinPanelHtml('create') +
    createJoinPanelHtml('join') +
    shareCardHtml(d, team);
}
// Members with inline role/remove controls (owner/admin gated), reusing the
// exact data-team-change="set-role" / data-team-action="remove-member" wiring.
function membersSettingsHtml(d, team) {
  var rows = hubMembers.map(function (m) {
    var self = d.user && d.user.userId === m.user_id;
    var controls = '';
    if (team.role === 'owner' && m.role !== 'owner' && !self) {
      controls += '<select class="role-select" data-team-change="set-role" data-user-id="' + esc(m.user_id) + '" aria-label="Role">' +
        '<option value="member"' + (m.role === 'member' ? ' selected' : '') + '>member</option>' +
        '<option value="admin"' + (m.role === 'admin' ? ' selected' : '') + '>admin</option></select>';
    }
    if ((team.role === 'owner' || team.role === 'admin') && m.role !== 'owner' && !self) {
      controls += '<button class="btn del" data-team-action="remove-member" data-user-id="' + esc(m.user_id) + '">Remove</button>';
    }
    return '<div class="mem-row">' + avatarHtml(m.user_id, m.display_name) +
      '<div class="grow"><strong>' + esc(m.display_name) +
      (self ? ' <span style="color:var(--muted);font-weight:400">(you)</span>' : '') + '</strong>' +
      '<small class="role-badge" style="border:none;padding:0;background:none">' + esc(m.role) + '</small></div>' +
      controls + '</div>';
  }).join('');
  var solo = hubMembers.length === 1;
  return '<div class="card"><div class="hub-card-head"><h2>Members</h2><span class="path">' + hubMembers.length + '</span></div>' +
    rows +
    (solo ? '<p class="m-help" style="margin:10px 0 4px">It\\u2019s just you so far. Create an invite below to bring in your team.</p>' : '') +
    '</div>';
}
// Signed in, but not in any team yet: create/join plus the account row.
function noTeamSettingsHtml(d) {
  return '<div class="card"><div class="hub-card-head"><h2>You\\u2019re not in a team yet</h2></div>' +
    '<p class="m-help">Create a workspace or join one with an invite. Until then your AI activity stays local to this Mac.</p></div>' +
    createJoinPanelHtml('create') + createJoinPanelHtml('join') + accountRowHtml(d);
}
function accountRowHtml(d) {
  return '<div class="card"><div class="hub-card-head"><h2>Account</h2></div>' +
    '<div class="profile">' + avatarHtml(d.user.userId, d.user.displayName) +
    '<div class="grow"><strong>' + esc(d.user.displayName) + '</strong><div class="path">' + esc(d.user.email) + '</div></div>' +
    (d.webUrl ? '<a class="btn" href="' + esc(d.webUrl) + '" target="_blank" rel="noopener" style="text-decoration:none">Open web workspace &nearr;</a>' : '') +
    '<button class="btn ghost" data-team-action="logout">Log out</button></div></div>';
}
// The team-management handlers live in the team module; point their event
// delegation at the Settings container (mirrors the auth-gate wiring).
var teamSettingsRoot = document.getElementById('teamSettingsRoot');
if (teamSettingsRoot) {
  teamSettingsRoot.addEventListener('click', handleTeamClick);
  teamSettingsRoot.addEventListener('change', handleTeamChange);
  teamSettingsRoot.addEventListener('submit', handleTeamSubmit);
}

/* ---- Settings: watched-projects list (add / scan / pause / delete / open) ---- */
function loadProjectsSettings() {
  var host = document.getElementById('stProjectList');
  if (!host) return;
  fetch('/api/projects').then(function (r) { return r.json(); }).then(function (projects) {
    host.innerHTML = projectsSettingsHtml(projects || []);
  }).catch(function () { host.innerHTML = '<div class="empty">Could not load projects.</div>'; });
}
function projectsSettingsHtml(projects) {
  if (!projects.length) {
    return '<div class="empty">No projects watched yet. Add one above, or use an AI tool in a folder and it appears after the next sync.</div>';
  }
  return projects.map(function (p) {
    return '<div class="mem-row"><div class="grow">' +
      '<a class="mlink" style="cursor:pointer" data-open-project="' + esc(p.path) + '"><strong>' + esc(p.name) + '</strong></a>' +
      '<small class="path">' + esc(p.path) +
      (p.paused ? ' &middot; paused' : '') + (p.exists === false ? ' &middot; missing' : '') +
      (p.team ? ' &middot; shared' : '') + '</small></div>' +
      '<button class="btn" data-proj-toggle="' + esc(p.path) + '">' + (p.paused ? 'Resume' : 'Pause') + '</button>' +
      '<button class="btn del" data-proj-del="' + esc(p.path) + '" data-name="' + esc(p.name) + '">Delete</button>' +
      '</div>';
  }).join('');
}
var stProjectList = document.getElementById('stProjectList');
if (stProjectList) {
  stProjectList.addEventListener('click', function (e) {
    var open = e.target.closest('[data-open-project]');
    if (open) { location.hash = '#project=' + encodeURIComponent(open.getAttribute('data-open-project')); return; }
    var tog = e.target.closest('[data-proj-toggle]');
    if (tog) {
      if (!armed(tog)) return; // toggles server-side: guard against double-click revert
      tog.disabled = true;
      fetch('/api/projects/toggle', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: tog.getAttribute('data-proj-toggle') }),
      }).then(function () { loadProjectsSettings(); })
        .catch(function () { tog.disabled = false; setPill(false); });
      return;
    }
    var del = e.target.closest('[data-proj-del]');
    if (del) { openDel(del.getAttribute('data-proj-del'), del.getAttribute('data-name') || del.getAttribute('data-proj-del')); return; }
  });
}
var stAddProject = document.getElementById('stAddProject');
if (stAddProject) stAddProject.onclick = openAdd;
var stScan = document.getElementById('stScan');
if (stScan) stScan.onclick = openScan;
function renderSettings(d) {
  var status = document.getElementById('stKeyStatus');
  if (d.keySource === 'config') {
    status.innerHTML = '&#10003; A key ending ' + esc(d.keyHint) + ' is saved.';
  } else if (d.keySource === 'env') {
    status.textContent = 'Using the ANTHROPIC_API_KEY from your environment. Saving a key here overrides it.';
  } else {
    status.textContent = 'No key yet — get one at console.anthropic.com, then paste it here.';
  }
  document.getElementById('stRemoveKey').style.display = d.keySource === 'config' ? '' : 'none';
  var models = document.getElementById('stModels');
  models.innerHTML = d.models.map(function (m) {
    return '<label class="radio' + (m.id === d.model ? ' sel' : '') + '"><input type="radio" name="stModel" value="' +
      esc(m.id) + '"' + (m.id === d.model ? ' checked' : '') + '><span>' + esc(m.label) + '</span></label>';
  }).join('');
  var radios = models.querySelectorAll('input[name=stModel]');
  for (var i = 0; i < radios.length; i++) {
    radios[i].onchange = function (e) {
      postSettings({ model: e.target.value }, 'stModelResult', 'Saved');
    };
  }
  document.getElementById('stInterval').value = d.intervalSec;
  document.getElementById('stTargets').value = d.targets.join(', ');
  document.getElementById('stDistillEnabled').checked = !!d.distill.enabled;
  document.getElementById('stHookStatus').textContent = d.hookInstalled
    ? 'Claude Code hook: Installed ✓' : 'Claude Code hook: Not installed';
  document.getElementById('stMinEdits').value = d.distill.minEdits;
  document.getElementById('stCheckpointEvery').value = d.distill.checkpointEvery;
  document.getElementById('stTeamUrl').value = (d.team && d.team.url) || '';
  document.getElementById('stTeamAnonKey').value = (d.team && d.team.anonKey) || '';
  document.getElementById('stTeamBackendStatus').textContent = d.team && d.team.customBackend
    ? 'Using a custom self-hosted backend from this config.'
    : 'Using the default hosted backend for this build.';
}
function stResult(id, msg, ok) {
  var el = document.getElementById(id);
  el.textContent = msg;
  el.className = 'st-result ' + (ok ? 'ok' : 'err');
  if (ok) {
    setTimeout(function () { if (el.textContent === msg) el.textContent = ''; }, 2600);
  }
}
function postSettings(body, resultId, okMsg) {
  return fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) { return r.json(); }).then(function (d) {
    renderSettings(d);
    if (resultId) stResult(resultId, okMsg || 'Saved', true);
    return d;
  }).catch(function () {
    if (resultId) stResult(resultId, 'Could not save — is MemBridge running?', false);
    setPill(false);
  });
}
document.getElementById('openSettings').onclick = function () { location.hash = '#settings'; };
document.getElementById('stClose').onclick = function () { location.hash = '#home'; };
document.getElementById('stTest').onclick = function () {
  var btn = document.getElementById('stTest');
  btn.disabled = true;
  stResult('stKeyResult', 'Testing…', true);
  fetch('/api/settings/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: document.getElementById('stKey').value.trim() }),
  }).then(function (r) { return r.json(); }).then(function (d) {
    btn.disabled = false;
    stResult('stKeyResult', d.ok ? 'Key works ✓' : d.error, d.ok);
  }).catch(function () {
    btn.disabled = false;
    stResult('stKeyResult', 'Could not reach MemBridge.', false);
  });
};
document.getElementById('stSaveKey').onclick = function () {
  var input = document.getElementById('stKey');
  var v = input.value.trim();
  if (!v) { stResult('stKeyResult', 'Paste a key first.', false); return; }
  postSettings({ apiKey: v }, 'stKeyResult', 'Key saved ✓').then(function () { input.value = ''; });
};
document.getElementById('stRemoveKey').onclick = function () {
  postSettings({ apiKey: '' }, 'stKeyResult', 'Key removed');
};
document.getElementById('stSaveSync').onclick = function () {
  var n = parseInt(document.getElementById('stInterval').value, 10);
  var t = document.getElementById('stTargets').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  postSettings({ intervalSec: n, targets: t }, 'stSyncResult', 'Saved — applies from the next check');
};
document.getElementById('stDistillEnabled').onchange = function (e) {
  postSettings({ distill: { enabled: e.target.checked } }, 'stDistillResult', e.target.checked ? 'Summaries on' : 'Summaries off');
};
document.getElementById('stSaveDistill').onclick = function () {
  var minEdits = parseInt(document.getElementById('stMinEdits').value, 10);
  var checkpointEvery = parseInt(document.getElementById('stCheckpointEvery').value, 10);
  postSettings({ distill: { minEdits: minEdits, checkpointEvery: checkpointEvery } }, 'stDistillResult', 'Saved');
};
document.getElementById('stSaveTeamBackend').onclick = function () {
  postSettings({
    team: {
      url: document.getElementById('stTeamUrl').value,
      anonKey: document.getElementById('stTeamAnonKey').value,
    },
  }, 'stTeamBackendResult', 'Backend saved');
};
document.getElementById('stResetTeamBackend').onclick = function () {
  postSettings({ team: { url: '', anonKey: '' } }, 'stTeamBackendResult', 'Reset to default');
};

/* ================= project page ================= */
var pjRoot = document.getElementById('pjRoot');
// pjFp gates rebuilds; pjEntries backs the deduped project stream + Load more;
// pjMenuOpen survives a no-op poll so an open ⋯ menu is not yanked shut.
var pjTimer = null, pjFp = '', pjEntries = [], pjMenuOpen = false;
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
  Promise.all([feedP, detailP]).then(function (res) {
    setPill(true);
    var feed = res[0] || {};
    var detail = res[1];
    if (isLocal && detail && detail.gone) { renderProjectGone(); return; }
    // Fingerprint both responses so polling still skips needless rebuilds.
    var fp = JSON.stringify({ feed: feed, detail: detail });
    if (fp === pjFp) { refreshAgo('view-project'); return; }
    pjFp = fp;
    renderProject(feed, detail, p);
  }).catch(function () { setPill(false); });
}
// One delegated listener outlives every rebuild: the panel re-renders on each
// poll, and a handler wired to a replaced node would silently drop clicks
// that race a rebuild.
pjRoot.addEventListener('click', function (e) {
  if (e.target.closest('.pj-close')) { location.hash = '#home'; return; }
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
function feedEntryHtml(e, opts) {
  opts = opts || {};
  var who = e.self ? 'You' : (e.author || 'Someone');
  var avatar = '<span class="favatar" style="background:' + personColor(e.authorId || 'you') + '">'
    + esc((who[0] || '?').toUpperCase()) + '</span>';
  var person = '<button class="fperson" data-author="' + esc(e.authorId || who) + '">' + esc(who) + '</button>';
  var proj = (opts.hideProject || !e.project) ? '' :
    '<button class="fproj" data-project="' + esc(e.projectId || e.projectPath || '') + '"'
    + ' data-path="' + esc(e.projectPath || '') + '" data-id="' + esc(e.projectId || '') + '">' + esc(e.project) + '</button>';
  var meta = '<div class="fmeta">' + avatar + person + badgeHtml(e.source) + proj
    + '<span class="fago" data-ago="' + esc(e.ts) + '">' + esc(ago(e.ts)) + '</span></div>';
  var body;
  if (e.summary) {
    body = '<div class="fsummary' + (e.distilled ? ' distilled' : '') + '">' + esc(e.summary) + '</div>'
      + '<div class="fask">Asked: ' + esc(e.ask) + '</div>';
  } else {
    body = '<div class="fworking">Working on: ' + esc(e.ask) + ' <span class="fhint">in progress</span></div>';
  }
  var files = (e.files && e.files.length)
    ? '<div class="afiles">' + esc(e.files[0]) + (e.files.length > 1 ? ' +' + (e.files.length - 1) + ' more' : '') + '</div>' : '';
  return '<div class="fentry' + (e.summary ? '' : ' pending') + '">' + meta + body + files + '</div>';
}
// Clamped summaries expand on click. Class-based so unchanged polls (which do
// not rewrite innerHTML) keep whichever entries the reader opened.
document.addEventListener('click', function (e) {
  var s = e.target.closest ? e.target.closest('.fsummary') : null;
  if (s) s.classList.toggle('expanded');
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
      items += '<button class="pj-mi danger" data-act="unlink" data-path="' + esc(p) + '">Unlink from ' +
        esc(detail.team.teamName || 'team') + '</button>';
    } else {
      items += '<button class="pj-mi" data-act="team-page">Share with a team</button>';
    }
    items += '<button class="pj-mi" data-act="remove-block" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Remove memory block</button>';
    items += '<div class="pj-mi-sep"></div>';
    items += '<button class="pj-mi danger" data-act="del" data-path="' + esc(p) + '" data-name="' + esc(detail.name) + '">Delete project</button>';
  } else {
    // Team-only: the folder is not on this Mac. Send the user to the team hub,
    // which carries the team context needed to link a local folder.
    items += '<div class="pj-mi-info">Not on this Mac</div>' +
      '<button class="pj-mi" data-act="link-folder">Link a local folder&hellip;</button>';
  }
  return '<div class="pj-menu" id="pjMenu">' + items + '</div>';
}
function renderProject(feed, detail, value) {
  feed = feed || {};
  var entries = (feed.entries || []).slice();
  pjEntries = entries;
  var local = !!detail;                       // metadata present => a folder we track
  var name = local ? detail.name : pjDisplayName(entries);
  var chip = local
    ? (detail.team ? '<span class="team-chip">Shared with ' + esc(detail.team.teamName || 'team') + '</span>' : '')
    : '<span class="team-chip">Shared with team</span>';

  var head = '<div class="pj-head"><div class="grow"><h2>' + esc(name) + '</h2>' +
    (local && detail.paused ? '<span class="chip">Paused</span>' : '') + chip +
    (local ? '<div class="path" style="margin-top:4px">' + esc(detail.path) + '</div>' : '') +
    '</div>' +
    (local ? '<button class="btn" data-act="copy" data-path="' + esc(detail.path) +
      '" title="Copy a short digest of recent AI work here, ready to paste into ChatGPT or any AI. Nothing is sent anywhere until you paste it.">Copy for AI</button>' : '') +
    '<div class="pj-menu-wrap"><button class="pj-menu-btn" title="More" aria-haspopup="true">&#8943;</button>' +
    pjMenuHtml(detail) + '</div>' +
    '<button class="pj-close" title="Back to projects">&times;</button></div>';

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

  var h = head + notice +
    '<div id="pjStream">' + stream + '</div>' +
    '<div id="pjMore">' + pjMoreBtnHtml(feed.nextBefore, value) + '</div>';

  // Roadmap: collapsed at the bottom; team-only projects have no local key/plan.
  if (local) {
    h += '<details class="roadmap"><summary>Roadmap</summary>' + planPanelHtml(detail) + '</details>';
  }

  // A rebuild must not eat a goal the user is typing, nor snap a section shut.
  var oldGoal = document.getElementById('pjGoal');
  var goalDraft = oldGoal ? oldGoal.value : null;
  var goalHadFocus = oldGoal && document.activeElement === oldGoal;
  var oldRoadmap = document.querySelector('#view-project .roadmap');
  var roadmapWasOpen = !!(oldRoadmap && oldRoadmap.open);

  pjRoot.innerHTML = h;
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
</script>
</body>
</html>`;
}

module.exports = { dashboardPage };
