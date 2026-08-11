'use strict';
const os = require('os');
const path = require('path');
const { isRealPrompt } = require('./claude-code');

// ===========================================================================
// UNVERIFIED DRAFT. DO NOT REGISTER IN lib/scan.js AS-IS.
// ===========================================================================
// Cursor is not installed on the machine where this was written, so NOT ONE
// line of this file has been run against a real Cursor transcript. Every field
// name below is inferred from published reverse-engineering of Cursor's on-disk
// state and from the documented cursor-agent stream format, not from a
// transcript anyone here has opened. Treat the field names as a hypothesis.
//
// Because of that, the whole file is written to FAIL CLOSED. Anything it
// cannot positively identify produces zero events rather than a guess. In a
// shared-memory product a wrong event is worse than a missing one: it lands in
// a teammate's context block, gets distilled, and is then indistinguishable
// from something a human actually said. Silence is recoverable, invented
// history is not.
//
// WHAT THIS TARGETS AND WHY
// Cursor has had at least three storage regimes:
//   1. workspaceStorage/<hash>/state.vscdb, ItemTable key
//      `workbench.panel.aichat.view.aichat.chatdata` (older).
//   2. globalStorage/state.vscdb, table `cursorDiskKV`, keys
//      `composerData:<id>` and `bubbleId:<composerId>:<bubbleId>`.
//   3. Current builds: `~/.cursor/chats/**/store.db` as the primary store,
//      with `~/.cursor/projects/<project>/agent-transcripts/**/*.jsonl` as a
//      plain-text transcript alongside it.
//
// This adapter targets (3), the JSONL transcripts, ONLY. That is a deliberate
// trade. The store.db and state.vscdb paths hold more (tool results, token
// counts) but reaching them needs a SQLite reader, and MemBridge has four small
// runtime deps and a documented Node 18 floor. node:sqlite does not exist on
// Node 18 or 20, so using it means raising the floor for every user in order to
// support one optional tool. The JSONL path needs no dependency at all and
// drops straight into the existing walkFiles('.jsonl') + byte-offset reader.
// The cost of that trade: transcripts carry tool INPUTS but not tool OUTPUTS,
// so this can never produce the `usage` events the other two adapters emit.
// Prompts, a summary, and edited files are the realistic ceiling here.
//
// TWO BLOCKERS THAT THIS FILE CANNOT SOLVE ON ITS OWN
// MemBridge requires `project` and `ts` on every event. The transcript records
// appear to carry NEITHER: the documented stream shape is
//   {"type":"user","message":{"role":"user","content":[{"type":"text",...}]},
//    "session_id":"<uuid>"}
// with no cwd and no timestamp. Both would have to come from the file's own
// path and mtime, and `extractEvents(entries, fileState)` is never told which
// file it is reading. So scan.js has to hand the adapter that context before
// this can emit anything at all. See `fileState.sourceFile` /
// `fileState.sourceMtime` below and the report accompanying this draft.
// Until scan.js does that, and absent an in-band cwd field, this adapter
// correctly yields nothing.

const MIN_SUMMARY_CHARS = 80; // same bar as claude-code and codex: skip "Done." noise
const MAX_TEXT_CHARS = 100000; // bound a pathological record, never truncate silently below this

// Candidate field names. Each list is ordered best-guess first and every lookup
// is tolerant, because the real names are unconfirmed. A list rather than a
// constant is the point: when Andrew runs a real session and reads a transcript,
// correcting this file should mean editing a string, not restructuring logic.
const CWD_KEYS = ['cwd', 'workspacePath', 'workspace_path', 'rootPath', 'projectPath', 'project_path'];
const TS_KEYS = ['timestamp', 'createdAt', 'created_at', 'ts', 'time', 'clientRpcSendTime'];
// Tool-call args that name an edited file. Cursor's tool params have been seen
// as `relativeWorkspacePath` and `targetFile` in the vscdb path, so both are
// carried here alongside the generic spellings.
const FILE_KEYS = ['relativeWorkspacePath', 'targetFile', 'target_file', 'path', 'filePath', 'file_path', 'file'];
// Tool names that mean "this file was written to". Read-shaped tools are
// deliberately absent: the `read` event kind carries offset/limit/messageId
// fields that a transcript without tool results cannot honestly fill.
const EDIT_TOOL_RE = /^(edit|write|create|apply|search_replace|multi_edit|str_replace)/i;

