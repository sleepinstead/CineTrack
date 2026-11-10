import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { contrastRatio, hexToRgb, isValidHex, normalizeHex, resolveThemeId, resolveThemePreference, systemTheme, THEME_IDS, THEMES } from '../src/lib/theme.ts'

const css = readFileSync(new URL('../src/styles/themes.css', import.meta.url), 'utf8')
const boot = readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8')

/** The custom properties declared in the block that styles `[data-theme='<id>']`. */
function tokensFor(id: string): Record<string, string> {
  const block = new RegExp(`\\[data-theme='${id}'\\]\\s*\\{([^}]*)\\}`).exec(css)
  assert.ok(block, `themes.css has no block for ${id}`)
  const tokens: Record<string, string> = {}
  for (const [, name, value] of block[1]!.matchAll(/(--[a-z-]+):\s*([^;]+);/g)) tokens[name!] = value!.trim()
  return tokens
}

const REQUIRED_TOKENS = [
  '--background', '--foreground', '--card', '--card-foreground', '--muted', '--muted-foreground',
  '--secondary', '--secondary-foreground', '--primary', '--primary-foreground', '--accent', '--accent-foreground',
  '--destructive', '--destructive-foreground', '--border', '--border-strong', '--ring',
  '--toast-info', '--toast-success', '--toast-warning', '--toast-error', '--toast-on',
  '--status-planned', '--status-planned-foreground', '--status-planned-ink',
  '--status-watching', '--status-watching-foreground', '--status-watching-ink',
  '--status-watched', '--status-watched-foreground', '--status-watched-ink',
  '--scrim', '--scrim-soft', '--shadow-pop', '--shadow-sheet', '--shadow-drawer', '--poster-edge',
]

/** [text, surface] pairs that carry readable text, all held to WCAG AA. */
const TEXT_PAIRS: [string, string][] = [
  ...['--background', '--card', '--muted'].flatMap((surface): [string, string][] => [
    ['--foreground', surface],
    ['--muted-foreground', surface],
    ['--primary', surface],
    ['--accent', surface],
    ['--destructive', surface],
  ]),
  ...['--background', '--card'].flatMap((surface): [string, string][] => [
    ['--status-planned-ink', surface],
    ['--status-watching-ink', surface],
    ['--status-watched-ink', surface],
  ]),
  ['--card-foreground', '--card'],
  ['--secondary-foreground', '--secondary'],
  ['--primary-foreground', '--primary'],
  ['--accent-foreground', '--accent'],
  ['--destructive-foreground', '--destructive'],
  ['--status-planned-foreground', '--status-planned'],
  ['--status-watching-foreground', '--status-watching'],
  ['--status-watched-foreground', '--status-watched'],
  ['--toast-on', '--toast-info'],
  ['--toast-on', '--toast-success'],
  ['--toast-on', '--toast-warning'],
  ['--toast-on', '--toast-error'],
]

/**
 * Pairs knowingly below AA. Noir's crimson is tuned so white text on it
 * passes AA; as text on the dark ground it is about 3.7:1 (AA for large text
 * only). Anything else that drops below AA still fails.
 */
const BELOW_AA_BY_CHOICE: Record<string, { pairs: string[]; min: number }> = {
  noir: { pairs: ['--primary', '--accent'], min: 3.2 },
  // Paper is restored with its original colours unchanged; on its sunken
  // --muted surface these two read at 4.48:1 and 4.35:1, a hair under AA.
  paper: { pairs: ['--muted-foreground', '--destructive'], min: 4.3 },
}

