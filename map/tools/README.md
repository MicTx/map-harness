---
description: "Let a map-analysis Agent edit, query, measure, and visually observe a session map through the map_* and geo_* tools."
kind: package-reference
---

# @map-harness/map-tools

English | [中文](README.zh.md)

## Summary

Choose this package when a session needs map editing and spatial analysis. `map_list_basemaps`, `map_set_basemap` and `map_set_imagery` select sources and imagery with revision checks. `map_edit_annotation` updates, deletes, styles, reorders, or undoes annotations and can apply or dismiss visual candidates as an agent; original authors remain unchanged. `data_export` publishes annotations as immutable GeoJSON. `map_observe` returns a revision-bound image to an image-capable model.

For historical imagery, `map_list_basemaps` accepts `source_id: 'esri-wayback'` and optional point/zoom local evidence; `map_set_basemap` requires its fixed `release_id`. `map_set_imagery` selects one such fixed release for the early-imagery layer without local or coverage capture, and `map_get_state` reports the three-layer display state. A publication date is not an acquisition date, and a missing acquisition date remains unknown. The host checks the selected release before applying it.

`map_markup` turns an image-capable model's reading of the latest `map_observe` attachment into bounded `sketch` or `target` proposals with WGS84 geometry. The Agent can apply that geometry with `map_draw` or `map_apply_patch`; user review remains available. Confidence is a non-probabilistic label.

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

The tool requires the accepted current call, an image-capable current Agent model and attachment storage.

#### What the model sees

The result appends a bounded JSON observation summary and the same saved image attachment as model image input. Its tool description is: `Observe this session's current map and return its image, observation id, sources, and positioning limits. Requires an open map and an image-capable current model. The image is evidence of the cited map revision, not a measurement; use geo_* or stats_* tools for numeric values.`

#### Token effect

The result includes a source summary, positioning status, limitation lines, and image pixels. Image-token cost depends on the captured dimensions and the active provider's image accounting.

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
