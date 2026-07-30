import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { ROUTES } from '../../app/routes'
import { useDataClient } from '../../data/DataClientProvider'
import {
  useCopyForAI, useMembers, useOpenMemoryFile, useProjectAccess, useProjects, useProjectStream,
  useSetProjectAccess, useSetProjectAccessDefault, useSetProjectPaused, useSettings, useStatus, useSyncProject,
} from '../../data/queries'
import type { StreamEntry as StreamEntryData } from '../../data/types'
import { SyncStateView } from '../../components/SyncState'
import { AccessPanel, type AccessRow } from './AccessPanel'
import { MemoryPanel, SyncPanel } from './SidePanels'
import { StreamEntry } from './StreamEntry'
import './project.css'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const COPY_CONFIRMATION_MS = 2000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// UTC fields -- same reasoning as TodayPage's todayDateLabel: the daemon's
// timestamps are UTC, so a local-time render could sort an entry into the
// wrong calendar day depending on where the app runs.
function dayLabel(iso: string): string {
  const d = new Date(iso)
  return `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
}

interface DayGroup {
  day: string
  entries: StreamEntryData[]
}

// Newest first, then bucketed into consecutive same-day runs -- the stream
// isn't guaranteed sorted by the API, so this sorts before grouping rather
// than trusting entry order.
function groupByDay(entries: StreamEntryData[]): DayGroup[] {
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at))
  const groups: DayGroup[] = []
  for (const entry of sorted) {
    const day = dayLabel(entry.at)
    const current = groups[groups.length - 1]
    if (current && current.day === day) current.entries.push(entry)
    else groups.push({ day, entries: [entry] })
  }
  return groups
}

interface ProjectPageProps {
  name: string
}

/** The project page: a merged team stream (left) and three ruled panels
 *  (right) — who sees this project, memory status, and sync. Matches
 *  project-v4.html. */
export function ProjectPage({ name }: ProjectPageProps) {
  const client = useDataClient()
  const projectsQuery = useProjects()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const membersQuery = useMembers()

  const project = projectsQuery.data?.find(p => p.name === name) ?? null
  const streamQuery = useProjectStream(project?.path ?? null)

  const solo = statusQuery.data?.solo ?? true
  const role = settingsQuery.data?.team?.role ?? null
  const isTeamAdmin = role === 'owner' || role === 'admin'
  // Reading access for a project that isn't shared 404s on the real daemon
  // (api-access.js readAccess -> requireLink), and a member role 403s the
  // matrix elsewhere in this app for the same reason access is manager-only
  // -- so this only fires once both conditions are actually true.
  const showAccessPanel = !solo && client.capabilities.teamAdminSupported && isTeamAdmin && !!project?.shared
  const accessQuery = useProjectAccess(showAccessPanel && project ? project.path : null)

  const setAccess = useSetProjectAccess()
  const setAccessDefault = useSetProjectAccessDefault()
  const setPaused = useSetProjectPaused()
  const syncProject = useSyncProject()
  const copyForAI = useCopyForAI()
  const openMemory = useOpenMemoryFile()
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle')

  useEffect(() => {
    if (copyStatus === 'idle') return
    const id = setTimeout(() => setCopyStatus('idle'), COPY_CONFIRMATION_MS)
    return () => clearTimeout(id)
  }, [copyStatus])

  const accessRows: AccessRow[] = useMemo(() => {
    if (!accessQuery.data || !membersQuery.data) return []
    const membersById = new Map(membersQuery.data.map(m => [m.id, m]))
    const rows: AccessRow[] = []
    for (const a of accessQuery.data.members) {
      const member = membersById.get(a.memberId)
      if (member) rows.push({ id: member.id, name: member.name, role: member.role, canSee: a.canSee })
    }
    return rows
  }, [accessQuery.data, membersQuery.data])

  const streamEntries = streamQuery.data ?? []
  const dayGroups = groupByDay(streamEntries)
  const latestEntry = dayGroups[0]?.entries[0] ?? null

  async function handleCopy() {
    if (!project) return
    try {
      const text = await copyForAI.mutateAsync(project.path)
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      setCopyStatus('copied')
    } catch {
      setCopyStatus('error')
    }
  }

  function handleTogglePause() {
    if (project) setPaused.mutate({ projectPath: project.path, paused: !project.paused })
  }

  function handleSync() {
    if (project) syncProject.mutate(project.path)
  }

  const hasError = projectsQuery.isError || statusQuery.isError || settingsQuery.isError || streamQuery.isError
  if (hasError) {
    const message = errorMessage(projectsQuery.error ?? statusQuery.error ?? settingsQuery.error ?? streamQuery.error)
    return (
      <div className="project-page">
        <p className="project-error" role="alert">Couldn't reach the daemon. {message}</p>
      </div>
    )
  }

  if (!project) {
    if (projectsQuery.isLoading) return null
    return (
      <div className="project-page">
        <Link href={ROUTES.projects} className="project-back">← Back to projects</Link>
        <p className="project-error">Project "{name}" not found.</p>
      </div>
    )
  }

  const copyLabel = copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? "Couldn't copy" : 'Copy for AI'

  return (
    <div className="project-page">
      <div className="project-header">
        <Link href={ROUTES.projects} className="project-back" aria-label="Back to projects">←</Link>
        <h1 className="mono project-title">{project.name}</h1>
        <span className={`tag ${project.shared ? 'tag-team' : 'tag-private'}`}>
          {project.shared ? 'Shared' : 'Private'}
        </span>
        <SyncStateView state={project.sync} />
        <div className="project-header-actions">
          <button type="button" className="project-btn project-btn-ghost" onClick={handleCopy} disabled={copyForAI.isPending}>
            {copyLabel}
          </button>
          <button type="button" className="project-btn project-btn-ghost" onClick={handleTogglePause} disabled={setPaused.isPending}>
            {project.paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="project-btn project-btn-primary" onClick={handleSync} disabled={syncProject.isPending}>
            Sync now
          </button>
        </div>
      </div>

      <div className="project-cols">
        <div className="project-stream">
          {dayGroups.length === 0 && <p className="project-empty-note">No activity captured yet.</p>}
          {dayGroups.map(group => (
            <div key={group.day}>
              <div className="project-day">{group.day}</div>
              {group.entries.map(entry => <StreamEntry key={entry.id} entry={entry} />)}
            </div>
          ))}
        </div>

        <div className="project-side">
          {showAccessPanel && accessRows.length > 0 && (
            <AccessPanel
              rows={accessRows}
              defaultAccess={accessQuery.data?.defaultAccess ?? true}
              onToggle={(memberId, canSee) => setAccess.mutate({ projectPath: project.path, memberId, canSee })}
              onToggleDefault={next => setAccessDefault.mutate({ projectPath: project.path, defaultAccess: next })}
            />
          )}
          {setAccessDefault.isError && (
            <p className="project-error" role="alert">Couldn't save the default. {errorMessage(setAccessDefault.error)}</p>
          )}
          <MemoryPanel
            project={project}
            latestEntry={latestEntry}
            onOpenMemory={() => openMemory.mutate(project.path)}
            openPending={openMemory.isPending}
          />
          {openMemory.isError && (
            <p className="project-error" role="alert">Couldn't open memory.md. {errorMessage(openMemory.error)}</p>
          )}
          {/* No onSync here: the header's own persistent "Sync now" button
              (above) is this page's one manual-sync trigger. A second
              embedded button in this row, calling the same mutation, would
              just be a redundant control next to the first. */}
          <SyncPanel
            sync={project.sync}
            encryptionEnabled={statusQuery.data?.encryption.enabled ?? false}
            plaintextOff={statusQuery.data?.encryption.plaintextOff ?? false}
            sessionsThisWeek={project.sessionsThisWeek}
            peopleCount={project.memberIds.length}
          />
        </div>
      </div>
    </div>
  )
}
