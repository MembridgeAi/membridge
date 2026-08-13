import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import { IdentityDialog } from './IdentityDialog'

function renderDialog(client = new FakeDataClient({})) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>
        <IdentityDialog currentName="marco" currentAvatar={null} currentAvatarColor={null}
                        viewerId="u1" onClose={() => {}} />
      </DataClientProvider>
    </QueryClientProvider>,
  )
}

afterEach(cleanup)

describe('IdentityDialog', () => {
  it('opens with the current name already in the field', async () => {
    renderDialog()
    expect(await screen.findByLabelText(/display name/i)).toHaveValue('marco')
  })

  it('refuses to save an empty name without calling the client', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.clear(await screen.findByLabelText(/display name/i))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and shows the reason when the name is taken', async () => {
    const client = new FakeDataClient({})
    vi.spyOn(client, 'setDisplayName').mockRejectedValue(
      new Error('somebody on Acme is already called nina'))
    renderDialog(client)
    await userEvent.clear(await screen.findByLabelText(/display name/i))
    await userEvent.type(screen.getByLabelText(/display name/i), 'nina')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already called nina/)
    // The typed text survives, so the person edits rather than retypes.
    expect(screen.getByLabelText(/display name/i)).toHaveValue('nina')
  })

  // Shape and colour are INDEPENDENT choices (AvatarGlyph.tsx's header states
  // this) -- picking one must not reset the other.
  it('sends the chosen glyph and colour together', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.click(await screen.findByRole('radio', { name: 'halo' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Colour 2' }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).toHaveBeenCalledWith('marco', 'halo', '#22C08F')
  })

  it('sends nulls when the initial and the derived colour are chosen', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.click(await screen.findByRole('radio', { name: 'halo' }))
    await userEvent.click(screen.getByRole('radio', { name: /^Initial$/ }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).toHaveBeenCalledWith('marco', null, null)
  })
})
