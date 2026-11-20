/**
 * The deterministic permutation machinery: a 32-bit mulberry32 stream plus
 * the in-place Fisher–Yates shuffle it drives. Every pseudo p-value this
 * package reports comes from one seeded stream consumed in a fixed order, so
 * the same seed and the same inputs reproduce the same p-values bit for bit.
 *
 * @module @map-harness/spatial-statistics/rand
 */

/** One deterministic PRNG stream returning uniform floats in [0, 1). */
export interface RandomStream {
  next(): number
}

/**
 * Create the mulberry32 stream one seed identifies. The same seed always
 * produces the same sequence on every platform — the stream uses only
 * 32-bit integer arithmetic.
 * @param seed - the non-negative 32-bit seed.
 * @returns the stream.
 */
export function mulberry32(seed: number): RandomStream {
  let state = seed | 0
  return {
    next(): number {
      state = (state + 0x6D2B79F5) | 0
      let t = state
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
  }
}

/**
 * Shuffle one array in place with the Fisher–Yates pass the stream drives.
 * @param values - the array permuted in place.
 * @param random - the seeded stream.
 * @returns the same array reference, permuted.
 */
export function shuffled<T>(values: T[], random: RandomStream): T[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random.next() * (i + 1))
    const keep = values[i] as T
    values[i] = values[j] as T
    values[j] = keep
  }
  return values
}
