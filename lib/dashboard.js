'use strict';

const { teamCss, teamJs } = require('./dashboard-team');
const dashboardStyles = require('./dashboard/styles');
const dashboardBody = require('./dashboard/body');
const dashboardClient = require('./dashboard/client');

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
${dashboardStyles(ICON_DATAURI, teamCss)}
</style>
</head>
<body>
${dashboardBody(MARK_WHITE)}
<script>
${dashboardClient(MARK_WHITE, teamJs)}
</script>
</body>
</html>`;
}

module.exports = { dashboardPage };
