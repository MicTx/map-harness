/**
 * Accessibility contract gates: the structural validation ladder (extents
 * and their nesting, half-open time windows with the training/observation
 * ordering, impedance/time-slice/barrier/entrance/capacity/ref/candidate
 * rules), the canonical spec digest, and the straight-line exploration
 * marker that can never pass as network evidence.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCESSIBILITY_METHOD_VERSION,
  BOUNDARY_RULE,
  MAX_CANDIDATES,
  specDigestOf,
  straightLineExploration,
  usableAsNetworkEvidence,
  validateAccessibilitySpec,
} from '../src/index.ts'

const SUPPORT = [116.0, 39.6, 116.8, 40.2]
const RETRIEVAL = [116.1, 39.7, 116.7, 40.1]
const STUDY = [116.2, 39.8, 116.6, 40.0]

/** A structurally valid spec every negative fixture mutates. */
function validSpec(overrides = {}) {
  return {
    goalRevision: 3,
    studyArea: { bbox: STUDY },
    retrievalExtent: { bbox: RETRIEVAL },
    analysisSupportExtent: { bbox: SUPPORT },
    observationWindow: { from: '2026-06-01T00:00:00Z', to: '2026-06-30T00:00:00Z' },
    impedance: { travelMode: 'walk', maxMinutes: 15 },
    timeSlices: ['midday'],
    populationRef: 'res-abc123@v2',
    populationField: 'population',
    facilityRefs: ['res-def456@v1'],
    methodVersion: ACCESSIBILITY_METHOD_VERSION,
    ...overrides,
  }
}

test('a well-formed spec validates clean and keeps the boundary semantics explicit', () => {
  assert.deepEqual(validateAccessibilitySpec(validSpec()), [])
  // Cross-boundary service is contract semantics: support ⊃ retrieval ⊃ study
  // is exactly what lets an out-of-study facility inside the support extent
  // keep serving study-area population.
  assert.equal(BOUNDARY_RULE.outsideStudyWithinSupport, 'retain')
  assert.equal(BOUNDARY_RULE.outsideSupport, 'exclude-with-diagnostic')
})

test('the three extents are distinct inputs and must nest study ⊆ retrieval ⊆ support', () => {
  // A support extent smaller than the retrieval extent cannot back the
  // method's edge allowance: rejected, not silently clamped.
  const issues = validateAccessibilitySpec(validSpec({
    analysisSupportExtent: { bbox: [116.15, 39.75, 116.65, 40.05] },
  }))
  assert.ok(issues.some(issue => issue.code === 'extent-nesting' && issue.field === 'analysisSupportExtent'))
  // A retrieval extent that drops the study area is equally rejected.
  const shrunk = validateAccessibilitySpec(validSpec({
    retrievalExtent: { bbox: [116.3, 39.85, 116.5, 39.95] },
  }))
  assert.ok(shrunk.some(issue => issue.code === 'extent-nesting' && issue.field === 'retrievalExtent'))
  // Malformed boxes are named per field.
  const malformed = validateAccessibilitySpec(validSpec({ studyArea: { bbox: [200, 0, 10, 0] } }))
  assert.ok(malformed.some(issue => issue.code === 'bbox-invalid' && issue.field === 'studyArea.bbox'))
})

