import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from 'react'
import type { MediaType, TmdbTitle } from './lib/tmdb'
import { useSetting } from './lib/settings'
import {
  documentTitleFor,
  hashFor,
  HOME,
  parseHash,
  routeFromState,
  sameRoute,
  type InfoSlug,
  type Page,
  type Route,
} from './lib/route'
import { Logo, SETTINGS_PANEL_ID, Spinner } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'
import { NotFound } from './components/Errors'
import { LoadErrorBanner, SaveStatus } from './components/AppStatus'
import InfoPage from './components/InfoPages'
import type { LibraryView } from './components/Library'

const Home = lazy(() => import('./components/Home'))
const Discover = lazy(() => import('./components/Discover'))
const Library = lazy(() => import('./components/Library'))
const Landing = lazy(() => import('./components/Landing'))
/** One shared import, so the idle prefetch and React.lazy resolve the same module. */
let titleDetailModule: Promise<typeof import('./components/TitleDetail')> | null = null
const loadTitleDetail = () => (titleDetailModule ??= import('./components/TitleDetail'))
const TitleDetail = lazy(loadTitleDetail)
const SettingsPanel = lazy(() => import('./components/SettingsPanel'))

const NAV: { id: Page; label: string; key: string }[] = [
  { id: 'home', label: 'Home', key: '1' },
  { id: 'discover', label: 'Discover', key: '2' },
  { id: 'library', label: 'Library', key: '3' },
]

const FOOTER_LINKS: { slug: InfoSlug; label: string }[] = [
  { slug: 'privacy', label: 'Privacy' },
  { slug: 'terms', label: 'Terms' },
  { slug: 'about', label: 'About' },
  { slug: 'api', label: 'API' },
]

/** Shown modifier: ⌥ on Apple platforms, Alt everywhere else. */
const NAV_MODIFIER = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|Macintosh/.test(navigator.userAgent ?? '') ? '⌥' : 'Alt'

function initialRoute(): Route {
  if (typeof window === 'undefined') return HOME
  return routeFromState(window.history.state) ?? parseHash(window.location.hash)
}

/** Warm the title drawer's chunk while idle so the first poster click is instant. */
function prefetchTitleDetail() {
  const load = () => void loadTitleDetail().catch(() => {
    titleDetailModule = null // Let the next attempt (or the real open) retry.
  })
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 2000 })
  else setTimeout(load, 1000)
}

