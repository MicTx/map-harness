---
description: "Give a session one live map state that the model edits through map tools and the person edits through the ArcGIS layer panel, restored on reload and replay."
kind: package-reference
---

# @map-harness/map-container

English | [中文](README.zh.md)

## Summary

The session's live map: the model reads and changes one map state through the `map_*` tools, and the person pans, zooms, styles layers, and draws annotations in the ArcGIS tab. Both sides share one revisioned state folded from the session log, so a reload, replay, or session switch restores the same layers, camera, candidates, and annotations. The package also owns the observation and source routes; the map tools read the state through `ctx.map`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a composition whose Agent preset exposes the map tools and whose web client loads the map tab.

### When to choose it

Choose it for sessions that need one shared map state: the model writes through `map_*` tools and the person edits through the layer panel. Omit the map profile when a session should not expose or capture a map; without this package the tools have no map service to resolve.

### Minimal configuration

```yaml
- id: map-container
  name: '@map-harness/map-container'
```

| Field | Default | Meaning |
|---|---|---|
| `sources` | built-in presets | Deployment overrides for basemap presets, credential bindings, custom source descriptors, catalog limits, the outbound proxy, and the source-write lock. |
| `observation.capturePolicy` | `unverified` | Source-policy metadata recorded with an observation; it does not block capture. |
| `observation.maxBytes` | `8388608` | Maximum admitted PNG bytes. |
| `observation.maxPixels` | `16777216` | Maximum decoded pixels. |
| `observation.maxDimension` | `8192` | Maximum decoded width or height. |
| `observation.maxPending` / `maxEarlyClaims` | `64` / `64` | Pending observation waits and parked early claims, each capped at `1024`. |
| `observation.vision` | absent | Deployment-authorized `provider`/`model` route a text-only Session may delegate an observation to. |
| `interaction.maxActions` / `maxObservations` / `maxElapsedMs` | unlimited | Per-turn `map_use` attempts, `map_observe` attempts, and wall-clock limit. |
| `interaction.maxPending` / `maxEarlyClaims` | `16` / `16` | Pending interaction waits and parked early claims. |
| `wayback.cacheTtlMs` | `300000` | Catalog refresh interval, at most one day. |
| `wayback.localCacheMaxEntries` | `64` | Local-evidence cache entries, at most `256`. |
| `wayback.maxConcurrentRequests` / `requestTimeoutMs` | `4` / `15000` | Concurrent catalog requests and per-request timeout (at most `120000`). |

An absent config takes every default; a nonsensical value fails the plugin at load instead of clamping. The accepted schema is owned by [`src/plugin.ts`](src/plugin.ts), and the shipped mount row is in [`map/profiles/map-web/cordis.patch.yml`](../profiles/map-web/cordis.patch.yml).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Host half

