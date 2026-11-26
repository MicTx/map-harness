---
kind: upgrade-guide
description: "Map Harness stops sharing ~/.dsh: every entry resolves an independent data root, ignores inherited DSH_HOME roots, and moves old data only through an explicit import."
---

# Map uses its own data home

English | [中文](guide.zh.md)

## Change

Map Harness previously resolved its data directory as `MAPHARNESS_HOME` → `DSH_HOME` → `~/.dsh`, so a stock DeepSeek Harness installation and Map shared sessions, credentials, schedules, caches, and browser state. Map now resolves one independent data root: `~/.map-harness` for releases, `~/.map-harness-preview` for preview builds, and `~/.map-harness-dev/<checkout-key>` for source checkouts. `MAPHARNESS_HOME` remains the only public override; an inherited `DSH_HOME`, `DSH_AGENTS_HOME`, or `DSH_RESOURCE_CACHE` no longer selects the Map root and is inspected only to reject a collision. A second process starting on the same data root fails with `MAP_INSTANCE_BUSY` instead of attaching to the running instance, the Map Web port defaults to the fixed `6425` (pass an explicit `--port` to use another), and the startup line reads `map-harness web`. Old data under `~/.dsh` stays where it is and is never shared again with the new instance: the first launch creates an empty new root and never deletes or rewrites the old one.

## Migration

1. If you have nothing to migrate, start Map once; the first launch creates `~/.map-harness` with its `map-instance.json` marker, `agents/`, and `cache/runtime/` directories. Confirm with `ls ~/.map-harness/map-instance.json`. A data root overlapping `~/.dsh`, `~/.agents`, or an installation root fails with `MAP_HOME_CONFLICT`; choose a separate root.
2. Keep using `MAPHARNESS_HOME` if you set it. A non-empty directory without a Map marker is refused with `MAP_HOME_UNCLAIMED` instead of being adopted; migrate into it with the import below.
3. To carry selected old Map sessions and their resources across, import **before** the first Map start: stop the old writers, prepare a readonly snapshot or quiescent backup of the old root, and run the dry-run (`map-harness manage import --from <snapshot> --to ~/.map-harness --session <ID> --snapshot readonly`) while `~/.map-harness` is absent or empty; it prints a JSON plan. Save the `status: ready` plan outside both roots and apply it with `map-harness manage import --apply --plan <file>`. The import publishes a marked instance you can then start. An already-started root (with marker or `agents/`) is rejected as a target; import into another empty path and set `MAPHARNESS_HOME` instead. Credentials, `.env`, stock sessions, schedules, and shared agents/skills are never imported; configure provider keys again in the new instance.
4. Scripts that exported `DSH_HOME` to point Map at a directory must export `MAPHARNESS_HOME` instead. Scripts that wait for the `dsh web:` startup line must wait for `map-harness web`.
5. Confirm isolation: with a stock DeepSeek Harness running, start Map and verify `~/.dsh` and `~/.agents` are unchanged, then open the printed `127.0.0.1` URL and reconfigure your provider keys.
