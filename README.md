# Map Harness

English | [中文](README.zh.md)

Map Harness adds a live map canvas and spatial-analysis tools to an AI agent workspace.

Download the script-launched Web service from [Releases](https://github.com/MicTx/map-harness/releases). This repository contains release documentation and licenses; project source code is not distributed. GitHub's automatic ZIP/TAR snapshots contain these documents only.

## Install

Download the archive matching the operating system and CPU of the computer running the Web service. Check its SHA-256 against `SHASUMS256.txt`; `web-service-release.json` lists qualified targets and their attachments. Extract the archive and run `start-web.cmd` on Windows or `./start-web.sh` on macOS/Linux. The launcher verifies the package, guides first-time credential configuration, starts the service, checks its Web page, and prints the full access URL. No Node.js, npm, Python, desktop installer, source checkout, or compilation is required; Windows uses Windows PowerShell. Your own DeepSeek API key is required only when configuring model access; input is hidden and stored outside the program folder. Only targets with attached, qualified archives are supported. The browser used to access the service need not run on the same platform as the service host.

## Capabilities

- Search places and geographic resources.
- Draw and manage map layers with natural language.
- Create, edit, recover, and export private map annotations.
- Choose controlled basemaps and label overlays.
- Run spatial analysis and compare location scenarios.
- Inspect map screenshots and retain geographic context across a conversation.

## License

Map Harness-authored map code uses the [Map Harness use-only license](https://github.com/MicTx/map-harness/blob/main/LICENSE): unmodified noncommercial operation is permitted; modification, secondary development, redistribution, and commercial use require separate written authorization. Earlier releases retain their supplied licenses. Upstream DSH remains under MIT; third-party permissions and any required source offers are preserved in [THIRD_PARTY_NOTICES.md](https://github.com/MicTx/map-harness/blob/main/THIRD_PARTY_NOTICES.md).
