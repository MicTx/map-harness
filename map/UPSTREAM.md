# 上游更新流程（deepseek-harness → map harness）

当前上游基线：GitHub `master` tag `dsh-v0.2.1-rc.2`（687f282e，2026-10-21 导入）。基线来自 GitHub `master`；同步前用 `git ls-remote --symref https://github.com/deepseek-ai/deepseek-harness.git HEAD` 解析默认分支和提交，不假设分支名为 `main`。

本仓库的上游文件区（`packages/`、`apps/`、`vendor/`、`scripts/`、`docs/`、`snapshots/`、`native/`、`python/`、`benchmarks/`、`website/`、`.agents/`、`.github/`、根级上游配置）保持 deepseek-harness 原样；本仓库自有层全部在 `map/`。兼容性补丁位于 `packages/client/tsdown.client.ts`：上游 `0.2.0-rc.2` 的 CSS virtual id 在安装 `@tsdown/css` 后可能重新附加 `?inline`，补丁在读取前剥离该 query，并保留 inline 默认导出。上游更新时按本流程执行，并重新验证各项补丁是否仍需要；资源生命周期修复、前置要求说明、`scripts/` 自有修改与根级门面文件见下文白名单。

Map 层有一个根级安装策略例外：`pnpm-workspace.yaml` 的 `allowBuilds` 拒绝 `@vaadin/vaadin-usage-statistics`，因为它由 `@arcgis/core` 间接引入，地图渲染不需要其 telemetry postinstall。该策略不得放行脚本，只能保持显式拒绝。

## 零冲突检查（导入前后各跑一次）

上游文件区的允许差异是 `pnpm-workspace.yaml` 末尾追加的 `map/*` 三行注释 + glob、`packages/client/tsdown.client.ts` 的 CSS virtual-id 兼容补丁、`scripts/` 自有修改（`scripts/translation-pairing.ts` 的根级配对白名单、`scripts/gen-third-party-notices.ts` 的许可模板及其 spec 断言，含上游 MIT 全文保存节；`verify-dsh-package-licenses` 双文件与 `no-unknown-casts.baseline.json`——AGPL 分家策略与 map 层存量 cast 基线属本仓库；`verify-repository-references.ts` 与 `verify-concrete-terms.ts` 的排除前缀加 `.spec/`、`map/`——私有任务包与自有层不是被巡查的上游维护面；`rescope-vendor.ts` 的 GENERIC_SKIPS 增补 inspect 事件名、`cordis.patch.yml` 和 `loader-smoke.spec.mjs` 产品数据豁免），以及下方「需重放的上游补丁」登记的文件与根级自有门面文件。检查命令：

