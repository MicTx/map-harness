# 图层工作台全链路验收

本案例验证 P1–P3 交付的迁移能力在同一会话内贯通：导入确认、检索成图、对话样式、面板回流、按引用导出获取、保存与重启恢复，以及失败路径的诚实拒绝。所有医院、道路与 POI 数据均为合成数据；卫星底图只提供位置参照。

## 结果与方法

| 项目 | 可判定结果 |
| --- | --- |
| 导入确认 | 歧义 CSV（x/y 弱别名）停在 `needs_confirmation` 且目录零行；确认指纹重调后一次往返发布 v1；WGS84 `.prj` 的 Shapefile 免确认导入；GBK 编码表头经显式 `encoding` 导入 |
| 检索成图 | fixture 天地图 `/v2/search` 两页合成 POI 注册为同名资源 v1→v2；`viz_aggregate` 网格密度层入图；限流失败码在对话可见且零新层 |
| 对话样式 | `layer_set_style` 预设改符号后面板 chip 主色与画布像素同源（chip 即像素 oracle）；逐要素覆盖改色经同一 `symbolVersion`/`overridesVersion` 生效；heatmap 与 imagery 家族入图 |
| 面板回流 | 组隐藏排队的 `[map-panel v1]` 批次以用户输入到达模型，经 `layer_set_state` 生效，pending 清除；模型驱动变更零新增面板请求 |
| 冲突可见性 | 过期 `expected_revision` 是可见拒绝且不烧修订；重试成功；`map_undo` 逐操作补偿 |
| 导出获取 | `data_export map:true` 逐层制品；对话粘贴 ref 经「按引用下载」取得字节，SHA-256 与制品记录一致；层下载按钮直取资源版本字节 |
| 保存恢复 | `map_save` 后杀进程树、同 `MAPHARNESS_HOME` 重启：投影 revision、图层、符号、分组、面板与制品路由全部恢复；业务级目录关闭重开恢复同 ref 同 digest |
| 负样本 | 截断 `.shp` 稳定拒绝且 `catalog_resolve` 零新行；revoked 源导出拒绝（`GOVERNANCE_REVOKED`）；畸形导入零残留 |

本案例不证明真实天地图服务或真实 LIVE 模型变体（见「未验证范围」）。

## 自动验证

从仓库根运行：

```sh
node --test --experimental-strip-types map/tools/tests/layer-workbench.spec.mjs
pnpm run test:snapshot -t map-layer-workbench
```

第一条通过真实工具、真实目录/存储与 JSONL 持久化核对跨工具串联、导出字节 digest、关闭重开恢复与三类负样本；错误覆盖期望的负样本必须被拒绝。

第二条回放真实 DeepSeek 录制的会话。`snapshots/session/map-layer-workbench/` 保存 inbox 任务、工具 schema pin 头与请求头；回放仍执行真实工具（导入、检索、样式、状态、导出、保存全部重算），绝不替换成录制结果。检索 leg 由进程内 fixture transport 承载（`poi-fixture-plugin.mjs`，配置面 `spatial-connect` 的 `baseUrl` 指向拦截主机），录制与回放同样不触网；面板步骤按 detail R4 的「等价用户文本」选择录制。在线检索时间戳经快照支撑面的窄域 `retrieved_at` token 归一。

重录需要有效 `DEEPSEEK_API_KEY`；本次录制时根 `.env` 的同名变量已失效（401），遂以同文件 `DEEPSEEK_OFFICIAL_API_KEY` 的已验证值注入执行。重录须复核调用顺序；任务来自 Session 原始 inbox 消息。

## 浏览器验证

构建 Web 后运行专属用例：

```sh
node map/bin/build.mjs
node map/bin/build-web.mjs
pnpm --filter @map-harness/arcgis-mcp run test:composition
```

四条 `layer workbench:` 前缀用例通过真实 map-web 应用与 Chromium 执行：导入确认链（两段确认、SHP 成层、畸形零残留）、样式与面板一致性链（chip=像素、组批量回流、对话获知、零反馈循环、过期修订、heatmap/imagery 家族）、导出与重启恢复链（digest 一致、按引用下载、进程重启全一致）、POI 链（fixture 检索成层与密度、限流诚实、分页版本递增）。既有 `layer management` 用例的显隐已迁移至 `set-layer-state`；`requiredMapTools` 断言面已补 `data_import`/`data_export`/`layer_set_state`/`layer_set_style`。模型传输在默认 lane 中是本地脚本化轮次，业务工具与存储不是替身。聚焦用例可用 `--test-name-pattern='layer workbench:'` 复跑。

`rendered pixels` 既有用例在本机 SwiftShader 下以 zoom 8 不绘制大类面（原始树同败，非本案例回归），已按 lane 自身惯例补 fixture 底图路由并改 zoom 9，语义不变。

## 证据归属

三层互不替代：模型场景提供端到端调用与报告证据；业务测试提供独立答案与失败路径；浏览器用例提供实际界面、渲染回执与交互证据。全链 GIF（A–F 分镜、真实服务 + 真实模型、单次连续运行）产出于 gitignored `.playwright-mcp/gif-run/layer-workbench-full-chain.gif`，其 SHA、树、速度标志与隔离条件披露于同目录 `DISCLOSURE.md`；因本集群不授权 GitHub 发布，GIF 未随 PR attach，保留本地。

### 未验证范围

- 真实天地图服务未验证：P4 门禁为 fixture 检索（受控 `/v2/search` wire）；真实 `TIANDITU_API_KEY` 的 key-activated lane 未运行。
- `MAP_LAYER_WORKBENCH_LIVE=1` 真实模型浏览器变体未实现为独立开关：真实模型证据由快照录制与 GIF 承担（有效 key 条件下）。
- ~~`map-facility-decision` 既有场景回放漂移~~ 已修复：以真实模型同任务重录（实测证据不变：150/350、200/350、top=east、revision 4），keyless 回放与组合用例绿。
- ~~语料 pin 政策违例~~ 已修复（2026-10-20 语料迁移）：`map-analyst-turn`、`map-facility-decision`、`map-lbs-denied` 三个场景迁移为 current-writer pin——canonical 重录至当前工具输出、writer oracle 移除、`replay.override.json` 由 `scripts/gen-replay-override.mjs` 从所选 fixture 确定性再生（`fromRequest` 按稳定的 request digest 绑定活运行 id）；比较入口新增 packed 载荷折叠与 identity 别名，使分片 id 在两侧同 token。GLM 网关证据冻结在 `map-analyst-turn` 的保留 V3 代际，由 `map/tests/glm-deepseek-parity.spec.mjs` 显式读取。ptc-python 组合的 `pythonBin` 现可经 `PTC_PYTHON_BIN` 覆写（默认 PATH 解析）：本机系统 python3 为 3.9.6，指定 3.11 后全量快照族 186/188 绿（2 平台跳过）。
- GIF 未发布到任何远端：开发真源为私有 Gitea，GitHub 发布未获授权；产物与披露仅存本地。

其余能力与覆盖缺口见[验证矩阵](verification-matrix.md)。
