'use strict';
// Decides what packaging does when the built React UI (ui/dist) is absent.
//
// This exists because v0.2.0 shipped an app whose entire window read "UI not
// built. Run: cd ui && npm run build". Three things lined up: build-app.yml
// never built ui/ (ci.yml did, build-app.yml didn't), prepare-app.js only
// warned and packaged anyway, and the legacy dashboard that used to back /app
// was deleted in 0.2.0 so there was nothing left to fall back to. A warning is
// not enough for a failure whose blast radius is "the product does not open" --
// this is a hard failure now, on every packaging run, local or CI.
//
// Pure and dependency-injected (no fs, no process.env) so both branches are
// testable without deleting a real ui/dist -- see test/run-tests.js.

// The escape hatch, for someone who genuinely wants to package without a UI.
// An env var rather than a --strict/--no-ui CLI flag because prepare-app.js is
// never invoked directly: it is the left side of a && chain inside an npm
// script ("node scripts/prepare-app.js && electron-builder ..."), so
// `npm run dist:mac -- --no-ui` appends the flag to electron-builder instead.
// Inline `VAR=1 node ...` in the npm script is POSIX-only and would break the
// Windows packaging leg.
const ALLOW_ENV = 'MEMBRIDGE_ALLOW_MISSING_UI';

// --prefix rather than `cd ui && ...` for the same Windows reason ci.yml uses
// `working-directory:` instead of a POSIX && chain.
const FIX = 'npm --prefix ui ci && npm --prefix ui run build';

/**
 * @param {{exists: boolean, allowMissing: boolean}} opts
 * @returns {null | {fatal: boolean, message: string}} null when there is nothing to report.
 */
function uiDistGate({ exists, allowMissing }) {
  if (exists) return null;
  if (allowMissing) {
    return {
      fatal: false,
      message: `ui/dist missing — packaging without a UI because ${ALLOW_ENV} is set. `
        + 'The packaged app will serve a 503 at /app.',
    };
  }
  return {
    fatal: true,
    message: 'ui/dist missing — refusing to package an app with no UI.\n'
      + `  Fix:  ${FIX}\n`
      + `  Or, to package without a UI on purpose:  ${ALLOW_ENV}=1`,
  };
}

module.exports = { uiDistGate, ALLOW_ENV, FIX };
