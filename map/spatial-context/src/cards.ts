/**
 * The versioned controlled-knowledge method cards, plus the
 * deterministic card selection and the stop-condition evaluation the
 * snapshot renders.
 *
 * A card carries its version, trigger conditions, required data, scale
 * expectations, tool families, preconditions, outputs, common misjudgments,
 * and stop conditions. Cards remind the model of relations and conditions;
 * they never assert that an analysis already happened, and retrieved
 * external material can never override the execution rules they state
 * (design §4.1, §5.5). The set is bounded; selection is a pure
 * keyword/state match, never a model call.
 *
 * @module @map-harness/spatial-context/cards
 */
import type { BudgetRefusal } from './budget.ts'
import type { DecisionFrame } from './frame.ts'

/** Current controlled-knowledge revision of the card set. */
export const METHOD_CARD_SET_VERSION = 6

/** Maximum cards one snapshot renders (deterministic first-match order; the rest stay discoverable, not injected). */
export const MAX_RENDERED_CARDS = 4

/** One versioned method card. */
export interface MethodCard {
  readonly id: 'visualization' | 'locate' | 'topology' | 'evidence-check' | 'network' | 'statistics' | 'spatiotemporal' | 'site-selection' | 'terrain' | 'visual-candidates' | 'visual-change-candidates'
  /** Controlled-knowledge version of this card (bump when the guidance changes). */
  readonly version: number
  /** Bounded trigger phrases (lowercase) matched against the goal question. */
  readonly triggers: readonly string[]
  /** Phrases that select the card before any evidence has settled; the evidence-check card otherwise needs settled evidence. */
  readonly alwaysTriggers?: readonly string[]
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

/** Bounded method guidance for discovery; actual tool schemas determine availability. */
export const METHOD_CARDS: readonly MethodCard[] = [
  {
    id: 'visualization',
    version: 1,
    triggers: ['可视化', '专题图', '热力', '分级', '密度图', '轨迹', '流向图', 'visualization', 'choropleth', 'heatmap', 'hexbin', '时空可视化'],
    requiredData: ['已加载图层；量值字段与单位；率/密度另需正分母，时序另需时间字段、时区和窗口'],
    scale: '选型仅对实际载入数据有效；不把显示聚合当分析输入',
    toolFamilies: ['viz-read', 'viz-style', 'layer-write'],
    preconditions: ['先用 viz_recommend 按场景与真实字段选型；缺条件先补数据，不自动执行推荐工具'],
    outputs: ['版本化方法身份、支持状态、缺口和下一步工具；analysisExecuted=false，不是统计证据'],
    misjudgments: ['热力颜色不是显著性热点；总量不直接作面积设色；统计表不是流向线或地形栅格'],
    stopConditions: ['needs-data 先补条件；unsupported 明示尚未支持，不静默换类型'],
    applicability: '地图展示、时空方法选择；完整类型按 viz_recommend 的 scenario 按需发现',
  },
  {
    id: 'visual-candidates',
    version: 1,
    triggers: ['看图找', '找目标', '标绘', '圈出', '候选', 'visual', 'markup', 'target candidate'],
    requiredData: ['当前会话最新 map_observe 图像与 observation_id；模型视觉判断，不是专用检测器'],
    scale: '像素定位经冻结 affine 变换到 WGS84；bbox 四角逐一变换，不做屏幕比例插值',
    toolFamilies: ['map-read', 'map-mutation'],
    preconditions: [
      '先 map_observe 取得当前 2D 可定位截图；过期观察重新观察，不复用旧图',
      'map_markup 只提交图像像素几何；confidence 只用 uncertain/likely 自评，不编造概率',
    ],
    outputs: ['候选 id、类别、说明、来源观察与限制；候选状态待确认'],
    misjudgments: [
      '把候选当用户已确认目标；把模型自评当检测精度',
      '把空候选当失败；看不到目标时返回空结果和限制说明',
    ],
    stopConditions: [
      '观察不可定位、跨会话或来源无许可：具名拒绝，不改用旧截图',
      '遮挡、分辨率不足或无明显目标：返回空候选，不再编造目标',
    ],
    applicability: '模型视觉标绘与目标候选；不适用于双时相变化检测或测绘级量测。',
  },
  {
    id: 'visual-change-candidates',
    version: 1,
    triggers: ['双时相', '两期', '变化候选', '比较两期', 'compare views'],
    requiredData: ['同一会话两次固定 release 的 map_observe 记录；同一视角、覆盖层组合与可定位 affine；两张已保存原图'],
    scale: '只比较已保存的两张同视角截图；像素几何经共同 affine 变换到 WGS84，不做栅格差分',
    toolFamilies: ['visual-change-read', 'visual-change-write'],
    preconditions: [
      '两次 map_observe 分别绑定固定 Wayback release；中间相机或覆盖层变化必须重新采集两图',
      '用 map_compare_views 读取两张原图和 comparison_id，再让模型同时看两图判断有限可比性',
      'map_mark_changes 只提交比较 id 和有界像素几何；confidence 只用 uncertain/likely 自评',
    ],
    outputs: ['comparison id、限制、有界变化候选和用户待确认记录；没有面积、发生日期或精度'],
    misjudgments: [
      '把发布日当当地拍摄日，或把同图不同 release 当确定无变化',
      '把云雾、季节、光照、压缩或镶嵌差异一律当实体变化',
      '把候选或模型自评当用户确认或检测准确率',
    ],
    stopConditions: [
      '缺图、跨会话、来源失效、视角/覆盖层不一致或未知 comparison：具名拒绝，不替换图片',
      '日期未知或逆序、只有一份当地影像：保持 limited 或拒绝，不推断发生时间',
      '看不清或没有可信变化：返回空候选和限制，不补造目标',
    ],
    applicability: '按需双图视觉比较与人工复查；不替代定量变化检测或跨会话时间轴。',
  },
  {
    id: 'locate',
    version: 2,
    triggers: ['定位', '在哪里', '位置', '坐标', '地名', '行政', '多少', '数量', '附近', 'locate', 'where', 'geocode', 'district'],
    requiredData: [
      '地名候选或精确坐标来源（catalog_register 登记的资源或用户给定的坐标）',
    ],
    scale: '点位/行政区尺度；坐标系与坐标约定必须随结果声明（WGS84 或显式 sourceCrs）',
    toolFamilies: ['catalog-read', 'map-mutation', 'geo-analysis'],
    preconditions: [
      '存在已登记资源或用户提供的明确位置依据',
      '同名候选不强行合并：歧义必须保留并报告',
      '计数类问题先界定研究区（AOI），再去重后报数；数量带来源与口径',
      'POI 来源存在覆盖偏差：计数只代表该来源已登记的要素，不是实际总数',
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
      '问题需要研究区而 AOI 未设置：先 map_refine_aoi 或请用户确认范围，不拿视窗当研究区',
    ],
    applicability: '定位与参照任务；回答"在哪里/这里是什么"。计数只代表已登记来源的要素。不适用于可达性或统计推断问题。',
  },
  {
    id: 'topology',
    version: 2,
    triggers: ['相交', '包含', '缓冲', '距离', '邻近', '相邻', '边界', '重叠', '面积', 'intersect', 'buffer', 'distance', 'contain', 'near', 'area'],
    requiredData: [
      '带几何的版本化输入（ref+selector 或 path 分支声明）；叠置与距离需要两个输入，面积需要面要素',
      'WGS84 或显式 sourceCrs 与单位声明（米制缓冲需要投影说明，未知 CRS 不猜测）',
    ],
    scale: '点位到城市尺度，结果随单位声明（m/km/m²）；Turf 球面距离/面积与局部投影缓冲的适用地域限制随结果披露',
    toolFamilies: ['geo-analysis', 'catalog-read'],
    preconditions: [
      '几何类型满足算子要求（面叠置、点距等按各工具 schema），几何非退化',
      '版本化 ref 输入选择精确一个 featureRef，不回退首项；消费的要素索引随结果入账',
    ],
    outputs: [
      '分析结果指标与单位（analysis-result 记录）',
      '实际消费的输入身份（selector/featureIndex）',
      '方法限制（球面近似、离散 steps 等 published limitations）',
    ],
    misjudgments: [
      '把边界接触当成不相交或相交的单一结论（区分正面积重叠/仅边界接触/互不相交）',
      '把空几何结果当成执行故障，或把负缓冲消失当异常',
      '把显示面积（Web Mercator）当真实面积；球面近似不等于测地精确',
      '缓冲区表达直线范围，不是路网可达',
    ],
    stopConditions: [
      '缺几何输入或几何类型不满足：blocked/not_applicable，先登记或声明缺数据',
      '未知 CRS 或退化几何：拒绝计算并报告缺口；任务需要精密计算时不猜测，先取元数据或显式转换',
    ],
    applicability: '几何量算与拓扑约束（geo_* 的缓冲、面积、相交、距离、包含）；不含路网可达性与网络阻抗；指引可随版本撤销',
  },
  {
    id: 'evidence-check',
    version: 2,
    triggers: ['证据', '结论', '验证', '为什么', '依据', '解释', '证据检查', 'evidence', 'verify', 'conclusion', 'explain'],
    alwaysTriggers: ['因果', '导致', '归因', '影响因素', 'causal', 'causation'],
    requiredData: [
      'EvidenceLedger 中至少一条已结算记录（succeeded/partial/failed）',
      '已接受的目标（真实用户消息）',
    ],
    scale: '任务级；逐条证据对照目标，不做跨任务汇总',
    toolFamilies: ['catalog-read', 'geo-analysis', 'map-read'],
    preconditions: [
      '每条结论引用已结算证据（evidenceId），不用模型自评替代',
      'unknown/not_applicable/partial/blocked 不渲染为成功',
      '因果措辞需要声明识别设计与诊断；缺少时只报告关联，并说明未做因果识别',
    ],
    outputs: [
      '逐项证据对照：支持/反驳/未知/不适用',
      '缺口清单（PlanState.gaps）与剩余预算',
    ],
    misjudgments: [
      '把同一来源的多份产物当独立证据',
      '把探索性发现当预先指定的验证',
      '放宽用户目标以宣告完成',
      '把关联、相关或模型解释当作因果效应',
    ],
    stopConditions: [
      '证据与目标冲突：报告冲突，不改写目标',
      '预算耗尽或重复补救超限：以 partial/blocked 交付已有证据与未满足条件',
      '无识别设计却被要求给出因果结论：降级为关联并说明',
    ],
    applicability: '证据与反证检查；高影响结论、数据冲突、因果措辞或预测外推时必须启用。',
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
    triggers: ['地形', '高程', '坡度', '可视域', '可视范围', '视线', 'terrain', 'dem', 'viewshed', 'slope', 'elevation'],
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

const ASCII_TRIGGER = /^[a-z0-9][a-z0-9 _-]*$/

/**
 * Whether one lowercase goal question contains one trigger phrase. CJK
 * phrases match as substrings. ASCII phrases match as whole words that may
 * carry a plural or verb suffix, so `contain` never fires inside `container`
 * and `dem` never fires inside `demand`.
 * @param question - the lowercased goal question.
 * @param trigger - one lowercase trigger phrase from a card.
 */
function matchesTrigger(question: string, trigger: string): boolean {
  if (!ASCII_TRIGGER.test(trigger)) return question.includes(trigger)
  return new RegExp(`(?<![a-z0-9])${trigger}(?:s|es|ed|ing)?(?![a-z0-9])`).test(question)
}

/**
 * Deterministically select the cards whose trigger conditions hold for the
 * current frame: a trigger match against the goal question, then the cards
 * the accepted plan already names in `methods`. The plan carries a method
 * across follow-up questions such as "继续"; it is the model's candidate, so
 * it ranks after every card the current question selects. The evidence-check
 * card needs settled evidence unless a card `alwaysTriggers` phrase matches,
 * and keeps priority because it guards conclusions. Selection is capped by
 * MAX_RENDERED_CARDS.
 * @param frame - the current authoritative frame.
 * @returns the selected cards in rank order.
 */
export function selectCards(frame: DecisionFrame): readonly MethodCard[] {
  if (frame.goal === null) return []
  const question = frame.goal.question.toLowerCase()
  const hasEvidence = frame.evidence.length > 0
  const matched = METHOD_CARDS.filter(card => {
    if (card.alwaysTriggers?.some(trigger => matchesTrigger(question, trigger)) === true) return true
    if (card.id === 'evidence-check' && !hasEvidence) return false
    return question.length > 0 && card.triggers.some(trigger => matchesTrigger(question, trigger))
  })
  const planned = new Set((frame.plan?.methods ?? []).map(method => method.name.trim().toLowerCase()))
  const sticky = METHOD_CARDS.filter(card => planned.has(card.id) && !matched.includes(card))
  // On-demand discovery stays bounded: the snapshot renders at most
  // MAX_RENDERED_CARDS (evidence-check keeps priority — it guards conclusions).
  const ranked = [
    ...matched.filter(card => card.id === 'evidence-check'),
    ...matched.filter(card => card.id !== 'evidence-check'),
    ...sticky,
  ]
  return ranked.slice(0, MAX_RENDERED_CARDS)
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
  if (budgetRefusal !== undefined) return budgetAdvisory(budgetRefusal)
  const gaps = frame.plan?.gaps ?? []
  const openGaps = gaps.filter(gap => gap.status === 'open')
  const blockedGaps = gaps.filter(gap => gap.status === 'blocked')
  const stale = staleGoalNote(frame)
  if (blockedGaps.length > 0) {
    return { kind: 'blocked', reason: `缺口被标记 blocked：${blockedGaps.map(gap => gap.id).join(', ')}；以 blocked 交付已有证据与未满足条件${stale}` }
  }
  if (openGaps.length > 0 && frame.goal !== null) {
    if (frame.evidence.length === 0) {
      return { kind: 'not_applicable', reason: `必需数据缺失且尚无已结算证据：${openGaps.map(gap => gap.id).join(', ')}；不生成默认值当证据${stale}` }
    }
    return { kind: 'partial', reason: `存在未解决缺口：${openGaps.map(gap => gap.id).join(', ')}；以 partial 交付已完成部分${stale}` }
  }
  return { kind: 'none' }
}

/**
 * The advisory for one budget refusal. It names the counter and its limit
 * but not the consumed amount, which the budget line already states: the
 * elapsed time grows on every step, and the advisory text must stay stable
 * while the same counter stays exhausted so it is delivered once.
 * @param refusal - the budget preflight refusal.
 * @returns the `budget` advisory.
 */
export function budgetAdvisory(refusal: BudgetRefusal): StopAdvisory {
  return { kind: 'budget', reason: `预算已达上限（${refusal.code}，上限 ${refusal.limit}）；取消不返还已发生成本，计划更新不能重置预算` }
}

/**
 * The note appended when the accepted plan was written for an earlier goal
 * revision. Every accepted user message raises the goal revision, including
 * a follow-up such as "继续", so the earlier gaps still count but are labelled.
 * @param frame - the current authoritative frame.
 * @returns the note, or an empty string when the plan matches the goal.
 */
export function staleGoalNote(frame: DecisionFrame): string {
  if (frame.plan === null || frame.goal === null || frame.plan.goalRevision === frame.goal.goalRevision) return ''
  return `（缺口写于旧目标 goalRevision=${frame.plan.goalRevision}；确认仍适用后以 goal_revision=${frame.goal.goalRevision} 重新提交计划）`
}
