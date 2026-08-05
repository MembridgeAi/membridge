'use strict';
const os = require('os');
const path = require('path');

// Claude Code writes one JSONL transcript per session under
// ~/.claude/projects/<project-slug>/<session-id>.jsonl. Every entry carries
// the project path in `cwd`; fileState only tracks the most recent assistant
// text block, which becomes the session's summary event.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Read-shaped tools. Their targets are what an agent re-derives context from,
// which is the waste the ledger measures.
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);
const MAX_TODO_ITEMS = 20; // todos events are stored verbatim — keep them bounded
// "Task #12 created successfully: Rebuild the parser" — TaskCreate's id is
// assigned by the harness and only ever appears in the tool RESULT, so the
// list can be rebuilt only by pairing each call with its reply.
const TASK_CREATED_RE = /^Task #(\d+) created successfully/;
const MIN_SUMMARY_CHARS = 80; // shorter final texts are "Done." noise, not summaries

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c && c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join(' ');
  }
  return '';
}

// Machine-authored payloads that arrive on the user turn but carry no angle
// bracket, so the `<`-prefix test below never sees them: another agent's
// message or an idle/stop notification, delivered either as a bare label or as
// a JSON envelope. These are chatter between tools, not something a human
// typed, and they read as noise in the prompt stream.
// The token must be followed by an envelope delimiter (`idle_notification:`,
// `[teammate-message]`) or sit in a JSON header — a prompt that merely OPENS
// with the word ("idle_notification should be filtered out") is a human asking
// about the feature and must survive.
const NOISE_RE = /^[[({\s"']*(?:idle_notification|teammate[_-]message|agent[_-](?:message|notification))\s*[\]:)}>,]|^\{[^}]{0,120}?"(?:type|event)"\s*:\s*"(?:idle_notification|teammate[_-]message)/i;

// Keep human asks; drop tool results, injected command wrappers, interruptions,
// and inter-agent chatter.
function isRealPrompt(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (t.startsWith('<') || t.startsWith('Caveat:') || t.startsWith('[Request interrupted')) return false;
  return !NOISE_RE.test(t);
}

// Prompt path only. An injected envelope can ride ALONG with a real ask in the
// same turn (a <system-reminder> appended after the human's text), so joining
// every block before the test would bury the envelope past the prefix check AND
// paste harness scaffolding into the stored prompt. Each block is judged on its
// own; only the human-authored ones survive. Assistant text keeps using
// textFromContent — none of this applies there.
function promptText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .filter(isRealPrompt)
    .join(' ')
    .trim();
}

module.exports = {
  id: 'claude-code',
  displayName: 'Claude Code',

  sessionRoots(config) {
    const opts = (config.adapters || {})['claude-code'] || {};
    return [opts.dir || path.join(os.homedir(), '.claude', 'projects')];
  },

  extractEvents(entries, fileState) {
    const events = [];
    // Task-tool reconstruction state. TodoWrite shipped the whole list in one
    // input; TaskCreate/TaskUpdate ship one task per call, so the list exists
    // only as state we rebuild. Both maps live on fileState so an incremental
    // read that sees only a TaskUpdate still knows that task's text.
    //   pendingCreates: tool_use id -> subject, until the result names its id
    //   tasks:          task id     -> { text, status }, insertion-ordered
    if (!fileState.pendingCreates) fileState.pendingCreates = {};
    if (!fileState.tasks) fileState.tasks = {};
    // Sessions whose task list changed in THIS pass. One snapshot is emitted
    // per session at the end rather than one per mutation: renderers keep only
    // the latest snapshot per session anyway, and a snapshot per call would
    // store the whole list dozens of times over in state.json.
    const touched = new Map();
    const noteTask = (e, session) => {
      const key = session || '';
      touched.set(key, { ts: e.timestamp, project: e.cwd, session });
    };
    // Per-request token usage. Emitted once per RECORD; several records share
    // one message id when a response had multiple content blocks, so the
    // ledger dedupes on messageId rather than the adapter. Shared by both the
    // sidechain and main-chain branches below so the shape can't drift.
    const pushUsage = (e, session, sidechain) => {
      events.push({
        ts: e.timestamp, project: e.cwd, source: this.displayName,
        kind: 'usage', session,
        messageId: e.message.id || e.uuid || null,
        model: e.message.model || null,
        usage: e.message.usage,
        sidechain,
      });
    };
    for (const e of entries) {
      if (!e || !e.cwd || !e.timestamp) continue;
      // A subagent (sidechain) turn is judged PER KIND, not with one verdict.
      // The old rule kept the token spend and dropped everything else, which
      // was right for the era when subagents only searched. They now write the
      // code: a lead who delegates every edit got `files: []` on every session
      // while the ledger still billed the work, so MemBridge recorded what the
      // subagents cost and nothing about what they did. The split now:
      //   * usage  -> banked exactly as before, still sidechain:true, so the
      //               ledger keeps treating it as its own request stream.
      //   * edits  -> KEPT. A sidechain record carries the PARENT session's id
      //               (verified on disk: every record in a subagents/agent-*
      //               transcript names the parent), so the human's session
      //               shows what its subagents changed and no synthetic
      //               session is invented. The project comes from the edited
      //               FILE, not this cwd -- project-resolve.rehomeEvents
      //               re-stamps every edit from its own path, which is what
      //               makes a cross-worktree or cross-repo edit land right.
      //   * prompts/summaries -> still dropped. A subagent's user turn is the
      //               spawn prompt the LEAD wrote, and its closing text is a
      //               report addressed to the lead. Surfacing either would
      //               fabricate human asks and self-reports nobody made.
      //   * todos  -> still dropped, and not merely as low value: snapshots are
      //               one-per-session and renderers keep only the latest, so a
      //               subagent's private checklist would OVERWRITE the lead's
      //               "Where you left off" list. TaskCreate/TaskUpdate feed the
      //               same snapshot and stay out for the same reason.
      //   * reads  -> still dropped. Reads are the denominator of the ledger's
      //               redundant-read and savings figures; doubling that
      //               population would silently re-baseline numbers quoted
      //               outside the product. A deliberate follow-up, not a side
      //               effect of this change.
      // So this stays a narrow branch rather than falling through to the
      // main-chain handling below, which would re-enable all four dropped kinds
      // at once (the prompt path, fileState.lastText, TodoWrite and reads).
      if (e.isSidechain) {
        if (e.type === 'assistant' && e.message) {
          const session = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : undefined;
          if (e.message.usage) pushUsage(e, session, true);
          // No session id and scan.js would fall back to the transcript
          // FILENAME, which for a subagent file is `agent-<hex>` -- a session
          // with no prompt and no summary, i.e. a phantom card on the feed.
          // Attribute the edit to the parent session or not at all.
          if (session && Array.isArray(e.message.content)) {
            for (const c of e.message.content) {
              if (!c || c.type !== 'tool_use') continue;
              if (!EDIT_TOOLS.has(c.name) || !c.input || !c.input.file_path) continue;
              events.push({
                ts: e.timestamp, project: e.cwd, source: this.displayName,
                kind: 'edit', file: c.input.file_path, session,
              });
            }
          }
        }
        continue;
      }
      // A tool_result arrives on the USER turn and is the only place a new
      // task's id is stated, so it is read before the isMeta/prompt handling
      // below (which would otherwise skip these entries entirely).
      if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
        for (const c of e.message.content) {
          if (!c || c.type !== 'tool_result') continue;
          const subject = fileState.pendingCreates[c.tool_use_id];
          if (!subject) continue;
          delete fileState.pendingCreates[c.tool_use_id];
          const text = typeof c.content === 'string' ? c.content : textFromContent(c.content);
          const m = TASK_CREATED_RE.exec(String(text).trim());
          if (!m) continue;
          fileState.tasks[m[1]] = { text: subject, status: 'pending' };
          noteTask(e, typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : undefined);
        }
      }
      // The entry's own session id, when it carries one. scan.js falls back to
      // the transcript FILENAME, which is normally the same value — but not
      // after a resume or a compaction, where a new file can hold entries from
      // an existing session. The Stop hook keys its summary on the payload's
      // session_id, so an id sourced from the filename silently orphans that
      // summary from its prompts and memorydb mints an "(not captured)" entry.
      const session = typeof e.sessionId === 'string' && e.sessionId ? e.sessionId : undefined;
      if (e.type === 'user' && !e.isMeta && e.message) {
        const text = promptText(e.message.content);
        if (isRealPrompt(text)) {
          events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'prompt', text, session });
        }
      } else if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
        if (e.message.usage) pushUsage(e, session, false);
        for (const c of e.message.content) {
          if (!c || c.type !== 'tool_use') continue;
          if (READ_TOOLS.has(c.name) && c.input) {
            const file = c.input.file_path || c.input.notebook_path || c.input.path || null;
            if (file) {
              events.push({
                ts: e.timestamp, project: e.cwd, source: this.displayName,
                kind: 'read', session, file, tool: c.name, toolUseId: c.id,
                offset: typeof c.input.offset === 'number' ? c.input.offset : null,
                limit: typeof c.input.limit === 'number' ? c.input.limit : null,
                messageId: e.message.id || null,
              });
            }
            continue;
          }
          if (EDIT_TOOLS.has(c.name) && c.input && c.input.file_path) {
            events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'edit', file: c.input.file_path, session });
          } else if (c.name === 'TodoWrite' && c.input && Array.isArray(c.input.todos)) {
            const items = c.input.todos
              .filter(t => t && typeof t.content === 'string')
              .slice(0, MAX_TODO_ITEMS)
              .map(t => ({ text: t.content, status: String(t.status || 'pending') }));
            if (items.length) {
              events.push({ ts: e.timestamp, project: e.cwd, source: this.displayName, kind: 'todos', items, session });
            }
          } else if (c.name === 'TaskCreate' && c.input && typeof c.input.subject === 'string' && c.input.subject.trim()) {
            // Park the subject until the result names the id it was given.
            fileState.pendingCreates[c.id] = c.input.subject.trim();
          } else if (c.name === 'TaskUpdate' && c.input && c.input.taskId != null) {
            const task = fileState.tasks[String(c.input.taskId)];
            // An id we never saw created (an earlier transcript, or a task
            // created before this file) has no text, so there is nothing
            // honest to show — skip it rather than invent a blank row.
            if (!task) continue;
            if (c.input.status === 'deleted') delete fileState.tasks[String(c.input.taskId)];
            else {
              if (c.input.status) task.status = String(c.input.status);
              if (typeof c.input.subject === 'string' && c.input.subject.trim()) task.text = c.input.subject.trim();
            }
            noteTask(e, session);
          }
        }
        // The last assistant text seen so far is the agent's running
        // self-report; it survives incremental reads via fileState.
        const text = textFromContent(e.message.content).trim();
        if (text) fileState.lastText = { ts: e.timestamp, project: e.cwd, text, session };
      }
    }
    // One task snapshot per touched session, carrying the whole rebuilt list
    // in the same shape TodoWrite produced, so everything downstream (the
    // context block, openTodos, the card's "Where you left off") is unchanged.
    for (const at of touched.values()) {
      const items = Object.keys(fileState.tasks)
        .slice(0, MAX_TODO_ITEMS)
        .map(id => ({ text: fileState.tasks[id].text, status: fileState.tasks[id].status }));
      if (items.length) {
        events.push({ ts: at.ts, project: at.project, source: this.displayName, kind: 'todos', items, session: at.session });
      }
    }
    // One summary per pass from the freshest text: an updated last-text emits
    // a new event, and renderers keep only the latest summary per session.
    const last = fileState.lastText;
    if (last && last.text.length >= MIN_SUMMARY_CHARS) {
      events.push({ ts: last.ts, project: last.project, source: this.displayName, kind: 'summary', text: last.text, session: last.session });
    }
    return events;
  },

  isRealPrompt,
};
