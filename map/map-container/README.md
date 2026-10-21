# @map-harness/map-container

English | [中文](README.zh.md)

The session's map: the authoritative `mapContainer` session projection and
its `ctx.map` read face on the host, and the ArcGIS map tab — canvas, layer
management panel, and workbench — in the browser. One map state, one writer;
the browser edits nothing outside the session queue.

## Host half

- The `mapContainer` projection folds accepted `map_*` tool results (the
  versioned `map-change` meta in `tool/result.meta`) into the durable layer
  list, view, AOI, operation ledger, and pending-call table. The fold is a
  pure synchronous function of the session log, so replay reconstructs the
  same map.
- `ctx.map` (the `MapContainerService`) reads that state for the tools; it has
  no write path.
- The visual-observation service pairs one `map_observe` wait with one
  client capture, and `GET /api/map/observation`-style registration rides the
  host Connection when one is mounted (pure-Node hosts call the service
  directly).
- `GET /api/map/artifact` streams one exact catalog version's bytes to the
  session's browser: the parameter set is exactly `session` + `ref`
  (`res-…@vN` / `art-…@vN`), the read goes through
  `SpatialCatalogService.forSession(session)` (session isolation,
  authorization, and whole-content digest verification), and every failure
  answers with one fixed code — `unknown-session`, `unknown-ref`,
  `unauthorized`, `digest-mismatch` — and no storage detail.

## Browser half

- `MapTabBody` mounts the ArcGIS view for one tab, drives it from the
  projection wire, and hosts the layer panel and the workbench.
- `LayerPanel` manages every wire layer: search (any word over name, id,
  type family, group), group sections with the ungrouped tail, batch
  visibility, opacity, grouping, two-step removal, preset quick-apply, legend
  chips derived from the same `legendOf`/`legendOfSymbol` functions the map
  renders through, and a bounded attribute table (`featureIdOf` row ids,
  8 rows per page, ≤12 columns).
- The panel has two operation levels. View-local actions (search, folding,
  locating via `focusLayer`/`focusFeature`, attribute paging) take effect
  immediately and never leave the browser. State changes (visibility,
  opacity, grouping, removal, presets, exports) serialize as one bounded
  `[map-panel v1]` text and queue into the session through the same
  `session.prompt` seam the composer uses, with the `mapPanel` reference
  source label. The panel never writes the projection and never pre-stages
  state: the checkbox follows the wire, not the click.
- `gesture.ts` forms bounded `[map-gesture v1]` camera observations from user
  interaction windows; occurrence-driven camera writes (`syncCamera`, focus
  `goTo`) mute attribution so programmatic renders never become user input.

## Conversation tool cards

- `src/tool-cards/` is the one display dictionary for every spatial tool: a Chinese action phrase, an icon category, and the argument and result fields a card lists, with unit-aware formatters (meters/kilometers, m²/km², WGS84 degrees, counts). Geometry arrays and large JSON never reach a card; malformed or streaming arguments degrade to the action name.
- The browser registers one keyed `tool.call.toolview` row (`MapToolCard`) per dictionary entry. The row derives its title (`action · subject`), argument and result lines, and failure code from the durable call slice alone, so live streaming and replay render the same; tools outside the dictionary keep the generic row.
- `@map-harness/map-tools` wraps every registered spatial tool with `withPresentation`, reusing the same entries for the Host `presentCall`/`presentResult` cards (ACP and CLI surfaces). The model-facing `output.render` text is unchanged.
- Adding or renaming a spatial tool requires a dictionary entry in the same change. `map-tools` re-types the dictionary as `Record<SpatialToolName, …>` so a missing entry fails `tsc`, `withPresentation` refuses an unlisted tool at registration, and `tools/tests/presentation.spec.mjs` asserts the dictionary keys equal the catalog.
- The map tab overlays and the tool rows share `map-theme.ts`, a stylesheet over the host `--dsw-*` design tokens, so they follow the host light and dark themes.

## Versions and evidence

`SymbolStyle` and `FeatureOverrides` version tokens (`sym-…@v1`,
`ovr-…@v1`) derive from a digest over every field, so a record cannot be
edited without a new version; `StyleSpec`/`LegendSpec` remain the
classification authority in `spatial-viz`. The pending book behind the panel
is advisory only: local, bounded (32 entries), never persisted, and it can
never claim an unobserved success.

Evidence: `tests/` (projection, protocol, occurrence rendering identities,
gesture and panel channels, derivation faces, artifact route) plus the
composition lane in `map/arcgis-mcp/tests/composition.e2e.mjs`. The
capability matrix lives in `map/docs/verification-matrix.md`; the binding
contract in `map/docs/map-container-binding.md`.

Dependency direction: `map-container → map-layers → spatial-viz` for layer
presentation, and `map-container → spatial-catalog` for resource/artifact
reads. Upstream `packages/` never imports this package; the plugin enters
through the loader like any other.
