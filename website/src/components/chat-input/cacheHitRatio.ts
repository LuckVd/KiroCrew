import { useQuery } from '@tanstack/react-query'
import { api } from '../../api/client'
import { crewLogProjectionsKey } from '../../hooks/websocket/sessionProjection'

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/** A token count, or 0 for anything a count cannot be: absent, negative, NaN, a string. */
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The share of a session's input tokens served from the prompt cache, from the
 *  crew log's `usage` fold: cache reads over cache reads, cache writes and
 *  uncached input (the fold's four token counts are disjoint).
 *
 *  `null` says "nothing to show", never zero. A backend that sends no token
 *  counts, or sends input tokens but no cache counts, leaves both cache counts at
 *  0, which would compute to a 0% miss. Only a non-zero cache count proves the
 *  backend reports cache at all, so without one there is no ratio. */
export function cacheHitRatio(read: unknown): number | null {
  const tokens = rec(rec(rec(rec(read).folds).usage).value).tokens
  const hits = count(rec(tokens).cache_read)
  const writes = count(rec(tokens).cache_write)
  if (hits + writes === 0) return null
  const total = hits + writes + count(rec(tokens).input)
  return Number.isFinite(total) ? hits / total : null
}

/** The ratio for the context popover. It reads the entry the Crew Log tab fills,
 *  lazily on open like the auto-compact threshold beside it, so a pushed
 *  `session_projection` frame keeps it current. A failed read shows nothing, the
 *  same as a backend with no counts; the popover's other rows are unaffected. */
export function useCacheHitRatio({ activeSlot, ctxPopoverOpen }: {
  activeSlot: string | null
  ctxPopoverOpen: boolean
}): number | null {
  const { data } = useQuery({
    queryKey: crewLogProjectionsKey(activeSlot ?? ''),
    queryFn: () => api.sessionCrewLogProjections(activeSlot as string),
    enabled: ctxPopoverOpen && !!activeSlot,
    staleTime: 30_000,
  })
  return cacheHitRatio(data)
}