function firstKey(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// ISO string out, or null. Accepts an ISO string or epoch millis/seconds, since
// which one Cursor writes is unconfirmed. Anything that does not parse into a
// sane calendar date returns null and the caller drops the event: a bogus ts
// would sort a teammate's memory wrong forever.
function toIso(v) {
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Values below ~1e11 are far more likely to be seconds than millis.
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    const y = d.getUTCFullYear();
    if (!Number.isFinite(d.getTime()) || y < 2015 || y > 2100) return null;
    return d.toISOString();
  }
  return null;
}

// Content blocks, Anthropic-shaped: [{type:'text',text:'...'}]. A bare string
// is accepted too because the on-disk shape may differ from the streamed one.
function textFromContent(content) {
  if (typeof content === 'string') return content.slice(0, MAX_TEXT_CHARS);
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && (c.type === 'text' || c.type === 'output_text' || c.type === 'input_text') && typeof c.text === 'string')
    .map(c => c.text)
    .join(' ')
    .slice(0, MAX_TEXT_CHARS);
}

// Provenance gate, same intent as codex.isGenuineRollout. A Cursor transcript
// line should be an object carrying a `type` we recognise, and in practice a
// `session_id`. Anything else in that directory (a sidecar, a log, another
// tool's file someone dropped there) must never be stamped 'Cursor'.
// Deliberately strict: an unrecognised file is skipped, not guessed at.
function looksLikeCursorTranscript(first) {
  if (!first || typeof first !== 'object' || Array.isArray(first)) return false;
  const type = first.type;
  if (typeof type !== 'string') return false;
  if (!['user', 'assistant', 'tool_call', 'result', 'system'].includes(type)) return false;
  // session_id is the strongest single signal that this is cursor-agent output.
  return typeof first.session_id === 'string' || typeof first.sessionId === 'string'
    || (first.message && typeof first.message === 'object');
}

// The project path for a transcript. Preference order:
//   1. An in-band cwd field, if Cursor turns out to write one.
//   2. The directory name under ~/.cursor/projects/<dir>/agent-transcripts/...,
//      but ONLY when that name is itself an absolute path we can trust.
// Case 2 is the honest sticking point. It is unconfirmed whether that directory
// is a readable path, a slug, or a hash. If it is a hash there is no way to
// invert it and this function correctly returns null, which means no events.
// Nothing here reconstructs a path from a slug: guessing that `-Users-me-app`
// is `/Users/me/app` breaks on any project whose own name contains a dash, and
// a wrong project key files a teammate's work under a repo they never touched.
function projectFromSourceFile(sourceFile) {
  if (typeof sourceFile !== 'string' || !sourceFile) return null;
  const marker = `${path.sep}agent-transcripts${path.sep}`;
  const i = sourceFile.indexOf(marker);
  if (i === -1) return null;
  // The transcript may sit one level deeper (agent-transcripts/<id>/<id>.jsonl),
  // but the project directory is always the segment directly above the marker.
  const dir = path.basename(sourceFile.slice(0, i));
  if (!dir) return null;

  // Only encodings that can be inverted WITHOUT guessing are accepted.
  //
  // Accepted: percent-encoding and file URIs. Both are lossless and
  // self-verifying, because a successful decode yields a string that is
  // absolute on its face. A decode that does not produce an absolute path is
  // treated as "not this encoding" and falls through to null.
  //
  // Rejected on purpose: dash slugs (the `-Users-me-app` style Claude Code
  // uses) and hashes. A dash slug is genuinely ambiguous, since any project
  // whose own directory name contains a dash decodes to more than one
  // candidate path, and a hash cannot be inverted at all. Filing a teammate's
  // work under the wrong repo is precisely the failure this whole file is
  // written to avoid, so an unrecognised encoding yields no project and
  // therefore no events.
  let decoded = null;
  if (dir.startsWith('file://')) {
    try { decoded = decodeURIComponent(dir.slice('file://'.length)); } catch { decoded = null; }
  } else if (dir.includes('%')) {
    try { decoded = decodeURIComponent(dir); } catch { decoded = null; }
  } else if (path.isAbsolute(dir)) {
    // Only reachable on a platform where a path separator can appear inside
    // this segment. Kept because it costs nothing and is unambiguous.
    decoded = dir;
  }
  if (typeof decoded === 'string' && decoded && path.isAbsolute(decoded)) return decoded;
  return null;
}

