import { describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import type {
  Issue, IssueDetailResponse, PullDetailResponse, PullRequest, TimelineEvent,
} from '../apps/issue-radar/api'

// Behaviour pins for the comment box at the head of the detail timeline, on the
// issue pane and on the pull-request pane.
//
//  * The box sits ABOVE the newest-first list, so the comment a reader is about to
//    write lands where the next one will appear.
//  * An issue is written through its own route and a pull request through the pull
//    route. GitLab and Azure DevOps number issues and change requests
//    independently, so the pull route given an issue number would comment on a
//    different item.
//  * After a post the pane re-reads the item, so the new comment is the top node
//    without the reader pressing Refresh.
//  * A failed post keeps the draft and says why, and a post that settles after the
//    pane moved to another item must not touch that item's draft.
//  * A repo connected read-only never shows the box.
//  * Escape that discards a draft stops there. The pull request list clears its bulk
//    selection on a window-level Escape, and discarding a comment must not disarm it.

const api = {
  issueDetail: vi.fn(),
  issueAi: vi.fn(),
  addIssueComment: vi.fn(),
  pullDetail: vi.fn(),
  pullAi: vi.fn(),
  addPrComment: vi.fn(),
}
vi.mock('../apps/issue-radar/api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  issueRadarApi: api,
}))

const ctx = { value: {} as Record<string, unknown> }
vi.mock('../apps/issue-radar/context', () => ({ useIssueRadar: () => ctx.value }))

// Children that own their own queries or markdown pipeline are stubbed; the box
// under test is not one of them.
vi.mock('../apps/issue-radar/components/RefMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}))
vi.mock('../apps/issue-radar/components/InvestigateButton', () => ({
  default: () => <div>investigate</div>,
}))
vi.mock('../apps/issue-radar/components/ReviewButton', () => ({
  default: () => <div>review-button</div>,
}))
vi.mock('../apps/issue-radar/components/PrActionsBar', () => ({
  default: () => <div>pr-actions-bar</div>,
}))
vi.mock('../apps/issue-radar/components/PrRunActions', () => ({
  default: () => <div>pr-run-actions</div>,
}))
vi.mock('../apps/issue-radar/components/AiSummaryCard', () => ({
  default: () => <div>ai-summary-card</div>,
}))

const IssueDetail = (await import('../apps/issue-radar/components/IssueDetail')).default
const PrDetail = (await import('../apps/issue-radar/components/PrDetail')).default

const REF = { owner: 'kirodotdev', repo: 'Kiro' }
const SCOPE = 'github:github.com:kirodotdev/Kiro'
const BOX = { name: 'Add a comment' }

const ISSUE: Issue = {
  number: 11, title: 'Row title', url: 'https://github.com/kirodotdev/Kiro/issues/11',
  labels: [], comments: 0, author: 'alice', author_association: 'MEMBER', state: 'open',
  assignees: [], body: 'Row body', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z',
}
const PULL: PullRequest = {
  number: 7, title: 'Row title', url: 'https://github.com/kirodotdev/Kiro/pull/7',
  state: 'open', draft: false, labels: [], author: 'alice', author_association: 'MEMBER',
  created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z', merged_at: null,
}

function remark(body: string, at: string): TimelineEvent {
  return { kind: 'comment', actor: 'bob', created_at: at, body }
}

/** The text of every comment card, in document order (the markdown stub). */
function cardTexts(): (string | null)[] {
  return screen.getAllByTestId('md').map((n) => n.textContent)
}

function issueResponse(number: number, timeline: TimelineEvent[]): IssueDetailResponse {
  return {
    owner: REF.owner, repo: REF.repo, number, from_cache: false, timeline,
    detail: {
      number, title: 'Detail title', body: 'The description body', state: 'open', state_reason: null,
      url: `https://github.com/kirodotdev/Kiro/issues/${number}`, author: 'alice',
      author_association: 'MEMBER', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z',
      closed_at: null, closed_by: null, comments: timeline.length, locked: false, labels: [],
      assignees: [], milestone: null,
      reactions: {
        total: 0, plus1: 0, minus1: 0, laugh: 0, hooray: 0, confused: 0, heart: 0, rocket: 0, eyes: 0,
      },
    },
  }
}

function pullResponse(timeline: TimelineEvent[]): PullDetailResponse {
  return {
    owner: REF.owner, repo: REF.repo, number: 7, from_cache: false, timeline, checks: [],
    detail: {
      number: 7, title: 'Detail title', body: 'The description body', state: 'open', draft: false,
      merged: false, url: 'https://github.com/kirodotdev/Kiro/pull/7', author: 'alice',
      author_association: 'MEMBER', created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-02T00:00:00Z',
      closed_at: null, merged_at: null, merged_by: null, comments: timeline.length, review_comments: 0,
      commits: 1, additions: 1, deletions: 0, changed_files: 1, mergeable: true, mergeable_state: 'clean',
      base: 'main', head: 'feat/thing', head_sha: 'abc1234', labels: [], assignees: [],
      requested_reviewers: [], milestone: null,
    },
  }
}

function renderIssue(issue: Issue = ISSUE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const tree = (i: Issue) => (
    <QueryClientProvider client={qc}><IssueDetail issue={i} /></QueryClientProvider>
  )
  const view = render(tree(issue))
  return { ...view, qc, switchTo: (i: Issue) => view.rerender(tree(i)) }
}

function renderPull() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}><PrDetail pull={PULL} /></QueryClientProvider>)
}

