import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { greetingFor } from '../src/lib/greeting.ts'

const at = (hour: number) => new Date(2026, 10, 6, hour, 30)

describe('home greeting', () => {
  it('follows the time of day', () => {
    assert.deepEqual(greetingFor(at(5)), ['Good', 'morning'])
    assert.deepEqual(greetingFor(at(11)), ['Good', 'morning'])
    assert.deepEqual(greetingFor(at(12)), ['Good', 'afternoon'])
    assert.deepEqual(greetingFor(at(17)), ['Good', 'evening'])
    assert.deepEqual(greetingFor(at(22)), ['Late', 'show'])
    assert.deepEqual(greetingFor(at(2)), ['Late', 'show'])
  })
})
