# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thank you for your interest in contributing to Map Harness!

This repository (Map Harness) is a downstream overlay on [DeepSeek Harness](./README.upstream.md). Contributions to upstream code go to [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness); contributions to this repository target the `map/` layer only (see [map/UPSTREAM.md](map/UPSTREAM.md) for how upstream files stay verbatim).

Map Harness is at an early stage and maintained by a very small team, so we cannot accept external pull requests at the moment. Ways that still help:

- Report issues and observations about the `map/` layer to this repository's tracker; upstream-specific findings belong in the upstream tracker instead.
- Read and share the project; blog posts and how-to guides about Map Harness are welcome.
- Upstream ecosystem activities (plugins, discussions, community Q&A around DeepSeek Harness) continue in the upstream community channels listed in [README.upstream.md](./README.upstream.md).

Docs and root-facing files are maintained as bilingual pairs (`foo.md` + `foo.zh.md` + `foo.i18n.yaml` consistency record); edit both sides and re-record with `pnpm run verify-translation-pairing --write <file>` — see [docs/i18n/README.md](docs/i18n/README.md).

Into the unknown.
