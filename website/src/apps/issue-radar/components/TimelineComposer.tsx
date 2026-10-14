// The comment box at the head of a detail pane's timeline.
//
// One box for the issue pane and the pull-request pane. The caller supplies the write
// (`post`) and the refresh that follows it, because an issue and a pull request are
// different routes on GitLab and Azure DevOps and the two panes cache under different
// query keys. The draft, the keys and the failure notice are shared.
//
//  * **A failed post keeps the draft.** The text stays and the forge's reason shows
//    under it, so a transient error does not cost a paragraph.
//  * **A late result is dropped.** The panes are reused when the reader moves to
//    another item, and a post can settle after that. `epoch` ties a result to the item
//    it was sent for, so it can neither clear nor blame the next item's draft.
//  * **One column.** The textarea is full width and the button row wraps, so the box
//    needs no narrow-width branch.
import { useEffect, useRef, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Btn } from '../../../components/ui'
import ErrorNotice from '../../../components/ErrorNotice'
import { useImeGuard } from '../../../hooks/useImeGuard'
import { i18nT } from '../../../i18n/t'

export default function TimelineComposer({ itemKey, post }: {
  /** Names the item written to. A change drops the draft and any in-flight result. */
  itemKey: string | number
  /** Posts `body` to the item and refreshes its timeline. Resolves once the forge
   * accepted the comment and rejects with the forge's reason. */
  post: (body: string) => Promise<unknown>
}) {
  const ime = useImeGuard()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const epoch = useRef(0)

  useEffect(() => {
    epoch.current += 1
    setText('')
    setError(null)
    setBusy(false)
  }, [itemKey])

  const submit = async () => {
    const body = text.trim()
    if (!body || busy) return
    const sentFor = epoch.current
    setBusy(true)
    setError(null)
    try {
      await post(body)
      if (sentFor === epoch.current) setText('')
    } catch (e) {
      if (sentFor === epoch.current) setError(e as Error)
    } finally {
      if (sentFor === epoch.current) setBusy(false)
    }
  }

  return (
    <div className="mb-4">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        {...ime.bindComposition<HTMLTextAreaElement>()}
        onKeyDown={(e) => {
          // Escape discards a draft and stops there: the pull request list listens for
          // Escape on `window` to clear a bulk selection, and discarding a comment must
          // not disarm it. With nothing to discard the key is left to bubble.
          if (e.key === 'Escape' && (text || error)) {
            e.preventDefault()
            e.stopPropagation()
            setText('')
            setError(null)
          }
          // Cmd/Ctrl+Enter sends. A bare Enter stays a newline: comments are prose.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { if (ime.claimEnter(e)) submit() }
        }}
        placeholder={i18nT('apps.issueRadar.components.prActionsBar.comment_placeholder')}
        aria-label={i18nT('apps.issueRadar.components.prActionsBar.comment_title')}
        rows={3}
        className="w-full bg-bg-elevated border border-border rounded-md px-2.5 py-2 text-[13px] text-text placeholder:text-muted outline-hidden resize-y transition-colors focus-ring font-body"
      />
      {/* No hand-off: the comment draft typed in the textarea above is unsaved, and the
          failure shows precisely because it did not post. */}
      <ErrorNotice message={error?.message} className="mt-1.5" />
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <Btn primary onClick={submit} disabled={!text.trim() || busy}>
          {busy
            ? <Loader2 className="lucide-inline animate-spin" />
            : <Check className="lucide-inline" />}
          {i18nT('apps.issueRadar.components.prActionsBar.comment_submit')}
        </Btn>
        <span className="text-[11px] text-muted">
          {i18nT('apps.issueRadar.components.prActionsBar.submit_hint')}
        </span>
      </div>
    </div>
  )
}
