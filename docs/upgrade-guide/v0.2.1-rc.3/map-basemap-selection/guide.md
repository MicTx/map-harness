---
kind: upgrade-guide
description: "Map basemap selection and the three-layer imagery display add map-change meta v8, projection state v21, and three model tools."
---
# Map basemap and imagery display protocol

English | [中文](guide.zh.md)

## Change

Map sessions may now carry an explicit `BasemapSelection` as the base source plus an optional compatible label source, and an `ImageryDisplayState` for the three imagery resources: reference labels, recent imagery, and fixed early Wayback imagery. A successful `map_set_basemap` or `map_set_imagery` tool result writes `map-change` metadata version 8 with the `set-basemap` or `set-imagery-display` change. `mapContainer` projection state version 21 exposes `basemap` (`null` means the historical fixed World Imagery default) and `imageryDisplay` (reference labels on, recent imagery on at opacity 1, early imagery off by default). `map_get_state` reports both. Versions 1–7 map-change records remain readable; software that accepts only those versions rejects a version-8 record instead of applying it. Projection cache rows below state version 21 refold from the Session log.

The model surface adds read-only `map_list_basemaps`, revision-checked `map_set_basemap`, and revision-checked `map_set_imagery`. The imagery tool switches the three layers, sets recent-imagery opacity in `[0, 1]`, and selects or clears one fixed official Wayback release; it reads only the official release catalog and never captures local, coverage, or metadata evidence. The recent layer renders above the early layer, so its opacity tunes the two-period comparison. Custom MapServer, WMTS, and XYZ sources are deployment-configured through `Config.sources`; source endpoints and credential references stay on the host and do not enter Session logs.

## Migration

1. Update external map-change parsers to accept `schemaVersion: 8`, `set-basemap`, and the `set-imagery-display` discriminator. Keep the version 1–7 readers and do not synthesize an explicit selection or display state for logs that predate those fields.
2. Update projection consumers to read the required `basemap` and `imageryDisplay` fields; treat `null` basemap as the historical default and apply the documented imagery defaults when an older wire omits them. Discard projection-cache entries whose `stateVersion` is not 21 and refold from the Session log.
3. Add the three model tools to tool inventories when the map profile is mounted. For controlled sources, configure them under the map container's `sources` settings; do not put private endpoints or credentials in model input or persisted selections.
4. Verify by replaying a pre-v8 Session, toggling each imagery layer, setting recent opacity, selecting and clearing a fixed Wayback release, restarting the Loader, and checking that the display state, camera, business layers, and operation ledger survive while no local or metadata capture request occurs and the private endpoint does not appear in the Session log.
