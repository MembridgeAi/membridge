import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { BriefWidgets } from './BriefWidgets'
import type { Session } from '../../data/types'

const session = (overrides: Partial<Session> = {}): Session => ({
  session: 's1', project: 'membridge', projectPath: '/x/membridge',
  author: 'Andrew', authorId: 'andrew', source: 'Claude Code',
  startedAt: '2026-07-29T19:00:00Z', endedAt: '2026-07-29T20:30:00Z', live: false,
  summary: 'done', summaryFull: 'done', goal: null, headline: null,
  decisions: 'Durability beats recency because a crashed run must not steal the hook.',
  gotchas: 'settings.json rewrites drop unknown keys, so merge before writing.',
  files: ['lib/hooks.js', 'test/run-tests.js'],
  changes: [
    { file: 'lib/hooks.js', status: 'edited', add: 41, del: 12, note: 'ownership gate', dep: false },
    { file: 'test/run-tests.js', status: 'edited', add: 88, del: 2, note: null, dep: false },
  ],
  checkpoints: [
    { ts: '2026-07-29T19:40:00Z', text: 'Gate extracted; stop path green.' },
    { ts: '2026-07-29T20:30:00Z', text: 'Hook ownership decided by durability.' },
  ],
  prompts: [],
  ...overrides,
})

function widgetTitles(): string[] {
  return [...document.querySelectorAll('details.session-widget summary .session-widget-title')]
    .map(el => el.textContent || '')
}

describe('BriefWidgets (Task 4)', () => {
  // Files lead. The reader's first question about a teammate's session is what
  // it touched, and that answer used to sit below two paragraphs of prose.
  // "Why" and "Watch out" are one widget now, titled "What": they were always
  // read together, and two open paragraphs stacked above the file list is the
  // wall this page exists to avoid.
  it('renders the widgets in the locked fixed order, files first', () => {
    render(<BriefWidgets session={session()} />)
    expect(widgetTitles()).toEqual(['Key files', 'Changes', 'What'])
  })

  it('Key files and What are open by default; the full Changes list is closed', () => {
    render(<BriefWidgets session={session()} />)
    const details = [...document.querySelectorAll('details.session-widget')] as HTMLDetailsElement[]
    expect(details.map(d => d.open)).toEqual([true, false, true])
  })

  it('What merges decisions and gotchas into one bulleted list', () => {
    render(<BriefWidgets session={session()} />)
    const what = screen.getByText('What').closest('details')!
    const bullets = [...what.querySelectorAll('li')].map(li => li.textContent)
    expect(bullets).toEqual([
      'Durability beats recency because a crashed run must not steal the hook.',
      'settings.json rewrites drop unknown keys, so merge before writing.',
    ])
    // The old two-widget shape is gone, not merely reordered.
    expect(screen.queryByText('Why')).toBeNull()
    expect(screen.queryByText('Watch out')).toBeNull()
  })

  it('a widget with no captured content is ABSENT from the DOM -- no placeholder row', () => {
    render(<BriefWidgets session={session({ decisions: null, gotchas: null, checkpoints: [] })} />)
    expect(screen.queryByText('What')).toBeNull()
    expect(screen.queryByText('Checkpoints')).toBeNull()
    expect(screen.queryByText(/not captured/i)).toBeNull()
    expect(widgetTitles()).toEqual(['Key files', 'Changes'])
  })

  it('Key files renders only changes entries carrying a note; no noted entry means no widget', () => {
    render(<BriefWidgets session={session()} />)
    const keyFiles = screen.getByText('Key files').closest('details')!
    expect(keyFiles.textContent).toContain('lib/hooks.js')
    expect(keyFiles.textContent).toContain('ownership gate')
    expect(keyFiles.textContent).not.toContain('test/run-tests.js')

    document.body.innerHTML = ''
    render(<BriefWidgets session={session({
      changes: [{ file: 'a.js', status: 'edited', add: 1, del: 1, note: null, dep: false }],
    })} />)
    expect(screen.queryByText('Key files')).toBeNull()
    // ...while the Changes widget still renders for the same session.
    expect(screen.queryByText('Changes')).not.toBeNull()
  })

  it('Changes renders +add -del per file', () => {
    render(<BriefWidgets session={session()} />)
    const changes = screen.getByText('Changes').closest('details')!
    expect(changes.textContent).toContain('lib/hooks.js')
    expect(changes.textContent).toContain('+41')
    expect(changes.textContent).toContain('-12')
    expect(changes.textContent).toContain('test/run-tests.js')
    expect(changes.textContent).toContain('+88')
    expect(changes.textContent).toContain('-2')
  })

  // The checkpoint trail is the page's distilled bullet list now (distill.ts),
  // and the prompt chain renders each checkpoint against the prompt it
  // followed. A third copy here was duplication, so the widget is gone.
  it('does not render a Checkpoints widget, even for a session with a full trail', () => {
    render(<BriefWidgets session={session()} />)
    expect(screen.queryByText('Checkpoints')).toBeNull()
    expect(document.querySelector('.session-checkpoint-text')).toBeNull()
  })

  it('a closed widget summary row carries a one-line truncated peek', () => {
    render(<BriefWidgets session={session()} />)
    const changes = screen.getByText('Changes').closest('details')!
    const peek = changes.querySelector('summary .session-widget-peek')
    expect(peek).not.toBeNull()
    expect(peek!.textContent).toMatch(/lib\/hooks\.js/)
    // Open widgets carry no peek -- there is nothing to preview.
    const what = screen.getByText('What').closest('details')!
    expect(what.querySelector('summary .session-widget-peek')).toBeNull()
  })

  // Grouping engages at >=4 total points across >=2 distinct areas
  // (distill.ts GROUP_MIN_POINTS / GROUP_MIN_AREAS). This fixture has 4
  // points across 2 areas (UI/UX, Backend), clearing both thresholds.
  it('heads each area group once the list clears the grouping threshold', () => {
    render(<BriefWidgets session={session({
      decisions: '[UI/UX] Removed the menu item\n[UI/UX] Renamed the tab',
      gotchas: '[Backend] Raised the rate limit\n[Backend] Cached the lookup',
    })} />)
    expect(screen.getAllByTestId('what-area').map(n => n.textContent)).toEqual(['UI/UX', 'Backend'])
    // The raw prefix must never reach the reader.
    expect(screen.queryByText(/\[UI\/UX\]/)).toBeNull()
  })

  it('heads nothing when the list is flat', () => {
    render(<BriefWidgets session={session({ decisions: '[UI/UX] One\n[Backend] Two', gotchas: null })} />)
    expect(screen.queryAllByTestId('what-area')).toHaveLength(0)
    expect(screen.getByText('One')).toBeTruthy()
  })
})
