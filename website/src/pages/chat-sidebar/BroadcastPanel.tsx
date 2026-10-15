/** The header menu's "Broadcast message" panel: one message, steered into every
 *  open session a quick pick (or the custom criteria) reaches.
 *
 *  Every target gets the same `/api/chat` send with `steer: true`. A running
 *  turn takes the text in once its current tool call ends; an idle session
 *  starts a new turn with it. The row label says which, so the count on the
 *  Send button can be reconciled with what each session will do. */
import { useState } from 'react'
import { Megaphone } from 'lucide-react'
import { isCrewmateChat } from '../../components/AgentDropdownList'
import ErrorNotice from '../../components/ErrorNotice'
import { Btn } from '../../components/ui'
import { NativeSelect, NativeSelectOption } from '../../components/ui/native-select'
import { sendTurn } from '../../chat-core/transport/sendTurn'
import { i18nT } from '../../i18n/t'
import {
  BROADCAST_STATES, PRESET_STATES, broadcastTargets, deliveryFor,
  type BroadcastCriteria, type BroadcastPreset, type BroadcastSlot, type BroadcastState, type CrewmateMode,
} from '../../lib/broadcastTargets'
import type { ChatFolder, ChatTag } from '../../types'
import { laneExtrasFor, type LaneSignals } from './board'
import { DisclosureChevron } from './chrome'
import type { AgentInfo, Slot } from './types'

const PRESETS: readonly Exclude<BroadcastPreset, 'custom'>[] = ['loop', 'running', 'waiting', 'all']
const CREW_MODES: readonly CrewmateMode[] = ['only', 'include', 'exclude']
const DAY_MS = 24 * 3600_000
/** Sends in flight at once: enough to finish a wide broadcast quickly without
 *  opening one POST per session against the gateway in the same instant. */
const SEND_CONCURRENCY = 4

type RowResult = 'sending' | 'sent' | 'failed' | 'unknown'

const PRESET_KEYS: Record<Exclude<BroadcastPreset, 'custom'>, string> = {
  loop: 'pages.chatSidebar.broadcast_preset_loop',
  running: 'pages.chatSidebar.broadcast_preset_running',
  waiting: 'pages.chatSidebar.broadcast_preset_waiting',
  all: 'pages.chatSidebar.broadcast_preset_all',
}
/** The turn states use the board lanes' own labels, so a state reads the same
 *  here as in the board view. */
const STATE_KEYS: Record<BroadcastState, string> = {
  loop: 'pages.chatSidebar.broadcast_state_loop',
  needs_approval: 'pages.chatSidebar.lane_needs_approval',
  waiting: 'pages.chatSidebar.lane_waiting',
  working: 'pages.chatSidebar.lane_working',
  idle: 'pages.chatSidebar.lane_idle',
}
const CREW_KEYS: Record<CrewmateMode, string> = {
  only: 'pages.chatSidebar.broadcast_crew_only',
  include: 'pages.chatSidebar.broadcast_crew_include',
  exclude: 'pages.chatSidebar.broadcast_crew_exclude',
}
const RESULT_KEYS: Record<RowResult, string> = {
  sending: 'pages.chatSidebar.broadcast_row_sending',
  sent: 'pages.chatSidebar.broadcast_row_sent',
  failed: 'pages.chatSidebar.broadcast_row_failed',
  unknown: 'pages.chatSidebar.broadcast_row_unknown',
}

const chipCls = (on: boolean) =>
  `px-2.5 py-1 rounded-full text-[12px] ${on ? 'bg-accent text-accent-fg border-accent hover:bg-accent-hover' : ''}`

/** Run *task* over *items* with at most *limit* in flight. */
async function runPool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

