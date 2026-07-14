'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { getConfig, loadState, saveState, loadUserConfig, saveUserConfig, ensureConfig, isProjectOff, log } = require('./util');
const advisor = require('./advisor');
const digest = require('./digest');
const hooks = require('./hooks');
const memorydb = require('./memorydb');
const { buildGraph } = require('./graph');
const { syncOnce, getAdapters, findProjectKey } = require('./scan');
const { dashboardPage } = require('./dashboard');
const teamsync = require('./teamsync');

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 1e6) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function statusPayload() {
  const config = getConfig();
  const state = loadState();
  const projects = Object.entries(state.projects || {});
  let lastSync = null;
  const tools = new Set();
  for (const [, proj] of projects) {
    if (proj.lastSync && (!lastSync || proj.lastSync > lastSync)) lastSync = proj.lastSync;
    for (const e of proj.events || []) tools.add(e.source);
  }
  return {
    running: true,
    pid: process.pid,
    version: require('../package.json').version,
    intervalSec: config.intervalSec,
    projectCount: projects.length,
    tools: [...tools],
    adapters: getAdapters(config).map(a => a.displayName),
    lastSync,
  };
}

function projectsPayload() {
  const config = getConfig();
  const state = loadState();
  const regexes = digest.compileRedactions(config);
  const out = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (!Array.isArray(proj.events)) proj.events = []; // added-but-empty project
    let exists = false;
    try {
      exists = fs.statSync(key).isDirectory();
    } catch {}
    out.push({
      path: key,
      name: path.basename(key),
      exists,
      paused: isProjectOff(key, config),
      lastSync: proj.lastSync || null,
      lastActivity: proj.events.length ? proj.events[proj.events.length - 1].ts : null,
      tools: [...new Set(proj.events.map(e => e.source))],
      prompts: digest.recentPrompts(proj, config, regexes).reverse(),
      files: digest.recentFiles(key, proj, config),
      targets: config.targets.map(t => ({
        file: t,
        exists: exists && fs.existsSync(path.join(key, t)),
      })),
      team: teamsync.loadTeamLink(key),
      teammateActivity: (proj.teamEntries || []).length,
    });
  }
  out.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return out;
}

const planPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'plan.json');

