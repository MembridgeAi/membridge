'use strict';
// Task 9: net-negative auto-report (spec §7.1 trigger, §8.5 payload, §7.2
// pooling). When a project's lifetime direct-avoidance total (spec §7.1,
// lib/ledger-fold.js's `avoided`) goes net negative with enough serves
// behind it to mean something, recall is paused for that project and one
// anonymous diagnostic payload is sent so the failure mode can be pooled
// across installs -- that pooling is the whole reason the holdout (§7.2)
// exists at all; a single install never sees enough held-out reads to prove
// causation on its own.
//
// GOVERNING RULE (spec §10, same as every other recall module): every
// failure degrades to ordinary behaviour, never breaks the caller. Nothing
// exported here may throw out into lib/scan.js's sync pass -- checkNetNegative
// wraps its own body, and sendDiagnostic swallows every network error.
const fs = require('fs');
const crypto = require('crypto');
const util = require('./util');
const pkg = require('../package.json');
const recallStore = require('./recall-store');
const { normalizeAvoided, normalizeHoldout } = require('./ledger-fold-state');

// Baked-in backend shipped with the build (lib/backend.json, filled in once
// by the operator -- see that file's own comment). The diagnostics function
// lives on the SAME Supabase project team sync already talks to: one piece
// of infra, two Edge Functions, no separate backend to provision. Empty
// when no backend is baked into a build (self-hosted/opensource builds),
// which resolves to "never send" below -- diagnostics degrades exactly like
// team sync does when unconfigured.
const BAKED = (() => {
  try {
    return require('./backend.json');
  } catch {
    return {};
  }
})();
const DEFAULT_DIAGNOSTICS_URL = BAKED.url ? `${String(BAKED.url).replace(/\/+$/, '')}/functions/v1/diagnostics` : '';

// A project needs at least this many recall serves behind it before a
// negative lifetime total is trusted as a real verdict rather than noise
// from the first couple of follow-up reads (spec §7.1/§7.3, Task 9 brief).
const NET_NEGATIVE_MIN_SERVES = 20;

const FETCH_TIMEOUT_MS = 5000;

// Below this many held-out skips, an average call-token-per-skip figure is
// too thin to mean anything -- report `null` rather than a number that looks
// precise but isn't (documented on holdout_divergence below).
const MIN_HOLDOUT_SKIPS = 5;

function diagnosticsUrl(config) {
  return (config && typeof config.diagnosticsUrl === 'string' && config.diagnosticsUrl) || DEFAULT_DIAGNOSTICS_URL;
}

// Two independent kill switches (spec §8.5's "Send anonymous diagnostics"
// toggle, plus a single-session env override): an explicit
// `diagnostics.enabled === false` in config, or MEMBRIDGE_NO_DIAGNOSTICS=1.
// Either one suppresses the NETWORK SEND only -- the project is still paused
// (see checkNetNegative) even when diagnostics are off, because the pause is
// a local safety behaviour, not a telemetry one.
function diagnosticsEnabled(config) {
  if (process.env.MEMBRIDGE_NO_DIAGNOSTICS === '1') return false;
  const d = config && config.diagnostics;
  return !(d && d.enabled === false);
}

// install_id: a random uuid, generated once and persisted exactly like every
// other MemBridge setting -- loadUserConfig/saveUserConfig (lib/util.js),
// the same pair every other config write in this codebase uses. Its only
// input is crypto.randomUUID(); nothing machine- or person-identifying ever
// feeds it.
function getOrCreateInstallId() {
  const raw = util.loadUserConfig();
  if (typeof raw.installId === 'string' && raw.installId) return raw.installId;
  const id = crypto.randomUUID();
  util.saveUserConfig({ ...raw, installId: id });
  return id;
}

// Per-project recall pause, written to config.json under recall.pausedProjects.
// Deliberately NOT the existing `.membridge-off` marker (util.isProjectOff):
// that pauses memory capture and context-file injection for the whole
// project, which a net-negative recall verdict has no business doing --
// only recall itself should go quiet. lib/hooks-recall.js's `tracked` gate
// consults this alongside isProjectOff.
function isRecallPausedForProject(projectPath, config) {
  const list = config && config.recall && Array.isArray(config.recall.pausedProjects)
    ? config.recall.pausedProjects : [];
  return list.includes(projectPath);
}

