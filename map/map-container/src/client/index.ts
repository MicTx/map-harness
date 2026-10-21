/** Browser plugin: one retained Sidebar map per Session, opened from that Session's conversation. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { createElement, useSyncExternalStore, type ReactNode } from 'react'
import { createMapSessionBinding } from './default-open.ts'
import { MapTabBody, type MapTabBodyProps } from './MapTabBody.tsx'
import { MapSessionAction, type MapSessionActionProps } from './MapSessionAction.tsx'
import { MAP_TAB_ID, mapTabDefinition } from './definition.ts'
import { createGestureSubmit } from './gesture-submit.ts'
import { createPanelChangeSubmit } from './change-submit.ts'
import { en, NS, zh } from './locales.ts'
import { MapToolCard } from './MapToolCard.tsx'
import { installMapTheme } from './map-theme.ts'
import { TOOL_CARD_DICTIONARY } from '../tool-cards/index.ts'

/** Required browser services for session-bound map navigation and the session queue. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'locale', 'sessions']

/**
 * Register the unique map page and a conversation action targeting the same Session.
 * @param ctx - client services owned by the map plugin's lifetime.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'map-container: dictionaries')
  // One keyed conversation row per dictionary tool; unlisted tools keep the generic row.
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', function* () {
    installMapTheme()
    for (const key of Object.keys(TOOL_CARD_DICTIONARY)) {
      yield ctx.slots.register({ name: 'tool.call.toolview', key, locale: NS }, MapToolCard)
    }
  }), 'map-container: tool rows')
  const t = ctx.locale.bind(NS)
  const gestureSubmit = createGestureSubmit(ctx)
  // The panel write channel: same queue seam, its own retain reference source.
  const panelSubmit = createGestureSubmit(ctx, 'mapPanel')
  const changeSubmit = createPanelChangeSubmit()
  const binding = createMapSessionBinding(ctx.sidebarRight)
  ctx.effect(() => () => binding.dispose(), 'map-container: session binding')

  function BoundMapTab(props: MapTabBodyProps): ReactNode {
    const { tab } = props.useTabInfo()
    useSyncExternalStore(binding.tabs.subscribe, binding.tabs.getSnapshot)
    // Restored duplicates may reach React before their layout can be reconciled.
    // Only the canonical record is allowed to start the asynchronous SDK load.
    if (!binding.owns(props.sessionId, tab.id)) return null
    return createElement(MapTabBody, { ...props, key: props.sessionId, gestureSubmit, panelSubmit, changeSubmit })
  }
  const action = (props: Omit<MapSessionActionProps, 'binding'>): ReactNode =>
    createElement(MapSessionAction, { ...props, binding })

  ctx.effect(() => ctx.sidebarRightTabs.register({
    ...mapTabDefinition(),
    title: () => t('view.map'),
    guide: [{ id: 'open-map', order: 30, title: () => t('view.map'), description: () => t('view.description') }],
  }), 'map-container: type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: MAP_TAB_ID, locale: NS }, BoundMapTab,
  )), 'map-container: body')
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'session-map', order: -10, locale: NS,
  }, action)), 'map-container: conversation action')
}
