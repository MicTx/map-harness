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
[data-map-panel], [data-map-workbench], [data-gesture-submit], [data-map-state], [data-map-panel-toggle] {
  background: var(--map-bg);
  color: var(--map-fg);
  border: 1px solid var(--map-border);
  border-radius: var(--map-radius);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px);
  font-size: 12px;
  line-height: 1.5;
}
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
[data-map-feature-card] {
  position: absolute; top: 12px; left: 12px; z-index: 3;
  width: min(300px, calc(100% - 24px)); max-height: min(60%, 420px); overflow: auto;
  background: var(--map-bg); color: var(--map-fg); border: 1px solid var(--map-border);
  border-radius: var(--map-radius); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  backdrop-filter: blur(6px); font-size: 12px; line-height: 1.5;
}
[data-map-feature-card-head] {
  position: sticky; top: 0; display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;
  padding: 10px 12px 8px; background: var(--map-bg); border-bottom: 1px solid var(--map-border);
}
[data-map-feature-card-head] h3 { margin: 0; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
[data-map-feature-card-head] p { margin: 2px 0 0; color: var(--map-fg-3); }
[data-map-feature-card] dl { margin: 0; padding: 6px 12px 10px; }
[data-map-feature-card] dl > div { display: grid; grid-template-columns: minmax(72px, 40%) 1fr; gap: 8px; padding: 3px 0; border-bottom: 1px dashed var(--map-border); }
[data-map-feature-card] dl > div:last-child { border-bottom: 0; }
[data-map-feature-card] dt { color: var(--map-fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-map-feature-card] dd { margin: 0; overflow-wrap: anywhere; }
[data-map-feature-card-empty], [data-map-feature-card-more] { margin: 0; padding: 6px 12px 10px; color: var(--map-fg-3); }
[data-map-panel] {
  position: absolute; top: 10px; right: 10px; z-index: 2; width: 280px; max-width: calc(100% - 20px);
  max-height: calc(100% - 80px); display: flex; flex-direction: column; box-sizing: border-box; overflow: hidden;
}
[data-map-panel-toggle] {
  position: absolute; top: 10px; right: 10px; z-index: 2; display: inline-flex; align-items: center; gap: 6px;
  min-height: 32px; padding: 0 10px; font-weight: 600;
}
[data-map-container] [data-map-panel-toggle] { border: 1px solid var(--map-border); padding: 0 10px; }
[data-map-panel-count] { min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--map-accent); color: #fff; font-size: 11px; line-height: 18px; text-align: center; }
[data-map-panel-header] { display: flex; align-items: center; gap: 8px; padding: 10px 8px 8px 12px; border-bottom: 1px solid var(--map-border); }
[data-map-container] [data-map-panel-header] h2 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; }
[data-map-panel-search] { margin: 8px 10px 0; }
[data-map-container] [data-map-panel-status] { margin: 8px 10px 0; padding: 4px 8px; border-radius: var(--map-radius-sm); background: var(--map-hover); color: var(--map-error); }
[data-map-container] [data-map-panel-status][data-ok] { color: var(--map-fg-2); }
[data-map-panel-empty] { margin: 0; padding: 16px 12px; color: var(--map-fg-3); text-align: center; }
[data-map-panel-list] { overflow-y: auto; padding: 4px 0 6px; }
[data-map-panel-meta] { color: var(--map-fg-3); font-size: 11px; font-variant-numeric: tabular-nums; }
[data-map-container] button[data-map-panel-icon] {
  display: inline-flex; align-items: center; justify-content: center; flex: none;
  width: 24px; height: 24px; min-height: 24px; padding: 0; border: 0; border-radius: var(--map-radius-sm); color: var(--map-fg-2); font-size: 14px; line-height: 1;
}
[data-map-container] button[data-map-panel-icon]:hover:not(:disabled) { background: var(--map-hover); color: var(--map-fg); }
[data-map-container] button[data-map-panel-eye][aria-pressed="false"] { color: var(--map-fg-3); }
[data-map-panel-group-row], [data-map-panel-row] { display: flex; align-items: center; gap: 4px; min-height: 30px; padding: 0 6px 0 8px; }
[data-map-panel-group-row]:hover, [data-map-panel-row]:hover { background: var(--map-hover); }
[data-map-container] button[data-map-panel-caret] {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; border: 0; padding: 0; font-weight: 600; color: var(--map-fg-2); text-align: left;
}
[data-map-container] button[data-map-panel-caret]:hover:not(:disabled) { background: transparent; }
[data-map-panel-layer][data-nested] [data-map-panel-row] { padding-left: 22px; }
[data-map-panel-layer][data-hidden] [data-map-panel-name], [data-map-panel-layer][data-hidden] [data-map-panel-swatch] { opacity: 0.45; }
[data-map-panel-layer][data-dragging] { opacity: 0.4; }
[data-map-panel-layer][data-drop-target] { box-shadow: inset 0 2px 0 var(--map-accent); }
[data-map-panel-handle] { flex: none; width: 12px; color: var(--map-fg-3); cursor: grab; font-size: 10px; letter-spacing: -2px; user-select: none; opacity: 0; transition: opacity 120ms ease; }
[data-map-panel-row]:hover [data-map-panel-handle], [data-map-panel-row]:focus-within [data-map-panel-handle] { opacity: 1; }
[data-map-panel-handle][draggable="false"] { cursor: default; }
[data-map-panel-swatch] {
  flex: none; width: 14px; height: 14px; border-radius: 3px; overflow: hidden; display: inline-flex;
  border: 1px solid var(--map-border); background: var(--map-hover);
}
[data-map-panel-swatch] > span { flex: 1; }
[data-map-panel-swatch][data-kind="point"] { border-radius: 50%; }
[data-map-panel-swatch][data-kind="line"] { height: 4px; border-radius: 2px; }
[data-map-container] button[data-map-panel-name] {
  flex: 1; min-width: 0; border: 0; padding: 0 2px; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--map-fg);
}
[data-map-container] button[data-map-panel-name]:hover:not(:disabled) { background: transparent; text-decoration: underline; }
[data-map-panel-actions] { display: inline-flex; gap: 0; opacity: 0; transition: opacity 120ms ease; }
[data-map-panel-row]:hover [data-map-panel-actions], [data-map-panel-row]:focus-within [data-map-panel-actions], [data-map-panel-actions]:has([aria-expanded="true"]) { opacity: 1; }
@media (hover: none) { [data-map-panel-actions], [data-map-panel-handle] { opacity: 1; } }
[data-map-panel-chip] { display: flex; align-items: center; gap: 2px; padding: 0 8px 4px 46px; color: var(--map-fg-3); }
[data-map-panel-layer][data-nested] [data-map-panel-chip] { padding-left: 60px; }
[data-map-panel-chip] > span[role="img"] { width: 14px; height: 8px; border-radius: 1px; }
[data-map-panel-ramp] { display: inline-flex; width: 84px; height: 6px; border-radius: 3px; overflow: hidden; }
[data-map-panel-ramp] > span { flex: 1; }
[data-map-panel-chip] small { margin-left: 6px; font-size: 11px; }
[data-map-panel-menu] {
  margin: 2px 8px 6px 22px; padding: 8px 10px; display: flex; flex-direction: column; gap: 8px;
  border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); background: var(--map-bg);
}
[data-map-panel-field] { display: flex; flex-direction: column; gap: 4px; }
[data-map-panel-field] > span { font-size: 11px; color: var(--map-fg-3); }
label[data-map-panel-field] { flex-direction: row; align-items: center; gap: 8px; }
label[data-map-panel-field] input[type="range"] { flex: 1; min-width: 0; }
label[data-map-panel-field] output { width: 34px; text-align: right; font-variant-numeric: tabular-nums; color: var(--map-fg-2); }
[data-map-panel-presets] { display: flex; flex-wrap: wrap; gap: 4px; }
[data-map-container] button[data-map-panel-preset] { width: 22px; height: 22px; min-height: 22px; padding: 3px; }
[data-map-panel-preset] > span { display: block; width: 100%; height: 100%; border-radius: 2px; }
[data-map-panel-chips], [data-map-panel-menu-items] { display: flex; flex-wrap: wrap; gap: 4px; }
[data-map-panel-chips] input { width: 110px; }
[data-map-container] button[data-danger] { color: var(--map-error); }
[data-map-panel-attributes] { margin: 2px 8px 6px 22px; }
[data-map-panel-table] { max-height: 180px; overflow: auto; border: 1px solid var(--map-border); border-radius: var(--map-radius-sm); }
[data-map-panel-table] tbody tr { cursor: pointer; }
[data-map-panel-table] td button { border: 0; padding: 0; min-height: 0; color: var(--map-accent); }
[data-map-panel-pager] { display: flex; align-items: center; justify-content: flex-end; gap: 4px; margin-top: 4px; color: var(--map-fg-2); }
[data-map-container] table { border-collapse: collapse; width: 100%; font-size: 11px; }
[data-map-container] th { text-align: left; font-weight: 600; color: var(--map-fg-2); border-bottom: 1px solid var(--map-border); padding: 2px 4px; }
[data-map-container] td { border-bottom: 1px solid var(--map-border); padding: 2px 4px; }
[data-map-container] tbody tr:hover { background: var(--map-hover); }
[data-map-workbench] section { margin-bottom: 8px; }
[data-map-workbench] section:last-child { margin-bottom: 0; }
[data-map-container] ::-webkit-scrollbar { width: 6px; height: 6px; }
[data-map-container] ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-hover-l2, rgba(0, 0, 0, 0.2)); border-radius: 3px; }
@media (prefers-reduced-motion: reduce) { [data-map-container] button, [data-map-panel-actions], [data-map-panel-handle] { transition: none; } }
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
