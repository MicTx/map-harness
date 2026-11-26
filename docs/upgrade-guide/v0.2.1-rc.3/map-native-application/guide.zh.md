---
kind: upgrade-guide
description: "Map Harness Release 安装从 Node workspace 运行包切换为脚本启动的原生 Web 服务。"
---

# Map Harness 原生 Web 服务

[English](guide.md) | 中文

## 变更

Map Harness Release 用户解压无源码 Web 服务包，替代 workspace 归档的 `install.sh`/`start.sh` 启动方式。包内包含原生服务程序、锁定 Node 引擎、编译地图核心、辅助工具、清单和许可。浏览器显示与交互保留 JavaScript，地图主机实现使用编译代码。每个版本仅支持实际附带并通过验收的脚本归档目标。

## 迁移

1. 保留现有 `~/.dsh` 状态目录，或 `MAPHARNESS_HOME` 指定的目录；不要把用户状态放进解压后的程序目录。
2. 从 `web-service-release.json` 选择已验收的服务主机目标，对照 `SHASUMS256.txt` 校验归档，解压到新程序文件夹，不要覆盖旧的 workspace 发行目录。
3. Windows 运行 `start-web.cmd`，macOS/Linux 运行 `./start-web.sh`。Windows 需要 Windows PowerShell；无需安装 Node.js、Python 或应用安装器。按引导把自己的 DeepSeek 密钥保存到包外受保护凭据库，后续启动直接复用；无人值守的直通服务调用使用 `--no-onboarding`。
4. 确认服务检查实际 Web 页面后输出本机访问 URL。升级时先停止旧服务，再把新版本解压到干净程序目录。凭据与选项见[安装引导](../../../../map/docs/release-install-guide.md)。
