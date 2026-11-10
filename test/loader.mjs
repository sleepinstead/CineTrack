// Preloaded by the test runner (see package.json "test") so Node's native
// loader can resolve the app's extensionless relative imports against .ts/.tsx
// sources. Bare specifiers and subpaths (react, react-dom/server, node:*) pass
// through untouched.
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !(specifier.split('/').pop() ?? '').includes('.')) {
      for (const candidate of [`${specifier}.ts`, `${specifier}.tsx`, `${specifier}.js`]) {
        try {
          const url = new URL(candidate, context.parentURL)
          if (existsSync(fileURLToPath(url))) return nextResolve(url.href, context)
        } catch {
          // fall through to the default resolution
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