```sh
# 登记文件之外不能出现上游差异；登记文件内部仍须逐块审阅
git diff --name-only <upstream-base-commit>..HEAD -- ':!map' ':!.spec' ':!.gitignore' ':!pnpm-workspace.yaml' ':!pnpm-lock.yaml' ':!README.md' ':!README.zh.md' ':!README.i18n.yaml' ':!README.upstream.md' ':!README.upstream.zh.md' ':!packages/client/tsdown.client.ts' ':!CONTRIBUTING.md' ':!CONTRIBUTING.zh.md' ':!CONTRIBUTING.i18n.yaml' ':!CODE_OF_CONDUCT.md' ':!CODE_OF_CONDUCT.zh.md' ':!CODE_OF_CONDUCT.i18n.yaml' ':!SECURITY.md' ':!SECURITY.zh.md' ':!SECURITY.i18n.yaml' ':!SAFETY.md' ':!SAFETY.zh.md' ':!SAFETY.i18n.yaml' ':!LICENSE' ':!THIRD_PARTY_NOTICES.md' ':!package.json' ':!scripts/translation-pairing.ts' ':!scripts/gen-third-party-notices.ts' ':!scripts/gen-third-party-notices.spec.ts' ':!scripts/verify-dsh-package-licenses.ts' ':!scripts/verify-dsh-package-licenses.spec.ts' ':!scripts/no-unknown-casts.baseline.json' ':!scripts/verify-repository-references.ts' ':!scripts/verify-concrete-terms.ts' ':!scripts/rescope-vendor.ts' ':!AGENTS.md' ':!scripts/doc-budgets.manifest.json' ':!scripts/gen-replay-override.mjs' ':!packages/test-support/session-snapshot/src/normalize.ts' ':!packages/test-support/session-snapshot/tests/normalize.spec.ts' ':!snapshots/session/map-layer-workbench' ':!snapshots/session/ptc-python-turn/cordis.yml' ':!snapshots/session/ptc-python-turn/cordis.snapshot.yml' ':!docs/development.md' ':!docs/development.zh.md' ':!docs/development.i18n.yaml' ':!packages/test-support/session-snapshot/src/manifest.ts' ':!packages/test-support/session-snapshot/tests/manifest.spec.ts' ':!scripts/session-snapshot-corpus-policy.ts' ':!scripts/session-snapshot-corpus-policy.spec.ts' ':!snapshots/AGENTS.md' ':!packages/test-support/session-snapshot/src/identity.ts' ':!packages/test-support/session-snapshot/tests/identity.spec.ts' ':!packages/test-support/session-snapshot/README.md' ':!packages/test-support/session-snapshot/README.zh.md' ':!packages/test-support/session-snapshot/README.i18n.yaml' ':!snapshots/session/map-analyst-turn' ':!snapshots/session/map-facility-decision' ':!snapshots/session/map-lbs-denied' ':!snapshots/session/map-data-resourcing' ':!snapshots/session/map-layer-styles' ':!docs/upgrade-guide/v0.2.0-rc.2/map-lbs-protocol' ':!docs/upgrade-guide/v0.2.0-rc.2/map-layer-presentation' ':!packages/api/session-controller/src/client/index.ts' ':!packages/api/session-controller/tests/client-apply.client.spec.ts' ':!packages/api/session-controller/README.md' ':!packages/api/session-controller/README.zh.md' ':!packages/api/session-controller/README.i18n.yaml' ':!packages/client/connection/src/client/index.ts' ':!packages/client/connection/tests/client-apply.client.spec.ts' ':!packages/client/connection/README.md' ':!packages/client/connection/README.zh.md' ':!packages/client/connection/README.i18n.yaml'
```

`pnpm-lock.yaml` 以导入的上游 lockfile 为真源。上游 package manifest 若改变 workspace range、增加 importer 或调整 patched dependency，direct specifier 可以随上游同步；map 侧只能重新注入 `map/*` workspace/importer 所需条目，不得手工制造与上游 manifest 不一致的版本。根级自有门面文件集：`README.md`/`README.zh.md` 及其 i18n 记录、`README.upstream` 双语（上游 README 的仓内副本，License 节链接重指 THIRD_PARTY_NOTICES.md 保存节）、`CONTRIBUTING`（双语+i18n）、`CODE_OF_CONDUCT`（双语+i18n）、`SECURITY`（三件套）、`SAFETY`（三件套，仅许可指针行与上游分叉）、`LICENSE`（AGPL-3.0，上游 MIT 全文保存于 THIRD_PARTY_NOTICES.md）、`THIRD_PARTY_NOTICES.md`（生成物，导入后重新执行 `pnpm run gen-third-party-notices`）、根 `package.json`（门面字段 description/license 自有；direct specifier 随上游手工同步）。导入时不随上游覆盖上述文件。

`snapshots/session/map-analyst-turn/`、`snapshots/session/map-facility-decision/`、`snapshots/session/map-lbs-denied/`、`snapshots/session/map-data-resourcing/` 、`snapshots/session/map-layer-styles/` 与 `snapshots/session/map-layer-workbench/` 是 map 自有 Session 场景，使用上游快照运行器；导入时保留这些目录。已提交 JSONL 代际不可覆盖，写入器升级只新增 successor。回放配置的插件名必须与新 base 行相同，避免真实 adapter 与 replay adapter 同时注册。

`docs/upgrade-guide/v0.2.0-rc.2/map-lbs-protocol/` 是 map 自有升级说明，使用上游规定的三文件格式并保留在导入白名单中；它描述LBS坐标、网络身份和授权错误变化。`docs/upgrade-guide/v0.2.0-rc.2/map-layer-presentation/` 同为 map 自有升级说明，描述图层呈现词汇（meta v5）与影像图层。

## 需重放的上游补丁

白名单允许的是以下改动，不是文件内任意差异。导入前保存相对上游基线的局部补丁；导入新版文件后逐块重放，禁止用旧文件整体覆盖新版。源码、回归测试和双语配对记录一起维护。

