'use strict';
// Anonymous product-health counters (docs/superpowers/specs/
// 2026-07-28-developer-diagnostics-backend-design.md §2).
//
// WHY THIS IS NOT lib/diagnostics.js: diagnostics.js posts a rich payload to a
// Supabase Edge Function on the SAME project that holds every customer's data.
// An unauthenticated write path there is a hole into the customer database no
// matter how small the body is. These counters go to a Cloudflare Worker
// instead, which holds no Supabase credential and has no route to it — so the
// worst case for a compromised counter endpoint is wrong numbers on an
// internal page. That address change, not the payload size, is what makes this
// safe to ship early.
//
// WHAT IS NEVER SENT: no paths, no repo names, no branch names, no file names,
// no account, no content. Only an install-scoped random id, the version, and a
// bounded enum per counter. Every dimension value below is drawn from a fixed
// allowlist, so a new value cannot leak in by accident — the Worker rejects
// anything outside it.
//
// GOVERNING RULE, inherited from every other module in this family: failure
// degrades to ordinary behaviour. Nothing here throws into the sync pass.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const pkg = require('../package.json');
const ledgerStore = require('./ledger-store');
const recallStore = require('./recall-store');
const diagnostics = require('./diagnostics');

// Baked-in counter endpoint. Empty in self-hosted/opensource builds, which
// resolves to "never send" — exactly how team sync and diagnostics already
// degrade when unconfigured. Deliberately a SEPARATE key from backend.json's
// Supabase url: these must be able to point at different infrastructure, and
// nothing should silently fall back to the customer database.
const BAKED = (() => {
  try {
    return require('./counters-backend.json');
  } catch {
    return {};
  }
})();
const DEFAULT_COUNTERS_URL = typeof BAKED.url === 'string' ? BAKED.url : '';

const FETCH_TIMEOUT_MS = 5000;

// One heartbeat per (version, UTC day). Anything more turns a diagnostic into
// a beacon; anything less and a quiet week is indistinguishable from an outage.
const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Allowlists. The Worker enforces the same sets; keep them in sync.
// ---------------------------------------------------------------------------
const RECALL_STATES = [
  'serving',        // has answered at least one read — the feature works here
  'no_hot_paths',   // nothing read by >1 session yet, so warm() has no input
  'empty_store',    // hot paths exist but warm() wrote no entry
  'all_rejected',   // skeletons were built and every one failed the ok gate
  'ready_unserved', // cache entries exist but nothing has ever been served
];
const ENV_SHAPES = ['single', 'worktree', 'mixed', 'none'];
const REGISTRATION_RESULTS = ['wrote', 'current', 'failed'];
const COUNTER_NAMES = ['heartbeat', 'recall_state', 'hook_registration', 'environment'];

// ---------------------------------------------------------------------------
// Pure classification. Every function below takes its inputs explicitly so the
// decision ladder is table-testable without touching a filesystem.
// ---------------------------------------------------------------------------

// The decision ladder, ordered most-decisive first. `serving` wins outright:
// one real serve proves the whole path works, whatever the other counters say.
//
// These states are NOT interchangeable and must not be collapsed into a single
// "broken" — no_hot_paths is the worktree keying defect, all_rejected is a
// skeletonizer problem, and empty_store is neither. Collapsing them is exactly
// what made the original failure take a day to diagnose.
function classifyRecall({ serves, hotPaths, storeEntries, noStructure }) {
  if (serves > 0) return 'serving';
  if (hotPaths === 0) return 'no_hot_paths';
  if (storeEntries === 0) return noStructure > 0 ? 'all_rejected' : 'empty_store';
  return 'ready_unserved';
}

// Install-level state across every tracked project. `serving` if ANY project
// serves — the question this answers is "does the feature work for this user
// at all", not "does it work everywhere". Otherwise the most common failure,
// with ties broken by RECALL_STATES order so the result is deterministic.
function rollUpRecall(states) {
  if (!states.length) return null;
  if (states.includes('serving')) return 'serving';
  const counts = new Map();
  for (const s of states) counts.set(s, (counts.get(s) || 0) + 1);
  let best = null;
  for (const s of RECALL_STATES) {
    const n = counts.get(s) || 0;
    if (n > 0 && (best === null || n > counts.get(best))) best = s;
  }
  return best;
}

// A linked worktree's `.git` is a FILE (a gitdir pointer); a normal checkout's
// is a directory. That single fact is the whole test — no git spawn, no path
// parsing, and nothing about the path is ever transmitted.
function isWorktreeCheckout(projectPath, statFn = fs.statSync) {
  try {
    return statFn(path.join(projectPath, '.git')).isFile();
  } catch {
    return false;
  }
}

function environmentShape(flags) {
  if (!flags.length) return 'none';
  const worktrees = flags.filter(Boolean).length;
  if (worktrees === 0) return 'single';
  if (worktrees === flags.length) return 'worktree';
  return 'mixed';
}