beforeEach(() => {
  vi.clearAllMocks()
  ctx.value = {
    active: REF,
    colorByName: new Map(),
    memberRoleByLogin: new Map(),
    repoLabels: [],
    countByLabel: new Map(),
    canWrite: true,
    stateFilter: 'open',
    me: 'alice',
    refreshPrefs: { detailPollMs: 30_000, pollInBackground: false },
    listDetail: { isMobile: false, showList: true, showDetail: true, openDetail: vi.fn(), closeDetail: vi.fn() },
    openRef: vi.fn(),
  }
  api.issueAi.mockResolvedValue({
    owner: REF.owner, repo: REF.repo, number: 11, summary: '', suggested_labels: [],
    generated_at: '2026-07-02T01:00:00Z', from_cache: true,
  })
  api.pullAi.mockResolvedValue({
    owner: REF.owner, repo: REF.repo, number: 7, summary: '', generated_at: '2026-07-02T01:00:00Z', from_cache: true,
  })
})

describe('issue pane — comment box at the head of the timeline', () => {
  it('posts through the issue route and shows the comment as the top node', async () => {
    const older = remark('older remark', '2026-07-02T01:00:00Z')
    api.issueDetail
      .mockResolvedValueOnce(issueResponse(11, [older]))
      .mockResolvedValue(issueResponse(11, [older, remark('looks good', '2026-07-02T02:00:00Z')]))
    api.addIssueComment.mockResolvedValue({ number: 11, comment_id: 5, url: null })
    const user = userEvent.setup()
    renderIssue()

    const box = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    // Above the list: the existing newest comment follows the box in document order.
    const existing = await screen.findByText('older remark')
    expect(box.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    // A bare Enter is a newline; only Cmd/Ctrl+Enter sends.
    await user.type(box, 'looks good{Enter}')
    expect(api.addIssueComment).not.toHaveBeenCalled()
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => expect(api.addIssueComment).toHaveBeenCalledWith(REF, 11, 'looks good'))
    // The new comment is the first card after the box, the older one second.
    await waitFor(() => {
      const cards = cardTexts()
      expect(cards).toContain('looks good')
      expect(cards.indexOf('looks good')).toBeLessThan(cards.indexOf('older remark'))
    })
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('keeps the draft and shows the forge message when the post fails', async () => {
    api.issueDetail.mockResolvedValue(issueResponse(11, []))
    api.addIssueComment.mockRejectedValue(new Error('Resource not accessible by integration'))
    const user = userEvent.setup()
    renderIssue()

    const box = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    await user.type(box, 'will retry')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    expect(await screen.findByText(/Resource not accessible by integration/)).toBeTruthy()
    expect(box.value).toBe('will retry')
    expect(api.issueDetail).toHaveBeenCalledTimes(1)
  })

  it('sends nothing for a blank draft, and Escape discards a draft', async () => {
    api.issueDetail.mockResolvedValue(issueResponse(11, []))
    const user = userEvent.setup()
    renderIssue()

    const box = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    await user.type(box, '   {Control>}{Enter}{/Control}')
    expect(api.addIssueComment).not.toHaveBeenCalled()
    await user.clear(box)
    await user.type(box, 'half a thought{Escape}')
    expect(box.value).toBe('')
  })

  it('keeps the Escape that discards a draft to itself, and lets one through when there is none', async () => {
    api.issueDetail.mockResolvedValue(issueResponse(11, []))
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    onTestFinished(() => window.removeEventListener('keydown', seen))
    const escapes = () => seen.mock.calls.filter(([e]) => (e as KeyboardEvent).key === 'Escape').length
    const user = userEvent.setup()
    renderIssue()

    const box = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    await user.type(box, 'a draft{Escape}')
    expect(box.value).toBe('')
    expect(escapes()).toBe(0)
    // Positive control: with nothing left to discard the key reaches the window listener.
    await user.keyboard('{Escape}')
    expect(escapes()).toBe(1)
  })

  it('sends once while a post is in flight, however many times the shortcut repeats', async () => {
    api.issueDetail.mockResolvedValue(issueResponse(11, []))
    let settle: (v: unknown) => void = () => {}
    api.addIssueComment.mockReturnValue(new Promise((r) => { settle = r }))
    const user = userEvent.setup()
    renderIssue()

    const box = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    await user.type(box, 'only once')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(api.addIssueComment).toHaveBeenCalledTimes(1))
    await user.keyboard('{Control>}{Enter}{/Control}{Control>}{Enter}{/Control}')
    await act(async () => { settle({ number: 11, comment_id: 7, url: null }) })

    await waitFor(() => expect(box.value).toBe(''))
    expect(api.addIssueComment).toHaveBeenCalledTimes(1)
  })

  it('does not let a post that settles late touch the draft of the next issue', async () => {
    api.issueDetail.mockImplementation(async (_ref: unknown, n: number) => issueResponse(n, []))
    let settle: (v: unknown) => void = () => {}
    api.addIssueComment.mockReturnValue(new Promise((r) => { settle = r }))
    const user = userEvent.setup()
    const pane = renderIssue()

    const first = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    await user.type(first, 'for eleven')
    await user.keyboard('{Control>}{Enter}{/Control}')
    await waitFor(() => expect(api.addIssueComment).toHaveBeenCalledTimes(1))

    pane.switchTo({ ...ISSUE, number: 12 })
    const second = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    expect(second.value).toBe('')
    await user.type(second, 'for twelve')
    await act(async () => { settle({ number: 11, comment_id: 6, url: null }) })

    // The stale post ran to its end: it marked the issue it was sent for as stale.
    await waitFor(() => expect(pane.qc.getQueryState(['issue-radar', 'issue', SCOPE, 11])?.isInvalidated).toBe(true))
    expect(second.value).toBe('for twelve')
  })

  it('is offered on a writable repo and withheld on a read-only one', async () => {
    api.issueDetail.mockResolvedValue(issueResponse(11, []))
    const writable = renderIssue()
    expect(await screen.findByRole('textbox', BOX)).toBeTruthy()
    writable.unmount()

    ctx.value = { ...ctx.value, canWrite: false }
    renderIssue()
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('textbox', BOX)).toBeNull()
  })
})

