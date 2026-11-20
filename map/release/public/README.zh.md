# Map Harness

[English](README.md) | 中文

Map Harness 为 AI 智能体工作区提供实时地图画布与空间分析工具。

从 [Releases](https://github.com/MicTx/map-harness/releases) 下载脚本启动的 Web 服务包。本仓按下方许可公开发布完整允许清单源码树；release 附件是预编译的 Web 服务归档。

## 安装

下载与运行 Web 服务的计算机操作系统及 CPU 对应的附件，并对照 `SHASUMS256.txt` 校验 SHA-256；`web-service-release.json` 列出已验收目标及其附件。解压后，Windows 运行 `start-web.cmd`，macOS/Linux 运行 `./start-web.sh`。启动脚本校验发行包，引导首次凭据配置，启动服务并检查实际 Web 页面，最后输出完整访问地址。无需 Node.js、npm、Python、桌面安装器、源码或本地编译；Windows 使用 Windows PowerShell。仅在配置模型访问时需要你自己的 DeepSeek API Key，输入隐藏并保存在程序目录之外。仅该版本实际附带并通过验收的目标受支持。访问服务的浏览器不必与服务主机使用相同平台。

## 功能

- 检索地点与地理资源。
- 用自然语言绘制和管理图层。
- 创建、编辑、恢复并导出私有地图标注。
- 选择受控底图与文字注记。
- 执行空间分析、比较选址方案。
- 查看地图截图，在对话中保留地理上下文。

## 许可

Map Harness 以 [PolyForm Noncommercial License 1.0.0](https://github.com/MicTx/map-harness/blob/main/LICENSE) 发布；商业使用需另行书面授权。旧版本保留随附的许可。上游 DSH 继续适用 MIT；第三方许可权利和必要的源码要约保留在 [THIRD_PARTY_NOTICES.md](https://github.com/MicTx/map-harness/blob/main/THIRD_PARTY_NOTICES.md)。
