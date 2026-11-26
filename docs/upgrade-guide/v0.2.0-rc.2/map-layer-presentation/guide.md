---
kind: upgrade-guide
description: "Map layers gain presentation state (visibility, opacity, groups, symbols, per-feature overrides) and key-free imagery overlays under meta schema v5; the map-change wire rejects older readers read-only."
---

# Map layer presentation vocabulary and imagery layers

English | [中文](guide.zh.md)

## Change

The map layering wire moves to meta schema version 5. The change vocabulary gains `set-layer-state` (batch visibility, opacity, and display-group labels), `set-symbol-style` (the whole-layer symbol or a heatmap presentation), and `set-feature-overrides` (per-feature patches above the symbol), and `add-layer` gains the optional `imagery` identity for key-free HTTPS tile overlays. Layer records may now carry `symbol`, `overrides`, `group`, and `imagery`; an imagery layer carries no feature data, so `data` and `imagery` are exclusive.

Two model tools expose the new words: `layer_set_state` and `layer_set_style`. Both are pure projection changes with no published artifact, so they carry no publish pairing. `map_add_layer` gains the third exclusive source `tile_url` (plus `tile_attribution`); the template must be HTTPS, key-free (no userinfo, no query), and carry `{z}/{y}/{x}` or `{level}/{row}/{col}` — the stored form is always normalized to `{level}/{row}/{col}`.

The persisted projection generation moves 8 → 9: cache rows written by a previous build are discarded and refolded from the session log. Version 4 change records still decode (the older vocabulary); a v5 record is refused read-only by an older build instead of being misread. `map_add_layer`'s versioned branch now derives the minimal legend from the layer id's deterministic palette color instead of one constant blue, so replayed recordings show per-layer legend colors.

## Migration

1. Rebuild every map package (`pnpm run build && node map/bin/build.mjs`); the profile links the built `lib/` entries, and a stale `map-container` lib cannot fold the new words.
2. Do not rewrite session logs. Old logs carrying v4 map-change records replay as before; the new projection cache refolds them at generation 9.
3. Replace whole-layer replacement (upsert or replacement `add-layer`) with `layer_set_state` wherever only visibility, opacity, or grouping changes — a replacement re-admits the data and burns the rendered identity, while the new word never touches either.
4. Expect recorded expectations that pin `map_add_layer` legends to change color: the legend now derives from the layer id. Re-record or refresh those scenarios with the owning repository commands instead of editing the expected files by hand.
5. Heatmap presentations require an all-Point layer with no classification style and are refused on lines, polygons, and classified layers; per-feature override ids must exist in the layer data (`featureIdOf` keys), and an unknown id refuses the whole change with the `feature-unknown` diagnostic.
6. Browser panels should read the new wire fields (`symbol`, `overrides`, `group`, `imagery`) and derive symbol legends through `legendOfSymbol`; a classified layer's legend still comes from `legendOf(style)` and never from the symbol.
