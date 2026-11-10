import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceRewatch,
  canSetDropped,
  MAX_REWATCHES,
  statusAfterEpisodeProgress,
  statusOptionsFor,
  statusTransition,
  statusesForMediaType,
  watchedAtAfterProgress,
} from '../src/lib/status.ts'

describe('statusesForMediaType', () => {
  it('movies support an in-progress state besides planned/watched', () => {
    assert.deepEqual([...statusesForMediaType('movie')], ['planned', 'watching', 'watched'])
  })
  it('TV keeps the full set including dropped', () => {
    assert.deepEqual([...statusesForMediaType('tv')], ['planned', 'watching', 'watched', 'dropped'])
  })
})

describe('canSetDropped / statusOptionsFor', () => {
  it('only an actively watched show with progress can be dropped', () => {
    assert.equal(canSetDropped('tv', 'watching', 3), true)
    assert.equal(canSetDropped('tv', 'watching', 0), false)
    assert.equal(canSetDropped('tv', 'planned', 3), false)
    assert.equal(canSetDropped('tv', 'watched', 3), false)
    assert.equal(canSetDropped('movie', 'watching', 3), false)
  })
  it('filters dropped out of the option list when it is not allowed', () => {
    assert.deepEqual([...statusOptionsFor('tv', 'watching', 3)], ['planned', 'watching', 'watched', 'dropped'])
    assert.deepEqual([...statusOptionsFor('tv', 'planned', 0)], ['planned', 'watching', 'watched'])
    assert.deepEqual([...statusOptionsFor('movie', 'watching', 3)], ['planned', 'watching', 'watched'])
  })
})

describe('statusAfterEpisodeProgress', () => {
  it('empty log falls back to planned, even after dropped (server invariant)', () => {
    assert.equal(statusAfterEpisodeProgress(true, 0, 10), 'planned')
  })
  it('partial progress means watching', () => {
    assert.equal(statusAfterEpisodeProgress(true, 5, 10), 'watching')
    assert.equal(statusAfterEpisodeProgress(false, 10, 10), 'watching')
    assert.equal(statusAfterEpisodeProgress(true, 3, null), 'watching')
  })
  it('completes when auto-complete is on and every known episode is marked', () => {
    assert.equal(statusAfterEpisodeProgress(true, 10, 10), 'watched')
    assert.equal(statusAfterEpisodeProgress(true, 12, 10), 'watched')
  })
})

describe('statusTransition', () => {
  const now = 1_700_000_000_000
  it('marks watched and stamps the date when one is missing', () => {
    const t = statusTransition('planned', 'watched', null, now)
    assert.deepEqual(t, { status: 'watched', watchedAt: now, clearEpisodes: false })
  })
  it('keeps an existing completion date', () => {
    const t = statusTransition('watching', 'watched', 42, now)
    assert.equal(t.watchedAt, 42)
  })
  it('moving away from watched clears the date', () => {
    const t = statusTransition('watched', 'watching', 42, now)
    assert.equal(t.status, 'watching')
    assert.equal(t.watchedAt, null)
  })
  it('planned resets episode progress except when resuming from dropped', () => {
    assert.equal(statusTransition('watching', 'planned', null, now).clearEpisodes, true)
    assert.equal(statusTransition('watched', 'planned', 42, now).clearEpisodes, true)
    assert.equal(statusTransition('dropped', 'planned', 42, now).clearEpisodes, false)
    assert.equal(statusTransition('dropped', 'planned', 42, now).watchedAt, 42)
  })
  it('dropping preserves the previous completion date', () => {
    const t = statusTransition('watching', 'dropped', 42, now)
    assert.equal(t.status, 'dropped')
    assert.equal(t.watchedAt, 42)
  })
})

describe('watchedAtAfterProgress', () => {
  it('keeps a dropped title’s completion date while unfinished', () => {
    assert.equal(watchedAtAfterProgress('dropped', false, 42, null), 42)
  })
  it('clears the date for an unfinished in-progress title', () => {
    assert.equal(watchedAtAfterProgress('watching', false, 42, 99), null)
  })
  it('uses the latest episode stamp on completion when no watched date exists', () => {
    assert.equal(watchedAtAfterProgress('watching', true, null, 99), 99)
    assert.equal(watchedAtAfterProgress('watching', true, 42, 99), 99)
  })
})

describe('advanceRewatch', () => {
  const base = { rewatching: true, rewatchEpisodes: {}, rewatches: [] as number[] }
  it('does not complete until every known episode is marked', () => {
    const out = advanceRewatch(base, { '1-1': 5 }, 2)
    assert.equal(out.rewatching, true)
    assert.deepEqual(out.rewatchEpisodes, { '1-1': 5 })
    assert.equal(out.rewatches.length, 0)
  })
  it('completes at the latest episode stamp and clears the rewatch log', () => {
    const out = advanceRewatch(base, { '1-1': 5, '1-2': 9 }, 2)
    assert.equal(out.rewatching, false)
    assert.deepEqual(out.rewatchEpisodes, {})
    assert.deepEqual(out.rewatches, [9])
  })
  it('caps the rewatch log but never evicts the completion just recorded', () => {
    const cycle = { ...base, rewatches: Array.from({ length: MAX_REWATCHES }, (_, i) => i) }
    const out = advanceRewatch(cycle, { '1-1': 1, '1-2': 2 }, 2)
    assert.equal(out.rewatches.length, MAX_REWATCHES)
    // The backdated completion (stamp 2) survives; the oldest stamp is dropped.
    assert.ok(out.rewatches.includes(2))
    assert.ok(!out.rewatches.includes(0))
  })
  it('ignores a missing total', () => {
    const out = advanceRewatch(base, { '1-1': 5 }, null)
    assert.equal(out.rewatching, true)
  })
})