module.exports = {
  id: 'cursor',
  displayName: 'Cursor',

  // ~/.cursor/projects is the transcript root. Overridable the same way the
  // other adapters are, so a relocated install or a test fixture needs no code
  // change. Note this is the CLI/agent config dir that lib/agent-config.js
  // already knows as `.cursor`, not the Application Support tree.
  sessionRoots(config) {
    const opts = (config.adapters || {}).cursor || {};
    return [opts.dir || path.join(os.homedir(), '.cursor', 'projects')];
  },

  extractEvents(entries, fileState) {
    // Gate once per file, verdict persisted on fileState exactly like codex.
    if (fileState.foreign) return [];
    if (!fileState.validated) {
      if (!entries.length) return []; // no complete line yet, so no verdict
      if (!looksLikeCursorTranscript(entries[0])) {
        fileState.foreign = true;
        return [];
      }
      fileState.validated = true;
    }

    // Project resolution. `sourceFile` is NOT set by scan.js today. Until it
    // is, this only succeeds if a transcript carries an in-band cwd, and
    // otherwise every event below is dropped by the `!project` guard.
    if (!fileState.cwd && fileState.sourceFile) {
      const fromPath = projectFromSourceFile(fileState.sourceFile);
      if (fromPath) fileState.cwd = fromPath;
    }

    const events = [];
    for (const e of entries) {
      // One malformed record must never abort the pass and strand the offset.
      try {
        if (!e || typeof e !== 'object') continue;

        // An in-band cwd wins and sticks for the rest of the file, the same
        // carry-forward codex uses for its session_meta cwd.
        const cwd = firstKey(e, CWD_KEYS);
        if (typeof cwd === 'string' && cwd) fileState.cwd = cwd;

        const project = fileState.cwd;
        // ts from the record, else the file's mtime as a per-file anchor if
        // scan.js supplies one. Both absent means no honest timestamp exists,
        // so nothing is emitted. Do not substitute Date.now(): that would
        // stamp a transcript from last week as activity happening right now.
        const ts = toIso(firstKey(e, TS_KEYS)) || toIso(fileState.sourceMtime) || null;
        if (!project || !ts) continue;

        const session = typeof e.session_id === 'string' && e.session_id ? e.session_id
          : typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : undefined;
        const msg = e.message && typeof e.message === 'object' ? e.message : null;
        const role = (msg && msg.role) || e.role || null;

        if (e.type === 'user' || role === 'user') {
          const text = textFromContent(msg ? msg.content : e.content).trim();
          if (text && isRealPrompt(text)) {
            events.push({ ts, project, source: this.displayName, kind: 'prompt', text, session });
          }
          continue;
        }

        if (e.type === 'assistant' || role === 'assistant') {
          // Assistant text arrives as deltas that must be concatenated, so the
          // running text is accumulated on fileState rather than overwritten
          // the way claude-code can afford to overwrite a whole block.
          const text = textFromContent(msg ? msg.content : e.content);
          if (text) {
            const prev = (fileState.lastText && fileState.lastText.text) || '';
            const joined = (prev + text).slice(0, MAX_TEXT_CHARS);
            fileState.lastText = { ts, project, text: joined, session };
          }
          continue;
        }

        if (e.type === 'tool_call') {
          // Only completed calls, so a cancelled edit is not reported as one
          // that happened. `subtype` is documented as started/completed.
          if (e.subtype && e.subtype !== 'completed') continue;
          for (const [key, val] of Object.entries(e)) {
            if (!val || typeof val !== 'object') continue;
            // Shape seen in the wild: { editToolCall: { args: {...} } }.
            const name = key.endsWith('ToolCall') ? key.slice(0, -'ToolCall'.length) : (typeof val.name === 'string' ? val.name : null);
            if (!name || !EDIT_TOOL_RE.test(name)) continue;
            const file = firstKey(val.args || val.params || val, FILE_KEYS);
            if (typeof file !== 'string' || !file) continue;
            // Relative paths are left relative on purpose. scan.js resolves
            // them against the raw project before normalizing worktrees, and
            // resolving here would defeat that.
            events.push({ ts, project, source: this.displayName, kind: 'edit', file, session });
          }
        }
      } catch {
        // Skip the record. Never let one bad line poison the file.
      }
    }

    // One summary per pass from the freshest accumulated text, matching the
    // other two adapters. Renderers keep only the latest summary per session.
    const last = fileState.lastText;
    if (last && typeof last.text === 'string' && last.text.trim().length >= MIN_SUMMARY_CHARS) {
      events.push({ ts: last.ts, project: last.project, source: this.displayName, kind: 'summary', text: last.text.trim(), session: last.session });
    }
    return events;
  },

  // Exported for the tests this draft still needs.
  looksLikeCursorTranscript,
  projectFromSourceFile,
  toIso,
};
