---
kind: upgrade-guide
description: "Map Harness release installation switches from a Node workspace runtime to a script-launched native Web service."
---

# Map Harness native Web service

English | [中文](guide.zh.md)

## Change

Map Harness release users extract a source-free Web service package instead of running the workspace archive with `install.sh`/`start.sh`. The package carries a native service executable, its locked Node engine, compiled map core, helpers, manifest, and licenses. Browser display and interaction remain JavaScript; map host implementations are compiled. A release supports only the targets for which qualified script archives are attached.

## Migration

1. Keep the existing `~/.dsh` state directory, or the directory selected by `MAPHARNESS_HOME`; keep it outside the extracted program folder.
2. Select a qualified service-host target from `web-service-release.json`, verify the archive against `SHASUMS256.txt`, and extract it into a new program folder rather than overlaying an old workspace distribution.
3. Run `start-web.cmd` on Windows or `./start-web.sh` on macOS/Linux. Windows requires Windows PowerShell; Node.js, Python, and an application installer are unnecessary. Follow the prompts to save your own DeepSeek key in the protected credential store outside the package; subsequent starts reuse it. Add `--no-onboarding` for an unattended direct service invocation.
4. Confirm that the service checks its actual Web page and prints the loopback URL. To update, stop the old service and extract the new archive into a clean program folder. See the [installation guide](../../../../map/docs/release-install-guide.md) for credentials and options.
