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
export const METHOD_CARD_SET_VERSION = 1

/** One versioned method card. */
export interface MethodCard {
  readonly id: 'locate' | 'topology' | 'evidence-check'
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
  return METHOD_CARDS.filter(card => {
    if (card.id === 'evidence-check') return hasEvidence && card.triggers.some(t => question.includes(t))
    return question.length > 0 && card.triggers.some(t => question.includes(t))
  })
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
