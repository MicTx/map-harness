/**
 * Incremental FeatureCollection scanner: extracts complete feature objects
 * from successive byte chunks with bounded memory (one feature's text at a
 * time), so classification and aggregation can cover resources larger than
 * the single-read limit without holding the whole file. The scan is exact —
 * every feature is visited once, in file order; sampling must never replace
 * it (design §10.4: computations must not misuse display samples).
 *
 * The scanner trusts the store's admission: registered collections already
 * passed format validation, so malformed bytes terminate the scan with a
 * named error instead of a best-effort recovery.
 *
 * @module @map-harness/spatial-viz/stream
 */

/** The scanner's refusal codes. */
export type StreamScanError =
  | 'invalid-collection-shape'
  | 'truncated-collection'
  | 'invalid-feature-json'
  | 'stream-byte-limit-exceeded'

/** Named scan failure; `message` names the position family, never file contents. */
export class StreamScanFailure extends Error {
  /** Machine-readable refusal code. */
  readonly code: StreamScanError

  /**
   * @param code - the refusal code callers branch on.
   * @param message - operator-facing position or cause description.
   */
  constructor(code: StreamScanError, message: string) {
    super(message)
    this.name = 'StreamScanFailure'
    this.code = code
  }
}

/** Scan limits: the total byte ceiling is the streaming path's protocol constant. */
export interface ScanLimits {
  readonly maxBytes: number
}

/** One parsed feature object as delivered to the visitor. */
export type ScannedFeature = Record<string, unknown>

const HEADER_WINDOW = 64 * 1024
const DECODER = new TextDecoder('utf-8', { fatal: false })

/**
 * Scan a FeatureCollection byte stream feature by feature. Header shape
 * (`"type": "FeatureCollection"` and the `"features"` array) is validated
 * inside a bounded window; each feature object is then extracted with a
 * string-aware brace-depth pass, parsed, and delivered in file order.
 * @param chunks - successive content chunks (UTF-8 JSON).
 * @param visit - per-feature callback; throwing from it aborts the scan and
 *   propagates unchanged.
 * @param limits - the total byte ceiling.
 * @returns the number of features visited.
 * @throws {StreamScanFailure} `invalid-collection-shape` when the bounded
 *   header window does not declare a FeatureCollection's features array;
 *   `stream-byte-limit-exceeded` past `limits.maxBytes`;
 *   `invalid-feature-json` for an unparseable feature object;
 *   `truncated-collection` when EOF arrives before the features array closes.
 */
export function scanFeatureCollectionChunks(
  chunks: Iterable<Uint8Array>,
  visit: (feature: ScannedFeature) => void,
  limits: ScanLimits,
): number {
  const scanner = createFeatureCollectionScanner(limits, visit)
  for (const chunk of chunks) {
    scanner.push(chunk)
  }
  return scanner.end()
}

/**
 * Create one stateful scanner for chunk-at-a-time feeding — the streaming
 * consumer's form: a single scanner instance receives every chunk so features
 * spanning chunk boundaries are extracted exactly once, with feature text
 * the only buffered state.
 * @param limits - the total byte ceiling.
 * @param visit - per-feature callback; throwing from it aborts the scan and
 *   propagates unchanged.
 * @returns the push/end handle.
 */
export function createFeatureCollectionScanner(
  limits: ScanLimits,
  visit: (feature: ScannedFeature) => void,
): { push: (chunk: Uint8Array) => void; end: () => number } {
  const state = new ScannerState(limits, visit)
  return {
    push: chunk => state.feed(chunk),
    end: () => state.finish(),
  }
}

class ScannerState {
  private readonly limits: ScanLimits
  private readonly visit: (feature: ScannedFeature) => void
  private text = ''
  private totalBytes = 0
  private phase: 'header' | 'features' | 'done' = 'header'
  private featureCount = 0

  constructor(limits: ScanLimits, visit: (feature: ScannedFeature) => void) {
    this.limits = limits
    this.visit = visit
  }

  /** Feed one chunk; header-phase text stays capped, feature-phase text is trimmed as consumed. */
  feed(chunk: Uint8Array): void {
    this.totalBytes += chunk.byteLength
    if (this.totalBytes > this.limits.maxBytes) {
      throw new StreamScanFailure('stream-byte-limit-exceeded', `the stream exceeded the ${String(this.limits.maxBytes)} byte scan limit`)
    }
    this.text += DECODER.decode(chunk, { stream: true })
    if (this.phase === 'header') {
      this.scanHeader()
    }
    if (this.phase === 'features') {
      this.scanFeatures()
    }
  }

  /** Close the stream: a valid header must have opened, and the array closed cleanly. */
  finish(): number {
    this.text += DECODER.decode()
    if (this.phase === 'header') {
      this.scanHeader()
      if (this.phase === 'header') {
        throw new StreamScanFailure('invalid-collection-shape', 'the stream ended without a FeatureCollection features array')
      }
    }
    if (this.phase === 'features') this.scanFeatures()
    if (this.phase !== 'done') {
      throw new StreamScanFailure('truncated-collection', 'the byte stream ended before the features array closed')
    }
    return this.featureCount
  }

  /** Validate the bounded header and locate the features array opening. */
  private scanHeader(): void {
    const typeAt = this.text.indexOf('"FeatureCollection"')
    if (typeAt < 0) {
      if (this.text.length > HEADER_WINDOW) {
        throw new StreamScanFailure('invalid-collection-shape', 'the header window does not declare a FeatureCollection')
      }
      return
    }
    const featuresKey = this.text.indexOf('"features"', typeAt)
    if (featuresKey < 0) {
      if (this.text.length > HEADER_WINDOW) {
        throw new StreamScanFailure('invalid-collection-shape', 'the header window does not declare a features array')
      }
      return
    }
    const arrayAt = this.text.indexOf('[', featuresKey)
    if (arrayAt < 0) {
      if (this.text.length > HEADER_WINDOW + 16) {
        throw new StreamScanFailure('invalid-collection-shape', 'the features key carries no array')
      }
      return
    }
    this.text = this.text.slice(arrayAt + 1)
    this.phase = 'features'
  }

  /** Extract and deliver complete feature objects from the buffered text. */
  private scanFeatures(): void {
    for (;;) {
      this.text = skipSeparators(this.text)
      if (this.phase === 'done') return
      if (this.text.length === 0) return
      const first = this.text[0]
      if (first === ']') {
        this.text = ''
        this.phase = 'done'
        return
      }
      const end = balancedObjectEnd(this.text)
      if (end < 0) return
      const featureText = this.text.slice(0, end + 1)
      this.text = this.text.slice(end + 1)
      let feature: ScannedFeature
      try {
        feature = JSON.parse(featureText) as ScannedFeature
      } catch {
        throw new StreamScanFailure('invalid-feature-json', `feature ${String(this.featureCount)} is not parseable JSON`)
      }
      this.featureCount += 1
      this.visit(feature)
    }
  }
}

/** Skip whitespace and the commas that separate array elements. */
function skipSeparators(text: string): string {
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === ',') {
      index += 1
      continue
    }
    if (char !== ' ' && char !== '\n' && char !== '\r' && char !== '\t') break
    index += 1
  }
  return index === 0 ? text : text.slice(index)
}

/**
 * Find the index of the brace that closes the object opening at position 0,
 * honoring string literals and escapes; -1 when the buffered text does not
 * yet hold the complete object.
 */
function balancedObjectEnd(text: string): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}
