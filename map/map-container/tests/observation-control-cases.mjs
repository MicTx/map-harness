/** Lead-authored, fixed calibration inputs; these are not production defaults. */
export const OBSERVATION_CONTROL_CASES = Object.freeze([
  { name: 'dpr1', deviceScaleFactor: 1, zoom: 10, rotation: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  { name: 'dpr2', deviceScaleFactor: 2, zoom: 10, rotation: 0, padding: { top: 0, right: 0, bottom: 0, left: 0 } },
  { name: 'dpr2-rotated-padded', deviceScaleFactor: 2, zoom: 11, rotation: 31, padding: { top: 17, right: 43, bottom: 29, left: 71 } },
])

/** Independent WGS84 positions, never the three fitting screen corners. */
/** @type {ReadonlyArray<{wgs84: [number, number], color: [number, number, number]}>} */
export const OBSERVATION_CONTROL_POINTS = Object.freeze([
  { wgs84: [116.30, 39.83], color: [229, 59, 53] },
  { wgs84: [116.50, 39.84], color: [49, 163, 94] },
  { wgs84: [116.31, 39.97], color: [51, 107, 199] },
  { wgs84: [116.49, 39.96], color: [226, 173, 32] },
  { wgs84: [116.40, 39.90], color: [178, 71, 168] },
])
