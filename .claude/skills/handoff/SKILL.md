---
name: handoff
description: Write and post an end-of-session handoff to Andrew in Slack, as a machine-readable version in #handoffs plus a short human brief in #brief. Use when the user says "write a handoff", "handoff to Andrew", "post a handoff", "end of day summary", "wrap up and tell Andrew", or asks to share what they did with their cofounder. Never post handoffs to DMs.
---

# Handoff

Two audiences, two messages, posted together. Andrew's agents read `#handoffs`. Andrew reads `#brief`. Neither message is a trimmed copy of the other; they are written for different readers.

## Channels

| Channel | ID | Audience | Job |
|---|---|---|---|
| `#handoffs` | `C0BK1NWRBSR` | Andrew's LLM | Complete technical state, evidence-dense |
| `#brief` | `C0BMAFY35DG` | Andrew, human | What happened and what Andrew owes, in under 60 seconds |
| `#all-membridge` | `C0BJPMVNCAV` | Company | Announcements only. Not handoffs. |

**Never post a handoff to a DM.** DMs were the old habit and they are why nothing was findable. If the user asks for a DM, post to the channels and say why.

## Before writing

1. Read recent `#handoffs` and `#brief` messages, plus the DM history with Andrew (`U0BJKS826TY`), far enough back to cover the last two handoffs. **Nothing already reported gets reported again**, except to correct it.
2. Check the project docs (`claude/ops/queue.md`, `claude/ops/decisions.md`, `claude/ops/handoff-*.md`) for state the user may not have mentioned.
3. Verify claims against the repo rather than repeating what the user said from memory. A handoff citing `file.js:line` is worth ten citing "I fixed the thing."

## The #handoffs message

Written so an agent with no context can act without asking a question.

- Open with `*Marco → Andrew, YYYY-MM-DD: <specific subject>*` and one line pointing at `#brief` for the human version.
- State shipping status honestly in the first two lines. "Nothing shipped" is a fine opening.
- Every claim carries evidence: `file.js:line`, branch names, commit SHAs, exact test counts, exact endpoint paths. Quote in-repo comments directly when they are the finding.
- Name the collision surface explicitly: which files this work touches, and which of Andrew's unmerged branches sit in the same place.
- Flag anything that changes runtime behaviour in its own section, marked as needing sign-off rather than awareness.
- Carry forward unanswered asks from previous handoffs verbatim under "Unchanged asks", with how long they have been open.
- Correct earlier handoffs when new information contradicts them. Say plainly that a previously reported fix did not close the issue. This is the highest-value part of any handoff and the easiest to skip.
- Do not soften findings for a cofounder's benefit. Andrew is a peer.

## The #brief message

The test: Andrew reads only the bold text, in about fifteen seconds, and understands the whole session.

### Format, exactly

A bulleted list. Each bullet is one specific finished thing, and has two parts:

1. **A single bolded sentence** naming what was finished. Concrete and complete, not a topic label. "Projects can now be archived instead of only deleted" works. "Projects tab improvements" does not.
2. **One or two plain sentences** underneath, unbolded, explaining why it matters or what it replaces. Skip this entirely when the bold sentence is self-sufficient.

Nothing else. No section headers, no sub-bullets, no closing summary. One optional line above the list for date and framing, and one line below for what is still owed by the other person.

The hard constraint: **the bolded sentences read in sequence must stand alone as a complete summary.** Before posting, read only the bold. If it does not make sense on its own, or if a bullet's bold text is a category rather than an outcome, rewrite it.

### Content rules

- One bullet per finished thing, ordered by what Andrew cares about most, not chronologically.
- Lead with what actually happened, including "nothing merged" if that is true.
- No file paths, no line numbers, no branch names, no jargon that needs the repo open. If a detail only makes sense with the code in front of you, it belongs in `#handoffs`. The one exception is naming a directory like `lib/` when ownership is the point.
- Anything that needs Andrew gets its own bullet, and its bold sentence says so outright: "One change needs your sign-off: ...".
- Say what you got wrong, in its own bullet. A brief that only reports wins is not read twice.
- Aim for six to twelve bullets. More than that means the bullets are too small.

### Not AI slop

- No em dashes anywhere. Commas, colons, parentheses, or two sentences.
- No "I'm excited to share", no "Here's a breakdown", no "Key takeaways", no closing summary that restates the message.
- No bullet list where three sentences would do.
- No adjective doing work a fact should do. "The number is not trustworthy, every token figure is characters divided by four" beats "there are some significant concerns with data quality."
- Contractions and short sentences are fine. It should read like the user typed it in a hurry and happened to be precise.

## Posting

Post both with `slack_send_message`, `#handoffs` first. Return both message links.

Draft instead of sending (`slack_send_message_draft`) only when the user asks to review first, or when the handoff contains a claim you could not verify. Say which claim, and why.

## After posting

Update `claude/ops/queue.md` with anything the session surfaced that is not already there: new tickets, stale entries to close, items that moved. A handoff that leaves the queue stale means tomorrow's session rediscovers the same work.
