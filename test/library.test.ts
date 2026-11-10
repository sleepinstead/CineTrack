import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

type FetchCall = { url: string; method: string; body: string }
const calls: FetchCall[] = []
/** Behavior override for POST responses, so persistence failure modes can be exercised. */
const behavior: { postStatus: number; postBody: string } = { postStatus: 200, postBody: '' }

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input)
  const method = (init?.method ?? 'GET').toUpperCase()
  calls.push({ url, method, body: String(init?.body ?? '') })
  if (method === 'POST' && behavior.postStatus !== 200) {
    return new Response(behavior.postBody, {
      status: behavior.postStatus,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response(method === 'GET' ? '{}' : '', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}) as typeof fetch

// Import after the fetch mock exists: the module hydrates from the mocked
// endpoint at load time.
const lib = await import('../src/lib/library.ts')
type Entry = import('../src/lib/library.ts').Entry

// Capture the hook API by rendering a probe component (no DOM required).
let api!: ReturnType<typeof lib.useLibrary>
function Probe() {
  api = lib.useLibrary()
  return null
}
renderToString(createElement(Probe))
if (!api) throw new Error('probe did not run')

let statusSnapshot: ReturnType<typeof lib.useLibraryStatus> | undefined
function StatusProbe() {
  statusSnapshot = lib.useLibraryStatus()
  return null
}
const libStatus = () => {
  renderToString(createElement(StatusProbe))
  if (!statusSnapshot) throw new Error('status probe did not run')
  return statusSnapshot
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function settle(cond: () => boolean, timeoutMs = 3000) {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('settle timed out')
    await sleep(25)
  }
}

const postCalls = () => calls.filter((c) => c.method === 'POST')

/** Wait until the POST count has held steady, i.e. in-flight flushes drained. */
async function waitForQuiet(stableMs = 150, timeoutMs = 5000) {
  const t0 = Date.now()
  let last = postCalls().length
  let stableSince = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    await sleep(50)
    const current = postCalls().length
    if (current === last) {
      if (Date.now() - stableSince >= stableMs) return
    } else {
      last = current
      stableSince = Date.now()
    }
  }
}

function makeEntry(overrides: Record<string, unknown> = {}): Entry {
  return {
    id: 1,
    mediaType: 'tv',
    title: 'Show',
    year: '2020',
    poster: null,
    customPoster: null,
    backdrop: null,
    rating: null,
    status: 'planned',
    favorite: false,
    addedAt: 1_700_000_000_000,
    watchedAt: null,
    runtime: null,
    episodes: {},
    totalEpisodes: null,
    rewatches: [],
    rewatching: false,
    rewatchEpisodes: {},
    ...overrides,
  } as Entry
}

describe('normalizeEntry', () => {
  it('renames the retired completed status', () => {
    const out = lib.normalizeEntry(makeEntry({ status: 'completed' }) as Entry)
    assert.equal(out.status, 'watched')
  })
  it('maps unknown statuses to planned', () => {
    const out = lib.normalizeEntry(makeEntry({ status: 'paused' }) as Entry)
    assert.equal(out.status, 'planned')
  })
  it('movies never carry dropped or rewatch state', () => {
    const out = lib.normalizeEntry(makeEntry({ mediaType: 'movie', status: 'dropped', rewatching: true, rewatchEpisodes: { '1-1': 1 } }) as Entry)
    assert.equal(out.status, 'planned')
    assert.equal(out.rewatching, false)
    assert.deepEqual(out.rewatchEpisodes, {})
  })
  it('a dropped show keeps its status while progress remains', () => {
    const out = lib.normalizeEntry(makeEntry({ status: 'dropped', episodes: { '1-1': 1_700_000_000_000 } }) as Entry)
    assert.equal(out.status, 'dropped')
  })
  it('a dropped show with an empty log falls back to planned (server invariant)', () => {
    const out = lib.normalizeEntry(makeEntry({ status: 'dropped', episodes: {} }) as Entry)
    assert.equal(out.status, 'planned')
  })
  it('coerces scalars and clamps bounds', () => {
    const out = lib.normalizeEntry(makeEntry({
      rating: 11,
      runtime: 1000,
      totalEpisodes: 99999,
      year: '20201',
      title: 'x'.repeat(500),
      episodes: { 'bad-key': 1, '1-2': NaN, '3-4': 1_700_000_000_000 },
      rewatches: [1_700_000_000_000, 'nope', Infinity],
    }) as Entry)
    assert.equal(out.rating, null)
    assert.equal(out.runtime, 600)
    assert.equal(out.totalEpisodes, 10000)
    assert.equal(out.year, '2020')
    assert.equal(out.title.length, 200)
    assert.deepEqual(out.episodes, { '3-4': 1_700_000_000_000 })
    assert.deepEqual(out.rewatches, [1_700_000_000_000])
  })
  it('drops unsafe poster paths', () => {
    const out = lib.normalizeEntry(makeEntry({ poster: 'https://evil/x.jpg', backdrop: '/safe.jpg' }) as Entry)
    assert.equal(out.poster, null)
    assert.equal(out.backdrop, '/safe.jpg')
  })
})

describe('keys', () => {
  it('isSafeKey accepts only well-formed ids', () => {
    assert.equal(lib.isSafeKey('movie:123'), true)
    assert.equal(lib.isSafeKey('tv:1'), true)
    assert.equal(lib.isSafeKey('movie:0'), false)
    assert.equal(lib.isSafeKey('movie:1.5'), false)
    assert.equal(lib.isSafeKey('book:1'), false)
    assert.equal(lib.isSafeKey('__proto__'), false)
  })
  it('epKey joins season and episode', () => {
    assert.equal(lib.epKey(2, 14), '2-14')
  })
})

describe('date helpers', () => {
  it('rejects rolled-over dates instead of returning NaN', () => {
    assert.equal(lib.fromDateInput('2024-02-30'), null)
    assert.equal(lib.fromDateInput('garbage'), null)
    assert.equal(lib.fromDateInput('2024-13-01'), null)
  })
  it('round-trips dates through local midday', () => {
    const ts = lib.fromDateInput('2024-02-29')
    assert.ok(ts != null)
    assert.equal(lib.toDateInput(ts!), '2024-02-29')
  })
  it('returns empty strings for invalid stamps', () => {
    assert.equal(lib.toDateInput(NaN), '')
    assert.equal(lib.toDateInput(Number.POSITIVE_INFINITY), '')
  })
})

describe('formatRelativeDay', () => {
  const now = lib.fromDateInput('2024-03-10')!
  const day = 86_400_000
  it('labels today, yesterday, and older ranges', () => {
    assert.equal(lib.formatRelativeDay(now, now), 'Today')
    assert.equal(lib.formatRelativeDay(now - day, now), 'Yesterday')
    assert.equal(lib.formatRelativeDay(now - 3 * day, now), '3d ago')
    assert.equal(lib.formatRelativeDay(now - 40 * day, now), '1mo ago')
  })
  it('treats future stamps as data errors, not “Today”', () => {
    assert.equal(lib.formatRelativeDay(now + day, now), 'Unknown date')
  })
  it('falls back for invalid stamps', () => {
    assert.equal(lib.formatRelativeDay(NaN, now), 'Unknown date')
  })
})

describe('derived metrics', () => {
  it('countStatuses folds legacy movie-dropped into planned', () => {
    const counts = lib.countStatuses([
      makeEntry({ mediaType: 'movie', status: 'dropped' }) as Entry,
      makeEntry({ status: 'watching' }) as Entry,
    ])
    assert.equal(counts.planned, 1)
    assert.equal(counts.watching, 1)
  })
  it('progress respects rewatch state and caps at 1', () => {
    assert.equal(lib.progress(makeEntry({ totalEpisodes: 10, episodes: ep(5) }) as Entry), 0.5)
    assert.equal(lib.progress(makeEntry({ mediaType: 'movie', watchedAt: 1 }) as Entry), 1)
    assert.equal(lib.progress(makeEntry({ totalEpisodes: 10, rewatching: true, rewatchEpisodes: ep(3) }) as Entry), 0.3)
  })
  it('minutesWatched counts rewatches for movies and episodes for shows', () => {
    const movie = makeEntry({ mediaType: 'movie', runtime: 90, watchedAt: 1, rewatches: [2, 3] }) as Entry
    assert.equal(lib.minutesWatched([movie]), 270)
    const show = makeEntry({ totalEpisodes: 10, episodes: ep(10), rewatches: [2] }) as Entry
    assert.equal(lib.minutesWatched([show]), 20 * 42)
  })
  it('isCompletedAtLeastOnce and canLogRewatch agree', () => {
    const done = makeEntry({ status: 'watched' }) as Entry
    assert.equal(lib.isCompletedAtLeastOnce(done), true)
    assert.equal(lib.canLogRewatch(done), true)
    const planned = makeEntry({}) as Entry
    assert.equal(lib.isCompletedAtLeastOnce(planned), false)
    assert.equal(lib.canLogRewatch(planned), false)
    const rewatching = makeEntry({ status: 'watched', rewatching: true }) as Entry
    assert.equal(lib.canLogRewatch(rewatching), false)
    assert.equal(lib.rewatchLockedReason(rewatching), 'Finish the episode list to log this rewatch.')
  })
  it('activityByMonth buckets completions by calendar month', () => {
    const now = new Date()
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 15, 12).getTime()
    const movie = makeEntry({ mediaType: 'movie', watchedAt: thisMonth }) as Entry
    const rows = lib.activityByMonth([movie], 3)
    assert.equal(rows.length, 3)
    const current = rows.find((r: { month: string }) => r.month === `${now.getFullYear()}-${now.getMonth()}`)
    assert.ok(current)
    assert.equal(current!.count, 1)
  })
})

