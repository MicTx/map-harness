## Install guide for LLM agents

This section is written for an AI coding agent installing map-harness {{version}} on a user's machine. Run the steps in order, check each step's success condition before the next one, and stop with the failing command's output if a check fails.

1. Check prerequisites.
   - Run `node --version`. Success: `v22.19.0` or later on 22.x, or `v24.0.0` or later.
   - Run `git --version`. Success: any version.
2. Get the release source.
   - Run `git clone --branch {{version}} --depth 1 https://github.com/MicTx/map-harness.git && cd map-harness`.
   - Success: `git describe --tags` prints `{{version}}`.
   - Run `corepack enable && pnpm --version`. Success: the version pinned in `package.json` `packageManager`; corepack selects it automatically.
3. Install dependencies.
   - Run `pnpm install`.
   - Success: exit code 0. Build-script approval prompts are configured in `pnpm-workspace.yaml`; do not approve additional scripts.
4. Build.
   - Run `pnpm run build:lib`, then `node map/bin/build-web.mjs`.
   - Success: both exit 0, and `map/map-container/lib/client.js` exists.
5. Configure the model key.
   - The user supplies `DEEPSEEK_API_KEY`. Ask for it; never invent, log, or commit it.
   - Put it in `~/.dsh/.env` (or `$MAPHARNESS_HOME/.env`) as `DEEPSEEK_API_KEY=<value>`, or export it in the shell that starts the service. A repository-root `.env` also works for the key.
   - `DEEPSEEK_BASE_URL` is optional and must be exported in the shell; `.env` files refuse it.
6. Start the map-mode Web service.
   - Run `pnpm run start:web -- --no-open`. This boots the `map-web` profile (same as `node map/bin/map-harness.mjs web`).
   - Success: the output contains a line starting with `dsh web: http://127.0.0.1:3080/?token=`.
   - Give the user that full URL; the token in it is the login. The service listens on loopback only.
7. Verify (optional).
   - Run `node map/bin/test.mjs`. Success: exit code 0.

Options: `--port <n>` changes the port; `MAPHARNESS_HOME=<dir>` keeps map-harness state apart from a stock DeepSeek Harness install (default `~/.dsh`).
