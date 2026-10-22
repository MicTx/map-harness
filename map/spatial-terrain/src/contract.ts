/**
 * The terrain method contract (`spatial-terrain@1`): the fully-specified,
 * versioned binding an elevation or line-of-sight computation must carry —
 * vertical datum/units/epoch, the horizontal CRS the coordinates are read in,
 * the exact surface/obstacle resource revisions (never a mutable path), the
 * accuracy budget, and the sampling policy.
 *
 * The contract is deliberate about what it refuses: a computation without a
 * named vertical datum, without vertical units this package implements, or
 * bound to an unversioned resource is never run — a WGS84 display preview is
 * not an analysis CRS, and no default datum is ever invented. Validation
 * accepts the raw JSON-shaped input the tool layer forwards and returns
 * typed issues instead of throwing, so a rejected spec lists every reason
 * rather than the first.
 *
 * @module @map-harness/spatial-terrain/contract
 */
import { createHash } from 'node:crypto'

/**
 * The method identity this package computes; a spec citing another version
 * is refused. The version pins every formula this package ships: the local
 * tangent-plane distance definition, bilinear grid interpolation, the
 * earth-curvature/refraction correction h_drop(d) = (1−k)·d²/(2R), and the
 * clearance-uncertainty rule that decides visible/blocked/indeterminate.
 */
export const TERRAIN_METHOD_VERSION = 'spatial-terrain@1'

/** Mean Earth radius (meters) behind the curvature correction and the local tangent plane. */
export const EARTH_RADIUS_M = 6_371_000

/** Default atmospheric-refraction coefficient (dimensionless) for the curvature correction. */
export const DEFAULT_REFRACTION_K = 0.13

/** The only vertical unit this version implements; anything else refuses loudly. */
export const SUPPORTED_VERTICAL_UNITS: readonly string[] = ['m']

/** Upper bound on surface grid points and obstacle features one analysis admits. */
export const MAX_TERRAIN_FEATURES = 65_536

/** Upper bound on one line-of-sight path length (meters); beyond it the local tangent plane's error is undisclosed. */
export const MAX_PATH_DISTANCE_M = 100_000

/** Default and maximum sample count one line-of-sight path admits. */
export const DEFAULT_MAX_SAMPLES = 4_096
export const ABSOLUTE_MAX_SAMPLES = 65_536

/** A catalog resource ref with an explicit version (`res-…@vN`) — the only binding the analysis accepts. */
export const RESOURCE_REF_PATTERN = /^res-[A-Za-z0-9-]+@v[1-9][0-9]*$/

/**
 * The vertical metadata every precision analysis carries. There is no
 * default: a missing datum, unit, or epoch refuses the analysis instead of
 * silently assuming one, because heights referenced to different datums are
 * not comparable numbers.
 */
export interface VerticalMetadata {
  /** Named vertical datum, e.g. `EGM96`, `NAVD88`, `ellipsoid-WGS84`. */
  readonly datum: string
  /** Vertical unit; this version implements `m` only. */
  readonly units: string
  /** Datum epoch or realization, e.g. `2010.00`; `none` is a literal for datum-less ellipsoidal heights. */
  readonly epoch: string
}

/** The exact, immutable surface binding one computation reads. */
export interface SurfaceBinding {
  /** Exact resource ref `res-…@vN`. */
  readonly ref: string
  /** Content digest of the exact stored bytes (from the authorized read), the revision token. */
  readonly revision: string
  /** Property holding each grid point's elevation, in the declared vertical unit. */
  readonly elevationField: string
  /** Horizontal CRS the stored coordinates are expressed in, e.g. `EPSG:4326`. */
  readonly horizontalCrs: string
  readonly vertical: VerticalMetadata
}

/** The obstacle bindings a computation may add on top of the surface. */
export interface BuildingsBinding {
  /** Exact resource ref `res-…@vN`. */
  readonly ref: string
  /** Content digest of the exact stored bytes. */
  readonly revision: string
  /** Property holding each building's height above its base, in the declared vertical unit. */
  readonly heightField: string
  /** Property holding an absolute base elevation; required when `base` is `absolute`. */
  readonly baseField?: string
  /** Where a building's base elevation comes from: the surface under the footprint, or an absolute property. */
  readonly base: 'terrain' | 'absolute'
}

/** The voxel binding: occupied cells as Point features at cell centers. */
export interface VoxelsBinding {
  /** Exact resource ref `res-…@vN`. */
  readonly ref: string
  /** Content digest of the exact stored bytes. */
  readonly revision: string
  /** Property holding the cell center's elevation, in the declared vertical unit. */
  readonly zField: string
  /** Cubic cell edge length in meters (the sampling grid of the voxel field). */
  readonly cellMeters: number
}

