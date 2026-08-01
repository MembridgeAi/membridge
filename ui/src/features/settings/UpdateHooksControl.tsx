import { StateChip, type StateTone } from '../../components/StateChip'
import { useUpdateHooks } from '../../data/queries'
import type { HooksVersionStatus, HookVintage } from '../../data/types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function vintageTone(v: HookVintage): StateTone {
  if (v === 'current') return 'ok'
  if (v === 'outdated') return 'warn'
  return 'muted'
}

function vintageGlyph(v: HookVintage): string {
  if (v === 'current') return '✓'
  if (v === 'outdated') return '⚠'
  return '•'
}

function vintageLabel(v: HookVintage): string {
  if (v === 'current') return 'up to date'
  if (v === 'outdated') return 'outdated — update available'
  return 'unknown'
}

interface UpdateHooksControlProps {
  hooksVersion: HooksVersionStatus
}

/**
 * "Update hooks" -- force-rewrites the Stop, recall and search hooks to the current
 * build (POST /api/hooks/update -> lib/hooks.js's forceUpdateHooks), always
 * callable regardless of the reported vintage -- the same "not gated on the
 * current state" shape as McpRegisterControl's Re-register. Two vintage
 * chips (one per hook) render honestly from Settings.hooksVersion up front;
 * after a click, each hook's own ok/detail renders as its own chip too, so a
 * Stop-hook failure can never hide behind a successful recall/search result
 * or a generic "done". There is deliberately no search VINTAGE chip: the
 * search hook is reconciled on every daemon launch (hooks.ensureInstalled), so
 * a stale one self-heals without the user ever being asked to act on it.
 */
export function UpdateHooksControl({ hooksVersion }: UpdateHooksControlProps) {
  const updateHooks = useUpdateHooks()
  const result = updateHooks.data

  return (
    <>
      <StateChip tone={vintageTone(hooksVersion.stop)} glyph={vintageGlyph(hooksVersion.stop)}>
        {`Stop hook: ${vintageLabel(hooksVersion.stop)}`}
      </StateChip>
      <StateChip tone={vintageTone(hooksVersion.recall)} glyph={vintageGlyph(hooksVersion.recall)}>
        {`Recall hook: ${vintageLabel(hooksVersion.recall)}`}
      </StateChip>
      <button
        type="button"
        className="settings-btn"
        onClick={() => updateHooks.mutate()}
        disabled={updateHooks.isPending}
      >
        {updateHooks.isPending ? 'Updating…' : 'Update hooks'}
      </button>
      {result && (
        <>
          <StateChip tone={result.stop.ok ? 'ok' : 'bad'} glyph={result.stop.ok ? '✓' : '✕'}>
            {`Stop: ${result.stop.detail}`}
          </StateChip>
          <StateChip tone={result.recall.ok ? 'ok' : 'bad'} glyph={result.recall.ok ? '✓' : '✕'}>
            {`Recall: ${result.recall.detail}`}
          </StateChip>
          <StateChip tone={result.search.ok ? 'ok' : 'bad'} glyph={result.search.ok ? '✓' : '✕'}>
            {`Search: ${result.search.detail}`}
          </StateChip>
        </>
      )}
      {updateHooks.isError && (
        <p className="settings-error" role="alert">Couldn't update hooks. {errorMessage(updateHooks.error)}</p>
      )}
    </>
  )
}
