---
kind: upgrade-guide
description: "The map tab stops sending `[map-gesture v1]` view observations into the conversation; the viewport reaches the model as snapshot context instead."
---

# The map viewport becomes implicit model context

English | [中文](guide.zh.md)

## Change

Before, a user drag on the map-web map steered a running turn with a `[map-gesture v1]` user message, and the map tab had a "Send view observation" button that queued one. Now no gesture text enters the conversation and the button is gone. Every settled 2D camera posts to `POST /api/map/viewport`, and the next spatial-context snapshot carries a `用户视窗` line (center, zoom, visible extent, WKID, 2D/3D) and a `地图环境` line.

Two map-web defaults change with it. The spatial-context step budget has no default limit: the snapshot renders `steps N/不限`, and `budget.maxModelSteps` applies only where a composition sets it. The `spatial-accessibility` row loads only when `TIANDITU_API_KEY` is set; without it the `run_*` tools answer `SPATIAL_SERVICE_UNAVAILABLE` instead of the plugin failing at load.

This affects automation and tests that read `[map-gesture v1]` messages, click the removed button, or depend on the 64-step default. `MapOccurrence.submitGestureObservation()` still exists, but no map UI calls it.

## Migration

1. Read the user's viewport from the snapshot's `用户视窗` line, or from the host `mapViewport` service (`viewportOf(sessionId)`), instead of parsing `[map-gesture v1]` messages.
2. Drop UI automation that clicks `[data-gesture-submit-button]`; the camera reaches the model without it.
3. To keep a step limit, set it on the spatial-context row in your overlay:

   ```yaml
   - id: spatial-context-agent
     config:
       budget:
         maxModelSteps: 64
   ```

4. To run accessibility jobs without a Tianditu key, enable the row with the keyless provider: `- id: spatial-accessibility` with `disabled: false` and `config.provider: controlled-lattice`.
5. Confirm: start `node map/bin/map-harness.mjs web`, pan the map, send a message, and check that the model request contains `用户视窗:`.
