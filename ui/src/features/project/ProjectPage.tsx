import { useEffect, useMemo, useState } from 'react'
import { Link } from 'wouter'
import { ROUTES, projectHref } from '../../app/routes'
import { useDataClient } from '../../data/DataClientProvider'
import { weekdayMonthDay } from '../../data/localTime'
import { collapseSessionCheckpoints } from '../../data/mappers'
import {
  useCopyForAI, useMembers, useOpenMemoryFile, useProjectAccess, useProjects, useProjectStream,
  useSetProjectAccess, useSetProjectAccessDefault, useSetProjectPaused, useSettings, useStatus, useSyncProject,
} from '../../data/queries'
import type { StreamEntry as StreamEntryData } from '../../data/types'
import { Avatar } from '../../components/Avatar'
import { DaemonErrorBanner, daemonErrorOf } from '../../components/DaemonError'
import { EntryRow } from '../../components/EntryRow'
import { SyncStateView } from '../../components/SyncState'
import { AccessPanel, type AccessRow } from './AccessPanel'
import { MemoryPanel, SyncPanel } from './SidePanels'
import './project.css'

const COPY_CONFIRMATION_MS = 2000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

// Local fields -- same fix as TodayPage's todayDateLabel: the daemon's
// timestamps are UTC, but grouping on the UTC day sorted an evening session
// into tomorrow for anyone west of Greenwich.
function dayLabel(iso: string): string {
  return weekdayMonthDay(new Date(iso))
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
  /** The :slug route param -- an encodeURIComponent'd project PATH from any
   *  link this app builds today, or a bare project name from an old
   *  name-based deep link (still resolved via the name-match fallback). */
  slug: string
}

// wouter's location handling runs decodeURI (which leaves reserved
// characters like %2F encoded) before matching, so the param needs a full
// decodeURIComponent here. An old hand-typed link can carry a raw '%' that
// makes decoding throw -- fall back to the literal segment rather than
// crashing the page.
function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug)
  } catch {
    return slug
  }
}

/** The project page: a merged team stream (left) and three ruled panels
 *  (right) — who sees this project, memory status, and sync. Matches
 *  project-v4.html. */
export function ProjectPage({ slug }: ProjectPageProps) {
  const client = useDataClient()
  const projectsQuery = useProjects()
  const statusQuery = useStatus()
  const settingsQuery = useSettings()
  const membersQuery = useMembers()

  // Look up by PATH (the unique key -- two projects can share a basename);
  // fall back to a name match so old name-based deep links keep resolving.
  const decoded = decodeSlug(slug)
  const project = projectsQuery.data?.find(p => p.path === decoded)
    ?? projectsQuery.data?.find(p => p.name === decoded)
    ?? null
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

  const memberNameById = useMemo(
    () => new Map((membersQuery.data ?? []).map(m => [m.id, m.name])),
    [membersQuery.data],
  )

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

  // Same reasoning as FeedPage: the Stop hook re-summarizes a session every
  // few edits, so this project's stream can carry several checkpoint rows
  // for one session -- collapse to each session's newest before grouping.
  const streamEntries = collapseSessionCheckpoints(streamQuery.data ?? [])
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

  // Full error page only for a first-load failure (no data at all); a failed
  // refetch with cached data degrades to the inline banner below instead of
  // blanking a populated stream every time the daemon hiccups mid-poll.
  const daemonError = daemonErrorOf([projectsQuery, statusQuery, settingsQuery, streamQuery])
  if (daemonError?.blocking) {
    return (
      <div className="project-page">
        <p className="project-error" role="alert">Couldn't reach MemBridge.</p>
        <p className="project-empty-note">{errorMessage(daemonError.error)}</p>
      </div>
    )
  }

  if (!project) {
    if (projectsQuery.isLoading) return null
    return (
      <div className="project-page">
        <Link href={ROUTES.projects} className="project-back">← Back to projects</Link>
        <p className="project-error">Project "{decoded}" not found.</p>
      </div>
    )
  }

  const copyLabel = copyStatus === 'copied' ? 'Copied' : copyStatus === 'error' ? "Couldn't copy" : 'Copy for AI'

  return (
    <div className="project-page">
      {daemonError && <DaemonErrorBanner className="project-error" error={daemonError.error} />}
      <div className="project-header">
        <Link href={ROUTES.projects} className="project-back" aria-label="Back to projects">←</Link>
        <h1 className="mono project-title">{project.name}</h1>
        <span className={`tag ${project.shared ? 'tag-team' : 'tag-private'}`}>
          {project.shared ? 'Shared' : 'Private'}
        </span>
        {/* Spec section 4: a shared project shows WHO shares it, at every
            role -- the read-only avatar stack is not gated the way the
            admin access panel is. Names resolve via getMembers(); an id
            with no member row (left the team) still gets an avatar. */}
        {project.shared && project.memberIds.length > 0 && (
          <span className="project-member-stack" data-testid="project-member-stack">
            {project.memberIds.slice(0, 4).map(id => (
              <Avatar key={id} id={id} name={memberNameById.get(id) ?? id} size={19} />
            ))}
            {project.memberIds.length > 4 && (
              <span className="project-member-more">+{project.memberIds.length - 4}</span>
            )}
          </span>
        )}
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
              {/* projectHref(project.path), not the slug this page was reached
                  by: an old name-based deep link would otherwise hand the
                  session page a `from` that resolves through the name-match
                  fallback, and the back link should point at the canonical
                  path form. */}
              {group.entries.map(entry => (
                <EntryRow key={entry.id} entry={entry} from={projectHref(project.path)} />
              ))}
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
          {/* Fix 8: useSetProjectAccess rolls its optimistic toggle back on
              failure -- without this line the toggle just snapped back with
              no explanation. Mirrors setAccessDefault's message below. */}
          {setAccess.isError && (
            <p className="project-error" role="alert">Couldn't change access. {errorMessage(setAccess.error)}</p>
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
