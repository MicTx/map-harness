/**
 * Import admission budgets. Values align with the GeoJSON admission in
 * `geo-source.ts` (`MAX_FILE_BYTES`, `MAX_FEATURES`,
 * `MAX_COORDINATE_TUPLES`); the canonical GeoJSON product always re-enters
 * that admission, and these constants front-run the same ceilings inside the
 * format parsers so oversized input refuses before wasted work. They are
 * protocol invariants, not configuration.
 */

/** Maximum raw file bytes one import may read (matches `geo-source.ts`). */
export const MAX_IMPORT_FILE_BYTES = 32 * 1024 * 1024

/** Maximum features one import may produce (matches `geo-source.ts`). */
export const MAX_IMPORT_FEATURES = 10_000

/** Maximum coordinate tuples one import may produce (matches `geo-source.ts`). */
export const MAX_IMPORT_COORDINATE_TUPLES = 100_000

/** Maximum entries one shapefile ZIP may carry. */
export const MAX_ZIP_ENTRIES = 16

/** Maximum total decompressed bytes across one shapefile ZIP's entries. */
export const MAX_ZIP_DECOMPRESSED_BYTES = 32 * 1024 * 1024
