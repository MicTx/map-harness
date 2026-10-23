## Install guide for LLM agents

This section is written for an AI coding agent installing map-harness {{version}} on a user's machine (Windows, macOS, or Linux). The release attaches a prebuilt runtime archive: nothing is compiled; the install step only downloads dependencies. Run the steps in order, check each step's success condition before the next one, and stop with the failing command's output if a check fails.

1. Check prerequisites.
   - Run `node --version`. Success: `v22.19.0` or later on 22.x, or `v24.0.0` or later. If Node.js is missing, point the user to https://nodejs.org (mirror for mainland China: https://npmmirror.com/mirrors/node/).
   - No git, compiler, or global pnpm is needed: the install script runs the pinned pnpm through `npx` when it is not on PATH.
2. Get the runtime archive.
   - Download `map-harness-{{version}}-runtime.zip` (Windows) or `map-harness-{{version}}-runtime.tar.gz` (macOS/Linux) from the GitHub release assets (https://github.com/MicTx/map-harness/releases/tag/{{version}}), and extract it.
   - Success: the extracted folder `map-harness-{{version}}-runtime` contains `install.cmd`, `install.sh`, `start.cmd`, and `start.sh`.
3. Install dependencies (choose the registry mirror).
   - Windows: run `install.cmd` in that folder. macOS/Linux: run `./install.sh`.
   - The script probes npm mirrors in order — npmmirror (`https://registry.npmmirror.com`), Tencent Cloud (`https://mirrors.cloud.tencent.com/npm`), then the official registry (`https://registry.npmjs.org`) — and uses the first reachable one. To force one, pass `--registry <url>` or set `MAPHARNESS_REGISTRY=<url>`. `--check` only reports the environment and the chosen registry.
   - Electron and Playwright browser downloads are skipped; the map Web service needs neither.
   - Success: the output ends with `map-harness setup: dependencies installed.`
4. Configure the model key.
   - The user supplies `DEEPSEEK_API_KEY`. Ask for it; never invent, log, or commit it.
   - Put it in `~/.dsh/.env` (or `$MAPHARNESS_HOME/.env`) as `DEEPSEEK_API_KEY=<value>`, or export it in the shell that starts the service.
   - `DEEPSEEK_BASE_URL` is optional and must be exported in the shell; `.env` files refuse it.
   - `TIANDITU_API_KEY` is optional the same way: without it the service still starts with no error, online Tianditu search stays off, and the road-network accessibility tools (`run_*`) report that the service is unavailable.
5. Start the map-mode Web service.
   - Windows: run `start.cmd --no-open`. macOS/Linux: run `./start.sh --no-open`.
   - Success: the output contains a line starting with `dsh web: http://127.0.0.1:3080/?token=`.
   - Give the user that full URL; the token in it is the login. The service listens on loopback only.

Options: `--port <n>` changes the port; `MAPHARNESS_HOME=<dir>` keeps map-harness state apart from a stock DeepSeek Harness install (default `~/.dsh`).

Building from source instead (developers): `git clone --branch {{version}} --depth 1 https://github.com/MicTx/map-harness.git`, then `pnpm install`, `node map/bin/build-web.mjs`, and `pnpm run start:web -- --no-open`.
