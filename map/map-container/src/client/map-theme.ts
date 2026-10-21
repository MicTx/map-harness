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

/** The overlay stylesheet text. */
export const MAP_THEME_CSS = `
[data-map-container] {
  --map-bg: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.96));
  --map-fg: var(--dsw-alias-label-primary, #1f2329);
  --map-fg-2: var(--dsw-alias-label-secondary, #4e5969);
  --map-fg-3: var(--dsw-alias-label-tertiary, #86909c);
  --map-border: var(--dsw-alias-border-l2, #e5e6eb);
  --map-hover: var(--dsw-alias-interactive-bg-hover, rgba(0, 0, 0, 0.05));
  --map-accent: var(--dsw-alias-state-business-primary, #3370ff);
  --map-error: var(--dsw-alias-state-error-primary, #d93026);
  --map-radius: var(--dsw-radius-md, 8px);
  --map-radius-sm: var(--dsw-radius-sm, 4px);
  font-family: var(--dsw-font-family, system-ui, sans-serif);
  color: var(--map-fg);
}
[data-map-panel], [data-map-workbench], [data-gesture-submit], [data-map-state], [data-map-panel-collapsed] {
  background: var(--map-bg);
  color: var(--map-fg);
  border: 1px solid var(--map-border);
  border-radius: var(--map-radius);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px);
  font-size: 12px;
  line-height: 1.5;
}
[data-map-panel] { padding: 10px 12px; width: 340px; box-sizing: border-box; }
[data-map-panel] input[type="range"] { flex: 1; min-width: 60px; }
[data-map-workbench] { border-radius: var(--map-radius) var(--map-radius) 0 0; border-bottom: 0; padding: 8px 12px; }
[data-gesture-submit] { padding: 4px; }
[data-map-state] { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); margin: 0; padding: 10px 16px; z-index: 2; display: flex; align-items: center; gap: 8px; }
[data-map-state="error"] { color: var(--map-error); }
[data-map-container] h2 { display: flex; align-items: center; justify-content: space-between; margin: 0 0 8px; font-size: 13px; font-weight: 600; }
[data-map-container] h3 { display: flex; align-items: center; justify-content: space-between; gap: 6px; margin: 6px 0 2px; font-size: 12px; font-weight: 600; color: var(--map-fg-2); }
[data-map-container] button {
  font: inherit; font-size: 12px; color: var(--map-fg); background: transparent;
  border: 1px solid var(--map-border); border-radius: var(--map-radius-sm);
  padding: 1px 8px; min-height: 22px; cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;
}
[data-map-container] button:hover:not(:disabled) { background: var(--map-hover); border-color: var(--map-fg-3); }
[data-map-container] button:disabled { color: var(--map-fg-3); cursor: not-allowed; opacity: 0.6; }
[data-map-container] button[aria-expanded] { border-color: transparent; padding-left: 2px; font-weight: 600; }
[data-map-container] button:focus-visible, [data-map-container] input:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--map-accent)); outline-offset: 1px;
}
[data-map-container] input[type="search"], [data-map-container] input[type="text"] {
  font: inherit; font-size: 12px; color: var(--map-fg); background: transparent;
  border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); padding: 2px 8px; min-height: 22px; box-sizing: border-box;
}
[data-map-container] input::placeholder { color: var(--map-fg-3); }
[data-map-container] input[type="checkbox"], [data-map-container] input[type="range"] { accent-color: var(--map-accent); }
[data-map-container] [role="status"], [data-map-container] [role="note"] { color: var(--map-fg-2); }
[data-map-panel-status] { padding: 4px 8px; border-radius: var(--map-radius-sm); background: var(--map-hover); }
[data-map-panel-layer] { padding: 6px 4px; border-bottom: 1px solid var(--map-border); border-radius: var(--map-radius-sm); }
[data-map-panel-layer]:last-child { border-bottom: 0; }
[data-map-panel-layer]:hover { background: var(--map-hover); }
[data-map-panel-row] > div { margin-top: 4px; }
[data-map-panel-row] > div:first-child { margin-top: 0; }
[data-map-panel-row] strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
[data-map-panel-badge] { color: var(--map-fg-2); background: var(--map-hover); border-radius: 999px; padding: 0 6px; font-size: 11px; }
[data-map-panel-meta] { color: var(--map-fg-3); }
[data-map-container] table { border-collapse: collapse; width: 100%; font-size: 11px; }
[data-map-container] th { text-align: left; font-weight: 600; color: var(--map-fg-2); border-bottom: 1px solid var(--map-border); padding: 2px 4px; }
[data-map-container] td { border-bottom: 1px solid var(--map-border); padding: 2px 4px; }
[data-map-container] tbody tr:hover { background: var(--map-hover); }
[data-map-workbench] section { margin-bottom: 8px; }
[data-map-workbench] section:last-child { margin-bottom: 0; }
[data-map-container] ::-webkit-scrollbar { width: 6px; height: 6px; }
[data-map-container] ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-hover-l2, rgba(0, 0, 0, 0.2)); border-radius: 3px; }
@media (prefers-reduced-motion: reduce) { [data-map-container] button { transition: none; } }
`

