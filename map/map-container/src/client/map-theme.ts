/**
 * Themed stylesheet for the map tab overlays (layer panel, workbench, gesture
 * submit, load states). Colors, radii, and focus rings read the host design
 * tokens (`--dsw-*`) with light-theme fallbacks, so the overlays follow the
 * host light/dark theme. Selectors key on the components' existing `data-*`
 * attributes; inline styles keep only positioning.
 * @module @map-harness/map-container/client/map-theme
 */

/** `data-plugin-css` tag id; one style element per document. */
export const MAP_THEME_TAG = '@map-harness/map-container'

/** Map overlay token fallbacks; the screenshot footer reads the same values. */
export const MAP_CAPTURE_THEME_FALLBACK = Object.freeze({
  background: 'rgba(255, 255, 255, 0.96)',
  foreground: '#1f2329',
})

/** Read the active map overlay colors for screenshot attribution. */
export function mapCaptureFooterColors(doc: Document | undefined = globalThis.document): { background: string; foreground: string } {
  const root = doc?.querySelector?.<HTMLElement>('[data-map-container]') ?? doc?.documentElement
  const style = root === undefined ? undefined : doc?.defaultView?.getComputedStyle(root)
  const background = style?.getPropertyValue('--map-bg').trim()
  const foreground = style?.getPropertyValue('--map-fg').trim()
  return {
    background: background === undefined || background === '' ? MAP_CAPTURE_THEME_FALLBACK.background : background,
    foreground: foreground === undefined || foreground === '' ? MAP_CAPTURE_THEME_FALLBACK.foreground : foreground,
  }
}