Continuous `map_use` control lives in `mapContainer.interaction`. Per-turn `interaction.maxActions`, `maxObservations` and `maxElapsedMs` are optional and unlimited by default. Recoverable failures leave the turn open; user takeover and accepted `finish` stop it. `/api/map/use` pairs bounded claim/result/cancel messages with the session; replay restores state without repeating SDK actions. See [continuous map use](../docs/map-container-binding.md#连续地图操作map_use).

For model/MCP and legacy catalog reads, the host loads its last validated Wayback catalog from `$DSH_HOME/cache/map/wayback-catalog.sqlite` and refreshes it at startup and after each `wayback.cacheTtlMs` interval. Only a complete batch replaces it; a failure is logged and leaves the last usable catalog intact. `GET /api/map/wayback?operation=catalog` reads only that snapshot and does not trigger a fetch. The browser picker does not use that route. `POST /api/map/wayback/admit` verifies one selected release against a known catalog entry or official ArcGIS item and WMTS evidence, and retains independently verified identities separately from the catalog. Session writes still check deployment policy and the expected revision. Rendering loads fixed-version WMTS tiles by viewport, with no latest-release fallback.

Point queries still use the bounded official service. Local candidates collapse identical decoded 256×256 image pixels, keeping the earliest image and the newest release of each other distinct image; this detects exact decoded equality, not perceptual similarity. Malformed tilemap evidence fails rather than reporting no change. Acquisition dates come from point metadata, not release dates; center and four-corner samples describe only those points. Missing, unknown, or failed metadata remains distinct. `Config.wayback` also sets local-cache entries, request concurrency, and request timeout.

The `visualProposals` projection field holds model sketch and target candidates with their saved observation, call/model identity, pixel geometry and WGS84 result. User confirmation, edit-then-confirm and rejection settle through user-change CAS. Agent application or dismissal uses a paired `map-agent-annotation` result, distinct candidate states, agent-authored features, and reversible revision-checked history. Each fold rebuilds candidate and annotation state; replay does not call the model or recapture the map. Browser-side attachment references use type-only imports so the Vite client does not load the attachment package's Node runtime.

`observationHistory` has bounded saved observations; `comparisons` records a versioned pair of their ids, image digests, fixed releases, common view and limitations. `visualChanges` holds two-image candidates bound to one comparison and the same affine. Comparison creation and candidate decisions fold from the accepted tool results without a new capture or model request; replay reconstructs both saved images and decisions from the session log.

- The `mapContainer` projection folds accepted `map_*` tool results (the
  versioned `map-change` meta in `tool/result.meta`) into the durable layer
  list, view, AOI, operation ledger, and pending-call table. The fold is a
  pure synchronous function of the session log, so replay reconstructs the
  same map.
- `ctx.map` (the `MapContainerService`) reads that state for the tools; it has
  no write path.
- `POST /api/map/change` is the user write path. It admits one bounded change
  (`set-layer-state`, `reorder-layers`, `remove-layer`, `set-symbol-preset`,
  `set-basemap`, `set-imagery-display`, `set-view`, and the annotation-only `annotation-create`,
  `annotation-update`, `annotation-delete`, and `annotation-undo`)
  against the revision the browser saw and the same candidate validation model
  changes pass, then injects one `map-user-change` notice into the live
  agent's next-step inbox without waking the model. The fold applies the
  notice when its inbox insertion commits, so the response returns after the
  map changed; the later claim replays as the same operation id. Annotation
  records use the `[map-user-change v3]` marker; ordinary layer, basemap, and
  state changes use `[map-user-change v2]`; imagery-display records use
  the `[map-user-change v7 imagery]` marker; settled-camera view records use
  the `[map-user-change v8 view]` marker. The remaining proposal and
  visual-change markers are listed under Model Experience; v1 notices remain
  readable but cannot carry annotation fields. The host derives annotation feature ids,
  timestamps, whitelisted properties, inverse snapshots, and summaries, and a
  retried applied operation id returns the accepted revision without another
  notice. Updates carry the feature's accepted update timestamp as a
  feature-level CAS token, and an ambiguous browser retry reuses its id only
  for the same complete payload at the same revision. Refusals use fixed codes: `invalid-change`, `unknown-session`,
  `stale-revision`, `layer-unknown`, `preset-unknown`, `oversized`,
  `annotation-limit`, `geometry-invalid`, `annotation-unknown`, and
  `annotation-protected`.
- A `set-wayback-comparison` notice records two distinct official local releases and their focus point without changing the displayed basemap. The host checks the live viewport and local evidence before and after preparing both sources. The `[map-user-change v4]` marker carries this operation; the projection replays its saved descriptors without external requests. Current-schema records that omit optional fields are normalized before identity checks; changed source facts still fail with `SOURCE_CHANGED`, and fixed Wayback releases retain their release-specific identity rather than falling back to the catalog placeholder.
- The visual-observation service pairs one `map_observe` wait with one
  client capture through a claim-then-capture handshake: the accepted
  tool/call seeds `observationRequest`, the client `claim`s it for an opaque
  token, captures only after rendering that exact revision, and `submit`s
  token + receipt; the host checks the shared strict receipt schema, current
  request/revision/source identities, canonical base64, and one bounded PNG
  decode before accepting. `POST /api/map/observation` is the single action
  route for `claim`, `capture`, `decline`, and token-authenticated `cancel`;
  pure-Node hosts use the same service. Early claims park only until their
  deadline. Invalid or wrong-token submissions preserve the live wait; a
  valid capture, decline, cancellation, timeout, or disposal releases it.
  After saving, the tool reads the reference back and compares the stored
  bytes, sha256, PNG type, length, and dimensions with the admitted capture;
  normalization or storage drift refuses the record. Accepted records fold via `map-observation` meta v1 into
  `latestObservation`; legacy results clear the request without evidence.
- `Config.observation` resolves source-policy metadata and resource limits at provider load. `capturePolicy` and source permissions do not block capture; unavailable sources and invalid capture identities still refuse. Hidden and zero-opacity layers are excluded from evidence. `MAX_OBSERVATION_BYTES` names the default byte limit; `maxBytes` may override it. Defaults are 8,388,608 bytes, 16,777,216 pixels, 8,192 pixels per dimension, and 64 pending waits/early claims; pending counts may be configured only through 1,024. Optional `vision` (`provider`/`model`) names the vision route a text-only Session may delegate to: only when the Session's subagent model-selection policy authorizes that route and the model is verified for image input does `map_observe` read through a vision child, raising the observation record to version 4. Source licences are readable facts: `osm-standard` defaults `automatedMapUse` to `unverified`, a deployment may declare `allowed` explicitly, and no OSM-specific hard prohibition remains.
- `Config.sources` validates deployment presets, named credential bindings,
  custom source descriptors, catalog limits, and the source-write lock at
  host activation. Public catalog records omit endpoints and credential
  references; catalog validation performs no source requests. A deployment
  may set `sources.proxy.outboundProxy = { urlEnv, targetResolution }` to
  route source requests through one explicit proxy: `urlEnv` names the
  environment variable holding the proxy URL (it must use the `DSH_`
  namespace so model subprocess environments scrub it), and
  `targetResolution` chooses
  whether CONNECT targets the verified literal address (`local`) or the
  original hostname (`proxy`). In `proxy` mode hostname resolution is
  delegated to that proxy, so the deployment must enforce the same
  private/metadata/multicast egress denials there; use `local` when it cannot.
  Without this setting the transport stays
  direct and ambient proxy variables stay inert. Proxy credentials remain in
  host memory and never enter configuration output, errors, logs, Sessions,
  or public descriptors.
- Session-bound source routes expose only deployment-owned facts:
  `/api/map/sources/catalog` returns the bounded public page,
  `/api/map/sources/render` returns the exact carrier recipe for the accepted
  projection state, and `/api/map/sources/resource` admits only closed
  metadata/tile/export operations after strict identity, epoch, provider,
  size, media, DNS, and redirect checks. Controlled responses use bounded
  reads and explicit cache policy; failures carry stable source codes and no
  private upstream detail. Service reload deregisters all three paths before
  awaiting disposal, allowing their immediate registration by the new service.
- `GET /api/map/artifact` streams one exact catalog version's bytes to the
  session's browser: the parameter set is exactly `session` + `ref`
  (`res-…@vN` / `art-…@vN`), the read goes through
  `SpatialCatalogService.forSession(session)` (session isolation,
  authorization, and whole-content digest verification), and every failure
  answers with one fixed code — `unknown-session`, `unknown-ref`,
  `unauthorized`, `digest-mismatch` — and no storage detail.

### Browser half

The map's stop control remains visible at 390px and follows both themes. Pointer, wheel, drawing and keyboard takeover invalidate local pending actions immediately; the host notice persists that stop across refreshes. An accepted camera target is not proof of a rendered view: suppressed pending camera writes report `CAMERA_SUPERSEDED`, while already accepted logical revisions remain in history. Pixel pan/zoom preserve the captured SDK scale and rotation; SDK LOD zoom is not the application's scale-based zoom.

- `MapTabBody` mounts the ArcGIS view for one tab and hosts a floating panel with Basemaps, Layers, and Annotations tabs; Layers is selected initially. Each tab contains a semantic table and retains its search, scroll, and operation state across tab changes and collapse. Drag the header or resize any edge or corner; position and size last only for the open map and are constrained when its available area changes. Narrow maps start collapsed and reserve the navigation column. The panel and bottom controls clear the measured SDK attribution footer, and the hover `FeatureCard` avoids the panel.
- Source-read failures leave business layers visible, expose a localized retry
  action, and use bounded exponential backoff instead of hot retrying; the
  recorded camera is reapplied after ArcGIS initialization. Every map tab uses
  the same resident panel card (narrow tabs keep the floating title-bar form),
  and coarse pointers get 44px controls with 16px inputs. Public Esri tile carriers pin
  `tileServers` to the single preset host, and persistent tile failures feed
  the same source-failure retry bar as descriptor failures.
- `LayerPanel` follows the Mapbox layer list: the Layers tab lists
  top-drawn layers first. Pending candidates sit in a scrollable Pending review
  region at the top of the list and expose preview, confirm, cancel, and a
  "more" dialog; confirming writes to the map and previewing locates the
  candidate feature. Ordinary layers keep a flat searchable list with no group
  headings. Each row is a drag handle, a type/style preview, the name with its
  visible/hidden state, the visibility switch, zoom, and "more". Names are
  plain text and the legend chip sits under the name inside the row; "more"
  opens one operation dialog holding opacity, preset styles, the single-symbol
  color editor, move up/down, the attribute table (`featureIdOf` row ids, 8
  rows per page, ≤12 columns), the exact-version download, export, and
  two-step removal.
  The annotation and basemap tabs share that design language: the
  same toolbar, conditional search (shown above four entries), scrollable list,
  row anatomy (type swatch, name with state, visibility eye, hover actions),
  and operation dialogs; annotation editing and imagery source selection
  happen inside the dialogs, with no inline editor or nested sub-tabs.
- `MapboxControls` mounts the official Mapbox GL JS v3 control set on the map instance: one `mapboxgl-ctrl-group` at the top right holds zoom in, zoom out, and the north-resetting compass, a second holds fullscreen, the bottom left carries a 100px scale bar, and the bottom right the compact attribution. `MAPBOX_CTRL_GEOMETRY` and `MAPBOX_CTRL_ICONS` in `map-theme.ts` transcribe the vendor stylesheet (`32px` buttons, `4px` radius, `0 0 0 2px rgba(0,0,0,.1)` ring, `#ddd` separators, `#eee` hover, `#0096ff` focus, verbatim SVG data URIs); `installMapTheme` appends `MAPBOX_CTRL_CSS` after the host theme so the vendor values win the cascade. Camera writes go through `MapOccurrence.zoomBy`, `resetBearing`, and `mapControlState`, which read the live view and never stage Session state. Layer rows use shared DSH controls and host theme colors.
- Bulk actions sit under the header: show all and hide all submit one
  `set-layer-state` carrying only the layers that differ (a click that would
  change nothing spends no revision) and show the affected layer count. Clear
  layers lives in the bulk "more" menu, shows the affected count, and removes
  the listed layers one change at a time behind an inline confirmation,
  stopping at the first refusal and reporting how many went. Layer and annotation swatches use the map's effective colors, including symbol and layer opacity and per-feature overrides. Multiple colors appear as segments; the layer dialog lists the complete legend. Imagery rows identify their type, and full truncated names remain available in operation dialogs.
- The Basemaps tab owns source selection as a flat three-row table:
  reference labels, recent imagery, and early imagery each occupy one row whose
  eye submits a `set-imagery-display` visibility change (the early eye stays
  disabled until a release is chosen) and whose name carries the current source
  and opacity summary. "More" opens the same operation dialog as a layer row:
  the labels row holds the compatible label select, the recent row holds the
  base select and the opacity slider, and the early row lists the browser's Wayback catalog and submits one fixed `set-imagery-display` selection. When Wayback is enabled, the browser fetches the public catalog directly in the background without credentials, keeps the last validated list across reloads, and offers retry in the picker if no list is available. Loading the catalog never changes the selection or queries local evidence. All three dialogs honor deployment write locks and clear an incompatible label instead of falling back silently. Selecting or reopening early imagery changes visible recent imagery from 100% to 50% opacity in the same reversible write; hidden or already adjusted recent imagery stays unchanged.
- The annotation group creates point, polyline, polygon, and rectangle
  features with `SketchViewModel`; finished geometry is projected to WGS84 and
  validated before one accepted revision. Drafts live only in the occurrence's
  temporary graphics layer, while accepted features live in the protected
  `user-annotations` layer with host-derived ids. Annotation rows mirror layer
  rows: a geometry swatch, the name with its type, and hover locate and "more"
  actions; clicking a row opens the operation dialog for name/description
  editing, style presets, geometry editing, and two-step deletion, while
  compensating undo and GeoJSON export stay in the toolbar's "more" menu.
  Edits operate on accepted state only. Projection and submission failures
  render an inline alert and never report a refused submission as success.
- Visibility, opacity, order, preset and single-symbol color changes, and
  removal post to the change route and take effect at once; the model reads the notice in its
  next turn. Export still queues one `[map-panel v1]` text through
  `session.prompt` (`mapPanel` source label) because it produces a catalog
  artifact. The panel never pre-stages state: every control renders the wire.
- Feature drawing follows Mapbox defaults: markers wear a white halo, lines
  draw with round caps over a translucent white casing, legend-colored fills
  are translucent with a darker same-hue outline, and selection is a cyan
  ring with a wider stroke. Semantic symbols (`map-layers`) resolve under
  explicit blocks. Classification colors ignore opacity inferred from a layer
  name, while declared symbols and per-feature overrides keep their opacity.
- `labeling.ts` places automatic labels in screen space whenever the 2D view
  settles: the symbol's `label.field`, else the first name-like property
  (`name`, `名称`, `title`, ...). Higher layers claim space first; points try
  top, right, bottom, then left; labels never overlap each other, any marker,
  or the view edge, and crowded labels drop. Every dropped candidate joins one
  screen-grid `+N` cluster badge, so placed names plus badge counts always
  cover every candidate; zooming in places more names, and clicking a badge
  frames the cluster's bbox. Labels and badges draw on the top overlay that
  exists only while labels do; badges are its only pointer-reachable content
  and suspend with the camera like the labels.
- Labels use 10.5px Microsoft YaHei with a shared white halo style consumed
  by both the DOM overlay and PNG compositor. Symbol colors are
  scaled to 55% per RGB channel for the label ink; layers without a symbol
  use neutral dark gray.
- Hovering a feature opens `FeatureCard` around the projected geometry of the
  topmost data feature (labels and casings are skipped), which takes the
  highlight. The card lists up to 24 fields as plain text (internal id hidden,
  overflow counted), titled by the label field. String attributes are
  truncated to 256 characters before they reach a graphic. Placement tries
  the feature's right, left, bottom, and top sides with centered and
  edge-aligned candidates, keeps the map margin, and avoids visible floating
  map DOM including the resident panel, title bars, workbench, status/error
  notices, attribution, and SDK UI. A constrained card shrinks to available
  space and scrolls; a physically impossible fit stays inside the map with
  minimum overlap. Camera settlement and size changes reanchor the open card;
  dismissal stays closed until the next hover. One hit test runs at a time
  (the latest pointer position wins); moving off every feature or leaving the
  view also closes the card. The ArcGIS popup is not used: it anchors below
  the narrow sidebar tab and leaves the viewport.
- After mount, a new layer outside the visible extent frames into view unless it is the user annotation layer, its revision changes the camera, or an explicit camera write is pending. Annotation edits and undo preserve the camera; the annotation's Locate action frames it explicitly. Mount and replay never auto-frame. Camera writes queue per concrete view, and its render receipt waits for the queued write to settle.
- `MapOccurrence.captureView()` and the observation claim both use the typed
  `captureViewOf(MapView | SceneView)` adapter and one capture transaction
  (`observation-capture.ts`). Screenshot dimensions come from the installed
  SDK's `Screenshot.data.width/height`; the transaction freezes the
  generation/view/revision/camera/gesture/layout/source identity, observes
  one abort signal and absolute deadline, and rechecks fresh state after each
  asynchronous stage. If ArcGIS `updating` changes during observation capture,
  the client waits for two stable frames and retries within that deadline;
  camera, source, layout, revision, or render-health changes still refuse.
  It composites labels and wraps full source attribution
  into theme-token-colored footer rows, then derives affine georeference
  coefficients from actual `toMap` samples and validates four independent
  points (`capture-math.ts`). Unreadable cameras produce
  `georeference.kind: 'none'` with reason `unreadable-camera`, and
  world-wrap/scene/invalid views produce no georeference. `captureView()`
  still resolves `{ dataUrl, viewport }`; a missing or destroyed view, a
  stalled SDK, and an SDK throw reject with a plain `CaptureError` object
  (`no-view` / `capture-timeout` / `capture-failed` with `detail`) rather
  than an `Error`. `view-policy.ts` also owns the zoom/scale
  inversion pair (`scaleFromZoom` / `zoomFromScale`, one anchor constant) and
  `boundsToZoom` for framing estimates.
- Every settled 2D camera posts to `POST /api/map/viewport` (`viewport.ts`
  keeps the latest per session, bounded to 256 sessions). A camera that settles
  after a user gesture and differs from the accepted `mapContainer.view` also
  writes one `set-view` user change, so reopening or switching sessions restores the
  final camera and the final layer state. The spatial-context
  snapshot renders it as the `用户视窗` line, so the model reasons over what
  the user sees without a chat message. `gesture.ts` still attributes camera
  changes (programmatic writes from `syncCamera` and focus `goTo` stay muted)
  for test metrics; no gesture text enters the conversation. The canvas keeps
  ArcGIS's emptied UI and overlay surfaces pointer-transparent, so unobstructed
  drag and wheel reach the view surface; the composition lane asserts the live
  camera moves and the newest report matches it.

### Conversation tool cards

- `src/tool-cards/` is the one display dictionary for every spatial tool: a Chinese action phrase, an icon category, and the argument and result fields a card lists, with unit-aware formatters (meters/kilometers, m²/km², WGS84 degrees, counts). Geometry arrays and large JSON never reach a card; malformed or streaming arguments degrade to the action name.
- The browser registers one keyed `tool.call.toolview` row (`MapToolCard`) per dictionary entry. The row derives its title (`action · subject`), argument and result lines, and failure code from the durable call slice alone, so live streaming and replay render the same; tools outside the dictionary keep the generic row.
- `@map-harness/map-tools` wraps every registered spatial tool with `withPresentation`, reusing the same entries for the Host `presentCall`/`presentResult` cards (ACP and CLI surfaces). The model-facing `output.render` text is unchanged.
- Adding or renaming a spatial tool requires a dictionary entry in the same change. `map-tools` re-types the dictionary as `Record<SpatialToolName, …>` so a missing entry fails `tsc`, `withPresentation` refuses an unlisted tool at registration, and `tools/tests/presentation.spec.mjs` asserts the dictionary keys equal the catalog.
- The map tab overlays and the tool rows share `map-theme.ts`, a stylesheet over the host `--dsw-*` design tokens, so they follow the host light and dark themes.

### Versions and evidence

`SymbolStyle` and `FeatureOverrides` version tokens (`sym-…@v1`,
`ovr-…@v1`) derive from a digest over every field, so a record cannot be
edited without a new version; `StyleSpec`/`LegendSpec` remain the
classification authority in `spatial-viz`.

Evidence: `tests/` (projection, protocol, occurrence rendering identities,
gesture and panel channels, user changes, annotation state/drawing/UI,
derivation faces, artifact route) plus the
composition lanes in `map/arcgis-mcp/tests/composition.e2e.mjs`. The
capability matrix lives in `map/docs/verification-matrix.md`; the binding
contract in `map/docs/map-container-binding.md`.

Dependency direction: `map-container → map-layers → spatial-viz` for layer
presentation, and `map-container → spatial-catalog` for resource/artifact
reads. Upstream `packages/` never imports this package; the plugin enters
through the loader like any other.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Map-container binding contract](../docs/map-container-binding.md) — host/browser binding, continuous map use, and source routes.
- [Verification matrix](../docs/verification-matrix.md) — package checks and composition evidence.
- [Map-layers contract](../layers/README.md) — presentation vocabulary this package folds and renders.
- [Map tools](../tools/README.md) — the model-facing tools that read this state.
- [Observation capture upgrade guide](../../docs/upgrade-guide/v0.2.1-rc.3/map-observation-capture/guide.md) — the observation record change.