function loadPlan(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Exactly what a roadmap request sends to Anthropic — and nothing else:
// project name, the goal, already-redacted recent asks, file paths, and
// top-level names. Never file contents, never other projects. The Plan tab
// lists this verbatim next to the Generate button.
function planPayload(key, proj, config, goal) {
  const regexes = digest.compileRedactions(config);
  return {
    projectName: path.basename(key),
    goal: digest.redactText(String(goal || ''), regexes).slice(0, 2000),
    recentAsks: memorydb.buildEntries(key, proj, config).slice(-20),
    topLevel: memorydb.topLevelNames(key, config),
  };
}

// Everything the project page needs in one payload: fuller history than the
// grid cards — entries carry which files each ask touched — plus injection
// targets and whether a memory.md exists to link to.
function projectDetail(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return null;
  if (!Array.isArray(proj.events)) proj.events = [];
  let exists = false;
  try {
    exists = fs.statSync(key).isDirectory();
  } catch {}
  const adv = advisor.getAdvisorConfig(config);
  return {
    hasKey: !!adv.apiKey,
    plan: loadPlan(key),
    estimate: {
      model: adv.model,
      costUsd: advisor.estimateCost(adv.model, advisor.buildPlanPrompt(planPayload(key, proj, config, '')).length),
    },
    path: key,
    name: path.basename(key),
    exists,
    paused: isProjectOff(key, config),
    lastSync: proj.lastSync || null,
    lastActivity: proj.events.length ? proj.events[proj.events.length - 1].ts : null,
    tools: [...new Set(proj.events.map(e => e.source))],
    entries: memorydb.buildEntries(key, proj, config).slice(-50),
    teamEntries: (proj.teamEntries || []).slice(-50),
    team: teamsync.loadTeamLink(key),
    files: digest.recentFiles(key, proj, { ...config, maxFiles: 20 }),
    targets: config.targets.map(t => ({
      file: t,
      exists: exists && fs.existsSync(path.join(key, t)),
    })),
    memory: {
      relPath: `${memorydb.DIR_NAME}/memory.md`,
      exists: fs.existsSync(memorydb.mdPath(key)),
    },
  };
}

// Read-only view of the project's own memory log. The served path is derived
// from a tracked project key — never from the raw query — so this cannot be
// pointed at arbitrary files.
function memoryMdPayload(projectPath) {
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  if (!key) return null;
  try {
    return fs.readFileSync(memorydb.mdPath(key), 'utf8');
  } catch {
    return null;
  }
}

// Toggle pause by adding/removing the exact project path in config exclude.
function toggleProject(projectPath) {
  ensureConfig();
  const raw = loadUserConfig();
  raw.exclude = raw.exclude || [];
  const idx = raw.exclude.indexOf(projectPath);
  if (idx === -1) raw.exclude.push(projectPath);
  else raw.exclude.splice(idx, 1);
  saveUserConfig(raw);
  return { path: projectPath, paused: idx === -1 };
}

// Register a directory so it shows on the dashboard before any AI activity.
function addProject(projectPath) {
  const resolved = path.resolve(projectPath);
  let isDir = false;
  try {
    isDir = fs.statSync(resolved).isDirectory();
  } catch {}
  if (!isDir) return { error: 'not a directory' };
  const state = loadState();
  const existing = findProjectKey(state, resolved);
  if (existing) return { path: existing, added: false };
  state.projects = state.projects || {};
  state.projects[resolved] = { events: [] };
  saveState(state);
  return { path: resolved, added: true };
}

// Forget a project: strip injected blocks, drop its .membridge dir and state.
// Transcript offsets stay consumed, so only future activity revives it.
function deleteProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath) || path.resolve(projectPath);
  for (const target of config.targets) digest.removeBlock(path.join(key, target));
  memorydb.removeProjectMemory(key);
  if (state.projects && state.projects[key]) {
    delete state.projects[key];
    saveState(state);
  }
  return { path: key, deleted: true };
}

// Settings for the dashboard. The API key itself is never sent to the page —
// only whether one exists, where it came from, and its last 4 characters.
function settingsPayload() {
  const config = getConfig();
  const adv = advisor.getAdvisorConfig(config);
  return {
    hasKey: !!adv.apiKey,
    keySource: adv.source, // 'config' | 'env' | null
    keyHint: adv.source === 'config' ? `…${adv.apiKey.slice(-4)}` : '',
    model: adv.model,
    models: advisor.PLANNER_MODELS,
    intervalSec: config.intervalSec,
    targets: config.targets,
    hookInstalled: hooks.isHookInstalled(),
    distill: {
      enabled: config.distill.enabled,
      consent: config.distill.consent,
      minEdits: config.distill.minEdits,
      checkpointEvery: config.distill.checkpointEvery,
    },
  };
}

