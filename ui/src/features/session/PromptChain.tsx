import { useState } from 'react'
import type { SessionCheckpoint, SessionPrompt } from '../../data/types'

// The prompt chain: every prompt of the session, newest-first, on a
// left-ruled timeline. Locked decisions honored:
//   * newest 5 first, then a "Show older prompts" button revealing 25 per
//     press -- a 200-prompt session must open instantly, so rows past the
//     window are simply not rendered (not hidden with CSS).
//   * an unshared prompt (ask: null, team-origin) renders the literal
//     "(prompt not shared)" placeholder HERE, in the renderer -- the daemon
//     never fabricates prompt text.
// A checkpoint renders beneath the prompt it followed (the newest prompt at
// or before the checkpoint's ts) as an accent-ruled block.

export const PROMPT_CHAIN_INITIAL = 5
export const PROMPT_CHAIN_STEP = 25

// The viewer's own wall clock; explicit locale so formatting never varies by
// machine (the suite pins TZ, and every toLocale* call passes 'en-US').
function clockTime(ts: string): string {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

/** The checkpoints that landed after prompt `i` and before the next newer
 *  prompt -- i.e. while this prompt's work was running. `prompts` is
 *  newest-first, so the "next newer" bound is prompts[i - 1]. A checkpoint
 *  older than every prompt attaches to the oldest one rather than vanishing. */
export function checkpointsFor(
  prompts: SessionPrompt[], checkpoints: SessionCheckpoint[], i: number,
): SessionCheckpoint[] {
  const prompt = prompts[i]
  const newerBound = i > 0 ? prompts[i - 1].ts : null
  const isOldest = i === prompts.length - 1
  return checkpoints.filter(c => {
    const afterThis = c.ts >= prompt.ts || isOldest
    const beforeNewer = newerBound === null || c.ts < newerBound
    return afterThis && beforeNewer
  })
}

interface PromptChainProps {
  prompts: SessionPrompt[]
  checkpoints: SessionCheckpoint[]
}

export function PromptChain({ prompts, checkpoints }: PromptChainProps) {
  const [shown, setShown] = useState(PROMPT_CHAIN_INITIAL)
  const visible = prompts.slice(0, shown)
  const total = prompts.length

  if (total === 0) return null

  return (
    <div className="session-chain">
      <div className="session-chain-title">Prompts</div>
      <ol className="session-chain-list">
        {visible.map((p, i) => (
          <li key={`${p.ts}|${total - i}`} className="session-prompt">
            <div className="session-prompt-head">
              <span className="mono session-prompt-index">{total - i}</span>
              <span className="mono session-prompt-time">{clockTime(p.ts)}</span>
            </div>
            {p.ask
              ? <div className="session-prompt-ask">{p.ask}</div>
              : <div className="session-prompt-ask session-prompt-unshared">(prompt not shared)</div>}
            {p.files.length > 0 && (
              <div className="session-prompt-files">
                {p.files.map(f => <span key={f} className="mono session-prompt-file">{f}</span>)}
              </div>
            )}
            {checkpointsFor(prompts, checkpoints, i).map(c => (
              <div key={`${c.ts}|${c.text}`} className="session-prompt-checkpoint">
                <span className="session-prompt-checkpoint-label">Checkpoint</span>
                {c.text}
              </div>
            ))}
          </li>
        ))}
      </ol>
      {shown < total && (
        <button
          type="button"
          className="session-chain-more"
          onClick={() => setShown(n => Math.min(n + PROMPT_CHAIN_STEP, total))}
        >
          Show older prompts
        </button>
      )}
    </div>
  )
}
