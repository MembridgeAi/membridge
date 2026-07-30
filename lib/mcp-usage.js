'use strict';
// Anonymous MCP usage tally. The MCP server is read-only toward MEMORY (it
// never writes events.jsonl, sessionState, or state.json — lib/mcp.js). This
// file is the one deliberate write, and it is not memory: a best-effort
// { toolName: lastUsedIso } map under the membridge home so the DAEMON's
// counters tick can report WHICH tools see use — never how often, never
// with what arguments. Respects the diagnostics kill switch at record time:
// an opted-out install never even tallies. Every path swallows errors — a
// failed tally must never surface into a tool response, and the MCP process
// must never gain a network call for this.
const fs = require('fs');
const path = require('path');
const util = require('./util');
const diagnostics = require('./diagnostics');
const { MCP_TOOLS } = require('./counters');

function tallyPath() { return path.join(util.homeDir(), 'mcp-usage.json'); }

function readTally() {
  try { return JSON.parse(fs.readFileSync(tallyPath(), 'utf8')) || {}; }
  catch { return {}; }
}

function recordToolUse(tool, opts = {}) {
  try {
    if (!MCP_TOOLS.includes(tool)) return;
    if (!diagnostics.diagnosticsEnabled(opts.config)) return;
    const tally = readTally();
    tally[tool] = new Date(opts.now || Date.now()).toISOString();
    const p = tallyPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // pid-suffixed: this tally is written from both the CLI and the daemon
    // tick (same rationale as lib/team-archive.js's saveArchive), so a fixed
    // tmp name would let a concurrent writer's rename land on a half-written file.
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(tally), { mode: 0o600 });
    fs.renameSync(tmp, p);
  } catch { /* never break a tool call over telemetry */ }
}

function toolsUsedWithin(ms, opts = {}) {
  const now = opts.now || Date.now();
  const tally = readTally();
  return MCP_TOOLS.filter(t => {
    const ts = Date.parse(tally[t] || '');
    return Number.isFinite(ts) && now - ts <= ms;
  });
}

module.exports = { recordToolUse, toolsUsedWithin, tallyPath };
