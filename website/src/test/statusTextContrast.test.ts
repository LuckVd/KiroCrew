/**
 * Ok- and danger-hued text on its own tinted fill clears the WCAG 1.4.3 text
 * floor (4.5:1) in every built-in LIGHT palette. Plain `--ok` on `--ok-subtle`
 * fell to 1.97:1 (amoled-light) and plain `--danger` on `--danger-subtle` to
 * 2.37:1 (tokyonight-light). The same shape as `--warn-text`
 * (glassWarnTextContrast.test.ts): `--ok-text` / `--danger-text` are the plain
 * hue in dark palettes and, under `[data-mode="light"]`, the hue darkened toward
 * black, so they still read as success and error. `text-ok-text` and
 * `text-danger-text` paint them on the fills.
 *
 * This file reads each mix from index.css, measures it against every tint the
 * source pairs with it, and refuses a source line that still pairs plain
 * `text-ok` / `text-danger` with that hue's tint. A tint that only appears on
 * `hover:` is paired with `hover:text-<hue>-text`, so the control keeps its
 * plain hue at rest.
 *
 * SURFACES: a tint is translucent, so the test lays it over `--bg`,
 * `--bg-elevated` and `--card` and requires the floor against each.
 *
 * SCOPE: light palettes only; dark palettes keep the plain hue, and a test pins
 * that. Theme packs installed at runtime are out of reach.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { relativeLuminance, contrastRatio, parseCssColor } from '../lib/iconContrast'
import { CSS, THEMES, resolveVar } from './themePalette'

const MIN_TEXT = 4.5
const SURFACES = ['--bg', '--bg-elevated', '--card'] as const
const HUES = ['ok', 'danger'] as const
type Hue = (typeof HUES)[number]

interface Rgb { r: number; g: number; b: number }

const ACTIVE = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const LIGHT_THEMES = THEMES.filter((t) => t === 'light' || t.endsWith('-light'))
const DARK_THEMES = THEMES.filter((t) => !LIGHT_THEMES.includes(t))

function tokenRgb(theme: string, prop: string): Rgb {
  const raw = resolveVar(theme, prop)
  if (raw === undefined) throw new Error(`theme ${theme}: ${prop} resolves to nothing`)
  const c = parseCssColor(raw)
  if (!c) throw new Error(`theme ${theme}: ${prop}=${raw} is not a colour this test can measure`)
  return { r: c.r, g: c.g, b: c.b }
}

/** The alpha of a theme's `--<hue>-subtle` (`rgba(r,g,b,A)`): the share of the
 *  hue a `bg-<hue>-subtle` fill lays over its surface. */
function subtleShare(theme: string, hue: Hue): number {
  const raw = resolveVar(theme, `--${hue}-subtle`)
  const c = raw === undefined ? null : parseCssColor(raw)
  if (!c) throw new Error(`theme ${theme}: --${hue}-subtle=${raw} is not a colour this test can measure`)
  return c.a
}

/** `color-mix(in srgb, a w, b)`: a straight per-channel mix in sRGB. */
const mix = (a: Rgb, b: Rgb, w: number): Rgb => ({
  r: a.r * w + b.r * (1 - w),
  g: a.g * w + b.g * (1 - w),
  b: a.b * w + b.b * (1 - w),
})
const lum = ({ r, g, b }: Rgb) => relativeLuminance(r, g, b)
const BLACK: Rgb = { r: 0, g: 0, b: 0 }

/** The light-mode token's hue share, read from the stylesheet so a change to
 *  the rule is measured rather than a copy of it. */
function lightShare(hue: Hue): number {
  const re = new RegExp(`\\[data-mode="light"\\]\\s*\\{[^{}]*--${hue}-text\\s*:\\s*color-mix\\(in srgb,\\s*var\\(--${hue}\\)\\s*(\\d+)%,\\s*#000\\)\\s*;?[^{}]*\\}`)
  const m = re.exec(ACTIVE)
  expect(m, `index.css lost the [data-mode="light"] --${hue}-text mix toward black`).not.toBeNull()
  return Number(m![1]) / 100
}