function pauseRecallForProject(projectPath) {
  const raw = util.loadUserConfig();
  const recallCfg = raw.recall && typeof raw.recall === 'object' ? raw.recall : {};
  const list = Array.isArray(recallCfg.pausedProjects) ? recallCfg.pausedProjects : [];
  if (list.includes(projectPath)) return; // already paused -- nothing to write
  util.saveUserConfig({ ...raw, recall: { ...recallCfg, pausedProjects: [...list, projectPath] } });
}

// File extension -> a small, generic language bucket. This is the ONLY
// per-file signal that ever leaves the machine (spec §8.5: no code, no file
// names, no project names). Extensions outside this list fall into "other"
// rather than being reported verbatim, so an unusual extension can never
// become a fingerprinting signal.
const LANG_BUCKETS = {
  ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'py', go: 'go', rb: 'rb', php: 'php', java: 'java', kt: 'kt',
  rs: 'rs', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'cs',
  sql: 'sql', sh: 'sh', yaml: 'yaml', yml: 'yaml', json: 'json',
};

// Counts of the recall store's warmed entries by language bucket -- never
// the relative paths themselves, just how many .ts vs .py files this
// project's recall cache currently holds. Reads recall-store's own index
// (already on disk from warm()); fail-open to an empty breakdown on any
// read/parse error, same contract as every other recall-store reader.
function languageBreakdown(projectPath) {
  let idx;
  try {
    idx = recallStore.readIndex(projectPath) || {};
  } catch {
    return {};
  }
  const out = {};
  for (const relPath of Object.keys(idx)) {
    const parts = String(relPath).split('.');
    const ext = parts.length > 1 ? parts.pop().toLowerCase() : '';
    const bucket = LANG_BUCKETS[ext] || 'other';
    out[bucket] = (out[bucket] || 0) + 1;
  }
  return out;
}

// MINOR 4 (final whole-branch review): reads lib/recall-store.js's real,
// persisted per-project counter of warm() refusals. Fail-open to 0, same
// contract as languageBreakdown -- a read/parse error here must never break
// buildPayload.
function noStructureCount(projectPath) {
  try {
    return recallStore.readCounters(projectPath).noStructure || 0;
  } catch {
    return 0;
  }
}

// compression_realization (renamed from holdout_divergence -- MINOR 5,
// final whole-branch review; see this function's own header for why):
// average net tokens avoided per SERVED read, divided by the average call
// size of a HELD-OUT read that would have been served (both priced by
// lib/recall.js's own estimateCallTokens, so they're comparable). A ratio
// near the tier compression floor (lib/recall.js MIN_COMPRESSION, 2.25x
// implies roughly 0.55+) says the two arms agree; a ratio well below that is
// A signal worth pooling, though NOT itself the §7.2 divergence check the
// spec describes -- see the caveat below. `null` when there aren't enough
// held-out skips yet for the average to mean anything (MIN_HOLDOUT_SKIPS)
// -- reporting a number here would look precise while being noise.
//
// CAVEAT (MINOR 5): the original name, "holdout_divergence", implied this
// directly measures spec §7.2's divergence check -- "catch cases where
// direct avoidance and total session cost disagree", the signature of
// induced reads / extra turns eating the gains. It cannot: both terms of
// this ratio (avoided.tokens/avoided.serves on one side, holdout.callTokens/
// holdout.skips on the other) live entirely on the DIRECT-AVOIDANCE side of
// that comparison -- neither one touches total session cost/volume, the
// other side §7.2 needs to detect second-order effects. As named, a reader
// would take a low ratio as causal evidence of the exact thing it cannot
// see. compression_realization names what it actually is: how much of the
// SERVED arm's compression the HELD-OUT arm's pricing would realize, a
// useful signal but not the §7.2 check. The real §7.2 divergence check
// needs per-session total volume (a figure this payload does not carry) and
// is future work -- see docs/superpowers/plans/2026-07-28-recall-saving-
// layer.md's Task 9 entry and docs/superpowers/specs/2026-07-28-membridge-
// token-reduction-design.md §7.2 for the one-line notes added alongside
// this rename.
function computeCompressionRealization(avoided, holdout) {
  return holdout.skips >= MIN_HOLDOUT_SKIPS && avoided.serves > 0 && holdout.callTokens > 0
    ? Math.round(((avoided.tokens / avoided.serves) / (holdout.callTokens / holdout.skips)) * 1000) / 1000
    : null;
}