/** The overlay stylesheet text. */
export const MAP_THEME_CSS = `
[data-map-container] {
  position: absolute; inset: 0; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--dsw-static-neutral-00, #fff);
  --map-bg: var(--dsw-alias-bg-layer-1, ${MAP_CAPTURE_THEME_FALLBACK.background});
  --map-fg: var(--dsw-alias-label-primary, ${MAP_CAPTURE_THEME_FALLBACK.foreground});
  --map-fg-2: var(--dsw-alias-label-secondary, #4e5969);
  /* Tertiary ink is decorative only (drag handle, disabled, placeholder).
     Informational labels use the secondary ink so 10-11px meta text still
     clears the 4.5:1 body-contrast floor in both themes. */
  --map-fg-3: var(--dsw-alias-label-secondary, #4e5969);
  --map-fg-4: var(--dsw-alias-label-tertiary, #86909c);
  --map-border: var(--dsw-alias-border-l2, #e5e6eb);
  --map-hover: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  --map-accent: var(--dsw-alias-state-business-primary, #3370ff);
  --map-error: var(--dsw-alias-state-error-primary, #d93026);
  --map-radius: var(--dsw-radius-md, 8px);
  --map-radius-sm: var(--dsw-radius-sm, 4px);
  --map-control-inset: 10px;
  font-family: var(--dsw-font-family, system-ui, sans-serif);
  color: var(--map-fg);
}
[data-map-canvas] { position: absolute; inset: 0; min-height: 0; }
[data-map-canvas] .esri-view { height: 100%; min-height: 0; }
[data-map-canvas] .esri-view-root {
  height: 100%; min-height: 0;
  display: grid; grid-template-rows: minmax(0, 1fr) auto;
}
[data-map-canvas] .esri-view-surface {
  position: absolute; inset: 0 0 auto;
  height: calc(100% - 22px); min-height: 0;
}
[data-map-canvas] .esri-view-attribution {
  grid-row: 2; position: relative; inset: auto;
  width: 100%; min-height: 22px; box-sizing: border-box;
  padding: 3px 8px; background: var(--map-bg); color: var(--map-fg-2);
  font-size: 11px; line-height: 16px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 0 8px;
  contain: none; z-index: 2;
}
/* The SDK default UI is removed (components: []); mirroring the official
   theme, both internal surfaces stay pointer-transparent so unobstructed
   drag/wheel reach the navigation surface instead of these full-viewport
   layers. */
[data-map-canvas] .esri-overlay-surface,
[data-map-canvas] .esri-ui {
  position: absolute; inset: 0 0 22px; min-height: 0; overflow: hidden;
  pointer-events: none;
}
[data-map-panel], [data-map-workbench], [data-map-state] {
  background: var(--map-bg);
  color: var(--map-fg);
  border: 1px solid var(--map-border);
  border-radius: var(--map-radius);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px);
  font-size: 12px;
  line-height: 1.5;
}
[data-map-workbench] {
  position: absolute; left: 0; right: 0; bottom: 32px; z-index: 1;
  max-height: 46%; overflow-y: auto;
  border-radius: var(--map-radius) var(--map-radius) 0 0; border-bottom: 0; padding: 8px 12px;
}
[data-map-state] { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0; padding: 10px 16px; z-index: 2; display: flex; align-items: center; gap: 8px; }
[data-map-state="error"] { color: var(--map-error); }
[data-map-source-error] {
  position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); z-index: 4;
  display: flex; align-items: center; gap: 10px; max-width: calc(100% - 24px); padding: 8px 10px;
  background: var(--map-bg); color: var(--map-error); border: 1px solid var(--map-border);
  border-radius: var(--map-radius); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12); font-size: 12px;
}
[data-map-container] h2 { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; font-size: 13px; font-weight: 500; }
[data-map-container] h3 { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 6px 0 2px; font-size: 12px; font-weight: 500; color: var(--map-fg-2); }
[data-map-container] button:not([class]) {
  font: inherit; font-size: 12px; color: var(--map-fg); background: transparent;
  border: 1px solid var(--map-border); border-radius: var(--map-radius-sm);
  padding: 1px 8px; min-height: 22px; cursor: pointer;
  transition: background-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease), border-color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease);
}
@media (hover: hover) {
  [data-map-container] button:not([class]):hover:not(:disabled) { background: var(--map-hover); }
  [data-map-container] [data-map-panel-group-row]:hover,
  [data-map-container] [data-map-panel-row]:hover,
  [data-map-container] tbody tr:hover { background: var(--map-hover); }
}
[data-map-container] button:not([class]):disabled { color: var(--map-fg-4); cursor: not-allowed; opacity: 0.6; }
[data-map-container] button:not([class])[aria-expanded] { border-color: transparent; padding-left: 2px; font-weight: 500; }
[data-map-container] button:not([class]):focus-visible, [data-map-container] input:not([class]):focus-visible, [data-map-container] select:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--map-accent)); outline-offset: 1px;
}
[data-map-container] input:not([class])[type="search"], [data-map-container] input:not([class])[type="text"], [data-map-container] select {
  font: inherit; font-size: 12px; color: var(--map-fg); background: transparent;
  border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); padding: 2px 8px; min-height: 22px; box-sizing: border-box;
}
[data-map-container] input:not([class])::placeholder { color: var(--map-fg-4); }
[data-map-container] input[type="checkbox"], [data-map-container] input[type="range"] { accent-color: var(--map-accent); }
[data-map-container] [role="status"], [data-map-container] [role="note"] { color: var(--map-fg-2); }
[data-map-feature-card] {
  /* The runtime placement writes left/top and measured width/height around the feature anchor. */
  position: absolute; top: 0; left: 0; z-index: 3;
  width: min(300px, calc(100% - 24px)); max-height: min(60%, 420px); overflow: auto;
  box-sizing: border-box; visibility: hidden;
  background: var(--map-bg); color: var(--map-fg); border: 1px solid var(--map-border);
  border-radius: var(--map-radius); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px); font-size: 12px; line-height: 1.5;
}
[data-map-feature-card-head] { align-items: flex-start; }
[data-map-feature-card-head] h3 { margin: 0; font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
[data-map-feature-card-head] p { margin: 2px 0 0; color: var(--map-fg-3); }
[data-map-feature-card] dl { margin: 0; padding: 6px 12px 10px; }
[data-map-feature-card] dl > div { display: grid; grid-template-columns: minmax(72px, 40%) 1fr; gap: 8px; padding: 3px 0; border-bottom: 1px solid var(--map-border); }
[data-map-feature-card] dl > div:last-child { border-bottom: 0; }
[data-map-feature-card] dt { color: var(--map-fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-feature-card] dd { margin: 0; overflow-wrap: anywhere; }
[data-map-feature-card-empty], [data-map-feature-card-more] { margin: 0; padding: 6px 12px 10px; color: var(--map-fg-3); }
[data-map-panel] {
  position: absolute; top: 10px; right: 10px; z-index: 2; width: 280px; max-width: calc(100% - 20px);
  max-height: calc(100% - 80px); display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
}
[data-map-panel][data-map-panel-surface="annotation"], [data-map-panel][data-map-panel-surface="unified"] { top: 10px; left: 10px; right: auto; }
[data-map-panel][data-map-panel-surface="imagery"] { top: auto; right: 10px; bottom: 10px; }
[data-map-panel][data-map-panel-surface="imagery"] { bottom: 38px; }
[data-map-rail="wide"] > [data-map-workbench] { left: 318px; }
[data-map-panel] > * { flex-shrink: 0; }
/* The title bar doubles as the drag handle for the resident card. */
[data-map-panel] > [data-map-panel-header] { cursor: grab; user-select: none; touch-action: none; }
[data-map-panel] > [data-map-panel-header]:active { cursor: grabbing; }
[data-map-panel][data-map-panel-collapsed] > [data-map-panel-header] { border-bottom: 0; padding-bottom: 10px; }
[data-map-panel-count] { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--map-accent); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
[data-map-feature-card-head], [data-map-panel-header] { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 10px 8px 8px 12px; border-bottom: 1px solid var(--map-border); background: var(--map-bg); }
[data-map-container] [data-map-panel-header] h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 500; }
[data-map-panel][data-map-panel-surface="unified"] { width: min(380px, calc(100% - 20px)); height: min(440px, calc(100% - 20px)); max-height: calc(100% - 20px); }
[data-map-panel][data-map-panel-surface="unified"][data-map-panel-collapsed] { height: auto !important; }
[data-map-panel-visually-hidden] { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
[data-map-panel-grip] { flex: none; color: var(--map-fg-3); letter-spacing: -2px; }
[data-map-panel-tabs] { flex: 1; min-width: 0; }
[data-map-panel-tabs] [role="tab"] { min-width: 0; overflow: hidden; padding-inline: 4px; }
[data-map-panel-tab] { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-panel][data-map-panel-surface="unified"] > [data-map-panel-body] { flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden; padding: 0; }
[data-map-panel][data-map-panel-surface="unified"] > [data-map-panel-body][hidden] { display: none; }
[data-map-panel-tab-body] { flex: 1; min-width: 0; overflow-y: auto; padding-bottom: 8px; }
[data-map-panel-tab-body][hidden] { display: none; }
[data-map-panel-tab-body] [data-map-panel-list], [data-map-panel-tab-body] [data-map-panel-sources], [data-map-panel-tab-body] [data-map-panel-annotations] { flex: none; overflow: visible; }
[data-map-panel-tab-body] [data-map-panel-annotations], [data-map-panel-tab-body] [data-map-panel-sources] { margin: 8px 10px 0; }
[data-map-panel-resize] { position: absolute; z-index: 3; touch-action: none; }
[data-map-panel-resize="n"], [data-map-panel-resize="s"] { left: 12px; right: 12px; height: 8px; cursor: ns-resize; }
[data-map-panel-resize="n"] { top: 0; } [data-map-panel-resize="s"] { bottom: 0; }
[data-map-panel-resize="e"], [data-map-panel-resize="w"] { top: 12px; bottom: 12px; width: 8px; cursor: ew-resize; }
[data-map-panel-resize="e"] { right: 0; } [data-map-panel-resize="w"] { left: 0; }
[data-map-panel-resize="ne"], [data-map-panel-resize="se"], [data-map-panel-resize="sw"], [data-map-panel-resize="nw"] { width: 16px; height: 16px; }
[data-map-panel-resize="ne"] { top: 0; right: 0; cursor: nesw-resize; } [data-map-panel-resize="sw"] { bottom: 0; left: 0; cursor: nesw-resize; }
[data-map-panel-resize="nw"] { top: 0; left: 0; cursor: nwse-resize; } [data-map-panel-resize="se"] { bottom: 0; right: 0; cursor: nwse-resize; }
@media (pointer: coarse) {
  [data-map-panel-resize="n"], [data-map-panel-resize="s"] { height: 12px; }
  [data-map-panel-resize="e"], [data-map-panel-resize="w"] { width: 12px; }
  [data-map-panel-resize="ne"], [data-map-panel-resize="se"], [data-map-panel-resize="sw"], [data-map-panel-resize="nw"] { width: 24px; height: 24px; }
}
[data-map-panel]:not([data-map-panel-surface="unified"]) > [data-map-panel-body] { flex: 0 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
[data-map-panel-body][data-overflow] { mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent); }
.map-panel-search { margin: 8px 10px 0; }
@media (pointer: coarse) { input[data-map-panel-search] { font-size: 16px; } }
[data-map-panel-sources] { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin: 8px 10px 0; }
[data-map-panel-sources] > small { display: block; color: var(--map-fg-3); font-size: 11px; }
[data-map-panel-sources] small[role="alert"] { color: var(--map-error); }
[data-map-imagery-dialog] input[type="range"] { width: 100%; min-width: 0; }
[data-map-panel-empty-inline] { color: var(--map-fg-3); font-size: 11px; }
[data-map-panel-annotations] { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; margin: 8px 10px 0; }
[data-map-panel-annotations] > [data-map-panel-list] { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 0 6px; }
[data-map-panel-changes] small, [data-map-panel-proposals] small { color: var(--map-fg-3); font-size: 11px; }
[data-map-panel-change-sources] { display: flex; flex-wrap: wrap; gap: 8px; }
[data-map-panel-change-evidence], [data-map-panel-proposal-evidence] { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
[data-map-panel-change-preview] { display: grid; gap: 4px; }
[data-map-panel-change-preview] img { display: block; width: 100%; max-height: 180px; object-fit: contain; border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); background: var(--map-bg); }
[data-map-panel-change-editor] { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding-top: 2px; }
[data-map-panel-proposal-preview] { display: grid; gap: 4px; }
[data-map-panel-proposal-preview] img { display: block; width: 100%; max-height: 180px; object-fit: contain; border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); background: var(--map-bg); }
[data-map-panel-proposal-editor] { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding-top: 2px; }
[data-map-panel-annotation-tools] { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
[data-map-panel-annotation-menu] { margin-left: auto; }
[data-map-panel-annotation-tools] > small { flex: 1 1 100%; color: var(--map-fg-3); font-size: 11px; }
/* The count numeral trails the drawing tools without forcing them to wrap. */
[data-map-panel-annotation-tools] > [data-map-panel-bulk-count] {
  flex: none; min-width: 16px; font-variant-numeric: tabular-nums; text-align: center;
}
[data-map-annotation-row] { display: contents; }
[data-map-panel-proposal-editor] label, [data-map-panel-change-editor] label {
  display: flex; flex-direction: column; gap: 4px;
}
[data-map-imagery-row] { display: contents; }
[data-map-imagery-dialog] { display: flex; flex-direction: column; gap: 8px; }
[data-map-imagery-dialog] [data-map-panel-field] { display: flex; flex-direction: column; gap: 4px; }
[data-map-imagery-dialog] [data-map-panel-field] > span { font-size: 12px; color: var(--dsw-alias-label-secondary); }
[data-map-imagery-dialog] select { min-width: 0; }
[data-map-imagery-dialog] input[type="range"] { accent-color: var(--dsw-alias-state-business-primary); }
[data-map-annotation-dialog] { display: flex; flex-direction: column; gap: 8px; }
[data-map-wayback] { grid-column: 1 / -1; display: grid; gap: 6px; }
[data-map-wayback] label { display: grid; gap: 4px; min-width: 0; }
[data-map-wayback] label > span { color: var(--map-fg-3); font-size: 11px; }
[data-map-wayback] select { width: 100%; min-width: 0; max-width: 100%; }
[data-map-wayback-meta] { display: grid; gap: 2px; }
[data-map-wayback-meta] small { color: var(--map-fg-3); font-size: 11px; }
[data-map-wayback-actions] { display: flex; flex-wrap: wrap; gap: 4px; }
[data-map-wayback] small { color: var(--map-fg-3); font-size: 11px; }
[data-map-wayback] small[role="alert"] { color: var(--map-error); }
@media (max-width: 420px) { [data-map-wayback] { display: grid; grid-template-columns: minmax(0, 1fr); } [data-map-wayback] label { width: 100%; } }
@media (max-width: 420px) { [data-map-panel-proposal-editor], [data-map-panel-change-editor] { grid-template-columns: 1fr; } [data-map-panel-actions] { justify-content: flex-end; } }
@media (max-width: 420px) {
  [data-map-container] { position: fixed; inset: 0; z-index: 20; }
}
[data-map-panel-bulk] { display: flex; align-items: center; gap: 4px; margin: 8px 10px 0; flex-wrap: wrap; }
[data-map-panel-bulk] > [data-map-panel-bulk-count] { margin-left: auto; color: var(--map-fg-3); font-size: 11px; white-space: nowrap; }
[data-map-panel-bulk-menu] { flex: none; }
[data-map-panel-pending] { margin: 8px 10px 0; border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); overflow: hidden; }
[data-map-panel-pending-head] { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 6px 8px; background: var(--map-hover); color: var(--map-fg-2); font-size: 11px; font-weight: 500; }
[data-map-panel-pending-head] small { color: var(--map-fg-3); font-size: 11px; font-weight: 400; line-height: 16px; }
[data-map-panel-pending-row] { display: grid; gap: 5px; padding: 6px 8px; border-top: 1px solid var(--map-border); background: var(--map-bg); }
[data-map-panel-pending-main] { display: flex; align-items: center; gap: 6px; min-width: 0; }
[data-map-panel-pending-swatch] { flex: none; width: 12px; height: 12px; border-radius: 50%; background: var(--map-accent); }
[data-map-panel-pending-swatch="change"] { border-radius: 3px; background: var(--map-fg-4); }
[data-map-panel-pending-name] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-panel-pending-actions] { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
[data-map-panel-bulk-confirm] { display: flex; align-items: center; gap: 4px; margin: 4px 10px 0; padding: 4px 8px; border: 1px solid var(--map-error); border-radius: var(--map-radius-sm); color: var(--map-error); }
[data-map-use-status] {
  position: relative; z-index: 4; flex: none; margin: 10px 10px 0;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  max-width: calc(100% - 20px); box-sizing: border-box; padding: 6px 10px;
  background: var(--map-bg); color: var(--map-fg); border: 1px solid var(--map-border);
  border-radius: var(--map-radius); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px); font-size: 12px; line-height: 1.5;
}
[data-map-use-status] > span[data-map-use-action] { color: var(--map-fg-2); }
[data-map-use-status] > button { margin-left: auto; min-height: 26px; padding: 1px 10px; white-space: nowrap; }
@media (hover: none) { [data-map-use-status] > button { min-height: 36px; } }
[data-map-overlay-content] { position: relative; flex: 1; min-height: 0; pointer-events: none; container-type: inline-size; }
[data-map-overlay-content] > * { pointer-events: auto; }
[data-map-overlay-content] > [data-map-panel-lane] { position: absolute; inset: 0 0 var(--map-attribution-height, 22px); pointer-events: none; }
[data-map-panel-lane] > [data-map-panel] { pointer-events: auto; }
@container (max-width: 420px) {
  [data-map-overlay-content] > [data-map-panel-lane] { right: calc(44px + var(--map-control-inset)); }
  [data-map-panel-lane] > [data-map-panel][data-map-panel-surface="unified"] {
    inset: var(--map-control-inset) var(--map-control-inset) auto;
    width: calc(100% - 2 * var(--map-control-inset)); max-height: calc(100% - 2 * var(--map-control-inset));
  }
}
[data-map-container] [data-map-panel-status] { margin: 8px 10px 0; padding: 4px 8px; border-radius: var(--map-radius-sm); background: var(--map-hover); color: var(--map-error); }
[data-map-container] [data-map-panel-status][data-ok] { color: var(--map-fg-2); }
[data-map-panel-empty] { margin: 0; padding: 16px 12px; color: var(--map-fg-3); text-align: center; }
[data-map-panel-list] { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 0 6px; }
[data-map-panel-list][data-overflow] { mask-image: linear-gradient(to bottom, #000 calc(100% - 14px), transparent); }
[data-map-panel-scroll-hint] { display: block; padding: 2px 10px 4px; color: var(--map-fg-3); font-size: 11px; text-align: center; }
@media (pointer: coarse) { [data-map-container] [data-map-panel][data-map-panel-surface] button { min-height: 44px; min-width: 44px; } }
[data-map-panel-meta] { color: var(--map-fg-3); font-size: 11px; font-variant-numeric: tabular-nums; }
[data-map-container] button[data-map-panel-icon] {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 28px; padding: 0;
}
[data-map-container] button[data-map-panel-eye][aria-pressed="false"] { color: var(--map-fg-3); }
[data-map-panel-group-row], [data-map-panel-row] { display: flex; align-items: center; gap: 4px; min-height: 30px; padding: 0 6px 0 8px; }
[data-map-panel-main-cell] { display: flex; flex: 1; min-width: 0; align-items: center; gap: 4px; }
[data-map-panel-action-cell] { display: inline-flex; flex: none; align-items: center; }
[data-map-panel-identity] { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
[data-map-panel-name-row] { display: flex; align-items: center; gap: 6px; min-width: 0; }
[data-map-panel-name-row] [data-map-panel-name] { flex: 1; }
[data-map-panel-state] { color: var(--map-fg-2); font-size: 11px; line-height: 16px; }
[data-map-panel-state][data-state="visible"] { color: var(--map-fg-2); }
[data-map-container] button[data-map-panel-caret] {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; border: 0; padding: 0; font-weight: 500; color: var(--map-fg-2); text-align: left;
}
[data-map-container] button[data-map-panel-caret]:hover:not(:disabled) { background: transparent; }
[data-map-panel-layer][data-nested] [data-map-panel-row] { padding-left: 22px; }
[data-map-panel-layer][data-hidden] [data-map-panel-name], [data-map-panel-layer][data-hidden] [data-map-panel-swatch] { opacity: 0.45; }
[data-map-panel-layer][data-dragging] { opacity: 0.4; }
[data-map-panel-layer][data-drop-target] { box-shadow: inset 0 2px 0 var(--map-accent); }
[data-map-panel-handle] { flex: none; width: 12px; color: var(--map-fg-4); cursor: grab; font-size: 10px; letter-spacing: -2px; user-select: none; opacity: 0; transition: opacity var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
[data-map-panel-row]:focus-within [data-map-panel-handle] { opacity: 1; }
@media (hover: hover) { [data-map-panel-row]:hover [data-map-panel-handle] { opacity: 1; } }
[data-map-panel-handle][draggable="false"] { cursor: default; }
/* The swatch box is a 24px hit target holding a 14px painted badge, so rows
   keep their rhythm and every swatch aligns on one axis. */
[data-map-panel-swatch] {
  flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: 3px; background: transparent;
}
[data-map-container] button[data-map-panel-swatch] { padding: 0; }
[data-map-panel-swatch] > span[data-map-panel-badge] {
  display: flex; flex: none; width: 14px; height: 14px; border-radius: 3px; overflow: hidden;
  border: 1px solid var(--map-border);
}
[data-map-panel-badge] > span { flex: 1 1 0; min-width: 0; }
[data-map-panel-type] { flex: none; font-size: 11px; color: var(--map-fg-2); }
[data-map-container] button[data-map-panel-swatch]:has([data-map-panel-type]) { width: auto; }
[data-map-panel-swatch][data-kind="point"] > span[data-map-panel-badge] { border-radius: 50%; }
[data-map-panel-swatch][data-kind="line"] > span[data-map-panel-badge] { height: 4px; border-radius: 2px; }
[data-map-panel-name] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-container] button[data-map-panel-name] {
  flex: 1; min-width: 0; text-align: left; justify-content: flex-start;
}
[data-map-panel-name] > span, [data-map-panel-chip] > small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-panel-actions] { display: inline-flex; gap: 0; opacity: 0; transition: opacity var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease); }
[data-map-panel-row]:focus-within [data-map-panel-actions], [data-map-panel-actions]:has([aria-expanded="true"]) { opacity: 1; }
@media (hover: hover) { [data-map-panel-row]:hover [data-map-panel-actions] { opacity: 1; } }
@media (hover: none) { [data-map-panel-actions], [data-map-panel-handle] { opacity: 1; } }
[data-map-panel-chip] { display: flex; min-width: 0; overflow: hidden; align-items: center; gap: 2px; min-height: 8px; padding: 0; color: var(--map-fg-3); }
[data-map-panel-chip] > span[role="img"] { flex: none; width: 12px; height: 6px; border-radius: 1px; }
[data-map-panel-ramp] { display: inline-flex; width: 74px; height: 5px; border-radius: 3px; overflow: hidden; }
[data-map-panel-ramp] > span { flex: 1; }
[data-map-panel-chip] small { font-size: 11px; }
[data-map-panel-menu] { display: flex; flex-direction: column; gap: 12px; }
[data-map-panel-candidate-evidence] { display: flex; flex-direction: column; gap: 6px; }
[data-map-panel-candidate-evidence] img { max-width: 100%; max-height: 220px; object-fit: contain; border-radius: var(--map-radius-sm); }
.map-layer-dialog { width: min(440px, 100%); max-height: 100%; overflow-y: auto; }
.map-layer-dialog h2 { min-width: 0; overflow-wrap: anywhere; }
.map-layer-dialog [data-map-panel-color-row] { display: flex; align-items: center; gap: 8px; }
.map-layer-dialog [data-map-panel-color-row] > span { flex: 1; min-width: 0; }
.map-layer-dialog [data-map-panel-color-error] { color: var(--dsw-alias-state-error-primary); }
.map-layer-dialog [data-map-panel-color-disabled] { color: var(--dsw-alias-label-secondary); opacity: 0.7; }
.map-layer-dialog [data-map-panel-actions] { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; opacity: 1; }
[data-map-candidate-dialog] { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
[data-map-panel-source-title] { overflow-wrap: anywhere; }
[data-map-panel-legend] ul { display: grid; gap: 4px; max-height: 180px; overflow: auto; padding: 0; margin: 4px 0 0; list-style: none; }
[data-map-panel-legend] li { display: flex; align-items: center; gap: 8px; overflow-wrap: anywhere; }
[data-map-panel-legend-color] { flex: none; width: 14px; height: 14px; border: 1px solid var(--dsw-alias-border-l2); }
[data-map-layer-dialog-summary] { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--dsw-alias-label-secondary); }
.map-layer-dialog p { margin: 0; color: var(--dsw-alias-label-secondary); }
@media (pointer: coarse) { .map-layer-dialog input, .map-layer-dialog select { font-size: 16px; } .map-layer-dialog button { min-height: 44px; min-width: 44px; } }
[data-map-panel-field] { display: flex; flex-direction: column; gap: 4px; }
[data-map-panel-field] > span { font-size: 11px; color: var(--map-fg-3); }
label[data-map-panel-field]:has(input[type="range"]) { flex-direction: row; align-items: center; gap: 8px; }
label[data-map-panel-field] input[type="range"] { flex: 1; min-width: 0; }
label[data-map-panel-field] output { width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: var(--map-fg-2); }
[data-map-panel-presets] { display: flex; flex-wrap: wrap; gap: 4px; }
[data-map-container] button[data-map-panel-preset], .map-layer-dialog button[data-map-panel-preset] { width: 28px; padding: 4px; }
[data-map-panel-preset] > span { display: block; width: 100%; height: 100%; border-radius: 2px; }
[data-map-panel-chips], [data-map-panel-menu-items] { display: flex; flex-wrap: wrap; gap: 4px; }
[data-map-panel-chips] input { width: 110px; }
[data-map-container] button[data-danger] { color: var(--map-error); }
[data-map-panel-attributes] { margin: 2px 8px 6px 22px; }
[data-map-panel-table] { max-height: 180px; overflow: auto; border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); }
[data-map-panel-table] tbody tr { cursor: pointer; }
[data-map-panel-pager] { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 4px; color: var(--map-fg-2); }
[data-map-container] table { border-collapse: collapse; width: 100%; font-size: 11px; }
[data-map-container] th { text-align: left; font-weight: 500; color: var(--map-fg-2); border-bottom: 1px solid var(--map-border); padding: 2px 4px; }
[data-map-container] td { border-bottom: 1px solid var(--map-border); padding: 2px 4px; }
[data-map-workbench] section { margin-bottom: 8px; }
[data-map-workbench] section:last-child { margin-bottom: 0; }
[data-map-container] ::-webkit-scrollbar { width: 6px; height: 6px; }
[data-map-container] ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-hover-l2, rgba(0, 0, 0, 0.2)); border-radius: 3px; }
@media (pointer: coarse) {
  [data-map-container] button:not([class]),
  [data-map-container] [data-map-panel-header] button, [data-map-container] [data-map-panel-body] button,
  [data-map-container] [data-map-source-error] button { min-height: 44px; min-width: 44px; }
  [data-map-container] select, [data-map-container] input { font-size: 16px; }
}
@media (hover: none) { [data-map-container] button:not([class]):focus-visible:not(:disabled) { background: var(--map-hover); } }
@media (max-width: 420px) {
  [data-map-panel-tabs] [role="tab"] { padding-inline: 2px; font-size: 11px; }
  [data-map-panel-tab] { overflow: visible; text-overflow: clip; }
  [data-map-overlay-content] {
    display: flex; flex-flow: row wrap; justify-content: flex-end;
    align-content: flex-end; align-items: flex-start; row-gap: 8px;
    padding: 10px 10px 32px;
  }
  [data-map-overlay-content] > [data-map-panel] {
    position: absolute; inset: 10px 10px auto; width: auto; max-width: none;
    max-height: calc(80% - 10px); height: auto; margin: 0;
  }
  [data-map-overlay-content] > [data-map-workbench] {
    position: relative; order: -1; flex: 0 0 100%; left: auto; right: auto; bottom: auto;
    margin: 0 0 8px; min-height: 0; box-sizing: border-box;
    max-height: min(32%, calc(44% - 92px)); overflow-y: auto;
  }
  [data-map-feature-card] { z-index: 4; }
}
@media (prefers-reduced-motion: reduce) {
  [data-map-container] button, [data-map-panel-actions], [data-map-panel-handle], [data-map-tool-card-row] { transition: none; }
}
`

