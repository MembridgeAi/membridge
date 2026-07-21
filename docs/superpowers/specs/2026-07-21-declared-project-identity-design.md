# Declared Project Identity: Bind, Don't Guess

**Date:** 2026-07-21 · **Status:** Draft (awaiting review)

**Builds on:** `2026-07-12-team-collaboration-saas-design.md` (team sync, `projects` table, `team.json` linking) and the existing `lib/teamsync.js` push/pull + `lib/project-resolve.js` root resolution.

## The principle

A teammate should get working team memory with **one click per folder** — create a project once, then bind each local folder to it. Project identity is **declared by a person**, never **derived from the git remote**. Git is never consulted to decide what project a folder belongs to.

## Where we are now

Identity is derived. `linkProject()` (`lib/teamsync.js`) either adopts a committed `.membridge/team.json` or calls `repoUrl()` and mints/matches a backend `projects` row keyed to the **normalized git remote** (`github.com/user/repo`). `detectAutoLinks()` matches that remote against backend rows and either auto-links (`team.autoLink`) or records a `teamSuggestion`.

Git-remote-as-identity breaks in three predictable ways, all fatal for an instant-on SaaS:

| # | Failure | Real example |
|---|---------|--------------|
| 1 | **Forks** — a fork's remote differs, so it mints a *second* project row and teammates silently stop seeing each other. | `andrewb-eng/membridge` → row `84236c88`, split from `mmelika/membridge` → row `ab5f018a`. This actually happened. |
| 2 | **No remote** — a local-only folder has no key; every machine is an island. | Any `git init` scratch project. |
| 3 | **Monorepo** — one remote, many logical projects; they collide onto one key. | `repo/packages/api` vs `repo/packages/web`. |

The tactical fix already shipped (commit `9a874a9`: committing `team.json` to anchor the shared `project_id`) works but is per-project manual and re-introduces working-tree churn — not an onboarding mechanism.

## The fix, in one line

Replace remote-derived identity with a per-machine **binding** — a stored fact `folder path → project_id` — set by one explicit user action, read by sync in place of `loadTeamLink`, inherited by worktrees, and optionally *pre-filled* (never decided) by the git remote when one happens to match.

## The three locked decisions

1. **Binding source of truth:** the local global state (`~/.membridge/state.json`), per machine, per absolute folder path. A **gitignored** `.membridge/team.json` mirror is written only so the Stop hook and CLI can read the binding without loading state. The mirror is never committed.
2. **Worktrees:** auto-inherit the nearest bound ancestor's `project_id` via `resolveRoot` — no per-worktree bind.
3. **Remote:** used only to *pre-fill* the bind suggestion (turn a menu pick into a one-tap confirm). It is never the source of truth and a wrong guess is always a visible, rejectable suggestion — never a silent binding.

---

## Delta 1 — the binding primitive

Add the binding fields to each project entry in state — both the project id and its team id, because the encryption path (`mkTeamKeyDeps`) needs `link.teamId` as well as `link.projectId`:

```
state.projects["/Users/marco/Documents/Membridge"] = {
  boundProjectId: "ab5f018a-…",   // NEW — the declared binding
  boundTeamId:    "6ba3c572-…",   // NEW — carried for the crypto path
  events, teamPushTs, teamPullTs, teamEntries, sharedSessions, ...
}
```

New module `lib/binding.js` (small, single-purpose):
- `bindFolder(state, path, projectId, teamId)` — set both fields, write the gitignored `team.json` mirror.
- `unbindFolder(state, path)` — clear them, remove the mirror.
- `resolveBinding(state, path)` — returns `{ projectId, teamId }` for a folder, walking up to the nearest bound ancestor (worktree inheritance, Decision 2), reusing `resolveRoot`'s walk from `project-resolve.js`; `null` when nothing is bound.

`team.json` shrinks to a portable mirror: `{ projectId, teamId, boundAt }` — no `linkedBy`, no committed intent.

## Delta 2 — sync reads the binding, not the remote

In `syncTeams()` (`lib/teamsync.js`, the per-project loop) replace:

```js
const link = loadTeamLink(key);
if (!link || !link.projectId) continue;
```

with a binding read:

```js
const b = resolveBinding(state, key);
if (!b) continue;
const link = { projectId: b.projectId, teamId: b.teamId || null };
```

`pushProject` / `pullProject` / cursors / dedup / encryption are **unchanged** — they already take `link.projectId`. Unbound folders are skipped exactly as unlinked ones are today.

## Delta 3 — detection replaces remote auto-link

