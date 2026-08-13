// The three outcomes of a sign-up, as the UI contract models them. This exists
// because the shipped bug was a MISSING outcome: "no session" and "no account"
// were both spelled as an absent boolean, so the UI could not tell them apart
// and told users to confirm an email that was never sent.
import { describe, it, expect } from 'vitest'
import { FakeDataClient } from './FakeDataClient'

describe('DataClient.signUp outcomes', () => {
  it('reports a fresh address as awaiting confirmation', async () => {
    const c = new FakeDataClient({ authenticated: false })
    await expect(c.signUp({ displayName: 'A', email: 'fresh@acme.dev', password: 'long-enough-pw' }))
      .resolves.toEqual({ status: 'needs-confirmation', email: 'fresh@acme.dev' })
  })

  it('reports the fixture address that already has an account', async () => {
    const c = new FakeDataClient({ authenticated: false })
    await expect(c.signUp({ displayName: 'A', email: FakeDataClient.REGISTERED_EMAIL, password: 'long-enough-pw' }))
      .resolves.toEqual({ status: 'email-exists', email: FakeDataClient.REGISTERED_EMAIL })
  })
})
