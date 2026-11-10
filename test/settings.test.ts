import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// No local API under the test runner: settings load fails fast and retries quietly.
globalThis.fetch = (async () => new Response('offline', { status: 503 })) as typeof fetch

const { currentSettings, importSettings, settingsForBackup } = await import('../src/lib/settings.ts')

const RETIRED = [
  // Renamed, then removed.
  'defaultShelfTab',
  'shelfColumns',
  // The old customisable masthead.
  'archiveName',
  'archiveItalicWordIndices',
  // Removed to keep Settings simple; their behaviour is fixed now.
  'statusBadgeShape',
  'statusBadgeSize',
  'statusBadgePosition',
  'statusBadgeIcon',
  'statusBadgeShadow',
  'posterQuality',
  'forYouColumns',
  'dateStyle',
  'defaultLibraryTab',
  'defaultSort',
  'openAfterAdd',
  'defaultWatchDate',
  'blurEpisodeCovers',
]

describe('retired settings', () => {
  it('are dropped from saved settings and never written back out', () => {
    const old: Record<string, unknown> = {
      defaultShelfTab: 'tv',
      shelfColumns: 8,
      archiveName: 'My Film Diary',
      archiveItalicWordIndices: [1],
      statusBadgeShape: 'square',
      statusBadgeSize: 'small',
      statusBadgePosition: 'bottom-left',
      statusBadgeIcon: true,
      statusBadgeShadow: true,
      posterQuality: 'saver',
      forYouColumns: 4,
      dateStyle: 'absolute',
      defaultLibraryTab: 'movie',
      defaultSort: 'title',
      openAfterAdd: true,
      defaultWatchDate: 'blank',
      blurEpisodeCovers: true,
    }
    assert.equal(importSettings(old), true)
    const backup = settingsForBackup()
    for (const key of RETIRED) assert.equal(key in backup, false, `${key} should be retired`)
  })
})

describe('kept settings', () => {
  it('keeps every value the panel can change', async () => {
    const { DEFAULT_THEME } = await import('../src/lib/theme.ts')
    const chosen = {
      theme: 'noir',
      density: 'compact',
      roundPosters: true,
      posterMotion: false,
      showNavHints: false,
      libraryColumns: 9,
      discoverColumns: 4,
      defaultStatus: 'watching',
      autoCompleteSeries: false,
      hideSpoilers: true,
      hideEpisodeCovers: true,
      showSpecials: false,
      metadataLanguage: 'fr-FR',
      showCommunityScores: true,
      includeAdult: true,
    } as const
    assert.notEqual(chosen.theme, DEFAULT_THEME)
    importSettings(chosen)
    const settings = currentSettings() as Record<string, unknown>
    for (const [key, value] of Object.entries(chosen)) assert.equal(settings[key], value, `${key} was not kept`)
  })

  it('clamps items per row to 3–10', () => {
    importSettings({ libraryColumns: 42, discoverColumns: 1 })
    assert.equal(currentSettings().libraryColumns, 10)
    assert.equal(currentSettings().discoverColumns, 3)
  })
})
