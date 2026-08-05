import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Cutover: the rebuilt UI is served at / now (lib/server.js), not /app --
  // '/app' survives only as a server-side redirect alias to /, so the built
  // asset paths and the router's base (App.tsx's routerBase(), which tracks
  // this via import.meta.env.BASE_URL) must both point at the real root.
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    environment: 'jsdom',
    // The other half of the same gotcha the timeouts below guard: the default
    // 'forks' pool cannot reliably start its workers when the machine is busy
    // (several agents compiling at once), and a worker that never starts is
    // reported as a test failure. This had only ever been passed ad hoc as
    // --pool=threads. Pin it.
    pool: 'threads',
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    passWithNoTests: true,
    // Must stay comfortably ABOVE vitest.setup.ts's asyncUtilTimeout (5s),
    // or a findBy* that is allowed to wait five seconds kills the test at
    // five and reports a vitest timeout instead of Testing Library's much
    // more useful "here is the DOM I actually saw". Neither limit slows a
    // passing run -- both exit the moment the element appears -- they only
    // decide how much scheduler starvation (a busy dev machine running the
    // whole suite in parallel) is tolerated before a passing test is
    // reported as a failure. This suite had a long tail of phantom
    // "Unable to find <element>" failures that were exactly that.
    testTimeout: 15_000,
    // Pin the suite's timezone. The UI renders every timestamp in the
    // VIEWER's local zone, so these assertions are only meaningful against a
    // known zone -- unpinned, the ambient TZ leaks into the workers and the
    // same suite passes in London and fails in California, which is exactly
    // the class of bug this guards. Vitest applies `env` inside each worker
    // before any test module (or setup file) is imported, and Node re-reads
    // the zone when process.env.TZ is assigned, so Date/Intl resolve to this
    // zone everywhere. Deliberately NOT 'UTC': a UTC-pinned suite cannot
    // tell local-day logic from UTC-day logic, so the bug would still hide.
    env: { TZ: 'America/Los_Angeles' },
  },
})
