/** Compile-time constants shared by map browser bundling and release protection. */

/**
 * Resolve only the public values the map browser modules consume.
 * @param environment - build environment already validated for the release edition.
 * @returns JSON expressions supplied to the browser compiler.
 */
export function mapBrowserDefines(environment: Record<string, string | undefined>): Record<string, string> {
  const mode = environment.NODE_ENV ?? 'production'
  return {
    'process.env.NODE_ENV': JSON.stringify(mode),
    'process.env.DSH_CLIENT_MAP_ORG_NAME': JSON.stringify(environment.DSH_CLIENT_MAP_ORG_NAME ?? ''),
    'import.meta.env.MODE': JSON.stringify(mode),
    'import.meta.env': JSON.stringify({ MODE: mode }),
  }
}
