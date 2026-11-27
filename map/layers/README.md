---
description: "Describe and validate a map layer's presentation — symbols, per-feature overrides, imagery overlays, basemap sources, annotation geometry — and derive the legend the map and workbench show."
kind: "package-library"
---

# @map-harness/map-layers

English | [中文](README.zh.md)

## Summary

Use this library to describe how one map layer looks and to derive its legend. It owns the whole-layer `SymbolStyle` (single geometry blocks or an exclusive heatmap), sparse per-feature overrides, key-free imagery-tile admission, opaque basemap source and selection records, annotation geometry, group names, the deterministic auto palette, and the preset symbol library. The map tools, the `mapContainer` projection, and the browser workbench consume it. Validators return every issue with a stable field code instead of throwing.

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

### When to use it

Import it where a layer presentation record must be validated, versioned, or resolved: the map tools at their argument boundary, the `mapContainer` projection fold, and the browser workbench through `map-container`. It is a dependency, not a plugin layer, so it declares no `cordis.yml` row.

### Entry point

```text
import { asSingleSymbol, autoSymbolOf, legendOfSymbol } from '@map-harness/map-layers'

const symbol = asSingleSymbol(autoSymbolOf('population'))
const legend = symbol === undefined ? undefined : legendOfSymbol(symbol)
```

`autoSymbolOf` always returns the single-presentation face for an automatic layer color, and the legend derives from that face; a heatmap symbol has no symbol legend. A rejected record returns its issue list instead of throwing. Exact types and accepted bounds are owned by [the package entry](src/index.ts); the presentation vocabulary, wire fields, and tool surface are owned by [the map-layers reference](../docs/map-layers.md).

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`SymbolStyle` is a discriminated record: `single` carries optional point, line, and fill blocks, while `heatmap` carries one exclusive block. A block `opacity` multiplies the layer-level opacity rather than replacing it. A single symbol may also declare `semantic` (a fixed 12-word table) and `label` (`field` plus an optional zoom range); explicit blocks replace the semantic block of their geometry family. `FeatureOverride`/`FeatureOverrides` add sparse per-feature patches above the layer symbol, and resolution order is per-feature override > classification > symbol > semantic block > ArcGIS default; the renderer and legend read the same resolved symbol. `symbolVersion` and `overridesVersion` digest every field except the token itself, so a record cannot be edited without producing a new version.

The `validate*` functions report every problem as a `LayersIssue` carrying the field path and a stable code; `parseBasemapSource` and `parseBasemapSelection` return a parse result with the same stable failure codes. `ImagerySpec` admission accepts only key-free HTTPS XYZ templates with no userinfo or query, and stores the normalized `{level}/{row}/{col}` form. `BasemapSource` and `BasemapSelection` carry branded ids, validated release dates, roles, and compatibility checks without host endpoints or credential references. `AnnotationGeometry` is the shared closed record for browser drafts and host admission, with map-container owning admission topology and session budgets.

`autoSymbolOf(layerId)` digests the layer id into a fixed 12-color categorical palette, so the same id always yields the same color across replays and processes; auto markers wear a white halo and auto fills use 0.3 opacity with a darker same-hue outline. `SYMBOL_PRESETS` is a fixed `preset:<name>` library that the tool boundary expands before validation. `legendOfSymbol` resolves semantic defaults first, keeps block opacity explicit so legend and renderer compose the same rgba, and can narrow rows to the geometry families the layer data carries; the legend derives and never re-decides a color. Group display names are 1..64 characters with no control characters, and the group set is the names in use, never a second registry.

| Source | Responsibility |
|---|---|
| `src/contract.ts` | Symbol blocks, overrides, imagery, group names, version digests, and validators |
| `src/semantic.ts` | Semantic word table and resolved single symbol |
| `src/palette.ts` | Deterministic 12-color auto symbol |
| `src/preset.ts` | Fixed preset library and id resolution |
| `src/legend.ts` | Single-symbol legend derivation |
| `src/basemap.ts` | Basemap source and selection records with compatibility checks |
| `src/annotation-geometry.ts` | Shared annotation geometry record and validity check |

Dependency direction is `map-layers → spatial-viz` only (reusing `isHexColor`, `vizDigestOf`, and `featureIdOf` semantics); the map tools and projection import this package, and the browser workbench reads it through `map-container`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Map-layers reference](../docs/map-layers.md) — presentation vocabulary, projection vocabulary, tool surface, and verification entry points.
- [Map-container contract](../map-container/README.md) — the projection fold and browser workbench that consume these records.
- [Spatial-viz](../spatial-viz/README.md) — the adjacent classification authority (`StyleSpec`/`LegendSpec`).
- [Layer-presentation upgrade guide](../../docs/upgrade-guide/v0.2.0-rc.2/map-layer-presentation/guide.md) — externally visible vocabulary and wire changes.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `map_*` style tools and the `mapContainer` browser workbench that apply these records; those consumers own every model-visible style result and every rendered pixel.

#### KV Cache effect

The library assembles no model request and does not edit request history; the consuming tools and panels own the text and metadata they publish.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- Presets and the auto palette are fixed libraries: a deployment cannot register new preset ids or palette slots, so other presentations need explicit symbol records.
- Annotation geometry admits Point, LineString, and single-ring Polygon only; Multi* geometries and polygon holes stay uneditable, and map-container owns admission topology and session budgets.
- Imagery overlays admit only key-free HTTPS XYZ templates; authenticated imagery must go through a deployment source adapter instead.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
