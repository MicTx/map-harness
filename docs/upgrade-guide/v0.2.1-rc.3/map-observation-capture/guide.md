---
kind: upgrade-guide
description: "The map observation client/server capture contract now requires a claim-then-capture handshake and a configurable source-capture policy."
---

# Map observation claim and capture policy

English | [中文](guide.zh.md)

## Change

`map_observe` evidence now uses one `POST /api/map/observation` route with `action: "claim"`, a token-bearing `kind: "capture"` or `kind: "decline"`, and token-bearing `action: "cancel"` requests. The client claims the accepted `observationRequest`, captures only after that revision renders, then awaits asynchronous host validation. The host checks the shared strict receipt schema, current request/revision and host-computed sources, canonical base64, and one bounded PNG decode before saving. It reads the saved attachment back and publishes metadata only if the actual bytes, digest, PNG type, length, and dimensions equal the admitted capture; a normalized or changed image is refused. Accepted evidence folds into `latestObservation` through `map-observation` metadata version 1. Invalid or wrong-token submissions preserve the pending wait; only a valid settlement, timeout, trusted tool cleanup, or disposal releases it. `MapPluginConfig.observation` accepts partial overrides resolved at plugin load, and invalid values fail load. `capturePolicy` defaults to `unverified` and remains source-policy metadata; it no longer blocks capture. Visible raster overlays are included, while hidden or zero-opacity layers are excluded.

## Migration

Per-turn observation, action and elapsed limits are now optional and default to unlimited. Recoverable failures leave the turn open; user takeover or accepted `finish` stops it. Custom clients read `mapContainer.interaction` and submit stops to `/api/map/use`. Camera candidates do not confirm rendering. Agent candidate decisions use `agent-applied` or `agent-dismissed`, not human review states.

1. Use the single action route: claim, then submit the receipt or decline with that token; use it to cancel.
2. If you self-host a client, preserve the capture receipt fields (`renderedRevision`, `viewId`, `generation`, `cameraEpoch`, `gestureEpoch`, `imageSize`, `mapContentRect`, `cssViewSize`, `camera`, `georeference`, `sources`, `includedOverlays`, `pngBase64`). `camera` may be `null` only with `{ kind: 'none', reason: 'unreadable-camera' }`.
3. Set only needed resource bounds under `MapPluginConfig.observation`. `capturePolicy` and source permission fields no longer control capture. Configure positive integer `maxBytes`, `maxPixels`, `maxDimension`, `maxPending`, or `maxEarlyClaims` within their documented bounds.
4. With a map open, call `map_observe`: the result includes the saved attachment, sha256, host-validated sources and georeference; `latestObservation` appears on the map wire state.
5. Upgrade the map host and client together. Set `interaction.maxActions`, `maxObservations` and `maxElapsedMs` only when limits are required. New camera records use map-change v7 and map-use v1; old records remain readable. Old projection caches rebuild from the Session log.
6. Camera results report `source_revision` and proposed `candidate_revision`; neither confirms rendering. After camera actions, omit `map_observe.expected_revision`. Re-observe after recoverable refusals; respect explicit user takeover.
7. Update candidate consumers to distinguish `agent-applied` and `agent-dismissed` from human acceptance and rejection. `map_edit_annotation` applies, dismisses or undoes candidates with agent attribution.
