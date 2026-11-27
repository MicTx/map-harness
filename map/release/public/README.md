# Map Harness

English | [中文](README.zh.md)

Map Harness is a self-hosted AI agent for geographic tasks that draws, inspects, and analyzes on a live map.

Download the script-launched Web service from [Releases](https://github.com/MicTx/map-harness/releases). This repository publishes the complete allowlisted source tree under the license below; the release attachments are prebuilt Web service archives.

## Install

Download the archive matching the operating system and CPU of the computer running the Web service — `mac-arm64`, `mac-x64`, `linux-arm64`, `linux-x64`, or `win-x64`; Linux targets require GNU libc. Check its SHA-256 against `SHASUMS256.txt`; `web-service-release.json` lists qualified targets and their attachments. Extract the archive and run `start-web.cmd` on Windows or `./start-web.sh` on macOS/Linux. Managed distributions (per-user installation) also ship `install-map.*` and `uninstall-map.*` installers. The launcher verifies the package, guides first-time credential configuration, starts the service, checks its Web page, and prints the full access URL. No Node.js, npm, Python, desktop installer, source checkout, or compilation is required; Windows uses Windows PowerShell. Your own DeepSeek API key is required only when configuring model access; input is hidden and stored outside the program folder. Only targets with attached, qualified archives are supported. The browser used to access the service need not run on the same platform as the service host.

Map Harness keeps its own user data root (`~/.map-harness` by default, override with `MAPHARNESS_HOME`), separate from any DeepSeek Harness installation. Sessions, credentials, and map data live there across restarts and upgrades. To bring selected old sessions and map resources from a previous shared installation, use the guided import command shipped with the release (`manage import`); the old data is never modified or deleted.

## Capabilities

- Search places and geographic resources.
- Draw and manage map layers with natural language.
- Create, edit, recover, and export private map annotations.
- Choose controlled basemaps and label overlays.
- Run spatial analysis and compare location scenarios.
- Inspect map screenshots and retain geographic context across a conversation.

## License

Map Harness is released under the [PolyForm Noncommercial License 1.0.0](https://github.com/MicTx/map-harness/blob/main/LICENSE); commercial use requires separate written authorization. Earlier releases retain their supplied licenses. The included DeepSeek Harness code remains available under the MIT License; third-party permissions and any required source offers are preserved in [THIRD_PARTY_NOTICES.md](https://github.com/MicTx/map-harness/blob/main/THIRD_PARTY_NOTICES.md).
