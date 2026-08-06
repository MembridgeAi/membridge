import { useMemo, useState } from 'react'
import { FormDialog } from '../../components/FormDialog'
import { useDataClient } from '../../data/DataClientProvider'
import { useAdoptProjects, useDiscoveredProjects, usePickPaths } from '../../data/queries'
import type { DiscoveredProject } from '../../data/types'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function sessionLabel(count: number): string {
  return count === 1 ? '1 session' : `${count} sessions`
}

interface AddProjectDialogProps {
  onClose: () => void
}

// What the bulk adopt call reported, kept whole rather than pre-formatted so
// each row (skipped or history-withheld) is announced as itself instead of a
// single sentence the user has to parse. A partial failure and a
// re-adopt-without-history are both non-fatal outcomes: neither closes the
// dialog, because a dialog that vanishes takes the reason with it.
interface AdoptReport {
  requested: number
  adoptedCount: number
  skipped: { path: string; reason: string }[]
  historyWithheld: string[]
}

/**
 * "Add project" — pick from what is already on this machine, or point a
 * native Finder/Explorer window at a folder. There is deliberately NO path
 * field: typing an absolute path by hand was the one thing every user had to
 * get exactly right, with a 400 as the only feedback when they didn't.
 *
 * Two ways in, both list-or-click:
 *  1. The scan (GET /api/scan, DataClient.discoverProjects) — every folder
 *     on this machine with real AI activity. Already-watched folders are
 *     filtered out here rather than rendered as dead checkboxes.
 *  2. Browse… — the Electron picker (window.membridge.pickPaths), for a
 *     folder that has no AI sessions in it yet and so cannot be discovered.
 *
 * Both routes end in the same bulk POST /api/projects/adopt, which reports
 * per-path outcomes; a partial failure names the folders that failed instead
 * of reporting the whole sweep as success, and a re-adopt that would replay a
 * previously-deleted project comes back with those paths in `historyWithheld`
 * so the UI can say why the block landed empty (matching the CLI's message).
 */
