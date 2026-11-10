/**
 * CineTrack's local API as plain Connect-style middleware, independent of
 * Vite so tests can mount it on a bare `http.Server`:
 *
 *   /__data/library   GET, HEAD, POST   the library (SQLite)
 *   /__data/settings  GET, HEAD, POST   preferences (SQLite)
 *   /__data/health    GET               storage status
 *   /api/tmdb/*       GET, HEAD         allow-listed TMDb proxy
 *
 * Every route is loopback-only, checks the Host header (DNS rebinding) and the
 * request origin (CSRF / cross-site reads) before doing any work.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createDatabase } from './database.ts'
import { handleLibrary, handleSettings } from './data-routes.ts'
import { createKeyResolver } from './env.ts'
import {
  applyApiHeaders,
  HttpError,
  isLocalHostHeader,
  isLoopbackAddress,
  isSameOriginRequest,
  sendError,
  sendJson,
  type Req,
  type Res,
} from './http.ts'
import { createTmdbProxy } from './tmdb-proxy.ts'

export type Logger = { info(message: string): void; warn(message: string): void; error(message: string): void }

/** Project files that must never be served, whatever the host server's own rules say. */
const BLOCKED_PATHS = [
  /^\/api\.txt$/i,
  /^\/\.env/i,
  /^\/\.git(?:\/|$)/i,
  /^\/vite\.config\./i,
  /^\/(?:data|server|test|dist)(?:\/|$)/i,
  /\.sqlite/i,
  /^\/@fs\//,
]

/**
 * Resolve the data folder. A folder inside the project is only allowed at
 * `<root>/data`: anywhere else (src/, public/) the dev server or the build
 * could serve or bundle the database file.
 */
export function resolveDataDir(root: string, requested?: string): string {
  const projectRoot = path.resolve(root)
  const dir = path.resolve(projectRoot, requested || 'data')
  const relative = path.relative(projectRoot, dir)
  const insideProject = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  if (insideProject && dir !== path.join(projectRoot, 'data')) {
    throw new Error(`CINETRACK_DATA_DIR must be outside the project folder or exactly ./data (got ${dir}).`)
  }
  return dir
}

export function createCinetrackApi(options: {
  root: string
  dataDir: string
  /** Refuse header-less clients entirely (production preview). */
  strict: boolean
  logger: Logger
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** Folder holding .env / .env.local / API.txt (defaults to `root`). */
  configRoot?: string
}) {
  const configRoot = options.configRoot ?? options.root
  const { logger } = options
  const db = createDatabase({
    dataDir: options.dataDir,
    wasmPath: path.join(options.root, 'node_modules/sql.js/dist/sql-wasm.wasm'),
  })
  const keys = createKeyResolver(configRoot, options.env)
  const handleTmdb = createTmdbProxy({
    getKey: keys.get,
    isBearerToken: keys.isBearerToken,
    logWarn: (message) => logger.warn(message),
    fetchImpl: options.fetchImpl,
  })
  /** Last storage failure, as a short code plus a message safe to show users. */
  let storageError: { code: string; message: string } | null = null

  function noteStorageError(error: unknown) {
    if (error instanceof HttpError) {
      const code = error.status === 423 ? 'locked' : error.status === 413 || error.status === 507 ? 'full' : 'unavailable'
      storageError = { code, message: error.message }
    } else {
      storageError = { code: 'unavailable', message: 'The local database could not be read or written. See the terminal for details.' }
    }
  }

  async function init() {
    const envKey = (options.env ?? process.env).VITE_TMDB_KEY
    if (envKey) logger.warn('[cinetrack] VITE_TMDB_KEY is embedded into the browser bundle by Vite — rename it to TMDB_KEY.')
    if (!keys.get()) logger.warn('[cinetrack] No TMDb API key found. Add TMDB_KEY=<your key> to .env to enable search and artwork.')
    for (const name of ['.env', '.env.local', 'API.txt']) {
      try {
        const mode = fs.statSync(path.join(configRoot, name)).mode
        if (process.platform !== 'win32' && mode & 0o077) {
          logger.warn(`[cinetrack] ${name} is readable by other users on this machine. Run: chmod 600 ${name}`)
        }
      } catch {
        // Not present.
      }
    }
    try {
      await db.init()
      storageError = null
    } catch (error) {
      noteStorageError(error)
      logger.error(`[cinetrack] Database unavailable at ${db.file}: ${(error as Error).message}`)
    }
  }

  async function middleware(req: Req, res: Res, next: (err?: unknown) => void) {
    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    let decoded = pathname
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      // Keep the raw path; it simply won't match a route.
    }
    if (BLOCKED_PATHS.some((pattern) => pattern.test(decoded))) {
      res.statusCode = 404
      res.end()
      return
    }
    // Vite's "open in editor" helper has no origin check of its own: any web
    // page could make it open arbitrary local paths in the user's editor.
    if (pathname.startsWith('/__open-in-editor') && req.headers['sec-fetch-site'] !== 'same-origin') {
      res.statusCode = 403
      res.end()
      return
    }

    const isTmdb = pathname === '/api/tmdb' || pathname.startsWith('/api/tmdb/')
    const isData = pathname.startsWith('/__data/')
    if (!isTmdb && !isData) {
      next()
      return
    }

    applyApiHeaders(res)
    try {
      if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'Forbidden')
      if (!isLocalHostHeader(req.headers.host)) throw new HttpError(403, 'Forbidden host')
      if (!isSameOriginRequest(req, options.strict)) throw new HttpError(403, 'Forbidden origin')

      if (isTmdb) {
        const raw = req.url ?? ''
        await handleTmdb(req, res, raw.slice(raw.indexOf('/api/tmdb') + '/api/tmdb'.length))
      } else if (pathname === '/__data/library') {
        await handleLibrary(req, res, db)
        storageError = null
      } else if (pathname === '/__data/settings') {
        await handleSettings(req, res, db)
        storageError = null
      } else if (pathname === '/__data/health') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed')
        sendJson(res, storageError ? 503 : 200, { ok: !storageError, ...(storageError ?? {}) }, { 'Cache-Control': 'no-store' })
      } else {
        throw new HttpError(404, 'Not found')
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy()
        return
      }
      const isClientError = error instanceof HttpError && error.status < 500 && error.status !== 423
      if (isData && !isClientError) noteStorageError(error)
      if (error instanceof HttpError) {
        if (error.status >= 500) logger.error(`[cinetrack] ${req.method} ${pathname}: ${error.message}`)
        sendError(res, error.status, error.message)
        return
      }
      logger.error(`[cinetrack] ${req.method} ${pathname} failed: ${(error as Error)?.message ?? String(error)}`)
      sendError(res, 500, isData ? storageError?.message ?? 'Internal error' : 'Internal error')
    }
  }

  return { middleware, init, close: () => db.close(), databaseFile: db.file }
}
