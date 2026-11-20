---
kind: upgrade-guide
description: "公开 GitHub 仓 main 由仅含发布文档改为承载允许清单完整源码树，自有代码改用 PolyForm Noncommercial 1.0.0。"
---

# 公开仓发布完整源码

[English](guide.md) | 中文

## 变更

此前发布把四个说明与许可文件写入公开仓 main，并以混淆后的地图模块分发脚本启动的 Web 服务归档；Map 自有代码采用运行使用许可。本版改为在孤儿公开快照中发布允许清单完整源码树，把 Map 自有代码重许可为 [PolyForm Noncommercial License 1.0.0](../../../../LICENSE)，并分发普通编译产物。私有 Gitea 仍是开发真源；私有历史、agent 状态、`.env*` 文件与维护者发布流程均被排除。旧版本保留随附许可。

克隆公开仓、从源码构建、再分发代码或检查 release 附件的用户都会看到这一变化。商业使用仍须另行书面授权。上游 DSH 保持 MIT，第三方权利不变。

## 迁移

1. 把所有自有 manifest 中的 `LicenseRef-Map-Harness-Use-Only` 声明替换为 `PolyForm-Noncommercial-1.0.0`，并更新匹配旧标识的工具。
2. 克隆公开仓后依次运行 `pnpm install` 与 `node map/bin/build-web.mjs`；源码树现在可直接解析工作区依赖。不要再假定 Source code ZIP 只含文档。
3. release 归档中的地图模块是可读的编译 JavaScript，不再是混淆字节；移除比对保护字节清单的校验。Web 服务 qualification 与 manifest 摘要校验仍然有效。
4. 源码要约说明改指向公开仓及其 release tag；`THIRD_PARTY_NOTICES.md` 继续由 `scripts/gen-third-party-notices.ts` 生成。
5. 运行 `pnpm run doc-sync`、`pnpm exec vitest run scripts/gen-third-party-notices.spec.ts scripts/verify-dsh-package-licenses.spec.ts` 与 `node map/bin/audit-public-tree.mjs --evidence <dir>` 确认迁移完成；审计应报告零违规且不含被排除路径。
