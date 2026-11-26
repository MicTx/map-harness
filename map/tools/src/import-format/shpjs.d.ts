/**
 * Type surface for the two `shpjs` component parsers this package uses.
 * `shpjs` ships no type declarations; the ZIP container admission is local,
 * so only the geometry and attribute parsers need typing here.
 */
declare module 'shpjs' {
  /** Parsed GeoJSON geometry (parser may add a redundant `bbox` member). */
  interface ShpGeometry {
    type: string
    coordinates?: unknown
    bbox?: number[]
    geometries?: ShpGeometry[]
  }

  /**
   * Parse the .shp component in native coordinates. The optional second
   * argument is a proj4 definition or WKT; passing it makes the parser
   * reproject, which this package never does — reprojection stays in the
   * shared geo-source path.
   * @param shp - .shp file bytes.
   * @param prj - unused by this package (omit to keep native coordinates).
   */
  export function parseShp(shp: Uint8Array, prj?: string): ShpGeometry[]

  /**
   * Parse the .dbf component into per-record property objects under a
   * `.cpg`-style encoding label.
   * @param dbf - .dbf file bytes.
   * @param cpg - encoding label (for example `UTF-8`, `gbk`).
   */
  export function parseDbf(dbf: Uint8Array, cpg?: string): Array<Record<string, unknown>>
}
