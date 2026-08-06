'use strict';
// NOT_RUN_BY_CI: not run as a test and not require()d by one — it is injected
// with --require into CHILD processes spawned by test/run-tests.js's
// mcp-wiring block (see the HOMEDIR_PRELOAD constant there). It therefore DOES
// execute under CI, inside those children, but no walk of require() edges from
// a suite can see that, which is why it declares itself here.
//
// Test-only preload: on every child launched by test/run-tests.js's
// mcp-wiring block, record what `os.homedir()` resolves to.
//
// The mcp-wiring section used to prove its own isolation by snapshotting the
// developer's real ~/.claude.json / ~/.codex/config.toml / ~/.cursor/mcp.json
// before and after, and asserting byte-identity at the end. That worked only
// because the redirection did -- but the read of the REAL file was itself the
// mcp-wiring flake #77 exists for: Claude Code sessions rewrite ~/.claude.json
// every ~minute, correlated with load rather than with anything the test does,
// and verify-finding's PHANTOM verdict cannot distinguish that from a
// scheduler-starvation timeout.
//
// This preload lets the check own its own signal. `os.homedir()` on POSIX
// resolves to $HOME; on Windows it resolves to $USERPROFILE (see Node docs
// for `os.homedir`). Both are set by fixtureEnv to the fixture path, so a
// correctly-isolated child logs a fixture path here; a child that ended up
// under the real home logs the real home here. Same claim as the old check,
// looked at from what the CHILDREN saw rather than what the real file held.
// See test/suites/tests-own-their-state.test.js.
try {
  const log = process.env.MB_HOMEDIR_LOG;
  if (log) require('fs').appendFileSync(log, require('os').homedir() + '\n');
} catch {
  // A test's isolation check must never crash a child in the check's own
  // instrumentation path. If the log write fails, the parent's assertion
  // will notice the missing line and fail there, not here.
}
