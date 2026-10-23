/**
 * The three P0c method cards — 定位 (locate), 拓扑 (topology), 证据检查
 * (evidence check) — as versioned controlled knowledge, plus the
 * deterministic card selection and the stop-condition evaluation the
 * snapshot renders.
 *
 * A card carries its version, trigger conditions, required data, scale
 * expectations, tool families, preconditions, outputs, common misjudgments,
 * and stop conditions. Cards remind the model of relations and conditions;
 * they never assert that an analysis already happened, and retrieved
 * external material can never override the execution rules they state
 * (design §4.1, §5.5). The set is fixed for P0c; selection is a pure
 * keyword/state match, never a model call.
 *
 * @module @map-harness/spatial-context/cards
 */
import type { BudgetRefusal } from './budget.ts'
import type { DecisionFrame } from './frame.ts'

/** Current controlled-knowledge revision of the card set. */
export const METHOD_CARD_SET_VERSION = 2

/** Maximum cards one snapshot renders (deterministic first-match order; the rest stay discoverable, not injected). */
export const MAX_RENDERED_CARDS = 4

/** One versioned method card. */
export interface MethodCard {
  readonly id: 'locate' | 'topology' | 'evidence-check' | 'geometry' | 'network' | 'statistics' | 'spatiotemporal' | 'site-selection' | 'terrain'
  /** Controlled-knowledge version of this card (bump when the guidance changes). */
  readonly version: number
  /** Bounded trigger phrases (lowercase) matched against the goal question. */
  readonly triggers: readonly string[]
  /** Data the method needs before it can answer, stated as gap expectations. */
  readonly requiredData: readonly string[]
  /** Scale/support expectation the method imposes. */
  readonly scale: string
  /** Tool families the card directs the model toward. */
  readonly toolFamilies: readonly string[]
  /** Preconditions that must hold before outputs count as evidence. */
  readonly preconditions: readonly string[]
  /** What a correct run of this method outputs. */
  readonly outputs: readonly string[]
  /** Misjudgments the card warns against. */
  readonly misjudgments: readonly string[]
  /** Conditions under which the model must stop or downgrade the claim. */
  readonly stopConditions: readonly string[]
  /** Applicability domain and revocability of the card's guidance. */
  readonly applicability: string
}

