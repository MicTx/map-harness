# layer-workbench acceptance fixtures

English | [中文](README.zh.md)

Synthetic-only assets for the P4 linked-acceptance case (`layer workbench`).
No customer data, credentials, or private paths appear here; every payload is
generated from `generate.mjs` and stays byte-stable across regeneration.

## Files

- `generate.mjs` — deterministic generator; `node generate.mjs` writes the
  assets, `node generate.mjs --verify` proves two runs produce identical
  digests and that the committed files match.
- `hospitals.csv` — Beijing-area hospital points with the ambiguous `x`/`y`
  header (weak aliases): `data_import` stops at `needs_confirmation`.
- `hospitals.confirmed.csv` — the resolved `lon`/`lat` header variant.
- `hospitals-gbk.csv` — GBK-encoded header with strong Chinese aliases;
  imports with `encoding: "gbk"`.
- `roads.shp.zip` — PolyLine shapefile with `.prj` (WGS84) and `.cpg`;
  imports without confirmation.
- `truncated.shp.zip` — the record chain is cut mid-record; refuses with the
  stable `.shp record chain` error and leaves zero catalog rows.
- `tile.png` — the 1×1 fixture tile the composition lane serves for both the
  basemap and the imagery family check.
- `imagery-template.json` — the key-free tile template the imagery family
  check uses; the composition lane intercepts it with `page.route`, so the
  host never resolves for real.
- `poi/` — Tianditu `/v2/search` wire payloads: `page-1.json` and
  `page-2.json` (paged success), `rate-limited.json` (HTTP 429), `empty.json`
  (a zero-count success).
- `poi-fixture-server.mjs` — loopback fixture search server consuming the
  `poi/` payloads; the composition scenario patch points the map-web
  composition's `spatial-connect` at it.
- `poi-fixture-plugin.mjs` — process-local transport the snapshot composition
  mounts instead, serving the same payloads without any network.
