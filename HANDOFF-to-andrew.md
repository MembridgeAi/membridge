# Handoff → Andrew (Marco, Windows + E2E day)

Aligning our sides before the meet. Short version: **Windows is fully working now, and all of it is already on `mmelika/master`** (not uncommitted like you had it) — CI green on both platforms, E2E encryption verified encrypting live on my Windows box. Answers to your asks + what you'll need to do are at the bottom.

## Landed on `mmelika/master` today (canonical) — 5 commits, pushed, CI green

| commit | what |
|---|---|
| `4714fc9` | Real Windows bugs that had kept CI red for weeks: POSIX path separators leaking into synced blocks, the `~/.membridge` home-dir colliding with the per-project marker, and local-vs-team path checks assuming a leading `/` instead of a drive letter. **Touches `scan.js`, `util.js`, `digest.js`, `server.js`, `dashboard.js`, `project-resolve.js`.** |
| `fa04786` | Windows app UX: brand taskbar icon (was the generic Electron logo), click-the-tray-to-open, launch-at-login toggle. |
| `24ce10e` | CI: added a `windows-latest` build job **and fixed the mac job** — it had been silently failing on *every* run because it never installed the opt-in MCP test deps (`@modelcontextprotocol/sdk` + `zod`). |
| `e225e64` | **DPAPI key store** — E2E encryption never initialized on Windows because key storage was macOS-only (`security` CLI). Now uses Windows DPAPI via PowerShell, zero new deps. |
| `83127e4` | Device/key-change recovery: self-heal + owner `membridge team rekey`. |

Tests: **586/586** — now includes a real DPAPI round-trip on `windows-latest` and the full new-device recovery flow.

## Answering your three asks

**1. Canonical repo → agreed, `mmelika`.** It's already ahead: my 5 commits are on `mmelika/master`. Your `d0fa052` (license) and `feat/feedback-hook` are **not** on mmelika yet (remote head is my `83127e4`) — push them there when you're ready.

**2. Confirm `d0fa052` → can't eyeball it yet**, it isn't on `mmelika/master` or any fetched branch. Push it / point me at the fork branch and I'll look.
- ⚠️ **License collision:** my `4714fc9` set `package-lock.json`'s root `"license"` to `"UNLICENSED"` (syncing to the then-current `package.json`). Your FSL change to `package.json` collides there — the lock's root `license` needs to become `FSL-1.1-ALv2` too. Trivial, just don't miss it.

**3. Merge order → flip the plan.** My Windows work is already *on* master, not uncommitted, so we don't merge them together — you rebase onto it:
   - a. Rebase `feat/feedback-hook` onto current `mmelika/master`, resolve the `scan.js` / `util.js` overlap (mine are small: `util.js` isTempPath +17 lines, `scan.js` foldWorktreeProjects 1 line).
   - b. Land the license commit (rebased), reconcile the `package-lock` license line.
   - c. Publish npm at the merged version.

## Migration numbers (your point 7)

- **I did not add a migration.** My E2E recovery is entirely client-side (`teamsync.js` + `keychain.js`). So there's no `015_multidevice_keys.sql` from me — **feedback-hook keeps `015_feedback.sql` cleanly.**
- **But there's a real gap that does need one:** self-heal deletes a member's *own* stale `team_keys` row so a holder can re-seal them. `team_keys` currently has SELECT + INSERT policies but **no DELETE policy** — so on the live backend the self-heal DELETE fails (degrades safely: delete fails → stays paused → fall back to rekey). To make self-heal work end-to-end we need a `team_keys` DELETE policy (member deletes only their own rows). **I'll author that as `016_multidevice_keys.sql`** — grabbing 016 per your note. Owner rekey needs no migration (insert-only — verified live).

## Verified live, not just tests

Rekeyed our team epoch 1→2 with the new `membridge team rekey` (owner/admin only). Pause cleared; my Windows box now pushes **epoch-2 ciphertext with null plaintext columns**. Encryption is genuinely active on Windows.

## What you'll see / need to do

- Your next `membridge sync` **auto-picks-up epoch 2** (your row is sealed to your current key) — new content stays encrypted, no action needed to keep working.
- You may get a **KEY CHANGE alert for me** — my Windows device generated a fresh keypair (the old private key was never stored, because the keychain never worked on Windows before today). Verify out-of-band, then `membridge team trust marco`:
  - **My new key:** `be72 98e8 aea5 c219 26ef 75dd 7539 ed92`
  - (I see yours as `d2e5 6fad 234a 7030 e8a2 2f89 7628 aacc` — confirm on your end.)
- **Cost of the rekey:** I can't read pre-rekey (epoch-1) encrypted history — content sealed only to your key before today. If there's anything important there I need, we can re-seal epoch-1 to my new key; otherwise it's fine (I never had it).

## Collisions (files we both touched)

- `scan.js`, `util.js` — my Windows fixes (landed) vs your feedback-hook (unlanded) → **rebase feedback-hook**.
- `package-lock.json` root `license` — my `UNLICENSED` sync vs your FSL → **take FSL**.

## For the meet

- Canonical = `mmelika` ✓ (my work's already there)
- Merge order: **feedback-hook rebase → license → npm publish**
- **016** for the `team_keys` DELETE policy migration (I'll write it); 015 stays feedback's
- npm: hold until feedback-hook + license + Windows work are all in, then publish
