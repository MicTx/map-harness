---
description: "LBS key pools with per-key status and priority, round-robin and random usage modes."
kind: package-reference
---

# @map-harness/lbs-keyring

English | [中文](README.zh.md)

LBS key pools for Map Harness: an ordered set of credential references per vendor, per-key status, and a usage mode that decides which key serves the next request.

## Summary

The package owns one settings namespace (`map-lbs-keyring`) for pool structure and value-free status, and one Host service (`lbsKeyring`) that selects a configured key through the credentials seam. Secret values never enter the settings document, the status projection, an error, or a log. The browser settings section, accessibility runs, online search, and basemap activation all read the same policy.

## Use this package

### When to choose it

Choose it when a deployment needs more than one LBS key per vendor, wants to spread quota across keys, or needs to see which key is currently serving. A deployment with no pool configuration keeps the legacy single credential reference per vendor.

### Data ownership

| Data | Owner | Wire path |
|---|---|---|
| Pool structure: mode, ordered slots, enabled flags, labels | Host settings namespace | `settings.describe` / `settings.mutate` through `configForms` |
| Secret value for one slot | Credentials seam | `credentials.set` / `credentials.unset` / `credentials.describe` |
| Usage status: outcome code, cooldown, use count, last used | Host settings namespace | forwarded `settings/document-updated` |
| Selected value for one operation | Host service in memory | `lbsKeyring.select(vendorId)` |

Each vendor's first slot keeps the legacy reference (`TIANDITU_API_KEY`, `AMAP_API_KEY`, and so on). Additional slots use numbered references such as `TIANDITU_API_KEY_2`. Slot references stay stable: reordering never reassigns a reference, and removing a slot never renumbers the others.

### Usage modes

| Mode | Selection |
|---|---|
| `priority` (in order) | Always prefer the earliest enabled and configured slot; fall back only when it cannot serve. This is the default and matches legacy single-key behavior. |
| `round-robin` | Advance a persisted cursor through the eligible slots on each selection. |
| `random` | Pick uniformly among eligible slots on each selection. |

Disabled, unconfigured and cooling slots are skipped. A classified `rate-limited` or `permission-denied` outcome puts its slot in cooldown; a `success` outcome clears it. When no slot can serve, consumers fall back to their original single-reference resolution.

## Service contract

`createLbsKeyring(deps)` builds the service over injected settings, credentials and clock faces. `select(vendorId)` resolves one value and persists the new cursor and usage count. `report({ vendorId, slotId, outcome })` updates cooldown health. `document()` validates the durable document on every read. The pure `contract.ts` and `policy.ts` modules carry no I/O and can be imported by the browser half.

## Tests

`pnpm --filter @map-harness/lbs-keyring run test` covers reference grammar and bounds, document validation, each selection mode, cooldown transitions, implicit single-key compatibility, and the absence of secret values in persisted state.

## Known Limitations and Deferred Work

Vendor-side key validity probing is out of scope: the package classifies outcomes reported by consumers and never calls a vendor endpoint itself. Runtime health is cooldown state derived from reported outcomes, not an independent health check.
