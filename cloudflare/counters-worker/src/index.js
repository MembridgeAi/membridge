/**
 * MemBridge anonymous counter ingest.
 *
 * Deliberately hosted on Cloudflare and NOT on the Supabase project: this
 * endpoint is public and unauthenticated by construction (clients are
 * anonymous), and an unauthenticated write path on the Supabase project would
 * be a hole into the database holding every customer's data. This Worker holds
 * no Supabase credential and has no route to it. The worst case for a full
 * compromise here is wrong numbers on an internal page.
 *
 * See docs/superpowers/specs/2026-07-28-developer-diagnostics-backend-design.md §2.
 *
 * Contract with lib/counters.js:
 *   POST { install_id, version, counters: [{ name, dims }] }
 *   -> 204, always, whatever happens.
 *
 * WHY ALWAYS 204: the client is fire-and-forget with a 5s timeout. An error
 * status teaches a buggy or hostile client to retry, and a retry storm across
 * every install is the one failure mode a silent diagnostic cannot notice.
 * Rejections are counted internally instead, so bad input is visible on the
 * dashboard rather than to the sender.
 */

// Must stay in sync with lib/counters.js -- including MCP_TOOLS there, which
// is the source of the `tool` set below (lib/mcp-usage.js's presence tally
// of the six read-only MCP tools). Anything outside these sets is dropped
// rather than stored: a fixed allowlist is what stops an unexpected value (a
// path, a branch name, a stray identifier) from ever landing in the dataset,
// however the client changes.
const COUNTER_NAMES = new Set(['heartbeat', 'recall_state', 'hook_registration', 'environment', 'mcp_tool_used']);
const DIM_VALUES = {
  state: new Set(['serving', 'no_hot_paths', 'empty_store', 'all_rejected', 'ready_unserved']),
  shape: new Set(['single', 'worktree', 'mixed', 'none']),
  result: new Set(['wrote', 'current', 'failed']),
  tool: new Set(['get_project_memory', 'get_recent_activity', 'list_projects', 'recall', 'search_memory', 'why']),
};

const MAX_BODY_BYTES = 2048;   // a valid payload is ~200 bytes, the real backstop
// Exported so tests can assert against the real cap rather than a copied
// magic number. 4 base (heartbeat/recall_state/environment/hook_registration)
// + up to 6 mcp_tool_used (one per allowlisted MCP tool), with headroom.
export const MAX_COUNTERS = 16;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$/;

const noContent = () => new Response(null, { status: 204 });

/**
 * Returns the datapoints to write, or [] if anything is off. Pure and total —
 * it never throws, so the handler has no error path to get wrong.
 */
export function validate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];

  const installId = payload.install_id;
  const version = payload.version;
  if (typeof installId !== 'string' || !UUID_RE.test(installId)) return [];
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return [];
  if (!Array.isArray(payload.counters) || payload.counters.length === 0) return [];
  if (payload.counters.length > MAX_COUNTERS) return [];

  const points = [];
  const seen = new Set();
  for (const c of payload.counters) {
    if (!c || typeof c !== 'object') return [];
    if (typeof c.name !== 'string' || !COUNTER_NAMES.has(c.name)) return [];

    const dims = c.dims;
    if (dims !== undefined && (typeof dims !== 'object' || dims === null || Array.isArray(dims))) return [];
    const keys = dims ? Object.keys(dims) : [];
    if (keys.length > 1) return [];

    let dimKey = '';
    let dimValue = '';
    if (keys.length === 1) {
      dimKey = keys[0];
      const allowed = DIM_VALUES[dimKey];
      if (!allowed) return [];
      dimValue = dims[dimKey];
      if (typeof dimValue !== 'string' || !allowed.has(dimValue)) return [];
    }

    // One datapoint per (name, dimKey, dimValue) per request. A counter name
    // may legitimately repeat with a DIFFERENT allowlisted dim value in the
    // same payload (mcp_tool_used: one entry per tool actually used) -- that
    // is not inflation. Repeating the exact same (name, dim) pair is still
    // rejected outright, whole payload included: that can only be a client
    // bug or an inflation attempt, same as before.
    const identity = `${c.name}|${dimKey}|${dimValue}`;
    if (seen.has(identity)) return [];
    seen.add(identity);

    points.push({
      // Analytics Engine allows one index, used as the sampling key. Keying on
      // the install means sampling degrades gracefully at volume: it thins
      // installs evenly rather than dropping one counter type wholesale.
      indexes: [installId],
      blobs: [c.name, version, dimKey, dimValue],
      doubles: [1],
    });
  }
  return points;
}

export default {
  async fetch(request, env) {
    // No CORS headers anywhere on purpose. The only legitimate caller is the
    // desktop client, which is not a browser; adding CORS would invite a
    // browser-based inflation source for no benefit.
    if (request.method !== 'POST') return noContent();

    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_BODY_BYTES) return noContent();

    let payload = null;
    try {
      const text = await request.text();
      // Re-check after reading: content-length is client-supplied and may lie.
      if (text.length > MAX_BODY_BYTES) return noContent();
      payload = JSON.parse(text);
    } catch {
      return noContent();
    }

    const points = validate(payload);
    if (!points.length) {
      // Rejections are themselves a signal — a spike means either a broken
      // release or someone probing. Recorded so it shows up on the dashboard.
      try {
        env.COUNTERS?.writeDataPoint({ indexes: ['rejected'], blobs: ['rejected', '', '', ''], doubles: [1] });
      } catch {}
      return noContent();
    }

    for (const p of points) {
      try {
        env.COUNTERS?.writeDataPoint(p);
      } catch {
        // One bad write must not drop the rest of the batch.
      }
    }
    return noContent();
  },
};
