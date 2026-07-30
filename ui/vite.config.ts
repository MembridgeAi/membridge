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
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    passWithNoTests: true,
  },
})
