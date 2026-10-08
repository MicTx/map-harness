# Map Harness

English | [中文](README.zh.md)

Map Harness: an agent-harness derivative of [DeepSeek Harness](./README.upstream.md), adding a live map canvas and spatial-analysis tools for geographic tasks. That increment is Geospatial Visualized Reasoning: when a task is geographic — siting, coverage, overlap, distribution — the agent draws, inspects, and reasons on the map instead of working from plain text.

**Developer preview — there will be compatibility-breaking changes.** The harness can execute model-generated commands and access files, processes, and the network; read [SAFETY.md](SAFETY.md) before running it.

<!-- Keep these anchors: docs/user/guide/index.md and docs/user/guide/providers.md link to #run; docs/user/develop/basic/{index,publish}.md link to #run-from-source. -->
<a id="run"></a>

<a id="run-from-source"></a>

## Quick start

Prerequisites: Node.js `^22.19.0 || >=24.0.0` and pnpm `11.7.0` (e.g. `corepack enable`), per `package.json`.
```sh
git clone https://github.com/MicTx/map-harness.git && cd map-harness
pnpm install          # install workspace dependencies
pnpm run build:lib    # build upstream host libraries (host + client phases)
node map/bin/build-web.mjs   # build map packages and the web frontend under the map brand title
node map/bin/map-harness.mjs web    # start the map harness web UI (default profile: map-web)
```
The last command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser; pass `--no-open` to skip opening. See the upstream [user guide](docs/user/guide/index.md) for what comes next.

## Architecture

Map Harness is a derivative: the [DeepSeek Harness](./README.upstream.md) (upstream, MIT) tree stays verbatim, and this project's additions live only in `map/`.

```
Upstream verbatim (apps/ vendor/ ...; exceptions registered in map/UPSTREAM.md)
└── map/                      ← the only owned area of this repository
    ├── tools/                ← map toolkit (model-facing map/geo spatial tools)
    ├── client-ui-brand/      ← brand plugin, occupying the sidebar.brand.* official slot
    ├── profiles/map-web/     ← map-web bundle (brand patch layer)
    ├── bin/                  ← map-harness CLI wrapper and build scripts
    ├── docs/                 ← map layer design records
    ├── README.md             ← slot contract
    └── UPSTREAM.md           ← upstream update process
```

Branding and map capabilities attach only through upstream extension slots (patch layers that replace or insert plugin rows by id); upstream files stay unchanged except the repo-owned facade files and integration patches registered in [map/UPSTREAM.md](./map/UPSTREAM.md). The complete slot contract and per-package attachment mechanisms live in [map/README.md](./map/README.md).

## Upstream updates

See [map/UPSTREAM.md](./map/UPSTREAM.md): new version import → zero-conflict check → reinstall → rebuild upstream and map layers → smoke test, never touching the `map/` layer.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md); upstream community channels are listed in [README.upstream.md](./README.upstream.md). Benchmarks: see [BENCHMARK.md](BENCHMARK.md).

## License

Map Harness is released under the [GNU Affero General Public License v3.0](./LICENSE). The vendored upstream [DeepSeek Harness](./README.upstream.md) code is Copyright (c) 2026 DeepSeek and remains under its MIT License, reproduced in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), where third-party dependencies and their licenses are disclosed as well.
