import { StateChip, type StateTone } from '../../components/StateChip'
import { useRegisterMcp } from '../../data/queries'
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

function toneFor(status: McpRowStatus): StateTone {
  if (status === 'registered' || status === 'unchanged') return 'ok'
  if (status === 'failed') return 'bad'
  return 'muted' // 'removed' | 'skipped'
}

function glyphFor(status: McpRowStatus): string {
  if (status === 'registered' || status === 'unchanged') return '✓'
  if (status === 'failed') return '✕'
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
  const rows = registerMcp.data?.rows ?? []

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
          {`${agentLabel(row.agent)}: ${row.status}${row.detail ? ` — ${row.detail}` : ''}`}
        </StateChip>
      ))}
      {registerMcp.isError && (
        <p className="settings-error" role="alert">Couldn't re-register. {errorMessage(registerMcp.error)}</p>
      )}
    </>
  )
}