function saveSettings(body) {
  ensureConfig();
  const raw = loadUserConfig();
  if (body.apiKey !== undefined) {
    raw.advisor = raw.advisor || {};
    raw.advisor.apiKey = String(body.apiKey || '').trim();
  }
  if (body.model !== undefined && advisor.PLANNER_MODELS.some(m => m.id === body.model)) {
    raw.advisor = raw.advisor || {};
    raw.advisor.model = body.model;
  }
  if (body.intervalSec !== undefined) {
    const n = parseInt(body.intervalSec, 10);
    if (Number.isFinite(n)) raw.intervalSec = Math.max(15, n);
  }
  if (Array.isArray(body.targets)) {
    const t = body.targets.map(s => String(s).trim()).filter(Boolean);
    if (t.length) raw.targets = t;
  }
  if (body.distill && typeof body.distill === 'object') {
    const current = getConfig().distill;
    const next = { ...(raw.distill || {}) };
    if (body.distill.enabled !== undefined) {
      const nowEnabled = !!body.distill.enabled;
      next.enabled = nowEnabled;
      // Unconditional, not just on transition: setupHooks/removeHooks are
      // idempotent, and the config's enabled flag may already say true while
      // the hook itself was never installed (e.g. consent was skipped).
      // Also record consent here, exactly like consent.js's applyConsent —
      // otherwise the first-run popup keeps nagging even though the hook
      // is now installed/removed from the Settings toggle.
      if (nowEnabled) {
        hooks.setupHooks();
        next.consent = 'granted';
      } else {
        hooks.removeHooks();
        next.consent = 'declined';
      }
    }
    if (body.distill.minEdits !== undefined) {
      const n = Number(body.distill.minEdits);
      next.minEdits = Number.isFinite(n) && n >= 1 ? n : current.minEdits;
    }
    if (body.distill.checkpointEvery !== undefined) {
      const n = Number(body.distill.checkpointEvery);
      next.checkpointEvery = Number.isFinite(n) && n >= 1 ? n : current.checkpointEvery;
    }
    // Explicit consent (e.g. re-showing the first-run prompt from Settings)
    // overrides whatever the enabled toggle above implied.
    if (['granted', 'declined', null].includes(body.distill.consent)) {
      next.consent = body.distill.consent;
    }
    raw.distill = next;
  }
  saveUserConfig(raw);
  return settingsPayload();
}

// "Copy for AI" digest: a trimmed, already-redacted handoff the dashboard
// puts on the clipboard for pasting into web AIs (ChatGPT, claude.ai, ...)
// that cannot see this disk. The manual bridge until importers/MCP (M5).
function copyPayload(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath);
  const proj = key ? state.projects[key] : null;
  if (!proj) return { error: 'unknown project' };
  if (!Array.isArray(proj.events)) proj.events = [];
  return { path: key, text: memorydb.renderCopyText(key, proj, config) };
}

// A token-free view of team state for the dashboard. Credentials never cross
// the local HTTP boundary; the browser only receives identity metadata.
async function teamPayload() {
  const config = getConfig();
  const creds = teamsync.loadCredentials();
  const state = loadState();
  const linkedProjects = Object.keys(state.projects || {}).map(projectPath => {
    const link = teamsync.loadTeamLink(projectPath);
    if (!link) return null;
    return {
      path: projectPath,
      name: path.basename(projectPath),
      teamId: link.teamId,
      teamName: link.teamName || '',
      linkedAt: link.linkedAt || null,
      teammateActivity: (state.projects[projectPath].teamEntries || []).length,
    };
  }).filter(Boolean);
  // Pending auto-link suggestions (a teammate linked a project with the same
  // git remote) awaiting the user's confirm/dismiss.
  const suggestions = Object.entries(state.projects || {}).map(([projectPath, proj]) => {
    const s = proj && proj.teamSuggestion;
    if (!s || teamsync.loadTeamLink(projectPath)) return null;
    return { path: projectPath, name: path.basename(projectPath), teamName: s.teamName, repoUrl: s.repoUrl };
  }).filter(Boolean);
  let teams = [];
  let error = null;
  if (creds) {
    try {
      teams = await teamsync.listTeams(config);
    } catch (err) {
      error = err.message;
    }
  }
  return {
    configured: teamsync.isConfigured(config),
    authenticated: !!creds,
    webUrl: teamsync.webUrl(config),
    user: creds ? {
      email: creds.email,
      displayName: creds.displayName,
    } : null,
    teams,
    linkedProjects,
    suggestions,
    projects: projectsPayload().map(p => ({
      path: p.path,
      name: p.name,
      exists: p.exists,
      paused: p.paused,
      team: p.team,
    })),
    error,
  };
}

