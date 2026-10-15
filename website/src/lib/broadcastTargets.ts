/** Which open sessions a broadcast reaches, and how each one receives it.
 *
 *  Pure: the sidebar's broadcast panel hands in the live slot rows, the set of
 *  slot keys with an active loop, and the folder tree, and draws whatever this
 *  returns. Every send goes out as a steer (`/api/chat` with `steer: true`):
 *  a running turn takes it in once its current tool call ends, and an idle
 *  session starts a new turn with it, so `deliveryFor` only labels the row. */
import { slotIsRemoteBound } from '../store/dashboardSlice'
import { hasLiveSessionWork, inferLane, type LaneExtras, type SessionLaneKey } from '../pages/chat/sessionLane'

/** A quick pick. `custom` hands the choice to the custom criteria. */
export type BroadcastPreset = 'loop' | 'running' | 'waiting' | 'all' | 'custom'

/** Crewmate chats: only them, alongside the rest, or left out (the default). */
export type CrewmateMode = 'only' | 'include' | 'exclude'

/** The states a custom broadcast can pick from; a row matches when it is in ANY
 *  picked state. The turn states are the board's own lanes (`inferLane`, fed
 *  the same extras), so a session is classed here as the board files it. `loop` is a
 *  mode, not a turn state, so a looping row is in a lane at the same time. */
export type BroadcastState = 'loop' | SessionLaneKey

export const BROADCAST_STATES: readonly BroadcastState[] = ['loop', 'needs_approval', 'waiting', 'working', 'idle']

/** The states each quick pick stands for. `waiting` covers both lanes that owe
 *  the user something: an approval and an answer. */
export const PRESET_STATES: Record<'loop' | 'running' | 'waiting' | 'all', readonly BroadcastState[]> = {
  loop: ['loop'],
  running: ['working'],
  waiting: ['needs_approval', 'waiting'],
  all: BROADCAST_STATES,
}

export interface BroadcastCriteria {
  preset: BroadcastPreset
  crewmates: CrewmateMode
  /** Custom only: states, matched as ANY. Empty matches nothing. */
  states: readonly BroadcastState[]
  /** Custom only: a folder, its sub-folders included. */
  folderId?: string
  /** Custom only: a tag the row must carry. */
  tagId?: string
  /** Custom only: pinned rows alone. */
  pinnedOnly?: boolean
  /** Custom only: rows with activity inside this many milliseconds of `now`. */
  activeWithinMs?: number
}

/** The slot fields the targeting reads. */
export interface BroadcastSlot {
  key: string
  running: boolean
  agent?: string
  agent_kind?: string
  folder_id?: string
  tags?: string[]
  pinned?: boolean
  needs_input?: boolean
  pending_approval?: boolean
  has_options?: boolean
  interrupted?: boolean
  subagents_running?: boolean
  queue_depth?: number
  last_ts?: string
  /** Present only on a row owned by a connected peer; never a broadcast target. */
  peer_id?: string
  /** `remote` marks a relay archive, which refuses every send. */
  executor?: string
}

export interface BroadcastFolder {
  id: string
  parent_id?: string
}

/** How a row receives the message: injected into its running turn, or as a new turn. */
export type BroadcastDelivery = 'steer' | 'new'

/** Context every match reads. `isCrewmate` is the caller's crewmate test, so
 *  a kind-less slot can still be recognised through the agent roster.
 *  `extrasFor` supplies the live signals outside the slot payload (sub-agent
 *  approvals, workflows, goal loops); the sidebar passes the board's own
 *  `laneExtrasFor`, so a session lands in the same lane in both places. */
export interface BroadcastContext {
  folders: readonly BroadcastFolder[]
  now: number
  isCrewmate: (slot: BroadcastSlot) => boolean
  extrasFor: (slot: BroadcastSlot) => LaneExtras
}

/** Every state *slot* is in right now: its board lane, plus `loop` when armed. */
export function slotBroadcastStates(slot: BroadcastSlot, extras: LaneExtras = {}): Set<BroadcastState> {
  const states = new Set<BroadcastState>([inferLane(slot, extras)])
  if (extras.goalLoopActive) states.add('loop')
  return states
}

export function deliveryFor(slot: BroadcastSlot, extras: LaneExtras = {}): BroadcastDelivery {
  return hasLiveSessionWork(slot, extras) ? 'steer' : 'new'
}

/** *folderId* and every folder nested under it. */
export function folderSubtree(folderId: string, folders: readonly BroadcastFolder[]): Set<string> {
  const out = new Set([folderId])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders) {
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
    }
  }
  return out
}

function presetMatches(preset: Exclude<BroadcastPreset, 'custom'>, states: Set<BroadcastState>): boolean {
  return PRESET_STATES[preset].some(s => states.has(s))
}

/** Whether this session can take a message at all. */
export function canReceiveBroadcast(slot: BroadcastSlot): boolean {
  return !slot.peer_id && !slotIsRemoteBound(slot)
}

/** Whether *slot* is a target under *criteria*. */
export function matchesBroadcast(
  slot: BroadcastSlot,
  criteria: BroadcastCriteria,
  ctx: BroadcastContext,
): boolean {
  // Sessions that cannot take a message are never matched: a peer's row is
  // not ours to send to, and a relay archive refuses every send (409
  // `relay_archive_read_only`), so counting either would promise a delivery
  // the server will refuse.
  if (!canReceiveBroadcast(slot)) return false
  const crew = ctx.isCrewmate(slot)
  if (criteria.crewmates === 'only' && !crew) return false
  if (criteria.crewmates === 'exclude' && crew) return false
  const states = slotBroadcastStates(slot, ctx.extrasFor(slot))
  if (criteria.preset !== 'custom') return presetMatches(criteria.preset, states)
  if (!criteria.states.some(s => states.has(s))) return false
  if (criteria.folderId) {
    if (!slot.folder_id || !folderSubtree(criteria.folderId, ctx.folders).has(slot.folder_id)) return false
  }
  if (criteria.tagId && !(slot.tags ?? []).includes(criteria.tagId)) return false
  if (criteria.pinnedOnly && !slot.pinned) return false
  if (criteria.activeWithinMs) {
    const ts = slot.last_ts ? Date.parse(slot.last_ts) : NaN
    if (!Number.isFinite(ts) || ctx.now - ts > criteria.activeWithinMs) return false
  }
  return true
}

/** The rows *criteria* reaches, in the order given. */
export function broadcastTargets<T extends BroadcastSlot>(
  slots: readonly T[],
  criteria: BroadcastCriteria,
  ctx: BroadcastContext,
): T[] {
  return slots.filter(s => matchesBroadcast(s, criteria, ctx))
}