/**
 * Install the stylesheet once per document.
 * @param doc - the target document; absent outside a browser.
 */
export function installMapTheme(doc: Document | undefined = globalThis.document): void {
  if (doc === undefined || doc.querySelector(`style[data-plugin-css="${MAP_THEME_TAG}"]`) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.pluginCss = MAP_THEME_TAG
  tag.textContent = MAP_THEME_CSS + MAP_TOOL_CARD_CSS + MAPBOX_CTRL_CSS
  doc.head.appendChild(tag)
}

/** Stylesheet for the conversation map tool rows (outside the map container). */
export const MAP_TOOL_CARD_CSS = `
[data-map-tool-card] { display: flex; flex-direction: column; font-family: var(--dsw-font-family, system-ui, sans-serif); }
[data-map-tool-card-row] {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-label-tertiary, #86909c); transition: color var(--ds-transition-duration-fast, 100ms) var(--ds-ease-in-out, ease);
}
[data-map-tool-card-row][role="button"] { cursor: pointer; }
@media (hover: hover) { [data-map-tool-card-row]:hover { color: var(--dsw-alias-label-secondary, #4e5969); } }
[data-map-tool-card-row]:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3370ff); outline-offset: 1px; border-radius: var(--dsw-radius-sm, 4px); }
[data-map-tool-card-icon] { flex: none; width: 16px; text-align: center; color: var(--dsw-alias-state-business-primary, #3370ff); }
[data-map-tool-card-row][aria-expanded]::after {
  content: ''; flex: none; margin-left: auto; width: 0; height: 0;
  border-left: 4px solid transparent; border-right: 4px solid transparent;
  border-top: 5px solid var(--dsw-alias-label-tertiary, #86909c);
}
[data-map-tool-card-row][aria-expanded="false"]::after { transform: rotate(-90deg); }
[data-map-tool-card-title] { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #4e5969); }
[data-map-tool-card-state] { flex: none; font-size: 11px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }
[data-map-tool-card][data-state="running"] [data-map-tool-card-state] { color: var(--dsw-alias-state-business-primary, #3370ff); }
[data-map-tool-card][data-state="error"] [data-map-tool-card-state], [data-map-tool-card-error] { color: var(--dsw-alias-state-error-primary, #d93026); }
[data-map-tool-card-error] { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-tool-card-body] {
  margin: 4px 0 6px 22px; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: var(--dsw-radius-md, 8px);
  background: var(--dsw-alias-bg-layer-1, transparent); font-size: 12px; color: var(--dsw-alias-label-primary, #1f2329);
}
[data-map-tool-card-section] h4 { margin: 0 0 4px; font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary, #4e5969); }
[data-map-tool-card-section] dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
[data-map-tool-card-section] dl > div { display: flex; gap: 12px; }
[data-map-tool-card-section] dt { flex: none; width: 6em; color: var(--dsw-alias-label-secondary, #4e5969); }
[data-map-tool-card-section] dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
[data-map-tool-card-raw] summary { cursor: pointer; color: var(--dsw-alias-label-secondary, #4e5969); font-size: 11px; }
[data-map-tool-card-raw] pre { margin: 4px 0 0; max-height: 200px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; }
[data-map-tool-card-inspect] {
  align-self: flex-start; font: inherit; font-size: 12px; cursor: pointer; background: transparent;
  color: var(--dsw-alias-label-secondary, #4e5969); border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: var(--dsw-radius-sm, 4px); padding: 1px 8px;
}
[data-map-session-action] {
  font: inherit; font-size: 12px; cursor: pointer; color: var(--dsw-alias-label-secondary, #4e5969);
  background: transparent; border: 0; border-radius: var(--dsw-radius-sm, 4px); padding: 2px 8px; min-height: 28px;
}
@media (hover: hover) {
  [data-map-session-action]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05)); color: var(--dsw-alias-label-primary, #1f2329); }
}
[data-map-session-action]:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3370ff); outline-offset: 1px; }
`

/**
 * Official Mapbox GL JS v3 control geometry, transcribed from
 * https://unpkg.com/mapbox-gl@3/dist/mapbox-gl.css. Values stay literal so the
 * overlay can be compared with the vendor stylesheet declaration by declaration.
 */
export const MAPBOX_CTRL_GEOMETRY = Object.freeze({
  buttonSize: '32px',
  radius: '4px',
  background: '#fff',
  ring: '0 0 0 2px rgba(0, 0, 0, 0.1)',
  separator: '#ddd',
  hover: '#eee',
  focus: '0 0 2px 2px #0096ff',
  font: `12px/20px "Helvetica Neue", Arial, Helvetica, sans-serif`,
  scaleBackground: 'rgba(255, 255, 255, 0.75)',
  scaleBorder: '#333',
  attributionBackground: 'rgba(255, 255, 255, 0.5)',
})

/** Vendor SVG icons: verbatim data URIs from the official stylesheet. */
export const MAPBOX_CTRL_ICONS = Object.freeze({
  zoomIn: `url("data:image/svg+xml;charset=utf-8,%3Csvg width='29' height='29' viewBox='0 0 29 29' xmlns='http://www.w3.org/2000/svg' fill='%23333'%3E %3Cpath d='M14.5 8.5c-.75 0-1.5.75-1.5 1.5v3h-3c-.75 0-1.5.75-1.5 1.5S9.25 16 10 16h3v3c0 .75.75 1.5 1.5 1.5S16 19.75 16 19v-3h3c.75 0 1.5-.75 1.5-1.5S19.75 13 19 13h-3v-3c0-.75-.75-1.5-1.5-1.5z'/%3E %3C/svg%3E")`,
  zoomOut: `url("data:image/svg+xml;charset=utf-8,%3Csvg width='29' height='29' viewBox='0 0 29 29' xmlns='http://www.w3.org/2000/svg' fill='%23333'%3E %3Cpath d='M10 13c-.75 0-1.5.75-1.5 1.5S9.25 16 10 16h9c.75 0 1.5-.75 1.5-1.5S19.75 13 19 13h-9z'/%3E %3C/svg%3E")`,
  compass: `url("data:image/svg+xml;charset=utf-8,%3Csvg width='29' height='29' viewBox='0 0 29 29' xmlns='http://www.w3.org/2000/svg' fill='%23333'%3E %3Cpath d='M10.5 14l4-8 4 8h-8z'/%3E %3Cpath id='south' d='M10.5 16l4 8 4-8h-8z' fill='%23ccc'/%3E %3C/svg%3E")`,
  fullscreen: `url("data:image/svg+xml;charset=utf-8,%3Csvg width='29' height='29' viewBox='0 0 29 29' xmlns='http://www.w3.org/2000/svg' fill='%23333'%3E %3Cpath d='M24 16v5.5c0 1.75-.75 2.5-2.5 2.5H16v-1l3-1.5-4-5.5 1-1 5.5 4 1.5-3h1zM6 16l1.5 3 5.5-4 1 1-4 5.5 3 1.5v1H7.5C5.75 24 5 23.25 5 21.5V16h1zm7-11v1l-3 1.5 4 5.5-1 1-5.5-4L6 13H5V7.5C5 5.75 5.75 5 7.5 5H13zm11 2.5c0-1.75-.75-2.5-2.5-2.5H16v1l3 1.5-4 5.5 1 1 5.5-4 1.5 3h1V7.5z'/%3E %3C/svg%3E")`,
  attribution: `url("data:image/svg+xml;charset=utf-8,%3Csvg width='24' height='24' viewBox='0 0 20 20' xmlns='http://www.w3.org/2000/svg' fill-rule='evenodd'%3E %3Cpath d='M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0m5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0'/%3E %3C/svg%3E")`,
})

/**
 * Stylesheet for the Mapbox-compatible controls and the layer-panel skin.
 * Selectors use `data-mapbox-*` instead of the vendor class names so nothing
 * collides with the ArcGIS SDK; declarations keep the vendor values.
 */
export const MAPBOX_CTRL_CSS = `
[data-mapbox-controls] { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
[data-map-overlay-content] > [data-mapbox-controls] { pointer-events: none; }
[data-mapbox-ctrl-top-right], [data-mapbox-ctrl-bottom-left], [data-mapbox-ctrl-bottom-right] {
  position: absolute; pointer-events: none; z-index: 2; font: ${MAPBOX_CTRL_GEOMETRY.font};
}
[data-mapbox-ctrl-top-right] { top: 0; right: 0; display: flex; flex-direction: column; align-items: flex-end; }
[data-mapbox-ctrl-bottom-left] { bottom: var(--map-attribution-height, 22px); left: 0; }
[data-mapbox-ctrl-bottom-right] { bottom: var(--map-attribution-height, 22px); right: 0; }
[data-mapbox-ctrl] { clear: both; pointer-events: auto; }
[data-mapbox-ctrl-top-right] > [data-mapbox-ctrl] { margin: var(--map-control-inset) var(--map-control-inset) 0 0; }
[data-mapbox-ctrl-top-right] > [data-mapbox-ctrl] + [data-mapbox-ctrl] { margin-top: 0; }
[data-mapbox-ctrl-bottom-left] > [data-mapbox-ctrl] { margin: 0 0 10px 10px; }
[data-mapbox-ctrl-bottom-right] > [data-mapbox-ctrl] { margin: 0 10px 10px 0; }
[data-mapbox-ctrl-group] { border-radius: ${MAPBOX_CTRL_GEOMETRY.radius}; background: ${MAPBOX_CTRL_GEOMETRY.background}; }
[data-mapbox-ctrl-group]:not(:empty) { box-shadow: ${MAPBOX_CTRL_GEOMETRY.ring}; }
[data-mapbox-ctrl-group] button {
  width: ${MAPBOX_CTRL_GEOMETRY.buttonSize}; height: ${MAPBOX_CTRL_GEOMETRY.buttonSize}; display: block;
  padding: 0; outline: none; border: 0; box-sizing: border-box; background-color: initial;
  cursor: pointer; overflow: hidden;
}
[data-map-container] [data-mapbox-ctrl-group] button, [data-map-container] [data-mapbox-ctrl-attrib-button] {
  font: initial; border: 0; border-radius: 0; padding: 0; min-height: 0; color: initial;
  background: transparent; transition: none;
}
[data-map-container] [data-mapbox-ctrl-group] button + button { border-top: 1px solid ${MAPBOX_CTRL_GEOMETRY.separator}; }
[data-mapbox-ctrl-group] button + button { border-top: 1px solid ${MAPBOX_CTRL_GEOMETRY.separator}; }
[data-mapbox-ctrl-group] button > [data-mapbox-ctrl-icon] {
  display: block; width: 100%; height: 100%; background-repeat: no-repeat; background-position: 50%;
}
[data-mapbox-ctrl-group] button:focus { box-shadow: ${MAPBOX_CTRL_GEOMETRY.focus}; }
[data-mapbox-ctrl-group] button:focus:not(:focus-visible) { box-shadow: none; }
[data-mapbox-ctrl-group] button:disabled { cursor: not-allowed; }
[data-mapbox-ctrl-group] button:disabled > [data-mapbox-ctrl-icon] { opacity: .25; }
[data-mapbox-ctrl-group] button:first-of-type { border-radius: ${MAPBOX_CTRL_GEOMETRY.radius} ${MAPBOX_CTRL_GEOMETRY.radius} 0 0; }
[data-mapbox-ctrl-group] button:last-child { border-radius: 0 0 ${MAPBOX_CTRL_GEOMETRY.radius} ${MAPBOX_CTRL_GEOMETRY.radius}; }
[data-mapbox-ctrl-group] button:only-child { border-radius: inherit; }
[data-mapbox-ctrl-group] button[data-mapbox-ctrl-zoom-in] > [data-mapbox-ctrl-icon] { background-image: ${MAPBOX_CTRL_ICONS.zoomIn}; }
[data-mapbox-ctrl-group] button[data-mapbox-ctrl-zoom-out] > [data-mapbox-ctrl-icon] { background-image: ${MAPBOX_CTRL_ICONS.zoomOut}; }
[data-mapbox-ctrl-group] button[data-mapbox-ctrl-compass] > [data-mapbox-ctrl-icon] { background-image: ${MAPBOX_CTRL_ICONS.compass}; transform: rotate(var(--mapbox-compass-rotation, 0deg)); }
[data-mapbox-ctrl-group] button[data-mapbox-ctrl-fullscreen] > [data-mapbox-ctrl-icon] { background-image: ${MAPBOX_CTRL_ICONS.fullscreen}; }
[data-mapbox-ctrl-scale] {
  background-color: ${MAPBOX_CTRL_GEOMETRY.scaleBackground}; font-size: 10px;
  color: ${MAPBOX_CTRL_GEOMETRY.scaleBorder}; border-color: ${MAPBOX_CTRL_GEOMETRY.scaleBorder};
  border-style: none solid solid; border-width: medium 2px 2px; padding: 0 5px;
  box-sizing: border-box; white-space: nowrap;
}
[data-mapbox-ctrl-attrib] { padding: 0 5px; background-color: ${MAPBOX_CTRL_GEOMETRY.attributionBackground}; margin: 0; }
[data-mapbox-ctrl-attrib] [data-mapbox-ctrl-attrib-inner] { color: rgba(0, 0, 0, 0.75); font-size: 10px; }
[data-mapbox-ctrl-attrib] a { color: rgba(0, 0, 0, 0.75); text-decoration: none; }
[data-mapbox-ctrl-attrib][data-mapbox-compact] {
  --mapbox-attrib-button-size: 24px;
  min-height: var(--mapbox-attrib-button-size); padding: 2px var(--mapbox-attrib-button-size) 2px 0;
  margin: 10px; position: relative; box-sizing: border-box;
  background-color: ${MAPBOX_CTRL_GEOMETRY.background}; border-radius: calc(var(--mapbox-attrib-button-size) / 2);
}
@media (pointer: coarse) {
  [data-mapbox-ctrl-attrib][data-mapbox-compact] { --mapbox-attrib-button-size: 44px; }
}
[data-mapbox-ctrl-attrib][data-mapbox-compact] [data-mapbox-ctrl-attrib-inner] { display: none; }
[data-mapbox-ctrl-attrib][data-mapbox-compact-show] { padding: 2px calc(var(--mapbox-attrib-button-size) + 4px) 2px 8px; }
[data-mapbox-ctrl-attrib][data-mapbox-compact-show] [data-mapbox-ctrl-attrib-inner] { display: block; max-width: min(320px, 60vw); }
[data-map-container] button[data-mapbox-ctrl-attrib-button] {
  display: none; cursor: pointer; position: absolute;
  width: var(--mapbox-attrib-button-size); height: var(--mapbox-attrib-button-size);
  box-sizing: border-box; border-radius: 50%; outline: none; top: 0; right: 0; border: 0;
  background-color: rgba(255, 255, 255, 0.5); background-image: ${MAPBOX_CTRL_ICONS.attribution};
  background-repeat: no-repeat; background-position: 50%; min-height: 0; padding: 0; font: initial;
}
[data-mapbox-ctrl-attrib][data-mapbox-compact] [data-mapbox-ctrl-attrib-button] { display: block; }
[data-mapbox-ctrl-attrib][data-mapbox-compact-show] [data-mapbox-ctrl-attrib-button] { background-color: rgba(0, 0, 0, 0.05); }
@media (hover: hover) {
  [data-mapbox-ctrl-group] button:not(:disabled):hover { background-color: ${MAPBOX_CTRL_GEOMETRY.hover}; }
  [data-mapbox-ctrl-attrib] a:hover { text-decoration: underline; }
}
`
