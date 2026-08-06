# Redaction boundary

_What each redaction layer catches, in order. What each sharing mode ships.
What is still not caught, stated plainly._

MemBridge captures prompt and summary text as your AI tools produce it, and
some of that text will contain secrets that should not leave your machine.
This document is the honest account of what the tool does and does not do
about that.

Everything below applies to text that would leave the machine — the team
sync push, the copy-for-AI digest, anything a shared network endpoint reads.
Purely local reads (your own dashboard, your own recall) go through the same
pipeline as defense in depth; a bug in a downstream reader cannot leak a
secret the pipeline already scrubbed.

## Sharing modes: what actually goes on the wire

Configured via `membridge team share-prompts <mode>` (CLI) or the Settings
screen. Three modes; a legacy boolean value is honored.

| Mode        | `ask` (raw prompt) | `goal` (agent-distilled) | `summary`, `headline`, `decisions`, `gotchas`, `files`, `changes` |
|-------------|--------------------|--------------------------|-------------------------------------------------------------------|
| `off`       | not shipped        | not shipped              | shipped (always)                                                  |
| `distilled` | not shipped        | shipped                  | shipped                                                           |
| `verbatim`  | shipped            | shipped                  | shipped                                                           |

**Fresh installs default to `distilled`** — the agent-written goal ships
because a teammate row without one is often just a name and a timestamp,
but the raw prompt does not, because the raw prompt is where secrets end
up. The `goal` field can only carry text an agent wrote in
`summaries.jsonl`; the Stop hook contract explicitly forbids restating the
user's prompt, so a leak through `goal` requires a hook implementation bug,
not user-typed text passing through.

**Existing installs never change under an update.** A user whose config on
disk has `sharePrompts: true` (legacy boolean, the pre-migration default
for a while) is honored as `verbatim` forever. Anyone with `false` reads as
`off`. Absent is `off`. The three-value UI and CLI are the audit trail for
this — after this ships you can see which mode is active without guessing.

## Redaction layers, in the order they run

Every shipped field passes through **the single redaction pipeline**
(`lib/digest.js`'s `redactText`, layered on top of `lib/redact.js`'s
`redactDefault`). The pipeline runs BEFORE any clipping — a truncation that
cut off a pattern's tail would break the pattern, so this order is
load-bearing and enforced in `test/suites/redaction-boundary.test.js`.

### 1. Named shape patterns (`DEFAULT_PATTERNS`)

Named credential shapes with dedicated regexes. Emit
`[redacted:<pattern-name>]`. Includes:

- PEM/OpenSSH private key blocks (`[redacted:private-key]`)
- JWTs (`[redacted:jwt]`)
- Connection URIs with embedded credentials (`[redacted:credentials]`)
- npmrc `_auth=` lines
- `Authorization:` headers and bare `Bearer` tokens
- Named provider keys (`[redacted:github-token]`, `[redacted:anthropic-key]`,
  `[redacted:stripe-key]`, and the rest of the table in `lib/redact.js`)
- URL query-string credentials (`[redacted:url-credential-param]`)
- Generic `KEY=value` assignments (`[redacted:secret-assignment]`, keeps
  wrapping quotes so `password: "value"` becomes `password: "[redacted:...]"`)
- Carrier-phrase captures: `password is X`, `secret: X`, `api key -> X`, etc.
  (`[redacted:phrase]`, keeps the sentence)

The named patterns catch **shape**. A string that matches Stripe's live-key
prefix is redacted whether or not the entropy backstop would have caught
it, so the reader knows what kind of thing was there.

### 2. Env-value deny-list (per-project, in-memory)

The project's own `.env`, `.env.local`, `.env.development`,
`.env.production`, and `.env.*.local` are read at push time. Values from
those files are matched **as literal strings** anywhere they subsequently
appear in captured text and replaced with `[redacted:env]`.

Deliberately narrow:

- `.env.example`, `.env.sample`, `.env.template` and any `*.example` /
  `*.sample` / `*.template` variant are **never** read — they hold
  placeholders, and redacting placeholder text corrupts prose.
