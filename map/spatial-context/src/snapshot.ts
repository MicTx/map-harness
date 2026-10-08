/**
 * The bounded `SpatialContextSnapshot` the pre-step listener injects: a
 * stable-text view of the current DecisionFrame, the map snapshot, the
 * resource candidates, the evidence ledger, the selected method cards, the
 * available tools, the stop advisory, and the remaining budget.
 *
 * Admission rules (design §5.2, audit D05): the baseline is a full bounded
 * view composed whenever no baseline for the current goal is visible on the
 * model surface (first entry, resume, fork, or after compaction/replacement
 * hid it); an increment lists only what settled after the last admitted
 * snapshot. The exact text digest deduplicates: an identical visible
 * snapshot suppresses re-injection, and a digest is "confirmed" only when
 * the projection folds it from an accepted `user/message`.
 *
 * @module @map-harness/spatial-context/snapshot
 */
import { createHash } from 'node:crypto'
import { checkBudget, type BudgetConfig, type BudgetRefusal } from './budget.ts'
import { evaluateStops, selectCards, type StopAdvisory } from './cards.ts'
import { PENDING_GOAL_SOURCE_SEQ, parseSnapshotHeader, type SpatialContextState } from './protocol.ts'
import type { EvidenceEntry, ResourceCandidate } from './frame.ts'

/** The tools the fixed Native spatial catalog serves (mirror of the unified catalog; parity-tested). */
const AVAILABLE_TOOLS = [
  'map_add_layer', 'map_remove_layer', 'map_set_view', 'map_set_mode', 'map_get_state',
  'geo_buffer', 'geo_area', 'geo_intersect', 'geo_distance',
  'catalog_register', 'catalog_resolve', 'map_save', 'decision_update',
] as const

/** Maximum evidence entries one snapshot renders (oldest dropped first). */
export const MAX_SNAPSHOT_EVIDENCE = 12

/** Maximum resource candidates one snapshot renders. */
export const MAX_SNAPSHOT_RESOURCES = 8

/** The accepted-injection facts the dedupe reads from the visible surface. */
export interface VisibleInjection {
  readonly seq: number
  readonly kind: 'baseline' | 'increment'
  /** Goal revision the visible snapshot was composed against. */
  readonly goal: number
  readonly digest: string
}

/** What one snapshot admits: the message content plus its identity. */
export interface ComposedSnapshot {
  readonly kind: 'baseline' | 'increment'
  readonly digest: string
  /** Full injected text, header line first. */
  readonly text: string
  readonly bytes: number
}

/** Read-face inputs the composer needs beyond the frame itself. */
/** The authorization availability of one catalog ref at composition time. */
export type RefAvailability = 'available' | 'revoked' | 'tombstoned' | 'recalled' | 'unknown'

/** The read-face inputs the snapshot composer needs beyond the frame itself. */
export interface SnapshotInputs {
  /** The current frame state (authoritative fold). */
  readonly frame: SpatialContextState
  /** The authoritative map projection revision, when the map unit is mounted. */
  readonly mapRevision: number | undefined
  /** Count of map layers, when the map unit is mounted. */
  readonly mapLayerCount: number | undefined
  /** Names of the visible map layers, when the map unit is mounted. */
  readonly mapLayerNames: readonly string[]
  readonly budget: BudgetConfig
  /** Current wall time for the elapsed check (enforcement, not replay). */
  readonly nowMs: number
  /**
   * Authorization availability of one catalog ref, checked at composition
   * time (the model-context entry). A revoked or tombstoned candidate
   * renders with an explicit unavailable marker — never silently dropped
   * and never presented as usable; `unknown` covers refs with no governance
   * answer. Absent when no catalog unit is mounted (no candidates can exist).
   */
  readonly refAvailability?: (ref: string) => RefAvailability
}

/** Compute the 16-hex digest over one snapshot body. */
export function digestOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16)
}

/** Build the versioned header line for one snapshot body. */
function headerOf(kind: 'baseline' | 'increment', goalRevision: number, digest: string): string {
  return `spatial-context/snapshot v1 kind=${kind} goal=${goalRevision} digest=${digest}`
}