/** One surveyed control point the surface is checked against before an analysis runs. */
export interface ControlPoint {
  readonly id: string
  readonly lon: number
  readonly lat: number
  /** Surveyed elevation in the declared vertical unit. */
  readonly elevationM: number
}

/** The curvature correction applied along a path. */
export type CurvatureCorrection =
  | { readonly kind: 'none' }
  | { readonly kind: 'refraction-corrected'; readonly refractionK: number }

/** The accuracy budget (one-sigma, meters) behind the clearance uncertainty. */
export interface AccuracyBudget {
  /** Surface elevation one-sigma at any point the path samples. */
  readonly surfaceMeters: number
  /** Observer endpoint elevation one-sigma. */
  readonly observerMeters: number
  /** Target endpoint elevation one-sigma. */
  readonly targetMeters: number
}

/** The sampling policy of one path computation. */
export interface SamplingPolicy {
  /** Sample spacing along the path, meters. */
  readonly intervalMeters: number
  /** Upper bound on samples; exceeding it refuses instead of silently coarsening. */
  readonly maxSamples: number
}

/** The fully-resolved, versioned terrain computation input. Every default the tool applies is written here. */
export interface TerrainSpec {
  readonly methodVersion: typeof TERRAIN_METHOD_VERSION
  readonly surface: SurfaceBinding
  readonly buildings?: BuildingsBinding
  readonly voxels?: VoxelsBinding
  readonly curvature: CurvatureCorrection
  readonly accuracy: AccuracyBudget
  readonly sampling: SamplingPolicy
  /** Surveyed control points the surface must match before the analysis runs. */
  readonly controlPoints?: readonly ControlPoint[]
  /** Match tolerance for the control points, meters; required with control points. */
  readonly controlToleranceM?: number
}

/** One structural spec issue: which field, a stable code, and why. */
export interface TerrainIssue {
  readonly field: string
  readonly code: TerrainIssueCode
  readonly message: string
}

/** The stable validation codes a TerrainSpec rejection carries. */
export type TerrainIssueCode =
  | 'method-version'
  | 'surface-required'
  | 'vertical-datum-required'
  | 'vertical-units-required'
  | 'vertical-units-unsupported'
  | 'epoch-required'
  | 'horizontal-crs-required'
  | 'ref-required'
  | 'ref-unversioned'
  | 'revision-required'
  | 'field-required'
  | 'interval-positive'
  | 'max-samples-bound'
  | 'accuracy-nonnegative'
  | 'voxel-cell-positive'
  | 'base-field-required'
  | 'ref-conflict'
  | 'control-points-required'
  | 'control-tolerance-positive'
  | 'control-point-invalid'

/** One endpoint (observer or target) as the raw tool input names it. */
export interface LosEndpoint {
  readonly lon: number
  readonly lat: number
  /** Height above the terrain surface at this point, meters. */
  readonly heightM: number
  /** Absolute elevation override; when present `heightM` is ignored and the surface is not sampled for the endpoint. */
  readonly elevationM?: number
}

/**
 * Validate one raw TerrainSpec-shaped value and return every structural
 * issue. A spec with zero issues is fully determined: no algorithm default
 * is applied after this boundary.
 * @param spec - the raw spec value.
 * @returns the issue list; empty means the spec may run.
 */