export default function BroadcastPanel({ slots, folders, tags, agents, signals, onClose }: {
  slots: readonly Slot[]
  /** The board's live lane signals, so each session is classed as the board files it. */
  signals: LaneSignals
  /** The agent roster, so a crewmate chat with no kind stamp is still recognised. */
  agents: readonly AgentInfo[]
  folders: readonly ChatFolder[]
  tags: readonly ChatTag[]
  onClose: () => void
}) {
  const [message, setMessage] = useState('')
  const [preset, setPreset] = useState<BroadcastPreset>('loop')
  const [crewmates, setCrewmates] = useState<CrewmateMode>('exclude')
  const [customOpen, setCustomOpen] = useState(false)
  // Seeded from the default pick and re-seeded on every pick, so the custom
  // checkboxes always show what the highlighted pick means.
  const [states, setStates] = useState<readonly BroadcastState[]>(PRESET_STATES.loop)
  const [folderId, setFolderId] = useState('')
  const [tagId, setTagId] = useState('')
  const [pinnedOnly, setPinnedOnly] = useState(false)
  const [recentOnly, setRecentOnly] = useState(false)
  // Rows the user unticked, and rows a send already settled (so a second
  // press retries only what did not go out).
  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set())
  const [results, setResults] = useState<Record<string, RowResult>>({})
  // The server's own reason per refused row, shown under that row.
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  // Set once a press leaves nothing failed or unknown; the line then counts
  // every row this broadcast reached, earlier presses included.
  const [sentCount, setSentCount] = useState(0)

  const now = Date.now()
  const isCrewmate = (s: BroadcastSlot) => isCrewmateChat(s.agent_kind, s.agent ?? '', agents)
  const extrasFor = (s: BroadcastSlot) => laneExtrasFor(s.key, signals)
  const ctx = { folders, now, isCrewmate, extrasFor }
  const criteria: BroadcastCriteria = {
    preset, crewmates, states,
    folderId: folderId || undefined,
    tagId: tagId || undefined,
    pinnedOnly,
    activeWithinMs: recentOnly ? DAY_MS : undefined,
  }
  // Refused rows first, so a failure and its reason are never scrolled away.
  const matched = broadcastTargets(slots, criteria, ctx)
  const targets = [...matched.filter(s => results[s.key] === 'failed'), ...matched.filter(s => results[s.key] !== 'failed')]
  const presetCount = (p: Exclude<BroadcastPreset, 'custom'>) =>
    broadcastTargets(slots, { ...criteria, preset: p }, ctx).length
  const settled = (key: string) => results[key] === 'sent' || results[key] === 'unknown'
  const chosen = targets.filter(s => !unticked.has(s.key) && !settled(s.key))
  const text = message.trim()

  const toggleState = (s: BroadcastState) =>
    setStates(prev => (prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]))
  const toggleRow = (key: string) =>
    setUnticked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const pickPreset = (p: BroadcastPreset) => {
    setPreset(p)
    if (p === 'custom') setCustomOpen(true)
    else setStates(PRESET_STATES[p])
  }
  const folderName = (id?: string) => (id ? folders.find(f => f.id === id)?.name : undefined)

  const send = async () => {
    if (!text || chosen.length === 0 || sending) return
    setSending(true)
    setError('')
    setSentCount(0)
    const batch = chosen.map(s => s.key)
    setResults(prev => ({ ...prev, ...Object.fromEntries(batch.map(k => [k, 'sending' as const])) }))
    const outcome: Record<string, RowResult> = {}
    await runPool(batch, SEND_CONCURRENCY, async (slot) => {
      const receipt = await sendTurn({ message: text, slot, steer: true })
      // Only an explicit refusal is safe to retry. A late, unreadable or
      // dropped-connection receipt may have reached the server, which
      // dispatches before it answers, so a resend could deliver twice.
      const r: RowResult = receipt.status === 'dispatched' || receipt.status === 'queued'
        ? 'sent'
        : receipt.status === 'refused' ? 'failed' : 'unknown'
      outcome[slot] = r
      setResults(prev => ({ ...prev, [slot]: r }))
      if (receipt.status === 'refused' && receipt.reason) {
        const reason = receipt.reason
        setReasons(prev => ({ ...prev, [slot]: reason }))
      }
    })
    setSending(false)
    // Judged over the whole broadcast, not this press: an unconfirmed row from
    // an earlier press is still unconfirmed after a retry clears the refusals.
    const all = { ...results, ...outcome }
    const failed = Object.values(all).filter(r => r === 'failed').length
    const unknown = Object.values(all).filter(r => r === 'unknown').length
    // A full success keeps the panel open on a confirmation, so the user can
    // see where the message went; each row already says Sent.
    if (failed === 0 && unknown === 0) {
      setSentCount(1)
      return
    }
    const parts: string[] = []
    if (failed > 0) parts.push(i18nT('pages.chatSidebar.broadcast_failed_some', { n: failed }))
    if (unknown > 0) parts.push(i18nT('pages.chatSidebar.broadcast_unknown_some', { n: unknown }))
    setError(parts.join(' '))
  }

  return (
    <div data-testid="broadcast-panel" className="mx-2 mb-2 p-3 rounded-lg bg-bg border border-border shadow-md text-sm animate-rise">
      <div className="font-medium text-text-strong mb-2"><Megaphone size={14} className="lucide-inline" /> {i18nT('pages.chatSidebar.broadcast_title')}</div>
      <textarea
        aria-label={i18nT('pages.chatSidebar.broadcast_message_label')}
        data-testid="broadcast-message"
        value={message}
        onChange={e => {
          setMessage(e.target.value)
          // New text is a new broadcast: every matched row gets it, including
          // the ones that already received the old text.
          if (Object.keys(results).length) { setResults({}); setReasons({}); setError(''); setSentCount(0) }
        }}
        disabled={sending}
        placeholder={i18nT('pages.chatSidebar.broadcast_placeholder')}
        rows={3}
        className="w-full resize-y rounded-md border border-border bg-bg-elevated text-text p-2 text-[13px] outline-hidden focus-visible:border-accent mb-2"
      />

      <div className="text-[11px] text-muted mb-1">{i18nT('pages.chatSidebar.broadcast_send_to')}</div>
      <div className="flex flex-wrap gap-1 mb-2" role="group" aria-label={i18nT('pages.chatSidebar.broadcast_send_to')}>
        {PRESETS.map(p => (
          <Btn key={p} data-testid={`broadcast-preset-${p}`} aria-pressed={preset === p} className={chipCls(preset === p)} onClick={() => pickPreset(p)}>
            {i18nT(PRESET_KEYS[p])} · {presetCount(p)}
          </Btn>
        ))}
        <Btn data-testid="broadcast-preset-custom" aria-pressed={preset === 'custom'} className={chipCls(preset === 'custom')} onClick={() => pickPreset('custom')}>
          {i18nT('pages.chatSidebar.broadcast_preset_custom')}
        </Btn>
      </div>

      <div className="text-[11px] text-muted">{i18nT('pages.chatSidebar.broadcast_crewmates')}</div>
      <div className="text-[11px] text-muted mb-1">{i18nT('pages.chatSidebar.broadcast_crewmates_hint')}</div>
      {/* One segmented control: three equal cells inside a shared border, so
          the row never grows past the panel and a long label truncates
          instead of wrapping onto a second line. */}
      <div className="flex mb-2 rounded-md border border-border overflow-hidden" role="group" aria-label={i18nT('pages.chatSidebar.broadcast_crewmates')}>
        {CREW_MODES.map(m => (
          <Btn
            key={m}
            data-testid={`broadcast-crew-${m}`}
            aria-pressed={crewmates === m}
            title={i18nT(CREW_KEYS[m])}
            className={`flex-1 min-w-0 justify-center rounded-none border-0 border-e border-border last:border-e-0 px-1 py-1 text-[12px] ${crewmates === m ? 'bg-accent text-accent-fg hover:bg-accent-hover' : ''}`}
            onClick={() => setCrewmates(m)}
          >
            <span className="truncate">{i18nT(CREW_KEYS[m])}</span>
          </Btn>
        ))}
      </div>

      <Btn
        data-testid="broadcast-custom-toggle"
        aria-expanded={customOpen}
        className="w-full justify-between text-[12px] mb-1"
        onClick={() => setCustomOpen(o => !o)}
      >
        <span>{i18nT('pages.chatSidebar.broadcast_custom_criteria')}</span>
        <DisclosureChevron open={customOpen} size={14} />
      </Btn>
      {customOpen && (
        <div data-testid="broadcast-custom" className="rounded-md border border-border p-2 mb-2">
          {preset !== 'custom' && (
            <div className="text-[12px] text-muted mb-1">{i18nT('pages.chatSidebar.broadcast_custom_hint')}</div>
          )}
          <div className="text-[11px] text-muted mb-1">{i18nT('pages.chatSidebar.broadcast_states_any')}</div>
          <div className="flex flex-wrap gap-1 mb-2" role="group" aria-label={i18nT('pages.chatSidebar.broadcast_states_any')}>
            {BROADCAST_STATES.map(s => (
              <Btn key={s} data-testid={`broadcast-state-${s}`} aria-pressed={states.includes(s)} className={chipCls(states.includes(s))} onClick={() => { setPreset('custom'); toggleState(s) }}>
                {i18nT(STATE_KEYS[s])}
              </Btn>
            ))}
          </div>
          <div className="text-[11px] text-muted mb-1">{i18nT('pages.chatSidebar.broadcast_scope_all')}</div>
          <div className="flex flex-col gap-1.5">
            <NativeSelect className="py-1 [@media(pointer:fine)]:text-[13px]" aria-label={i18nT('pages.chatSidebar.broadcast_folder')} value={folderId} onChange={e => { setPreset('custom'); setFolderId(e.target.value) }}>
              <NativeSelectOption value="">{i18nT('pages.chatSidebar.broadcast_any_folder')}</NativeSelectOption>
              {folders.map(f => <NativeSelectOption key={f.id} value={f.id}>{f.name}</NativeSelectOption>)}
            </NativeSelect>
            <NativeSelect className="py-1 [@media(pointer:fine)]:text-[13px]" aria-label={i18nT('pages.chatSidebar.broadcast_tag')} value={tagId} onChange={e => { setPreset('custom'); setTagId(e.target.value) }}>
              <NativeSelectOption value="">{i18nT('pages.chatSidebar.broadcast_any_tag')}</NativeSelectOption>
              {tags.map(t => <NativeSelectOption key={t.id} value={t.id}>{t.name}</NativeSelectOption>)}
            </NativeSelect>
            <label className="flex items-center gap-2 text-[12px] text-text cursor-pointer">
              <input type="checkbox" aria-label={i18nT('pages.chatSidebar.broadcast_pinned_only')} checked={pinnedOnly} onChange={e => { setPreset('custom'); setPinnedOnly(e.target.checked) }} />
              {i18nT('pages.chatSidebar.broadcast_pinned_only')}
            </label>
            <label className="flex items-center gap-2 text-[12px] text-text cursor-pointer">
              <input type="checkbox" aria-label={i18nT('pages.chatSidebar.broadcast_active_24h')} checked={recentOnly} onChange={e => { setPreset('custom'); setRecentOnly(e.target.checked) }} />
              {i18nT('pages.chatSidebar.broadcast_active_24h')}
            </label>
          </div>
        </div>
      )}

      <div data-testid="broadcast-count" role="status" className="text-[11px] text-muted mt-2 mb-1">
        {i18nT('pages.chatSidebar.broadcast_matched', { n: targets.length })}
      </div>
      {targets.length > 0 && (
        <ul className="max-h-[200px] overflow-y-auto rounded-md border border-border bg-bg-elevated px-2 mb-2" aria-label={i18nT('pages.chatSidebar.broadcast_targets')}>
          {targets.map(s => {
            const result = results[s.key]
            const ticked = !unticked.has(s.key)
            const folder = folderName(s.folder_id)
            return (
              <li key={s.key} data-testid={`broadcast-row-${s.key}`} className="py-1.5 border-b border-border last:border-b-0 text-[12px]">
                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                    <input type="checkbox" aria-label={s.title || i18nT('pages.chatSidebar.broadcast_untitled')} checked={ticked && !settled(s.key)} disabled={sending || settled(s.key)} onChange={() => toggleRow(s.key)} />
                    <span className="truncate text-text">{s.title || i18nT('pages.chatSidebar.broadcast_untitled')}</span>
                    {folder && <span className="truncate text-muted shrink-[2]">{folder}</span>}
                  </label>
                  <span className={`shrink-0 ${result === 'failed' ? 'text-danger' : 'text-muted'}`}>
                    {result
                      ? i18nT(RESULT_KEYS[result])
                      : deliveryFor(s, extrasFor(s)) === 'steer'
                        ? i18nT('pages.chatSidebar.broadcast_row_steer')
                        : i18nT('pages.chatSidebar.broadcast_row_new')}
                  </span>
                </div>
                {/* No hand-off: the broadcast text above is not saved anywhere,
                    and the navigation a hand-off makes would unmount it. */}
                {result === 'failed' && reasons[s.key] && (
                  <ErrorNotice message={reasons[s.key]} className="mt-1" testId={`broadcast-reason-${s.key}`} />
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* No hand-off: the broadcast text above is not saved anywhere, and the
          navigation a hand-off makes would unmount this panel and lose it. */}
      <ErrorNotice message={error} className="mb-2" testId="broadcast-error" />
      {sentCount > 0 && (
        <div data-testid="broadcast-sent" role="status" className="text-[12px] text-ok mb-2">
          {i18nT('pages.chatSidebar.broadcast_sent_all', { n: Object.values(results).filter(r => r === 'sent').length })}
        </div>
      )}
      <div className="flex items-center gap-2 justify-end">
        {/* Disabled while sending: closing would not stop the sends already
            under way, and the batch would close a panel reopened meanwhile. */}
        <Btn data-testid="broadcast-close" className="text-[12px] px-3 py-1" disabled={sending} onClick={onClose}>
          {Object.keys(results).length ? i18nT('pages.chatSidebar.close') : i18nT('pages.chatSidebar.cancel')}
        </Btn>
        <Btn
          primary
          data-testid="broadcast-send"
          className="text-[12px] px-3 py-1"
          disabled={!text || chosen.length === 0 || sending}
          onClick={() => { void send() }}
        >
          {sending ? i18nT('pages.chatSidebar.broadcast_sending') : i18nT('pages.chatSidebar.broadcast_send', { n: chosen.length })}
        </Btn>
      </div>
    </div>
  )
}