/** The fixed three-card set (P0c scope). */
export const METHOD_CARDS: readonly MethodCard[] = [
  {
    id: 'locate',
    version: 1,
    triggers: ['定位', '在哪里', '位置', '坐标', '地名', '行政', 'locate', 'where', 'geocode', 'district'],
    requiredData: [
      '地名候选或精确坐标来源（catalog_register 登记的资源或用户给定的坐标）',
    ],
    scale: '点位/行政区尺度；坐标系与坐标约定必须随结果声明（WGS84 或显式 sourceCrs）',
    toolFamilies: ['catalog-read', 'map-mutation', 'geo-analysis'],
    preconditions: [
      '存在已登记资源或用户提供的明确位置依据',
      '同名候选不强行合并：歧义必须保留并报告',
    ],
    outputs: [
      '定位结果及其来源引用（resourceRef 或用户消息 seq）',
      '残留歧义与未匹配项',
    ],
    misjudgments: [
      '把最高相似度候选当作唯一匹配',
      '把地图视口当作分析范围',
      '把插件上下文消息当作用户确认的位置',
    ],
    stopConditions: [
      '无任何已登记资源且用户未给坐标：blocked，报告缺数据，不猜测坐标',
      '存在同名歧义且用户未消解：保留候选，不静默选一',
    ],
    applicability: '定位与参照任务；回答"在哪里/这里是什么"。不适用于邻近、可达性或统计问题。',
  },
  {
    id: 'topology',
    version: 1,
    triggers: ['相交', '包含', '缓冲', '距离', '邻', '边界', '重叠', 'intersect', 'buffer', 'distance', 'contain', 'near'],
    requiredData: [
      '至少两个带几何的版本化输入（ref+selector 或 path 分支声明）',
      'CRS 与单位声明（米制缓冲需要投影说明）',
    ],
    scale: '几何操作尺度；Turf 球面距离/面积与局部投影缓冲的适用地域限制随结果披露',
    toolFamilies: ['geo-analysis', 'catalog-read'],
    preconditions: [
      '几何类型满足算子要求（面叠置、点距等按各工具 schema）',
      '版本化 ref 输入选择精确一个 featureRef，不回退首项',
    ],
    outputs: [
      '分析结果指标与单位（analysis-result 记录）',
      '实际消费的输入身份（selector/featureIndex）',
      '方法限制（球面近似、离散 steps 等 published limitations）',
    ],
    misjudgments: [
      '把边界接触当成不相交或相交的单一结论（区分正面积重叠/仅边界接触/互不相交）',
      '把空几何结果当成执行故障，或把负缓冲消失当异常',
      '把显示面积（Web Mercator）当真实面积',
    ],
    stopConditions: [
      '缺几何输入或几何类型不满足：blocked/not_applicable，先登记或声明缺数据',
      'CRS 未知且任务需要精密计算：拒绝猜测，先取元数据或显式转换',
    ],
    applicability: '拓扑与约束任务（相交、包含、缓冲、距离）。P0c 不含路网可达性与网络阻抗。',
  },
  {
    id: 'evidence-check',
    version: 1,
    triggers: ['证据', '结论', '验证', '为什么', '依据', '解释', '证据检查', 'evidence', 'verify', 'conclusion', 'explain'],
    requiredData: [
      'EvidenceLedger 中至少一条已结算记录（succeeded/partial/failed）',
      '已接受的目标（真实用户消息）',
    ],
    scale: '任务级；逐条证据对照目标，不做跨任务汇总',
    toolFamilies: ['catalog-read', 'geo-analysis', 'map-read'],
    preconditions: [
      '每条结论引用已结算证据（evidenceId），不用模型自评替代',
      'unknown/not_applicable/partial/blocked 不渲染为成功',
    ],
    outputs: [
      '逐项证据对照：支持/反驳/未知/不适用',
      '缺口清单（PlanState.gaps）与剩余预算',
    ],
    misjudgments: [
      '把同一来源的多份产物当独立证据',
      '把探索性发现当预先指定的验证',
      '放宽用户目标以宣告完成',
    ],
    stopConditions: [
      '证据与目标冲突：报告冲突，不改写目标',
      '预算耗尽或重复补救超限：以 partial/blocked 交付已有证据与未满足条件',
    ],
    applicability: '证据与反证检查；高影响结论、数据冲突、因果措辞或预测外推时必须启用。',
  },
  {
    id: 'geometry',
    version: 1,
    triggers: ['缓冲', '范围', '面积', '相交', '距离', 'buffer', 'area', 'intersect', 'distance'],
    requiredData: [
      'WGS84 或显式 sourceCrs 的已登记资源/坐标（未知 CRS 不猜测）',
    ],
    scale: '点位到城市尺度；结果随单位声明（m/km/m²）',
    toolFamilies: ['geo-analysis'],
    preconditions: [
      '坐标系已知且几何非退化',
      '消费的要素索引随结果入账',
    ],
    outputs: ['带单位数值、bbox 与消费要素索引的 analysis-result 证据'],
    misjudgments: [
      '球面近似不等于测地精确',
      '缓冲区表达直线范围，不是路网可达',
    ],
    stopConditions: ['未知 CRS 或退化几何：拒绝计算并报告缺口'],
    applicability: '几何量算与叠置（geo_*）；指引可随版本撤销',
  },
  {
    id: 'network',
    version: 1,
    triggers: ['可达', '通勤', '路网', '车程', 'accessibility', 'drive', 'network'],
    requiredData: [
      '路网资源或已配置 provider（tianditu-road-network 需凭据）',
      '人口/设施资源作为需求侧',
    ],
    scale: '社区到城市尺度；格网密度由 provider 配置声明',
    toolFamilies: ['run-submit', 'run-read'],
    preconditions: [
      '路网可达必须由 run_* 作业计算',
      '作业未终态不计成功（unknown + 未终态限制）',
    ],
    outputs: ['覆盖率/覆盖人口等带分母指标与 artifact 版本'],
    misjudgments: [
      '以直线缓冲冒充路网可达',
      '无凭据/无路网时用格网近似却不声明',
    ],
    stopConditions: ['路网数据或凭据缺失：明示 blocked，不以直线结果代替'],
    applicability: '路网可达性（run_*）；指引可随版本撤销',
  },
  {
    id: 'statistics',
    version: 1,
    triggers: ['统计', '均值', '分布', '热点', '自相关', '聚类', 'zonal', 'hotspot', 'autocorrelation', 'cluster'],
    requiredData: ['已登记资源与数值字段；率类指标需正数分母字段'],
    scale: '分区/格网尺度；MAUP 尺度效应随限制声明',
    toolFamilies: ['stat-analysis'],
    preconditions: [
      '率 = 分子/正分母，无分母不是率',
      '样本量与缺失计数随结果入账',
    ],
    outputs: ['统计量、显著性与 missing 计数的 spatial-stat 证据'],
    misjudgments: ['相关不等于因果', '小样本过度解读显著性'],
    stopConditions: ['字段全缺失或分母非正：拒绝并报告缺口'],
    applicability: '分区统计/空间统计（stats_*/pattern_*）；指引可随版本撤销',
  },
  {
    id: 'spatiotemporal',
    version: 1,
    triggers: ['时序', '变化', '演变', '流动', '时空', 'change', 'flow', 'timeline', 'stream'],
    requiredData: ['时间字段与 IANA 时区绑定（time_field/timezone）'],
    scale: '时间粒度由 granularity 声明；帧外要素不入当前帧',
    toolFamilies: ['stat-analysis', 'stream-workbench'],
    preconditions: [
      '时间戳可解析；绑定后图例/导出与样式同版本',
    ],
    outputs: ['时空统计或流指标的版本化证据'],
    misjudgments: ['把时间裁剪后的缺失当作零值'],
    stopConditions: ['时间不可解析：拒绝时间绑定'],
    applicability: '时空模式（pattern_*、stream_*）；指引可随版本撤销',
  },
  {
    id: 'site-selection',
    version: 1,
    triggers: ['选址', '布局', '优化', '预测', '情景', 'allocate', 'forecast', 'scenario'],
    requiredData: [
      '候选/约束/需求显式（资源或用户给定）',
      '预测需历史数据并先 forecast_validate',
    ],
    scale: '设施/城市尺度；目标函数与约束随结果声明',
    toolFamilies: ['decision-model'],
    preconditions: [
      '选址目标可量化；情景比较用同一基准',
      '预测报告验证指标，不报告未验证外推',
    ],
    outputs: ['方案/预测的空间决策证据（claimLevel 随结论声明）'],
    misjudgments: ['相关冒充因果', '未验证外推与已验证结论混报'],
    stopConditions: ['缺约束或无验证时降级为探索性结论'],
    applicability: '选址/预测/情景（location_*/forecast_*/scenario_*）；指引可随版本撤销',
  },
  {
    id: 'terrain',
    version: 1,
    triggers: ['地形', '高程', '坡度', '可视', '视线', 'terrain', 'dem', 'viewshed'],
    requiredData: [
      '版本化地形表面（terrain_add_layer）与高程字段',
      '垂直基准/单位（datum/units）随表面声明',
    ],
    scale: '局地尺度；遮挡逐点计算',
    toolFamilies: ['terrain-display', 'terrain-analysis'],
    preconditions: [
      '视域 = 逐点遮挡计算（terrain_viewshed/geo_line_of_sight）',
      '视锥绘制不是可视域',
    ],
    outputs: ['可视/遮挡的 spatial-terrain 证据与表面版本'],
    misjudgments: ['把视锥或方向线当可视域', '跨基准高程直接比较'],
    stopConditions: ['无表面版本或基准未知：拒绝计算'],
    applicability: '地形展示与分析（terrain_*、geo_line_of_sight）；指引可随版本撤销',
  },
]

