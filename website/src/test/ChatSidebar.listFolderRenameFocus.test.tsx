/**
 * #13598 — ChatSidebar list-view folder rename: Enter and Escape restore focus
 * to the folder header row; a pointer blur moves nothing.
 *
 * Opens the rename editor via the ContextMenu Rename item
 * (data-testid `folder-rename-${FOLDER_ID}-ctx`). The ContextMenu family is
 * fully mocked to render its content synchronously so menu items are always
 * accessible in happy-dom without a real right-click gesture.
 *
 * useFolderRename focuses the input via requestAnimationFrame after the edit
 * state is set, so the tests wait one extra frame after opening the editor
 * before asserting document.activeElement.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Provider } from 'react-redux'
import { MemoryRouter } from 'react-router-dom'
import { createTestStore } from './helpers'
import type { RootState } from '../store'
import { ThemeProvider } from '../hooks/useTheme'
import type { ChatFolder } from '../types'

vi.mock('framer-motion', async () => {
  const React = await import('react')
  const FRAMER_PROPS = new Set([
    'layout', 'layoutId', 'layoutScroll', 'initial', 'animate', 'exit',
    'transition', 'variants', 'whileHover', 'whileTap', 'whileInView',
    'drag', 'dragConstraints', 'dragElastic', 'onAnimationComplete',
  ])
  // Stable cache prevents remounts when motion.div is accessed across renders.
  const cache = new Map<string, ReturnType<typeof React.forwardRef>>()
  const make = (tag: string) => {
    if (!cache.has(tag)) {
      cache.set(tag, React.forwardRef((props: Record<string, unknown>, ref: React.Ref<unknown>) => {
        const clean: Record<string, unknown> = {}
        for (const k of Object.keys(props)) {
          if (k === 'children') continue
          if (k === 'layoutId') { clean['data-layout-id'] = props[k]; continue }
          if (FRAMER_PROPS.has(k)) continue
          clean[k] = props[k]
        }
        return React.createElement(tag, { ...clean, ref }, props.children as React.ReactNode)
      }))
    }
    return cache.get(tag)!
  }
  const motion = new Proxy({}, { get: (_t, tag: string) => make(tag) })
  return {
    motion,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    LayoutGroup: ({ children }: { children?: React.ReactNode }) => React.createElement(React.Fragment, null, children),
  }
})

vi.mock('../components/ProjectPicker', () => ({ default: () => null }))
vi.mock('../components/SessionActionsMenu', () => ({ default: () => null, SessionActionsMenu: () => null }))

// FolderMoveSubmenu is irrelevant to the focus contract being tested here.
vi.mock('../components/FolderMoveSubmenu', () => ({ default: () => null }))

/**
 * Mock the entire ContextMenu family so that:
 *  • ContextMenu: renders both its trigger and content immediately (no portal,
 *    no right-click gate) — the rename item is always accessible.
 *  • ContextMenuTrigger: pass-through (no Radix event capture).
 *  • ContextMenuContent: renders as a plain div[role=menu].
 *  • ContextMenuItem: renders as a button[role=menuitem] with the onClick intact.
 *
 * This lets us click `data-testid="folder-rename-${FOLDER_ID}-ctx"` directly
 * instead of performing a real right-click gesture in happy-dom.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = Record<string, any>
vi.mock('../components/ui/context-menu', async () => {
  const React = await import('react')
  return {
    ContextMenu: ({ children }: AnyProps) => React.createElement(React.Fragment, null, children),
    ContextMenuTrigger: ({ children }: AnyProps) => children,
    ContextMenuContent: ({ children, 'data-testid': dtid }: AnyProps) =>
      React.createElement('div', { role: 'menu', 'data-testid': dtid }, children),
    ContextMenuItem: ({ children, onClick, 'data-testid': dtid, className }: AnyProps) =>
      React.createElement('button', { type: 'button', role: 'menuitem', onClick, 'data-testid': dtid, className }, children),
    ContextMenuSeparator: () => React.createElement('hr'),
    ContextMenuSub: ({ children }: AnyProps) => React.createElement(React.Fragment, null, children),
    ContextMenuSubTrigger: ({ children }: AnyProps) => children,
    ContextMenuSubContent: () => null,
    ContextMenuLabel: ({ children }: AnyProps) => React.createElement('div', null, children),
    ContextMenuCheckboxItem: ({ children, onCheckedChange, checked }: AnyProps) =>
      React.createElement('button', { type: 'button', role: 'menuitemcheckbox', onClick: () => onCheckedChange?.(!checked) }, children),
    ContextMenuRadioGroup: ({ children }: AnyProps) => React.createElement(React.Fragment, null, children),
    ContextMenuRadioItem: ({ children, onClick }: AnyProps) =>
      React.createElement('button', { type: 'button', role: 'menuitemradio', onClick }, children),
  }
})

vi.mock('../pages/chat/ChatSettings', () => ({
  loadChatConfig: () => ({ tagColumnsEnabled: false, confirmCloseSession: false }),
  saveChatConfig: vi.fn(),
}))

const { updateChatFolderMock } = vi.hoisted(() => ({ updateChatFolderMock: vi.fn() }))

vi.mock('../api/client', () => ({
  SEARCH_MIN_CHARS: 2,
  api: new Proxy({} as Record<string, unknown>, {
    get: (_t, prop: string) => {
      if (prop === 'updateChatFolder') return updateChatFolderMock
      return vi.fn().mockResolvedValue([])
    },
  }),
}))

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  })),
})

// Prevent delete-folder confirm() from showing a real dialog.
vi.spyOn(window, 'confirm').mockReturnValue(false)

import ChatSidebar from '../pages/ChatSidebar'

const FOLDER_ID = 'folder-focus-test'
const FOLDER_NAME = 'Focus Folder'

const folder: ChatFolder = {
  id: FOLDER_ID, name: FOLDER_NAME, collapsed: false, parent_id: '', color: '', icon: '',
}

// A slot inside the folder so the folder header renders in the list view.
const slotInFolder = {
  key: 'slot-in-folder', title: 'Slot in Folder',
  running: false, tags: [], created: '', last_ts: '', folder_id: FOLDER_ID,
} as unknown as import('../types').Slot

function renderSidebar() {
  const store = createTestStore({
    dashboard: {
      status: {}, connected: true, slots: [slotInFolder], approvalMode: 'normal',
      channelTrusted: false, refreshTrigger: 0, unreadSlots: [], updateProgress: null,
      subagentRunning: {}, subagentDetails: {}, subagentText: {},
      sessionDefaultColor: null, sessionColorsMode: 'tint', sessionColorsPalette: 'horizon',
      sessionColorsIntensity: 'clear', slotsLoaded: true,
    } as unknown as RootState['dashboard'],
    chat: { activeSlot: null } as unknown as RootState['chat'],
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(['chat-tags'], [])
  qc.setQueryData(['tag-columns'], [])
  qc.setQueryData(['chat-folders'], [folder])
  render(
    <QueryClientProvider client={qc}>
      <Provider store={store}>
        <ThemeProvider>
          <MemoryRouter>
            <ChatSidebar
              slots={[slotInFolder]} activeSlot={null} unreadSlots={[]}
              history={[]} historyHasMore={false} defaultAgent="" installedAgents={[]}
            />
            <button type="button" data-testid="elsewhere">Elsewhere</button>
          </MemoryRouter>
        </ThemeProvider>
      </Provider>
    </QueryClientProvider>,
  )
}

/** Wait for one requestAnimationFrame — needed after opening the editor
 *  (useFolderRename focuses via rAF) and after commit/cancel (focusListFolderRow
 *  runs in a rAF). */
