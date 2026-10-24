# @map-harness/map-container

English | [中文](README.zh.md)

The session's map: the authoritative `mapContainer` session projection and
its `ctx.map` read face on the host, and the ArcGIS map tab — canvas, layer
management panel, and workbench — in the browser. One map state, folded from
the session log; the model writes through `map_*` tools and the user writes
through the layer panel's change route.

## Host half

- The `mapContainer` projection folds accepted `map_*` tool results (the
  versioned `map-change` meta in `tool/result.meta`) into the durable layer
  list, view, AOI, operation ledger, and pending-call table. The fold is a
  pure synchronous function of the session log, so replay reconstructs the
  same map.
- `ctx.map` (the `MapContainerService`) reads that state for the tools; it has
  no write path.
- `POST /api/map/change` is the user write path. It admits one bounded change
  (`set-layer-state`, `reorder-layers`, `remove-layer`, `set-symbol-preset`)
  against the revision the browser saw and the same candidate validation model
  changes pass, then injects one `map-user-change` notice into the live
  agent's next-step inbox without waking the model. The fold applies the
  notice when its inbox insertion commits, so the response returns after the
  map changed; the later claim replays as the same operation id. Refusals use
  fixed codes: `invalid-change`, `unknown-session`, `stale-revision`,
  `layer-unknown`, `preset-unknown`, `oversized`.
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
- `LayerPanel` follows the Mapbox layer list: a Layers button at the map's
  top right opens a floating panel listing top-drawn layers first. Each row
  has a drag handle, a type swatch, the name (click to zoom), and a
  visibility eye; zoom and a "more" menu appear on hover or focus. The menu
  holds opacity, preset styles, grouping, move up/down, the attribute table
  (`featureIdOf` row ids, 8 rows per page, ≤12 columns), the exact-version
  download, export, and two-step removal. Groups fold and carry one eye for
  all members. Classified and heatmap layers show their legend under the row.
- Bulk actions sit under the header: show all and hide all submit one
  `set-layer-state` carrying only the layers that differ (a click that would
  change nothing spends no revision), and clear removes the listed layers one
  change at a time behind an inline confirmation, stopping at the first
  refusal and reporting how many went. A layer with no legend color of its
  own paints its type badge color instead; a layer that has a legend chip
  keeps that chip's color, so the badge never becomes a second color signal.
- Visibility, opacity, order, grouping, presets, and removal post to the
  change route and take effect at once; the model reads the notice in its
  next turn. Export still queues one `[map-panel v1]` text through
  `session.prompt` (`mapPanel` source label) because it produces a catalog
  artifact. The panel never pre-stages state: every control renders the wire.
- Feature drawing follows Mapbox defaults: markers wear a white halo, lines
  draw with round caps over a translucent white casing, legend-colored fills
  are translucent with a darker same-hue outline, and selection is a cyan
  ring with a wider stroke. Semantic symbols (`map-layers`) resolve under
  explicit blocks.
- `labeling.ts` places automatic labels in screen space whenever the 2D view
  settles: the symbol's `label.field`, else the first name-like property
  (`name`, `名称`, `title`, ...). Higher layers claim space first; points try
  top, right, bottom, then left; labels never overlap each other, any marker,
  or the view edge, and crowded labels drop. Labels draw as haloed text on a
  top overlay that exists only while labels do.
- Labels use 10.5px Microsoft YaHei in the layer's main color (symbol color,
  else legend color), darkened 20% for legibility.
- Hovering a feature opens `FeatureCard` at the map's top left: the topmost
  data feature (labels and casings are skipped) takes the highlight, and the
  card lists up to 24 fields as plain text (internal id hidden, overflow
  counted), titled by the label field. String attributes are truncated to
  256 characters before they reach a graphic. One hit test runs at a time
  (the latest pointer position wins); moving off every feature, leaving the
  view, the close button, or Escape closes the card. The ArcGIS popup is not
  used: it anchors below the narrow sidebar tab and leaves the viewport.
- A layer added after mount frames into view, unless the same revision also
  sets the view; mounting and replay never auto-frame.
- `MapOccurrence.captureView()` is the one public screenshot path: it races
  the SDK's `takeScreenshot({ format: 'png' })` against a 5-second deadline
  and resolves `{ dataUrl, viewport }`, where `viewport` is the same
  plain-number fix the gesture channel reports (`view-policy.ts`
  `viewportSnapshotOf`, `null` when the view cannot report one). A missing or
  destroyed view, a stalled SDK, and an SDK throw reject with a plain
  `CaptureError` object (`no-view` / `capture-timeout` / `capture-failed` with
  `detail`) rather than an `Error`. `view-policy.ts` also owns the zoom/scale
  inversion pair (`scaleFromZoom` / `zoomFromScale`, one anchor constant) and
  `boundsToZoom` for framing estimates.
- Every settled 2D camera posts to `POST /api/map/viewport` (`viewport.ts`
  keeps the latest per session, bounded to 256 sessions). The spatial-context
  snapshot renders it as the `用户视窗` line, so the model reasons over what
  the user sees without a chat message. `gesture.ts` still attributes camera
  changes (programmatic writes from `syncCamera` and focus `goTo` stay muted)
  for test metrics; no gesture text enters the conversation.

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
classification authority in `spatial-viz`.

Evidence: `tests/` (projection, protocol, occurrence rendering identities,
gesture and panel channels, user changes, derivation faces, artifact route) plus the
composition lane in `map/arcgis-mcp/tests/composition.e2e.mjs`. The
capability matrix lives in `map/docs/verification-matrix.md`; the binding
contract in `map/docs/map-container-binding.md`.

Dependency direction: `map-container → map-layers → spatial-viz` for layer
presentation, and `map-container → spatial-catalog` for resource/artifact
reads. Upstream `packages/` never imports this package; the plugin enters
through the loader like any other.

## Known Limitations and Deferred Work

- A user change applies when its notice enters the inbox. Cancelling the
  agent with inbox clearing before the next turn removes the notice, so the
  map keeps the change but the model is never told about it.
- The panel edits presets only; free symbol editing (colors, widths) still
  goes through the conversation.