| 文件 | 保留内容 | 验证与退休条件 |
| --- | --- | --- |
| `packages/test-support/session-snapshot/src/manifest.ts`、`tests/manifest.spec.ts`、该包 README 双语及配对、`scripts/session-snapshot-corpus-policy.ts` 及 spec、`snapshots/AGENTS.md` | `behavior-baseline` 固定当前格式的原始录制，当前输出独立写入 writer oracle；不占当前格式的历史角色预算，也不冒充迁移覆盖 | manifest/policy 正反例及三个 map owner refresh/replay，原始 generations 无 diff；上游等价支持不可变行为基线后退休 |
| `packages/client/connection/src/client/index.ts`、`tests/client-apply.client.spec.ts`、该包 README 双语及配对 | 回环及页面自有 Host 不因 navigator.onLine=false 暂停连接；streamBaseUrl 决定网络依赖分类，安全权限不变 | Connection 三条 focused suites 与 offline-hint 地图浏览器回归；上游等价覆盖本机启动/恢复及远程离线暂停后退休 |
| `packages/api/session-controller/src/client/index.ts`、`tests/client-apply.client.spec.ts`、该包 README 双语及配对 | 每个 Host generation 创建独立 control consumer，释放旧流并阻止迟到 baseline；已终止的消费者不能复用 | client-apply/transport 测试及地图服务重启浏览器回归；上游等价实现通过终止流后重连及延迟卸载测试后退休 |
| `packages/client/tsdown.client.ts` | CSS virtual-id 的 `?inline` 兼容处理 | 重建客户端；上游等价处理同时保留 inline 默认导出时移除本地补丁 |
| `docs/development.md`、`docs/development.zh.md`、`docs/development.i18n.yaml` | ptc-python 的 CPython 3.10+ 主机前置要求 | 双语同步后重录配对；上游已写明同一要求时移除本地文字补丁，不覆盖新版其余内容 |
| `snapshots/session/ptc-python-turn/cordis.yml`、`cordis.snapshot.yml` | ptc-runtime-python 的 `pythonBin` 读 `PTC_PYTHON_BIN`，缺省 `python3` | 该场景回放在 python3 < 3.10 主机上通过；上游提供等价解释器配置后退休 |
| `packages/test-support/session-snapshot/src/normalize.ts`、`tests/normalize.spec.ts` | map 会话的归一化扩展（与 identity.ts 同批） | 与 identity 补丁同步退休 |
| 根 `AGENTS.md`、`scripts/doc-budgets.manifest.json` | 「Project-specific engineering facts」节及对应字数上限 | 文本迁入 map 文档后退休 |
| `scripts/gen-replay-override.mjs` | map 会话 `replay.override.json` 的 `{{fromRequest:...}}` 重生成脚本（自有新增文件） | 重录 map 场景后运行并回放通过；上游提供等价绑定后退休 |
| `packages/test-support/session-snapshot/src/identity.ts`、`tests/identity.spec.ts`、该包 README 双语及配对 | map 工具 JSON 的读取点/产物/run 身份（含 `data_import`/`data_export` 的资源/制品 ref 归一化与 `layer_set_state`/`layer_set_style` 的结果归一化）与 spatial-context 来源限定的时钟 token；不归一化业务指标 | identity 正负样本与两个 map 会话回放；上游提供等价的来源限定支持且这些回放通过后退休 |

`scripts/verify-dsh-package-licenses.ts` 的 package name 类型收窄随既有脚本分叉保留；`scripts/rescope-vendor.ts` 的产品数据跳过随既有 GENERIC_SKIPS 分叉保留。同步这两个脚本时同时审阅既有差异，不能只保留最新修复。上游吸收任一补丁后，在同一更新提交中删除对应白名单项；仍有其他自有改动的文件继续登记。

## 导入和解记录（2026-10-04）

10-02 导入（基线 2599fdcec2，上游 tag `dsh-v0.2.0-rc.2` = 639ed015）因未锚定的 rsync 排除项漏掉全部包级英文 `README.md`，且无 `--delete` 使部分文件滞留旧版。2026-10-04 按全树对账（git ls-files vs tag tarball）分两轮和解，终态：**自有白名单之外与 tag 逐字节一致，dropped 为零**。

第一轮（opensource-prep 核查轮）：恢复 32 个漏带的包级 `README.md` 与 `packages/settings/settings/README.md` 滞留内容（该 README 载有「No invariant companion is published」理由句，`verify-package-invariants` 依赖它）。