const nextFrame = () => act(async () => { await new Promise(requestAnimationFrame) })

/** Open the folder rename editor via double-click on the folder name.
 *  Finds the folder row by its data attribute and double-clicks the name text. */
async function openRenameEditor(): Promise<HTMLInputElement> {
  // The test caller already waited for FOLDER_NAME to appear.
  // Find the folder row by its data-folder-row attribute and double-click the title span inside it.
  const folderRow = document.querySelector(`[data-folder-row="${FOLDER_ID}"]`) as HTMLElement
  if (!folderRow) throw new Error(`data-folder-row="${FOLDER_ID}" not found in DOM`)
  // The folder name span has onDoubleClick to open the rename editor.
  // The name span has title="Double-click to rename" and an onDoubleClick handler.
  const titleEl = folderRow.querySelector('[title="Double-click to rename"]') as HTMLElement
  if (!titleEl) throw new Error('folder header dblclick target not found')
  act(() => { fireEvent.doubleClick(titleEl) })
  // useFolderRename focuses the input via requestAnimationFrame.
  await nextFrame()
  return screen.getByRole('textbox') as HTMLInputElement
}

beforeEach(() => {
  updateChatFolderMock.mockReset()
  updateChatFolderMock.mockResolvedValue({ ok: true })
})
afterEach(() => vi.clearAllMocks())

