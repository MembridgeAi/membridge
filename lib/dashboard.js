'use strict';

const { teamCss, teamHtml, teamJs } = require('./dashboard-team');

// Self-contained dashboard page: no build step, no external assets, no CDN,
// works fully offline. Served by lib/server.js at / and loaded inside the
// Electron BrowserWindow. The warm, high-contrast visual system uses only
// local font fallbacks so the app remains complete without a network.
//
// Two views, switched client-side via location.hash:
//   #overview - stats + project cards (5s polling while active)
//   #neural   - 3D force-directed graph of /api/graph on a 2d canvas
//               (30s refetch + rAF loop, only while active and visible)
function dashboardPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MemBridge</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4.5' fill='%233B82F6'/%3E%3Cg fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' transform='translate(12 12) scale(0.72) translate(-12 -12)'%3E%3Cpath d='M5 20V4l7 9 7-9v16'/%3E%3Cpath d='M1 14h22'/%3E%3C/g%3E%3C/svg%3E">
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
body.signed-out header, body.signed-out #view-home, body.signed-out #view-overview, body.signed-out #view-project,
body.signed-out #view-settings, body.signed-out #view-neural, body.signed-out #view-team { display: none !important; }

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
.tabs { display: flex; gap: 22px; flex: 1; height: 100%; }
.tab {
  background: none; border: none; padding: 0; margin: 0; cursor: pointer;
  font: inherit; font-size: 14px; color: var(--muted); position: relative;
  height: 100%;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); }
.tab.active::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 50%, transparent);
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

