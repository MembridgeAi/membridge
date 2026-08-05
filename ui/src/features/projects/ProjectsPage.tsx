import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { projectHref } from '../../app/routes'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { SyncStateView } from '../../components/SyncState'
import { useDataClient } from '../../data/DataClientProvider'
import { relativeAgo } from '../../data/relativeTime'
import { isRetryableDeleteRefusal, useAccessMatrix, useArchiveProject, useDeleteProject, useMembers, useProjectAccess, useProjects, useSetProjectAccess, useSettings, useStatus, useSyncProject, useUnarchiveProject } from '../../data/queries'
import type { AccessMatrix, Project } from '../../data/types'
import { AccessPopover, type PopoverRoster } from './AccessPopover'
import { AccessSummary, type AccessMemberRef } from './AccessSummary'
import { AddProjectDialog } from './AddProjectDialog'
import './projects.css'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// The fixed column set (spec: Project · Sessions 7d · Last activity · Sync ·
// Access · Open). Width is independent of team size by construction.
const COLUMN_COUNT = 6

interface ProjectTableRowProps {
  project: Project
  /** Authoritative roster, or null when this page cannot know it (rosterFor). */
  roster: AccessMemberRef[] | null
  teamSize: number
  showAccess: boolean
  onSync: () => void
  /** True while THIS row's sync request is in flight (Fix 9). */
  syncPending: boolean
  onOpenAccess: () => void
  /** Select mode: when non-null, a checkbox gutter leads the row. */
  selection: { selected: boolean; onToggle: (selected: boolean) => void } | null
  /** Single-project delete (Task 6). Null in select mode: Delete is not a
   *  bulk action, so no delete control may exist while selecting. */
  onDelete: (() => void) | null
}

function ProjectTableRow({ project, roster, teamSize, showAccess, onSync, syncPending, onOpenAccess, selection, onDelete }: ProjectTableRowProps) {
  return (
    <tr data-testid={`project-row-${project.name}`}>
      {selection && (
        <td className="select-gutter">
          <input
            type="checkbox"
            className="access-cell"
            checked={selection.selected}
            aria-label={`Select ${project.name}`}
            onChange={e => selection.onToggle(e.target.checked)}
          />
        </td>
      )}
      {/* The NAME is the link, not only the "Open" button parked at the far
          right of the row: the name is what a reader points at, and leaving it
          dead meant the obvious target did nothing. Same destination as Open,
          from the same builder, so the two can never drift apart. */}
      <td className="proj-name">
        <Link href={projectHref(project.path)} className="proj-name-link">{project.name}</Link>
        {' '}<span className={`tag ${project.shared ? 'tag-team' : 'tag-private'}`}>{project.shared ? 'Shared' : 'Private'}</span>
        {/* `title` is load-bearing, not a nicety: projects.css clamps the path
            to two lines, and what a clamp drops is the TAIL -- which is the
            only thing distinguishing two worktrees of one repo
            (.../worktrees/ui vs .../worktrees/hunt). The full path has to stay
            recoverable without leaving the row. */}
        <span className="mono proj-path" title={project.path}>{project.path}</span>
      </td>
      <td className="mono num">{project.sessionsThisWeek}</td>
      <td className="mono num">{project.lastActivity ? relativeAgo(project.lastActivity) : 'never'}</td>
      <td><SyncStateView state={project.sync} onSync={project.sync.state === 'behind' ? onSync : undefined} syncPending={syncPending} /></td>
      {showAccess && (
        <td className="access-td">
          {project.shared ? (
            <AccessSummary projectName={project.name} roster={roster} teamSize={teamSize} onOpen={onOpenAccess} />
          ) : (
            // A private project renders NO control here at all (spec: the
            // dead dashed cells are removed, not restyled) -- nobody else
            // can be granted access until the project is shared.
            <span className="access-private">Only you</span>
          )}
        </td>
      )}
      {/* Route on the encoded PATH, never the raw name: two projects can
          share a basename (two checkouts of "api"), and a raw name breaks
          the URL outright on '#' or '?'. ProjectPage decodes and looks up
          by path, with a name-match fallback for old links. The interpolation
          that used to live here re-typed the project path pattern, which is
          exactly what routes.ts's header rule forbids -- projectHref owns it. */}
      <td className="row-actions">
        <Link href={projectHref(project.path)} className="proj-btn">Open</Link>
        {onDelete && (
          <button
            type="button"
            className="proj-btn proj-btn-delete"
            aria-label={`Delete ${project.name}`}
            onClick={onDelete}
          >
            Delete
          </button>
        )}
      </td>
    </tr>
  )
}