// ── Source scan ──────────────────────────────────────────────────────────────
// A class token is a run of [\w-/] bounded by non-class characters; a variant
// prefix (`hover:`) is kept with it. `text-<hue>` must end the token exactly:
// `text-<hue>-text` and `text-<hue>-fg` are other utilities, `text-<hue>/80` an
// opacity modifier this test does not govern.
function patterns(hue: Hue) {
  return {
    plain: new RegExp(`(?<![\\w-])(?:[\\w-]+:)*text-${hue}(?![\\w/-])`),
    safe: new RegExp(`(?<![\\w-])(?:[\\w-]+:)*text-${hue}-text(?![\\w/-])`),
    tint: new RegExp(`(?<![\\w-])(?:[\\w-]+:)*bg-${hue}(?:-subtle|\\/(\\d+))(?![\\w-])`, 'g'),
    plainPfx: new RegExp(`(?<![\\w-])((?:[\\w-]+:)*)text-${hue}(?![\\w/-])`, 'g'),
    safePfx: new RegExp(`(?<![\\w-])((?:[\\w-]+:)*)text-${hue}-text(?![\\w/-])`, 'g'),
    tintPfx: new RegExp(`(?<![\\w-])((?:[\\w-]+:)*)bg-${hue}(?:-subtle|\\/\\d+)(?![\\w-])`, 'g'),
  }
}

/** True when some state of the line lays a `hue` tint under plain
 *  `text-<hue>`. A tint that only exists under `hover:` is covered by
 *  `hover:text-<hue>-text` (or by an at-rest `text-<hue>-text`). */
function plainOnTint(text: string, hue: Hue): boolean {
  const p = patterns(hue)
  const prefixes = (re: RegExp) => new Set([...text.matchAll(re)].map((m) => m[1]))
  const plain = prefixes(p.plainPfx)
  const safe = prefixes(p.safePfx)
  for (const t of prefixes(p.tintPfx)) {
    const covered = safe.has(t) || (t !== '' && safe.has(''))
    if (!covered && (plain.has(t) || plain.has(''))) return true
  }
  return false
}

interface SourceLine { file: string; line: number; text: string }

function sourceLines(): SourceLine[] {
  const root = resolve(__dirname, '..')
  const out: SourceLine[] = []
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue
    const full = join(entry.parentPath, entry.name)
    if (full.split(sep).includes('test')) continue
    const file = relative(root, full)
    readFileSync(full, 'utf8').split('\n').forEach((text, i) => out.push({ file, line: i + 1, text }))
  }
  return out
}
const LINES = sourceLines()
const FILES = new Set(LINES.map((l) => l.file))

/** Every `hue` tint paired with `text-<hue>-text` anywhere in the source: the
 *  set the token is measured against. */
function pairedTints(hue: Hue): { tints: Map<string, number | 'subtle'>; sites: string[] } {
  const p = patterns(hue)
  const tints = new Map<string, number | 'subtle'>()
  const sites: string[] = []
  for (const l of LINES) {
    if (!p.safe.test(l.text)) continue
    const found = [...l.text.matchAll(p.tint)]
    if (found.length === 0) continue
    sites.push(`${l.file}:${l.line}`)
    for (const m of found) tints.set(m[1] === undefined ? 'subtle' : `/${m[1]}`, m[1] === undefined ? 'subtle' : Number(m[1]) / 100)
  }
  return { tints, sites }
}