第二轮（import-drift 修复轮）：
- **恢复 207 个滞留文件到 tag 原文**：其余 179 个包级 EN README、`apps/` 7 个（含 `apps/cli/README.i18n.yaml`）、`docs/` 4 个、`native/` 1 个、`python/sdk-runtime` 1 个、`.github/` 1 个、`vendor/` 5 个 vendor README——10-02 导入曾把 vendor/README.md preamble 换成 master 措辞并追加记录 22，与 tag 版 `rescope-vendor` 脚本的 exact edit 不再吻合，以及 `.agents/notes/` 的 README 与 8 个 i18n/确认记录（EN 与记录刷回 tag 后与 zh 侧天然一致）。
- **补跟踪 5 个 snapshots fixture**：3 个 `.dsh/skills/**/SKILL.md`（根 `.gitignore` 未锚定的 `.dsh/` 误伤）、`app.local`（fixture 自带 `*.local` 规则，上游以 force-add 跟踪）、CJK 文件名 `说明.txt`；根 `.gitignore` 相应锚定 `/.dsh/`、`/.mapharness/`，补 `.dsh-build/` 与上游防护条目（`.p12`、`.env` 变体、`.storages/`、`.sessions/`）。
- **三个门禁脚本自有分叉**（登记于零冲突白名单）：`verify-repository-references.ts`、`verify-concrete-terms.ts` 排除前缀加 `.spec/`、`map/`；`rescope-vendor.ts` 的 GENERIC_SKIPS 增补 inspect 事件名豁免。

零冲突检查若以 2599fdcec2 为基线，会列出和解文件集与上述三个脚本；其内容等于上游 tag 原文或已登记的自有分叉，属本记录覆盖的和解类差异，下次全量导入后按新基线自然收敛。

## 导入记录（2026-10-21，0.2.1-rc.2）

本轮不用 rsync：以 tag 树 `git checkout <tag> -- .` 为底、按上游 diff 删除已移除文件，再用 `git apply --3way` 重放 `<旧基线>..HEAD` 的非 map 补丁，上游删除与新增天然对齐。上游 634d7e96dc 以 `await using` 关闭 pnpm 日志句柄，plugin-manager 补丁退休。上游断裂点：`session-persistence-jsonl` 改为模块插件（无 default export，消费方用 `import * as`）；`presentationMeta` 对 nested 调用同样计算；runtime context 新增 working-directory 段，map 会话快照随之 refresh。

## 更新步骤

1. **准备**：确认工作树干净，记录当前上游基线 commit：
   ```sh
   git checkout main && git pull
   git checkout -b spec/YYYY-MM-DD_update-upstream-<version>
   ```
2. **导入新版本**：先保存「需重放的上游补丁」中的局部差异，再解压新版 deepseek-harness zip，覆盖上游文件区（**不覆盖** `map/`、`.spec/`、`.gitignore`、`pnpm-workspace.yaml`、根级自有门面文件集——`README.md`/`README.zh.md`/`README.i18n.yaml`、`CONTRIBUTING.*`、`CODE_OF_CONDUCT.*`、`SECURITY.*`、`SAFETY.*`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`package.json`、`scripts/translation-pairing.ts`、`scripts/gen-third-party-notices.ts`）。排除项必须以 `/` 锚定在解压根：rsync 无斜杠模式按文件名递归匹配任意层级，10-02 导入即因未锚定的 `README.md` 漏掉全部包级英文 README：
   ```sh
   rsync -a --exclude '.git' <new-extract>/ ~/dev/map-harness/ \
     --exclude '/map' --exclude '/.spec' --exclude '/.gitignore' \
     --exclude '/snapshots/session/map-analyst-turn' --exclude '/snapshots/session/map-facility-decision' --exclude '/snapshots/session/map-lbs-denied' --exclude '/snapshots/session/map-data-resourcing' --exclude '/snapshots/session/map-layer-styles' --exclude '/snapshots/session/map-layer-workbench' \
     --exclude '/docs/upgrade-guide/v0.2.0-rc.2/map-lbs-protocol' --exclude '/docs/upgrade-guide/v0.2.0-rc.2/map-layer-presentation' \
     --exclude '/README.md' --exclude '/README.zh.md' --exclude '/README.i18n.yaml' --exclude '/README.upstream.md' --exclude '/README.upstream.zh.md' \
     --exclude '/CONTRIBUTING.md' --exclude '/CONTRIBUTING.zh.md' --exclude '/CONTRIBUTING.i18n.yaml' \
     --exclude '/CODE_OF_CONDUCT.md' --exclude '/CODE_OF_CONDUCT.zh.md' --exclude '/CODE_OF_CONDUCT.i18n.yaml' \
     --exclude '/SECURITY.md' --exclude '/SECURITY.zh.md' --exclude '/SECURITY.i18n.yaml' \
     --exclude '/SAFETY.md' --exclude '/SAFETY.zh.md' --exclude '/SAFETY.i18n.yaml' \
     --exclude '/LICENSE' --exclude '/THIRD_PARTY_NOTICES.md' --exclude '/package.json' \
     --exclude '/scripts/translation-pairing.ts' --exclude '/scripts/gen-third-party-notices.ts' --exclude '/scripts/gen-third-party-notices.spec.ts' --exclude '/scripts/verify-dsh-package-licenses.ts' --exclude '/scripts/verify-dsh-package-licenses.spec.ts' --exclude '/scripts/no-unknown-casts.baseline.json' --exclude '/scripts/verify-repository-references.ts' --exclude '/scripts/verify-concrete-terms.ts' --exclude '/scripts/rescope-vendor.ts'
   # 恢复唯一允许的上游追加行
   git checkout -- pnpm-workspace.yaml   # 然后手工重加 map/* 三行，或用 git stash 保留
   ```
   更稳妥的做法：先 `git stash` 或把 `pnpm-workspace.yaml` 备份，rsync 后恢复。导入后重新执行 `pnpm install && pnpm run gen-third-party-notices` 再生成 THIRD_PARTY_NOTICES.md。