/**
 * Install the stylesheet once per document.
 * @param doc - the target document; absent outside a browser.
 */
export function installMapTheme(doc: Document | undefined = globalThis.document): void {
  if (doc === undefined || doc.querySelector(`style[data-plugin-css="${MAP_THEME_TAG}"]`) !== null) return
  const tag = doc.createElement('style')
  tag.dataset.pluginCss = MAP_THEME_TAG
  tag.textContent = MAP_THEME_CSS + MAP_TOOL_CARD_CSS
  doc.head.appendChild(tag)
}

/** Stylesheet for the conversation map tool rows (outside the map container). */
export const MAP_TOOL_CARD_CSS = `
[data-map-tool-card] { display: flex; flex-direction: column; font-family: var(--dsw-font-family, system-ui, sans-serif); }
[data-map-tool-card-row] {
  display: flex; align-items: center; gap: 6px; min-width: 0;
  height: calc(24px + var(--dsh-content-font-delta, 0px));
  font-size: var(--dsh-content-font-size-secondary, 13px);
  color: var(--dsw-alias-label-tertiary, #86909c); transition: color 100ms ease;
}
[data-map-tool-card-row][role="button"] { cursor: pointer; }
[data-map-tool-card-row]:hover { color: var(--dsw-alias-label-secondary, #4e5969); }
[data-map-tool-card-row]:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #3370ff); outline-offset: 1px; border-radius: var(--dsw-radius-sm, 4px); }
[data-map-tool-card-icon] { flex: none; width: 16px; text-align: center; color: var(--dsw-alias-state-business-primary, #3370ff); }
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
[data-map-tool-card-section] h4 { margin: 0 0 4px; font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #86909c); }
[data-map-tool-card-section] dl { margin: 0; display: flex; flex-direction: column; gap: 2px; }
[data-map-tool-card-section] dl > div { display: flex; gap: 12px; }
[data-map-tool-card-section] dt { flex: none; width: 6em; color: var(--dsw-alias-label-secondary, #4e5969); }
[data-map-tool-card-section] dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
[data-map-tool-card-raw] summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #86909c); font-size: 11px; }
[data-map-tool-card-raw] pre { margin: 4px 0 0; max-height: 200px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; }
[data-map-tool-card-inspect] {
  align-self: flex-start; font: inherit; font-size: 12px; cursor: pointer; background: transparent;
  color: var(--dsw-alias-label-secondary, #4e5969); border: 1px solid var(--dsw-alias-border-l2, #e5e6eb); border-radius: var(--dsw-radius-sm, 4px); padding: 1px 8px;
}
@media (prefers-reduced-motion: reduce) { [data-map-tool-card-row] { transition: none; } }
`
