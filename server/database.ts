/**
 * SQLite persistence via sql.js (WASM). The database lives in memory and is
 * written to `<dataDir>/database.sqlite` after every committed change.
 *
 * Guarantees:
 * - One in-memory handle is reused across requests; it is reloaded only when
 *   the file on disk changes underneath us (e.g. the user restores a copy).
 * - Writes are serialized and atomic: the new image goes to a temp file that
 *   is fsynced and renamed over the old one, so a crash mid-write leaves the
 *   previous database intact instead of a torn file.
 * - A damaged database file is never moved, replaced, or overwritten.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpError } from './http.ts'

/** The slice of the sql.js Database API this server uses. */
export type SqlStatement = {
  bind(values: unknown[]): boolean
  step(): boolean
  get(): unknown[]
  run(values?: unknown[]): void
  reset(): void
  free(): boolean
}
export type SqlDatabase = {
  run(sql: string, params?: unknown[]): void
  exec(sql: string): { columns: string[]; values: unknown[][] }[]
  prepare(sql: string): SqlStatement
  export(): Uint8Array
  close(): void
}
type SqlJsStatic = { Database: new (data?: Uint8Array) => SqlDatabase }

export const MAX_DATABASE_BYTES = 64 * 1024 * 1024
const SCHEMA_VERSION = 1

const LIBRARY_COLUMNS: [string, string][] = [
  ['media_type', 'TEXT'],
  ['id', 'INTEGER'],
  ['title', 'TEXT'],
  ['year', 'TEXT'],
  ['poster', 'TEXT'],
  ['backdrop', 'TEXT'],
  ['rating', 'REAL'],
  ['status', 'TEXT'],
  ['favorite', 'INTEGER DEFAULT 0'],
  ['added_at', 'INTEGER'],
  ['watched_at', 'INTEGER'],
  ['runtime', 'INTEGER'],
  ['total_episodes', 'INTEGER'],
  ['episodes', 'TEXT'],
  ['rewatches', 'TEXT'],
  ['note', 'TEXT'],
  ['json', 'TEXT'],
]