/**
 * Read the accepted injections currently visible on the model surface.
 * The caller scans `session.surface.nodes` and decodes each visible
 * `user/message` with this plugin's source; only parseable snapshots count.
 * @param texts - the injected snapshot texts visible on the surface, with their event seqs.
 */
export function visibleInjectionsOf(texts: readonly { readonly seq: number; readonly text: string }[]): VisibleInjection[] {
  const visible: VisibleInjection[] = []
  for (const { seq, text } of texts) {
    const header = parseSnapshotHeader(text)
    if (header !== undefined) {
      visible.push({ seq, kind: header.kind, goal: header.goal, digest: header.digest })
    }
  }
  return visible
}

/** Truncate one line to the bounded snapshot width. */
function line(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Render one evidence entry line. */
function evidenceLine(entry: EvidenceEntry): string {
  const ref = entry.ref === undefined ? '' : ` ref=${entry.ref}`
  const digest = entry.contentDigest === undefined ? '' : ` digest=${entry.contentDigest.slice(0, 8)}`
  const scan = entry.scanFeatures === undefined ? '' : ` scan=${entry.scanFeatures}`
  const limitation = entry.limitations[0] === undefined ? '' : ` — ${entry.limitations[0]}`
  return `[${entry.evidenceId}] ${entry.tool} ${entry.status}${ref}${digest}${scan}${limitation}`
}

/** Render the budget lines shared by both snapshot kinds. */
function budgetLines(inputs: SnapshotInputs): string[] {
  const { budget, frame } = inputs
  const goalAcceptedAt = frame.goal?.acceptedAt
  const elapsed = goalAcceptedAt === undefined ? 0 : Math.max(0, inputs.nowMs - goalAcceptedAt)
  return [
    `预算: steps ${frame.budget.stepsUsed}/${budget.maxModelSteps}, meta ${frame.budget.metaBytes}/${budget.maxMetaBytes} B, context ${frame.budget.contextBytes}/${budget.maxContextBytes} B, scan ${frame.budget.scanFeatures}/${budget.maxScanFeatures} features, elapsed ${elapsed}/${budget.maxElapsedMs} ms`,
    '预算为硬限制；取消不返还已发生成本，计划更新(planRevision)不能重置预算；供应商费用只作估算记录，不设限额。',
  ]
}

/** Render the card block: trigger, required data, preconditions, outputs, misjudgments, stop conditions. */
function cardLines(inputs: SnapshotInputs): string[] {
  const lines: string[] = []
  for (const card of selectCards(inputs.frame)) {
    lines.push(`方法卡 [${card.id} v${card.version}]: 适用=${card.applicability}`)
    lines.push(`  必需数据: ${card.requiredData.join('；')}`)
    lines.push(`  前置条件: ${card.preconditions.join('；')}`)
    lines.push(`  停止条件: ${card.stopConditions.join('；')}`)
    lines.push(`  常见误判: ${card.misjudgments.join('；')}`)
  }
  return lines
}

/** Compose the full baseline snapshot for the current goal. */
function composeBaseline(inputs: SnapshotInputs): string {
  const { frame } = inputs
  const lines: string[] = []
  const goal = frame.goal as NonNullable<SpatialContextState['goal']>
  const source = goal.sourceSeq === PENDING_GOAL_SOURCE_SEQ
    ? '来源=user/message(本轮请求,未入日志)'
    : `来源=user/message seq=${goal.sourceSeq}`
  lines.push(`目标: ${line(goal.question)} (goalRevision=${goal.goalRevision}, questionId=${goal.questionId}, ${source})`)
  const plan = frame.plan
  lines.push(plan === null
    ? '计划: 尚无已接受计划 (planRevision=0)；复杂任务需要持久计划时用 decision_update 提交 expectedPlanRevision 与当前 goalRevision。'
    : `计划: planRevision=${plan.planRevision} (goalRevision=${plan.goalRevision})`
      + (plan.interpretation === undefined ? '' : ` 解释(模型候选,非用户授权): ${line(plan.interpretation, 200)}`)
      + (plan.methods.length === 0 ? '' : ` 方法: ${plan.methods.map(method => method.name).join('/')}`)
      + (plan.steps.length === 0 ? '' : ` 步骤: ${plan.steps.length} 项`)
      + (plan.gaps.length === 0 ? '' : ` 缺口: ${plan.gaps.map(gap => `${gap.id}(${gap.status})`).join('/')}`))
  lines.push(inputs.mapRevision === undefined
    ? '地图: map 容器未挂载'
    : `地图: revision=${inputs.mapRevision}, 图层=${inputs.mapLayerCount ?? 0}${inputs.mapLayerNames.length === 0 ? '' : ` (${inputs.mapLayerNames.slice(0, 8).join(', ')})`}`)
  const resources = frame.resources.slice(-MAX_SNAPSHOT_RESOURCES)
  lines.push(resources.length === 0
    ? '资源候选: 无（用 catalog_register 登记或 catalog_resolve 解析精确版本）'
    : `资源候选: ${resources.map(resource => resourceCandidateLine(resource, inputs.refAvailability)).join('; ')}`)
  const evidence = frame.evidence.slice(-MAX_SNAPSHOT_EVIDENCE)
  lines.push(evidence.length === 0
    ? '证据: 尚无已结算记录（unknown/not_applicable/partial/blocked 不会被渲染为成功）'
    : `证据:\n${evidence.map(evidenceLine).map(text => `  ${text}`).join('\n')}`)
  lines.push(...cardLines(inputs))
  lines.push(`可用工具: ${AVAILABLE_TOOLS.join(', ')}（固定 Native 集；嵌套 PTC 派发不可用）`)
  const refusal = budgetRefusalOf(inputs)
  const stop = evaluateStops(inputs.frame, refusal)
  lines.push(`停止建议: ${stopLine(stop)}`)
  lines.push(...budgetLines(inputs))
  return lines.join('\n')
}

/** Render one stop advisory. */
function stopLine(stop: StopAdvisory): string {
  return stop.kind === 'none' ? 'none（可继续；工具返回不可用/空结果须分别记录，不生成默认值当证据）' : `${stop.kind} — ${stop.reason}`
}

/**
 * Render one resource candidate line, appending the explicit unavailable
 * marker when the ref's governance state is not available at composition
 * time. The marker restates the copy limit — the snapshot never presents a
 * revoked candidate as usable and never promises erasure of what the model
 * already saw.
 */
function resourceCandidateLine(
  resource: ResourceCandidate,
  refAvailability: SnapshotInputs['refAvailability'],
): string {
  const detail = `digest=${resource.contentDigest.slice(0, 8)}, ${resource.nativeCrs}, ${resource.featureCount} 要素, auth=${resource.authorization}`
  return availabilitySuffix(resource.ref, refAvailability, `${resource.ref}(${detail})`)
}

/** Append the unavailable marker for a non-available ref, when gating is active. */
function availabilitySuffix(
  ref: string,
  refAvailability: SnapshotInputs['refAvailability'],
  base: string,
): string {
  if (refAvailability === undefined) return base
  const availability = refAvailability(ref)
  if (availability === 'available' || availability === 'unknown') return base
  if (availability === 'recalled') {
    return `${base} [已召回: 后续访问被拒绝；召回不擦除已存在的副本]`
  }
  const marker = availability === 'revoked' ? '已撤权' : '已标记不可用'
  return `${base} [${marker}: 后续访问被拒绝；已进入日志/报告/客户端的副本不会被远程召回或擦除]`
}

/** Compute the budget preflight refusal the snapshot reports. */
function budgetRefusalOf(inputs: SnapshotInputs): BudgetRefusal | undefined {
  return checkBudget(inputs.frame.budget, inputs.budget, inputs.nowMs, inputs.frame.goal?.acceptedAt)
}

/** Compose the increment snapshot listing only what settled after `sinceSeq`. */
function composeIncrement(inputs: SnapshotInputs, sinceSeq: number): string | undefined {
  const { frame } = inputs
  const lines: string[] = []
  const newEvidence = frame.evidence.filter(entry => entry.seq > sinceSeq).slice(-MAX_SNAPSHOT_EVIDENCE)
  const newResources = frame.resources.filter(resource => resource.presentedAt > sinceSeq).slice(-MAX_SNAPSHOT_RESOURCES)
  const planChanged = frame.plan !== null && frame.plan.sourceSeq > sinceSeq
  if (newEvidence.length === 0 && newResources.length === 0 && !planChanged) return undefined
  lines.push(`自上次注入 seq=${sinceSeq} 的新事实:`)
  if (planChanged) {
    const plan = frame.plan as NonNullable<SpatialContextState['plan']>
    lines.push(`计划更新: planRevision=${plan.planRevision}${plan.gaps.length === 0 ? '' : ` 缺口: ${plan.gaps.map(gap => `${gap.id}(${gap.status})`).join('/')}`}`)
  }
  if (newResources.length > 0) {
    lines.push(`新资源候选: ${newResources.map(resource => {
      const detail = `digest=${resource.contentDigest.slice(0, 8)}, ${resource.nativeCrs}`
      return availabilitySuffix(resource.ref, inputs.refAvailability, `${resource.ref}(${detail})`)
    }).join('; ')}`)
  }
  if (newEvidence.length > 0) {
    lines.push(`新证据:\n${newEvidence.map(evidenceLine).map(text => `  ${text}`).join('\n')}`)
  }
  const refusal = budgetRefusalOf(inputs)
  const stop = evaluateStops(inputs.frame, refusal)
  lines.push(`停止建议: ${stopLine(stop)}`)
  lines.push(...budgetLines(inputs))
  return lines.join('\n')
}

/**
 * Compose the snapshot the next model request should see, or `undefined`
 * when nothing needs injecting (no accepted goal, nothing new, or the exact
 * snapshot is already visible).
 * @param inputs - the frame and composition inputs.
 * @param visible - the accepted injections still visible on the model surface.
 * @returns the composed snapshot, or `undefined` to inject nothing.
 */
export function composeSnapshot(
  inputs: SnapshotInputs,
  visible: readonly VisibleInjection[],
): ComposedSnapshot | undefined {
  const { frame } = inputs
  if (frame.goal === null) return undefined
  const goalRevision = frame.goal.goalRevision
  const visibleForGoal = visible.filter(injection => injection.goal === goalRevision)
  const visibleBaseline = visibleForGoal.find(injection => injection.kind === 'baseline')
  const newestVisible = visibleForGoal.reduce((newest, injection) => injection.seq > (newest?.seq ?? -1) ? injection : newest, undefined as VisibleInjection | undefined)
  if (visibleBaseline === undefined) {
    const body = composeBaseline(inputs)
    const digest = digestOf(body)
    return { kind: 'baseline', digest, text: `${headerOf('baseline', goalRevision, digest)}\n${body}`, bytes: Buffer.byteLength(`${headerOf('baseline', goalRevision, digest)}\n${body}`, 'utf8') }
  }
  if (newestVisible !== undefined) {
    const body = composeIncrement(inputs, newestVisible.seq)
    if (body === undefined) return undefined
    const digest = digestOf(body)
    const text = `${headerOf('increment', goalRevision, digest)}\n${body}`
    return { kind: 'increment', digest, text, bytes: Buffer.byteLength(text, 'utf8') }
  }
  return undefined
}

/**
 * Whether one composed snapshot is already visible verbatim on the surface.
 * @param composed - the snapshot about to inject.
 * @param visible - the accepted injections still visible on the model surface.
 */
export function isDuplicate(composed: ComposedSnapshot, visible: readonly VisibleInjection[]): boolean {
  return visible.some(injection => injection.digest === composed.digest)
}

/** The resource candidates one snapshot rendering used (exported for tests). */
export type { ResourceCandidate, EvidenceEntry }
