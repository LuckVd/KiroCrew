import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Slot } from './types'
import type { LaneSignals } from './board'

const sendTurn = vi.hoisted(() => vi.fn())

vi.mock('../../chat-core/transport/sendTurn', () => ({ sendTurn }))

import BroadcastPanel from './BroadcastPanel'

const slots: Slot[] = [
  { key: 'loop-busy', title: 'Babysit', running: true },
  { key: 'loop-idle', title: 'Runbook', running: false },
  { key: 'crew-loop', title: 'Astra', running: true, agent_kind: 'member' },
  { key: 'plain', title: 'Plain', running: false },
  // A crewmate chat with no kind stamp, recognised only through the roster.
  { key: 'kindless', title: 'Kindless', running: true, agent: 'astra' },
]
const agents = [{ name: 'astra', source: 'crew', selection_kind: 'member' as const }]

function setup(onClose = vi.fn()) {
  render(<BroadcastPanel slots={slots} folders={[]} tags={[]} agents={agents} signals={signals} onClose={onClose} />)
  return { onClose }
}

let signals: LaneSignals
beforeEach(() => {
  signals = {
    subagentStartedCounts: {}, subagentApprovalCounts: {}, workflowActiveSet: new Set(),
    automationRunningSet: new Set(['loop-busy', 'loop-idle', 'crew-loop', 'kindless']),
  }
  sendTurn.mockReset()
})
afterEach(() => { vi.clearAllMocks() })

