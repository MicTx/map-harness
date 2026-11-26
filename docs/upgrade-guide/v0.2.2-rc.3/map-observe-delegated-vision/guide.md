---
kind: upgrade-guide
description: "map_observe gains an optional focus and may read the map through an authorized vision child for text-only Sessions; the observation record adds version 4 and OSM becomes grantable. No existing record or configuration stops working."
---

# map_observe delegates to a vision child for text-only Sessions

English | [中文](guide.zh.md)

## Change

`map_observe` used to refuse with `VISION_UNAVAILABLE` whenever the Session's current model was not verified for image input. It now resolves the optional `observation.vision` route (`provider`/`model`) instead: when the Session's subagent model-selection policy authorizes that route and the model is verified for image input, a vision child session reads the captured image, and the tool returns the child's structured analysis (`summary`, `observations`, `limitations`) as text. Pixels are never handed to a text-only model. The durable observation record gains schema version 4, which alone carries `visualAnalysis` (`provider`, `model`, `childSessionId`); versions 1–3 remain readable and are written exactly as before for direct reads.

Two smaller facts ship with it. `map_observe` accepts an optional `focus` (1–512 characters) as the visual question; omitting it falls back to the Session goal. `osm-standard` now reports `automatedMapUse: unverified` by default and accepts an explicit deployment grant of `allowed`; the OSM-specific hard prohibitions are gone. Source licences remain readable facts and do not gate capture or map use.

## Migration

1. Sessions whose current model accepts images need nothing: observations stay on version 3 and the image still reaches the model.
2. To let text-only Sessions observe, set `observation.vision` in the `map-container` plugin config and authorize the same `provider`/`model` through the subagent model-selection policy for that Session. Without either, `map_observe` still refuses with `VISION_UNAVAILABLE`, now before any capture.
3. Readers of `tool/result.meta` that switch on `schemaVersion` must accept `4`: a version 4 record always has `visualAnalysis`, and a record with `visualAnalysis` is always version 4. Readers that only compare `observationId`/`mapRevision` are unaffected.
4. `map_markup`/`map_mark_changes` proposals built on a version 4 observation must name the reading child's `provider`/`model`, or they are refused with `visual-proposal-pairing`.
5. Deployments that relied on OSM being unconditionally denied for automated use should declare `automatedMapUse: denied` on `osm-standard` if they want that fact recorded; nothing is granted automatically.
6. Pass `focus` only when you want a specific visual question answered; the previous behaviour is preserved when it is omitted.
