# Map Harness

English | [中文](README.zh.md)

Map Harness is a self-hosted AI agent for geographic tasks that draws, inspects, and analyzes on a live map.

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

When a task is geographic — siting, coverage, overlap, distribution — the agent puts data on the map, looks at what it drew, and runs versioned spatial analysis instead of reasoning from plain text. Each conversation owns its map: replaying the session log rebuilds the same map after a restart, a context compaction, or a fork.

> [!WARNING]
>
> Developer preview: versions can break compatibility. The agent can run model-generated commands and access files, processes, and the network; read [SAFETY.md](SAFETY.md) before running it.

## Features

| Capability | What you can do |
|---|---|
| **Map by conversation** | Ask in plain language to locate places, add or draw layers, switch between 2D and 3D, and change basemaps. With a vision-capable model, the agent checks map screenshots and can pan, zoom, and inspect the map within per-turn limits; your own map input always takes priority. |
| **Layers and styling** | Rename, show, hide, reorder, group, and restyle layers with thematic classes, heatmaps, and per-feature overrides; legends follow the rendered symbols. |
| **Basemaps and historical imagery** | Use Esri World Imagery, fixed Esri Wayback releases, OpenStreetMap, and Tianditu, then compare two dates and confirm what appeared, disappeared, or changed. |
| **Data in and out** | Import GeoJSON, CSV, Shapefile, and KML (ambiguous columns wait for your confirmation), search places and POIs through Tianditu (requires a Tianditu key), and export by reference with SHA-256 digests. |
| **Spatial analysis** | Run buffers, overlays, areas, distances, contours, kernel density, slope, line of sight, and viewsheds. |
| **Accessibility and statistics** | Measure road-network service coverage through AMap, Tianditu, Baidu, Tencent, or Mapbox routing, test spatial autocorrelation and hotspots with Moran's I and Getis-Ord Gi*, and detect change, cluster, and flow patterns. |
| **Decisions and siting** | Compare candidate sites under coverage, equity, and cost weights, allocate locations, and validate forecasts; attribution and effect results are labeled `causal`, `association`, or `unknown`, so a correlation is never reported as a cause. |
| **Annotations and collaboration** | Draw annotations that the model cannot overwrite, undo changes, and export annotations as GeoJSON; concurrent edits commit against map revisions. |

<!-- Keep these anchors: docs/user/guide/index.md and docs/user/guide/providers.md link to #run; docs/user/develop/basic/{index,publish}.md link to #run-from-source. -->
<a id="run"></a>

<a id="run-from-source"></a>

## Quick start

Map Harness runs from a source checkout. It requires Node.js `>=24.9.0`, the pnpm version pinned in `package.json` (`packageManager`), and, on Linux and macOS, a C compiler for one small native addon.

```sh
pnpm install                       # install workspace dependencies
node map/bin/build-web.mjs         # build the agent runtime, map packages, and the Web frontend
node map/bin/map-harness.mjs web   # start the Web UI with the map-web profile
```

The Web UI starts at `http://127.0.0.1:6425` and opens in your default browser (`--no-open` skips that; `--port <n>` changes the port). On first start, open **Settings → Models** and enter your own DeepSeek API key, or export `DEEPSEEK_API_KEY` before starting. `pnpm run start:web` and `make web` start the same profile; `node map/bin/test.mjs` runs the map test suites.

A source checkout keeps its data in `~/.map-harness-dev/<checkout-key>` (set `MAPHARNESS_HOME` to use another directory). Map provider keys for Tianditu, AMap, Baidu, Tencent, and Mapbox are optional and set in Settings; Esri basemaps need no key. DeepSeek is the default model provider; [add other providers](docs/user/guide/providers.md) on the Models page. Data directories are described in the [installation reference](map/docs/installation.md) (Chinese).

## How it works

- **The conversation owns the map.** Tool calls propose map changes; accepted changes fold into a session projection, so the session log alone reproduces the map.
- **One spatial tool catalog.** The agent calls 72 spatial tools in 26 families, registered in a single catalog and served through an in-process MCP server; see the [capability index](map/docs/capability-index.md) (Chinese).
- **Versioned data per conversation.** Imported and derived data become immutable resource versions in a per-conversation catalog, and analyses and exports cite exact versions.
- **ArcGIS in the browser.** Each conversation's map renders in a side panel with the ArcGIS Maps SDK for JavaScript.
- **Repository layout.** `map/` holds all Map Harness code: tools, map container, spatial libraries, profiles, and release tooling ([package map](map/README.md)). The agent runtime outside `map/` is [DeepSeek Harness](README.upstream.md) (MIT), imported verbatim except for the root project files and integration patches listed in [map/UPSTREAM.md](map/UPSTREAM.md).

## Documentation

- [Installation reference](map/docs/installation.md) (Chinese): data directories, managed installs, upgrades, and data import.
- [Capability index](map/docs/capability-index.md) (Chinese): every model-visible map tool and how it is registered.
- [Package map](map/README.md): map packages and how each one attaches to the agent runtime.
- [Runtime user guide](docs/user/guide/index.md): the Web UI, model providers, and other runtime features.
- [Safety notice](SAFETY.md): risks of running an agent with file, process, and network access.

The public source tree excludes private working notes and session recordings. Replay suites that use these recordings require the development checkout.

## Contributing

Bug reports and observations are welcome in the [issue tracker](https://github.com/MicTx/map-harness/issues); external pull requests are not accepted yet. See [CONTRIBUTING.md](CONTRIBUTING.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md) for private vulnerability reports.

## License

Map Harness is released under the [PolyForm Noncommercial License 1.0.0](LICENSE); commercial use requires separate written authorization. Earlier releases keep the licenses they shipped with. The DeepSeek Harness code in this repository is Copyright (c) 2026 DeepSeek and remains available under the MIT License, reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) together with the licenses of third-party dependencies.
