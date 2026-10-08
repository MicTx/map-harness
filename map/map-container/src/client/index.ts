/**
 * Browser half: register the `map` right-Sidebar tab type and the
 * conversation-view tab. Container state is the `mapContainer` session
 * projection the node half folds from the durable tool results; both faces
 * render it through the standard `useProjection` kit.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { createElement, type ReactNode } from 'react'
import { installDefaultMapOpen } from './default-open.ts'
import { MapTabBody, type MapTabBodyProps } from './MapTabBody.tsx'
import { MapViewBody, type MapViewBodyProps } from './MapViewBody.tsx'
import { MAP_TAB_ID, MAP_VIEW_ID, mapTabDefinition } from './definition.ts'
import { createGestureSubmit } from './gesture-submit.ts'
import { en, NS, zh } from './locales.ts'

/** Required browser services: slots, Sidebar tabs, session binding, copy, and the session queue. */
export const inject = ['slots', 'sidebarRightTabs', 'sidebarRight', 'uiSession', 'locale', 'sessions']

/** Register the map tab type, its Sidebar body, and the conversation view.
 * @param ctx - Client root context carrying the Sidebar and slot registries.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'map-container: dictionaries')
  const t = ctx.locale.bind(NS)
  const gestureSubmit = createGestureSubmit(ctx)
  const gestureTab = (props: MapTabBodyProps): ReactNode => createElement(MapTabBody, { ...props, gestureSubmit })
  const gestureView = (props: MapViewBodyProps): ReactNode => createElement(MapViewBody, { ...props, gestureSubmit })

  ctx.effect(() => ctx.sidebarRightTabs.register({
    ...mapTabDefinition(),
    guide: [{
      id: 'open-map',
      order: 30,
      title: () => t('view.map'),
      description: () => '打开本会话绑定的地图容器：加载工作区地理数据、空间分析可视化。',
    }],
  }), 'map-container: type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: MAP_TAB_ID, locale: NS }, gestureTab,
  )), 'map-container: body')

  // The map-only profile presents the map as the right Sidebar's purpose: one
  // default open per session, never fighting a later manual collapse.
  ctx.effect(() => installDefaultMapOpen(ctx), 'map-container: default open')

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: MAP_VIEW_ID,
    order: 20,
    locale: NS,
    label: () => t('view.map'),
  }, gestureView))
}
