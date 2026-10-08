# 上游更新流程（deepseek-harness → map harness）

当前上游基线来自 GitHub `master`；同步前用 `git ls-remote --symref https://github.com/deepseek-ai/deepseek-harness.git HEAD` 解析默认分支和提交，不假设分支名为 `main`。

本仓库的上游文件区（`packages/`、`apps/`、`vendor/`、`scripts/`、`docs/`、`snapshots/`、`native/`、`python/`、`benchmarks/`、`website/`、`.agents/`、`.github/`、根级上游配置）保持 deepseek-harness 原样；本仓库自有层全部在 `map/`。兼容性补丁位于 `packages/client/tsdown.client.ts`：上游 `0.2.0-rc.2` 的 CSS virtual id 在安装 `@tsdown/css` 后可能重新附加 `?inline`，补丁在读取前剥离该 query，并保留 inline 默认导出。上游更新时按本流程执行，并重新验证该补丁是否仍需要；`scripts/` 自有修改与根级门面文件见下文白名单。

Map 层有一个根级安装策略例外：`pnpm-workspace.yaml` 的 `allowBuilds` 拒绝 `@vaadin/vaadin-usage-statistics`，因为它由 `@arcgis/core` 间接引入，地图渲染不需要其 telemetry postinstall。该策略不得放行脚本，只能保持显式拒绝。

## 零冲突检查（导入前后各跑一次）

上游文件区的允许差异是 `pnpm-workspace.yaml` 末尾追加的 `map/*` 三行注释 + glob、`packages/client/tsdown.client.ts` 的 CSS virtual-id 兼容补丁、`scripts/` 自有修改（`scripts/translation-pairing.ts` 的根级配对白名单、`scripts/gen-third-party-notices.ts` 的许可模板及其 spec 断言，含上游 MIT 全文保存节；`verify-dsh-package-licenses` 双文件与 `no-unknown-casts.baseline.json`——AGPL 分家策略与 map 层存量 cast 基线属本仓库；`verify-repository-references.ts` 与 `verify-concrete-terms.ts` 的排除前缀加 `.spec/`、`map/`——私有任务包与自有层不是被巡查的上游维护面；`rescope-vendor.ts` 的 GENERIC_SKIPS 增补 inspect 事件名豁免——`cordis/inspect-query(-resolved)` 是事件标识符而非模块名），以及下一段登记的根级自有门面文件。检查命令：

```sh
# 除 pnpm-workspace.yaml 与 CSS virtual-id 兼容补丁外，不能出现其他上游文件
git diff --name-only <upstream-base-commit>..HEAD -- ':!map' ':!.spec' ':!.gitignore' ':!pnpm-workspace.yaml' ':!pnpm-lock.yaml' ':!README.md' ':!README.zh.md' ':!README.i18n.yaml' ':!README.upstream.md' ':!README.upstream.zh.md' ':!packages/client/tsdown.client.ts' ':!CONTRIBUTING.md' ':!CONTRIBUTING.zh.md' ':!CONTRIBUTING.i18n.yaml' ':!CODE_OF_CONDUCT.md' ':!CODE_OF_CONDUCT.zh.md' ':!CODE_OF_CONDUCT.i18n.yaml' ':!SECURITY.md' ':!SECURITY.zh.md' ':!SECURITY.i18n.yaml' ':!SAFETY.md' ':!SAFETY.zh.md' ':!SAFETY.i18n.yaml' ':!LICENSE' ':!THIRD_PARTY_NOTICES.md' ':!package.json' ':!scripts/translation-pairing.ts' ':!scripts/gen-third-party-notices.ts' ':!scripts/gen-third-party-notices.spec.ts' ':!scripts/verify-dsh-package-licenses.ts' ':!scripts/verify-dsh-package-licenses.spec.ts' ':!scripts/no-unknown-casts.baseline.json' ':!scripts/verify-repository-references.ts' ':!scripts/verify-concrete-terms.ts' ':!scripts/rescope-vendor.ts'
```

`pnpm-lock.yaml` 以导入的上游 lockfile 为真源。上游 package manifest 若改变 workspace range、增加 importer 或调整 patched dependency，direct specifier 可以随上游同步；map 侧只能重新注入 `map/*` workspace/importer 所需条目，不得手工制造与上游 manifest 不一致的版本。根级自有门面文件集：`README.md`/`README.zh.md` 及其 i18n 记录、`README.upstream` 双语（上游 README 的仓内副本，License 节链接重指 THIRD_PARTY_NOTICES.md 保存节）、`CONTRIBUTING`（双语+i18n）、`CODE_OF_CONDUCT`（双语+i18n）、`SECURITY`（三件套）、`SAFETY`（三件套，仅许可指针行与上游分叉）、`LICENSE`（AGPL-3.0，上游 MIT 全文保存于 THIRD_PARTY_NOTICES.md）、`THIRD_PARTY_NOTICES.md`（生成物，导入后重新执行 `pnpm run gen-third-party-notices`）、根 `package.json`（门面字段 description/license 自有；direct specifier 随上游手工同步）。导入时不随上游覆盖上述文件。

