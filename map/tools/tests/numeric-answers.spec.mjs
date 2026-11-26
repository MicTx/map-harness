/**
 * Analytic-answer numeric gates for the geo_* family: every expected value is
 * derived here from an independent source — grid arithmetic on the Gauss-Kruger
 * central meridian (where k0 = 1 makes grid meters equal ground meters),
 * Steiner's theorem for the buffer offset, the spherical meridian-arc length,
 * or an exact discrete fact — never by calling the tool family again.
 * Tolerances are pre-declared and cover only the documented gaps (the
 * spherical area approximation, the circle discretization, sphere-vs-ellipsoid
 * radius), so a wrong formula, wrong feature selection, or wrong unit cannot
 * pass. The D09 semantic gaps that are NOT fixed here (point/line area refuses,
 * boundary-touching topological predicates) stay pinned by the disclosure
 * guards below; see map/docs/verification-matrix.md, out-of-scope table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import proj4 from 'proj4'
import { projDefinitionOf } from '../src/geo-source.ts'
import { geoArea, geoBuffer, geoDistance, geoIntersect } from '../src/geo-tools.ts'
import { withWorkspace } from './workspace-rig.mjs'

/**
 * EPSG:4547 in the table is the CGCS2000 3-degree Gauss-Kruger zone with
 * central meridian 114°E, k0 = 1, and 500,000 m false easting
 * (map/tools/src/geo-source.ts). On the central meridian one grid meter is
 * one ground meter, which is what makes grid arithmetic an independent
 * answer for the projected fixtures below.
 */
const EPSG_4547 = 'EPSG:4547'
const CM_LON = 114

/** Turf's published mean earth radius (@turf/helpers `earthRadius`). */
const MEAN_EARTH_RADIUS_M = 6371008.8

const forward = ([lon, lat]) => proj4('EPSG:4326', projDefinitionOf(EPSG_4547), [lon, lat])

/** An axis-aligned square/rectangle FeatureCollection; coordinates are abstract (grid or degrees). */
function rectangle(x, y, width, height) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]]],
      },
      properties: {},
    }],
  }
}

/** A square frame: one outer ring plus one concentric square hole. */
function frame(x, y, outer, inner) {
  const inset = (outer - inner) / 2
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [[x, y], [x + outer, y], [x + outer, y + outer], [x, y + outer], [x, y]],
          [[x + inset, y + inset], [x + inset + inner, y + inset], [x + inset + inner, y + inset + inner], [x + inset, y + inset + inner], [x + inset, y + inset]],
        ],
      },
      properties: {},
    }],
  }
}

const pointAt = ([x, y]) => ({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [x, y] }, properties: {} }],
})

/** Assert `actual` equals `expected` within a pre-declared relative tolerance. */
function assertClose(actual, expected, relative, label) {
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * relative,
    `${label}: got ${actual}, expected ${expected} within ${relative * 100}%`,
  )
}

test('geo_area of a projected square matches the analytic grid area', async () => {
  await withWorkspace('area-grid', async ({ write, exec }) => {
    const [x, y] = forward([CM_LON, 39])
    write('square.geojson', rectangle(x, y, 1000, 2000))
    const value = await geoArea.execute({ path: 'square.geojson', crs: EPSG_4547 }, exec)
    assertClose(value.area_m2, 2_000_000, 0.005, '1 km × 2 km grid square')
    assert.equal(value.status, 'succeeded')
  })
})

test('geo_area subtracts a hole ring exactly as grid arithmetic does', async () => {
  await withWorkspace('area-hole', async ({ write, exec }) => {
    const [x, y] = forward([CM_LON, 39])
    write('frame.geojson', frame(x, y, 1000, 400))
    const value = await geoArea.execute({ path: 'frame.geojson', crs: EPSG_4547 }, exec)
    assertClose(value.area_m2, 1_000_000 - 160_000, 0.005, '1000 m frame with a 400 m hole')
  })
})

