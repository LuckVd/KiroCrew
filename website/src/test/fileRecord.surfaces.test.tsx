/**
 * One file-record decision for every surface that draws a `file` row.
 *
 * The SDK default (ChatEmbed, SideChat) and ChatPage's override must accept and
 * reject the same records. Each keeps its own fallback for a rejected record:
 * the SDK default draws nothing, ChatPage hands the row to renderUnparsedFile
 * (its conversational bubble), and neither ever gives FileCard a non-record.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../i18n/all'
import type { ChatMessage } from '../types'
import {
  defaultMessageRenderers,
  mergeRenderers,
  resolveRenderer,
  type MessageRenderContext,
} from '../app-sdk/messageRenderers'
import { createTranscriptRenderers } from '../pages/chat/transcriptRenderers'
import { parseFileRecord } from '../lib/fileRecord'

const fileMsg = (content: string): ChatMessage =>
  ({ role: 'file', content, cls: '' }) as ChatMessage

const ctx = (m: ChatMessage): MessageRenderContext => ({
  index: 0,
  messages: [m],
  running: false,
  key: 'k',
  hideCardOwnedOAuth: false,
  autoDeniedIds: new Set<string>(),
  wrapper: children => children,
  row: children => <div data-testid="row">{children}</div>,
})

const UNPARSED = 'unparsed-fallback'
const chatPageRegistry = mergeRenderers(createTranscriptRenderers({
  slot: 's1',
  renderUnparsedFile: m => <div data-testid={UNPARSED}>{m.content}</div>,
}))

function drawWith(registry: Parameters<typeof resolveRenderer>[1], content: string) {
  const m = fileMsg(content)
  const entry = resolveRenderer(m, registry)
  expect(entry?.id).toBe('file')
  return entry!.render(m, ctx(m))
}

const VALID: Array<[string, string]> = [
  ['full record', JSON.stringify({ filename: 'report q3.pdf', size: 2048, content_type: 'application/pdf', description: 'Quarterly report' })],
  ['filename only', JSON.stringify({ filename: 'report.pdf' })],
  ['empty optional strings and zero size', JSON.stringify({ filename: 'report.pdf', content_type: '', description: '', size: 0 })],
  ['extra server field (path)', JSON.stringify({ filename: 'report.pdf', path: '/tmp/outbox/report.pdf' })],
]

const INVALID: Array<[string, string]> = [
  ['invalid JSON', 'not json'],
  ['null', 'null'],
  ['a JSON string', '"chart.png"'],
  ['a JSON number', '7'],
  ['an array', '[]'],
  ['missing filename', JSON.stringify({ size: 3 })],
  ['empty filename', JSON.stringify({ filename: '' })],
  ['non-string filename', JSON.stringify({ filename: 7 })],
  ['numeric content_type', JSON.stringify({ filename: 'a.pdf', content_type: 7 })],
  ['null content_type', JSON.stringify({ filename: 'a.pdf', content_type: null })],
  ['object description', JSON.stringify({ filename: 'a.pdf', description: { text: 'x' } })],
  ['null description', JSON.stringify({ filename: 'a.pdf', description: null })],
  ['string size', JSON.stringify({ filename: 'a.pdf', size: '2048' })],
  ['null size', JSON.stringify({ filename: 'a.pdf', size: null })],
]

describe('parseFileRecord', () => {
  it.each(VALID)('accepts %s', (_name, content) => {
    const file = parseFileRecord(content)
    expect(file).not.toBeNull()
    expect(file!.filename).toBe((JSON.parse(content) as { filename: string }).filename)
  })

  it('keeps only the card fields', () => {
    expect(parseFileRecord(JSON.stringify({ filename: 'a.pdf', path: '/x', size: 1 })))
      .toEqual({ filename: 'a.pdf', size: 1, content_type: undefined, description: undefined })
  })

  it.each(INVALID)('rejects %s', (_name, content) => {
    expect(parseFileRecord(content)).toBeNull()
  })
})

describe('both surfaces decide the same way', () => {
  it.each(VALID)('%s: both draw the FileCard', (_name, content) => {
    const { filename } = JSON.parse(content) as { filename: string }
    for (const registry of [defaultMessageRenderers, chatPageRegistry]) {
      const { unmount } = render(<>{drawWith(registry, content)}</>)
      expect(screen.getByTestId('row')).toBeTruthy()
      expect(screen.getByText(filename)).toBeTruthy()
      expect(screen.queryByTestId(UNPARSED)).toBeNull()
      unmount()
    }
  })

  it.each(INVALID)('%s: SDK draws nothing, ChatPage falls back to text', (_name, content) => {
    expect(drawWith(defaultMessageRenderers, content)).toBeNull()

    render(<>{drawWith(chatPageRegistry, content)}</>)
    expect(screen.getByTestId(UNPARSED).textContent).toBe(content)
    expect(screen.queryByTestId('row')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('ChatPage draws nothing for a rejected record when no fallback is passed', () => {
    const registry = mergeRenderers(createTranscriptRenderers({ slot: 's1' }))
    expect(drawWith(registry, 'null')).toBeNull()
    expect(drawWith(registry, JSON.stringify({ size: 3 }))).toBeNull()
  })
})
