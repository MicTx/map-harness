---
description: "Let a map-analysis Agent edit, query, measure, and visually observe a session map through the map_* and geo_* tools."
kind: package-reference
---

# @map-harness/map-tools

English | [中文](README.zh.md)

## Summary

Choose this package when a session needs map editing and spatial analysis. `map_list_basemaps`, `map_set_basemap` and `map_set_imagery` select sources and imagery with revision checks. `map_edit_annotation` updates, deletes, styles, reorders, or undoes annotations and can apply or dismiss visual candidates as an agent; original authors remain unchanged. `data_export` publishes annotations as immutable GeoJSON. `map_observe` returns a revision-bound image to an image-capable model.

For historical imagery, `map_list_basemaps` accepts `source_id: 'esri-wayback'` and optional point/zoom local evidence; `map_set_basemap` requires its fixed `release_id`. `map_set_imagery` selects a fixed early release without enabling it or capturing local evidence. When `early_visible: true` omits both recent settings, visible recent imagery at 100% opacity changes to 50%; explicit recent settings, hidden imagery, and adjusted opacity remain unchanged. `map_get_state` reports the display state. A publication date is not an acquisition date, and a missing acquisition date remains unknown. The host checks the selected release before applying it.

`map_markup` turns an image-capable model's reading of the latest `map_observe` attachment into bounded `sketch` or `target` proposals with WGS84 geometry. The Agent can apply that geometry with `map_draw` or `map_apply_patch`; user review remains available. Confidence is a non-probabilistic label.

`map_refine_aoi` replaces a pixel-rectangle AOI candidate with real building footprints: it takes `candidate_id` (an existing candidate layer's bbox) or an explicit `bbox` (at most 0.05° per side) as the window, asks the configured footprint source (OSM Overpass by default; a deployment overrides endpoint, timeout, retries and licence through spatial-connect's `footprints`) for buildings, ranks every footprint by whether it contains the candidate's centre and by its overlap with the window, and returns **all** of them — nothing merged, no boundary claimed. The result is one real-Polygon layer (an `add-layer` candidate) whose features carry `source`/`licence`/`attribution`/`selection` (rank and relation) and `refines` (the replaced candidate id); the original rectangle is kept untouched and reported as `superseded`. An unreachable source, an empty answer and a 4xx surface as `REFINE_SOURCE_UNAVAILABLE` / `REFINE_NO_FOOTPRINTS` / `REFINE_SOURCE_INVALID`, and in all three the candidate is left exactly as it was — an empty answer is **not** a fallback to the rectangle. Confirmation stays with the person.

For two fixed releases, `map_compare_views` checks saved image bytes, release dates, common camera/CRS/affine/rect/size and overlay composition before returning both images. `map_mark_changes` returns bounded WGS84 candidates. Publication dates are not acquisition or change dates; the tools report no area, precision or recall.

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

Mount the plugin in a composition when the selected Agent preset should receive the map tool catalog.

### When to choose it

Choose it for sessions that need map editing, visual observation, or numeric geo_* analysis; a session without a map should omit the map profile instead of registering tools whose host services are absent.

### Minimal configuration

The plugin has no package-level configuration. The map host owns the source catalog, source-write lock, and observation bounds.

```yaml
- id: map-tools
  name: '@map-harness/map-tools'
```

Source-policy classifications are retained as metadata and do not block observation; see the [map-container README](../map-container/README.md) and [observation upgrade guide](../../docs/upgrade-guide/v0.2.1-rc.3/map-observation-capture/guide.md).

`map_use` accepts one `pan`, `zoom`, `click`, or `finish`. Each pixel action consumes the latest `observation_id`; observe again before another action. Pan/zoom results report `source_revision` and the proposed `candidate_revision`, not an accepted or rendered version. Call `map_observe` without `expected_revision` after a camera action to inspect the latest accepted state. Clicks return bounded SDK hits with host-derived attributes or an empty hit list. Per-turn limits are optional and unlimited by default. A recoverable refusal permits another observation; an explicit user takeover or `finish` stops the turn.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

`src/a-index.ts` registers the direct Native definitions and their pure host presenters. The optional MCP consumer adapts the same tool definitions in `src/mcp-tools.ts`; for `map_observe`, it renders the canonical structured result through the native image renderer so the already-saved attachment remains model-visible. Basemap tools resolve catalog ids, role compatibility, mode/projection support, and revision stability through the map host before proposing a `set-basemap` change; model input never carries a source URL or credential. `map_edit_annotation` uses paired agent-owned results for annotation edits, layer styling and ordering, and visual-candidate decisions; accepted candidates carry agent authorship rather than user confirmation. Annotation GeoJSON export freezes the accepted map revision. Before publishing metadata, the observation tool reads the saved image back and requires its bytes to match the admitted PNG exactly. Map state, source transport, observation capture, projection metadata, and tool-card copy belong to [map-container](../map-container/README.md); MCP transport and registration belong to [arcgis-mcp](../docs/arcgis-mcp.md).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Map-container contract](../map-container/README.md) — projection, client capture, and tool-card ownership.
- [ArcGIS MCP provider](../docs/arcgis-mcp.md) — internal MCP transport and execution binding.
- [Verification matrix](../docs/verification-matrix.md) — map package checks and composition evidence.

-----

<a id="model-experience"></a>
## Model Experience

### map_observe result

#### Request context and condition

The tool requires the accepted current call and attachment storage. When the current Agent model accepts images it delivers the screenshot directly; otherwise a vision child session reads the image — authorized by the deployment configuration (`observation.vision` `provider`/`model`) and by the Session's subagent model-selection policy — and the child's input and output are retained in its own Session. The host revalidates the admitted source descriptors through attachment storage and readback; source drift prevents publication of the observation.

#### What the model sees

The result appends a bounded JSON observation summary. A direct read hands the same saved image attachment to the model as image input; a delegated read appends the child's structured analysis (`summary`/`observations`/`limitations`) instead and **never** hands pixels to a text-only model — the observation record becomes version 4 and carries the reading child's identity. Its tool description is: `Observe this session's current map and return its image, observation id, sources, and positioning limits. Requires an open map and an image-capable current model. The image is evidence of the cited map revision, not a measurement; use geo_* or stats_* tools for numeric values.`

#### Token effect

A direct read includes a source summary, positioning status, limitation lines, and image pixels, with image-token cost depending on the captured dimensions and the active provider's image accounting; a delegated read carries only the text analysis, and the pixel cost falls on the vision child.

#### KV Cache effect

Each observation appends a new tool result and image to Session history; it does not rewrite an earlier prefix. A later model request may include prior observation images again, with cache behavior owned by the provider.

## Known Limitations and Deferred Work

- Unavailable sources, missing credentials, stale views and models without image input still refuse the relevant operation.
- An image with no valid affine georeference is read-only evidence; use geo_* or stats_* tools for measurements.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No separate tool catalog is maintained here. Keep the owning definition and presenter in `src/a-index.ts`, `src/observation-tools.ts`, and `src/presentation/`; update the corresponding map-container presentation entry with a model-visible tool change.

</details>
