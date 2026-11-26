---
kind: upgrade-guide
description: "map_refine_aoi replaces rectangle AOI candidates with real OSM building footprints; spatial-connect gains a keyless footprints source that a deployment may override. Existing tools, records and configurations keep working."
---

# map_refine_aoi refines AOI candidates with building footprints

English | [中文](guide.zh.md)

## Change

A new `map-mutation` tool, `map_refine_aoi`, replaces a pixel-rectangle AOI candidate with real building footprints. It takes the `candidate_id` of an existing candidate layer or an explicit WGS84 `bbox` of at most 0.05° per side, asks the configured footprint source for buildings in that window, ranks every closed footprint by whether it contains the candidate's centre and by how much of it overlaps the window, and returns all of them — nothing is merged and no boundary is claimed. The result is one layer of real polygons (a versioned `add-layer` change) whose features carry `source`, `licence`, `attribution`, `selection` and a `refines` link to the replaced candidate; the original rectangle is kept untouched and reported as `superseded`. An unreachable source, an empty answer and a 4xx surface as `REFINE_SOURCE_UNAVAILABLE`, `REFINE_NO_FOOTPRINTS` and `REFINE_SOURCE_INVALID`, and in every case the candidate is left exactly as it was — an empty answer is never a fallback to the rectangle.

The source is `spatial-connect`'s new `spatialFootprints` service: a keyless OSM Overpass provider by default (`https://overpass-api.de/api/interpreter`, ODbL 1.0, attribution © OpenStreetMap contributors), with a hard per-call timeout, bounded retries on 429/5xx only, a response byte cap and a bounded query window. Multipolygon relations are not rebuilt; only closed ways with a building tag are returned, and the result says so in its limitations. Confirmation of the refined candidate stays with the person.

## Migration

1. Sessions that never refine a candidate need nothing: no existing tool, record or configuration changes.
2. The public Overpass default is slow and sometimes unavailable from restricted networks. Declare a reachable mirror or a private footprint service in the `spatial-connect` plugin config — `footprints: { baseUrl, timeoutMs, maxRetries, licence, attribution }` — or set `footprints: null` to disable the source; the tool then refuses with `REFINE_SOURCE_UNAVAILABLE` and leaves the candidate unchanged.
3. Readers of `tool/result.meta` see the new tool's `add-layer` change under the existing `map-change` kind; no new meta kind or schema version is introduced.
4. Visual-proposal records may now carry an optional `supersededBy` property naming the refined layer. It is a property, not a status: the five `VisualProposalStatus` values are unchanged, historical records without it stay valid, and readers that switch on `status` are unaffected.
5. Readers that enumerate the fixed spatial tool catalog must accept `map_refine_aoi`; the arcgis-mcp catalog, the direct handlers and the tool directory document already list it.
6. Refined footprints are ODbL-licensed data: keep the `attribution` the tool reports when the layer is shown or exported.