describe('BroadcastPanel', () => {
  it('defaults to looping sessions with crewmates excluded', () => {
    setup()
    expect(screen.getByTestId('broadcast-crew-exclude').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('broadcast-row-loop-busy')).toBeTruthy()
    expect(screen.getByTestId('broadcast-row-loop-idle')).toBeTruthy()
    expect(screen.queryByTestId('broadcast-row-crew-loop')).toBeNull()
    expect(screen.queryByTestId('broadcast-row-plain')).toBeNull()
    expect(screen.queryByTestId('broadcast-row-kindless')).toBeNull()
  })

  it('labels a running row as a steer and an idle row as a new message', () => {
    setup()
    expect(screen.getByTestId('broadcast-row-loop-busy').textContent).toContain('Joins running turn')
    expect(screen.getByTestId('broadcast-row-loop-idle').textContent).toContain('Starts new turn')
  })

  it('brings crewmates in when included', () => {
    setup()
    fireEvent.click(screen.getByTestId('broadcast-crew-include'))
    expect(screen.getByTestId('broadcast-row-crew-loop')).toBeTruthy()
  })

  it('labels a session running a workflow as joining its turn, as the board would', () => {
    signals.workflowActiveSet = new Set(['loop-idle'])
    setup()
    expect(screen.getByTestId('broadcast-row-loop-idle').textContent).toContain('Joins running turn')
  })

  it('keeps naming unconfirmed rows after a retry clears the refusals', async () => {
    sendTurn.mockImplementation(async ({ slot }: { slot: string }) =>
      slot === 'loop-busy' ? { status: 'refused', body: {} } : { status: 'response-late', body: {} })
    setup()
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-error').textContent).toContain('1 not sent'))
    expect(screen.getByTestId('broadcast-error').textContent).toContain('1 could not be confirmed')
    sendTurn.mockResolvedValue({ status: 'dispatched', body: {} })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-row-loop-busy').textContent).toContain('Sent'))
    expect(screen.queryByTestId('broadcast-sent')).toBeNull()
    expect(screen.getByTestId('broadcast-error').textContent).toContain('1 could not be confirmed')
  })

  it('keeps Send disabled until there is text', () => {
    setup()
    expect((screen.getByTestId('broadcast-send') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: '  ' } })
    expect((screen.getByTestId('broadcast-send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('steers the trimmed text into every ticked target and confirms on success', async () => {
    sendTurn.mockResolvedValue({ status: 'dispatched', body: {} })
    const { onClose } = setup()
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: ' pause for CI ' } })
    // Untick one row: it must not be sent.
    fireEvent.click(screen.getByLabelText('Runbook'))
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-sent').textContent).toContain('Sent to 1'))
    // The panel stays open on the confirmation; Close is the user's call.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByTestId('broadcast-close').textContent).toBe('Close')
    expect(sendTurn).toHaveBeenCalledTimes(1)
    expect(sendTurn).toHaveBeenCalledWith({ message: 'pause for CI', slot: 'loop-busy', steer: true })
  })

  it('stays open on a refusal, never resends an unconfirmed row, and retries only the failed one', async () => {
    sendTurn.mockImplementation(async ({ slot }: { slot: string }) =>
      slot === 'loop-busy' ? { status: 'refused', body: {}, reason: 'slot is closed' } : { status: 'transport-error', body: {} })
    const { onClose } = setup()
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-row-loop-busy').textContent).toContain('Failed'))
    // A dropped connection may still have delivered: it is never resent.
    expect(screen.getByTestId('broadcast-row-loop-idle').textContent).toContain('May have been sent')
    // The reason is shown inline under its row, not only on hover.
    expect(screen.getByTestId('broadcast-reason-loop-busy').textContent).toContain('slot is closed')
    expect(onClose).not.toHaveBeenCalled()
    sendTurn.mockClear()
    sendTurn.mockResolvedValue({ status: 'dispatched', body: {} })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-row-loop-busy').textContent).toContain('Sent'))
    expect(sendTurn.mock.calls.map(c => c[0].slot)).toEqual(['loop-busy'])
  })

  it('moves a refused row to the top of the list', async () => {
    sendTurn.mockImplementation(async ({ slot }: { slot: string }) =>
      slot === 'loop-idle' ? { status: 'refused', body: {} } : { status: 'dispatched', body: {} })
    setup()
    expect(screen.getAllByTestId(/^broadcast-row-/)[0].getAttribute('data-testid')).toBe('broadcast-row-loop-busy')
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-row-loop-idle').textContent).toContain('Failed'))
    expect(screen.getAllByTestId(/^broadcast-row-/)[0].getAttribute('data-testid')).toBe('broadcast-row-loop-idle')
  })

  it('counts every row the broadcast reached once a retry clears the last failure', async () => {
    sendTurn.mockImplementation(async ({ slot }: { slot: string }) =>
      slot === 'loop-busy' ? { status: 'refused', body: {} } : { status: 'dispatched', body: {} })
    setup()
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-row-loop-busy').textContent).toContain('Failed'))
    sendTurn.mockResolvedValue({ status: 'dispatched', body: {} })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-sent').textContent).toContain('Sent to 2'))
  })

  it('keeps Cancel and the text locked while a batch is sending', async () => {
    let release: (v: unknown) => void = () => {}
    sendTurn.mockImplementation(() => new Promise(r => { release = r }))
    setup()
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect((screen.getByTestId('broadcast-close') as HTMLButtonElement).disabled).toBe(true))
    expect((screen.getByTestId('broadcast-message') as HTMLTextAreaElement).disabled).toBe(true)
    release({ status: 'dispatched', body: {} })
  })

  it('sends edited text to every matched row again after a partial failure', async () => {
    sendTurn.mockImplementation(async ({ slot }: { slot: string }) =>
      slot === 'loop-busy' ? { status: 'refused', body: {} } : { status: 'dispatched', body: {} })
    setup()
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'v1' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-row-loop-busy').textContent).toContain('Failed'))
    sendTurn.mockClear()
    sendTurn.mockResolvedValue({ status: 'dispatched', body: {} })
    fireEvent.change(screen.getByTestId('broadcast-message'), { target: { value: 'v2' } })
    fireEvent.click(screen.getByTestId('broadcast-send'))
    await waitFor(() => expect(screen.getByTestId('broadcast-sent')).toBeTruthy())
    expect(sendTurn.mock.calls.map(c => c[0].slot).sort()).toEqual(['loop-busy', 'loop-idle'])
  })

  it('switches to Custom when a custom state is picked', () => {
    setup()
    fireEvent.click(screen.getByTestId('broadcast-custom-toggle'))
    // The state chips start as the highlighted pick: only In a loop.
    expect(screen.getByTestId('broadcast-state-loop').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('broadcast-state-working').getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByTestId('broadcast-state-idle'))
    expect(screen.getByTestId('broadcast-preset-custom').getAttribute('aria-pressed')).toBe('true')
    // Custom states now: loop, idle -> the idle non-crewmate row joins.
    expect(screen.getByTestId('broadcast-row-plain')).toBeTruthy()
  })

  it('re-seeds the custom state chips from every quick pick', () => {
    setup()
    fireEvent.click(screen.getByTestId('broadcast-custom-toggle'))
    fireEvent.click(screen.getByTestId('broadcast-preset-waiting'))
    expect(screen.getByTestId('broadcast-state-needs_approval').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('broadcast-state-waiting').getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('broadcast-state-loop').getAttribute('aria-pressed')).toBe('false')
  })
})