export function AddProjectDialog({ onClose }: AddProjectDialogProps) {
  const client = useDataClient()
  const discovery = useDiscoveredProjects(true)
  const adopt = useAdoptProjects()
  const pickPaths = usePickPaths()
  // Paths the user has UNCHECKED. Selection is stored as the complement so a
  // row that arrives from a later re-scan is selected by default like every
  // other row, instead of silently arriving unchecked.
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [report, setReport] = useState<AdoptReport | null>(null)

  const candidates: DiscoveredProject[] = useMemo(
    () => (discovery.data ?? [])
      .filter(p => !p.tracked)
      .sort((a, b) => b.sessionCount - a.sessionCount),
    [discovery.data],
  )
  const selected = candidates.filter(p => !excluded.has(p.path))
  const allSelected = candidates.length > 0 && selected.length === candidates.length

  function toggle(path: string, isSelected: boolean) {
    setExcluded(prev => {
      const next = new Set(prev)
      if (isSelected) next.delete(path)
      else next.add(path)
      return next
    })
  }

  // One request for every path, never one per row: a half-finished sweep
  // over 40 folders is a state the user would have to reason about.
  async function add(paths: string[], closeOnSuccess: boolean) {
    if (paths.length === 0) return
    setReport(null)
    try {
      const result = await adopt.mutateAsync(paths)
      const historyWithheld = result.historyWithheld ?? []
      // Any non-clean outcome keeps the dialog open. Skipped rows are a
      // partial failure the user needs to see per-path; a re-adopt that
      // withholds history is a success with a caveat — the block will land
      // empty for those projects, and if the dialog vanished the user would
      // have no reason offered for it.
      if (result.skipped.length > 0 || historyWithheld.length > 0) {
        setReport({
          requested: paths.length,
          adoptedCount: result.adopted.length,
          skipped: result.skipped,
          historyWithheld,
        })
        return
      }
      if (closeOnSuccess) onClose()
    } catch {
      // adopt.isError renders the message below; nothing else to do.
    }
  }

  // The native picker. Multiple on purpose — selecting three folders in one
  // Finder window is one adopt request, same as the scan list's bulk add.
  async function browse() {
    setReport(null)
    try {
      const picked = await pickPaths.mutateAsync({ kind: 'folder', multiple: true })
      if (picked.length === 0) return // cancelled
      await add(picked, true)
    } catch {
      // pickPaths.isError renders the message below.
    }
  }

  const pending = adopt.isPending || pickPaths.isPending
  const scanning = discovery.isLoading

  return (
    <FormDialog titleId="add-project-title" title="Add project" wide onClose={onClose}>
      <p className="dialog-message">
        {scanning
          ? 'Looking for projects you have already worked in on this machine…'
          : candidates.length > 0
            ? 'These folders on this machine have AI sessions in them. Pick the ones MemBridge should watch.'
            : 'Every folder with AI activity on this machine is already being watched.'}
      </p>

      {discovery.isError && (
        <p className="dialog-error" role="alert">Couldn't scan this machine. {errorMessage(discovery.error)}</p>
      )}

      {candidates.length > 0 && (
        <>
          <div className="discover-toolbar">
            <span className="mono discover-count">{selected.length} of {candidates.length} selected</span>
            <button
              type="button"
              className="dialog-btn discover-select-all"
              onClick={() => setExcluded(allSelected ? new Set(candidates.map(p => p.path)) : new Set())}
            >
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <ul className="discover-list">
            {candidates.map(p => (
              <li key={p.path} className="discover-row" data-testid={`discover-row-${p.name}`}>
                <label className="discover-label">
                  <input
                    type="checkbox"
                    checked={!excluded.has(p.path)}
                    onChange={e => toggle(p.path, e.target.checked)}
                    aria-label={p.name}
                  />
                  <span className="discover-name">{p.name}</span>
                  <span className="discover-meta">
                    {sessionLabel(p.sessionCount)}
                    {p.tools.length > 0 && ` · ${p.tools.join(', ')}`}
                  </span>
                  <span className="mono discover-path">{p.path}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      )}

      {report && report.skipped.length > 0 && (
        <div className="dialog-error" role="alert">
          <p className="discover-report-line">
            Added {report.adoptedCount} of {report.requested}. Skipped:
          </p>
          <ul className="discover-report-list">
            {report.skipped.map(s => (
              <li key={s.path}>
                <span className="mono discover-report-path">{s.path}</span>
                {' — '}
                {s.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* history-withheld is a success case (the projects ARE now watched),
          but the injected memory block will land empty for them because they
          were removed on purpose before. Mirrors the CLI wording so a user
          moving between the two surfaces reads the same explanation. */}
      {report && report.historyWithheld.length > 0 && (
        <div className="discover-withheld" role="status">
          <p className="discover-report-line">
            Added, but earlier memory was not restored — these folders were previously deleted on purpose:
          </p>
          <ul className="discover-report-list">
            {report.historyWithheld.map(p => (
              <li key={p}>
                <span className="mono discover-report-path">{p}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {adopt.isError && (
        <p className="dialog-error" role="alert">Couldn't add. {errorMessage(adopt.error)}</p>
      )}
      {pickPaths.isError && (
        <p className="dialog-error" role="alert">Couldn't open the folder picker. {errorMessage(pickPaths.error)}</p>
      )}

      <div className="dialog-actions discover-actions">
        {/* The picker exists only behind the Electron bridge. In a plain
            browser tab there is no window.membridge to answer the IPC call,
            so the button is not rendered at all -- and the note says what to
            use instead, rather than leaving a control that does nothing. */}
        {client.capabilities.filePicker ? (
          <button type="button" className="dialog-btn discover-browse" onClick={() => { void browse() }} disabled={pending}>
            Browse for a folder…
          </button>
        ) : (
          <span className="discover-note">Open MemBridge's desktop app to browse for a folder that isn't listed.</span>
        )}
        <button type="button" className="dialog-btn" onClick={onClose} disabled={pending}>
          Cancel
        </button>
        <button
          type="button"
          className="dialog-btn dialog-btn-primary"
          disabled={pending || selected.length === 0}
          onClick={() => { void add(selected.map(p => p.path), true) }}
        >
          {selected.length === 1 ? 'Add 1 project' : `Add ${selected.length} projects`}
        </button>
      </div>
    </FormDialog>
  )
}
