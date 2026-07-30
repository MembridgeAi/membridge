import { useMemo, useState } from 'react'
import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { Avatar } from '../../components/Avatar'
import { SyncStateView } from '../../components/SyncState'
import { useDataClient } from '../../data/DataClientProvider'
import { useAccessMatrix, useProjects, useSetProjectAccess, useSettings, useStatus, useSyncProject } from '../../data/queries'
import type { AccessMatrix, Project } from '../../data/types'
import { AccessCell } from './AccessCell'
import './projects.css'

// The daemon has no endpoint today that tells the client which team-member
// row is "you" (team_members_list returns every member's real id, with no
// self flag) -- but every other DataClient method in this app already
// reserves the literal id 'me' for the viewer (getMembers, getProjectAccess,
// getLiveSessions, Project.memberIds). Matching that convention here is the
// only way to mark a self column/cell at all; it degrades safely if a real
// backend ever uses different ids -- self simply never gets flagged, so
// those cells fall back to being treated like any other member's.
const VIEWER_ID = 'me'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function relativeTime(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface ProjectTableRowProps {
  project: Project
  matrixRow: AccessMatrix['rows'][number] | undefined
  members: AccessMatrix['members']
  showMatrix: boolean
  showSelfColumn: boolean
  onSync: () => void
  onToggleAccess: (memberId: string, canSee: boolean) => void
}

function ProjectTableRow({ project, matrixRow, members, showMatrix, showSelfColumn, onSync, onToggleAccess }: ProjectTableRowProps) {
  return (
    <tr data-testid={`project-row-${project.name}`}>
      <td className="proj-name">
        {project.name} <span className={`tag ${project.shared ? 'tag-team' : 'tag-private'}`}>{project.shared ? 'Shared' : 'Private'}</span>
        <span className="mono proj-path">{project.path}</span>
      </td>
      <td className="mono num">{project.sessionsThisWeek}</td>
      <td className="mono num">{relativeTime(project.lastActivity)}</td>
      <td><SyncStateView state={project.sync} onSync={project.sync.state === 'behind' ? onSync : undefined} /></td>
      {showMatrix && members.map(member => (
        <td className="who" key={member.id}>
          <AccessCell
            memberName={member.name}
            checked={matrixRow?.access[member.id] ?? false}
            disabled={!project.shared || member.id === VIEWER_ID}
            isSelf={member.id === VIEWER_ID}
            onToggle={checked => onToggleAccess(member.id, checked)}
          />
        </td>
      ))}
      {showSelfColumn && (
        <td className="who">
          {/* A member's own visibility isn't editable from this grid (the
              write endpoint is manager-only and 403s for a member anyway),
              and it's trivially true -- getProjects() already only returns
              projects this viewer can see. */}
          <AccessCell memberName="You" checked disabled isSelf onToggle={() => {}} />
        </td>
      )}
      <td><Link href={`${ROUTES.projects}/${project.name}`} className="proj-btn">Open</Link></td>
    </tr>
  )
}

/** The projects grid: one row per project, one column per member for an
 *  owner/admin (bulk access editing), or a single "You" column for a member.
 *  Matches projects-list-v2.html. */
export function ProjectsPage() {
  const client = useDataClient()
  const projectsQuery = useProjects()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const [filter, setFilter] = useState('')

  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const isTeamAdmin = role === 'owner' || role === 'admin'
  const showMatrix = !solo && client.capabilities.teamAdminSupported && isTeamAdmin
  const showSelfColumn = !solo && !showMatrix

  const matrixQuery = useAccessMatrix(showMatrix)
  const setAccess = useSetProjectAccess()
  const syncProject = useSyncProject()

  const projects = projectsQuery.data ?? []
  const filtered = filter.trim()
    ? projects.filter(p => p.name.toLowerCase().includes(filter.trim().toLowerCase()))
    : projects
  const members = matrixQuery.data?.members ?? []
  const matrixByPath = useMemo(() => {
    const map = new Map<string, AccessMatrix['rows'][number]>()
    for (const row of matrixQuery.data?.rows ?? []) map.set(row.projectPath, row)
    return map
  }, [matrixQuery.data])

  const hasError = projectsQuery.isError || statusQuery.isError || settingsQuery.isError || (showMatrix && matrixQuery.isError)
  if (hasError) {
    const message = errorMessage(projectsQuery.error ?? statusQuery.error ?? settingsQuery.error ?? matrixQuery.error)
    return (
      <div className="projects-page">
        <p className="projects-error" role="alert">Couldn't reach the daemon. {message}</p>
      </div>
    )
  }

  // A row must not appear until its FINAL shape is known -- role gating
  // decides whether it gets member columns at all, and (for an owner/admin)
  // the matrix request is a separate fetch that starts only once role
  // gating resolves showMatrix=true. Rendering rows earlier would flash a
  // row with no access columns and then pop them in a moment later.
  const ready = projectsQuery.data !== undefined && statusQuery.data !== undefined
    && settingsQuery.data !== undefined && (!showMatrix || matrixQuery.data !== undefined)

  const sharedCount = projects.filter(p => p.shared).length
  const columnCount = 5 + (showMatrix ? members.length : showSelfColumn ? 1 : 0)

  return (
    <div className="projects-page">
      <div className="projects-header">
        <h1 className="projects-title">Projects</h1>
        <span className="mono projects-count">{projects.length} watched · {sharedCount} shared</span>
        <div className="projects-header-right">
          <input
            className="projects-search"
            placeholder="Filter projects…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            aria-label="Filter projects"
          />
        </div>
      </div>

      <div className="scroll-x" data-testid="projects-scroll">
        <table className="projects-table">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Sessions · 7d</th>
              <th scope="col">Last activity</th>
              <th scope="col">Sync</th>
              {showMatrix && members.map(member => (
                <th className="who" key={member.id} scope="col">
                  <Avatar id={member.id} name={member.name} size={19} />
                </th>
              ))}
              {showSelfColumn && (
                <th className="who" scope="col">
                  <Avatar id={VIEWER_ID} name="You" size={19} />
                </th>
              )}
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
                matrixRow={matrixByPath.get(project.path)}
                members={members}
                showMatrix={showMatrix}
                showSelfColumn={showSelfColumn}
                onSync={() => syncProject.mutate(project.path)}
                onToggleAccess={(memberId, canSee) => setAccess.mutate({ projectPath: project.path, memberId, canSee })}
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
      </div>
      {showMatrix && (
        <p className="projects-foot">
          Dashed boxes are private projects — nobody else can be given access until you share the project.
          Changes apply immediately; every change is recorded in the team audit trail.
        </p>
      )}
    </div>
  )
}