function ep(n: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (let i = 1; i <= n; i++) out[`1-${i}`] = 1_700_000_000_000 + i
  return out
}

describe('parseLibraryImport', () => {
  it('imports new rows, merges collisions, and skips invalid rows', () => {
    const existing = [makeEntry({ id: 5, rating: 9, status: 'watching' }) as Entry]
    const text = JSON.stringify([
      { id: 5, mediaType: 'tv', title: 'Incoming', rating: 3 },
      { id: 6, mediaType: 'movie', title: 'New Film' },
      { id: 0, mediaType: 'tv', title: 'Bad' },
      { id: 7, mediaType: 'person', title: 'Not a title' },
    ])
    const result = lib.parseLibraryImport(text, existing)
    assert.equal(result.imported, 1)
    assert.equal(result.combined, 1)
    assert.equal(result.skipped, 2)
    // Existing curated fields win on collision.
    assert.equal(result.merged['tv:5'].rating, 9)
    assert.equal(result.merged['tv:5'].status, 'watching')
  })
  it('a dropped import without progress normalizes to planned', () => {
    const text = JSON.stringify([{ id: 8, mediaType: 'tv', title: 'D', status: 'dropped', episodes: {} }])
    const result = lib.parseLibraryImport(text, [])
    assert.equal(result.merged['tv:8'].status, 'planned')
  })
  it('a dropped import with progress keeps dropped', () => {
    const text = JSON.stringify([{ id: 9, mediaType: 'tv', title: 'D2', status: 'dropped', episodes: { '1-1': 1_700_000_000_000 } }])
    const result = lib.parseLibraryImport(text, [])
    assert.equal(result.merged['tv:9'].status, 'dropped')
  })
  it('rejects malformed documents', () => {
    assert.throws(() => lib.parseLibraryImport('not json', []), /could not be read/)
    assert.throws(() => lib.parseLibraryImport('{}', []), /list of titles/)
  })
})

