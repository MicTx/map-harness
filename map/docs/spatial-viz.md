# 空间可视化工作台（spatial-viz）

`@map-harness/spatial-viz` 是可视化工作台的领域库与客户端面板：版本化的 `StyleSpec`/`LegendSpec` 契约、分类与时间轴计算、以及把图层、图例、属性表、图表和导出钉在同一 style/data/time revision 上的共享筛选身份。库本体是环境无关纯代码（无 Node 内建依赖），工具端与浏览器工作台消费同一份推导。

方法版本：`spatial-viz@1`。三个模型工具由 `@map-harness/map-tools` 承载（`viz_create_style`、`viz_classify`、`viz_compare`），样式变更经 `map-change` v3 `set-style` 提交协议折叠（见 [map-container](map-container-binding.md) 与设计 §6.2/§10.3）。

## 契约（contract.ts）

- **StyleSpec**：字段、单位、量纲（total/rate/density）、分母字段（rate/density 必填、total 禁用）、编码（fill/size；size 仅限 total）、分类法（quantile/equal-interval/manual）、实际断点（严格递增，1–11 个）、分类域、调色板（类数个 `#rrggbb`）、缺失/越界颜色、缺测文案、可选 TimeBinding、断点来源 ref、`styleVersion`。
- **styleVersionOf**：对除 `styleVersion` 外的全部字段做键序无关摘要（双种子 FNV-1a → `sty-<12hex>@v1`）。校验拒绝任何 `styleVersion` 不再生的载荷——样式不可被就地篡改，只能产生新版本。
- **manual 分类必须给 `breaksSourceRef`**（精确 `res-…@vN`/`art-…@vN`）：模型不得在没有统计来源时编造断点；计算断点同样在内容里披露来源（数据本身）。
- **LegendSpec 只能由 `legendOf(style)` 派生**：携带 `styleVersion` 与断点来源，不维护第二套颜色/单位。行结构化（kind/from/to/toInclusive），客户端据此本地化。

## 分类（classify.ts）

- `computeBreaks`：quantile 取不同值秩的中点（断点永不与数据值重合、永不产生恒空类），强并数据诚实地收缩类数；equal-interval 均分极差；常量数据返回 0 断点（单类，工具拒绝样式化）。
- `classifyValue`/`countClasses`：半开类 `[b_k, b_{k+1})`（末类右闭到域顶），`underflow`/`overflow`/`missing` 具名类——缺测是标记，不是插补。
- `measureValueOf`：rate/density 分类比值；分母缺失、非数值或 ≤0 一律缺失，绝不当 0。
- `sizeForClass`：点符号按等级递增（8→20px），配合缺测的 x 形/虚线构成非颜色编码。
- `unifyDomains`（viz_compare）：两层数据并集统一断点与分类域，`unifiedDomain: true`；同色同值，逐层各自重分级被明确拒绝。

## 时间轴（timeline.ts）

- `framesOf(binding, observed)`：按 binding 的 IANA 时区与粒度（hour/day/week/month，周对齐周一）枚举半开窗口内的日历帧；无观测的帧保留为 `occupied: false`（缺测），窗口超 `MAX_TIMELINE_FRAMES` 拒绝而非截断。时区换算经 `Intl` 两次校正（fold-back 取早支，确定性）。
- `createTimeAxis`/`axisStep`/`axisGoto`/`axisPlay`/`axisPause`/`axisAdvance`：纯状态机——访问历史（升序去重）、变更计数、播放到末帧自动停止不回绕；同按键序列重放恒同终态。状态是普通 JSON 且不含任何模型通道字段（测试断言无 event/message/request/tool/model 字样）——播放不逐帧唤醒模型。

## 联动与导出（linked.ts）

- `histogramOf(legend, style, values)`：分布图直接复用图例分箱，图表永不另行分级。
- `selectionFilterOf` + `filterRevisionOf`：共享筛选 = 样式版本 + 数据身份（catalog ref 或 `display:<digest>`）+ 固定时间帧 + 刷选区间，摘要为 `sel-<12hex>`；地图高亮、属性表、图表刷选、导出四方都从这一个谓词推导（`selectFeatureIds`：缺测值/缺测时间不匹配任何刷选或帧；区间半开、域顶右闭）。
- `attributeRowsOf`：属性表行（列序保持、缺失为 null），`MAX_ATTRIBUTE_ROWS` 封顶并具名截断。
- `exportManifestOf`：固定 revision 导出清单——地图 revision、逐层 styleVersion/dataRef/displayDigest/要素数、帧（含时区/粒度/本地标签）、筛选 revision、以及渲染/数据/导出三类相互独立具名的失败；清单深拷贝，导出后外部编辑不可达。

## 工具链（map/tools）

- `viz_create_style`：从目录冻结字节计算分类并发布样式 artifact（经 publish 配对）；携带 `viz-style` v1 meta（身份 + 断点 + 来源 + artifact ref）。
- `viz_classify`：对已加载图层按其渲染数据计算样式，产出 `map-change` v3 `set-style` 候选；标准提交协议折叠（未配对/失败/旧 revision/未知图层拒绝）。可选 time 参数给图层挂工作台时间轴。
- `viz_compare`：两图层统一分类域，一次变更写两条样式；manual 分类无统域语义，直接拒绝。

## 浏览器工作台（map-container client）

`Workbench.tsx` 渲染图例（色块 `role="img"` + 文字范围 + 计数）、时间轴（prev/next/play/pause/slider，全部可键盘操作）、按图例分级的分布图（点击柱 = 刷选，`aria-pressed`）、分页属性表（行按钮选择要素）与导出按钮；`role="status"` 播报选择数、当前帧与导出结果。播放由组件定时器驱动 `axisAdvance`，不产生模型事件。文案全部走 `mapContainer` locale 字典（zh/en）。

## 测试

- `map/spatial-viz/tests/*.spec.mjs`：契约（词表/括号规则/版本再生/时区/窗口）、分类（秩中点/诚实收缩/半开语义/比值/尺寸/统一域）、时间轴（UTC 与 Asia/Shanghai 日历、缺测帧、状态机确定性、无模型字段）、联动（分箱复用/筛选摘要/选择语义/导出冻结）。
- `map/tools/tests/viz-tools.spec.mjs`：真实 catalog + 投影的创建→发布→加载→分类折叠→对比链路，及全部响亮拒绝。
- `map/map-container/tests/projection.spec.mjs`（set-style 折叠/拒绝）与 `tests/occurrence.spec.mjs`（类符号渲染/帧过滤/高亮/测试句柄）。
- 真实 Web ARIA：composition lane 的 workbench 用例（真实 app + Playwright 角色与键盘断言）。
