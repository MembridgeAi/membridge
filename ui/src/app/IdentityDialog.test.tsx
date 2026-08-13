import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DataClientProvider } from '../data/DataClientProvider'
import { FakeDataClient } from '../data/FakeDataClient'
import { GLYPHS, AVATAR_COLORS } from '../components/AvatarGlyph'
import { IdentityDialog } from './IdentityDialog'

function renderDialog(client = new FakeDataClient({}), onClose: () => void = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <DataClientProvider client={client}>
        <IdentityDialog currentName="marco" currentAvatar={null} currentAvatarColor={null}
                        viewerId="u1" onClose={onClose} />
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
    const onClose = vi.fn()
    renderDialog(client, onClose)
    await userEvent.clear(await screen.findByLabelText(/display name/i))
    await userEvent.type(screen.getByLabelText(/display name/i), 'nina')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already called nina/)
    // The typed text survives, so the person edits rather than retypes.
    expect(screen.getByLabelText(/display name/i)).toHaveValue('nina')
    // A collision must not close the dialog -- that would lose the name the
    // person just typed, which is the entire point of showing the alert.
    expect(onClose).not.toHaveBeenCalled()
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

  // Distinct from the test above: this one actually visits a real colour
  // first, so it fails if "Default colour" silently stopped being wired up
  // (unlike the null-from-the-start case, which never proves the option
  // is clickable or that clicking it does anything).
  it('returns to the id-derived colour after having picked a real one', async () => {
    const client = new FakeDataClient({})
    const spy = vi.spyOn(client, 'setDisplayName')
    renderDialog(client)
    await userEvent.click(await screen.findByRole('radio', { name: 'Colour 2' }))
    await userEvent.click(screen.getByRole('radio', { name: /^Default colour$/ }))
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(spy).toHaveBeenCalledWith('marco', null, null)
  })

  // The whole point of two independent rows: every colour swatch should
  // preview the glyph the person already chose, not a plain initial.
  // AvatarGlyph renders <svg role="img">; the initial fallback renders a
  // plain span with no role, so counting "img" roles inside the colour
  // radiogroup cleanly tells them apart.
  it('previews the chosen glyph across every colour swatch', async () => {
    renderDialog()
    await userEvent.click(await screen.findByRole('radio', { name: 'halo' }))
    const colourRow = screen.getByRole('radiogroup', { name: /avatar colour/i })
    expect(within(colourRow).getAllByRole('img')).toHaveLength(AVATAR_COLORS.length + 1)
  })

  // Same idea in the other direction: every shape swatch (excluding
  // "Initial", which forces avatar=null and always renders the plain
  // initial) should carry the chosen colour.
  it('previews the chosen colour across every shape swatch', async () => {
    renderDialog()
    await userEvent.click(await screen.findByRole('radio', { name: 'Colour 2' }))
    const shapeRow = screen.getByRole('radiogroup', { name: /avatar shape/i })
    const glyphSwatches = within(shapeRow).getAllByRole('img')
    expect(glyphSwatches).toHaveLength(GLYPHS.length)
    for (const svg of glyphSwatches) {
      expect(svg).toHaveStyle({ color: '#22C08F' })
    }
  })
})
