import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createCinetrackApi, resolveDataDir } from '../server/api.ts'
import { canonicalTmdbPath } from '../server/tmdb-proxy.ts'
import { parseDotEnv } from '../server/env.ts'

const ROOT = path.resolve(import.meta.dirname, '..')
const silent = { info() {}, warn() {}, error() {} }

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: string }
type Server = { port: number; close: () => Promise<void>; api: ReturnType<typeof createCinetrackApi> }

async function startServer(options: { dataDir: string; strict?: boolean; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv }): Promise<Server> {
  const api = createCinetrackApi({
    root: ROOT,
    // Never read the developer's real .env: tests control the key explicitly.
    configRoot: options.dataDir,
    dataDir: options.dataDir,
    strict: options.strict ?? false,
    logger: silent,
    fetchImpl: options.fetchImpl,
    env: options.env ?? { TMDB_KEY: 'test-key' },
  })
  await api.init()
  const server = http.createServer((req, res) => {
    void api.middleware(req, res, () => {
      res.statusCode = 299 // "passed through to the host server"
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    port,
    api,
    close: () =>
      new Promise((resolve) => {
        api.close()
        server.close(() => resolve())
      }),
  }
}

function request(port: number, pathname: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method ?? 'GET',
        headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

const postJson = (port: number, pathname: string, body: unknown, headers: Record<string, string> = {}) =>
  request(port, pathname, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } })

const tempDirs: string[] = []
function tempDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cinetrack-test-'))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

const movie = (id: number, extra: Record<string, unknown> = {}) => ({ id, mediaType: 'movie', title: `Film ${id}`, status: 'planned', ...extra })
const show = (id: number, extra: Record<string, unknown> = {}) => ({ id, mediaType: 'tv', title: `Show ${id}`, status: 'planned', ...extra })

describe('request guards', () => {
  let srv: Server
  before(async () => {
    srv = await startServer({ dataDir: tempDataDir() })
  })
  after(() => srv.close())

  it('rejects a rebound Host header', async () => {
    const res = await request(srv.port, '/__data/library', { headers: { Host: 'evil.example:80', Origin: 'http://evil.example:80' } })
    assert.equal(res.status, 403)
  })
  it('rejects cross-site reads and writes', async () => {
    assert.equal((await request(srv.port, '/__data/library', { headers: { Origin: 'https://evil.example' } })).status, 403)
    assert.equal((await postJson(srv.port, '/__data/library', {}, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await request(srv.port, '/__data/library', { headers: { Origin: 'null' } })).status, 403)
  })
  it('lets header-less tools read in development but never write', async () => {
    const headers = { Origin: '' }
    assert.equal((await request(srv.port, '/__data/library', { headers })).status, 200)
    assert.equal((await postJson(srv.port, '/__data/library', {}, headers)).status, 403)
  })
  it('requires a JSON content type for writes', async () => {
    const res = await request(srv.port, '/__data/library', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })
    assert.equal(res.status, 415)
  })
  it('answers unknown methods with 405 and an Allow header', async () => {
    const res = await request(srv.port, '/__data/library', { method: 'DELETE' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.allow, 'GET, HEAD, POST')
  })
  it('sets hardening headers on API responses', async () => {
    const res = await request(srv.port, '/__data/library')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.match(String(res.headers['content-security-policy']), /default-src 'none'/)
    assert.equal(res.headers['cache-control'], 'no-store')
  })
  it('never serves project secrets or internals', async () => {
    for (const p of ['/.env', '/.env.local', '/API.txt', '/data/database.sqlite', '/server/env.ts', '/vite.config.ts', '/x.sqlite', '/%2eenv']) {
      assert.equal((await request(srv.port, p)).status, 404, p)
    }
    assert.equal((await request(srv.port, '/src/main.tsx')).status, 299)
  })
  it("blocks Vite's open-in-editor helper for cross-site requests", async () => {
    assert.equal((await request(srv.port, '/__open-in-editor?file=/etc/hosts', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403)
  })
  it('returns 404 JSON for unknown data routes', async () => {
    const res = await request(srv.port, '/__data/nope')
    assert.equal(res.status, 404)
    assert.deepEqual(JSON.parse(res.body), { error: 'Not found' })
  })
})

describe('strict mode (production preview)', () => {
  it('refuses header-less reads', async () => {
    const srv = await startServer({ dataDir: tempDataDir(), strict: true })
    try {
      assert.equal((await request(srv.port, '/__data/library', { headers: { Origin: '' } })).status, 403)
      assert.equal((await request(srv.port, '/__data/library', { headers: { Origin: '', 'Sec-Fetch-Site': 'same-origin' } })).status, 200)
    } finally {
      await srv.close()
    }
  })
})

describe('library storage', () => {
  let srv: Server
  let dataDir: string
  before(async () => {
    dataDir = tempDataDir()
    srv = await startServer({ dataDir })
  })
  after(() => srv.close())

  it('normalizes records and drops ones that do not match their key', async () => {
    const res = await postJson(srv.port, '/__data/library', {
      changes: {
        'movie:1': movie(1, { rating: 11, poster: 'https://evil/x.jpg', extra: 'field' }),
        'movie:2': movie(3),
        'book:4': { id: 4, mediaType: 'book' },
      },
    })
    assert.equal(res.status, 204)
    const stored = JSON.parse((await request(srv.port, '/__data/library')).body)
    assert.deepEqual(Object.keys(stored), ['movie:1'])
    assert.equal(stored['movie:1'].rating, null)
    assert.equal(stored['movie:1'].poster, null)
    assert.equal('extra' in stored['movie:1'], false)
  })

  it('coerces an invalid Dropped transition instead of rejecting the whole batch', async () => {
    await postJson(srv.port, '/__data/library', { changes: { 'tv:10': show(10) } })
    const res = await postJson(srv.port, '/__data/library', {
      changes: {
        'tv:10': show(10, { status: 'dropped', episodes: { '1-1': 1_700_000_000_000 } }),
        'movie:11': movie(11),
      },
    })
    assert.equal(res.status, 204)
    const stored = JSON.parse((await request(srv.port, '/__data/library')).body)
    assert.equal(stored['tv:10'].status, 'watching')
    assert.ok(stored['movie:11'], 'the unrelated change in the same batch was saved')
  })

  it('allows Dropped from Watching with progress', async () => {
    await postJson(srv.port, '/__data/library', { changes: { 'tv:12': show(12, { status: 'watching', episodes: { '1-1': 1 } }) } })
    await postJson(srv.port, '/__data/library', { changes: { 'tv:12': show(12, { status: 'dropped', episodes: { '1-1': 1 } }) } })
    const stored = JSON.parse((await request(srv.port, '/__data/library')).body)
    assert.equal(stored['tv:12'].status, 'dropped')
  })

  it('deletes with null and clears with the envelope flag', async () => {
    await postJson(srv.port, '/__data/library', { changes: { 'movie:1': null } })
    let stored = JSON.parse((await request(srv.port, '/__data/library')).body)
    assert.equal(stored['movie:1'], undefined)
    await postJson(srv.port, '/__data/library', { clear: true, changes: { 'movie:20': movie(20) } })
    stored = JSON.parse((await request(srv.port, '/__data/library')).body)
    assert.deepEqual(Object.keys(stored), ['movie:20'])
  })

  it('rejects oversized batches', async () => {
    const changes: Record<string, unknown> = {}
    for (let i = 1; i <= 5001; i++) changes[`movie:${i}`] = null
    assert.equal((await postJson(srv.port, '/__data/library', { changes })).status, 413)
    assert.equal((await postJson(srv.port, '/__data/library', [1, 2])).status, 400)
    assert.equal((await request(srv.port, '/__data/library', { method: 'POST', body: '{bad', headers: { 'Content-Type': 'application/json' } })).status, 400)
  })

  it('writes atomically with private permissions and no leftovers', () => {
    const file = path.join(dataDir, 'database.sqlite')
    assert.ok(fs.existsSync(file))
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), [])
  })

  it('picks up a database file replaced on disk', async () => {
    const other = await startServer({ dataDir: tempDataDir() })
    await postJson(other.port, '/__data/library', { changes: { 'movie:99': movie(99) } })
    await other.close()
    fs.copyFileSync(path.join(tempDirs.at(-1)!, 'database.sqlite'), path.join(dataDir, 'database.sqlite'))
    const stored = JSON.parse((await request(srv.port, '/__data/library')).body)
    assert.deepEqual(Object.keys(stored), ['movie:99'])
  })
})

describe('settings storage', () => {
  let srv: Server
  before(async () => {
    srv = await startServer({ dataDir: tempDataDir() })
  })
  after(() => srv.close())

  it('stores valid keys and ignores malformed ones', async () => {
    assert.equal((await postJson(srv.port, '/__data/settings', { theme: 'velvet', 'bad key': 1, constructor: 'x' })).status, 204)
    const stored = JSON.parse((await request(srv.port, '/__data/settings')).body)
    assert.deepEqual(stored, { theme: 'velvet', constructor: 'x' })
  })
  it('rejects oversized values and unbounded growth', async () => {
    assert.equal((await postJson(srv.port, '/__data/settings', { big: 'x'.repeat(20_000) })).status, 413)
    const many: Record<string, number> = {}
    for (let i = 0; i < 250; i++) many[`k${i}`] = i
    assert.equal((await postJson(srv.port, '/__data/settings', many)).status, 413)
  })
})

describe('damaged and legacy databases', () => {
  it('refuses to read or overwrite a corrupt file and reports it', async () => {
    const dataDir = tempDataDir()
    const file = path.join(dataDir, 'database.sqlite')
    const garbage = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 7)])
    fs.writeFileSync(file, garbage)
    const srv = await startServer({ dataDir })
    try {
      assert.equal((await request(srv.port, '/__data/library')).status, 500)
      assert.equal((await postJson(srv.port, '/__data/library', { changes: { 'movie:1': movie(1) } })).status, 500)
      const health = await request(srv.port, '/__data/health')
      assert.equal(health.status, 503)
      assert.equal(JSON.parse(health.body).ok, false)
      assert.deepEqual(fs.readFileSync(file), garbage, 'the damaged file was left untouched')
    } finally {
      await srv.close()
    }
  })

  it('rebuilds records from early databases that stored only columns', async () => {
    const dataDir = tempDataDir()
    const initSqlJs = (await import('sql.js')).default as (config: object) => Promise<{ Database: new () => { run(sql: string): void; export(): Uint8Array } }>
    const SQL = await initSqlJs({ locateFile: () => path.join(ROOT, 'node_modules/sql.js/dist/sql-wasm.wasm') })
    const legacy = new SQL.Database()
    legacy.run("CREATE TABLE library (key TEXT PRIMARY KEY, title TEXT, status TEXT, favorite INTEGER, episodes TEXT)")
    legacy.run(`INSERT INTO library VALUES ('tv:7', 'Old Show', 'watching', 1, '{"1-1":1700000000000}')`)
    fs.writeFileSync(path.join(dataDir, 'database.sqlite'), legacy.export())
    const srv = await startServer({ dataDir })
    try {
      const stored = JSON.parse((await request(srv.port, '/__data/library')).body)
      assert.equal(stored['tv:7']?.title, 'Old Show')
      assert.equal(stored['tv:7']?.status, 'watching')
      assert.equal(stored['tv:7']?.favorite, true)
      assert.deepEqual(stored['tv:7']?.episodes, { '1-1': 1_700_000_000_000 })
    } finally {
      await srv.close()
    }
  })

  it('keeps a restore point from the last good start', async () => {
    const dataDir = tempDataDir()
    const first = await startServer({ dataDir })
    await postJson(first.port, '/__data/library', { changes: { 'movie:5': movie(5) } })
    await first.close()
    const second = await startServer({ dataDir })
    await second.close()
    assert.ok(fs.existsSync(path.join(dataDir, 'database.sqlite.bak')))
  })

  it('refuses to share a data folder with another live server', async () => {
    const dataDir = tempDataDir()
    fs.writeFileSync(path.join(dataDir, '.cinetrack.lock'), String(process.ppid))
    const srv = await startServer({ dataDir })
    try {
      const res = await request(srv.port, '/__data/library')
      assert.equal(res.status, 423)
      assert.match(JSON.parse(res.body).error, /Another CineTrack server/)
    } finally {
      await srv.close()
    }
  })
})