describe('episode edits (hook)', () => {
  it('unmarking the last episode of a dropped show falls back to planned instead of a server-rejected state', async () => {
    await settle(() => lib.isLibraryHydrated())
    api.replaceAll({ 'tv:100': makeEntry({ id: 100, status: 'dropped', episodes: { '1-1': 1_700_000_000_000 } }) })
    api.toggleEpisode(100, 1, 1)
    const entry = api.get('tv', 100)
    assert.ok(entry)
    assert.equal(entry!.status, 'planned')
    assert.deepEqual(entry!.episodes, {})
  })
  it('adding progress to a dropped show resumes it as watching', async () => {
    api.replaceAll({ 'tv:101': makeEntry({ id: 101, status: 'dropped', episodes: { '1-1': 1_700_000_000_000 } }) })
    api.toggleEpisode(101, 1, 2)
    const entry = api.get('tv', 101)
    assert.equal(entry!.status, 'watching')
    assert.equal(Object.keys(entry!.episodes).length, 2)
  })
  it('auto-completes a series when the final episode is marked', async () => {
    api.replaceAll({ 'tv:102': makeEntry({ id: 102, totalEpisodes: 2, episodes: { '1-1': 1 } }) })
    api.toggleEpisode(102, 1, 2)
    const entry = api.get('tv', 102)
    assert.equal(entry!.status, 'watched')
    assert.ok(entry!.watchedAt != null)
  })
  it('clearing a season on a dropped show falls back to planned', async () => {
    api.replaceAll({ 'tv:103': makeEntry({ id: 103, status: 'dropped', episodes: { '1-1': 1, '1-2': 2 } }) })
    api.setSeasonWatched(103, 1, [1, 2], false)
    const entry = api.get('tv', 103)
    assert.equal(entry!.status, 'planned')
  })
  it('completed shows refuse episode edits until a rewatch starts', async () => {
    api.replaceAll({ 'tv:104': makeEntry({ id: 104, status: 'watched', totalEpisodes: 2, episodes: ep(2) }) })
    api.toggleEpisode(104, 1, 1)
    const entry = api.get('tv', 104)
    assert.equal(entry!.status, 'watched')
    assert.equal(Object.keys(entry!.episodes).length, 2)
  })
})

