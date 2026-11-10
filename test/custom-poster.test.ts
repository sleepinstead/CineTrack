import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeCustomPosterDataUrl } from '../src/lib/custom-poster.ts'

/** Minimal structurally-valid WebP: RIFF header + length + WEBP + VP8 chunk. */
function webpDataUrl(bytes = 20): string {
  const buf = Buffer.alloc(bytes)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(bytes - 8, 4)
  buf.write('WEBP', 8, 'ascii')
  buf.write('VP8 ', 12, 'ascii')
  return `data:image/webp;base64,${buf.toString('base64')}`
}

describe('isSafeCustomPosterDataUrl', () => {
  it('accepts a structurally valid compact webp data url', () => {
    assert.equal(isSafeCustomPosterDataUrl(webpDataUrl()), true)
  })
  it('rejects non-webp prefixes', () => {
    assert.equal(isSafeCustomPosterDataUrl('data:image/png;base64,AAAA'), false)
    assert.equal(isSafeCustomPosterDataUrl('https://example.com/x.webp'), false)
  })
  it('rejects malformed base64 and short payloads', () => {
    assert.equal(isSafeCustomPosterDataUrl('data:image/webp;base64,!!!!'), false)
    assert.equal(isSafeCustomPosterDataUrl('data:image/webp;base64,AAAA'), false)
    assert.equal(isSafeCustomPosterDataUrl('data:image/webp;base64,'), false)
  })
  it('rejects payloads larger than the poster cap', () => {
    const huge = `data:image/webp;base64,${'A'.repeat(2_796_228 + 4)}`
    assert.equal(isSafeCustomPosterDataUrl(huge), false)
  })
  it('rejects wrong RIFF length accounting', () => {
    // 20-byte file but a header claiming a different size.
    const buf = Buffer.alloc(20)
    buf.write('RIFF', 0, 'ascii')
    buf.writeUInt32LE(100, 4)
    buf.write('WEBP', 8, 'ascii')
    buf.write('VP8 ', 12, 'ascii')
    assert.equal(isSafeCustomPosterDataUrl(`data:image/webp;base64,${buf.toString('base64')}`), false)
  })
})
