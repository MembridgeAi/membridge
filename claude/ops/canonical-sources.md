# Canonical sources

Read this before reading code, cloning anything, or trusting a file in this
project.

## The repository

Canonical: `MembridgeAi/membridge`, branch `master`.

`andrewb-eng/membridge` is a stale personal fork. Never read from it, never
clone it, never push to it. As of 2026-08-01 it was roughly 320 commits behind.
On 2026-07-31 it was nine days behind and did not contain the React/TypeScript
dashboard rewrite at all, which caused one full session to be written against a
codebase that no longer existed.

The site repository is `mmelika/membridge-site`, branch `main`, live at
membridge.app.

If a session's GitHub connector is pointed at the fork, say so out loud and
clone `MembridgeAi/membridge` directly instead. Do not silently work from
whatever the connector returns.

## The repo beats the Claude Project

The Claude Project is a mirror. This repository is canonical. When a document
there and this repository disagree, this repository is right and that copy is
stale.

Specs and plans get amended in the repo after they are written in the mirror.
Treat the mirror versions as the originating draft, not the current state.

## Read order for a fresh session

1. `claude/ops/state.md` in this repository. It carries verified current state:
   real suite counts, release topology, what is broken right now.
2. `claude/ops/queue.md` for what is being worked and in what order.
3. `claude/ops/decisions.md` for settled calls and their reasoning. Append-only.
4. `claude/ops/blocked.md` for what is waiting on a human.

A number in any document that is not in `state.md` may be stale. The test count
in particular has been 622, 1221, 1285, 1294, 1313 and 1226 at various points,
each for a traceable reason. Never quote one without checking.

## Verification rules that have already been learned the hard way

A green CI log is not proof a binary is signed. A build killed after the signing
line prints comes out `Signature=adhoc`. The only proof is downloading the
published asset through a browser and running `codesign -dv --verbose=4`,
`spctl -a -vv`, and `xcrun stapler validate` on that file. This has produced a
false positive once.

A 200 status code is not proof a download works. A missing GitHub release asset
redirects to an HTML page and still returns 200. Check `content_type`.
`application/octet-stream`, `application/x-apple-diskimage` or `application/zip`
means a real binary. `text/html` means the link is dead.

The repo working is not proof the product works. The npm tarball's `files` field
ships no UI, so an npm-only install has no dashboard. Every test that runs from
the repo or the Electron app misses this entire class of defect. Test published
artifacts.

A green suite is not proof the suite ran. A crash in the harness silently hid
roughly 5,300 lines of tests for an unknown period.

## Agent authority

No agent merges, publishes, tags, moves a tag, or messages anyone but Andrew.
The bottleneck is human review capacity, not production capacity, so an agent
with merge rights converts a review queue into an audit queue.

One agent per working tree. Two agents in one checkout swept a third party's
staged files into a commit on 2026-07-31 and was caught only by a soft reset
before push.

## House style

No em dashes. Not in prose, not in code comments, not in UI copy.
