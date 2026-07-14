# Desktop dashboard dark mode — design

Date: 2026-07-14
Status: approved approach, pending spec review

## Goal

Add a dark mode to the Electron dashboard (served by `lib/server.js`, styled in
`lib/dashboard.js` + `lib/dashboard-team.js`). Web app (`web/`) is out of scope.
The theme follows macOS by default, with a persisted manual override.

## Approach

Use the CSS `light-dark()` function (supported by Electron 43's Chromium).

- `:root { color-scheme: light dark; }` and every themed color expressed as
  `light-dark(<light>, <dark>)` — primarily inside the existing CSS variables.
- Hardcoded one-off light colors (`#fff`, `#f1f5f9`, `#ecfdf5`, tinted shadows,
  header glass rgba, etc.) are promoted into new semantic variables so each
  color pair is defined exactly once, e.g. `--surface`, `--surface-subtle`,
  `--tint-accent`, `--tint-ok`, `--tint-danger`, `--glass`, `--shadow-*`.
- Mode switching sets `document.documentElement.style.colorScheme`:
  `'light dark'` (System, default), `'light'`, or `'dark'`. No matchMedia
  listeners needed — the engine resolves System mode natively and live.

## Modes and persistence

- Three-way control in the Settings view (`#view-settings`): **System / Light /
  Dark**, styled like the existing radio rows.
- Preference stored in `localStorage` key `mb-theme` (`system|light|dark`);
  `system` is the default when unset.
- A tiny inline script in `<head>` applies the stored value before first paint
  to avoid a theme flash.

## Dark palette

Dark sibling of the current "Minimalist Modern" light system (same brand blue,
slate surfaces — NOT the old teal theme):

| Token    | Light                | Dark      |
| -------- | -------------------- | --------- |
| bg       | #fafafa              | #0a0e14   |
| card     | #fff                 | #111826   |
| border   | #e2e8f0              | #1f2937   |
| text     | #0f172a              | #e5eaf3   |
| muted    | #64748b              | #8b96a8   |
| accent   | #0052ff              | #4d7cff   |
| accent2  | #4d7cff              | #7c9dff   |
| danger   | #dc2626              | #f87171   |

Tints/shadows get dark equivalents (higher-alpha accents, black-based shadows).
Exact one-off pairs are decided during implementation, keeping contrast at
WCAG AA for text.

## Canvas (neural graph)

The graph draws with JS color literals. It will read its palette from
`getComputedStyle(document.documentElement)` at draw-setup so it follows the
active theme; source-identity colors (claude/codex hues) stay fixed but are
checked for legibility on both backgrounds.

## Cleanup included

The legacy dark-era CSS at the top of `lib/dashboard.js` (old `:root` palette
and hardcoded teal `rgba(45,224,167,…)` accents) is dead or, worse, leaking
into the current UI where the newer system doesn't override it (e.g.
`.pcard:hover`). It is removed/merged as part of this work so the file has one
design system, themed in one place. `lib/dashboard-team.js` hardcoded light
colors move to the shared variables.

## Error handling

- Invalid/absent `mb-theme` value → treated as `system`.
- `localStorage` unavailable → in-memory only, defaults to System.

## Testing

- Unit (test/run-tests.js style): dashboard HTML contains `color-scheme`,
  `light-dark(`, the three-way control, and the boot script; setting persists
  round-trip via the same code path.
- Manual: run the app, flip macOS appearance (System mode follows live), pin
  Light and Dark, relaunch to confirm persistence, check overview / project /
  neural / team / settings views and modals in both themes.
- Rebuild + reinstall MemBridge.app afterward (standing project practice).
