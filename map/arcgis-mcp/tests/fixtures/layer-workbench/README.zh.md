# layer-workbench 验收夹具

[English](README.md) | 中文

P4 联动验收案例（`layer workbench`）的纯合成资产。这里不出现任何客户数据、
凭据或私人路径；所有载荷由 `generate.mjs` 生成，且跨次再生成保持字节稳定。

## 文件

- `generate.mjs` — 确定性生成器；`node generate.mjs` 写出资产，
  `node generate.mjs --verify` 证明两次运行摘要一致且与提交文件相符。
- `hospitals.csv` — 北京地区医院点，带歧义 `x`/`y` 表头（弱别名）：
  `data_import` 停在 `needs_confirmation`。
- `hospitals.confirmed.csv` — 解析后的 `lon`/`lat` 表头变体。
- `hospitals-gbk.csv` — GBK 编码表头，携带强中文别名；以
  `encoding: "gbk"` 导入。
- `roads.shp.zip` — PolyLine shapefile，含 `.prj`（WGS84）与 `.cpg`；
  无需确认即可导入。
- `truncated.shp.zip` — 记录链在中途截断；以稳定的
  `.shp record chain` 错误拒绝且目录零新行。
- `tile.png` — 1×1 fixture 瓦片，composition lane 同时用作底图与
  imagery 家族检查。
- `imagery-template.json` — imagery 家族检查使用的免密瓦片模板；
  composition lane 以 `page.route` 拦截，主机名从不真实解析。
- `poi/` — 天地图 `/v2/search` wire 载荷：`page-1.json` 与
  `page-2.json`（分页成功）、`rate-limited.json`（HTTP 429）、
  `empty.json`（零结果成功）。
- `poi-fixture-server.mjs` — 消费 `poi/` 载荷的环回 fixture 检索服务；
  composition 场景 patch 把 map-web 组合的 `spatial-connect` 指向它。
- `poi-fixture-plugin.mjs` — 快照组合改挂的进程内 transport，
  服务同一批载荷且完全不触网。
