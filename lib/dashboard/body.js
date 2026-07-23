'use strict';
// Static <body> markup for the dashboard page, extracted verbatim from
// dashboard.js. MARK_WHITE (inlined brand SVG) is its only interpolation.
module.exports = function dashboardBody(MARK_WHITE) {
  return `
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
`;
};
