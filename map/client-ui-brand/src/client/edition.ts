/**
 * Brand title and edition line shared by the sidebar occupant and the Web
 * build title. The edition line names the deploying organization only when a
 * private build supplies `DSH_CLIENT_MAP_ORG_NAME`; every tracked artifact and
 * public build shows the community edition instead.
 */

/** Product headline shown in every edition. */
export const BRAND_HEADLINE = '探索未至之境 x Map Harness'

/** Edition line used when no organization name is configured. */
export const COMMUNITY_EDITION = '社区版'

/**
 * Resolve the edition line from an organization name.
 * @param orgName - deploying organization name, or undefined/blank for public builds.
 * @returns the trimmed organization name, or the community edition label.
 */
export function editionLine(orgName: string | undefined): string {
  const trimmed = orgName?.trim() ?? ''
  return trimmed === '' ? COMMUNITY_EDITION : trimmed
}
