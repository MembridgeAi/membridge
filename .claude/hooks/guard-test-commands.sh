#!/bin/bash
# PreToolUse hook on Bash for the MemBridge agent team.
#
# Enforces the standing orders that agents will otherwise drift away from under
# pressure. Exit code 2 blocks the command and returns the stderr message to the
# agent, so it learns why instead of retrying.
#
# Wire it up in .claude/settings.json with an ABSOLUTE path. Relative paths
# break because teammates and worktree sessions run from different directories.

INPUT=$(cat)

[ -z "$INPUT" ] && exit 0

# Fail CLOSED, not open. If this hook cannot read its input it must block, not
# wave everything through. A guard that silently allows everything when a
# dependency is missing is exactly the fail-open-plus-success-flag defect this
# repo is full of, and it would be invisible until an agent nuked master.
if command -v jq >/dev/null 2>&1; then
  CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty')
elif command -v python3 >/dev/null 2>&1; then
  CMD=$(printf '%s' "$INPUT" | python3 -c \
    'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("command",""))' 2>/dev/null)
else
  echo "Blocked: guard-test-commands.sh needs jq or python3 on PATH and found neither. Install one, or the safety hook cannot inspect commands." >&2
  exit 2
fi

if [ -z "$CMD" ]; then
  echo "Blocked: guard-test-commands.sh received input it could not parse, so it cannot tell whether this command is safe. Tell the human; do not retry." >&2
  exit 2
fi

# 1. Full node suite with no suite argument. `node test/run.js --list` is fine,
#    `node test/run.js search` is fine, bare is not.
if printf '%s' "$CMD" | grep -qE '(^|[;&|]|&&)[[:space:]]*node[[:space:]]+(\./)?test/run\.js[[:space:]]*($|[;&|])'; then
  cat >&2 <<'MSG'
Blocked: `node test/run.js` with no suite argument is a ship gate, not a
development tool, and running it under load manufactures phantom failures.
Run only the suite you touched: `node test/run.js <suite>`.
List suites with `node test/run.js --list`.
If a human explicitly asked for the full suite, tell them the hook blocked it
and let them run it themselves.
MSG
  exit 2
fi

# 2. Bare vitest run with no file argument.
if printf '%s' "$CMD" | grep -qE 'vitest[[:space:]]+run[[:space:]]*($|[;&|])'; then
  cat >&2 <<'MSG'
Blocked: `vitest run` with no file argument is a ship gate, not a development
tool. Under load it produces `Unable to find <element>` failures that are not
real defects.
Run the test files for what you touched: `npx vitest run <file>`.
The whole suite is allowed only when you changed shared code (DataClient, app
shell, theme, ui/src/components) AND a human asked for it.
MSG
  exit 2
fi

# 3. No pushing, ever. A human lands the work.
if printf '%s' "$CMD" | grep -qE '(^|[;&|]|&&)[[:space:]]*git[[:space:]]+([^;&|]*[[:space:]])?push'; then
  cat >&2 <<'MSG'
Blocked: agents never push. Commit to your own worktree branch, say the ticket
is done, and stop. A human lands the work.
MSG
  exit 2
fi

# 4. No committing onto master or main.
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$BRANCH" = "master" ] || [ "$BRANCH" = "main" ]; then
  if printf '%s' "$CMD" | grep -qE '(^|[;&|]|&&)[[:space:]]*git[[:space:]]+(commit|merge|rebase|reset[[:space:]]+--hard)'; then
    cat >&2 <<MSG
Blocked: you are on '$BRANCH'. Agents never commit to the default branch.
Work in your own git worktree on your own branch. If you are not in one, stop
and tell the lead rather than creating one yourself.
MSG
    exit 2
  fi
fi

exit 0
