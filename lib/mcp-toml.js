'use strict';
// Targeted TOML surgery: own exactly one table, leave every other byte alone.
//
// WHY NOT A TOML LIBRARY (mcp spec §5.2). A parse-and-restringify rewrites the
// user's ENTIRE file: comments lost, key order churned, quoted keys re-quoted
// at the library's discretion. Real Codex configs contain
// `plugins."github@openai-curated"` and
// `projects."/Users/marco/Documents/AI Shit/CopyNigga"`. MemBridge's hook
// reconcilers already refuse to rewrite settings.json wholesale; the same
// reasoning applies here, and a dependency would not change it.
//
// This needs only enough TOML awareness to recognise a table header at the
// start of a line and find the next one. It parses no values and rewrites
// nothing it did not write.
//
// PURE: string in, string out. No fs, no clock.

// A table header at line start: [name] or [ name ] with optional trailing
// comment. Deliberately not anchored to any particular key syntax -- we only
// need to know THAT a table starts here, never what it means. Failing to
// recognise a header is the dangerous direction: an unrecognised one gets
// swallowed into our span and deleted.
const HEADER_RE = /^[ \t]*\[([^\]]*)\][ \t]*(?:#.*)?$/;

// Splitting on '\n' leaves a trailing '\r' on every line of a CRLF file, which
// is exactly what lets untouched lines be copied through byte-for-byte. Strip
// it for the match only -- without this, a Windows config's header is never
// found, we append a SECOND [mcp_servers.membridge], and a duplicate table is
// a TOML parse error: we would break the file we were registering into.
const headerName = line => {
  const m = HEADER_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
  return m ? m[1].trim() : null;
};

// Ours, or one of our own sub-tables (`mcp_servers.membridge.env`). A foreign
// table that merely starts with a similar prefix (`mcp_servers.membridgeous`)
// is NOT ours -- the dot boundary is what makes that safe.
const isOursOrChild = (name, table) => name === table || name.startsWith(`${table}.`);

// findBlock -> { start, end } as LINE indices, end exclusive. Spans our table
// and any of our sub-tables, stopping at the first table that is not ours.
function findBlock(text, table) {
  const lines = String(text).split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const name = headerName(lines[i]);
    if (name === null) continue;
    if (start === -1) {
      if (name === table) start = i;
      continue;
    }
    if (!isOursOrChild(name, table)) return { start, end: i };
  }
  return start === -1 ? null : { start, end: lines.length };
}

// A file that uses CRLF anywhere is treated as a CRLF file, so the lines WE
// add match the ones we did not.
const eolOf = text => (/\r\n/.test(text) ? '\r\n' : '\n');

// upsertBlock -> { text, changed }. Absent: append. Present: replace exactly
// the span findBlock reports. `changed:false` when the result is identical, so
// callers can skip the write entirely and never touch mtime for nothing.
function upsertBlock(text, table, bodyLines) {
  const src = String(text == null ? '' : text);
  const nl = eolOf(src);
  const crlf = nl === '\r\n';
  const block = [`[${table}]`, ...bodyLines];
  const found = findBlock(src, table);

  let out;
  if (!found) {
    const base = src.length && !src.endsWith('\n') ? `${src}${nl}` : src;
    const sep = base.trim().length ? nl : '';
    out = `${base}${sep}${block.join(nl)}${nl}`;
  } else {
    const lines = src.split('\n');
    const own = crlf ? block.map(l => `${l}\r`) : block;
    // One blank line after our block. The span findBlock reports already
    // swallows whatever blank lines followed our header, so re-emitting a
    // single one is a stable seam -- and NOTHING outside [start, end) is even
    // looked at, let alone reflowed. (A whole-file blank-run collapse would
    // silently reformat the user's spacing: bytes that are not ours.)
    out = [
      ...lines.slice(0, found.start),
      ...own,
      crlf ? '\r' : '',
      ...lines.slice(found.end),
    ].join('\n');
  }
  return { text: out, changed: out !== src };
}

function removeBlock(text, table) {
  const src = String(text == null ? '' : text);
  const found = findBlock(src, table);
  if (!found) return { text: src, changed: false };
  const lines = src.split('\n');
  const out = [...lines.slice(0, found.start), ...lines.slice(found.end)].join('\n');
  return { text: out, changed: out !== src };
}

module.exports = { findBlock, upsertBlock, removeBlock };
