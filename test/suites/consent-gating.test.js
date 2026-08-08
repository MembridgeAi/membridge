'use strict';
// Shared plumbing lives in test/harness.js; run this file directly, or via
// `node test/run.js consent-gating`.
// --- first-run consent: a decline has to actually turn capture off ---
//
// The first-run dialog (app/main.js) promises "This ... installs a Claude Code
// hook", so "Not now" is the user declining the hook and the capture it feeds.
// Recording the DECISION is not the same as honouring it: the two capture gates
// read `distill.enabled` and nothing else --
//   lib/hooks.js runStop:        `if (distill.enabled === false) return;`
//   lib/scan.js  scanSummaries:  `if ((config.distill || {}).enabled === false) return events;`
// -- while `distill.consent` gates only the rendered AGENTS.md line
// (lib/digest.js). So a decline that sets consent alone leaves every capture
// path running.
//
// `enabled: false` is the DURABLE half and cannot be replaced by removeHooks()
// alone: hooks.ensureInstalled() re-runs reconcileStopHook() unconditionally on
// every daemon boot and app launch, with no consent or enabled guard, so a
// removal on its own is silently undone by the next start.
const h = require('../harness'); // FIRST: pins MEMBRIDGE_* env before any lib require
const { check } = h;
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const util = require('../../lib/util');
const hooks = require('../../lib/hooks');
const scan = require('../../lib/scan');
const consent = require('../../lib/consent');

// Put the config back in the state a fresh install reaches the dialog in:
// distillation on, no decision recorded yet.
//
// ADAPTED for the consent RECORD (lib/hook-consent.js), which did not exist
// when this suite was written. There are now two places a decision can be
// remembered — `config.hooks` (the record every reconciler and hook body
// reads) and the legacy `distill.consent` — and hook-consent.state() falls
// back to the second when the first is absent. Clearing only the legacy field
// would leave a recorded 'declined' standing, so every check after the first
// would run against an install that had already answered, and the
// preconditions below ("an undecided config SHOULD ingest") would pass
// vacuously. Deleting the record is what actually restores "nobody has been
// asked yet".
function seedUndecided() {
  util.ensureConfig();
  const raw = util.loadUserConfig();
  raw.distill = { ...(raw.distill || {}), enabled: true, consent: null };
  delete raw.hooks; // back to hookConsent.UNKNOWN
  util.saveUserConfig(raw);
}

async function main() {
  seedUndecided();

  check('consent: an undecided fresh install is what the dialog is shown for', () => {
    assert.strictEqual(consent.needsConsentPrompt(util.getConfig()), true,
      'the seeded config should be the one that prompts');
  });

  check('consent: declining the first-run prompt actually stops capture, not just records a decision', () => {
    seedUndecided();
    hooks.setupHooks(); // a fresh install already has the hook: ensureInstalled runs before the dialog
    assert.strictEqual(hooks.isHookInstalled(), true, 'precondition: the Stop hook should be installed');

    const message = consent.applyConsent('declined');

    const after = util.getConfig();
    assert.strictEqual(after.distill.consent, 'declined', 'the decision itself was not recorded');
    // The durable gate. Without this, runStop still blocks every session stop
    // and scanSummaries still ingests, no matter what consent says.
    assert.strictEqual(after.distill.enabled, false,
      `declining left distillation enabled, so capture keeps running -- message claimed: ${message}`);
    // And the message must not be a claim the code did not achieve.
    assert.strictEqual(hooks.isHookInstalled(), false,
      `the Stop hook survived a decline whose message says "no hook installed" -> ${message}`);
  });

  // The behavioural half: prove the gate the decline sets really does stop the
  // summary ingest, rather than trusting the flag.
  check('consent: after a decline, an agent-written summary line is not ingested', () => {
    seedUndecided();
    const proj = path.join(h.ROOT, 'projects', 'consent-decline-app');
    fs.mkdirSync(path.join(proj, '.membridge'), { recursive: true });
    fs.writeFileSync(hooks.summariesPath(proj),
      JSON.stringify({ session: 'cd1', ts: '2026-07-15T01:05:00.000Z', did: 'work that a declining user never agreed to capture' }) + '\n');
    const state = { version: util.STATE_VERSION, files: {}, projects: { [proj]: { events: [] } } };

    // Sanity: while still undecided, this line IS ingested -- otherwise the
    // assertion below would pass for the wrong reason.
    assert.ok(scan.scanSummaries(state, util.getConfig()).length > 0,
      'precondition: an undecided config should ingest the summary line');

    consent.applyConsent('declined');
    const fresh = { version: util.STATE_VERSION, files: {}, projects: { [proj]: { events: [] } } };
    assert.deepStrictEqual(scan.scanSummaries(fresh, util.getConfig()), [],
      'a declined install still ingested an agent-written summary');
  });

  check('consent: granting still enables capture and installs the hook', () => {
    seedUndecided();
    hooks.removeHooks();
    const message = consent.applyConsent('granted');
    const after = util.getConfig();
    assert.strictEqual(after.distill.consent, 'granted', 'the grant was not recorded');
    assert.notStrictEqual(after.distill.enabled, false, 'granting must not leave distillation disabled');
    assert.strictEqual(hooks.isHookInstalled(), true,
      `granting reported success but installed no hook -> ${message}`);
  });

  h.finish();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
