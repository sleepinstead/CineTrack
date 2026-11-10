import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { documentTitleFor, hashFor, HOME, parseHash, routeFromState, sameRoute } from '../src/lib/route.ts'
import { isNotFoundError, TmdbError } from '../src/lib/tmdb.ts'

describe('not found routes', () => {
  it('keeps known links working', () => {
    assert.deepEqual(parseHash(''), HOME)
    assert.deepEqual(parseHash('#'), HOME)
    assert.equal(parseHash('#library').page, 'library')
    assert.equal(parseHash('#about').info, 'about')
    assert.deepEqual(parseHash('#title/movie/550').title, { type: 'movie', id: 550 })
    assert.equal(parseHash('#library').notFound, null)
  })

  it('marks an unknown hash as not found and keeps it in the URL', () => {
    const route = parseHash('#shelf')
    assert.equal(route.notFound, 'shelf')
    assert.equal(hashFor(route), '#shelf')
    assert.equal(documentTitleFor(route), 'Not found · CineTrack')
    assert.equal(parseHash('#title/movie/0').notFound, 'title/movie/0')
  })

  it('caps the stored hash and round-trips through history state', () => {
    const route = parseHash(`#${'x'.repeat(500)}`)
    assert.equal(route.notFound?.length, 200)
    assert.ok(sameRoute(routeFromState({ cinetrack: route })!, route))
    assert.equal(sameRoute(route, HOME), false)
  })
})

describe('TMDb not found errors', () => {
  it('recognises a 404 and nothing else', () => {
    assert.equal(isNotFoundError(new TmdbError('gone', 404)), true)
    assert.equal(isNotFoundError(new TmdbError('busy', 503)), false)
    assert.equal(isNotFoundError(new Error('404')), false)
  })
})