- Values under 8 characters are skipped (too short to be a distinct
  literal without also destroying ordinary words).
- A stop-list drops obvious non-secrets (`true`, `false`, `localhost`,
  bare integers, `development`, `production`, `test`, bare URLs).
- Case-sensitive. Secrets are.
- Metacharacters in values are escaped before matching — `p@ss.w+rd` is
  matched byte-for-byte, not as a regex.

The values are **never persisted**. They live in the process's compiled
matcher and nowhere else — not in `state.json`, not in logs, not in error
messages. `test/suites/env-deny-list.test.js` walks the isolated test
`MEMBRIDGE_HOME` after a full pipeline pass and fails if a known literal
appears in any file the run wrote.

Symlinks out of the project root are ignored (`fs.lstatSync` gate).

Cached per absolute project path, keyed by the newest env-file mtime, so a
`.env` edit takes effect on the next push without a daemon restart. The
cache holds at most 32 projects at a time.

### 3. User patterns (`config.redact`, `config.redactExtra`)

Any user-added regex from the config, applied last. Matches become a bare
`[redacted]`. Invalid patterns are silently ignored to keep the pipeline
running.

### 4. Entropy backstop (`redactHighEntropy`)

Runs after every named pattern. A base64-ish blob of 24 or more characters
at 4.5 or more bits per character is redacted as `[redacted:high-entropy]`,
UNLESS it looks like a git SHA, a UUID (session ids stay intact — hook
consumers rely on them), a filesystem or URL path segment, or a filename
with an extension.

The threshold is deliberately conservative. Below 4.5 bits/char, false
positives eat identifiers and machine-generated strings that are not
secrets — session ids, ULIDs, hex hashes — and there is no threshold that
also catches memorable-word passwords without doing that. That is the
tradeoff behind the boundary below.

## What is NOT caught, on purpose

**A memorable-word password with no shape and no carrier and no env
presence** — `hunter2corgi`, `aardvarkboxwaltz`, `correcthorse`. The
character-level entropy of a lowercase English string is not
distinguishable from ordinary text, and no threshold that catches these
would also spare project names, brand names, and casual prose. See
`redactHighEntropy` and its adjacent test
`test/suites/redaction-boundary.test.js` for the assertion that PINS this
limit — if the assertion ever starts failing, this document is out of date
too, and the two must land together.

**A secret that was never in `.env` and never introduced by a carrier
phrase.** If a developer pastes `myapp:p4ssw0rd!` into a prompt with no
surrounding "password is" and no matching `.env` value, the deny-list has
nothing to match against and the carrier has nothing to trigger on. The
entropy backstop MIGHT catch it depending on length and character
distribution, but that is not something to rely on.

**A secret in a captured file's contents.** MemBridge reads the file
manifest (paths, additions/deletions), not the file bodies, so a
`git commit` containing a hard-coded key is not something the pipeline is
looking at. That is the git provider's job.

## What each mode is worth

`off` is the fully paranoid mode — a teammate sees your name, your
timestamps, and your file lists. They cannot see any word you or an agent
wrote. Use it for a repo whose file names alone are sensitive.

`distilled` (default) trades one specific risk for another. It sends the
agent-written goal, which is an agent-written distillation of what the
session was about; that field cannot contain a raw prompt by construction
(the Stop hook contract in `lib/hooks.js` forbids it). It does not send
the raw prompt, which is where credential leaks actually happen. This is
the setting the alpha ships with because it makes teammate rows useful
without a documented leak vector.

`verbatim` sends the raw prompt too, redacted through every layer above.
Use it when you trust the pipeline, the corpus, and the person on the
other end.

## Reproducing the check

```
node test/run.js redaction wire-redaction share-prompts-mode env-deny-list carrier-phrase redaction-boundary
```

Green means the tests documenting the boundary above pass. They do not
prove the boundary is right — they prove the boundary is stable.
