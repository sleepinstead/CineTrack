export const MAX_CUSTOM_POSTER_FILE_BYTES = 10 * 1024 * 1024
export const MAX_CUSTOM_POSTER_BYTES = 2 * 1024 * 1024
export const MAX_CUSTOM_POSTER_PIXELS = 32_000_000
export const MAX_CUSTOM_POSTER_WIDTH = 1200
export const MAX_CUSTOM_POSTER_HEIGHT = 1800

const DATA_URL_PREFIX = 'data:image/webp;base64,'
const MAX_CUSTOM_POSTER_DATA_URL_LENGTH = DATA_URL_PREFIX.length + Math.ceil(MAX_CUSTOM_POSTER_BYTES / 3) * 4

/** Fast structural check for library reads and imports; the server validates the full payload too. */
export function isSafeCustomPosterDataUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_CUSTOM_POSTER_DATA_URL_LENGTH || !value.startsWith(DATA_URL_PREFIX)) return false
  const payload = value.slice(DATA_URL_PREFIX.length)
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  if (payload.length / 4 * 3 - padding > MAX_CUSTOM_POSTER_BYTES) return false
  try {
    const header = atob(payload.slice(0, 24))
    const byteLength = payload.length / 4 * 3 - padding
    const riffLength = header.charCodeAt(4) | (header.charCodeAt(5) << 8) | (header.charCodeAt(6) << 16) | (header.charCodeAt(7) << 24)
    const chunk = header.slice(12, 16)
    return header.length >= 16
      && header.slice(0, 4) === 'RIFF'
      && riffLength + 8 === byteLength
      && header.slice(8, 12) === 'WEBP'
      && (chunk === 'VP8 ' || chunk === 'VP8L' || chunk === 'VP8X')
  } catch {
    return false
  }
}

function imageType(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The image could not be read. Try another file.'))
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('The image could not be read. Try another file.'))
    reader.readAsDataURL(blob)
  })
}

/** Validate a local raster image and keep a compact, safe-to-store WebP copy. */
export async function prepareCustomPoster(file: File): Promise<string> {
  if (file.size <= 0) throw new Error('That image is empty.')
  if (file.size > MAX_CUSTOM_POSTER_FILE_BYTES) throw new Error('Choose an image no larger than 10 MB.')

  const signature = imageType(new Uint8Array(await file.slice(0, 12).arrayBuffer()))
  if (!signature || (file.type && file.type !== signature && !(file.type === 'image/jpg' && signature === 'image/jpeg'))) {
    throw new Error('Use a valid JPEG, PNG, or WebP image.')
  }

  if (typeof createImageBitmap !== 'function') throw new Error('This browser cannot process local poster images.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('This image could not be opened. Try another file.')
  }

  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_CUSTOM_POSTER_PIXELS) {
      throw new Error('This image has too many pixels to use as a poster.')
    }
    const scale = Math.min(1, MAX_CUSTOM_POSTER_WIDTH / bitmap.width, MAX_CUSTOM_POSTER_HEIGHT / bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not prepare the poster image.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    let blob: Blob | null = null
    for (const quality of [0.84, 0.72, 0.6, 0.48]) {
      blob = await canvasBlob(canvas, quality)
      if (!blob || blob.type !== 'image/webp') throw new Error('This browser cannot save poster images in a supported format.')
      if (blob.size <= MAX_CUSTOM_POSTER_BYTES) break
    }
    if (!blob || blob.size > MAX_CUSTOM_POSTER_BYTES) throw new Error('The prepared poster is too large. Choose a simpler image.')
    const dataUrl = await blobDataUrl(blob)
    if (!isSafeCustomPosterDataUrl(dataUrl)) throw new Error('The poster image could not be validated. Try another file.')
    return dataUrl
  } finally {
    bitmap.close()
  }
}
