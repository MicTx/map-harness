/**
 * The weight matrix for the weighted statistics: binary great-circle
 * distance-band neighbors over the admitted units, optional row
 * standardization, the islands the band leaves unconnected, and the
 * randomization-hypothesis sums (S0, S1, S2) the closed-form Moran variance
 * needs. The matrix is built once per computation and consumed as a sparse
 * neighbor list, so permutation redraws never rebuild it.
 *
 * @module @map-harness/spatial-statistics/weights
 */
import type { Standardization, WeightSpec } from './contract.ts'

/** One WGS84 coordinate pair the great-circle kernel consumes. */
export type LonLat = readonly [number, number]

/** Mean Earth radius in meters (IUGG mean radius, the same sphere Turf declares). */
export const EARTH_RADIUS_METERS = 6371008.8

/**
 * Great-circle distance in meters on the mean-radius sphere.
 * @param a - `[longitude, latitude]` of the first point.
 * @param b - `[longitude, latitude]` of the second point.
 * @returns the spherical distance in meters.
 */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const rad = Math.PI / 180
  const lat1 = a[1] * rad
  const lat2 = b[1] * rad
  const dLat = lat2 - lat1
  const dLon = (b[0] - a[0]) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** One directed weighted edge `i → j` of the sparse matrix. */
export interface WeightEdge {
  readonly j: number
  readonly w: number
}

/** The built weight matrix over `n` admitted units. */
export interface WeightMatrix {
  readonly n: number
  /** Directed neighbor lists; `neighbors[i]` holds every `i → j` edge. */
  readonly neighbors: readonly (readonly WeightEdge[])[]
  /** ΣΣ w_ij over both directions (standardized weights included). */
  readonly s0: number
  /** ½ ΣΣ (w_ij + w_ji)² — the connectivity sum the closed-form variance uses. */
  readonly s1: number
  /** Σᵢ (w_i· + w_·i)² — the row/column sum squares the closed-form variance uses. */
  readonly s2: number
  /** Admitted units the band left without any neighbor (excluded with diagnostics). */
  readonly islandIndexes: readonly number[]
}

/**
 * Build the distance-band weight matrix over the given coordinates.
 * @param coordinates - one `[longitude, latitude]` pair per admitted unit.
 * @param spec - the band definition and standardization the spec declared.
 * @returns the sparse matrix with its randomization sums.
 */
export function buildWeightMatrix(coordinates: readonly LonLat[], spec: { weights: WeightSpec; standardization: Standardization }): WeightMatrix {
  const n = coordinates.length
  const raw: WeightEdge[][] = Array.from({ length: n }, () => [])
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = haversineMeters(coordinates[i] as LonLat, coordinates[j] as LonLat)
      if (d <= spec.weights.bandMeters) {
        raw[i]?.push({ j, w: 1 })
        raw[j]?.push({ j: i, w: 1 })
      }
    }
  }
  let neighbors: WeightEdge[][] = raw
  if (spec.standardization === 'row') {
    neighbors = raw.map(row => {
      const total = row.reduce((sum, edge) => sum + edge.w, 0)
      return total === 0 ? row : row.map(edge => ({ j: edge.j, w: edge.w / total }))
    })
  }
  const islandIndexes: number[] = []
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const row = neighbors[i] ?? []
    let rowSum = 0
    let rowSquared = 0
    for (const edge of row) {
      rowSum += edge.w
      rowSquared += edge.w * edge.w
    }
    if (rowSum === 0) islandIndexes.push(i)
    s0 += rowSum
    s1 += 2 * rowSquared
    s2 += (2 * rowSum) ** 2
  }
  return { n, neighbors, s0, s1, s2, islandIndexes }
}

/** Sparse dot product Σ_j w_ij v_j for one row of the matrix. */
export function lagOf(row: readonly WeightEdge[], v: readonly number[]): number {
  let sum = 0
  for (const edge of row) sum += edge.w * (v[edge.j] ?? 0)
  return sum
}