/** The projects grid: one row per project and ONE Access cell per row at any
 *  team size (spec: constant-width access). Editing lives in the
 *  admin-gated AccessPopover; a member gets the same popover read-only. */
export function ProjectsPage() {
  const client = useDataClient()
  const projectsQuery = useProjects()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const [filter, setFilter] = useState('')
  const [showAddProject, setShowAddProject] = useState(false)
  // The project path whose access popover is open, or null.
  const [accessFor, setAccessFor] = useState<string | null>(null)
  // Select mode (spec section 3): a checkbox gutter plus a sticky action bar
  // whose ONLY bulk action is Archive. Delete is deliberately absent here.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkReport, setBulkReport] = useState<string | null>(null)
  const [archivedOpen, setArchivedOpen] = useState(false)
  // The single project path a delete confirmation is open for, or null.
  // Structurally one at a time: the dialog is keyed off this one path.
  const [deleteFor, setDeleteFor] = useState<string | null>(null)

  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const isTeamAdmin = role === 'owner' || role === 'admin'
  // The SAME gate the old member-column grid used -- reused, not reinvented:
  // owner/admin get live toggles in the popover, everyone else a read-only
  // roster.
  const canEditAccess = !solo && client.capabilities.teamAdminSupported && isTeamAdmin
  const showAccess = !solo
  // Task 18: the real viewer id (settings.viewerId, from GET /api/team),
  // never a hardcoded two-letter placeholder -- a sentinel like that never
  // matches a real user id, which silently disabled the self-revoke guard
  // below in production (it always compared against a string the daemon
  // never sends).
  const viewerId = settingsQuery.data?.viewerId ?? null

  const matrixQuery = useAccessMatrix(canEditAccess)
  // Names for the roster and the popover, at every role (GET /api/team/members
  // is not admin-gated the way the access matrix is).
  const membersQuery = useMembers(!solo)
  const setAccess = useSetProjectAccess()
  const syncProject = useSyncProject()
  const archiveProject = useArchiveProject()
  const unarchiveProject = useUnarchiveProject()
  const deleteProject = useDeleteProject()
  // POST /api/team/archive-project answers 200 on a REFUSAL as well as on a
  // success, and useDeleteProject turns a refusal into a rejection so no
  // success path can run for a destruction that never happened. Two very
  // different refusals arrive that way, though: "you are not a manager" (final)
  // and "we could not tell whether you are, and changed nothing" (an outage or
  // an expired sign-in -- entirely retryable). They used to render identically.
  const deleteRefusalRetryable = isRetryableDeleteRefusal(deleteProject.error)

  const projects = projectsQuery.data ?? []
  // Archived rows leave the main table and live in the collapsed section at
  // the bottom (same payload, sectioned on the flag -- never a re-fetch).
  const activeProjects = projects.filter(p => !p.archived)
  const archivedProjects = projects.filter(p => p.archived)
  const filtered = filter.trim()
    ? activeProjects.filter(p => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : activeProjects

  function exitSelectMode() {
    setSelectMode(false)
    setSelected(new Set())
    setBulkReport(null)
  }

  function toggleSelected(path: string, isSelected: boolean) {
    setSelected(prev => {
      const next = new Set(prev)
      if (isSelected) next.add(path)
      else next.delete(path)
      return next
    })
  }

  // Bulk archive is per-project and reports per-project (spec error
  // handling): a partial failure names the rows that failed and never rolls
  // back the ones that worked -- the failed rows stay selected for a retry.
  async function archiveSelected() {
    const paths = [...selected]
    if (paths.length === 0) return
    const results = await Promise.allSettled(paths.map(p => archiveProject.mutateAsync(p)))
    const failedPaths = paths.filter((_, i) => results[i].status === 'rejected')
    if (failedPaths.length === 0) {
      exitSelectMode()
      return
    }
    const names = failedPaths.map(p => projects.find(x => x.path === p)?.name ?? p)
    setBulkReport(`Archived ${paths.length - failedPaths.length} of ${paths.length}. Failed: ${names.join(', ')}.`)
    setSelected(new Set(failedPaths))
  }
  const matrixByPath = useMemo(() => {
    const map = new Map<string, AccessMatrix['rows'][number]>()
    for (const row of matrixQuery.data?.rows ?? []) map.set(row.projectPath, row)
    return map
  }, [matrixQuery.data])
  const nameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of matrixQuery.data?.members ?? []) map.set(m.id, m.name)
    for (const m of membersQuery.data ?? []) map.set(m.id, m.name)
    return map
  }, [matrixQuery.data, membersQuery.data])

  const teamSize = membersQuery.data?.length ?? matrixQuery.data?.members.length ?? 0

  // The per-project access read (GET /api/project/access), as the OWNER/ADMIN's
  // fallback for a project the matrix carries no row for. Fired only while a
  // popover is open, so it is one request for one project, triggered by the
  // user opening that cell -- never a per-project request on page load, which
  // the constant-width grid spec forbids (lib/api-access.js accessMatrix:
  // "N+1 here is a spec violation").
  //
  // ADMIN ONLY, deliberately, even though the daemon route is not role-gated
  // the way the matrix is: public.project_access's select policy is
  // `is_team_manager(team_id)` (migration 025 section 6) and RLS filters
  // instead of erroring, so a member's read returns ZERO rows and
  // readAccess's correct-for-a-manager "no row means visible" default then
  // reports the whole team as able to see the project. Calling this as a
  // member would replace the wrong count this ticket removes with a wrong
  // roster -- the popover shows them the `restricted` state instead.
  // Must sit above the blocking-error return below, hooks being hooks.
  const popoverFromMatrix = canEditAccess && !!(accessFor && matrixByPath.get(accessFor))
  const popoverAccessQuery = useProjectAccess(canEditAccess && accessFor && !popoverFromMatrix ? accessFor : null)

  // Deleting a SHARED project is manager-only on the daemon
  // (lib/server.js archiveSharedProject: a non-manager's request is REFUSED,
  // and refused only after unlinkProject has already pruned that machine's
  // durable teammate archive), so the control must not be offered to someone
  // it is going to refuse. Same gate the access popover uses, not a second
  // permission concept; a member keeps Delete on their own private projects.
  function canDeleteProject(project: Project): boolean {
    return !project.shared || canEditAccess
  }

  // A member id as {id, name}, with the viewer named "You" when no member row
  // resolves them (they left the team, or membersQuery has not landed).
  function memberRef(id: string): AccessMemberRef {
    return { id, name: nameById.get(id) ?? (id === viewerId ? 'You' : id) }
  }

  // Who can see this project -- or NULL, meaning this page cannot answer that
  // for this row.
  //
  // The only whole-grid authority is the access matrix, and it is owner/admin
  // only (lib/api-access.js accessMatrix 403s a member). This used to fall back
  // to project.recentAuthorIds, which is the distinct author set of the project's
  // slice of ONE capped /api/feed page -- so a shared project quiet enough to
  // have no entry on that page reported "0 of 5" for a project the whole team
  // could see, on the one surface whose entire job is answering "who can see
  // this". No count at all is strictly better than a wrong one. What the
  // popover can add is fetched there, per project and on demand (see
  // popoverAccessQuery above), so cost at rest is unchanged: zero extra
  // requests on load, and this page does not poll (useProjects has a staleTime,
  // not a refetchInterval).
  function rosterFor(project: Project): AccessMemberRef[] | null {
    if (!project.shared) return []
    const row = matrixByPath.get(project.path)
    if (canEditAccess && row) {
      return (matrixQuery.data?.members ?? []).filter(m => row.access[m.id]).map(m => ({ id: m.id, name: m.name }))
    }
    return null
  }

  // Full error page only for a first-load failure (no data at all); a failed
  // refetch with cached data degrades to the inline banner below instead of
  // blanking a populated grid every time the daemon hiccups mid-poll.
  const daemonError = daemonErrorOf([projectsQuery, statusQuery, settingsQuery, ...(canEditAccess ? [matrixQuery] : [])])
  if (daemonError?.blocking) {
    return (
      <div className="projects-page">
        <p className="projects-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="projects-foot">{errorMessage(daemonError.error)}</p>
      </div>
    )
  }

  // A row must not appear until its FINAL shape is known -- role gating
  // decides whether the Access cell is editable, and (for an owner/admin)
  // the matrix request is a separate fetch that starts only once role
  // gating resolves canEditAccess=true. Rendering rows earlier would flash
  // a roster that pops in a moment later.
  const ready = projectsQuery.data !== undefined && statusQuery.data !== undefined
    && settingsQuery.data !== undefined && (!canEditAccess || matrixQuery.data !== undefined)
    && (solo || membersQuery.data !== undefined)

  const sharedCount = activeProjects.filter(p => p.shared).length
  const columnCount = (showAccess ? COLUMN_COUNT : COLUMN_COUNT - 1) + (selectMode ? 1 : 0)

  const deleteTarget = deleteFor ? projects.find(p => p.path === deleteFor) ?? null : null
  const accessProject = accessFor ? projects.find(p => p.path === accessFor) ?? null : null

  // What the open popover knows. An admin's popover lists the whole team with
  // their real flags, so they can grant as well as revoke, from an
  // AUTHORITATIVE source: the matrix when it has a row for this project, the
  // per-project read above when it does not. That read's in-flight and failed
  // states are carried through as themselves rather than collapsed to an empty
  // list, which would read as "nobody can see this project". A member gets
  // `restricted`: nothing this app can call will tell them the truth (see the
  // RLS note above), so it names the boundary rather than guessing.
  function popoverRosterOf(): PopoverRoster {
    if (!canEditAccess) return { state: 'restricted' }
    const matrixRow = accessProject ? matrixByPath.get(accessProject.path) : undefined
    if (popoverFromMatrix && matrixRow) {
      return {
        state: 'known',
        members: (matrixQuery.data?.members ?? []).map(m => ({ id: m.id, name: m.name })),
        access: matrixRow.access,
      }
    }
    if (popoverAccessQuery.isError) return { state: 'error', message: errorMessage(popoverAccessQuery.error) }
    const data = popoverAccessQuery.data
    if (!data) return { state: 'loading' }
    return {
      state: 'known',
      members: data.members.map(m => memberRef(m.memberId)),
      access: Object.fromEntries(data.members.map(m => [m.memberId, m.canSee])),
    }
  }
  const popoverRoster = popoverRosterOf()

  return (
    <div className="projects-page">
      {daemonError && <DaemonErrorBanner className="projects-error" error={daemonError.error} />}
      {/* Fix 8/9: a failed access toggle rolls back optimistically (the
          hook's onError) and a failed sync changes nothing on screen -- both
          need a visible reason, mirroring setAccessDefault's message on the
          project page. */}
      {setAccess.isError && (
        <p className="projects-error" role="alert">Couldn't change access. {errorMessage(setAccess.error)}</p>
      )}
      {syncProject.isError && (
        <p className="projects-error" role="alert">Couldn't sync. {errorMessage(syncProject.error)}</p>
      )}
      {unarchiveProject.isError && (
        <p className="projects-error" role="alert">Couldn't unarchive. {errorMessage(unarchiveProject.error)}</p>
      )}
      <div className="projects-header">
        <h1 className="projects-title">Projects</h1>
        <span className="mono projects-count">{activeProjects.length} watched · {sharedCount} shared</span>
        <div className="projects-header-right">
          {/* Select mode collapses the header controls to a single Done. */}
          {selectMode ? (
            <button type="button" className="projects-btn-add" onClick={exitSelectMode}>
              Done
            </button>
          ) : (
            <>
              <input
                className="projects-search"
                placeholder="Filter projects…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                aria-label="Filter projects"
              />
              <button type="button" className="projects-btn-select" onClick={() => setSelectMode(true)}>
                Select
              </button>
              <button type="button" className="projects-btn-add" onClick={() => setShowAddProject(true)}>
                Add project
              </button>
            </>
          )}
        </div>
      </div>

      {/* No scroll-x wrapper: the column set is fixed (one Access cell instead
          of one column per member), so the table's width does not grow with
          the team. A fixed column set was never enough to keep the page from
          scrolling sideways, though -- the name and path are arbitrary-length,
          and under `table-layout: auto` their min-content sets a floor that
          `width: 100%` cannot override. projects.css bounds that; see the note
          on .projects-table for the measurements. */}
      <table className="projects-table">
        <thead>
          <tr>
            {selectMode && <th scope="col" className="select-gutter" aria-hidden="true" />}
            <th scope="col">Project</th>
            <th scope="col">Sessions · 7d</th>
            <th scope="col">Last activity</th>
            <th scope="col">Sync</th>
            {showAccess && <th scope="col">Access</th>}
            <th scope="col" aria-hidden="true" />
          </tr>
        </thead>
        <tbody>
          {!ready && (
            <tr><td className="projects-empty-note" colSpan={columnCount}>Loading…</td></tr>
          )}
          {ready && filtered.map(project => (
            <ProjectTableRow
              key={project.path}
              project={project}
              roster={rosterFor(project)}
              teamSize={teamSize}
              showAccess={showAccess}
              onSync={() => syncProject.mutate(project.path)}
              syncPending={syncProject.isPending && syncProject.variables === project.path}
              onOpenAccess={() => setAccessFor(project.path)}
              selection={selectMode ? {
                selected: selected.has(project.path),
                onToggle: isSelected => toggleSelected(project.path, isSelected),
              } : null}
              onDelete={selectMode || !canDeleteProject(project)
                ? null
                : () => { deleteProject.reset(); setDeleteFor(project.path) }}
            />
          ))}
          {ready && filtered.length === 0 && (
            <tr>
              <td className="projects-empty-note" colSpan={columnCount}>
                No projects match "{filter}".
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {ready && archivedProjects.length > 0 && (
        <section className="archived-section">
          <button
            type="button"
            className="archived-toggle"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen(open => !open)}
          >
            Archived ({archivedProjects.length})
          </button>
          {archivedOpen && (
            <ul className="archived-list">
              {archivedProjects.map(p => (
                <li key={p.path} className="archived-row" data-testid={`archived-row-${p.name}`}>
                  <span className="archived-name">{p.name}</span>
                  <span className="mono proj-path" title={p.path}>{p.path}</span>
                  {p.missing && <span className="archived-missing">folder missing</span>}
                  <button
                    type="button"
                    className="proj-btn archived-unarchive"
                    onClick={() => unarchiveProject.mutate(p.path)}
                    aria-label={`Unarchive ${p.name}`}
                  >
                    Unarchive
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {selectMode && (
        <div className="select-bar" data-testid="select-bar">
          <span className="select-count mono">{selected.size} selected</span>
          {/* The blast radius in one line, including the traced teamsync
              consequence (see archiveProject in lib/server.js): pausing via
              config.exclude also stops pulling teammates' entries. */}
          <span className="select-note">
            Archiving stops watching and new capture, and a shared project also stops receiving teammates' new activity.
            Nothing is deleted: history stays in the Feed, and Unarchive restores everything.
          </span>
          {bulkReport && <span className="select-report" role="alert">{bulkReport}</span>}
          <button type="button" className="proj-btn" onClick={exitSelectMode}>Cancel</button>
          <button
            type="button"
            className="projects-btn-add"
            disabled={selected.size === 0 || archiveProject.isPending}
            onClick={() => { void archiveSelected() }}
          >
            Archive {selected.size} projects
          </button>
        </div>
      )}
      {showAccess && canEditAccess && (
        <p className="projects-foot">
          Click a project's Access cell to change who can see it.
          Changes apply immediately; every change is recorded in the team audit trail.
        </p>
      )}
      {accessProject && (
        <AccessPopover
          projectName={accessProject.name}
          roster={popoverRoster}
          canEdit={canEditAccess}
          viewerId={viewerId}
          onToggle={(memberId, canSee) => setAccess.mutate({ projectPath: accessProject.path, memberId, canSee })}
          onClose={() => setAccessFor(null)}
        />
      )}
      {deleteTarget && (
        <ConfirmDialog
          title={`Delete ${deleteTarget.name}?`}
          message={`This permanently deletes what MemBridge holds for ${deleteTarget.name}: the .membridge/ folder (its memory and history), the MemBridge block in its context files (CLAUDE.md and AGENTS.md), and its team archive. If you only want it out of this list, Archive it instead: that destroys nothing.`}
          // "Try again" only when the daemon itself said the refusal was
          // retryable. It could not establish the caller's role -- no
          // connection, an expired sign-in -- so it changed nothing and the
          // identical delete may succeed on the next attempt. The button IS the
          // retry (the typed confirmation survives, so it is enabled already);
          // what was missing was any sign that retrying was the right move
          // rather than going to argue about a role.
          //
          // Gated on `retryable`, never on the refusal code: a determinate
          // refusal the daemon adds later must read as final here without this
          // screen being taught its name.
          confirmLabel={deleteRefusalRetryable ? 'Try again' : 'Delete project'}
          destructive
          pending={deleteProject.isPending}
          error={deleteProject.isError ? errorMessage(deleteProject.error) : null}
          errorTone={deleteRefusalRetryable ? 'retryable' : 'error'}
          confirmInput={{ requiredText: deleteTarget.name, label: 'Type the project name to confirm' }}
          onConfirm={() => deleteProject.mutate(deleteTarget.path, { onSuccess: () => setDeleteFor(null) })}
          onCancel={() => setDeleteFor(null)}
        />
      )}
      {showAddProject && <AddProjectDialog onClose={() => setShowAddProject(false)} />}
    </div>
  )
}