Replace `detectAutoLinks()` (remote matching) with `detectUnboundFolders()`:
- A candidate is any tracked folder with recent edit events and no resolved binding (not paused, not dismissed).
- For each, surface a **suggestion** (`proj.bindSuggestion = { candidateProjectId?, prefillFrom: 'remote'|'context'|null }`).
- **Decision 3 pre-fill — two hint sources, neither ever trusted as truth:**
  1. **Git remote:** if `repoUrl(key)` matches a backend project's optional `repo_url` metadata, propose that project.
  2. **Context marker:** MemBridge already writes a managed block into the repo's `CLAUDE.md`/`AGENTS.md`. It also stamps a hidden marker there (`<!-- membridge:project=<id> -->`); if a fresh clone carries one, read it as a second pre-fill source.
  When a hint resolves, set `candidateProjectId` so the UI shows *"Looks like **Membridge** — bind? [Yes]"* (a one-tap confirm) instead of an empty picker. A missing, stale, or tampered hint simply leaves the picker empty and the user picks. **A hint only pre-selects; the user's confirm is what binds — so a bad marker can never silently connect a folder to the wrong project.**

Keep `resolveSuggestion(accept)` semantics: accept → `bindFolder`; dismiss → remember `bindSuggestionDismissed` for that folder.

## Delta 4 — backend

`projects.repo_url` becomes **optional metadata**, not an identity key: nullable, non-unique, used only for the Delta 3 pre-fill. No new tables. RLS is unchanged and remains the real authorization boundary — a push to a `project_id` still only succeeds if the caller is a member of that project's team, so an optimistic client-side bind is safe (the server rejects an unauthorized push).

## Delta 5 — user surfaces

- **Desktop app / dashboard:** a bind chip appears when an unbound edited folder is detected — a project dropdown (pre-selected per Delta 3) + **Bind**. A folder's current binding is shown and rebindable in one click.
- **CLI:** `membridge bind [<project-name-or-id>]` (bind cwd; interactive picker if omitted) and `membridge unbind`. `membridge status` gains a `bound → <project>` line per folder. The `team link`/`team unlink` verbs become thin aliases to bind/unbind for continuity.

## Delta 6 — migration (silent, no re-onboard)

On upgrade, for each folder with a committed or existing `.membridge/team.json` carrying a `projectId`: seed `boundProjectId` from it once, then treat the file as a gitignored mirror going forward (add `**/.membridge/team.json` back under the ignore, dropping the `!` negation from commit `9a874a9`). The orphan fork row `84236c88` is archived; its entries are left to age out of `teamEntries` (cap already enforces this). Nobody re-onboards.

## Edge cases

| Case | Behavior |
|------|----------|
| Fork (different remote) | Both bound the same `project_id` by choice; remote never read. Split impossible. |
| No git remote | Binding never touched git; works identically. |
| Monorepo | Bind sub-folders to distinct projects; `rehomeEvents` routes each edit to its nearest bound root. |
| Worktree under a bound repo | Inherits parent's `project_id` (Decision 2); zero extra clicks. |
| Same folder, two machines | Each binds locally; both point at one `project_id`; converge. |
| Bound to wrong project | Rebind is one click; already-pushed rows left as-is (cheap; no re-home). |
| Pre-fill guesses wrong | Visible suggestion the user rejects; never a silent binding. |

## Testing

- **Unit:** `binding.js` (`bindFolder`/`unbindFolder`/`resolveBinding` incl. worktree ancestor walk); `detectUnboundFolders` candidate/pre-fill/dismiss logic.
- **Integration:** `syncTeams` pushes/pulls for a bound folder and skips an unbound one (against the existing offline mock backend); migration seeds a binding from a legacy `team.json`.
- **Regression:** a fork-remote folder bound to the shared project pushes to the shared `project_id`, not a new row.
- Keep the existing suite green (currently 470).

## Alternatives considered

All three share one root: they try to skip the bind click by carrying identity in a **repo artifact** instead of over the sync backend. Each is kept only as an optional *hint* (Delta 3), never as source of truth.

| Alternative | Why not as the mechanism | Kept as |
|-------------|--------------------------|---------|
| **Auto-committed `team.json`** | A background daemon committing into users' repos is invasive and unsafe (dirty tree, hooks, signing, protected branches); propagation still rides push/merge/pull, so a new teammate or a fork cut before the commit gets nothing; can't express monorepo granularity; no-git folders can't carry it; bakes a semi-sensitive id permanently into shared/public history. | Manual escape hatch (still supported for the single-shared-repo case). |
| **Git remote as identity** | Fork remotes differ (the original bug); monorepos collide onto one remote; no-remote folders have no key; robust fork→upstream resolution needs per-host heuristics and auth tokens. | Pre-fill hint. |
| **Identity in the context injection** (`CLAUDE.md` marker) | Collapses into "committed `team.json` in disguise" — same push/merge/pull propagation lag and same fork/monorepo/no-file gaps — and adds tamper risk (a human-edited doc becomes a control value) plus coupling to the injection format. | Pre-fill hint (second source in Delta 3). |

The decisive reframe: MemBridge already runs a fast, authoritative, git-independent channel — the sync backend. Identity should travel over it (join team → app lists projects → bind once), not be smuggled through repo files that propagate slower and can be stale or edited.

## Out of scope

- Zero-click binding for the *second* teammate (irreducible one confirm click by design — Delta 3 only shaves it to a tap).
- Re-homing historical orphan-row entries into the shared project (archival only).
- Any change to redaction, encryption, or the distillation/summary pipeline.
