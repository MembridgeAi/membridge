import { describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderApp, renderWith } from '../../test/renderApp'
import { FakeDataClient } from '../../data/FakeDataClient'
import { normalizeSharePrompts } from '../../data/settingsMapper'
import { SettingsPage } from './SettingsPage'

describe('SharePromptsControl', () => {
  it('is hidden on a solo install, matching the encryption row policy', async () => {
    renderApp({ solo: true }, <SettingsPage />)
    // The Memory delivery block is our render-complete signal (it renders
    // even on solo); once it is up we know Settings is done mounting.
    await screen.findByText(/memory delivery/i)
    expect(screen.queryByTestId('setting-share-prompts')).toBeNull()
  })

  it('shows three options in wire order (off, distilled, verbatim), with one plain sentence each', async () => {
    renderApp({ sharePrompts: 'off' }, <SettingsPage />)
    const row = await screen.findByTestId('setting-share-prompts')
    const radios = within(row).getAllByRole('radio')
    expect(radios.map(r => r.getAttribute('value'))).toEqual(['off', 'distilled', 'verbatim'])
    expect(within(row).getByText(/prompts and agent summaries stay on your machine/i)).toBeInTheDocument()
    expect(within(row).getByText(/agent's short intent summary/i)).toBeInTheDocument()
    expect(within(row).getByText(/raw text of every prompt/i)).toBeInTheDocument()
  })

  it('links to the redaction-boundary doc rather than rendering it inline', async () => {
    renderApp({ sharePrompts: 'verbatim' }, <SettingsPage />)
    const row = await screen.findByTestId('setting-share-prompts')
    const link = within(row).getByRole('link', { name: /what is redacted/i })
    expect(link).toHaveAttribute('href', expect.stringContaining('redaction-boundary'))
  })

  it('reflects the current setting as SELECTED', async () => {
    renderApp({ sharePrompts: 'distilled' }, <SettingsPage />)
    const row = await screen.findByTestId('setting-share-prompts')
    const distilled = within(row).getByRole('radio', { name: /distilled/i })
    expect(distilled).toBeChecked()
    const off = within(row).getByRole('radio', { name: /^off$/i })
    const verbatim = within(row).getByRole('radio', { name: /verbatim/i })
    expect(off).not.toBeChecked()
    expect(verbatim).not.toBeChecked()
  })

  // The audit-trail case. The daemon normalizes legacy `sharePrompts: true`
  // to the string 'verbatim' on /api/settings, and the client-side
  // normalizer accepts a raw boolean too (for the rollout window). Either
  // way the row has to READ as Verbatim, so a user who opted into raw
  // sharing under the boolean regime does not silently show as "Off".
  it('normalizes legacy sharePrompts:true to Verbatim SELECTED', async () => {
    // Client-side: prove the normalizer itself (the boolean-input path).
    expect(normalizeSharePrompts(true)).toBe('verbatim')
    expect(normalizeSharePrompts(false)).toBe('off')

    // End-to-end: what the row actually renders once the mapping is
    // applied. FakeDataClient models an already-normalized payload (see
    // settingsPayload.team.sharePrompts), which is what the real daemon
    // sends -- so passing 'verbatim' here is the SAME state a legacy
    // machine's server-side normalization produces.
    renderApp({ sharePrompts: 'verbatim' }, <SettingsPage />)
    const row = await screen.findByTestId('setting-share-prompts')
    const verbatim = within(row).getByRole('radio', { name: /verbatim/i })
    expect(verbatim).toBeChecked()
  })

  it('writes the string form to the daemon, never a boolean', async () => {
    const client = new FakeDataClient({ sharePrompts: 'off' })
    const spy = vi.spyOn(client, 'setSetting')
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-share-prompts')
    await userEvent.click(within(row).getByRole('radio', { name: /distilled/i }))
    await waitFor(() => expect(spy).toHaveBeenCalled())
    // The whole assertion. If a future refactor sends `{team: {sharePrompts: true}}`
    // for backwards-compatibility with an older daemon, this test fails --
    // the wire contract is the three-value string, and the client must
    // never fall back to the boolean shape it deliberately left behind.
    expect(spy).toHaveBeenCalledWith('team', { sharePrompts: 'distilled' })
  })

  it('names the row that failed when the write is refused, and rolls the selection back', async () => {
    const client = new FakeDataClient({ sharePrompts: 'off' })
    vi.spyOn(client, 'setSetting').mockRejectedValue(new Error('backend rejected: bad value'))
    renderWith(client, <SettingsPage />)
    const row = await screen.findByTestId('setting-share-prompts')
    const verbatim = within(row).getByRole('radio', { name: /verbatim/i })
    await userEvent.click(verbatim)
    // The error surfaces on THIS row, naming Share prompts specifically.
    // (The Settings page's group-wide error banner was retired precisely
    // because it could not say WHICH control had failed.)
    expect(await within(row).findByText(/couldn't change share prompts/i)).toBeInTheDocument()
    // And the visible selection has snapped back to the last authoritative
    // value ('off'), so a rejected save does not leave the radio one click
    // ahead of the daemon.
    await waitFor(() => {
      expect(within(row).getByRole('radio', { name: /^off$/i })).toBeChecked()
    })
  })
})
