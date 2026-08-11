import { useEffect, useState } from 'react'
import type { SharePromptsMode } from '../../data/types'
import { SettingRow } from './SettingRow'

/**
 * A user opens this row to answer: "What does my machine actually send to my
 * teammates on top of the session summary?" Three states, one plain sentence
 * each on what leaves the machine, exactly one selected. Historically this
 * decision was a boolean (`sharePrompts: true|false`) that silently promoted
 * a fresh install's default to full-verbatim if anyone had ever flipped it;
 * the three-value form makes that middle "distilled" ground its own,
 * explicitly-labelled option and turns the boolean-true case into a
 * SELECTED "Verbatim" state -- the audit trail for what would otherwise be
 * a silent promotion.
 *
 * The row hosts the docs link to the redaction boundary (link, never inline
 * -- the whole doc is not a settings-row length), so a user weighing
 * Verbatim can read what "redacted for shaped secrets" actually catches
 * before turning it on.
 */

interface OptionSpec {
  value: SharePromptsMode
  label: string
  description: string
}

// Order matches the on-wire progression from "sends nothing" to "sends
// everything", which is also the order the user reads them in when they
// weigh the decision. Not alphabetised.
const OPTIONS: OptionSpec[] = [
  {
    value: 'off',
    label: 'Off',
    description: 'Prompts and agent summaries stay on your machine.',
  },
  {
    value: 'distilled',
    label: 'Distilled',
    description: "Your teammates see the agent's short intent summary. Your prompts stay on your machine.",
  },
  {
    value: 'verbatim',
    label: 'Verbatim',
    description: 'Your teammates see the raw text of every prompt you send, redacted for shaped secrets and env values but not for prose secrets.',
  },
]

// TODO(docs-team): docs/security/redaction-boundary.md is not yet in this
// repo -- when it lands, replace this GitHub source-of-truth link with the
// hosted membridge.app URL the marketing site will surface. Kept as a link
// rather than an inline render on purpose (see the file header).
const REDACTION_BOUNDARY_URL = 'https://github.com/MembridgeAi/membridge/blob/master/docs/security/redaction-boundary.md'

interface SharePromptsControlProps {
  value: SharePromptsMode
  onChange: (next: SharePromptsMode) => Promise<void> | void
  /** A previous change is still in flight; the group must reject a second
   *  click so a user cannot queue up an opposite write while the first is
   *  pending. Same reason Toggle disables during a write. */
  pending: boolean
  /** The last write's failure message, or null. Rendered inline through
   *  SettingRow's own error slot -- one row, one message -- so a rejected
   *  save names the setting that failed. */
  error: string | null
}

export function SharePromptsControl({ value, onChange, pending, error }: SharePromptsControlProps) {
  // Local selection mirrors the incoming `value` but leads it during a
  // write, so the radio moves the moment a user clicks even though the
  // authoritative refresh only lands when settingsRefresh completes. If
  // the write is rejected, useEffect below snaps the selection BACK to the
  // last authoritative `value` -- there is no ghost-selected state.
  const [selected, setSelected] = useState<SharePromptsMode>(value)
  useEffect(() => { setSelected(value) }, [value])

  async function pick(next: SharePromptsMode) {
    if (next === selected || pending) return
    setSelected(next)
    try {
      await onChange(next)
    } catch {
      // The mutation reports its own error through `error` above; the
      // rollback of `selected` happens through the useEffect on `value`
      // once react-query restores the previous cache.
      setSelected(value)
    }
  }

  return (
    <SettingRow
      label="Share prompts with teammates"
      description="What this machine sends to your team alongside each session summary."
      testId="setting-share-prompts"
      error={error}
    >
      <fieldset
        className="share-prompts-fieldset"
        aria-label="Share prompts with teammates"
        disabled={pending}
      >
        {OPTIONS.map(opt => {
          const inputId = `share-prompts-${opt.value}`
          return (
            <label key={opt.value} className="share-prompts-option" htmlFor={inputId}>
              <input
                id={inputId}
                type="radio"
                name="share-prompts"
                value={opt.value}
                checked={selected === opt.value}
                // The <label> below carries both the mode name AND its full
                // per-option sentence, so its text content -- which is what
                // the accessible name resolves to -- would read as "Off
                // Prompts and agent summaries stay on your machine." An
                // explicit aria-label pins the accessible name to just the
                // mode name, which is what a screen reader user needs to
                // hear when they land on the radio; the sentence is
                // rendered visually and remains reachable by exploring the
                // label after selection.
                aria-label={opt.label}
                // onChange is what React counts as the accessibility-correct
                // event for a radio; onClick would fire even when the user
                // arrows into the option, which would double-write. This is
                // the same shape the design-system radios use.
                onChange={() => { void pick(opt.value) }}
              />
              <span className="share-prompts-option-label">{opt.label}</span>
              <span className="share-prompts-option-desc">{opt.description}</span>
            </label>
          )
        })}
      </fieldset>
      <a
        className="share-prompts-doc-link"
        href={REDACTION_BOUNDARY_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        What is redacted?
      </a>
    </SettingRow>
  )
}
