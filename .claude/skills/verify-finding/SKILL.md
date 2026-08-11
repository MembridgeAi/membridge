---
name: verify-finding
description: Decide whether a failing test in this repo is a real defect or a phantom caused by machine load, before anyone acts on it. Use whenever a test fails, whenever a bug candidate rests on a red suite, and before filing, promoting, or fixing anything that came from a test failure.
---

# Verify a finding before you believe it

This repo's suites produce phantom failures under load. Testing Library's
`findBy*` and `waitFor` run on their own `asyncUtilTimeout`, not vitest's
`testTimeout`, and several assertions are sensitive to scheduler starvation.
When several agents compile at once, passing tests report as failures, usually
`Unable to find <element>`. They read exactly like real defects.

An agent that believes one will "fix" working code to silence a measurement
error. That is the most expensive mistake available here, because the diff looks
reasonable and the test goes green.

**No test failure is a defect until it reproduces alone on a quiet machine.**

## Run it

```sh
node scripts/verify-finding.js --suite <suiteName>
node scripts/verify-finding.js --ui <testFile> [--name "<test name>"]
node scripts/verify-finding.js --ui <testFile> --runs 5
```

`--runs` defaults to 3. The script takes a machine-wide lock and waits for load
to drop before it measures, so two agents cannot verify at the same time. It can
block for a while. That is the design, not a hang.

## Branch on the exit code, never on the output

| Code | Meaning | What you do |
| --- | --- | --- |
| `0` | CONFIRMED, failed every isolated run | Real. File it, promote it, or fix it. |
| `3` | PHANTOM, passed in isolation | Load artifact. Do **not** file it and do **not** touch the code. |
| `4` | FLAKY, inconsistent across identical isolated runs | Stop. Hand it to a human. Do not fix and do not dismiss. |
| `1` | ERROR, bad usage or the runner could not execute | Fix the invocation, then rerun. |

```sh
node scripts/verify-finding.js --suite search; echo "exit=$?"
```

A `3` is not a weaker `0`. It means there is nothing there.

A `4` is the one people get wrong. It is not "probably fine". An isolated run
that disagrees with itself is either a real race or a broken test, and both need
a human to decide which.

## Rules

- Never report a bug whose only evidence is a red run you have not gated.
- Never mark work done while a test you touched is red and ungated.
- Quote the exit code in your report. "Tests pass now" is not evidence.
- If the script itself is missing, stop and say so. Do not fall back to judging
  the failure by eye, which is exactly the failure mode it exists to prevent.