describe('ok and danger text on their own tints in light palettes', () => {
  it('anchors the premise: the rules exist and the light palettes are found', () => {
    const bridge = readFileSync(resolve(__dirname, '../tailwind-theme.css'), 'utf8')
    for (const hue of HUES) {
      expect(ACTIVE).toMatch(new RegExp(`:root\\s*\\{[^{}]*--${hue}-text\\s*:\\s*var\\(--${hue}\\)\\s*;`))
      expect(bridge).toMatch(new RegExp(`--color-${hue}-text:\\s*var\\(--${hue}-text\\);`))
    }
    expect(LIGHT_THEMES.length).toBeGreaterThanOrEqual(15)
    for (const t of ['light', 'amoled-light', 'tokyonight-light']) expect(LIGHT_THEMES).toContain(t)
    expect(FILES.size, 'scanned no source files').toBeGreaterThan(100)
  })

  for (const hue of HUES) {
    describe(`--${hue}-text`, () => {
      it('leaves dark palettes on the plain hue', () => {
        expect(ACTIVE).not.toMatch(new RegExp(`\\[data-mode="dark"\\][^{}]*\\{[^{}]*--${hue}-text\\s*:`))
        for (const t of DARK_THEMES) expect(resolveVar(t, `--${hue}-text`), `${t} overrides --${hue}-text`).toBe(`var(--${hue})`)
        expect(DARK_THEMES.length).toBeGreaterThanOrEqual(15)
      })

      it('the plain hue fails somewhere (so the mix is doing real work)', () => {
        const failing = LIGHT_THEMES.filter((t) => {
          const c = tokenRgb(t, `--${hue}`)
          return contrastRatio(lum(c), lum(mix(c, tokenRgb(t, '--bg'), subtleShare(t, hue)))) < MIN_TEXT
        })
        expect(failing.length).toBeGreaterThan(0)
      })

      it(`clears 4.5:1 on every ${hue} tint the source pairs with text-${hue}-text, in every light palette`, () => {
        const w = lightShare(hue)
        const { tints, sites } = pairedTints(hue)
        // The premise: the pairings exist and the subtle fill plus the common
        // alpha tints are among them, so a new stronger tint is measured here
        // rather than assumed.
        expect(sites.length).toBeGreaterThanOrEqual(30)
        expect([...tints.keys()]).toEqual(expect.arrayContaining(['subtle', '/10']))
        const failures: string[] = []
        for (const t of LIGHT_THEMES) {
          const c = tokenRgb(t, `--${hue}`)
          const fg = lum(mix(c, BLACK, w))
          for (const [name, share] of tints) {
            const n = share === 'subtle' ? subtleShare(t, hue) : share
            for (const base of SURFACES) {
              const ratio = contrastRatio(fg, lum(mix(c, tokenRgb(t, base), n)))
              if (ratio < MIN_TEXT) failures.push(`${t}: ${hue} ${w * 100}% vs bg-${hue}${name === 'subtle' ? '-subtle' : name} over ${base} is ${ratio.toFixed(2)}:1`)
            }
          }
        }
        expect(failures, `text-${hue}-text below 4.5:1:\n${failures.join('\n')}`).toEqual([])
      })

      it(`leaves no ${hue} tint painting plain text-${hue} in the source`, () => {
        const p = patterns(hue)
        const offenders = LINES.filter((l) => p.plain.test(l.text) && plainOnTint(l.text, hue)).map((l) => `${l.file}:${l.line}`)
        expect(offenders, `${hue} tints still painting plain text-${hue}:\n${offenders.join('\n')}`).toEqual([])
      })
    })
  }

  it('tells a tint at rest from a tint that only appears on hover', () => {
    expect(plainOnTint('bg-ok-subtle text-ok', 'ok')).toBe(true)
    expect(plainOnTint('text-danger bg-danger/10 border-danger', 'danger')).toBe(true)
    expect(plainOnTint('text-danger hover:bg-danger/10', 'danger')).toBe(true)
    expect(plainOnTint('text-danger hover:text-danger-text hover:bg-danger/10', 'danger')).toBe(false)
    expect(plainOnTint('bg-ok-subtle text-ok-text', 'ok')).toBe(false)
    expect(plainOnTint('bg-danger text-danger-fg hover:bg-danger/80', 'danger')).toBe(false)
    // The hues do not cross: an ok tint does not govern danger text.
    expect(plainOnTint('bg-ok-subtle text-danger', 'danger')).toBe(false)
  })
})
