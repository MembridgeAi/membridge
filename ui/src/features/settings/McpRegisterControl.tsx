import { StateChip, type StateTone } from '../../components/StateChip'
import { useRegisterMcp, useSettings } from '../../data/queries'
import type { McpRowStatus } from '../../data/types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

const KNOWN_AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
}

// Mirrors settingsMapper.ts's agentLabel -- a user-declared agent lib/mcp-
// register.js has never heard of still gets a readable label, not a raw id.
function agentLabel(agent: string): string {
  return KNOWN_AGENT_LABELS[agent] ?? agent.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// The chips used to interpolate lib/mcp-register.js's raw status token, so
// they read "Codex: skipped" and "Cursor: removed" -- the daemon's internal
// vocabulary, describing its own control flow rather than the user's machine.
// Each status now maps to a phrase about what is true on this machine.
//
// 'skipped' is the load-bearing one: mcp-register.js sets it whenever it
// declined to write (no `claude` binary, a config file that isn't ours, an
// undeclared agent, auto-registration switched off), and it ALWAYS attaches a
// `detail` sentence naming the cause and usually the config key that fixes it.
// So the phrase stays deliberately short and the detail carries the specifics.
function phraseFor(status: McpRowStatus): string {
  if (status === 'registered') return 'registered now'
  if (status === 'unchanged') return 'already registered'
  if (status === 'removed') return 'registration removed'
  if (status === 'failed') return "couldn't register"
  return 'nothing changed' // 'skipped'
}

// 'skipped' was muted alongside 'removed', so the tone said "fine" while the
// word said something hadn't happened. A skip means the MCP server is NOT
// wired into that tool and its detail names what to do about it, which is the
// definition of warn. 'removed' stays muted: that is a deliberate outcome of
// asking for a removal, not a problem to fix.
function toneFor(status: McpRowStatus): StateTone {
  if (status === 'registered' || status === 'unchanged') return 'ok'
  if (status === 'failed') return 'bad'
  if (status === 'skipped') return 'warn'
  return 'muted' // 'removed'
}

function glyphFor(status: McpRowStatus): string {
  if (status === 'registered' || status === 'unchanged') return '✓'
  if (status === 'failed') return '✕'
  if (status === 'skipped') return '⚠'
  return '•'
}

/**
 * "Re-register" -- Task: the MCP row used to only offer a fix (the old,
 * never-actually-wired "Register" button) when it reported not-installed.
 * That left no way to force a fresh reconcile on a machine where a tool
 * CLAIMS installed but is actually misbehaving. This control is rendered in
 * every state (installed, not registered, not checked yet) and always calls
 * the real registration path: POST /api/mcp/register -> lib/mcp-register.js's
 * registerNow(), the same thing `membridge mcp register` runs.
 *
 * A failed row must be visible, never silently swallowed into a generic
 * "done" -- each tool's real per-row status renders as its own chip
 * afterwards (red for failed, matching every other real-problem indicator
 * on this page), and a request-level failure (the endpoint itself rejecting)
 * surfaces through the same .settings-error pattern every other write here
 * uses.
 */
export function McpRegisterControl() {
  const registerMcp = useRegisterMcp()
  const settingsQuery = useSettings()

  // These chips used to appear ONLY after a Re-register click, because the
  // mutation response was their only source. That hid the reasons behind an
  // action nobody knew to take: at rest the page showed a single summary
  // sentence ("no AI tool on this machine picked it up") while the daemon
  // had already recorded, per tool, the specific cause and the config key
  // that fixes it -- the same lines `membridge status` prints. The recorded
  // rows come through GET /api/settings, so they render immediately; a fresh
  // mutation result supersedes them because it is the newer truth about the
  // same machine.
  const recorded = settingsQuery.data?.delivery.find(c => c.id === 'mcp')?.mcpRows ?? []
  const rows = registerMcp.data?.rows ?? recorded

  return (
    <>
      <button
        type="button"
        className="settings-btn"
        onClick={() => registerMcp.mutate()}
        disabled={registerMcp.isPending}
      >
        {registerMcp.isPending ? 'Registering…' : 'Re-register'}
      </button>
      {rows.map(row => (
        <StateChip key={row.agent} tone={toneFor(row.status)} glyph={glyphFor(row.status)}>
          {`${agentLabel(row.agent)}: ${phraseFor(row.status)}${row.detail ? ` · ${row.detail}` : ''}`}
        </StateChip>
      ))}
      {registerMcp.isError && (
        <p className="settings-error" role="alert">Couldn't re-register. {errorMessage(registerMcp.error)}</p>
      )}
    </>
  )
}