/**
 * Deterministically select the cards whose trigger conditions hold for the
 * current frame: keyword match against the goal question plus state
 * conditions (the evidence-check card also triggers once settled evidence
 * exists). At most three cards; the fixed set bounds this by construction.
 * @param frame - the current authoritative frame.
 * @returns the selected cards in fixed set order.
 */
export function selectCards(frame: DecisionFrame): readonly MethodCard[] {
  const question = frame.goal?.question.toLowerCase() ?? ''
  const hasEvidence = frame.evidence.length > 0
  const matched = METHOD_CARDS.filter(card => {
    if (card.id === 'evidence-check') return hasEvidence && card.triggers.some(t => question.includes(t))
    return question.length > 0 && card.triggers.some(t => question.includes(t))
  })
  // On-demand discovery stays bounded: the snapshot renders at most
  // MAX_RENDERED_CARDS (evidence-check keeps priority — it guards conclusions).
  const priority = [...matched.filter(card => card.id === 'evidence-check'), ...matched.filter(card => card.id !== 'evidence-check')]
  return priority.slice(0, MAX_RENDERED_CARDS)
}

/** Why the loop should stop or downgrade the current analysis. */
export type StopAdvisory = {
  readonly kind: 'none'
} | {
  readonly kind: 'blocked' | 'not_applicable' | 'partial' | 'budget' | 'repeat-gap'
  /** Bounded reason naming the condition and what is missing. */
  readonly reason: string
}

/**
 * Evaluate the stop conditions over the current frame and budget. These are
 * progress and precondition checks rendered into the snapshot — not a script
 * the model must walk, and not a scientific-correctness verdict (design §4.2,
 * §5.5).
 * @param frame - the current authoritative frame.
 * @param budgetRefusal - the budget preflight refusal, when one fired.
 * @returns the advisory the snapshot renders (`none` while work may proceed).
 */
export function evaluateStops(frame: DecisionFrame, budgetRefusal: BudgetRefusal | undefined): StopAdvisory {
  if (budgetRefusal !== undefined) {
    return { kind: 'budget', reason: `预算已达上限（${budgetRefusal.code}: ${budgetRefusal.used}/${budgetRefusal.limit}）；取消不返还已发生成本，计划更新不能重置预算` }
  }
  const gaps = frame.plan?.gaps ?? []
  const openGaps = gaps.filter(gap => gap.status === 'open')
  const blockedGaps = gaps.filter(gap => gap.status === 'blocked')
  if (blockedGaps.length > 0) {
    return { kind: 'blocked', reason: `缺口被标记 blocked：${blockedGaps.map(gap => gap.id).join(', ')}；以 blocked 交付已有证据与未满足条件` }
  }
  if (openGaps.length > 0 && frame.goal !== null) {
    if (frame.evidence.length === 0) {
      return { kind: 'not_applicable', reason: `必需数据缺失且尚无已结算证据：${openGaps.map(gap => gap.id).join(', ')}；不生成默认值当证据` }
    }
    return { kind: 'partial', reason: `存在未解决缺口：${openGaps.map(gap => gap.id).join(', ')}；以 partial 交付已完成部分` }
  }
  return { kind: 'none' }
}
