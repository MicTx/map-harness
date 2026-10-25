/**
 * `@map-harness/spatial-terrain` — the terrain and line-of-sight analysis
 * library: the versioned `spatial-terrain@1` binding (vertical
 * datum/units/epoch, horizontal CRS, exact resource revisions, accuracy
 * budget, sampling policy, optional control points), the gridded elevation
 * surface with bilinear interpolation and building/voxel obstacles, and the
 * sampled line-of-sight computation with curvature/refraction correction,
 * obstruction diagnostics, explicit distance definitions, and an honesty
 * rule that makes grazing sightlines `indeterminate` instead of answered.
 * A pure library the terrain tools consume — no host row.
 * @module @map-harness/spatial-terrain
 */
export * from './contract.ts'
export * from './surface.ts'
export * from './los.ts'
export * from './viewshed.ts'