function migrate(db: SqlDatabase) {
  db.run(`
    CREATE TABLE IF NOT EXISTS library (
      key TEXT PRIMARY KEY,
      media_type TEXT, id INTEGER, title TEXT, year TEXT, poster TEXT, backdrop TEXT,
      rating REAL, status TEXT, favorite INTEGER DEFAULT 0, added_at INTEGER,
      watched_at INTEGER, runtime INTEGER, total_episodes INTEGER, episodes TEXT,
      rewatches TEXT, note TEXT, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  // CREATE TABLE IF NOT EXISTS never adds columns to an older file, so bring
  // portable databases from earlier versions up to the current shape.
  const columns = (table: string) =>
    new Set((db.exec(`PRAGMA table_info(${table})`)[0]?.values ?? []).map((row) => String(row[1])))
  const libraryColumns = columns('library')
  for (const [name, definition] of LIBRARY_COLUMNS) {
    if (!libraryColumns.has(name)) db.run(`ALTER TABLE library ADD COLUMN ${name} ${definition}`)
  }
  const settingsColumns = columns('settings')
  if (!settingsColumns.has('key')) db.run('ALTER TABLE settings ADD COLUMN key TEXT')
  if (!settingsColumns.has('value')) db.run('ALTER TABLE settings ADD COLUMN value TEXT')
  // Very early databases stored only the scalar columns; rebuild their JSON
  // so those titles load instead of being silently skipped.
  try {
    db.run(`
      UPDATE library SET json = json_object(
        'id', CAST(substr(key, instr(key, ':') + 1) AS INTEGER),
        'mediaType', substr(key, 1, instr(key, ':') - 1),
        'title', title, 'year', year, 'poster', poster, 'backdrop', backdrop,
        'rating', rating, 'status', status,
        'favorite', json(CASE WHEN favorite THEN 'true' ELSE 'false' END),
        'addedAt', added_at, 'watchedAt', watched_at, 'runtime', runtime,
        'totalEpisodes', total_episodes,
        'episodes', json(CASE WHEN json_valid(episodes) THEN episodes ELSE '{}' END),
        'rewatches', json(CASE WHEN json_valid(rewatches) THEN rewatches ELSE '[]' END),
        'note', note
      )
      WHERE (json IS NULL OR json = '') AND instr(key, ':') > 0
    `)
  } catch {
    // JSON1 unavailable: rows without JSON stay skipped, as before.
  }
  const version = Number(db.exec('PRAGMA user_version')[0]?.values?.[0]?.[0] ?? 0)
  if (version < SCHEMA_VERSION) db.run(`PRAGMA user_version = ${SCHEMA_VERSION}`)
}

/** SQLite's own structural check; a torn or truncated file fails it. */
function assertIntact(db: SqlDatabase) {
  const result = db.exec('PRAGMA quick_check')[0]?.values?.[0]?.[0]
  if (result !== 'ok') throw new Error(String(result ?? 'integrity check failed'))
}

/** Rebuild the file when deleted rows have left a quarter of it empty. */
function compactIfWasteful(db: SqlDatabase) {
  const pages = Number(db.exec('PRAGMA page_count')[0]?.values?.[0]?.[0] ?? 0)
  const free = Number(db.exec('PRAGMA freelist_count')[0]?.values?.[0]?.[0] ?? 0)
  if (pages > 256 && free / pages > 0.25) db.run('VACUUM')
}

type FileStamp = { mtimeMs: number; size: number } | null

function stampOf(file: string): FileStamp {
  try {
    const st = fs.statSync(file)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const sameStamp = (a: FileStamp, b: FileStamp) =>
  a === b || (!!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size)

export type Database = {
  readonly file: string
  /** Run a synchronous read against the current database. */
  read<T>(fn: (db: SqlDatabase) => T): Promise<T>
  /** Run a synchronous change inside a transaction, then persist it atomically. */
  write<T>(fn: (db: SqlDatabase) => T): Promise<T>
  /** Take the single-writer lock, back up the existing file, and create it if missing. */
  init(): Promise<void>
  close(): void
}

export const LOCK_FILE = '.cinetrack.lock'

/** True when another live process holds the data folder's lock. */
function lockHeldByOther(lockPath: string): number | null {
  let pid: number
  try {
    pid = Number(fs.readFileSync(lockPath, 'utf8').trim())
  } catch {
    return null
  }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : null
  }
}

export function createDatabase(options: { dataDir: string; wasmPath: string; maxBytes?: number }): Database {
  const file = path.resolve(options.dataDir, 'database.sqlite')
  const maxBytes = options.maxBytes ?? MAX_DATABASE_BYTES
  let sqlPromise: Promise<SqlJsStatic> | null = null
  let handle: { db: SqlDatabase; stamp: FileStamp } | null = null
  let loading: Promise<SqlDatabase> | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let ownedLock: string | null = null

  function getSql(): Promise<SqlJsStatic> {
    sqlPromise ??= import('sql.js')
      .then((mod) => (mod.default as (config: object) => Promise<SqlJsStatic>)({ locateFile: () => options.wasmPath }))
      .catch((error) => {
        sqlPromise = null
        throw error
      })
    return sqlPromise
  }

  function discard() {
    try {
      handle?.db.close()
    } catch {
      // Already closed.
    }
    handle = null
  }

  async function load(): Promise<SqlDatabase> {
    const SQL = await getSql()
    const stamp = stampOf(file)
    if (stamp && stamp.size > maxBytes) {
      // Fail loudly: falling through to an empty handle would let the next
      // write persist an empty database over the real one.
      throw new HttpError(507, 'The database file is larger than CineTrack can open.')
    }
    let bytes: Buffer | null = null
    if (stamp) {
      try {
        bytes = fs.readFileSync(file)
      } catch (error) {
        throw new Error(`Database file is unreadable: ${(error as Error).message}`, { cause: error })
      }
    }
    let db: SqlDatabase
    try {
      db = bytes ? new SQL.Database(bytes) : new SQL.Database()
      if (bytes) assertIntact(db)
      migrate(db)
    } catch (error) {
      // Keep the sole copy intact and fail the request instead.
      throw new HttpError(500, `The database file is damaged and was left untouched (${(error as Error).message}).`, { cause: error })
    }
    handle = { db, stamp }
    return db
  }

  /** The live handle, reloaded if the file changed since we last saw it. */
  async function current(): Promise<SqlDatabase> {
    if (handle && sameStamp(handle.stamp, stampOf(file))) return handle.db
    if (loading) return loading
    discard()
    loading = load().finally(() => {
      loading = null
    })
    return loading
  }

  function persist(db: SqlDatabase) {
    compactIfWasteful(db)
    const data = db.export()
    if (data.byteLength > maxBytes) {
      throw new HttpError(413, 'The database is full — remove some titles or custom posters to keep saving.')
    }
    // Write beside the real file so a symlinked database (e.g. into a synced
    // folder) is updated in place rather than replaced by a plain file.
    let target = file
    try {
      target = fs.realpathSync(file)
    } catch {
      // Not created yet.
    }
    const dir = path.dirname(target)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = path.join(dir, `.database.sqlite.${process.pid}.${randomUUID()}.tmp`)
    const fd = fs.openSync(temp, 'wx', 0o600)
    try {
      let offset = 0
      while (offset < data.byteLength) {
        const written = fs.writeSync(fd, data, offset, data.byteLength - offset)
        if (written <= 0) throw new Error('Database write made no progress')
        offset += written
      }
      fs.fsyncSync(fd)
    } catch (error) {
      fs.closeSync(fd)
      fs.rmSync(temp, { force: true })
      throw error
    }
    fs.closeSync(fd)
    try {
      fs.renameSync(temp, target)
    } catch (error) {
      fs.rmSync(temp, { force: true })
      throw error
    }
    try {
      const dirFd = fs.openSync(dir, 'r')
      try {
        fs.fsyncSync(dirFd)
      } finally {
        fs.closeSync(dirFd)
      }
    } catch {
      // Directory fsync is unsupported on some platforms (e.g. Windows).
    }
    if (handle?.db === db) handle.stamp = stampOf(file)
  }

  /** Hold the data folder's lock so two servers never write one file. */
  function acquireLock() {
    if (ownedLock) return
    const dir = path.dirname(file)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lockPath = path.join(dir, LOCK_FILE)
    const owner = lockHeldByOther(lockPath)
    if (owner) {
      throw new HttpError(423, `Another CineTrack server (process ${owner}) is using this library. Stop it, then reload this page.`)
    }
    fs.writeFileSync(lockPath, String(process.pid), { mode: 0o600 })
    ownedLock = lockPath
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const guarded = async () => {
      acquireLock()
      return task()
    }
    const run = queue.then(guarded, guarded)
    queue = run.catch(() => undefined)
    return run
  }

  return {
    file,
    async read(fn) {
      // Reads wait for queued writes so a client never reads a state older
      // than a save it has already been told succeeded.
      return enqueue(async () => fn(await current()))
    },
    write(fn) {
      return enqueue(async () => {
        const db = await current()
        db.run('BEGIN IMMEDIATE')
        let result
        try {
          result = fn(db)
          db.run('COMMIT')
        } catch (error) {
          try {
            db.run('ROLLBACK')
          } catch {
            // No open transaction.
          }
          throw error
        }
        try {
          persist(db)
        } catch (error) {
          // Memory now holds a commit the disk never received; drop it so the
          // next request reloads the last durable state.
          discard()
          throw error
        }
        return result
      })
    },
    async init() {
      await enqueue(async () => {
        const db = await current()
        if (!handle?.stamp) {
          persist(db)
        } else {
          // One restore point per server start, taken only from a file that
          // just passed the integrity check.
          fs.copyFileSync(file, `${file}.bak`)
          fs.chmodSync(`${file}.bak`, 0o600)
        }
      })
    },
    close() {
      discard()
      if (ownedLock) {
        try {
          if (fs.readFileSync(ownedLock, 'utf8').trim() === String(process.pid)) fs.rmSync(ownedLock, { force: true })
        } catch {
          // Already gone.
        }
        ownedLock = null
      }
    },
  }
}