<a id="model-experience"></a>
## Model Experience

### User map-change notice

#### Request context and condition

The browser change route admits one bounded change and injects one `map-user-change` notice into the live Agent's next-step inbox without waking the model. The notice reaches the model only when the next turn claims the inbox; cancelling the Agent with inbox clearing before that turn removes the notice while the map keeps the change. The summary line is in the user's locale; `userChangeNoticeText` appends the marker and the record JSON.

#### What the model sees

The exact text is the summary line, then the marker, then the record JSON on its own line. The marker identifies the record vocabulary: `[map-user-change v2]` for ordinary layer, basemap, and state changes; `[map-user-change v3]` for annotation operations; `[map-user-change v4]` for a prepared Wayback comparison; `[map-user-change v5]` for visual-proposal decisions; `[map-user-change v6 visual-change]` for visual-change decisions; `[map-user-change v7 imagery]` for imagery display; `[map-user-change v8 view]` for a settled camera. `[map-user-change v1]` remains readable but cannot carry annotation fields. The record carries the operation id, the target revision, and the admitted change.

#### Token effect

One notice adds the summary line, the marker, and a bounded record of at most 16 KiB to the inbox message the next turn reads; it replaces no earlier tokens.

#### KV Cache effect

A notice is appended when the inbox claims it, after the request tokens already in the Session, so it does not rewrite earlier tokens. Clearing the inbox before that claim removes the notice instead of appending it.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- A user change applies when its notice enters the inbox. Cancelling the
  agent with inbox clearing before the next turn removes the notice, so the
  map keeps the change but the model is never told about it.
- The panel edits presets and single-symbol colors; other free symbol
  properties (widths, dashes) still go through the conversation.
- Annotation geometry accepts Point, LineString, and single-ring Polygon;
  GeoJSON Multi* and polygon holes are not editable in this version.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Keep the projection fold a pure synchronous function of the session log; every new accepted `map_*` result needs its meta kind, fold branch, and replay assertion in `tests/` (`tests/projection.spec.mjs`). Tool-card copy lives in `src/tool-cards/` and must gain an entry with every spatial tool.

</details>
