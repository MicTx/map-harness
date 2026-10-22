---
kind: upgrade-guide
description: "Amap and Baidu network identities change with coordinate corrections, Baidu caps collection evidence, and Tianditu uses HTTPS and explicit authorization failures."
---

# Map LBS coordinates and authorization

English | [中文](guide.zh.md)

## Change

The Baidu provider interprets input coordinates as WGS84, requests GCJ-02 output and converts returned coordinates using the same approximate inverse as the Amap provider. Its network reference ends in `@2`; `@1` results used the vendor's default BD-09 convention without conversion. Amap network references also end in `@2` because the shared longitude approximation includes its missing harmonic term. Stored runs and reports are not rewritten. The inverse has residual metre-level error and is not a survey-grade conversion.

Baidu Place v2 totals can be capped at 150. Collections reaching that bound report `partial` rather than claiming every matching POI was retrieved; bounds searches require the vendor's advanced entitlement.

Tianditu uses HTTPS by default. HTTP 401/403 and Baidu application-disabled status 240 report `PERMISSION_DENIED`, not temporary unavailability. HTTP 429 reports `RATE_LIMITED`.

## Migration

1. Supply WGS84 coordinates to Baidu analyses. Do not relabel existing BD-09 values as WGS84. Recompute affected Amap/Baidu coverage or routes instead of comparing their old `@1` network identity with `@2`; treat capped POI collections as partial.
2. Allow HTTPS access to the official Tianditu API. Keep an explicit deployment `tianditu.baseUrl` only when an intentional gateway requires it; never disable TLS verification to accommodate a gateway.
3. Check the key's service type and enabled APIs in the vendor console before retrying `PERMISSION_DENIED`. A browser SDK key does not establish Web-service authorization.
4. Run the [provider verification commands](../../../../map/docs/spatial-accessibility.md). Confirm a successful vendor response, coordinate units and the new Baidu network reference; a skipped test or HTTP 200 containing an authorization error is not a successful connection.