test('historical training windows must end before the observation window starts', () => {
  const ok = validateAccessibilitySpec(validSpec({
    trainingWindow: { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' },
  }))
  assert.deepEqual(ok, [], 'a training window abutting the observation start is valid')
  const leak = validateAccessibilitySpec(validSpec({
    trainingWindow: { from: '2026-01-01T00:00:00Z', to: '2026-06-15T00:00:00Z' },
  }))
  assert.ok(leak.some(issue => issue.code === 'training-window-invalid'), 'lookback data overlapping the observation window is refused')
  const unordered = validateAccessibilitySpec(validSpec({
    observationWindow: { from: '2026-06-30T00:00:00Z', to: '2026-06-01T00:00:00Z' },
  }))
  assert.ok(unordered.some(issue => issue.code === 'window-invalid'))
})

test('missing impedance is a named rejection, never a defaulted budget', () => {
  const spec = validSpec()
  delete spec.impedance
  const issues = validateAccessibilitySpec(spec)
  assert.ok(issues.some(issue => issue.code === 'missing-impedance'))
  const unknown = validateAccessibilitySpec(validSpec({ impedance: { travelMode: 'fly', maxMinutes: 15 } }))
  assert.ok(unknown.some(issue => issue.code === 'mode-unknown'))
  const unbounded = validateAccessibilitySpec(validSpec({ impedance: { travelMode: 'walk', maxMinutes: 999 } }))
  assert.ok(unbounded.some(issue => issue.code === 'impedance-invalid'))
})

test('capacity and entrance inputs are validated per entry', () => {
  const negative = validateAccessibilitySpec(validSpec({
    capacity: { perFacility: { 'fac-a': -5 }, assignment: 'nearest-first' },
  }))
  assert.ok(negative.some(issue => issue.code === 'capacity-invalid' && issue.field.includes('fac-a')))
  const missingEntrance = validateAccessibilitySpec(validSpec({
    entrances: [{ facilityId: '', coordinates: [116.3, 39.9] }],
  }))
  assert.ok(missingEntrance.some(issue => issue.code === 'entrance-invalid'))
  const offGrid = validateAccessibilitySpec(validSpec({
    entrances: [{ facilityId: 'fac-a', coordinates: [116.3, 120] }],
  }))
  assert.ok(offGrid.some(issue => issue.code === 'entrance-invalid' && issue.field.includes('coordinates')))
})

test('versioned refs, time slices, and candidate budgets are checked at the boundary', () => {
  const refs = validateAccessibilitySpec(validSpec({ populationRef: 'populations.geojson' }))
  assert.ok(refs.some(issue => issue.code === 'ref-invalid' && issue.field === 'populationRef'))
  const slices = validateAccessibilitySpec(validSpec({ timeSlices: ['rush-hour'] }))
  assert.ok(slices.some(issue => issue.code === 'slice-unknown'))
  const candidates = validateAccessibilitySpec(validSpec({
    candidates: Array.from({ length: MAX_CANDIDATES + 1 }, (_, index) => ({
      id: `c${index}`, label: `option ${index}`, addFacilities: [{ id: `f${index}`, coordinates: [116.3, 39.9] }], cost: 1,
    })),
    weights: { coverage: 1, equity: 0, cost: 0 },
  }))
  assert.ok(candidates.some(issue => issue.code === 'candidate-invalid'))
  const noWeights = validateAccessibilitySpec(validSpec({
    candidates: [{ id: 'c1', label: 'option', addFacilities: [{ id: 'f1', coordinates: [116.3, 39.9] }], cost: 1 }],
  }))
  assert.ok(noWeights.some(issue => issue.code === 'weights-invalid'))
})

test('the spec digest is canonical: key order never changes the identity', () => {
  const flat = validSpec()
  const reordered = {
    methodVersion: flat.methodVersion,
    facilityRefs: flat.facilityRefs,
    populationField: flat.populationField,
    populationRef: flat.populationRef,
    timeSlices: flat.timeSlices,
    impedance: { maxMinutes: flat.impedance.maxMinutes, travelMode: flat.impedance.travelMode },
    observationWindow: flat.observationWindow,
    analysisSupportExtent: flat.analysisSupportExtent,
    retrievalExtent: flat.retrievalExtent,
    studyArea: flat.studyArea,
    goalRevision: flat.goalRevision,
  }
  assert.equal(specDigestOf(reordered), specDigestOf(flat))
  assert.notEqual(specDigestOf(validSpec({ goalRevision: 4 })), specDigestOf(flat))
})

test('a straight-line exploration is permanently marked and refused as network evidence', () => {
  const exploration = straightLineExploration('步行15分钟覆盖哪些社区')
  assert.equal(exploration.kind, 'exploratory-straight-line')
  assert.equal(exploration.exploratory, true)
  assert.ok(exploration.limitations[0].includes('not walk/bike/drive accessibility evidence'))
  assert.equal(usableAsNetworkEvidence(exploration), false, 'the exploration cannot be cited as walk evidence')
  assert.equal(usableAsNetworkEvidence({ kind: 'network-coverage' }), true)
})