3. **完整性对账**：先在新版文件上逐块重放仍需保留的补丁，执行对应验证；上游已等价修复的项按表退休。rsync 不带 `--delete`（工作区含 `node_modules/`、构建产物，不能让上游树删它们），因此既会漏带也会滞留。导入后与上游 tag 逐字节对账（对 `git ls-files` 的每个上游文件与解压树比对，并列出解压树有而索引没有的文件）；两类清单为空（或全部落在自有白名单）才继续。10-02 导入的漏带与滞留正是缺这一步才存活到 2026-10-04（见下文和解记录）。
4. **零冲突检查**：跑上面的检查命令，确认除白名单文件外无 diff。
5. **重装依赖**：
   ```sh
   pnpm install
   ```
   lockfile diff 审阅：direct specifier 不变、只有传递依赖/metadata 漂移即接受。
6. **重建上游**：
   ```sh
   pnpm run build:lib && pnpm run build:web
   ```
7. **重建 map 层**：
   ```sh
   pnpm --filter @map-harness/client-ui-brand run build
   ```
8. **冒烟**：
   ```sh
   pnpm vitest run packages/core/tools packages/core/session
   MAPHARNESS_HOME=$(mktemp -d) node map/bin/map-harness.mjs --dump-config | grep -A2 map-client-ui-brand
   MAPHARNESS_HOME=$(mktemp -d) node map/bin/map-harness.mjs --profile map-web web --no-open &
   curl -s -o /dev/null -w '%{http-code}' http://127.0.0.1:3080   # 期望 200
   ```
9. **提交**：`feat: update upstream deepseek-harness to <version>`，归档进 spec 任务包。

## 断裂面与修复点

上游更新可能改变以下契约；map 层的对应物与修复方式：

| 上游契约 | map 层消费点 | 断裂症状 | 修复 |
|---|---|---|---|
| `sidebar.brand.mark`/`name` 插槽（`ui-sidebar`） | `map/client-ui-brand/src/client` | 品牌行不渲染/类型错误 | 对齐 props 契约 |
| `ui-brand-official` patch 行 id（`web-app` bundle） | `map/profiles/map-web/cordis.patch.yml` | 官方品牌回来（disable 未命中） | 更新 patch 的 id |
| `dsh.bundle.patch` / `dsh.profile.bundles` 字段 | `map/profiles/map-web/package.json`、wrapper | profile 启动报「declares no dsh.bundle」 | 对齐字段名 |
| closure-factory 浏览器产物契约（`window.__ModuleLoader__`） | `map/client-ui-brand/tsdown.config.ts` | 浏览器 roster 加载失败 | 对齐 banner/footer 格式 |
| `lib/types` 前置 tsc 产物路径 | map 包 build script | build 报缺文件 | 对齐 build 顺序 |
| `@tsdown/css` 重新附加 `?inline` | `packages/client/tsdown.client.ts` | client build 把 `.mjs?inline` 当物理 CSS 路径或丢失默认导出 | 先剥离 virtual-id query，再按 inline 语义返回 CSS 文本 |