export function validateTerrainSpec(spec: unknown): TerrainIssue[] {
  const issues: TerrainIssue[] = []
  const record = spec as Partial<TerrainSpec> | null
  if (typeof record !== 'object' || record === null) {
    return [{ field: 'spec', code: 'surface-required', message: 'the terrain spec must be an object' }]
  }
  if (record.methodVersion !== TERRAIN_METHOD_VERSION) {
    issues.push({ field: 'methodVersion', code: 'method-version', message: `spec must cite method version ${TERRAIN_METHOD_VERSION}` })
  }
  const surface = record.surface as SurfaceBinding | undefined
  if (typeof surface !== 'object' || surface === null) {
    issues.push({ field: 'surface', code: 'surface-required', message: 'a surface binding is required' })
    return issues
  }
  validateBinding(surface, 'surface', 'elevationField', issues, { requireCrs: true, requireVertical: true })
  validateObstacles(record, issues)
  validateCurvature(record.curvature, issues)
  const accuracy = record.accuracy
  if (typeof accuracy !== 'object' || accuracy === null) {
    issues.push({ field: 'accuracy', code: 'accuracy-nonnegative', message: 'an accuracy budget is required' })
  } else {
    for (const key of ['surfaceMeters', 'observerMeters', 'targetMeters'] as const) {
      const value = accuracy[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        issues.push({ field: `accuracy.${key}`, code: 'accuracy-nonnegative', message: `${key} must be a finite nonnegative number` })
      }
    }
  }
  const sampling = record.sampling
  if (typeof sampling !== 'object' || sampling === null) {
    issues.push({ field: 'sampling', code: 'interval-positive', message: 'a sampling policy is required' })
  } else {
    if (typeof sampling.intervalMeters !== 'number' || !Number.isFinite(sampling.intervalMeters) || sampling.intervalMeters <= 0) {
      issues.push({ field: 'sampling.intervalMeters', code: 'interval-positive', message: 'intervalMeters must be a positive number' })
    }
    if (typeof sampling.maxSamples !== 'number' || !Number.isInteger(sampling.maxSamples)
      || sampling.maxSamples < 2 || sampling.maxSamples > ABSOLUTE_MAX_SAMPLES) {
      issues.push({ field: 'sampling.maxSamples', code: 'max-samples-bound', message: `maxSamples must be an integer in [2, ${ABSOLUTE_MAX_SAMPLES}]` })
    }
  }
  const controls = record.controlPoints
  const tolerance = record.controlToleranceM
  if (controls !== undefined) {
    if (!Array.isArray(controls) || controls.length === 0) {
      issues.push({ field: 'controlPoints', code: 'control-points-required', message: 'controlPoints must be a nonempty array when present' })
    } else {
      for (const [index, point] of controls.entries()) {
        if (typeof point !== 'object' || point === null
          || typeof point.id !== 'string' || point.id.length === 0
          || typeof point.lon !== 'number' || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180
          || typeof point.lat !== 'number' || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90
          || typeof point.elevationM !== 'number' || !Number.isFinite(point.elevationM)) {
          issues.push({ field: `controlPoints[${index}]`, code: 'control-point-invalid', message: 'a control point needs id, finite lon/lat, and a finite elevationM' })
          break
        }
      }
    }
    if (typeof tolerance !== 'number' || !Number.isFinite(tolerance) || tolerance <= 0) {
      issues.push({ field: 'controlToleranceM', code: 'control-tolerance-positive', message: 'controlToleranceM must be a positive number when control points are given' })
    }
  } else if (tolerance !== undefined) {
    issues.push({ field: 'controlToleranceM', code: 'control-points-required', message: 'controlToleranceM applies only with controlPoints' })
  }
  return issues
}

/** The elevation property name each binding kind carries. */
type BindingFieldKey = 'elevationField' | 'heightField' | 'zField'

/** Validate one surface/obstacle binding in place. Obstacles share the surface's vertical datum. */
function validateBinding(
  binding: Partial<SurfaceBinding & BuildingsBinding & VoxelsBinding>,
  at: string,
  fieldKey: BindingFieldKey,
  issues: TerrainIssue[],
  requirement: { requireCrs?: boolean; requireVertical?: boolean },
): void {
  if (typeof binding.ref !== 'string' || binding.ref.length === 0) {
    issues.push({ field: `${at}.ref`, code: 'ref-required', message: 'an exact resource ref is required' })
  } else if (!RESOURCE_REF_PATTERN.test(binding.ref)) {
    issues.push({ field: `${at}.ref`, code: 'ref-unversioned', message: `ref must be a versioned resource ref matching ${RESOURCE_REF_PATTERN}` })
  }
  if (typeof binding.revision !== 'string' || binding.revision.length === 0) {
    issues.push({ field: `${at}.revision`, code: 'revision-required', message: 'the content digest of the bound version is required' })
  }
  if (typeof binding[fieldKey] !== 'string' || (binding[fieldKey] as string).length === 0) {
    issues.push({ field: `${at}.${fieldKey}`, code: 'field-required', message: `the ${fieldKey} property name is required` })
  }
  if (requirement.requireCrs && (typeof binding.horizontalCrs !== 'string' || binding.horizontalCrs.length === 0)) {
    issues.push({ field: `${at}.horizontalCrs`, code: 'horizontal-crs-required', message: 'the horizontal CRS of the coordinates is required; a display projection is not an analysis CRS' })
  }
  if (requirement.requireVertical) validateVertical(binding.vertical, `${at}.vertical`, issues)
}

/** Validate one vertical metadata block: no default datum, supported units only. */
function validateVertical(vertical: VerticalMetadata | undefined, at: string, issues: TerrainIssue[]): void {
  if (typeof vertical !== 'object' || vertical === null) {
    issues.push({ field: at, code: 'vertical-datum-required', message: 'vertical metadata (datum/units/epoch) is required' })
    return
  }
  if (typeof vertical.datum !== 'string' || vertical.datum.length === 0) {
    issues.push({ field: `${at}.datum`, code: 'vertical-datum-required', message: 'a named vertical datum is required; heights without one are not comparable' })
  }
  if (typeof vertical.units !== 'string' || vertical.units.length === 0) {
    issues.push({ field: `${at}.units`, code: 'vertical-units-required', message: 'the vertical unit is required' })
  } else if (!SUPPORTED_VERTICAL_UNITS.includes(vertical.units)) {
    issues.push({ field: `${at}.units`, code: 'vertical-units-unsupported', message: `vertical unit "${vertical.units}" is unsupported; this version implements ${SUPPORTED_VERTICAL_UNITS.join('/')}` })
  }
  if (typeof vertical.epoch !== 'string' || vertical.epoch.length === 0) {
    issues.push({ field: `${at}.epoch`, code: 'epoch-required', message: 'the datum epoch (or the literal "none") is required' })
  }
}

