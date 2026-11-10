/**
 * Mounts CineTrack's local API (see ./api.ts) into Vite's dev server
 * (`npm run dev`) and preview server (`npm run start`).
 */
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { createCinetrackApi, resolveDataDir } from './api.ts'

export function cinetrackServer(options: { root: string; dataDir?: string }): Plugin {
  const dataDir = resolveDataDir(options.root, options.dataDir ?? process.env.CINETRACK_DATA_DIR)

  function attach(server: ViteDevServer | PreviewServer, strict: boolean) {
    const log = server.config.logger
    const api = createCinetrackApi({
      root: options.root,
      dataDir,
      strict,
      logger: {
        info: (message) => log.info(message, { timestamp: true }),
        warn: (message) => log.warn(message, { timestamp: true }),
        error: (message) => log.error(message, { timestamp: true }),
      },
    })
    void api.init()
    server.middlewares.use(api.middleware)
    server.httpServer?.once('close', api.close)
  }

  return {
    name: 'cinetrack-server',
    configureServer(server) {
      attach(server, false)
    },
    configurePreviewServer(server) {
      attach(server, true)
    },
  }
}
