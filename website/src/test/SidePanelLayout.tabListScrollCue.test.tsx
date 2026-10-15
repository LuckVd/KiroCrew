/**
 * The desktop side-panel rail (Settings, Customize, Developer) scrolls its tab
 * list inside a fixed-height column, and the overlay scrollbar stays hidden
 * until hovered. Settings has enough rows that a laptop-height window clips the
 * last ones (Developer, Releases, About), and the list then reads as complete.
 * The cue is a "More below" control in its own strip under the list, driven by
 * the shared `useScrollEdgesY` measurement.
 *
 * These tests pin the wiring, and each names what reverting it breaks:
 *
 *   - a list that fits shows no control (revert symptom: a permanent cue lies
 *     that rows are hidden),
 *   - a clipped list shows it (revert symptom: no sign that rows sit below
 *     the fold, the original confusion),
 *   - it goes away once the list is scrolled to the end (needs the hook's
 *     scroll listener, not a one-shot read),
 *   - a click scrolls the list down and opens no tab (the control sits
 *     outside every row, so it cannot land on one),
 *   - it stays out of the tab order and the accessibility tree, where the
 *     rows already are.
 *
 * jsdom does no layout, so scroll geometry is stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import SidePanelLayout, { type SidePanelTab } from '../components/SidePanelLayout'

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }))

const TABS: SidePanelTab[] = [
  { key: 'overview', label: 'Overview', icon: null },
  { key: 'secrets', label: 'Secrets', icon: null, group: 'System' },
  { key: 'developer', label: 'Developer', icon: null, group: 'System' },
]

/** `hidden` px of rows below the fold, `scrolled` px already past the top. */
function stubGeometry({ hidden, scrolled = 0 }: { hidden: number; scrolled?: number }) {
  const proto = window.HTMLElement.prototype
  vi.spyOn(proto, 'clientHeight', 'get').mockReturnValue(400)
  vi.spyOn(proto, 'scrollHeight', 'get').mockReturnValue(400 + hidden)
  vi.spyOn(proto, 'scrollTop', 'get').mockReturnValue(scrolled)
}

function renderRail() {
  return render(
    <MemoryRouter initialEntries={['/settings']}>
      <SidePanelLayout title="Settings" tabs={TABS} rememberKey="test-tab-list-cue">
        {tab => <div data-testid="pane">{tab}</div>}
      </SidePanelLayout>
    </MemoryRouter>,
  )
}

const list = () => screen.getByTestId('side-panel-tab-list')
const more = () => screen.queryByTestId('side-panel-tab-list-more')

describe('side-panel rail: "More below" control on a clipped tab list', () => {
  beforeEach(() => {
    sessionStorage.clear()
    if (!window.ResizeObserver) {
      window.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver
    }
  })
  afterEach(() => { vi.restoreAllMocks(); cleanup() })

  it('shows nothing when every row fits', () => {
    stubGeometry({ hidden: 0 })
    renderRail()
    expect(more()).toBeNull()
  })

  it('shows the control when rows sit below the fold', () => {
    stubGeometry({ hidden: 120 })
    renderRail()
    expect(more()).not.toBeNull()
  })

  it('goes away once the list is scrolled to the end', () => {
    stubGeometry({ hidden: 120 })
    renderRail()
    vi.spyOn(window.HTMLElement.prototype, 'scrollTop', 'get').mockReturnValue(120)
    act(() => { fireEvent.scroll(list()) })
    expect(more()).toBeNull()
  })

  it('scrolls the list down on click and opens no tab', () => {
    stubGeometry({ hidden: 120 })
    const scrollBy = vi.fn()
    Object.defineProperty(window.HTMLElement.prototype, 'scrollBy', { value: scrollBy, configurable: true, writable: true })
    renderRail()
    const before = screen.getByTestId('pane').textContent
    fireEvent.click(more()!)
    expect(scrollBy).toHaveBeenCalledTimes(1)
    expect(scrollBy.mock.calls[0][0].top).toBeGreaterThan(0)
    expect(scrollBy.mock.instances[0]).toBe(list())
    expect(screen.getByTestId('pane').textContent).toBe(before)
  })

  it('stays out of the tab order and the accessibility tree', () => {
    stubGeometry({ hidden: 120 })
    renderRail()
    expect(more()).toHaveAttribute('tabindex', '-1')
    expect(more()).toHaveAttribute('aria-hidden', 'true')
    // The rows it points at are still real, reachable buttons.
    fireEvent.click(screen.getByRole('button', { name: 'Developer' }))
    expect(screen.getByTestId('pane').textContent).toBe('developer')
  })
})