// The exact payload shape (spec §8.5, plus the two fields the plan added for
// §7.2 pooling): no code, no file names, no project names, no account.
function buildPayload(projectPath, ledger, config) {
  const avoided = normalizeAvoided(ledger && ledger.avoided);
  const holdout = normalizeHoldout(ledger && ledger.holdout);
  const readsAnswered = avoided.serves;

  // acceptance: the fraction of answered reads that did NOT turn out net
  // negative -- 1.0 means every serve this project ever made held up.
  const acceptance = readsAnswered > 0
    ? Math.round(((readsAnswered - avoided.netNegatives) / readsAnswered) * 1000) / 1000
    : 0;

  return {
    install_id: getOrCreateInstallId(),
    version: pkg.version,
    net_tokens: avoided.tokens,
    acceptance,
    reads_answered: readsAnswered,
    // read_after_serve: lib/recall-store.js's bumpRejection, driven
    // exclusively by a net-negative correction (see
    // lib/ledger-fold-recall-open-serves.js). no_structure (MINOR 4, final
    // whole-branch review): lib/recall-store.js's warm() now bumps a
    // persisted per-project counter (bumpNoStructure) every time
    // skeletonize() declines a candidate (degenerate/binary/minified --
    // see warm()'s own comment), read back here instead of the old
    // hardcoded 0.
    reject_reasons: { read_after_serve: avoided.netNegatives, no_structure: noStructureCount(projectPath) },
    languages: languageBreakdown(projectPath),
    direct_avoided: { ...avoided },
    compression_realization: computeCompressionRealization(avoided, holdout),
  };
}

// Fire-and-forget POST, 5s timeout, fetchImpl injectable so tests never touch
// the real network (mirrors lib/update-check.js's fetchLatest). Resolves
// true/false; never rejects and never throws -- a network failure here must
// be invisible to the caller.
async function sendDiagnostic(payload, config, { fetchImpl = fetch } = {}) {
  const url = diagnosticsUrl(config);
  if (!url) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The single entry point lib/scan.js calls, once per project per sync pass,
// right after a fresh ledger fold. Idempotent: a project already paused is
// left alone (no repeat pause-write, no repeat diagnostic) -- "queue one
// diagnostic" per the brief means one per project, not one per sync pass.
// Returns true when this pass paused the project (whether or not a
// diagnostic was actually sent -- diagnostics.enabled/MEMBRIDGE_NO_DIAGNOSTICS
// gate the SEND, never the pause itself, which is a local safety behaviour).
function checkNetNegative(projectPath, ledger, config, opts = {}) {
  try {
    const avoided = normalizeAvoided(ledger && ledger.avoided);
    if (avoided.tokens >= 0 || avoided.serves < NET_NEGATIVE_MIN_SERVES) return false;
    if (isRecallPausedForProject(projectPath, config)) return false;

    pauseRecallForProject(projectPath);

    if (diagnosticsEnabled(config)) {
      const payload = buildPayload(projectPath, ledger, config);
      // Fire-and-forget: syncOnce must not wait on a network round-trip.
      sendDiagnostic(payload, config, opts).catch(() => {});
    }
    return true;
  } catch {
    return false; // fail-open -- must never break the sync pass that called this
  }
}

module.exports = {
  checkNetNegative,
  isRecallPausedForProject,
  pauseRecallForProject,
  buildPayload,
  sendDiagnostic,
  languageBreakdown,
  getOrCreateInstallId,
  diagnosticsEnabled,
  diagnosticsUrl,
  NET_NEGATIVE_MIN_SERVES,
  MIN_HOLDOUT_SKIPS,
  // Exported for tests (MINOR 5, final whole-branch review): the renamed
  // computing function, independently testable without going through the
  // full buildPayload shape.
  computeCompressionRealization,
};