// #13598 regression — ChatSidebar list-view folder rename focus contract
describe('ChatSidebar list folder rename — focus contract (#13598)', () => {
  it('folder-rename-status region is present and polite', async () => {
    renderSidebar()
    await screen.findByText(FOLDER_NAME)
    const region = document.querySelector('[data-testid="folder-rename-status"]')
    expect(region).toBeTruthy()
    expect(region?.getAttribute('role')).toBe('status')
    expect(region?.getAttribute('aria-live')).toBe('polite')
    expect(region?.textContent).toBe('')
  })

  it('Rename item opens the inline editor with focus on the input', async () => {
    renderSidebar()
    await screen.findByText(FOLDER_NAME)
    const input = await openRenameEditor()
    expect(document.activeElement).toBe(input)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('Enter commits rename and restores focus to folder header row', async () => {
    renderSidebar()
    await screen.findByText(FOLDER_NAME)
    const input = await openRenameEditor()

    act(() => { fireEvent.change(input, { target: { value: 'Renamed' } }) })
    act(() => { fireEvent.keyDown(input, { key: 'Enter' }) })
    // focusListFolderRow is called in requestAnimationFrame after Enter
    await nextFrame()

    const folderRow = document.querySelector(`[data-folder-row="${FOLDER_ID}"]`) as HTMLElement
    expect(folderRow).toBeTruthy()
    expect(document.activeElement).toBe(folderRow)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('Escape cancels rename and restores focus to folder header row', async () => {
    renderSidebar()
    await screen.findByText(FOLDER_NAME)
    const input = await openRenameEditor()

    act(() => { fireEvent.keyDown(input, { key: 'Escape' }) })
    // focusListFolderRow is called in requestAnimationFrame after Escape
    await nextFrame()

    const folderRow = document.querySelector(`[data-folder-row="${FOLDER_ID}"]`) as HTMLElement
    expect(folderRow).toBeTruthy()
    expect(document.activeElement).toBe(folderRow)
    expect(document.activeElement).not.toBe(document.body)
  })

  it('pointer blur (onBlur) does NOT restore focus to folder header row', async () => {
    renderSidebar()
    await screen.findByText(FOLDER_NAME)
    const input = await openRenameEditor()

    const elsewhere = screen.getByTestId('elsewhere')
    // Simulate pointer click elsewhere: focus the other element, then blur input.
    act(() => { elsewhere.focus() })
    act(() => { fireEvent.blur(input) })
    // onBlur → renameCommit → no rAF for focusListFolderRow; folder row NOT focused.
    await nextFrame()

    const folderRow = document.querySelector(`[data-folder-row="${FOLDER_ID}"]`) as HTMLElement
    expect(document.activeElement).toBe(elsewhere)
    expect(document.activeElement).not.toBe(folderRow)
    expect(document.activeElement).not.toBe(document.body)
  })
})
