---
description: "LBS key pools with per-key status and priority, round-robin and random usage modes."
kind: package-reference
---

# @map-harness/lbs-keyring

English | [中文](README.zh.md)

## Summary

Give a deployment several LBS keys per vendor and let one policy decide which key serves the next request. The package owns the `map-lbs-keyring` settings namespace for pool structure and value-free status, and the Host `lbsKeyring` service that resolves one configured value through the credentials seam. Secret values never enter the settings document, the status projection, an error, or a log. The browser settings section, accessibility runs, online search, and basemap activation read the same pool.

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

Mount the Host plugin in a composition that also provides `settings` and `credentials`; both are optional, and either missing service keeps the legacy single-key path.

### When to choose it

Choose it when a deployment needs more than one LBS key per vendor, wants to spread quota across keys, or needs to see which key is currently serving. A deployment with no pool configuration keeps the legacy single credential reference per vendor.

### Minimal configuration

```yaml
- id: map-lbs-keyring
  name: '@map-harness/lbs-keyring'
```

| Field | Default | Meaning |
|---|---|---|
| `vendors` | `{}` | Pool per vendor: ordered slots, usage mode, cursor, and health; an empty pool keeps the legacy single reference. |
| `cooldownScale` | `1` | Multiplier for outcome cooldowns, in `[0, 10]`. |

Both fields are volatile settings, so the settings page edits the pool without remounting the plugin. The accepted shape is owned by [`src/config.ts`](src/config.ts).

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`createLbsKeyring(deps)` builds the service over injected settings, credentials and clock faces. `select(vendorId)` resolves one value and persists the new cursor and usage count. `report({ vendorId, slotId, outcome })` updates cooldown health. `document()` validates the durable document on every read. The pure `contract.ts` and `policy.ts` modules carry no I/O and can be imported by the browser half.

| Source | Responsibility |
|---|---|
| `src/index.ts` | Host plugin (`name`/`apply`/`inject`) and service declaration |
| `src/config.ts` | Volatile settings schema and the shared namespace id |
| `src/contract.ts` | Reference grammar, bounds, and document normalization |
| `src/policy.ts` | Eligible-slot and selection policy without I/O |
| `src/service.ts` | Service over settings, credentials, and clock |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Map-web profile composition](../profiles/map-web/cordis.patch.yml) — the shipped mount row and its empty-pool default.
- [LBS protocol upgrade guide](../../docs/upgrade-guide/v0.2.0-rc.2/map-lbs-protocol/guide.md) — LBS coordinate, network identity, and authorization changes beside this pool.
- [Verification matrix](../docs/verification-matrix.md) — the unit, Loader, and ownership rows for this package.
- [Engineering reference](../docs/engineering.md) — package inventory and consumer summary.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the LBS search, accessibility, and basemap consumers that resolve keys through `lbsKeyring`; those consumers own every model-visible result and failure.

#### KV Cache effect

The package assembles no model request and does not edit request history; key selection changes only which credential a consumer uses, so it neither appends model-context tokens nor invalidates a reusable prefix.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Vendor-side key validity probing is out of scope: the package classifies outcomes reported by consumers and never calls a vendor endpoint itself.
- Runtime health is cooldown state derived from reported outcomes, not an independent health check.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`pnpm --filter @map-harness/lbs-keyring run test` covers reference grammar and bounds, document validation, each selection mode, cooldown transitions, implicit single-key compatibility, and the absence of secret values in persisted state.

</details>
