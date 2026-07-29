'use strict';
// Merge one server into a `{ "mcpServers": { ... } }` config (Cursor, and any
// agent using the same shape).
//
// THE IMPORTANT DISTINCTION (mcp spec §5.3): a MISSING file is writable and
// reads as `{}`. A file that EXISTS but cannot be parsed, or whose mcpServers
// is not an object, returns null -- a REFUSAL. Callers must not write. Treating
// an unreadable config as empty would overwrite whatever the user had, which is
// the single worst thing this module could do.
//
// This mirrors lib/hooks.js's readSettings, which throws rather than write over
// a settings file it cannot understand.
const fs = require('fs');
const path = require('path');

// null = "exists but unusable, refuse to write". { data:{}, existed:false } =
// "not there yet, safe to create".
function readConfig(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // ONLY a genuinely absent file is safe to create. Every other read failure
    // means something IS there that we cannot see -- a config locked down to
    // mode 000 (EACCES), a directory in its place (EISDIR), a bad disk (EIO).
    // Classifying those as "missing" is the clobber this module exists to
    // prevent: renaming over a file needs the DIRECTORY to be writable, not
    // the file, so an unreadable config is overwritten just fine. Measured --
    // chmod 000 a real mcp.json, read-as-empty, write, and the user's servers
    // are gone.
    if (err && err.code === 'ENOENT') return { data: {}, existed: false };
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if ('mcpServers' in data) {
    const m = data.mcpServers;
    if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  }
  return { data, existed: true };
}

const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Pure in the sense that matters: the input object is never mutated, so a
// caller that reads a config and then decides NOT to write it has not already
// changed anything. Note the limit of that guarantee -- the returned tree is a
// shallow copy, so nested objects (a foreign server entry, the `entry` passed
// in) are shared with the input. Callers here serialize the result immediately
// and never mutate it; deep-copying would be cost without a caller.
function upsertServer(data, name, entry) {
  const base = data && typeof data === 'object' ? data : {};
  const servers = base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {};
  if (sameEntry(servers[name], entry)) return { data: base, changed: false };
  return {
    data: { ...base, mcpServers: { ...servers, [name]: entry } },
    changed: true,
  };
}

// isOurs(entry) is the ownership predicate (Global Constraints): a server that
// merely shares our NAME but is not ours must never be removed.
function removeServer(data, name, isOurs) {
  const base = data && typeof data === 'object' ? data : {};
  const servers = base.mcpServers && typeof base.mcpServers === 'object' ? base.mcpServers : {};
  const entry = servers[name];
  if (!entry) return { data: base, changed: false };
  let mine = false;
  try { mine = !!isOurs(entry); } catch { mine = false; }
  if (!mine) return { data: base, changed: false };
  const next = { ...servers };
  delete next[name];
  return { data: { ...base, mcpServers: next }, changed: true };
}

// Atomic: same tmp+rename pattern as lib/util.js's saveState and
// lib/recall-store.js's put. A crash leaves a stray temp file, never a
// half-written config.
let writeCounter = 0;
function writeConfig(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const json = `${JSON.stringify(data, null, 2)}\n`; // throws before touching disk
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${writeCounter++}.tmp`);
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = { readConfig, upsertServer, writeConfig, removeServer };
