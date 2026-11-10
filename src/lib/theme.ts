/**
 * Theme registry. The colours themselves live in src/styles/themes.css; this
 * module names the themes, applies one to the document, and remembers it for
 * the pre-paint boot script (public/theme-boot.js).
 */

export const THEME_IDS = ['paper', 'noir'] as const
export type ThemeId = (typeof THEME_IDS)[number]

export const DEFAULT_THEME: ThemeId = 'paper'

/** What the user picks: a fixed theme, or follow the operating system. */
export type ThemePreference = ThemeId | 'system'

/** The theme the OS asks for right now: Noir in dark mode, else Paper. */
export function systemTheme(): ThemeId {
  try {
    return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'noir' : 'paper'
  } catch {
    return DEFAULT_THEME
  }
}

/** Resolve a stored preference, keeping `system` and mapping retired ids. */
export function resolveThemePreference(raw: unknown, legacyCustomColors?: unknown): ThemePreference {
  return raw === 'system' ? 'system' : resolveThemeId(raw, legacyCustomColors)
}

/** Call `onChange` whenever the OS switches between light and dark. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

export type ThemeMeta = {
  id: ThemeId
  name: string
  description: string
  tone: 'light' | 'dark'
  /** Page background, for the browser's theme-color; tests keep it in step with themes.css. */
  themeColor: string
}

export const THEMES: readonly ThemeMeta[] = [
  { id: 'paper', name: 'Paper', description: 'White and oxblood red', tone: 'light', themeColor: '#ffffff' },
  { id: 'noir', name: 'Noir', description: 'Graphite and crimson', tone: 'dark', themeColor: '#0e0e10' },
]

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value)
}

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!
}

/**
 * Themes from earlier versions, mapped to the closest new theme by tone and
 * temperature. `custom` follows the brightness of its saved background.
 */
const RETIRED_THEMES: Record<string, ThemeId> = {
  // Light themes from earlier redesigns.
  porcelain: 'paper',
  frost: 'paper',
  dawn: 'paper',
  matinee: 'paper',
  gallery: 'paper',
  blueprint: 'paper',
  // Dark themes from earlier redesigns.
  nocturne: 'noir',
  dusk: 'noir',
  projector: 'noir',
  midnight: 'noir',
  velvet: 'noir',
  nitrate: 'noir',
  halide: 'noir',
  black: 'noir',
}

/** Resolve any stored theme value, current or retired, to a current theme. */
export function resolveThemeId(raw: unknown, legacyCustomColors?: unknown): ThemeId {
  if (isThemeId(raw)) return raw
  if (typeof raw === 'string' && Object.hasOwn(RETIRED_THEMES, raw)) return RETIRED_THEMES[raw]!
  if (raw === 'custom') {
    const background =
      legacyCustomColors && typeof legacyCustomColors === 'object'
        ? (legacyCustomColors as Record<string, unknown>).background
        : undefined
    if (typeof background === 'string' && isValidHex(background) && relativeLuminance(background) < 0.2) return 'noir'
    return 'paper'
  }
  return DEFAULT_THEME
}

export function isValidHex(raw: string): boolean {
  return /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(raw.trim())
}

export function normalizeHex(raw: string): string {
  let hex = raw.trim().replace(/^#/, '')
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return '#' + hex.toLowerCase()
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  if (!isValidHex(hex)) return null
  const num = parseInt(normalizeHex(hex).slice(1), 16)
  return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 }
}

/** WCAG 2.x relative luminance (0 = black, 1 = white). */
export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex)
  if (!rgb) return 1
  const channel = (value: number) => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b)
}

/** WCAG contrast ratio between two colours, from 1 (none) to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** localStorage key read by public/theme-boot.js before first paint. */
export const THEME_HINT_KEY = 'cinetrack.theme'

/** Remember the applied theme so the next load can paint it immediately. */
function rememberThemeHint(hint: { theme: ThemePreference; round: boolean }) {
  try {
    window.localStorage.setItem(THEME_HINT_KEY, JSON.stringify(hint))
  } catch {
    // Private mode / blocked storage: the theme still applies after load.
  }
}

/** Inline overrides written by the retired custom-colour feature. */
const LEGACY_INLINE_VARS = [
  '--background', '--foreground', '--card', '--card-foreground', '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground', '--accent', '--accent-foreground',
  '--border', '--ring', '--tooth', '--status-planned', '--status-planned-foreground', '--status-watching',
  '--status-watching-foreground', '--status-watched', '--status-watched-foreground',
]

export function applyTheme(preference: ThemePreference, round = false) {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const meta = themeMeta(preference === 'system' ? systemTheme() : preference)
  root.dataset.theme = meta.id
  for (const name of LEGACY_INLINE_VARS) root.style.removeProperty(name)
  root.style.colorScheme = meta.tone
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', meta.themeColor)
  // The hint keeps `system` itself, so the boot script follows the OS too.
  rememberThemeHint({ theme: preference, round })
}
