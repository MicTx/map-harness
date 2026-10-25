/** The session's map page; the binding reconciles duplicate layout records before rendering. */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** The tab kind this package owns. */
export const MAP_TAB_KIND = 'map'

/** This implementation's identity in the tab system: the key its body registers under. */
export const MAP_TAB_ID = '@map-harness/map-container'

/** The map tab title: one fixed copy key, not an address derivation. */
export const MAP_TAB_TITLE = '地图'

/**
 * The map tab type's registry definition.
 * @returns the definition to register.
 */
export function mapTabDefinition(): SidebarRightTabDefinition {
  return {
    id: MAP_TAB_ID,
    kind: MAP_TAB_KIND,
    multiple: false,
    keepMounted: true,
    patterns: ['dsh-resource://map/**'],
    priority: 'fallback',
    canOpen: () => true,
    title: () => MAP_TAB_TITLE,
  }
}
