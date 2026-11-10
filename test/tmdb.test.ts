import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { img, isSafeImagePath, titleOf, yearOf, type TmdbTitle } from '../src/lib/tmdb.ts'

describe('isSafeImagePath', () => {
  it('accepts TMDb-relative paths', () => {
    assert.equal(isSafeImagePath('/abc/def-1.jpg'), true)
    assert.equal(isSafeImagePath('/_x.y-z.png'), true)
  })
  it('rejects absolute urls, schemes, and traversal', () => {
    assert.equal(isSafeImagePath('https://evil.example/x.jpg'), false)
    assert.equal(isSafeImagePath('data:text/html,x'), false)
    assert.equal(isSafeImagePath('blob:x'), false)
    assert.equal(isSafeImagePath('/../etc/passwd'), false)
    assert.equal(isSafeImagePath('..\\x'), false)
    assert.equal(isSafeImagePath('x.jpg'), false)
    assert.equal(isSafeImagePath('/a%20b.jpg'), false)
  })
})

describe('img', () => {
  it('builds sized URLs only for safe paths', () => {
    assert.equal(img('/poster.jpg', 'w342'), 'https://image.tmdb.org/t/p/w342/poster.jpg')
    assert.equal(img(null), null)
    assert.equal(img('https://evil'), null)
  })
})

describe('titleOf / yearOf', () => {
  const base: TmdbTitle = { id: 1, poster_path: null, backdrop_path: null, overview: '', vote_average: 0 }
  it('prefers movie titles and falls back to series names', () => {
    assert.equal(titleOf({ ...base, title: 'Film' }), 'Film')
    assert.equal(titleOf({ ...base, name: 'Show' }), 'Show')
    assert.equal(titleOf(base), 'Untitled')
  })
  it('derives the year from either date field', () => {
    assert.equal(yearOf({ ...base, release_date: '1999-03-12' }), '1999')
    assert.equal(yearOf({ ...base, first_air_date: '2010-09-01' }), '2010')
    assert.equal(yearOf(base), '')
  })
})
