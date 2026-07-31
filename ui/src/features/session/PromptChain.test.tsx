import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PromptChain } from './PromptChain'
import type { SessionCheckpoint, SessionPrompt } from '../../data/types'

// Newest-first, like the daemon sends: count prompts back from the base, one
// per minute.
function chain(count: number, base = Date.parse('2026-07-29T20:00:00Z')): SessionPrompt[] {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(base - i * 60_000).toISOString(),
    ask: `prompt ${count - i}`,
    files: [],
  }))
}

function renderedRows(): HTMLElement[] {
  return [...document.querySelectorAll('.session-prompt')] as HTMLElement[]
}

describe('PromptChain (Task 5)', () => {
  it('renders prompts newest-first, judged by the rendered times', () => {
    // Suite TZ is pinned to America/Los_Angeles: 20:00Z = 1:00 PM, 19:58Z = 12:58 PM.
    render(<PromptChain prompts={chain(3)} checkpoints={[]} />)
    const times = renderedRows().map(r => r.querySelector('.session-prompt-time')!.textContent)
    expect(times).toEqual(['1:00 PM', '12:59 PM', '12:58 PM'])
  })

  it('a 60-prompt session renders exactly 5 rows on first paint', () => {
    render(<PromptChain prompts={chain(60)} checkpoints={[]} />)
    expect(renderedRows()).toHaveLength(5)
    expect(screen.getByText('prompt 60')).toBeInTheDocument()
    expect(screen.queryByText('prompt 55')).toBeNull()
  })

  it('Show older prompts reveals 25 more per press and disappears at the end', () => {
    render(<PromptChain prompts={chain(60)} checkpoints={[]} />)
    const button = screen.getByRole('button', { name: /show older prompts/i })
    fireEvent.click(button)
    expect(renderedRows()).toHaveLength(30)
    fireEvent.click(button)
    expect(renderedRows()).toHaveLength(55)
    fireEvent.click(button)
    expect(renderedRows()).toHaveLength(60)
    expect(screen.queryByRole('button', { name: /show older prompts/i })).toBeNull()
  })

  it('no button at all when the chain fits in the first page', () => {
    render(<PromptChain prompts={chain(5)} checkpoints={[]} />)
    expect(screen.queryByRole('button', { name: /show older prompts/i })).toBeNull()
  })

  it('a checkpoint renders beneath the prompt it followed', () => {
    const prompts: SessionPrompt[] = [
      { ts: '2026-07-29T20:00:00Z', ask: 'second ask', files: [] },
      { ts: '2026-07-29T19:00:00Z', ask: 'first ask', files: [] },
    ]
    const checkpoints: SessionCheckpoint[] = [
      { ts: '2026-07-29T19:30:00Z', text: 'landed after the first ask' },
    ]
    render(<PromptChain prompts={prompts} checkpoints={checkpoints} />)
    const rows = renderedRows()
    expect(rows[1].textContent).toContain('first ask')
    expect(rows[1].textContent).toContain('landed after the first ask')
    expect(rows[0].textContent).not.toContain('landed after the first ask')
  })

  it('an unshared prompt renders the placeholder, supplied by the renderer not the data', () => {
    const prompts: SessionPrompt[] = [
      { ts: '2026-07-29T20:00:00Z', ask: null, files: ['src/login.js'] },
    ]
    render(<PromptChain prompts={prompts} checkpoints={[]} />)
    expect(screen.getByText('(prompt not shared)')).toBeInTheDocument()
    expect(screen.getByText('src/login.js')).toBeInTheDocument()
  })

  it('per-prompt files render as mono chips', () => {
    const prompts: SessionPrompt[] = [
      { ts: '2026-07-29T20:00:00Z', ask: 'wire it up', files: ['lib/hooks.js', 'test/run-tests.js'] },
    ]
    render(<PromptChain prompts={prompts} checkpoints={[]} />)
    expect(screen.getByText('lib/hooks.js')).toBeInTheDocument()
    expect(screen.getByText('test/run-tests.js')).toBeInTheDocument()
  })
})