/* ---------- overview ---------- */
#view-overview { flex: 1; overflow-y: auto; display: none; }
#view-overview.active { display: block; }
#view-overview .inner { max-width: 860px; margin: 0 auto; padding: 40px 28px 64px; }
#view-home { flex: 1; overflow-y: auto; display: none; }
#view-home.active { display: block; }
#view-home .inner { max-width: 720px; margin: 0 auto; padding: 40px 28px 64px; }
.stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 16px; margin-bottom: 28px;
}
.stat {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 16px 20px;
}
.stat .k { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.stat .v {
  font-size: 26px; font-weight: 650; line-height: 1.2;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
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

/* ---------- projects grid ---------- */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 16px; }
.grid .card { margin-bottom: 0; }
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

/* ---------- neural map ---------- */
#view-neural {
  flex: 1; position: relative; display: none; overflow: hidden;
  background: radial-gradient(1100px 700px at 50% 38%, var(--bg2), var(--bg));
}
#view-neural.active { display: block; }
#net { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
#search {
  position: absolute; top: 18px; left: 18px; width: 230px;
  font: inherit; font-size: 13.5px; color: var(--text);
  background: rgba(10, 15, 14, .85); border: 1px solid var(--border);
  border-radius: 10px; padding: 8px 14px; outline: none;
}
#search::placeholder { color: var(--muted); }
#search:focus { border-color: color-mix(in srgb, var(--accent) 45%, transparent); box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 15%, transparent); }
#legend {
  position: absolute; left: 18px; bottom: 16px; font-size: 12px;
  color: var(--muted); line-height: 1.9; pointer-events: none;
}
#legend .sw {
  display: inline-block; width: 9px; height: 9px; border-radius: 50%;
  margin-right: 7px; vertical-align: baseline;
}
#legend .ln {
  display: inline-block; width: 18px; height: 2px; border-radius: 2px;
  margin-right: 7px; vertical-align: middle;
}
#legend .li { margin-right: 18px; white-space: nowrap; }
#hint {
  position: absolute; left: 0; right: 0; bottom: 16px; text-align: center;
  font-size: 12.5px; color: var(--muted); pointer-events: none;
  transition: opacity 1.2s ease; opacity: 1;
}
#hint.hide { opacity: 0; }
#recenter {
  position: absolute; right: 18px; bottom: 16px;
  font: inherit; font-size: 12.5px; color: var(--muted); cursor: pointer;
  background: rgba(10, 15, 14, .85); border: 1px solid var(--border);
  border-radius: 10px; padding: 6px 14px;
}
#recenter:hover { color: var(--text); border-color: var(--muted); }
#neuralEmpty {
  position: absolute; inset: 0; display: none;
  align-items: center; justify-content: center; pointer-events: none;
}
#neuralEmpty div {
  max-width: 420px; text-align: center; color: var(--muted);
  font-size: 14.5px; padding: 0 24px;
}
#panel {
  position: absolute; top: 18px; right: 18px; width: 320px;
  max-height: calc(100% - 70px); overflow-y: auto; display: none;
  background: rgba(13, 20, 19, .96); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 18px 20px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, .55);
}
#panel.open { display: block; }
#panel h3 { font-size: 15px; font-weight: 600; margin: 0; line-height: 1.4; word-break: break-word; }
#panel .p-head { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 12px; }
#panel .p-head h3 { flex: 1; }
#panel .p-close {
  flex: none; background: none; border: none; color: var(--muted); cursor: pointer;
  font-size: 18px; line-height: 1; padding: 0 2px; margin-top: -1px;
}
#panel .p-close:hover { color: var(--text); }
#panel .p-row { font-size: 13px; color: var(--muted); padding: 3px 0; }
#panel .p-row b { color: var(--text); font-weight: 500; }
#panel .p-files {
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11.5px;
  color: var(--text); word-break: break-all; margin-top: 4px; line-height: 1.7;
}
#panel .p-sec {
  font-size: 11px; color: var(--muted); text-transform: uppercase;
  letter-spacing: .8px; margin: 16px 0 6px;
}
#panel .conn {
  border: 1px solid var(--border); border-radius: 10px;
  padding: 9px 12px; margin-bottom: 8px; cursor: pointer;
}
#panel .conn:hover { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
#panel .conn-t { font-size: 13px; line-height: 1.4; word-break: break-word; }
#panel .conn-w { font-size: 12px; color: var(--muted); margin-top: 2px; word-break: break-word; }

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
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='4.5' fill='%233B82F6'/%3E%3Cg fill='none' stroke='%23fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' transform='translate(12 12) scale(0.72) translate(-12 -12)'%3E%3Cpath d='M5 20V4l7 9 7-9v16'/%3E%3Cpath d='M1 14h22'/%3E%3C/g%3E%3C/svg%3E") center/contain no-repeat;
}
.brand .dot { width: 28px; height: 28px; border-radius: 9px; box-shadow: var(--shadow-accent); }
.tabs { gap: 6px; align-items: center; }
.tab { height: 40px; padding: 0 14px; border-radius: 10px; font-size: 13px; font-weight: 600; transition: all .2s ease; }
.tab:hover { color: var(--text); background: var(--surface-subtle); }
.tab.active { color: var(--accent); background: color-mix(in srgb, var(--accent) 6%, transparent); }
.tab.active::after { display: none; }
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
button.btn:focus-visible, .tab:focus-visible, input:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 22%, transparent); outline-offset: 2px; }
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
#view-overview .inner, #view-project .inner { max-width: 1120px; padding: 48px 34px 72px; }
#view-settings .inner, #view-team .inner { max-width: 980px; padding: 48px 34px 72px; }
.hero { display: grid; grid-template-columns: 1.1fr .9fr; gap: 48px; align-items: center; margin-bottom: 46px; }
.section-label { display: inline-flex; align-items: center; gap: 9px; padding: 7px 12px; border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 999px; background: color-mix(in srgb, var(--accent) 4.5%, transparent); color: var(--accent); font: 600 10px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; }
.section-label::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 2.2s infinite; }
.hero h1, .page-title { margin: 15px 0 12px; font: 400 clamp(38px,5vw,60px)/1.02 var(--display); letter-spacing: -.04em; }
.hero h1 em, .gradient-text { font-style: normal; color: transparent; background: linear-gradient(90deg,var(--accent),var(--accent2)); -webkit-background-clip: text; background-clip: text; }
.hero p { max-width: 620px; margin: 0; color: var(--muted); font-size: 16px; line-height: 1.72; }
.hero-art { position: relative; min-height: 210px; border: 1px solid var(--border); border-radius: 28px; overflow: hidden; background: radial-gradient(circle at 50% 50%,color-mix(in srgb, var(--accent) 11%, transparent),transparent 57%),var(--card); box-shadow: var(--shadow-lg); }
.hero-art::before { content: ''; position: absolute; inset: 22px; border: 1px dashed color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 50%; animation: spin 60s linear infinite; }
.orb { position: absolute; inset: 50%; width: 74px; height: 74px; margin: -37px; border-radius: 24px; background: linear-gradient(135deg,var(--accent),var(--accent2)); box-shadow: var(--shadow-accent); transform: rotate(45deg); }
.float-card { position: absolute; display: flex; align-items: center; gap: 9px; padding: 10px 13px; border: 1px solid var(--border); border-radius: 12px; background: light-dark(rgba(255,255,255,.94), rgba(17,24,38,.94)); box-shadow: var(--shadow-md); color: var(--text); font-size: 11px; font-weight: 700; }
.float-card::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg,var(--accent),var(--accent2)); }
.float-card.one { top: 28px; right: 28px; animation: float 5s ease-in-out infinite; }
.float-card.two { left: 26px; bottom: 26px; animation: float 4s ease-in-out .6s infinite; }
.stats { grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 34px; }
.stat { border-radius: 15px; padding: 18px 19px; box-shadow: var(--shadow-sm); transition: transform .25s,box-shadow .25s; }
.stat:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); }
.stat .k { font: 600 10px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
.stat .v { margin-top: 8px; font-size: 25px; letter-spacing: -.04em; }
.section-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin: 0 0 16px; }
.section-head h2 { margin: 0; font: 400 29px/1.15 var(--display); letter-spacing: -.025em; }
.section-head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.card { border-radius: var(--radius); box-shadow: var(--shadow-sm); }
.grid { grid-template-columns: repeat(auto-fill,minmax(285px,1fr)); gap: 14px; }
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
#view-team { flex: 1; overflow-y: auto; display: none; }
#view-team.active { display: block; }
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
#view-neural { background: radial-gradient(900px 620px at 50% 40%,#172554,#0f172a 68%); }
#search, #recenter { background: rgba(15,23,42,.82); border-color: rgba(255,255,255,.15); color: #fff; backdrop-filter: blur(12px); }
#panel { background: rgba(15,23,42,.94); border-color: rgba(255,255,255,.14); color: #f8fafc; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
#panel .p-row, #panel .p-sec, #panel .conn-w { color: #94a3b8; }
#panel .p-row b, #panel .p-files { color: #f8fafc; }
@keyframes pulse { 0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.28);opacity:.66} }
@keyframes spin { to{transform:rotate(360deg)} }
@keyframes float { 0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)} }
@media (max-width: 850px) {
  header { padding: 0 14px; gap: 8px; }
  .brand { font-size: 0; }
  .tabs { gap: 2px; }
  .tab { padding: 0 9px; }
  .hero { grid-template-columns: 1fr; }
  .hero-art { display:none; }
  .stats { grid-template-columns: repeat(2,1fr); }
  .auth-page { grid-template-columns:1fr; }
  .auth-story { min-height:330px; padding:38px 34px; }
  .auth-story .auth-brand { margin-bottom:70px; }
  .auth-copy h1 { font-size:48px; }
  .auth-story > .path { display:none; }
  .auth-panel { padding:46px 28px 62px; }
}
@media (max-width: 590px) {
  header { overflow-x:auto; }
  #view-home .inner, #view-overview .inner, #view-project .inner, #view-team .inner, #view-settings .inner { padding: 32px 18px 60px; }
  .hero h1 { font-size:42px; }
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

${teamHtml}

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

<div id="view-neural">
  <canvas id="net"></canvas>
  <input id="search" type="text" placeholder="Search chats" autocomplete="off" spellcheck="false">
  <div id="legend">
    <span class="li"><span class="sw" style="background:#2de0a7"></span>Claude Code</span><span
      class="li"><span class="sw" style="background:#38b6ff"></span>Codex</span><span
      class="li"><span class="sw" style="background:#b48cff"></span>Other tools</span><br>
    <span class="li"><span class="ln" style="background:rgba(45,224,167,.7)"></span>shared files</span><span
      class="li"><span class="ln" style="background:rgba(56,182,255,.6)"></span>shared ideas</span>
  </div>
  <div id="hint">drag to rotate &middot; scroll to zoom &middot; click a chat</div>
  <button id="recenter">Re-center</button>
  <div id="neuralEmpty"><div>Your chats will appear here as glowing nodes.
    Use Claude Code or Codex in any project, then come back after the next sync.</div></div>
  <aside id="panel"></aside>
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
// remaining distinct in badges and the neural map.
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
// Views: #overview (projects grid), #project=<path> (one project, level 2 of
// max 2), #neural. Hash routing means browser-back exits a project page.
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
function scrollToInvite() {
  var el = document.getElementById('settings-invite');
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
document.getElementById('openInvite').onclick = function () { location.hash = '#settings'; setTimeout(scrollToInvite, 0); };
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

/* ================= overview view ================= */
var ovTimer = null;
function startOverview() {
  loadOverview();
  ovTimer = setInterval(loadOverview, 5000);
}
function stopOverview() {
  if (ovTimer) { clearInterval(ovTimer); ovTimer = null; }
}
var stat = function (k, v, agoTs) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v"' +
    (agoTs ? ' data-ago="' + esc(agoTs) + '"' : '') + '>' + esc(v) + '</div></div>';
};
// Patch relative times in place so unchanged polls never rebuild the DOM.
function refreshAgo(rootId) {
  var els = document.querySelectorAll('#' + rootId + ' [data-ago]');
  for (var i = 0; i < els.length; i++) els[i].textContent = ago(els[i].getAttribute('data-ago'));
}
// Compact grid card: clicking it opens the project page; all actions live there.
function projectCard(p) {
  var badges = p.tools.map(badgeHtml).join(' ');
  return '<div class="card pcard' + (p.paused ? ' paused' : '') + '" data-open="' + esc(p.path) + '">' +
    '<div class="row"><div class="grow"><h2>' + esc(p.name) + '</h2>' +
    '<div class="path">' + esc(p.path) + '</div></div>' +
    (p.paused ? '<span class="chip">Paused</span>' : '') + '</div>' +
    '<div style="margin-top:12px">' + (badges || '<span style="font-size:12px;color:var(--muted)">No AI activity yet</span>') + '</div>' +
    (p.team ? '<span class="team-chip">' + esc(p.team.teamName || 'Team linked') +
      (p.teammateActivity ? ' · ' + esc(p.teammateActivity) + ' updates' : '') + '</span>' : '') +
    '<div class="meta">' + p.prompts.length + ' recent ask' + (p.prompts.length === 1 ? '' : 's') +
    ' &middot; active <span data-ago="' + esc(p.lastActivity || '') + '">' + esc(ago(p.lastActivity)) + '</span></div></div>';
}
var ovFp = '';
function loadOverview() {
  Promise.all([
    fetch('/api/status').then(function (r) { return r.json(); }),
    fetch('/api/projects').then(function (r) { return r.json(); }),
  ]).then(function (res) {
    var status = res[0], projects = res[1];
    setPill(true);
    // Rebuild only when the data changed: rewriting innerHTML every poll
    // destroys text selection and hover state.
    var fp = JSON.stringify(res);
    if (fp === ovFp) { refreshAgo('view-overview'); return; }
    ovFp = fp;
    document.getElementById('stats').innerHTML =
      stat('Projects watched', status.projectCount) +
      stat('Tools connected', status.adapters.length) +
      stat('Last sync', ago(status.lastSync), status.lastSync) +
      stat('Interval', status.intervalSec + 's');
    var wrap = document.getElementById('projects');
    if (!projects.length) {
      wrap.innerHTML = '<div class="empty">No AI activity found yet. Use Claude Code or Codex in any project and it will appear here after the next sync.</div>';
      return;
    }
    wrap.innerHTML = '<div class="grid">' + projects.map(projectCard).join('') + '</div>';
    var cards = wrap.querySelectorAll('[data-open]');
    for (var i = 0; i < cards.length; i++) {
      (function (card) {
        card.onclick = function () {
          location.hash = '#project=' + encodeURIComponent(card.dataset.open);
        };
      })(cards[i]);
    }
  }).catch(function () { setPill(false); });
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
    if (res.ok) { closeAdd(); loadOverview(); return; } // added or already tracked
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
    if (currentTab() === 'project') location.hash = '#overview';
    else loadOverview();
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
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) {
    setPill(true);
    renderSettings(d);
  }).catch(function () { setPill(false); });
}
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
document.getElementById('stClose').onclick = function () { location.hash = '#overview'; };
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
  if (btn.dataset.act === 'team-page') { location.hash = '#team'; return; }
  if (btn.dataset.act === 'link-folder') { location.hash = '#team'; return; }
  if (btn.dataset.act === 'del') {
    openDel(btn.dataset.path, btn.dataset.name || btn.dataset.path);
    return;
  }
  if (btn.dataset.act === 'remove-block') {
    // openRemove is itself a confirm modal, so no separate arming here.
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
function entryHtml(e) {
  return '<div class="aentry"><div class="entry"><span class="t">' +
    esc((e.ts || '').slice(0, 16).replace('T', ' ')) + '</span>' + badgeHtml(e.source) +
    '<span>' + esc(e.ask) + '</span></div>' +
    (e.summary ? '<div class="aresult">' + (e.distilled ? '<span class="distilled">distilled</span>' : '') + esc(e.summary) + '</div>' : '') +
    (e.files.length ? '<div class="afiles">' + esc(e.files.join(', ')) + '</div>' : '') + '</div>';
}
function teamEntryHtml(e) {
  return '<div class="aentry"><div class="entry"><span class="t">' +
    esc((e.ts || '').slice(0, 16).replace('T', ' ')) + '</span>' + badgeHtml(e.source) +
    '<span><strong>' + esc(e.author || 'Teammate') + '</strong> · ' + esc(e.ask) + '</span></div>' +
    (e.files && e.files.length ? '<div class="afiles">' + esc(e.files.join(', ')) + '</div>' : '') + '</div>';
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
function pjDisplayName(entries, value) {
  for (var i = 0; i < entries.length; i++) if (entries[i].project) return entries[i].project;
  return 'Shared project';
}
// The ⋯ dropdown absorbs the old Memory tab + admin actions. Destructive items
// arm (click-again) or open a confirm modal; non-destructive ones act at once.
function pjMenuHtml(detail, value) {
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
  } else {
    items += '<div class="pj-mi-info">Not on this Mac</div>';
  }
  return '<div class="pj-menu" id="pjMenu">' + items + '</div>';
}
function renderProject(feed, detail, value) {
  feed = feed || {};
  var entries = (feed.entries || []).slice();
  pjEntries = entries;
  var local = !!detail;                       // metadata present => a folder we track
  var name = local ? detail.name : pjDisplayName(entries, value);
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
    pjMenuHtml(detail, value) + '</div>' +
    '<button class="pj-close" title="Back to projects">&times;</button></div>';

  // One merged, day-grouped stream (local + team, deduped server-side).
  var stream = entries.length
    ? dayGroupHtml(entries, { hideProject: true })
    : '<div class="empty">' + (local
        ? 'No AI activity captured here yet. Use Claude Code or Codex in this project and it will show up after the next sync.'
        : 'No activity has arrived from your team for this project yet.') + '</div>';

  var h = head +
    '<div id="pjStream">' + stream + '</div>' +
    '<div id="pjMore">' + pjMoreBtnHtml(feed.nextBefore, value) + '</div>';

  pjRoot.innerHTML = h;
  // Click handling is delegated on pjRoot (survives this rebuild).
  if (pjMenuOpen) { var menu = document.getElementById('pjMenu'); if (menu) menu.className = 'pj-menu open'; }
}

/* ================= neural map: data & simulation ================= */
var canvas = document.getElementById('net');
var ctx = canvas.getContext('2d');
var neuralEl = document.getElementById('view-neural');
var panelEl = document.getElementById('panel');
var hintEl = document.getElementById('hint');
var searchEl = document.getElementById('search');
var W = 0, H = 0;
var FOV = 700;
var cam = { yaw: 0.6, pitch: 0.35, dist: 700 };
var HOME = { yaw: 0.6, pitch: 0.35, dist: 700 };
var G = { nodes: [], links: [], byId: {}, heat: 0, fp: '' };
var hoverId = null, selectedId = null, focusSet = null, searchQ = '';
var dragging = null, interacted = false;
var rafId = 0, graphTimer = null;

var HUB_RGB = hexRgb('#2de0a7');
var MEMBER_RGB = [52, 70, 64];        // very faint, near --border
var SHARED_RGB = hexRgb('#2de0a7');   // related links with shared files
var IDEA_RGB = hexRgb('#38b6ff');     // related links on shared ideas only

function startNeural() {
  resizeCanvas();
  fetchGraph();
  graphTimer = setInterval(fetchGraph, 30000);
  if (!rafId) rafId = requestAnimationFrame(frame);
}
function stopNeural() {
  if (graphTimer) { clearInterval(graphTimer); graphTimer = null; }
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
}

function fetchGraph() {
  fetch('/api/graph').then(function (r) {
    if (!r.ok) throw new Error('graph ' + r.status); // a 500 is not an empty graph
    return r.json();
  }).then(function (d) {
    setPill(true);
    var nodes = d.nodes || [], links = d.links || [];
    // Rebuild only when the payload really changed, keeping old positions.
    var fp = JSON.stringify({ n: nodes, l: links });
    if (fp !== G.fp) {
      G.fp = fp;
      buildGraph(nodes, links);
      G.heat = 1;
    }
    var hasChats = G.nodes.some(function (n) { return n.type === 'chat'; });
    document.getElementById('neuralEmpty').style.display = hasChats ? 'none' : 'flex';
  }).catch(function () { setPill(false); });
}

var rnd = function (r) { return (Math.random() * 2 - 1) * r; };
function buildGraph(rawNodes, rawLinks) {
  var old = G.byId;
  var byId = {}, nodes = [], i, n, sn;
  // Pass 1: project hubs, so chats can seed near them.
  for (i = 0; i < rawNodes.length; i++) {
    n = rawNodes[i];
    if (n.type !== 'project') continue;
    sn = {
      id: n.id, type: 'project', label: n.label || '', raw: n,
      x: rnd(220), y: rnd(160), z: rnd(220), vx: 0, vy: 0, vz: 0,
      mass: 5 + Math.min(12, (n.chats || 0) * 0.4),
      r: 9 + Math.min(8, (n.chats || 0) * 0.5),
      rgb: HUB_RGB, labelLower: (n.label || '').toLowerCase(),
    };
    var prev = old[n.id];
    if (prev) { sn.x = prev.x; sn.y = prev.y; sn.z = prev.z; sn.vx = prev.vx; sn.vy = prev.vy; sn.vz = prev.vz; }
    byId[sn.id] = sn; nodes.push(sn);
  }
  // Pass 2: chats.
  for (i = 0; i < rawNodes.length; i++) {
    n = rawNodes[i];
    if (n.type === 'project') continue;
    var hub = byId['p:' + n.project];
    sn = {
      id: n.id, type: 'chat', label: n.label || '', raw: n,
      x: hub ? hub.x + rnd(70) : rnd(260),
      y: hub ? hub.y + rnd(70) : rnd(200),
      z: hub ? hub.z + rnd(70) : rnd(260),
      vx: 0, vy: 0, vz: 0, mass: 1,
      r: 3.5 + Math.min(4, (n.prompts || 0) * 0.35),
      rgb: hexRgb(toolHex(n.source)), labelLower: (n.label || '').toLowerCase(),
    };
    var prevC = old[n.id];
    if (prevC) { sn.x = prevC.x; sn.y = prevC.y; sn.z = prevC.z; sn.vx = prevC.vx; sn.vy = prevC.vy; sn.vz = prevC.vz; }
    byId[sn.id] = sn; nodes.push(sn);
  }
  // Links: resolve endpoints, precompute spring constants.
  var links = [];
  for (i = 0; i < rawLinks.length; i++) {
    var l = rawLinks[i];
    var a = byId[l.source], b = byId[l.target];
    if (!a || !b) continue;
    var member = l.type === 'member';
    var w = member ? 1
      : Math.min(1, (l.similarity || 0) + ((l.sharedFiles && l.sharedFiles.length) ? 0.4 : 0));
    links.push({
      a: a, b: b, type: l.type, raw: l,
      rest: member ? 60 : 150,
      k: member ? 0.015 : 0.0015 + 0.005 * w,
    });
  }
  G.nodes = nodes; G.links = links; G.byId = byId;
  if (selectedId && !byId[selectedId]) clearSelection();
  else if (selectedId) renderPanel();
  rebuildFocus();
}

// One physics step: repulsion + link springs + gravity, Euler integration.
var REP = 1600, GRAV = 0.0006, DAMP = 0.9, VMAX = 4;
function stepSim() {
  var ns = G.nodes, ls = G.links;
  var i, j, a, b, dx, dy, dz, d2, d, f;
  for (i = 0; i < ns.length; i++) { a = ns[i]; a.fx = 0; a.fy = 0; a.fz = 0; }
  // Coulomb-style repulsion between all pairs (fine at <=600 nodes).
  for (i = 0; i < ns.length; i++) {
    a = ns[i];
    for (j = i + 1; j < ns.length; j++) {
      b = ns[j];
      dx = a.x - b.x; dy = a.y - b.y; dz = a.z - b.z;
      d2 = dx * dx + dy * dy + dz * dz + 0.01;
      if (d2 > 250000) continue; // negligible past ~500px
      d = Math.sqrt(d2);
      f = REP / d2;
      dx = dx / d * f; dy = dy / d * f; dz = dz / d * f;
      a.fx += dx; a.fy += dy; a.fz += dz;
      b.fx -= dx; b.fy -= dy; b.fz -= dz;
    }
  }
  // Springs along links.
  for (i = 0; i < ls.length; i++) {
    var l = ls[i]; a = l.a; b = l.b;
    dx = b.x - a.x; dy = b.y - a.y; dz = b.z - a.z;
    d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.01;
    f = l.k * (d - l.rest);
    dx = dx / d * f; dy = dy / d * f; dz = dz / d * f;
    a.fx += dx; a.fy += dy; a.fz += dz;
    b.fx -= dx; b.fy -= dy; b.fz -= dz;
  }
  // Mild gravity toward the origin, then integrate with damping.
  for (i = 0; i < ns.length; i++) {
    a = ns[i];
    a.fx -= a.x * GRAV * a.mass; a.fy -= a.y * GRAV * a.mass; a.fz -= a.z * GRAV * a.mass;
    a.vx = (a.vx + a.fx / a.mass) * DAMP;
    a.vy = (a.vy + a.fy / a.mass) * DAMP;
    a.vz = (a.vz + a.fz / a.mass) * DAMP;
    var sp = Math.sqrt(a.vx * a.vx + a.vy * a.vy + a.vz * a.vz);
    if (sp > VMAX) { a.vx *= VMAX / sp; a.vy *= VMAX / sp; a.vz *= VMAX / sp; }
    a.x += a.vx; a.y += a.vy; a.z += a.vz;
  }
}

/* ================= neural map: projection & render ================= */
var dpr = 1;
function resizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  W = neuralEl.clientWidth; H = neuralEl.clientHeight;
  canvas.width = Math.max(1, Math.round(W * dpr));
  canvas.height = Math.max(1, Math.round(H * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', function () {
  if (currentTab() === 'neural') resizeCanvas();
});

function frame() {
  rafId = 0;
  if (currentTab() !== 'neural' || document.hidden) return;
  // Slow idle auto-rotation; pause while dragging or hovering a node.
  if (!dragging && !hoverId) cam.yaw += 0.0016;
  if (G.heat > 0.02) { stepSim(); G.heat *= 0.993; }
  draw();
  rafId = requestAnimationFrame(frame);
}

function project() {
  var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
  var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  var cx = W / 2, cyy = H / 2;
  for (var i = 0; i < G.nodes.length; i++) {
    var n = G.nodes[i];
    var x = n.x * cy + n.z * sy;
    var zz = n.z * cy - n.x * sy;
    var y = n.y * cp - zz * sp;
    var z = n.y * sp + zz * cp;
    var depth = z + cam.dist;
    if (depth < 80) { n.off = true; continue; }
    n.off = false;
    var s = FOV / (FOV + z + (cam.dist - FOV)); // = FOV / depth
    n.sx = cx + x * s; n.sy = cyy + y * s; n.ss = s; n.depth = depth;
    // Fade with depth so far nodes recede.
    n.da = Math.max(0.22, Math.min(1, 1.45 - depth / (cam.dist * 1.5)));
  }
}

function nodeVis(n) {
  var v = 1;
  if (searchQ) {
    if (n.type === 'chat') v *= n.labelLower.indexOf(searchQ) !== -1 ? 1 : 0.15;
    else v *= 0.4;
  }
  if (focusSet) v *= focusSet[n.id] ? 1 : 0.15;
  return v;
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  project();
  var i, n;
  // Links first (under the orbs).
  for (i = 0; i < G.links.length; i++) {
    var l = G.links[i];
    if (l.a.off || l.b.off) continue;
    var va = nodeVis(l.a), vb = nodeVis(l.b);
    var af = Math.min(l.a.da, l.b.da) * Math.min(va, vb);
    if (af <= 0.02) continue;
    var focused = focusSet && (focusSet[l.a.id] && focusSet[l.b.id]) &&
      (l.a.id === hoverId || l.a.id === selectedId || l.b.id === hoverId || l.b.id === selectedId);
    var col, alpha;
    if (l.type === 'member') { col = MEMBER_RGB; alpha = 0.55 * af; }
    else if (l.raw.sharedFiles && l.raw.sharedFiles.length) { col = SHARED_RGB; alpha = 0.35 * af; }
    else { col = IDEA_RGB; alpha = 0.2 * af; }
    if (focused) alpha = Math.min(0.85, alpha * 2.4);
    ctx.strokeStyle = rgba(col, alpha);
    ctx.lineWidth = focused ? 1.6 : 1;
    ctx.beginPath();
    ctx.moveTo(l.a.sx, l.a.sy);
    ctx.lineTo(l.b.sx, l.b.sy);
    ctx.stroke();
  }
  // Nodes back-to-front (painter's algorithm).
  var order = [];
  for (i = 0; i < G.nodes.length; i++) if (!G.nodes[i].off) order.push(G.nodes[i]);
  order.sort(function (p, q) { return q.depth - p.depth; });
  for (i = 0; i < order.length; i++) drawNode(order[i]);
}

function drawNode(n) {
  var v = nodeVis(n) * n.da;
  if (v <= 0.02) return;
  var active = n.id === hoverId || n.id === selectedId;
  var match = searchQ && n.type === 'chat' && n.labelLower.indexOf(searchQ) !== -1;
  var r = Math.max(1.5, n.r * n.ss * (active ? 1.3 : 1));
  var glow = r * (n.type === 'project' ? 3.4 : 2.7) * (match ? 1.5 : 1);
  var g = ctx.createRadialGradient(n.sx, n.sy, 0, n.sx, n.sy, glow);
  g.addColorStop(0, rgba(n.rgb, 0.9 * v));
  g.addColorStop(0.35, rgba(n.rgb, 0.3 * v));
  g.addColorStop(1, rgba(n.rgb, 0));
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(n.sx, n.sy, glow, 0, 6.2832); ctx.fill();
  // Bright core: project hubs read white-teal, chats take their tool color.
  ctx.fillStyle = n.type === 'project'
    ? 'rgba(234,255,247,' + 0.95 * v + ')'
    : rgba(n.rgb, 0.95 * v);
  ctx.beginPath(); ctx.arc(n.sx, n.sy, Math.max(1.2, r * 0.55), 0, 6.2832); ctx.fill();
  if (n.id === selectedId) {
    ctx.strokeStyle = 'rgba(45,224,167,' + 0.85 * v + ')';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(n.sx, n.sy, r + 4, 0, 6.2832); ctx.stroke();
  }
  ctx.textAlign = 'center';
  if (n.type === 'project') {
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(113,130,125,' + Math.min(1, 0.95 * v) + ')';
    ctx.fillText(n.label.toUpperCase().slice(0, 30), n.sx, n.sy + glow * 0.55 + 12);
  } else if (active) {
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(230,242,238,' + Math.min(1, 1.1 * v) + ')';
    var t = n.label.length > 46 ? n.label.slice(0, 45) + '\\u2026' : n.label;
    ctx.fillText(t, n.sx, n.sy - glow * 0.55 - 8);
  }
}

/* ================= neural map: interaction ================= */
function pickNode(mx, my) {
  var best = null, bestD = 12 * 12;
  for (var i = 0; i < G.nodes.length; i++) {
    var n = G.nodes[i];
    if (n.off) continue;
    var dx = n.sx - mx, dy = n.sy - my;
    var d = dx * dx + dy * dy;
    var hit = Math.max(12, n.r * n.ss + 4);
    if (d < hit * hit && (best === null || d < bestD)) { best = n; bestD = d; }
  }
  return best;
}
function rebuildFocus() {
  focusSet = null;
  var ids = [];
  if (hoverId) ids.push(hoverId);
  if (selectedId && selectedId !== hoverId) ids.push(selectedId);
  if (!ids.length) return;
  focusSet = {};
  for (var i = 0; i < ids.length; i++) focusSet[ids[i]] = 1;
  for (var j = 0; j < G.links.length; j++) {
    var l = G.links[j];
    for (var k = 0; k < ids.length; k++) {
      if (l.a.id === ids[k]) focusSet[l.b.id] = 1;
      if (l.b.id === ids[k]) focusSet[l.a.id] = 1;
    }
  }
}
function noteInteracted() {
  if (!interacted) { interacted = true; hintEl.className = 'hide'; }
}
canvas.addEventListener('pointerdown', function (e) {
  noteInteracted();
  dragging = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', function (e) {
  var rect = canvas.getBoundingClientRect();
  var mx = e.clientX - rect.left, my = e.clientY - rect.top;
  if (dragging) {
    var dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
    cam.yaw += dx * 0.005;
    cam.pitch = Math.max(-1.25, Math.min(1.25, cam.pitch + dy * 0.005));
    dragging.x = e.clientX; dragging.y = e.clientY;
    return;
  }
  var n = pickNode(mx, my);
  var id = n ? n.id : null;
  if (id !== hoverId) {
    hoverId = id;
    canvas.style.cursor = id ? 'pointer' : '';
    rebuildFocus();
  }
});
canvas.addEventListener('pointerup', function (e) {
  var wasDrag = dragging && dragging.moved;
  dragging = null;
  if (wasDrag) { G.heat = Math.max(G.heat, 0.3); return; }
  var rect = canvas.getBoundingClientRect();
  var n = pickNode(e.clientX - rect.left, e.clientY - rect.top);
  if (n) selectNode(n.id);
  else clearSelection(); // background click closes the panel
});
canvas.addEventListener('pointercancel', function () { dragging = null; });
canvas.addEventListener('pointerleave', function () {
  if (hoverId) { hoverId = null; canvas.style.cursor = ''; rebuildFocus(); }
});
canvas.addEventListener('wheel', function (e) {
  e.preventDefault();
  noteInteracted();
  cam.dist = Math.max(260, Math.min(2200, cam.dist * (1 + e.deltaY * 0.0012)));
}, { passive: false });
document.getElementById('recenter').onclick = function () {
  cam.yaw = HOME.yaw; cam.pitch = HOME.pitch; cam.dist = HOME.dist;
  G.heat = Math.max(G.heat, 0.5);
};
searchEl.addEventListener('input', function () {
  searchQ = searchEl.value.trim().toLowerCase();
});
window.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') clearSelection();
});