## 导入和解记录（2026-10-04）

10-02 导入（基线 2599fdcec2，上游 tag `dsh-v0.2.0-rc.2` = 639ed015）因未锚定的 rsync 排除项漏掉全部包级英文 `README.md`，且无 `--delete` 使部分文件滞留旧版。2026-10-04 按全树对账（git ls-files vs tag tarball）分两轮和解，终态：**自有白名单之外与 tag 逐字节一致，dropped 为零**。

第一轮（opensource-prep 核查轮）：恢复 32 个漏带的包级 `README.md` 与 `packages/settings/settings/README.md` 滞留内容（该 README 载有「No invariant companion is published」理由句，`verify-package-invariants` 依赖它）。

第二轮（import-drift 修复轮）：
- **恢复 207 个滞留文件到 tag 原文**：其余 179 个包级 EN README、`apps/` 7 个（含 `apps/cli/README.i18n.yaml`）、`docs/` 4 个、`native/` 1 个、`python/sdk-runtime` 1 个、`.github/` 1 个、`vendor/` 5 个 vendor README——10-02 导入曾把 vendor/README.md preamble 换成 master 措辞并追加记录 22，与 tag 版 `rescope-vendor` 脚本的 exact edit 不再吻合，以及 `.agents/notes/` 的 README 与 8 个 i18n/确认记录（EN 与记录刷回 tag 后与 zh 侧天然一致）。
- **补跟踪 5 个 snapshots fixture**：3 个 `.dsh/skills/**/SKILL.md`（根 `.gitignore` 未锚定的 `.dsh/` 误伤）、`app.local`（fixture 自带 `*.local` 规则，上游以 force-add 跟踪）、CJK 文件名 `说明.txt`；根 `.gitignore` 相应锚定 `/.dsh/`、`/.mapharness/`，补 `.dsh-build/` 与上游防护条目（`.p12`、`.env` 变体、`.storages/`、`.sessions/`）。
- **三个门禁脚本自有分叉**（登记于零冲突白名单）：`verify-repository-references.ts`、`verify-concrete-terms.ts` 排除前缀加 `.spec/`、`map/`；`rescope-vendor.ts` 的 GENERIC_SKIPS 增补 inspect 事件名豁免。

零冲突检查若以 2599fdcec2 为基线，会列出和解文件集与上述三个脚本；其内容等于上游 tag 原文或已登记的自有分叉，属本记录覆盖的和解类差异，下次全量导入后按新基线自然收敛。

## 更新步骤

1. **准备**：确认工作树干净，记录当前上游基线 commit：
   ```sh
   git checkout main && git pull
   git checkout -b spec/YYYY-MM-DD_update-upstream-<version>
   ```
2. **导入新版本**：解压新版 deepseek-harness zip，覆盖上游文件区（**不覆盖** `map/`、`.spec/`、`.gitignore`、`pnpm-workspace.yaml`、根级自有门面文件集——`README.md`/`README.zh.md`/`README.i18n.yaml`、`CONTRIBUTING.*`、`CODE_OF_CONDUCT.*`、`SECURITY.*`、`SAFETY.*`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`package.json`、`scripts/translation-pairing.ts`、`scripts/gen-third-party-notices.ts`）。排除项必须以 `/` 锚定在解压根：rsync 无斜杠模式按文件名递归匹配任意层级，10-02 导入即因未锚定的 `README.md` 漏掉全部包级英文 README：
   ```sh
   rsync -a --exclude '.git' <new-extract>/ ~/dev/map-harness/ \
     --exclude '/map' --exclude '/.spec' --exclude '/.gitignore' \
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
3. **完整性对账**：rsync 不带 `--delete`（工作区含 `node_modules/`、构建产物，不能让上游树删它们），因此既会漏带也会滞留。导入后与上游 tag 逐字节对账（对 `git ls-files` 的每个上游文件与解压树比对，并列出解压树有而索引没有的文件）；两类清单为空（或全部落在自有白名单）才继续。10-02 导入的漏带与滞留正是缺这一步才存活到 2026-10-04（见下文和解记录）。
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