describe('database flush', () => {
  it('chunks a large pending batch into multiple requests', async () => {
    // Start from an empty library so the batch contains exactly the 100 rows
    // below (no delete-tombstones from earlier tests mixed into the chunks).
    api.clear()
    await waitForQuiet(250)
    const big: Record<string, Entry> = {}
    const base = Date.now()
    for (let i = 1; i <= 100; i++) {
      const episodes: Record<string, number> = {}
      for (let s = 1; s <= 200; s++) {
        for (let e = 1; e <= 100; e++) episodes[`${s}-${e}`] = base + i
      }
      big[`tv:${i}`] = makeEntry({ id: i, episodes })
    }
    const before = postCalls().length
    api.replaceAll(big)
    await settle(() => postCalls().length - before >= 2, 10_000)
    const posts = postCalls().slice(before)
    assert.ok(posts.length >= 2)
    const totalKeys = posts.reduce((sum, call) => {
      const parsed = JSON.parse(call.body) as { changes: Record<string, unknown> }
      return sum + Object.keys(parsed.changes).length
    }, 0)
    assert.equal(totalKeys, 100)
    assert.ok(api.get('tv', 50))
  })
  it('stops retrying after a permanent rejection instead of wedging later saves', async () => {
    await waitForQuiet(250)
    behavior.postStatus = 413
    behavior.postBody = JSON.stringify({ error: 'Database file too large — remove some titles to continue saving' })
    const before = postCalls().length
    api.replaceAll({ 'tv:200': makeEntry({ id: 200 }) })
    await settle(() => postCalls().length > before)
    // Let any (buggy) first retry at ~1s fire.
    await sleep(1500)
    const count = postCalls().length
    await sleep(1500)
    assert.equal(postCalls().length, count)
    // The library is reconciled with what the database actually holds, so the
    // UI never shows a title that will vanish on reload…
    await settle(() => !api.get('tv', 200))
    // …and the rejection is surfaced instead of only logged.
    assert.match(lib.isLibraryHydrated() ? libStatus().saveError ?? '' : '', /couldn't be saved/)
    behavior.postStatus = 200
  })
})
