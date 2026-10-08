/**
 * Stage one of the map tab type's registration: what the `map` tab IS.
 *
 * The type claims no resource address — it is a session-surface pane the
 * agent's tools and the user both see. `canOpen` accepts every address with a
 * session scope so `ctx.sidebarRight.openTab('map')` and any `dsh-resource://`
 * pin resolving to this session can land here.
 */
import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

/** The tab kind this package owns. */
export const MAP_TAB_KIND = 'map'

/** This implementation's identity in the tab system: the key its body registers under. */
export const MAP_TAB_ID = '@map-harness/map-container'

/** The map tab title: one fixed copy key, not an address derivation. */
export const MAP_TAB_TITLE = '地图'

/** Conversation view entry id registered on `conversation.view`. */
export const MAP_VIEW_ID = 'map'

/**
 * Occurrence key published on `__mapHarness` for the conversation view.
 * Distinct from the right-Sidebar tab's `tab.id` so the two faces never share a handle.
 */
export const MAP_VIEW_OCCURRENCE_KEY = 'view:map'

/**
 * The map tab type's registry definition.
 * @returns the definition to register.
 */
export function mapTabDefinition(): SidebarRightTabDefinition {
  return {
    id: MAP_TAB_ID,
    kind: MAP_TAB_KIND,
    patterns: ['dsh-resource://map/**'],
    priority: 'fallback',
    canOpen: () => true,
    title: () => MAP_TAB_TITLE,
  }
}