describe('theme registry', () => {
  it('offers one light and one dark theme, light first as the default', () => {
    assert.deepEqual(THEMES.map((t) => t.id), [...THEME_IDS])
    assert.deepEqual(THEMES.map((t) => t.tone), ['light', 'dark'])
    assert.equal(resolveThemeId(undefined), 'paper')
  })

  it('gives both themes a red accent', () => {
    // Paper's oxblood and Noir's crimson both stay in the red family.
    for (const theme of THEMES) {
      const primary = tokensFor(theme.id)['--primary']!
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(primary.slice(i, i + 2), 16)) as [number, number, number]
      assert.ok(r > g * 1.6 && r > b * 1.4, `${theme.id} primary ${primary} is not crimson`)
    }
  })

  it('keeps theme-color and the boot script in step with themes.css', () => {
    for (const theme of THEMES) {
      const tokens = tokensFor(theme.id)
      assert.equal(theme.themeColor, tokens['--background'], `${theme.id} themeColor`)
      assert.match(boot, new RegExp(`${theme.id}: '${theme.themeColor}'`), `theme-boot.js entry for ${theme.id}`)
      assert.match(css, new RegExp(`\\[data-theme='${theme.id}'\\]\\s*\\{\\s*color-scheme: ${theme.tone};`), `${theme.id} color-scheme`)
    }
  })

  it('maps every retired theme id to a current theme', () => {
    const expected: Record<string, string> = {
      porcelain: 'paper', frost: 'paper', dawn: 'paper', matinee: 'paper', gallery: 'paper', blueprint: 'paper',
      nocturne: 'noir', dusk: 'noir', projector: 'noir', midnight: 'noir', velvet: 'noir', nitrate: 'noir', halide: 'noir', black: 'noir',
    }
    for (const [from, to] of Object.entries(expected)) {
      assert.equal(resolveThemeId(from), to, from)
      assert.match(boot, new RegExp(`${from}: '${to}'`), `theme-boot.js maps ${from}`)
    }
    assert.equal(resolveThemeId('noir'), 'noir')
    assert.equal(resolveThemeId(undefined), 'paper')
    assert.equal(resolveThemeId('__proto__'), 'paper')
  })

  it('keeps a system preference and resolves it from the OS', () => {
    assert.equal(resolveThemePreference('system'), 'system')
    assert.equal(resolveThemePreference('frost'), 'paper')
    assert.equal(resolveThemeId('system'), 'paper')
    // No window under Node: the OS is treated as light.
    assert.equal(systemTheme(), 'paper')
    assert.match(boot, /theme === 'system'/)
    assert.match(boot, /prefers-color-scheme: dark/)
  })

  it('maps a custom palette by the brightness of its background', () => {
    assert.equal(resolveThemeId('custom', { background: '#0e121a' }), 'noir')
    assert.equal(resolveThemeId('custom', { background: '#f4ede2' }), 'paper')
    assert.equal(resolveThemeId('custom', null), 'paper')
  })
})

describe('theme palettes', () => {
  for (const theme of THEMES) {
    it(`${theme.name} defines every token`, () => {
      const tokens = tokensFor(theme.id)
      const missing = REQUIRED_TOKENS.filter((name) => !(name in tokens))
      assert.deepEqual(missing, [])
    })

    it(`${theme.name} meets WCAG AA for every text pair`, () => {
      const tokens = tokensFor(theme.id)
      const exception = BELOW_AA_BY_CHOICE[theme.id]
      const failures = TEXT_PAIRS.map(([text, surface]) => ({ text, surface, ratio: contrastRatio(tokens[text]!, tokens[surface]!) }))
        .filter(({ text, ratio }) => !(ratio >= (exception?.pairs.includes(text) ? exception.min : 4.5)))
        .map(({ text, surface, ratio }) => `${text} on ${surface}: ${ratio.toFixed(2)}`)
      assert.deepEqual(failures, [])
    })
  }

  it("keeps Paper's original colours from the backup", () => {
    const backup = readFileSync(new URL('../src/theme-backup/paper.css', import.meta.url), 'utf8')
    const paper = tokensFor('paper')
    // The accent was brightened on purpose (#7a2318 → #a32d1e); everything else is original.
    const BRIGHTENED = new Set(['--primary', '--accent', '--ring'])
    for (const [, name, value] of backup.matchAll(/(--[a-z-]+):\s*(#[0-9a-f]{6});/g)) {
      if (BRIGHTENED.has(name!)) continue
      assert.equal(paper[name!], value, `${name} differs from the Paper backup`)
    }
    assert.equal(paper['--primary'], '#a32d1e')
  })

  it('is the fallback palette for a page without a theme attribute', () => {
    assert.match(css, /:root,\s*\[data-theme='paper'\]\s*\{/)
  })
})

describe('hex helpers', () => {
  it('accepts 3- and 6-digit hex with optional hash', () => {
    assert.equal(isValidHex('#fff'), true)
    assert.equal(isValidHex('fff'), true)
    assert.equal(isValidHex('#a1B2c3'), true)
    assert.equal(isValidHex('#ggg'), false)
    assert.equal(isValidHex('#12345'), false)
    assert.equal(isValidHex(''), false)
  })
  it('normalizes to lowercase 6-digit form', () => {
    assert.equal(normalizeHex('#FFF'), '#ffffff')
    assert.equal(normalizeHex('a1b2c3'), '#a1b2c3')
  })
  it('converts hex to rgb', () => {
    assert.deepEqual(hexToRgb('#010203'), { r: 1, g: 2, b: 3 })
    assert.equal(hexToRgb('nope'), null)
  })
  it('computes WCAG contrast ratios', () => {
    assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21)
    assert.equal(contrastRatio('#777777', '#777777'), 1)
  })
})