async function runTeamSync(projectPath) {
  const result = await teamsync.syncTeams(projectPath ? { project: projectPath } : {});
  for (const key of result.changed) syncOnce({ project: key });
  return result;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardPage());
    } else if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, statusPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/projects') {
      json(res, 200, projectsPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/project') {
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const d = projectDetail(p);
      if (!d) return json(res, 404, { error: 'unknown project' });
      json(res, 200, d);
    } else if (req.method === 'GET' && url.pathname === '/api/project/memory') {
      const p = String(url.searchParams.get('path') || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const text = memoryMdPayload(p);
      res.writeHead(text === null ? 404 : 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text === null ? 'No memory log for this project yet.' : text);
    } else if (req.method === 'GET' && url.pathname === '/api/graph') {
      json(res, 200, buildGraph(loadState(), getConfig()));
    } else if (req.method === 'GET' && url.pathname === '/api/settings') {
      json(res, 200, settingsPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/team') {
      json(res, 200, await teamPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      json(res, 200, saveSettings(body));
    } else if (req.method === 'POST' && url.pathname === '/api/settings/test') {
      // Tests the pasted key if one is provided, else the stored/env key.
      const body = await readBody(req);
      const adv = advisor.getAdvisorConfig(getConfig());
      const key = String(body.apiKey || '').trim() || adv.apiKey;
      json(res, 200, await advisor.testKey(key, adv.model));
    } else if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readBody(req);
      const projectPath = String(body.project || '').trim() || null;
      const local = syncOnce(projectPath ? { project: projectPath } : {});
      const team = await runTeamSync(projectPath);
      json(res, 200, { ...local, team });
    } else if (req.method === 'POST' && url.pathname === '/api/team/signup') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const displayName = String(body.displayName || '').trim();
      if (!email || !password || !displayName) return json(res, 400, { error: 'name, email, and password are required' });
      const result = await teamsync.signup(getConfig(), email, password, displayName);
      json(res, 200, { needsConfirmation: !!result.needsConfirmation, email: result.email });
    } else if (req.method === 'POST' && url.pathname === '/api/team/login') {
      const body = await readBody(req);
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      if (!email || !password) return json(res, 400, { error: 'email and password are required' });
      const result = await teamsync.login(getConfig(), email, password, String(body.displayName || '').trim());
      json(res, 200, { email: result.email, displayName: result.displayName });
    } else if (req.method === 'POST' && url.pathname === '/api/team/logout') {
      teamsync.clearCredentials();
      json(res, 200, { authenticated: false });
    } else if (req.method === 'POST' && url.pathname === '/api/team/create') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return json(res, 400, { error: 'team name is required' });
      json(res, 200, await teamsync.createTeam(getConfig(), name));
    } else if (req.method === 'POST' && url.pathname === '/api/team/join') {
      const body = await readBody(req);
      const inviteCode = String(body.inviteCode || '').trim();
      if (!inviteCode) return json(res, 400, { error: 'invite code is required' });
      json(res, 200, await teamsync.join(getConfig(), inviteCode));
    } else if (req.method === 'POST' && url.pathname === '/api/team/invite') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      const days = parseInt(body.expiresDays, 10);
      const maxUses = parseInt(body.maxUses, 10);
      json(res, 200, await teamsync.createInvite(getConfig(), teamId, {
        expiresAt: Number.isFinite(days) ? new Date(Date.now() + days * 86400000).toISOString() : null,
        maxUses: Number.isFinite(maxUses) ? maxUses : null,
      }));
    } else if (req.method === 'POST' && url.pathname === '/api/team/suggestion') {
      // Confirm or dismiss an auto-link suggestion; linking starts a sync.
      const body = await readBody(req);
      const projectPath = String(body.path || '').trim();
      if (!projectPath) return json(res, 400, { error: 'project is required' });
      const link = await teamsync.resolveSuggestion(getConfig(), projectPath, !!body.accept);
      if (link) await runTeamSync(projectPath);
      json(res, 200, { linked: !!link });
    } else if (req.method === 'POST' && url.pathname === '/api/team/link') {
      const body = await readBody(req);
      const projectPath = String(body.path || '').trim();
      const teamId = String(body.teamId || '').trim();
      const teamName = String(body.teamName || '').trim();
      if (!projectPath || !teamId) return json(res, 400, { error: 'project and team are required' });
      const projectKey = findProjectKey(loadState(), projectPath);
      if (!projectKey) return json(res, 404, { error: 'unknown project' });
      const link = await teamsync.linkProject(getConfig(), projectKey, teamId, teamName);
      await runTeamSync(projectKey);
      json(res, 200, link);
    } else if (req.method === 'POST' && url.pathname === '/api/team/unlink') {
      const body = await readBody(req);
      const projectPath = String(body.path || '').trim();
      if (!projectPath) return json(res, 400, { error: 'project is required' });
      const projectKey = findProjectKey(loadState(), projectPath);
      if (!projectKey) return json(res, 404, { error: 'unknown project' });
      json(res, 200, { unlinked: teamsync.unlinkProject(projectKey) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/sync') {
      const body = await readBody(req);
      json(res, 200, await runTeamSync(String(body.path || '').trim() || null));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/toggle') {
      const body = await readBody(req);
      if (!body.path) return json(res, 400, { error: 'path required' });
      json(res, 200, toggleProject(body.path));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/add') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const r = addProject(p);
      json(res, r.error ? 400 : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/projects/delete') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      json(res, 200, deleteProject(p));
    } else if (req.method === 'POST' && url.pathname === '/api/projects/copy') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      const r = copyPayload(p);
      json(res, r.error ? 404 : 200, r);
    } else if (req.method === 'POST' && url.pathname === '/api/plan/generate') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      const goal = String(body.goal || '').trim();
      if (!p || !goal) return json(res, 400, { error: 'path and goal required' });
      const config = getConfig();
      const state = loadState();
      const key = findProjectKey(state, p);
      const proj = key ? state.projects[key] : null;
      if (!proj) return json(res, 404, { error: 'unknown project' });
      if (!Array.isArray(proj.events)) proj.events = [];
      const adv = advisor.getAdvisorConfig(config);
      if (!adv.apiKey) return json(res, 400, { error: 'Add your Anthropic key in Settings first.' });
      const payload = planPayload(key, proj, config, goal);
      const r = await advisor.generatePlan(adv.apiKey, adv.model, payload);
      if (!r.ok) return json(res, r.status || 502, { error: r.error });
      const saved = {
        goal: payload.goal,
        generatedAt: new Date().toISOString(),
        model: r.model,
        costUsd: r.costUsd,
        usage: r.usage,
        plan: r.plan,
      };
      fs.mkdirSync(path.join(key, memorydb.DIR_NAME), { recursive: true });
      fs.writeFileSync(planPath(key), JSON.stringify(saved, null, 2));
      // Re-render this project's memory block right away so the roadmap line
      // reaches CLAUDE.md/AGENTS.md now, not on the next activity. syncOnce
      // skips paused/missing projects on its own.
      syncOnce({ project: key });
      json(res, 200, { ok: true, plan: saved });
    } else {
      json(res, 404, { error: 'not found' });
    }
  } catch (err) {
    log(`dashboard error ${req.method} ${url.pathname}: ${err.message}`);
    json(res, 500, { error: err.message });
  }
}

// Local-only by design: binds 127.0.0.1, never an external interface.
// A fast stop→start can find the port still held by the dying daemon; without
// a retry the new daemon would keep syncing forever with a dead dashboard.
function startServer(port, opts = {}) {
  const retries = opts.retries === undefined ? 20 : opts.retries;
  const retryDelayMs = opts.retryDelayMs === undefined ? 500 : opts.retryDelayMs;
  const server = http.createServer(handle);
  let attempt = 0;
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      if (attempt < retries) {
        attempt++;
        log(`dashboard port ${port} in use, retrying (${attempt}/${retries})`);
        setTimeout(() => server.listen(port, '127.0.0.1'), retryDelayMs).unref();
      } else {
        log(`dashboard port ${port} still in use after ${retries} retries; giving up (is another MemBridge running?). Sync continues without the dashboard.`);
      }
      return;
    }
    log(`dashboard server error: ${err.message}`);
  });
  server.listen(port, '127.0.0.1', () => log(`dashboard on http://127.0.0.1:${port}`));
  return server;
}

module.exports = { startServer, statusPayload, projectsPayload, projectDetail, toggleProject, addProject, deleteProject, copyPayload, settingsPayload, saveSettings, teamPayload, runTeamSync };