// Build the counter list. Pure: callers supply the already-gathered facts.
function buildCounters({ recallState, shape, registration }) {
  const out = [{ name: 'heartbeat', dims: {} }];
  if (recallState) out.push({ name: 'recall_state', dims: { state: recallState } });
  if (shape) out.push({ name: 'environment', dims: { shape } });
  if (registration) out.push({ name: 'hook_registration', dims: { result: registration } });
  return out;
}

// A stable fingerprint of everything except the heartbeat, so a send only
// happens on a real state change or once a day. Without this, a broken install
// would POST on every 60s sync pass forever.
function signatureOf(counters) {
  return counters
    .filter(c => c.name !== 'heartbeat')
    .map(c => `${c.name}:${Object.entries(c.dims).map(([k, v]) => `${k}=${v}`).join(',')}`)
    .sort()
    .join('|');
}

function shouldSend(prev, sig, now) {
  if (!prev || typeof prev !== 'object') return true;
  if (prev.sig !== sig) return true;
  const last = Number(prev.ts) || 0;
  return now - last >= HEARTBEAT_INTERVAL_MS;
}

// ---------------------------------------------------------------------------
// Gathering (touches disk) and sending (touches network).
// ---------------------------------------------------------------------------

// Reuses diagnostics' kill switches verbatim rather than inventing a second
// pair: a user who turned diagnostics off has turned THIS off too, and
// MEMBRIDGE_NO_DIAGNOSTICS=1 remains one override for the whole family.
function countersEnabled(config) {
  return diagnostics.diagnosticsEnabled(config);
}

// Precedence is by PRESENCE of the config key, not by its truthiness. A blank
// countersUrl is a deliberate opt-out and must outrank the URL compiled into the
// release; `||` collapses "absent" and "explicitly emptied" into one falsy case,
// so a self-hosted build that set countersUrl: '' still sent. An absent key is
// left alone -- that path keeps the baked default, which is what our own builds
// ship for. Whitespace is trimmed on both sides of the decision: it reads as the
// same opt-out, and untrimmed it was truthy enough to clear emitCounters' guard
// and have us POST to the literal string "   ".
// A non-string (including a counters-backend.json with no "url") is never
// fetchable, so it resolves to never-send.
function countersUrl(config, baked = DEFAULT_COUNTERS_URL) {
  const raw = config && typeof config.countersUrl === 'string' ? config.countersUrl : baked;
  return typeof raw === 'string' ? raw.trim() : '';
}

// Per-project facts, from files already on disk. Every read is wrapped: a
// project whose ledger or store is unreadable is skipped, never fatal.
function gatherProject(projectPath) {
  try {
    const ledger = ledgerStore.readLedger(projectPath) || {};
    const avoided = ledger.avoided || {};
    const index = recallStore.readIndex(projectPath) || {};
    const counters = recallStore.readCounters(projectPath) || {};
    return {
      state: classifyRecall({
        serves: Number(avoided.serves) || 0,
        hotPaths: Array.isArray(ledger.hotPaths) ? ledger.hotPaths.length : 0,
        storeEntries: Object.keys(index).length,
        noStructure: Number(counters.noStructure) || 0,
      }),
      worktree: isWorktreeCheckout(projectPath),
    };
  } catch {
    return null;
  }
}

async function postCounters(url, body, { fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Called once per daemon sync pass. Returns true only when a POST was actually
// attempted and resolved, so tests can assert the cadence rather than the
// network. Wrapped whole: a throw here must never reach lib/scan.js.
async function emitCounters(state, config, { fetchImpl = fetch, now = Date.now(), registration = null } = {}) {
  try {
    if (!countersEnabled(config)) return false;
    const url = countersUrl(config);
    if (!url) return false;

    const projectPaths = Object.keys((state && state.projects) || {});
    const gathered = projectPaths.map(gatherProject).filter(Boolean);

    const counters = buildCounters({
      recallState: rollUpRecall(gathered.map(g => g.state)),
      shape: environmentShape(gathered.map(g => g.worktree)),
      registration: REGISTRATION_RESULTS.includes(registration) ? registration : null,
    });

    const sig = signatureOf(counters);
    const prev = (state && state.countersLastSent) || null;
    if (!shouldSend(prev, sig, now)) return false;

    const ok = await postCounters(url, {
      install_id: diagnostics.getOrCreateInstallId(),
      version: pkg.version,
      counters,
    }, { fetchImpl });

    // Record the attempt either way. A send that failed must not retry on the
    // next 60s tick — an endpoint that is down would otherwise be hammered by
    // every install at once, which is the failure mode a fire-and-forget
    // diagnostic is least able to notice.
    const fresh = util.loadState();
    util.saveState({ ...fresh, countersLastSent: { sig, ts: now } });
    return ok;
  } catch (err) {
    try { util.log(`counters skipped: ${err && err.message}`); } catch {}
    return false;
  }
}

module.exports = {
  emitCounters,
  countersEnabled,
  countersUrl,
  buildCounters,
  classifyRecall,
  rollUpRecall,
  environmentShape,
  isWorktreeCheckout,
  signatureOf,
  shouldSend,
  gatherProject,
  RECALL_STATES,
  ENV_SHAPES,
  REGISTRATION_RESULTS,
  COUNTER_NAMES,
  HEARTBEAT_INTERVAL_MS,
};
