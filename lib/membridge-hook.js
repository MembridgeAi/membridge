'use strict';
// Hook entry point, invoked by the commands setup-hooks writes:
//   [ELECTRON_RUN_AS_NODE=1] "<runtime>" "<this file>"               // Claude Code Stop hook
//   [ELECTRON_RUN_AS_NODE=1] "<runtime>" "<this file>" post-commit   // git post-commit hook
// It lives in lib/ (not bin/) because the packaged Electron app ships only
// lib/ inside its asar — this file therefore exists in every install layout
// (git checkout, npm -g, app.asar) at a path derivable from __dirname.
// Behavior matches `membridge hook stop` / `membridge hook post-commit` /
// `membridge hook recall`.
// argv dispatch: `append <target> '<json>'` writes one validated summary
// line (see hooks.runAppend); `post-commit` runs the commit->session hook;
// `recall` runs the PreToolUse recall hook (lib/hooks-recall.js); anything
// else is the Stop-hook entry point.
const hooks = require('./hooks');
const argv = process.argv.slice(2);
if (argv[0] === 'append') hooks.runAppend(argv.slice(1));
else if (argv[0] === 'post-commit') hooks.runPostCommit();
else if (argv[0] === 'recall') hooks.runRecall();
else hooks.runStop();