describe('pull-request pane — comment box at the head of the timeline', () => {
  it('posts through the pull route and shows the comment in the timeline', async () => {
    const older = remark('older remark', '2026-07-02T01:00:00Z')
    api.pullDetail
      .mockResolvedValueOnce(pullResponse([older]))
      .mockResolvedValue(pullResponse([older, remark('ship it', '2026-07-02T02:00:00Z')]))
    api.addPrComment.mockResolvedValue({ number: 7, id: 5, url: null, created_at: null })
    const user = userEvent.setup()
    renderPull()

    const box = await screen.findByRole('textbox', BOX) as HTMLTextAreaElement
    const existing = await screen.findByText('older remark')
    expect(box.compareDocumentPosition(existing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await user.type(box, 'ship it')
    await user.keyboard('{Control>}{Enter}{/Control}')

    await waitFor(() => expect(api.addPrComment).toHaveBeenCalledWith(REF, 7, 'ship it'))
    expect(api.addIssueComment).not.toHaveBeenCalled()
    await waitFor(() => expect(cardTexts()).toContain('ship it'))
    expect(api.pullDetail).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(box.value).toBe(''))
  })

  it('is offered on a writable repo and withheld on a read-only one', async () => {
    api.pullDetail.mockResolvedValue(pullResponse([]))
    const writable = renderPull()
    expect(await screen.findByRole('textbox', BOX)).toBeTruthy()
    writable.unmount()

    ctx.value = { ...ctx.value, canWrite: false }
    renderPull()
    await screen.findByRole('heading', { level: 1 })
    expect(screen.queryByRole('textbox', BOX)).toBeNull()
  })
})
