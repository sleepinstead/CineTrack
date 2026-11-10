/**
 * BACKUP — the original "Paper" theme's TypeScript metadata, preserved
 * verbatim from src/lib/settings.ts (THEMES) and src/lib/theme.ts
 * (THEME_DEFAULTS.paper) before the four-theme redesign.
 *
 * Nothing imports this file. See README.md in this folder to restore Paper.
 */

/** Original entry from the THEMES list in src/lib/settings.ts. */
export const PAPER_THEME_ENTRY = {
  id: 'paper',
  name: 'Paper',
  note: 'True white stock, oxblood ink',
  tone: 'light',
  swatch: ['#ffffff', '#14130f', '#7a2318'],
} as const

/** Original THEME_DEFAULTS.paper from src/lib/theme.ts. */
export const PAPER_THEME_DEFAULTS = {
  background: '#ffffff',
  card: '#faf8f3',
  foreground: '#14130f',
  primary: '#7a2318',
  border: '#e3ded1',
  mutedForeground: '#74705f',
  secondary: '#f0ede4',
  statusPlanned: '#52525b',
  statusWatching: '#2563eb',
  statusWatched: '#15803d',
} as const

/** Original marked-episode fill colour default (settings.episodeWatchedColor). */
export const PAPER_EPISODE_WATCHED_COLOR = '#15803d'