export default function App() {
  const [route, setRoute] = useState<Route>(initialRoute)
  const [libraryView, setLibraryView] = useState<LibraryView | null>(null)
  const [settingsMounted, setSettingsMounted] = useState(route.settings)
  const showNavHints = useSetting('showNavHints')
  /** Seed data for an opening title, so the drawer can paint before details load. */
  const seeds = useRef(new Map<string, TmdbTitle>())
  // Route changes are transitions: React keeps the current screen up until the
  // next view (e.g. the lazily loaded title drawer) is ready, instead of
  // flashing a Suspense fallback and then swapping it out.
  const [navigating, startNavigation] = useTransition()
  /** Latest requested route, ahead of any transition still rendering it. */
  const routeRef = useRef(route)

  /** Move to a new view, recording it in browser history. */
  const navigate = useCallback((next: Route, options: { replace?: boolean } = {}) => {
    const current = routeRef.current
    if (sameRoute(current, next)) return
    const url = `${window.location.pathname}${window.location.search}${hashFor(next)}`
    const state = { cinetrack: next, pushed: !options.replace || window.history.state?.pushed === true }
    if (options.replace) window.history.replaceState(state, '', url)
    else window.history.pushState(state, '', url)
    routeRef.current = next
    startNavigation(() => setRoute(next))
  }, [])

  /** Close an overlay: step back if the app opened it, otherwise replace. */
  const dismiss = useCallback((next: Route) => {
    if (window.history.state?.pushed === true && routeFromState(window.history.state)) window.history.back()
    else navigate(next, { replace: true })
  }, [navigate])

  // Record the initial route on the entry the browser loaded, so Back from
  // the first pushed view restores it exactly.
  useEffect(() => {
    if (!routeFromState(window.history.state)) {
      window.history.replaceState({ cinetrack: routeRef.current, pushed: false }, '', `${window.location.pathname}${window.location.search}${hashFor(routeRef.current)}`)
    }
    prefetchTitleDetail()
  }, [])

  useEffect(() => {
    const sync = () => {
      const next = routeFromState(window.history.state) ?? parseHash(window.location.hash)
      if (!routeFromState(window.history.state)) {
        // A typed URL or a plain `#discover` link: adopt it as an app entry.
        window.history.replaceState({ cinetrack: next, pushed: true }, '', window.location.href)
      }
      routeRef.current = next
      startNavigation(() => setRoute((current) => (sameRoute(current, next) ? current : next)))
    }
    window.addEventListener('popstate', sync)
    window.addEventListener('hashchange', sync)
    return () => {
      window.removeEventListener('popstate', sync)
      window.removeEventListener('hashchange', sync)
    }
  }, [])

  useEffect(() => {
    if (route.settings) setSettingsMounted(true)
  }, [route.settings])

  // Page changes: new document title, back to the top, and focus on the new
  // view's heading so keyboard and screen-reader users land in the content.
  const viewKey = route.info ?? (route.notFound ? 'not-found' : route.page)
  const lastView = useRef(viewKey)
  useEffect(() => {
    if (!route.title) document.title = documentTitleFor(route)
  }, [route])
  useLayoutEffect(() => {
    if (lastView.current === viewKey) return
    lastView.current = viewKey
    window.scrollTo({ top: 0 })
    // Pages are lazy: wait (up to ~1 s) for the new view's heading to mount.
    let frame = 0
    let tries = 0
    const focusView = () => {
      const heading = document.querySelector<HTMLElement>('#main-content h1')
      if (!heading && tries++ < 60) {
        frame = requestAnimationFrame(focusView)
        return
      }
      const target = heading ?? document.getElementById('main-content')
      if (!target) return
      if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1')
      target.focus({ preventScroll: true })
    }
    frame = requestAnimationFrame(focusView)
    return () => cancelAnimationFrame(frame)
  }, [viewKey])

  const goPage = useCallback((page: Page, view: LibraryView | null = null) => {
    if (page === 'library') setLibraryView(view)
    navigate({ ...HOME, page })
  }, [navigate])

  const openInfo = useCallback((slug: InfoSlug) => navigate({ ...routeRef.current, info: slug, title: null, settings: false, notFound: null }), [navigate])
  const closeInfo = useCallback(() => dismiss({ ...routeRef.current, info: null }), [dismiss])

  const openTitle = useCallback((type: MediaType, id: number, seed?: TmdbTitle) => {
    if (seed) seeds.current.set(`${type}:${id}`, seed)
    const current = routeRef.current
    // A title opened from inside another title replaces it, so Close and Back
    // both return to the page underneath rather than to the previous title.
    navigate({ ...current, title: { type, id }, settings: false }, { replace: !!current.title })
  }, [navigate])
  const closeTitle = useCallback(() => dismiss({ ...routeRef.current, title: null }), [dismiss])

  const setSettingsOpen = useCallback((open: boolean) => {
    const current = routeRef.current
    if (open === current.settings) return
    if (open) navigate({ ...current, settings: true })
    else dismiss({ ...current, settings: false })
  }, [navigate, dismiss])

  // Alt+1/2/3 jumps between sections, Alt+, toggles settings. Physical codes,
  // not e.key: macOS Option+digit types ¡™£ instead of the digit.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const focusedTarget = e.target instanceof HTMLElement ? e.target : null
      // Never steal a keystroke while the user is typing into a control.
      if (focusedTarget?.closest('input, textarea, select, [contenteditable="true"]')) return
      const dialog = focusedTarget?.closest('[role="dialog"], [role="alertdialog"]')
      if (e.code === 'Comma') {
        // Alt+, must keep working inside the settings drawer it opened; any
        // other dialog keeps its shortcuts to itself.
        if (dialog && !(dialog instanceof HTMLElement && dialog.id === SETTINGS_PANEL_ID)) return
        e.preventDefault()
        setSettingsOpen(!routeRef.current.settings)
        return
      }
      if (dialog) return
      const digit = e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Numpad') ? e.code.slice(6) : null
      const target = NAV.find((n) => n.key === digit)
      if (!target) return
      e.preventDefault()
      goPage(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goPage, setSettingsOpen])

  const activePage = route.info || route.notFound ? null : route.page
  const titleSeed = route.title ? seeds.current.get(`${route.title.type}:${route.title.id}`) : undefined

  return (
    <div className="flex min-h-screen flex-col text-foreground">
      <NavigationProgress active={navigating} />
      <a
        href="#main-content"
        onClick={(e) => {
          e.preventDefault()
          document.getElementById('main-content')?.focus()
        }}
        className="sr-only z-[200] bg-[var(--foreground)] px-4 py-2 text-[var(--background)] focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-xl backdrop-saturate-150">
        {/* Three tracks so the nav sits optically centred regardless of side widths.
            Stretch, not centre: the nav buttons run the full header height so the
            active rule rests on the bottom border. */}
        <div className="grid w-full grid-cols-2 items-stretch gap-3 px-4 md:grid-cols-[1fr_auto_1fr] md:gap-4 lg:px-6">
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault()
              goPage('welcome')
            }}
            aria-label="About CineTrack"
            className="press flex items-center justify-self-start py-3"
          >
            <Logo size={24} markSize={44} wordmark={false} />
          </a>

          <nav aria-label="Main" className="quiet-scroll order-3 col-span-2 flex items-stretch justify-center gap-1 overflow-x-auto md:order-none md:col-span-1 md:col-start-2">
            {NAV.map((n) => (
              <a
                key={n.id}
                href={hashFor({ ...HOME, page: n.id }) || '#'}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                  e.preventDefault()
                  goPage(n.id)
                }}
                aria-current={activePage === n.id ? 'page' : undefined}
                aria-keyshortcuts={`Alt+${n.key}`}
                title={`${n.label} (${NAV_MODIFIER}${n.key})`}
                className={`relative flex items-center justify-center gap-1.5 px-3 py-3 font-sans text-[12px] font-medium uppercase tracking-[0.14em] transition-colors duration-200 ${
                  activePage === n.id ? 'text-foreground' : 'text-secondary-foreground hover:text-foreground'
                }`}
              >
                <span className="relative">
                  {n.label}
                  <span
                    aria-hidden
                    className={`absolute inset-x-0 bottom-0 h-[2px] origin-left bg-[var(--primary)] transition-transform duration-300 ease-out ${
                      activePage === n.id ? 'scale-x-100' : 'scale-x-0'
                    }`}
                  />
                </span>
                {showNavHints && (
                  <span aria-hidden className="hidden font-sans text-[10px] tracking-[0.1em] text-muted-foreground sm:inline">
                    {NAV_MODIFIER}
                    {n.key}
                  </span>
                )}
              </a>
            ))}
          </nav>

          <div className="flex items-center justify-end gap-4 py-3">
            <SaveStatus />
            <button
              type="button"
              onClick={() => setSettingsOpen(!route.settings)}
              aria-haspopup="dialog"
              aria-expanded={route.settings}
              aria-controls={settingsMounted ? SETTINGS_PANEL_ID : undefined}
              aria-keyshortcuts="Alt+Comma"
              title={showNavHints ? `Settings (${NAV_MODIFIER},)` : 'Settings'}
              className="press flex h-8 items-center gap-2 border border-border bg-card/50 px-3 font-sans text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground transition-colors duration-200 hover:border-[var(--foreground)] hover:text-foreground"
            >
              <span>Settings</span>
              {showNavHints && (
                <span aria-hidden className="hidden text-[10px] tracking-[0.08em] text-muted-foreground opacity-70 sm:inline">
                  {NAV_MODIFIER},
                </span>
              )}
            </button>
          </div>
        </div>
        <LoadErrorBanner />
      </header>

      <main id="main-content" tabIndex={-1} className="w-full flex-1 px-4 pb-12 pt-6 outline-none lg:px-6 lg:pb-16 lg:pt-8">
        <ErrorBoundary resetKey={viewKey} label={viewKey}>
          <Suspense
            fallback={
              <div className="flex min-h-[40vh] items-center justify-center">
                <Spinner size={28} />
              </div>
            }
          >
            <div className="page-enter" key={viewKey}>
              {route.info ? (
                <InfoPage slug={route.info} onBack={closeInfo} />
              ) : route.notFound ? (
                <NotFound
                  title="This page isn’t in CineTrack"
                  message={
                    <>
                      Nothing lives at <code className="break-all font-sans text-foreground">#{route.notFound}</code>. The link may be mistyped or from an older version.
                    </>
                  }
                  actions={[
                    { label: 'Go home', onClick: () => goPage('home') },
                    { label: 'Open library', onClick: () => goPage('library') },
                  ]}
                />
              ) : (
                <>
                  {route.page === 'home' && <Home onOpen={openTitle} onLibraryNavigate={(view) => goPage('library', view)} />}
                  {route.page === 'discover' && <Discover onOpen={openTitle} />}
                  {route.page === 'library' && <Library onOpen={openTitle} initialView={libraryView} />}
                  {route.page === 'welcome' && <Landing onOpen={openTitle} onNavigate={(page) => goPage(page)} />}
                </>
              )}
            </div>
          </Suspense>
        </ErrorBoundary>
      </main>

      <footer className="cinema-footer">
        <div className="cinema-footer-topbar">
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {FOOTER_LINKS.map((link) => (
              <a
                key={link.slug}
                href={`#${link.slug}`}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                  e.preventDefault()
                  openInfo(link.slug)
                }}
                aria-current={route.info === link.slug ? 'page' : undefined}
                className="press font-sans font-medium text-foreground transition-colors hover:text-[var(--primary)]"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <span className="font-sans text-muted-foreground">© {new Date().getFullYear()} CineTrack</span>
        </div>
      </footer>

      <ErrorBoundary
        overlay
        label="overlay"
        resetKey={`${route.title?.type}:${route.title?.id}:${route.settings}`}
        onDismiss={() => dismiss({ ...routeRef.current, title: null, settings: false })}
      >
        <Suspense fallback={null}>
          {(settingsMounted || route.settings) && <SettingsPanel open={route.settings} onClose={() => setSettingsOpen(false)} />}
          {route.title && (
            <TitleDetail
              key={`${route.title.type}-${route.title.id}`}
              type={route.title.type}
              id={route.title.id}
              seed={titleSeed}
              onClose={closeTitle}
              onOpenTitle={openTitle}
            />
          )}
        </Suspense>
      </ErrorBoundary>
    </div>
  )
}

/** Thin progress bar while a navigation waits on code or data (shown only if it's slow). */
function NavigationProgress({ active }: { active: boolean }) {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!active) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), 150)
    return () => window.clearTimeout(timer)
  }, [active])
  if (!visible) return null
  return (
    <div role="progressbar" aria-label="Loading" className="fixed inset-x-0 top-0 z-[120] h-0.5 overflow-hidden bg-[var(--primary)]/20">
      <div className="h-full w-1/3 animate-[ct-progress_900ms_ease-in-out_infinite] bg-[var(--primary)]" />
    </div>
  )
}