describe('data folder location', () => {
  it('only allows ./data inside the project', () => {
    assert.equal(resolveDataDir('/proj'), '/proj/data')
    assert.equal(resolveDataDir('/proj', '/elsewhere/db'), '/elsewhere/db')
    assert.throws(() => resolveDataDir('/proj', 'public'), /CINETRACK_DATA_DIR/)
    assert.throws(() => resolveDataDir('/proj', '/proj/src/db'), /CINETRACK_DATA_DIR/)
  })
})

describe('TMDb proxy', () => {
  it('canonicalizes allowed paths and rejects everything else', () => {
    assert.equal(canonicalTmdbPath('/movie/550?page=1&language=en-US'), '/movie/550?language=en-US&page=1')
    for (const bad of ['/movie/../account', '/movie/%2e%2e/x', '//movie/1', '/movie\\1', '/account/1', '/movie/1?api_key=x', '/movie/1?page=1&page=2']) {
      assert.throws(() => canonicalTmdbPath(bad), /not allowed|too long/, bad)
    }
  })

  it('caches successes and shares concurrent upstream requests', async () => {
    let calls = 0
    const fakeFetch = (async (input: string | URL) => {
      calls++
      assert.match(String(input), /api_key=test-key/)
      await new Promise((resolve) => setTimeout(resolve, 30))
      return new Response(JSON.stringify({ genres: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const srv = await startServer({ dataDir: tempDataDir(), fetchImpl: fakeFetch })
    try {
      const replies = await Promise.all([1, 2, 3].map(() => request(srv.port, '/api/tmdb/genre/movie/list?language=en-US')))
      assert.deepEqual(replies.map((r) => r.status), [200, 200, 200])
      assert.equal(calls, 1)
      const cached = await request(srv.port, '/api/tmdb/genre/movie/list?language=en-US')
      assert.equal(cached.headers['x-cache'], 'HIT')
      assert.equal(calls, 1)
      assert.ok(!cached.body.includes('test-key'))
    } finally {
      await srv.close()
    }
  })

  it('explains a missing or rejected key and refuses non-JSON upstreams', async () => {
    const noKey = await startServer({ dataDir: tempDataDir(), env: {} })
    try {
      const res = await request(noKey.port, '/api/tmdb/movie/1')
      assert.equal(res.status, 503)
      assert.match(JSON.parse(res.body).error, /TMDB_KEY/)
    } finally {
      await noKey.close()
    }
    const rejected = await startServer({
      dataDir: tempDataDir(),
      fetchImpl: (async () => new Response('{"status_message":"Invalid API key"}', { status: 401, headers: { 'content-type': 'application/json' } })) as typeof fetch,
    })
    try {
      const res = await request(rejected.port, '/api/tmdb/movie/2')
      assert.equal(res.status, 502)
      assert.match(JSON.parse(res.body).error, /rejected the API key/)
    } finally {
      await rejected.close()
    }
    const html = await startServer({
      dataDir: tempDataDir(),
      fetchImpl: (async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
    })
    try {
      assert.equal((await request(html.port, '/api/tmdb/movie/3')).status, 502)
    } finally {
      await html.close()
    }
  })

  it('rejects writes', async () => {
    const srv = await startServer({ dataDir: tempDataDir() })
    try {
      assert.equal((await postJson(srv.port, '/api/tmdb/movie/1', {})).status, 405)
    } finally {
      await srv.close()
    }
  })
})

describe('parseDotEnv', () => {
  it('handles quotes, export, comments and blank lines', () => {
    assert.deepEqual(
      parseDotEnv('# comment\nexport TMDB_KEY="abc"\nOTHER=x # note\n\nQUOTED=\'a # b\'\nEMPTY=\n'),
      { TMDB_KEY: 'abc', OTHER: 'x', QUOTED: 'a # b' },
    )
  })
})
