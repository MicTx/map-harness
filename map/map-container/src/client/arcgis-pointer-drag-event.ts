/**
 * The ArcGIS Maps SDK 5.1.24 runtime supports the `pointer-drag` view event:
 * its `ViewEvents.js` lists the name in `eventTypes` and constructs the
 * payload for each registration. The declared `ViewEventTypes` map omits the
 * key, so `view.on("pointer-drag", …)` fails to typecheck. This module adds
 * the missing declaration with the payload the runtime constructs. Remove it
 * when the SDK declarations include `pointer-drag`.
 */

export {}

declare module '@arcgis/core/views/input/types.js' {
  /**
   * Payload of the view's `pointer-drag` event, fired while a registered drag
   * produces pointer input.
   */
  export interface PointerDragEvent extends PointerEventCommon {
    /** The event type. */
    type: 'pointer-drag'
    /** The state of the drag. */
    action: DragEvent['action']
    /** Screen coordinates of the start of the drag. */
    origin: DragEventOrigin
  }

  /** Registers `pointer-drag` handlers typed with {@link PointerDragEvent}. */
  export interface ViewEventTypes {
    'pointer-drag': PointerDragEvent
  }
}
