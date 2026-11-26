---
kind: upgrade-guide
description: "The public GitHub repository now carries the complete allowlisted source tree under PolyForm Noncommercial 1.0.0 instead of release documentation only."
---

# Public repository publishes full source

English | [中文](guide.zh.md)

## Change

Earlier releases published four documentation and license files to the public repository main and distributed script-launched Web service archives with obfuscated map modules. The Map-authored code used a use-only license. This release publishes the complete allowlisted source tree in an orphan public snapshot, relicenses Map-authored code to [PolyForm Noncommercial License 1.0.0](../../../../LICENSE), and distributes plain compiled runtime artifacts. Private Gitea remains the development source of truth; private history, agent state, `.env*` files, and the maintainer release procedure are excluded. Older releases keep their supplied licenses.

The change is visible to anyone cloning the public repository, building from source, redistributing the code, or inspecting a release attachment. Commercial use still requires separate written authorization. Upstream DSH remains MIT and third-party permissions are unchanged.

## Migration

1. Replace the `LicenseRef-Map-Harness-Use-Only` declaration in every owned manifest with `PolyForm-Noncommercial-1.0.0`, and update any tooling that matched the old identifier.
2. Clone the public repository and build with `pnpm install` followed by `node map/bin/build-web.mjs`; the source tree now resolves workspace dependencies directly. Do not expect a Source code ZIP containing only documentation.
3. For release archives, expect readable compiled JavaScript in map modules instead of obfuscated bytes; remove any verification that compares protected byte inventories. The Web service qualification and manifest digest checks still apply.
4. Point source-offer notices at the public repository and its release tags. Keep `THIRD_PARTY_NOTICES.md` generated from `scripts/gen-third-party-notices.ts`.
5. Confirm the migration by running `pnpm run doc-sync`, `pnpm exec vitest run scripts/gen-third-party-notices.spec.ts scripts/verify-dsh-package-licenses.spec.ts`, and `node map/bin/audit-public-tree.mjs --evidence <dir>`; the audit reports zero violations and no excluded paths.
