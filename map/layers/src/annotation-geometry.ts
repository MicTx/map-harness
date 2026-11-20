/** Annotation geometry contract shared by host admission and the browser draft host. */
export type AnnotationGeometry =
  | { readonly type: 'Point'; readonly coordinates: readonly [number, number] }
  | { readonly type: 'LineString'; readonly coordinates: readonly (readonly [number, number])[] }
  | { readonly type: 'Polygon'; readonly coordinates: readonly (readonly (readonly [number, number])[])[] }

/** Structurally validate one annotation geometry without importing host protocol code. */
export function isValidAnnotationGeometry(geometry: AnnotationGeometry): boolean {
  const point = (value: unknown): value is [number, number] => Array.isArray(value) && value.length === 2
    && [0, 1].every(index => typeof value[index] === 'number' && Number.isFinite(value[index])
      && value[index] >= (index === 0 ? -180 : -90) && value[index] <= (index === 0 ? 180 : 90))
  if (geometry.type === 'Point') return point(geometry.coordinates)
  const points = geometry.type === 'LineString' ? geometry.coordinates : geometry.coordinates[0]
  return Array.isArray(points) && points.length > 0 && points.length <= 1024 && points.every(point)
}