/* ================= neural map: selection panel ================= */
function selectNode(id) {
  selectedId = id;
  rebuildFocus();
  renderPanel();
}
function clearSelection() {
  if (!selectedId) return;
  selectedId = null;
  rebuildFocus();
  panelEl.className = '';
  panelEl.innerHTML = '';
}
function renderPanel() {
  var n = G.byId[selectedId];
  if (!n) { clearSelection(); return; }
  var h = '<div class="p-head"><h3>' + esc(n.label) + '</h3>' +
    '<button class="p-close" data-close="1" title="Close">&times;</button></div>';
  if (n.type === 'project') {
    h += '<div class="p-row"><b>Project</b></div>' +
      '<div class="p-files">' + esc(n.raw.path || '') + '</div>' +
      '<div class="p-row" style="margin-top:8px">Chats: <b>' + esc(n.raw.chats || 0) + '</b></div>' +
      '<div class="p-row">Status: <b>' + (n.raw.paused ? 'Paused' : 'Active') + '</b></div>';
  } else {
    var raw = n.raw;
    var hub = G.byId['p:' + raw.project];
    h += '<div style="margin-bottom:10px">' + badgeHtml(raw.source) + '</div>' +
      '<div class="p-row">Project: <b>' + esc(hub ? hub.label : raw.project) + '</b></div>' +
      '<div class="p-row">First activity: <b>' + esc(ago(raw.firstTs)) + '</b></div>' +
      '<div class="p-row">Last activity: <b>' + esc(ago(raw.lastTs)) + '</b></div>' +
      '<div class="p-row">Prompts: <b>' + esc(raw.prompts || 0) + '</b></div>';
    if (raw.files && raw.files.length) {
      h += '<div class="p-sec">Files touched</div><div class="p-files">' +
        raw.files.map(esc).join('<br>') + '</div>';
    }
    var rows = '';
    for (var i = 0; i < G.links.length; i++) {
      var l = G.links[i];
      if (l.type !== 'related' || (l.a !== n && l.b !== n)) continue;
      var o = l.a === n ? l.b : l.a;
      var why;
      if (l.raw.sharedFiles && l.raw.sharedFiles.length) why = 'shares ' + l.raw.sharedFiles.join(', ');
      else if (l.raw.terms && l.raw.terms.length) why = 'related ideas: ' + l.raw.terms.join(', ');
      else why = 'related work';
      rows += '<div class="conn" data-node="' + esc(o.id) + '">' +
        '<div class="conn-t">' + esc(o.label) + '</div>' +
        '<div class="conn-w">' + esc(why) + '</div></div>';
    }
    if (rows) h += '<div class="p-sec">Connected to</div>' + rows;
  }
  panelEl.innerHTML = h;
  panelEl.className = 'open';
}
panelEl.addEventListener('click', function (e) {
  var close = e.target.closest('[data-close]');
  if (close) { clearSelection(); return; }
  var row = e.target.closest('[data-node]');
  if (row) selectNode(row.dataset.node);
});

/* ================= boot ================= */
loadTeam();
</script>
</body>
</html>`;
}

module.exports = { dashboardPage };
