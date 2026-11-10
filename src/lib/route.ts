/**
 * URL ⇄ view state. The hash carries everything needed for a deep link:
 *
 *   #                 Home              #discover / #library   pages
 *   #welcome          the landing page (the nav logo opens it)
 *   #about …          info pages        #title/movie/550       a title drawer
 *   anything else     the Not Found page (the hash is kept as typed)
 *
 * History entries the app pushes carry `{ cinetrack: Route }` so Back can
 * restore the page underneath an overlay and close overlays one at a time.
 */
import type { MediaType } from './entry'

export type Page = 'home' | 'discover' | 'library' | 'welcome'
export type InfoSlug = 'about' | 'privacy' | 'terms' | 'api'
export type Route = {
  page: Page
  info: InfoSlug | null
  title: { type: MediaType; id: number } | null
  settings: boolean
  /** The unrecognised hash (without `#`) when the link points nowhere. */
  notFound: string | null
}

export const INFO_SLUGS: readonly InfoSlug[] = ['about', 'privacy', 'terms', 'api']
const PAGES: readonly Page[] = ['home', 'discover', 'library', 'welcome']

export const HOME: Route = { page: 'home', info: null, title: null, settings: false, notFound: null }

const MAX_NOT_FOUND_LENGTH = 200

/** Parse a location hash (`#library`, `#/library`, `#title/tv/1399`). */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '').trim()
  const titleMatch = /^title\/(movie|tv)\/(\d{1,10})$/.exec(raw)
  if (titleMatch) {
    const id = Number(titleMatch[2])
    if (Number.isSafeInteger(id) && id > 0) return { ...HOME, title: { type: titleMatch[1] as MediaType, id } }
  }
  if ((INFO_SLUGS as readonly string[]).includes(raw)) return { ...HOME, info: raw as InfoSlug }
  if ((PAGES as readonly string[]).includes(raw)) return { ...HOME, page: raw as Page }
  if (!raw) return HOME
  return { ...HOME, notFound: raw.slice(0, MAX_NOT_FOUND_LENGTH) }
}

export function hashFor(route: Route): string {
  if (route.title) return `#title/${route.title.type}/${route.title.id}`
  if (route.info) return `#${route.info}`
  if (route.notFound) return `#${route.notFound}`
  return route.page === 'home' ? '' : `#${route.page}`
}

/** The route recorded on a history entry, if the app pushed it. */
export function routeFromState(state: unknown): Route | null {
  const route = (state as { cinetrack?: unknown } | null)?.cinetrack as Partial<Route> | undefined
  if (!route || typeof route !== 'object' || !(PAGES as readonly string[]).includes(route.page as string)) return null
  const title = route.title && typeof route.title === 'object' && (route.title.type === 'movie' || route.title.type === 'tv') && Number.isSafeInteger(route.title.id)
    ? { type: route.title.type, id: route.title.id }
    : null
  const info = (INFO_SLUGS as readonly string[]).includes(route.info as string) ? (route.info as InfoSlug) : null
  const notFound = typeof route.notFound === 'string' && route.notFound && route.notFound.length <= MAX_NOT_FOUND_LENGTH ? route.notFound : null
  return { page: route.page as Page, info, title, settings: route.settings === true, notFound }
}

export const sameRoute = (a: Route, b: Route) =>
  a.page === b.page && a.info === b.info && a.settings === b.settings && a.notFound === b.notFound &&
  a.title?.type === b.title?.type && a.title?.id === b.title?.id

const PAGE_LABEL: Record<Page, string> = { home: 'Home', discover: 'Discover', library: 'Library', welcome: 'Welcome' }
const INFO_LABEL: Record<InfoSlug, string> = { about: 'About', privacy: 'Privacy', terms: 'Terms', api: 'API' }

export function documentTitleFor(route: Route): string {
  if (route.info) return `${INFO_LABEL[route.info]} · CineTrack`
  if (route.notFound) return 'Not found · CineTrack'
  if (route.page === 'welcome') return 'CineTrack · A ledger for films and television'
  return route.page === 'home' ? 'CineTrack' : `${PAGE_LABEL[route.page]} · CineTrack`
}
