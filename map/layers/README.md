# @map-harness/map-layers

English | [中文](README.zh.md)

Versioned layer-presentation vocabulary for the map layer — the presentation
authority beside `spatial-viz`'s classification authority.

- `SymbolStyle` — the whole-layer presentation record: `single` (optional
  `point`/`line`/`fill` blocks) or `heatmap` (one block, exclusive). Each
  block carries colors, sizes, patterns, and an optional block `opacity`
  (`[0, 1]`, default 1) that multiplies — never replaces — the layer-level
  opacity.
- `FeatureOverride` / `FeatureOverrides` — sparse per-feature patches above
  the layer symbol; resolution order is override > classification > symbol >
  ArcGIS default.
- `ImagerySpec` — key-free HTTPS XYZ tile admission for imagery overlay
  layers; userinfo and query strings refuse structurally, and the stored
  template is always the normalized ArcGIS `{level}/{row}/{col}` form.
- Group display names — 1..64 characters, no control characters; the group
  set is implicit (the names in use), never a second registry.
- `autoSymbolOf(layerId)` — deterministic automatic coloring: the layer id's
  digest picks a slot in the fixed 12-color categorical palette; same id,
  same color, no counters or randomness, replay-stable.
- `SYMBOL_PRESETS` / `resolveSymbolPreset` — the built-in `preset:<name>`
  library (marker shapes × palette bases × size/transparency tiers, line
  patterns, fills, heatmaps). Presets are an explicit resolve step at the
  tool boundary: the id expands to the full symbol, which re-validates.
- `legendOfSymbol` — the single-symbol legend derivation; rows carry block
  opacity explicitly so legend and renderer compose the same rgba. The legend
  derives, it never re-decides a color.

Version tokens (`sym-…@v1`, `ovr-…@v1`) derive the same way
`spatial-viz`'s `styleVersion` does: a digest over every field except the
token itself, so a record cannot be edited without producing a new version.
Validators return every issue (`LayersIssue`: field + stable code) instead
of throwing.

Dependency direction: `map-layers → spatial-viz` only (reusing `isHexColor`,
`vizDigestOf`, `featureIdOf` semantics). The projection fold and the tools
import this package; the browser workbench consumes it through map-container.
Pure library — no host plugin row.

```sh
pnpm --filter @map-harness/map-layers run test   # contract + palette suites
```