test('shared-edge rectangles report exactly zero overlap and disclose the boundary semantics', async () => {
  await withWorkspace('shared-edge', async ({ write, exec }) => {
    write('a.geojson', rectangle(10, 10, 1, 1))
    write('b.geojson', rectangle(11, 10, 1, 1))
    const value = await geoIntersect.execute({ path_a: 'a.geojson', path_b: 'b.geojson' }, exec)
    assert.equal(value.intersects, false, 'the polygons share a boundary, not an area')
    assert.equal(value.overlap_area_m2, 0, 'the analytic overlap of edge-touching rectangles is exactly zero')
    assert.ok(
      value.limitations.some(line => line.includes('boundary-touching')),
      'the polygon-overlay boundary semantics must stay disclosed',
    )
  })
})

test('overlap area equals the analytic intersection of two grid rectangles', async () => {
  await withWorkspace('overlap', async ({ write, exec }) => {
    const [x, y] = forward([CM_LON, 39])
    write('a.geojson', rectangle(x, y, 1000, 1000))
    write('b.geojson', rectangle(x + 500, y, 1000, 1000))
    const value = await geoIntersect.execute(
      { path_a: 'a.geojson', path_b: 'b.geojson', crs_a: EPSG_4547, crs_b: EPSG_4547 },
      exec,
    )
    assert.equal(value.intersects, true)
    assertClose(value.overlap_area_m2, 500_000, 0.005, '500 m × 1000 m overlap')
  })
})

test('geo_distance along a meridian equals the spherical arc length', async () => {
  await withWorkspace('meridian-arc', async ({ write, exec }) => {
    write('a.geojson', pointAt([0, 0]))
    write('b.geojson', pointAt([0, 1]))
    const value = await geoDistance.execute({ path_a: 'a.geojson', path_b: 'b.geojson' }, exec)
    const expected = MEAN_EARTH_RADIUS_M * Math.PI / 180
    assert.ok(
      Math.abs(value.distance_m - expected) < 1,
      `one degree of latitude: got ${value.distance_m} m, expected ${expected} m within 1 m`,
    )
  })
})

test('ten grid kilometres on the central meridian survive the CRS convergence', async () => {
  await withWorkspace('grid-km', async ({ write, exec }) => {
    const [x, y] = forward([CM_LON, 39])
    write('a.geojson', pointAt([x, y]))
    write('b.geojson', pointAt([x, y + 10_000]))
    const value = await geoDistance.execute(
      { path_a: 'a.geojson', path_b: 'b.geojson', crs_a: EPSG_4547, crs_b: EPSG_4547 },
      exec,
    )
    assertClose(value.distance_m, 10_000, 0.005, 'grid arithmetic vs convergence + great circle')
  })
})

test('buffered square area matches Steiner: A + P·r + πr²', async () => {
  await withWorkspace('buffer-steiner', async ({ write, exec }) => {
    const [x, y] = forward([CM_LON, 39])
    write('square.geojson', rectangle(x, y, 1000, 1000))
    const value = await geoBuffer.execute(
      { path: 'square.geojson', crs: EPSG_4547, distance_m: 100, steps: 32 },
      exec,
    )
    const expected = 1000 * 1000 + 2 * (1000 + 1000) * 100 + Math.PI * 100 * 100
    assertClose(value.area_m2, expected, 0.005, 'Steiner theorem for the offset square')
    assert.ok(
      value.limitations.some(line => line.includes('steps-discretized')),
      'the circle discretization must stay disclosed',
    )
  })
})

test('point and line geometries disclose the area limitation instead of an unexplained zero', async () => {
  await withWorkspace('area-disclosure', async ({ write, exec }) => {
    // D09 keeps point/line refusal as an open semantic gap; until its owner
    // changes the behavior (with snapshot-grade evidence), the zero MUST
    // never ship without this published limitation.
    write('point.geojson', pointAt([116.4, 39.9]))
    const point = await geoArea.execute({ path: 'point.geojson' }, exec)
    assert.equal(point.area_m2, 0)
    assert.match(point.limitations.join(' '), /Point or line geometry contributes no measurable area/)
    assert.match(point.meta.limitations.join(' '), /Point or line geometry contributes no measurable area/)

    write('line.geojson', {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[116, 39], [117, 40]] }, properties: {} }],
    })
    const line = await geoArea.execute({ path: 'line.geojson' }, exec)
    assert.equal(line.area_m2, 0)
    assert.match(line.limitations.join(' '), /Point or line geometry contributes no measurable area/)
  })
})
