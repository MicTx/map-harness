# 设施选址与人口覆盖验收

本案例用三个人口点和两个设施候选，验证资源注册、网络覆盖、方案比较、地图分级、持久化与恢复。所有人口和路网均为合成数据；卫星底图只提供位置参照，不是人口或出行时间的数据来源。

## 结果与方法

| 项目 | 可判定结果 |
| --- | --- |
| 人口分母 | 350：西侧 100 + 50，东侧 200 |
| 西侧设施 | 10 分钟受控步行网络覆盖 150/350 |
| 东侧设施 | 同一方法覆盖 200/350 |
| 候选比较 | 权重 coverage=1、equity=0、cost=0，预算 10；east 排第一 |
| 不可行候选 | over-budget 的成本为 20，保留具名拒绝原因且不赋排名 |
| 地图与图例 | population 三分位分级，单位 people，断点 75/150；selected-facility 引用 east 的精确资源版本 |
| 保存与恢复 | 真实 JSONL 写 handle、flush 与关闭后读取；SQLite 资源版本和运行结果保留，图层和样式恢复一致 |

排序只比较声明的候选，并非所有设施方案的全局最优。网络分钟来自受控格网，不可当作真实道路分钟；容量按每设施 1000 人封顶。本案例不证明 LBS 厂商、数据库或远程 MCP 端点已完成部署验收。

## 自动验证

从仓库根运行：

```sh
node --test --experimental-strip-types map/tools/tests/facility-decision.spec.mjs
pnpm run test:snapshot -t 'map-(analyst-turn|facility-decision)'
```

第一条通过真实工具、目录、作业和地图投影核对手算人数、排名、图例/属性表/导出身份，并在关闭首个实例后从磁盘读取日志与资源。它同时覆盖缺文件、提交前取消、非法外延、撤权和超预算候选；错误覆盖期望的负样本必须被拒绝。

第二条回放真实模型录制的 Session。`snapshots/session/map-facility-decision/` 保存样例、当前会话与请求头。两个随机 run id 通过该场景的 `replay.override.json` 按 request digest 从真实 `run_submit` 输出绑定；覆盖指标与工具结果仍由当前实现计算，绝不替换成录制结果。`map-analyst-turn` 保留 v3 原件，并由 v4 successor 承载当前写入器输出。

重录需要当前 Messages 提供者接受的有效 `DEEPSEEK_API_KEY`；配置了变量不等于认证有效。注入凭据后运行 `pnpm run test:snapshot:record -t map-facility-decision`。重录必须复核调用顺序，并同步 override 中被替换的调用索引与 request digest；只绑定易变身份，不覆盖指标。任务须来自 Session 的原始 inbox 消息，不能只替换派生的 user/message。

## 浏览器验证

构建 Web 后运行专属用例：

```sh
node map/bin/build-web.mjs
node --test --test-name-pattern='facility decision:' map/arcgis-mcp/tests/composition.e2e.mjs
```

默认用例通过真实 map-web 应用与 Chromium 执行已录制模型的工具决策，检查两项覆盖人数、地图分级、属性表、刷选高亮、固定版本导出、页面重载和当前 revision 的 rendered 回执。模型传输在默认 lane 中是本地回放，业务工具与存储不是替身。服务端口由系统分配；浏览器使用 ANGLE/SwiftShader 满足 ArcGIS 的 WebGL2 要求。

已有有效模型凭据时，以 `MAP_FACILITY_LIVE=1` 运行同一用例，改用部署的真实模型。`MAP_FACILITY_ARTIFACTS` 可指定截图目录；截图只包含临时工作区的合成案例，不采集用户会话。实时模型输出不要求逐字相同，但同样必须满足人数、地图、联动和恢复断言。

## 证据归属

模型场景提供端到端调用与报告证据；业务测试提供独立数值答案和失败路径；浏览器用例提供实际界面、WebGL 渲染回执及交互证据。三层互不替代。其余能力和仍未覆盖的范围见[验证矩阵](verification-matrix.md)。
