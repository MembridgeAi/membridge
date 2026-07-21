'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const { getConfig, loadState, saveState, loadUserConfig, saveUserConfig, ensureConfig, isProjectOff, log, effectiveTargets, EXTRA_TARGETS } = require('./util');
const advisor = require('./advisor');
const digest = require('./digest');
const hooks = require('./hooks');
const memorydb = require('./memorydb');
const feed = require('./feed');
const { syncOnce, getAdapters, findProjectKey, scanAll } = require('./scan');
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
    teamLastSync: state.teamLastSync || null,
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
      targets: effectiveTargets(config).map(t => ({
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

// Unified cross-project, cross-team feed. Local memory is always available;
// each team is fetched independently so one unreachable team degrades to a
// flag instead of failing the whole feed.
async function feedPayload(opts) {
  const config = getConfig();
  const state = loadState();
  const creds = teamsync.loadCredentials();
  const selfUserId = creds ? creds.userId : null;
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  // One compiled redactor for the whole payload, threaded into the
  // normalizers: team rows are server content and must be re-redacted before
  // they surface (defense in depth against a hostile or legacy backend row,
  // same rule as the context-block render path); local entries arrive
  // pre-redacted from buildEntries, so their pass is defensive only.
  const regexes = digest.compileRedactions(config);
  const redact = text => digest.redactText(text, regexes);

  // Local: every watched project's entries, tagged with project identity.
  const local = [];
  for (const [key, proj] of Object.entries(state.projects || {})) {
    if (!Array.isArray(proj.events)) proj.events = [];
    const link = teamsync.loadTeamLink(key);
    const meta = { projectPath: key, projectName: path.basename(key), projectId: link ? link.projectId : null, authorId: selfUserId, redact };
    for (const e of memorydb.buildEntries(key, proj, config)) {
      local.push(feed.normalizeLocal({ ...e, shared: teamsync.isShared(config, proj, e.session) }, meta));
    }
  }

  // Team: team_feed RPC per membership, fetched concurrently. Any failure ->
  // degrade (flag), never throw; a non-array teams response degrades too.
  // team_feed's p_project is a uuid; the client may filter by a local path
  // (.fproj navigation, Settings list, and Home chips for local-only projects
  // all use `#project=/abs/path`). Resolve a path to its linked team-project
  // uuid; an unlinked local project has no team rows, so skip the team query
  // rather than sending a bad uuid (which Postgres rejects, degrading the feed).
  let teamProject = opts.project || null;
  let skipTeam = false;
  if (opts.project && opts.project.charAt(0) === '/') {
    const link = teamsync.loadTeamLink(opts.project);
    if (link && link.projectId) teamProject = link.projectId;
    else { skipTeam = true; }
  }

  let team = [];
  let teamUnavailable = false;
  let teamList = [];
  if (creds && !skipTeam) {
    let teams = [];
    try {
      teams = await teamsync.listTeams(config);
    } catch { teamUnavailable = true; }
    teamList = Array.isArray(teams) ? teams : [];
    if (teams != null && !Array.isArray(teams)) teamUnavailable = true;
    // NOTE: team pagination here is the accepted "approximate seam" (plan
    // out-of-scope: true unified cursor). We pass beforeCreatedAt only (no
    // beforeId), and `before` is an entry ts not a created_at, so team rows
    // sharing the exact boundary created_at may be skipped on Load more. The
    // local source is lossless (inclusive <=); the cross-source seam is not.
    // The person filter passes a display NAME, but team_feed's p_author is a
    // UUID (author_id). Passing a name there is a type error that fails the whole
    // team query (shows "sync unreachable"). So only forward author to the RPC
    // when it is a real UUID; a name is applied to team rows by name below.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rpcAuthor = opts.author && UUID_RE.test(opts.author) ? opts.author : null;
    const settled = await Promise.allSettled(teamList.map(t =>
      teamsync.teamFeed(config, t.team_id, {
        author: rpcAuthor, project: teamProject, source: opts.source,
        beforeCreatedAt: opts.before || null, since: opts.since || null, limit,
      })));
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        for (const row of r.value || []) team.push(feed.normalizeTeam(row, { selfUserId, redact }));
      } else {
        teamUnavailable = true;
      }
    }
    // Author name filter for team rows (RPC filtered by uuid only, or not at all).
    if (opts.author && !UUID_RE.test(opts.author)) {
      team = team.filter(e => e.author === opts.author || e.authorId === opts.author);
    }
  }

  // Client-side filters also apply to local rows (team rows already filtered by
  // the RPC). The `before` boundary is INCLUSIVE (<=) so same-second entries at
  // a page edge are never dropped on "Load more"; the client dedupes the
  // one-entry overlap when appending pages.
  const f = local.filter(e =>
    (!opts.author || e.author === opts.author || e.authorId === opts.author) &&
    (!opts.project || e.projectPath === opts.project || e.projectId === opts.project) &&
    (!opts.source || e.source === opts.source) &&
    (!opts.since || String(e.ts) >= String(opts.since)) &&
    (!opts.before || String(e.ts) <= String(opts.before)));

  // Pending auto-link suggestions (a teammate linked a project sharing this
  // git remote) awaiting confirm/dismiss — surfaced atop the Home feed.
  const suggestions = Object.entries(state.projects || {}).map(([projectPath, proj]) => {
    const s = proj && proj.teamSuggestion;
    if (!s || teamsync.loadTeamLink(projectPath)) return null;
    return { path: projectPath, name: path.basename(projectPath), teamName: s.teamName, repoUrl: s.repoUrl };
  }).filter(Boolean);

  // Home reads these lightweight flags to pick its empty / no-team state and
  // its suggested-links card without a second round-trip to /api/team.
  const out = feed.buildFeed({ local: f, team, teamUnavailable, limit });
  // When a team is unreachable, the live team_feed rows are gone, but each
  // project cached its last-pulled teammate entries. Derive distinct author
  // names from that cache so the offline headline can still say who was active
  // instead of "unavailable". Empty when the feed is healthy.
  let offlineTeammates = [];
  if (teamUnavailable) {
    const names = new Set();
    for (const proj of Object.values(state.projects || {})) {
      for (const e of proj.teamEntries || []) {
        if (e && e.author && e.author !== 'You') names.add(e.author);
      }
    }
    offlineTeammates = [...names];
  }
  return { ...out, signedIn: !!creds, hasTeam: teamList.length > 0, suggestions, offlineTeammates };
}

// Read-only discovery view (dashboard equivalent of `membridge scan`): which
// adapters/session directories exist, and which projects have AI activity.
// Mirrors cmdScan's fresh-state pass exactly — nothing is persisted, so
// this must only run when the user opens the view, never on a poll timer.
function scanPayload() {
  const config = getConfig();
  const adapters = [];
  for (const a of getAdapters(config)) {
    for (const root of a.sessionRoots(config)) {
      adapters.push({ displayName: a.displayName, root, exists: fs.existsSync(root) });
    }
  }
  const state = { files: {}, projects: {} }; // fresh: scan everything from byte 0
  const events = scanAll(state, config);
  digest.mergeEvents(state, events, config);
  const projects = Object.entries(state.projects).map(([key, proj]) => {
    const bySource = {};
    for (const e of proj.events) bySource[e.source] = (bySource[e.source] || 0) + 1;
    return {
      path: key,
      name: path.basename(key),
      paused: isProjectOff(key, config),
      bySource,
    };
  });
  return { adapters, projectCount: projects.length, projects };
}

const planPath = projectPath => path.join(projectPath, memorydb.DIR_NAME, 'plan.json');

function loadPlan(projectPath) {
  try {
    return JSON.parse(fs.readFileSync(planPath(projectPath), 'utf8'));
  } catch {
    return null;
  }
}

// Fold a shared project's cached teammate entries into the roadmap's recent
// asks so the plan reflects the whole team's recent work, not just this
// machine's. Deduped on source|ts|ask, sorted oldest-first, capped like the
// local-only path was. teamEntries carry no tasks/checkpoints (out of scope) —
// only ts/source/ask/files/summary survive into the prompt. A teammate entry's
// `ask` can be null (memory_entries.ask is nullable) — fall back to its
// summary, and drop entries where both are empty so a literal "null" never
// reaches the prompt.
function mergeRecentAsks(key, proj, config) {
  const local = memorydb.buildEntries(key, proj, config);
  const team = (proj.teamEntries || [])
    .map(e => ({
      ts: e.ts,
      source: e.source,
      ask: e.ask || e.summary || '',
      files: Array.isArray(e.files) ? e.files : [],
      summary: e.summary || undefined,
      author: e.author,
    }))
    .filter(e => e.ask);
  const seen = new Set();
  const merged = [];
  for (const e of [...local, ...team]) {
    const k = `${e.source}|${e.ts}|${e.ask}`;
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(e);
  }
  merged.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return merged.slice(-20);
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
    recentAsks: mergeRecentAsks(key, proj, config),
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
  const rx = digest.compileRedactions(config);
  const teamEntries = proj.teamEntries || [];
  const localLast = proj.events.length ? proj.events[proj.events.length - 1].ts : null;
  const teamLast = teamEntries.reduce((m, e) => (!m || String(e.ts) > String(m) ? e.ts : m), null);
  const lastTouched = [localLast, teamLast].filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || null;
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
    lastActivity: localLast,
    lastTouched,
    activeLabel: digest.relativeLabel(lastTouched),
    stats: memorydb.projectStats(key, proj),
    tools: [...new Set(proj.events.map(e => e.source))],
    entries: memorydb.buildEntries(key, proj, config).slice(-50),
    // Pulled teamEntries are server content stored raw at pull time; re-redact
    // the free text before it crosses the local HTTP boundary, same rule as
    // the feed routes and the context-block render.
    teamEntries: teamEntries.slice(-50).map(e => ({
      ...e,
      ask: e.ask ? digest.redactText(e.ask, rx) : e.ask,
      summary: e.summary ? digest.redactText(e.summary, rx) : e.summary,
      goal: e.goal ? digest.redactText(e.goal, rx) : e.goal,
      decisions: e.decisions ? digest.redactText(e.decisions, rx) : e.decisions,
      gotchas: e.gotchas ? digest.redactText(e.gotchas, rx) : e.gotchas,
      changes: Array.isArray(e.changes) ? e.changes.map(c => ({ ...c, note: c.note ? digest.redactText(c.note, rx) : c.note })) : [],
    })),
    team: teamsync.loadTeamLink(key),
    files: digest.recentFiles(key, proj, { ...config, maxFiles: 20 }),
    targets: effectiveTargets(config).map(t => ({
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
  for (const target of effectiveTargets(config)) {
    digest.removeBlock(path.join(key, target), { preamble: digest.preambleFor(target), projectRoot: key });
  }
  memorydb.removeProjectMemory(key);
  if (state.projects && state.projects[key]) {
    delete state.projects[key];
    saveState(state);
  }
  return { path: key, deleted: true };
}

// Delete a SHARED project. Owners/admins archive it for the whole team
// (reversible soft-delete on the backend) and clean up locally; a plain member
// can only unlink their own machine. The backend archive_project RPC is the
// real authorization — the local role check just picks the branch. A path with
// no team link falls back to a plain local delete.
async function archiveSharedProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath) || path.resolve(projectPath);
  const link = teamsync.loadTeamLink(key);
  if (!link || !link.projectId) {
    return { ...deleteProject(key), scope: 'local' };
  }
  const teams = await teamsync.listTeams(config).catch(() => []);
  const team = (teams || []).find(t => t.team_id === link.teamId);
  const isManager = !!team && ['owner', 'admin'].includes(team.role);
  if (!isManager) {
    // Plain member: unlink this machine only; never archive for the team.
    const unlinked = teamsync.unlinkProject(key);
    return {
      path: key, scope: 'local', archived: false, unlinked,
      message: 'only owners or managers can delete a shared project for the team',
    };
  }
  await teamsync.archiveProject(config, link.projectId);
  teamsync.unlinkProject(key); // drop team.json first
  deleteProject(key);          // then strip injected blocks + wipe local memory/state
  return { path: key, scope: 'team', archived: true };
}

// Strip the injected block from a project's context files without touching
// its .membridge history/memory or state. Syncing again will re-add the
// block unless the project is paused first.
function removeBlockFromProject(projectPath) {
  const config = getConfig();
  const state = loadState();
  const key = findProjectKey(state, projectPath) || path.resolve(projectPath);
  for (const target of effectiveTargets(config)) {
    digest.removeBlock(path.join(key, target), { preamble: digest.preambleFor(target), projectRoot: key });
  }
  return { path: key, removed: true };
}

// Catch-Up read pointer. GET is pure (never mutates); mark/undo rewrite the
// pointer immutably so a mis-tap is one-step reversible from Home. The cached
// briefing (Phase 2) is surfaced here so Home can render it without regenerating.
function catchupPayload() {
  const c = loadState().catchup || {};
  return {
    lastViewedTs: c.lastViewedTs || null,
    prevViewedTs: c.prevViewedTs || null,
    hasBriefing: !!(c.briefing && c.briefing.text),
    briefing: c.briefing || null,
  };
}

function markCaughtUp(ts) {
  const state = loadState();
  const c = state.catchup || {};
  const next = {
    ...c,
    prevViewedTs: c.lastViewedTs || null,
    lastViewedTs: ts || new Date().toISOString(),
  };
  saveState({ ...state, catchup: next });
  return { lastViewedTs: next.lastViewedTs, prevViewedTs: next.prevViewedTs };
}

function undoCaughtUp() {
  const state = loadState();
  const c = state.catchup || {};
  const next = { ...c, lastViewedTs: c.prevViewedTs || null, prevViewedTs: null };
  saveState({ ...state, catchup: next });
  return { lastViewedTs: next.lastViewedTs, prevViewedTs: next.prevViewedTs };
}

// Multi-provider advisor settings for the dashboard. Never returns a key
// value — only whether each provider has one set (keySet), plus its
// non-secret baseUrl (for local/OpenAI-compatible endpoints).
function advisorPayload() {
  const config = getConfig();
  const raw = loadUserConfig();
  const adv = advisor.getAdvisorConfig(config);
  const stored = (raw.advisor && raw.advisor.providers) || {};
  // Legacy top-level key still counts as "set" for anthropic unless the
  // provider entry now carries its own key (mirror of getAdvisorConfig's gate,
  // so a stored model-only entry doesn't make the key look absent).
  const legacyAnthropicKey = raw.advisor && !(stored.anthropic && stored.anthropic.apiKey) ? raw.advisor.apiKey : '';
  const providers = advisor.providers.list().map(a => {
    const pconf = stored[a.id] || {};
    const keySet = !!(pconf.apiKey || (a.id === 'anthropic' && legacyAnthropicKey) || (a.keyEnv || []).some(k => process.env[k]));
    return {
      id: a.id, label: a.label, needsBaseUrl: a.needsBaseUrl,
      models: a.models, keySet,
      baseUrl: a.needsBaseUrl ? (pconf.baseUrl || '') : undefined,
      model: pconf.model || (a.id === adv.provider ? adv.model : (a.models[0] ? a.models[0].id : '')),
    };
  });
  return { provider: adv.provider, model: adv.model, providers };
}

// Settings for the dashboard. The API key itself is never sent to the page —
// only whether one exists, where it came from, and its last 4 characters.
function settingsPayload() {
  const config = getConfig();
  const raw = loadUserConfig();
  const adv = advisor.getAdvisorConfig(config);
  const team = raw.team && typeof raw.team === 'object' ? raw.team : {};
  return {
    hasKey: !!adv.apiKey,
    keySource: adv.source, // 'config' | 'env' | null
    keyHint: adv.source === 'config' ? `…${adv.apiKey.slice(-4)}` : '',
    model: adv.model,
    models: advisor.PLANNER_MODELS,
    advisor: advisorPayload(),
    intervalSec: config.intervalSec,
    targets: config.targets,
    extraTargets: config.extraTargets,
    extraTargetFiles: EXTRA_TARGETS,
    hookInstalled: hooks.isHookInstalled(),
    distill: {
      enabled: config.distill.enabled,
      consent: config.distill.consent,
      minEdits: config.distill.minEdits,
      checkpointEvery: config.distill.checkpointEvery,
    },
    team: {
      url: String(team.url || ''),
      anonKey: String(team.anonKey || ''),
      customBackend: !!(team.url && team.anonKey),
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
  if (body.extraTargets && typeof body.extraTargets === 'object') {
    const next = { ...(raw.extraTargets && typeof raw.extraTargets === 'object' ? raw.extraTargets : {}) };
    for (const key of Object.keys(EXTRA_TARGETS)) {
      if (body.extraTargets[key] !== undefined) next[key] = !!body.extraTargets[key];
    }
    raw.extraTargets = next;
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
  if (body.advisor && typeof body.advisor === 'object') {
    const b = body.advisor;
    raw.advisor = raw.advisor || {};
    raw.advisor.providers = raw.advisor.providers || {};
    const pid = advisor.providers.byId(b.provider) ? b.provider
      : (advisor.providers.byId(raw.advisor.provider) ? raw.advisor.provider : 'anthropic');
    if (b.provider !== undefined && advisor.providers.byId(b.provider)) raw.advisor.provider = b.provider;
    // Only materialize a provider-scoped entry when there is actually a field
    // to store — a bare provider switch (no key/baseUrl/model) must not
    // create an empty `providers[pid]` object, since its mere presence
    // shadows the legacy top-level advisor.apiKey fallback for 'anthropic'
    // in advisor.getAdvisorConfig (an empty object is still truthy).
    if (b.apiKey !== undefined || b.baseUrl !== undefined || b.model !== undefined) {
      const p = raw.advisor.providers[pid] = { ...(raw.advisor.providers[pid] || {}) };
      if (b.apiKey !== undefined) p.apiKey = String(b.apiKey || '').trim();
      if (b.baseUrl !== undefined) p.baseUrl = String(b.baseUrl || '').trim();
      if (b.model !== undefined) {
        const adapter = advisor.providers.byId(pid);
        const ok = adapter.models.length ? adapter.models.some(m => m.id === b.model) : !!String(b.model || '').trim();
        if (ok) p.model = String(b.model).trim();
      }
    }
  }
  if (body.team && typeof body.team === 'object') {
    // Only the backend fields are dashboard-editable; keep flags like
    // sharePrompts that live under the same config key.
    raw.team = {
      ...(raw.team && typeof raw.team === 'object' ? raw.team : {}),
      url: String(body.team.url || '').trim(),
      anonKey: String(body.team.anonKey || '').trim(),
    };
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
      userId: creds.userId,
      email: creds.email,
      displayName: creds.displayName,
    } : null,
    teams: (teams || []).map(t => ({
      ...t,
      memberCount: typeof t.member_count === 'number' ? t.member_count : null,
      createdAt: t.created_at || null,
    })),
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

// Team projects for the hub: backend stats joined with whichever local folder
// (if any) is linked to each team project, so the UI can cross-link the views.
async function teamProjectsPayload(teamId) {
  const rows = await teamsync.projectStats(getConfig(), teamId);
  const state = loadState();
  const localByProjectId = {};
  for (const projectPath of Object.keys(state.projects || {})) {
    const link = teamsync.loadTeamLink(projectPath);
    if (link && link.projectId) localByProjectId[link.projectId] = projectPath;
  }
  return (rows || []).map(r => ({ ...r, localPath: localByProjectId[r.project_id] || null }));
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
    } else if (req.method === 'GET' && url.pathname === '/api/feed') {
      const q = k => String(url.searchParams.get(k) || '').trim() || null;
      const raw = parseInt(url.searchParams.get('limit'), 10);
      const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 200) : 50;
      json(res, 200, await feedPayload({
        author: q('author'), project: q('project'), source: q('source'),
        before: q('before'), since: q('since'), limit,
      }));
    } else if (req.method === 'GET' && url.pathname === '/api/catchup') {
      json(res, 200, catchupPayload());
    } else if (req.method === 'GET' && url.pathname === '/api/scan') {
      json(res, 200, scanPayload());
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
    } else if (req.method === 'GET' && url.pathname === '/api/advisor') {
      json(res, 200, advisorPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/advisor') {
      const body = await readBody(req);
      saveSettings({ advisor: body });
      json(res, 200, advisorPayload());
    } else if (req.method === 'POST' && url.pathname === '/api/advisor/test') {
      const body = await readBody(req);
      const config = getConfig();
      const provider = advisor.providers.byId(body.provider) ? body.provider : advisor.getAdvisorConfig(config).provider;
      const adv = advisor.getAdvisorConfig({ ...config, advisor: { ...(config.advisor || {}), provider } });
      const key = String(body.apiKey || '').trim() || adv.apiKey;
      const baseUrl = String(body.baseUrl || '').trim() || adv.baseUrl;
      json(res, 200, await advisor.testKey(key, adv.model, { provider, baseUrl }));
    } else if (req.method === 'POST' && url.pathname === '/api/sync') {
      const body = await readBody(req);
      const projectPath = String(body.project || '').trim() || null;
      const local = syncOnce(projectPath ? { project: projectPath } : {});
      const team = await runTeamSync(projectPath);
      json(res, 200, { ...local, team });
    } else if (req.method === 'POST' && url.pathname === '/api/share-session') {
      // Persist-first: the per-session share flag lands in proj.sharedSessions
      // (authoritative for future normal pushes) before we attempt the
      // network reshare, so the intent survives a failed/offline reshare —
      // the next sync reconciles it.
      const body = await readBody(req);
      const projectPath = String(body.project || '').trim();
      const session = String(body.session || '').trim();
      const share = !!body.share;
      if (!projectPath || !session) return json(res, 400, { error: 'project and session required' });
      const state = loadState();
      const key = findProjectKey(state, projectPath);
      const proj = key ? state.projects[key] : null;
      if (!proj) return json(res, 404, { error: 'unknown project' });
      const set = new Set(Array.isArray(proj.sharedSessions) ? proj.sharedSessions : []);
      if (share) set.add(session); else set.delete(session);
      proj.sharedSessions = [...set];
      saveState(state);
      let reshare = { ok: true };
      try { reshare = await teamsync.reshareSession(getConfig(), key, session, share); }
      catch (err) { reshare = { ok: false, error: err.message }; }
      json(res, 200, { ok: true, shared: share, reshare });
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
    } else if (req.method === 'GET' && url.pathname === '/api/team/members') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { members: await teamsync.listMembers(getConfig(), teamId) });
    } else if (req.method === 'GET' && url.pathname === '/api/team/feed') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      const q = k => String(url.searchParams.get(k) || '').trim() || null;
      const limit = parseInt(url.searchParams.get('limit'), 10);
      const beforeId = parseInt(url.searchParams.get('beforeId'), 10);
      const config = getConfig();
      const rows = await teamsync.teamFeed(config, teamId, {
        author: q('author'),
        project: q('project'),
        source: q('source'),
        beforeCreatedAt: q('beforeCreatedAt'),
        beforeId: Number.isFinite(beforeId) ? beforeId : null,
        limit: Number.isFinite(limit) ? limit : 50,
      });
      // Same read-side redaction as feedPayload: these are server rows, and a
      // hostile or legacy backend row must not surface raw free text.
      const rx = digest.compileRedactions(config);
      const scrubRow = r => ({
        ...r,
        ask: r.ask ? digest.redactText(r.ask, rx) : r.ask,
        summary: r.summary ? digest.redactText(r.summary, rx) : r.summary,
      });
      // Fail closed: anything but the expected array (or the null of an empty
      // 204) must not pass through unscrubbed.
      json(res, 200, { entries: Array.isArray(rows) ? rows.map(scrubRow) : (rows == null ? rows : []) });
    } else if (req.method === 'GET' && url.pathname === '/api/team/projects') {
      const teamId = String(url.searchParams.get('teamId') || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { projects: await teamProjectsPayload(teamId) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/remove-member') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const userId = String(body.userId || '').trim();
      if (!teamId || !userId) return json(res, 400, { error: 'team and member are required' });
      await teamsync.removeMember(getConfig(), teamId, userId);
      json(res, 200, { removed: true });
    } else if (req.method === 'POST' && url.pathname === '/api/team/set-role') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const userId = String(body.userId || '').trim();
      const role = String(body.role || '').trim();
      if (!teamId || !userId || !role) return json(res, 400, { error: 'team, member, and role are required' });
      await teamsync.setRole(getConfig(), teamId, userId, role);
      json(res, 200, { role });
    } else if (req.method === 'POST' && url.pathname === '/api/team/rename') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      const name = String(body.name || '').trim();
      if (!teamId || !name) return json(res, 400, { error: 'team and name are required' });
      await teamsync.renameTeam(getConfig(), teamId, name);
      json(res, 200, { name });
    } else if (req.method === 'POST' && url.pathname === '/api/team/rotate-invite') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      json(res, 200, { inviteCode: await teamsync.rotateInvite(getConfig(), teamId) });
    } else if (req.method === 'POST' && url.pathname === '/api/team/revoke-invite') {
      const body = await readBody(req);
      const token = String(body.token || '').trim();
      if (!token) return json(res, 400, { error: 'invite token is required' });
      await teamsync.revokeInvite(getConfig(), token);
      json(res, 200, { revoked: true });
    } else if (req.method === 'POST' && url.pathname === '/api/team/leave') {
      const body = await readBody(req);
      const teamId = String(body.teamId || '').trim();
      if (!teamId) return json(res, 400, { error: 'team is required' });
      await teamsync.leaveTeam(getConfig(), teamId);
      json(res, 200, { left: true });
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
    } else if (req.method === 'POST' && url.pathname === '/api/team/archive-project') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      json(res, 200, await archiveSharedProject(p));
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
    } else if (req.method === 'POST' && url.pathname === '/api/catchup/mark') {
      const body = await readBody(req);
      const ts = String(body.ts || '').trim() || null;
      json(res, 200, markCaughtUp(ts));
    } else if (req.method === 'POST' && url.pathname === '/api/catchup/undo') {
      json(res, 200, undoCaughtUp());
    } else if (req.method === 'POST' && url.pathname === '/api/projects/remove') {
      const body = await readBody(req);
      const p = String(body.path || '').trim();
      if (!p) return json(res, 400, { error: 'path required' });
      json(res, 200, removeBlockFromProject(p));
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
      if (!adv.apiKey && !adv.baseUrl) return json(res, 400, { error: `Add your ${adv.adapter.label} key in Settings first.` });
      const payload = planPayload(key, proj, config, goal);
      const r = await advisor.generatePlan(adv.apiKey, adv.model, payload, { provider: adv.provider, baseUrl: adv.baseUrl });
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
    } else if (req.method === 'POST' && url.pathname === '/api/briefing/generate') {
      const body = await readBody(req);
      // Default the window to "since you last looked" so a briefing is always a
      // catch-up even if the client omits `since` (review MEDIUM #2).
      const catchupState = loadState().catchup || {};
      const since = String(body.since || '').trim() || catchupState.lastViewedTs || null;
      const config = getConfig();
      const adv = advisor.getAdvisorConfig(config);
      // No key -> degrade, exactly like the roadmap path does (the FE offers
      // "add an API key" instead of a briefing).
      if (!adv.apiKey && !adv.baseUrl) return json(res, 200, { degraded: true });
      // Only teammates' work belongs in a catch-up briefing: drop our own rows
      // (self), then group what's left by author. feedPayload already tags each
      // entry with { self, author, ... } and forwards `since` to the team feed.
      const feedRes = await feedPayload({ since, limit: 200 });
      const byAuthor = new Map();
      for (const e of feedRes.entries || []) {
        if (e.self) continue;
        const name = e.author || 'Teammate';
        if (!byAuthor.has(name)) byAuthor.set(name, []);
        byAuthor.get(name).push({ ts: e.ts, source: e.source, ask: e.ask, summary: e.summary, files: e.files, project: e.project });
      }
      const teammates = [...byAuthor.entries()].map(([name, entries]) => ({ name, entries }));
      const now = new Date().toISOString();
      const r = await advisor.generateBriefing(adv.apiKey, adv.model, { since, until: now, teammates }, { provider: adv.provider, baseUrl: adv.baseUrl });
      if (r.error) return json(res, 502, { error: r.error });
      // Cache the briefing (overwrite = "Regenerate", same as the roadmap). Merge
      // defensively so we never clobber the catch-up read pointers.
      const state = loadState();
      const catchup = state.catchup || { lastViewedTs: null, prevViewedTs: null, briefing: null };
      saveState({ ...state, catchup: { ...catchup, briefing: { text: r.text, generatedAt: now, since } } });
      json(res, 200, { text: r.text, generatedAt: now, degraded: false });
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

module.exports = { startServer, statusPayload, projectsPayload, projectDetail, planPayload, toggleProject, addProject, deleteProject, removeBlockFromProject, copyPayload, settingsPayload, saveSettings, teamPayload, teamProjectsPayload, runTeamSync, scanPayload, feedPayload, catchupPayload, markCaughtUp, undoCaughtUp };
