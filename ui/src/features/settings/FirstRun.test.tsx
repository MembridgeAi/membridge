import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { FirstRun } from './FirstRun'

describe('FirstRun', () => {
  it('describes what MemBridge will watch, using the real detected tools', async () => {
    renderApp({}, <FirstRun />)
    expect(await screen.findByText(/Claude Code and Codex/)).toBeInTheDocument()
  })

  it('says nothing about teams', async () => {
    renderApp({}, <FirstRun />)
    await screen.findByText('Welcome to MemBridge')
    expect(screen.queryByText(/team/i)).toBeNull()
  })

  it('offers a real summaries opt-in toggle, wired to setSetting', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const setSpy = vi.spyOn(client, 'setSetting')
    renderWith(client, <FirstRun />)
    const toggle = await screen.findByRole('switch', { name: 'Session summaries' })
    await user.click(toggle)
    expect(setSpy).toHaveBeenCalledWith('distill', { enabled: false })
  })

  it('finishing calls setSetting with a real completion timestamp', async () => {
    const user = userEvent.setup()
    const client = new FakeDataClient()
    const setSpy = vi.spyOn(client, 'setSetting')
    renderWith(client, <FirstRun />)
    await user.click(await screen.findByRole('button', { name: /get started/i }))
    expect(setSpy).toHaveBeenCalledWith('setupCompletedAt', expect.any(String))
  })

  // Settings honesty finding: this screen SHOWED the summaries switch as on
  // (`summaries?.enabled ?? true` -- an assumption whenever the daemon has
  // not reported a choice) while "Get started" wrote only setupCompletedAt.
  // A user who read the consent, left the switch alone and pressed the button
  // had agreed to something nothing recorded.
  describe('summaries consent', () => {
    it('records the consent it displayed, not just the completion stamp', async () => {
      const client = new FakeDataClient()
      const base = await client.getSettings()
      // The daemon has reported nothing about this channel, so ON is purely
      // the screen's own default -- exactly the case that used to go
      // unrecorded.
      vi.spyOn(client, 'getSettings').mockResolvedValue({
        ...base,
        delivery: base.delivery.map(c => c.id === 'summaries' ? { ...c, enabled: null } : c),
      })
      const setSpy = vi.spyOn(client, 'setSetting')
      renderWith(client, <FirstRun />)
      expect(await screen.findByRole('switch', { name: 'Session summaries' })).toHaveAttribute('aria-checked', 'true')
      await userEvent.click(screen.getByRole('button', { name: /get started/i }))
      await waitFor(() => expect(setSpy).toHaveBeenCalledWith('distill', { enabled: true }))
      expect(setSpy).toHaveBeenCalledWith('setupCompletedAt', expect.any(String))
    })

    it('records the OFF choice when that is what the screen is showing', async () => {
      const client = new FakeDataClient()
      const base = await client.getSettings()
      vi.spyOn(client, 'getSettings').mockResolvedValue({
        ...base,
        delivery: base.delivery.map(c => c.id === 'summaries' ? { ...c, enabled: false } : c),
      })
      const setSpy = vi.spyOn(client, 'setSetting')
      renderWith(client, <FirstRun />)
      await screen.findByRole('button', { name: /get started/i })
      await userEvent.click(screen.getByRole('button', { name: /get started/i }))
      await waitFor(() => expect(setSpy).toHaveBeenCalledWith('distill', { enabled: false }))
    })

    // Setup must not complete over a consent write the daemon refused --
    // App.tsx takes this takeover down on setupDone, so that is the last
    // moment the failure can be seen at all.
    it('does not complete setup when the consent write is refused', async () => {
      const client = new FakeDataClient()
      const setSpy = vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('consent write rejected'))
      renderWith(client, <FirstRun />)
      await userEvent.click(await screen.findByRole('button', { name: /get started/i }))
      expect(await screen.findByText(/consent write rejected/i)).toBeInTheDocument()
      expect(setSpy).toHaveBeenCalledWith('distill', { enabled: true })
      expect(setSpy).not.toHaveBeenCalledWith('setupCompletedAt', expect.any(String))
    })
  })

  it('surfaces a load failure instead of rendering a blank page', async () => {
    renderApp({ failWith: 'daemon unreachable' }, <FirstRun />)
    expect(await screen.findByText(/couldn't reach/i)).toBeInTheDocument()
  })

  // Part B finding: a rejected setSetting write here used to look identical
  // to a successful one -- the toggle silently reverted next render (or
  // "Get started" silently did nothing) with no explanation.
  it('surfaces a failed summaries toggle instead of silently reverting', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('write rejected'))
    renderWith(client, <FirstRun />)
    const toggle = await screen.findByRole('switch', { name: 'Session summaries' })
    await userEvent.click(toggle)
    expect(await screen.findByText(/write rejected/i)).toBeInTheDocument()
  })

  it('surfaces a failed "Get started" instead of silently doing nothing', async () => {
    const client = new FakeDataClient()
    vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('setup save rejected'))
    renderWith(client, <FirstRun />)
    await userEvent.click(await screen.findByRole('button', { name: /get started/i }))
    expect(await screen.findByText(/setup save rejected/i)).toBeInTheDocument()
  })

  // "Get started" writes setupCompletedAt and then waits for ['status'] to
  // come back with setupDone:true before App.tsx swaps this screen out. That
  // is a real round trip on a cold daemon, and with a button whose label
  // never changed the screen looked frozen -- the same "silently did
  // nothing" complaint the error banner above exists for, just with a slow
  // write instead of a rejected one. The mutation already tracks isPending;
  // the label only has to say so.
  it('says the write is in flight instead of looking frozen', async () => {
    const client = new FakeDataClient()
    // Deliberately never resolves: pending is the state under test, so the
    // write must not be allowed to finish and end it.
    vi.spyOn(client, 'setSetting').mockReturnValue(new Promise<void>(() => {}))
    renderWith(client, <FirstRun />)
    await userEvent.click(await screen.findByRole('button', { name: /get started/i }))
    expect(await screen.findByRole('button', { name: /saving/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^get started$/i })).toBeNull()
  })
})