/** Validate the optional obstacle bindings, including the surface ref conflict. */
function validateObstacles(record: Partial<TerrainSpec>, issues: TerrainIssue[]): void {
  const surfaceRef = record.surface?.ref
  const buildings = record.buildings
  const voxels = record.voxels
  if (buildings !== undefined && buildings !== null) {
    validateBinding(buildings, 'buildings', 'heightField', issues, {})
    if (buildings.base !== 'terrain' && buildings.base !== 'absolute') {
      issues.push({ field: 'buildings.base', code: 'base-field-required', message: 'buildings.base must be "terrain" or "absolute"' })
    } else if (buildings.base === 'absolute' && (typeof buildings.baseField !== 'string' || buildings.baseField.length === 0)) {
      issues.push({ field: 'buildings.baseField', code: 'base-field-required', message: 'base=absolute requires the baseField property name' })
    } else if (buildings.base === 'terrain' && buildings.baseField !== undefined) {
      issues.push({ field: 'buildings.baseField', code: 'base-field-required', message: 'baseField applies to base=absolute only; base=terrain samples the surface' })
    }
    if (surfaceRef !== undefined && buildings.ref === surfaceRef) {
      issues.push({ field: 'buildings.ref', code: 'ref-conflict', message: 'the buildings ref must differ from the surface ref' })
    }
  }
  if (voxels !== undefined && voxels !== null) {
    validateBinding(voxels, 'voxels', 'zField', issues, {})
    if (typeof voxels.cellMeters !== 'number' || !Number.isFinite(voxels.cellMeters) || voxels.cellMeters <= 0) {
      issues.push({ field: 'voxels.cellMeters', code: 'voxel-cell-positive', message: 'cellMeters must be a positive number' })
    }
    if (surfaceRef !== undefined && voxels.ref === surfaceRef) {
      issues.push({ field: 'voxels.ref', code: 'ref-conflict', message: 'the voxels ref must differ from the surface ref' })
    }
  }
  if (buildings !== undefined && buildings !== null && voxels !== undefined && voxels !== null
    && buildings.ref === voxels.ref) {
    issues.push({ field: 'voxels.ref', code: 'ref-conflict', message: 'the buildings and voxels bindings must cite different resources' })
  }
}

/** Validate the curvature block. */
function validateCurvature(curvature: CurvatureCorrection | undefined, issues: TerrainIssue[]): void {
  if (curvature === undefined || curvature === null) {
    issues.push({ field: 'curvature', code: 'method-version', message: 'the curvature correction must be stated explicitly (none or refraction-corrected)' })
    return
  }
  if (curvature.kind === 'none') return
  if (curvature.kind === 'refraction-corrected') {
    if (typeof curvature.refractionK !== 'number' || !Number.isFinite(curvature.refractionK) || curvature.refractionK < 0 || curvature.refractionK >= 1) {
      issues.push({ field: 'curvature.refractionK', code: 'method-version', message: 'refractionK must be a finite number in [0, 1)' })
    }
    return
  }
  issues.push({ field: 'curvature', code: 'method-version', message: 'curvature.kind must be "none" or "refraction-corrected"' })
}

/** The revision identity one computation binds to: exact ref plus content digest. */
export interface TerrainRevision {
  readonly ref: string
  readonly revision: string
}

/**
 * Whether one recorded revision is still the revision a consumer currently
 * holds — the stale-version check between an analysis result and a displayed
 * layer. String equality over exact refs and content digests; a different
 * version of the same resource is stale, never silently accepted.
 * @param recorded - the revision the analysis or display recorded.
 * @param current - the revision the consumer holds.
 * @returns true when both name the exact same version.
 */
export function revisionsMatch(recorded: TerrainRevision, current: TerrainRevision): boolean {
  return recorded.ref === current.ref && recorded.revision === current.revision
}

/**
 * The canonical digest of one resolved spec — the identity recorded in
 * results and artifacts so two runs over the same inputs are recognizable.
 * @param spec - the resolved spec.
 * @returns a sha256 hex digest of the canonical JSON.
 */
export function terrainSpecDigestOf(spec: TerrainSpec): string {
  return createHash('sha256').update(JSON.stringify(spec), 'utf8').digest('hex')
}
