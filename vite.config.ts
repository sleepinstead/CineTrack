import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'
import { cinetrackServer } from './server/plugin.ts'

const ROOT = import.meta.dirname
const requestedPort = Number(process.env.PORT)
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 8443

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  // Poster requests to image.tmdb.org carry no referrer.
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
}

// The browser only ever talks to this origin: TMDb JSON goes through the local
// proxy, so connect-src needs no third-party host. Posters load from TMDb's
// image CDN; custom posters are validated WebP data URLs.
const CSP_DIRECTIVES = (dev: boolean) => [
  "default-src 'self'",
  // Vite's dev client and React Refresh inject inline/eval'd code; builds don't.
  dev ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'" : "script-src 'self'",
  dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' https://image.tmdb.org data:",
  dev ? "connect-src 'self' ws://127.0.0.1:* ws://localhost:*" : "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'self'",
].join('; ')

export default defineConfig({
  plugins: [react(), tailwindcss(), cinetrackServer({ root: ROOT })],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    cors: false,
    watch: {
      ignored: ['**/data/**', '**/*.sqlite', '**/API.txt'],
    },
    fs: {
      strict: true,
      allow: [
        path.join(ROOT, 'src'),
        path.join(ROOT, 'index.html'),
        path.join(ROOT, 'node_modules/@fontsource'),
        path.join(ROOT, 'node_modules/@fontsource-variable'),
        path.join(ROOT, 'node_modules/vite/dist/client'),
      ],
      // Replaces Vite's defaults, so they are repeated here.
      deny: ['.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}', '.npmrc', '.yarnrc.yml', '**/.git/**', '**/data/**', '**/*.sqlite*', 'API.txt'],
    },
    headers: { ...SECURITY_HEADERS, 'Content-Security-Policy': CSP_DIRECTIVES(true) },
  },
  preview: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    cors: false,
    headers: { ...SECURITY_HEADERS, 'Content-Security-Policy': CSP_DIRECTIVES(false) },
  },
  build: {
    target: 'es2022',
    // Source maps are generated for debugging but never referenced by the bundle.
    sourcemap: 'hidden',
    rolldownOptions: {
      output: {
        // Only React gets its own long-cached chunk; everything else splits
        // along the app's own lazy imports.
        manualChunks(id: string) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor'
          return undefined
        },
      },
    },
  },
})
