import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderApp } from '../test/renderApp'

/** The app ships under a /app/ prefix in the desktop build, but every earlier
 *  test rendered it at '/'. That gap let a router with no base reach a real
 *  install: nothing matched, and every screen rendered the "Not found"
 *  placeholder. These tests render at the deployed prefix so a missing or
 *  wrong router base fails here instead of in the packaged app. */
describe('App at its deployed /app prefix', () => {
  // Vite bakes BASE_URL at build time; jsdom serves at '/'. Stub it so these
  // tests exercise the same prefix the desktop build actually deploys under.
  beforeEach(() => { vi.stubEnv('BASE_URL', '/app/') })
  afterEach(() => { vi.unstubAllEnvs(); window.history.pushState({}, '', '/') })

  const at = (path: string) => {
    window.history.pushState({}, '', path)
  }

  it('renders Today at the prefix root, not the not-found placeholder', async () => {
    at('/app/')
    renderApp()
    expect(await screen.findByText(/happening now/i)).toBeInTheDocument()
    expect(screen.queryByText(/not built yet/i)).toBeNull()
  })

  it('renders a deep route under the prefix', async () => {
    at('/app/projects')
    renderApp()
    expect(await screen.findByRole('heading', { name: /projects/i })).toBeInTheDocument()
    expect(screen.queryByText(/not built yet/i)).toBeNull()
  })

  it('still shows the not-found placeholder for a genuinely unknown path', async () => {
    at('/app/no-such-screen')
    renderApp()
    expect(await screen.findByText(/not found/i)).toBeInTheDocument()
  })
})
