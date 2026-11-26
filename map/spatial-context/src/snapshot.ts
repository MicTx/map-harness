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
import { budgetAdvisory, evaluateStops, selectCards, type StopAdvisory } from './cards.ts'
import { PENDING_GOAL_SOURCE_SEQ, parseSnapshotHeader, type SpatialContextState } from './protocol.ts'
import type { EvidenceEntry, ResourceCandidate } from './frame.ts'
import type { VisualChangeStatus, VisualProposalStatus } from '@map-harness/map-container'

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
  /** The mounted map's layers with visibility, newest id order. */
  readonly mapLayers: readonly { readonly id: string; readonly name: string; readonly visible: boolean }[]
  /** The mounted map's current view (the viewport — deliberately distinct from the AOI). */
  readonly mapView: { readonly center: readonly [number, number]; readonly zoom: number; readonly wkid: number } | undefined
  /** The camera the user's browser last settled on (what the user sees), when one was reported. */
  readonly userViewport?: { readonly center: readonly [number, number]; readonly zoom: number; readonly extent: readonly [number, number, number, number]; readonly wkid: number; readonly mode: 'map' | 'scene' }
  /**
   * The newest visible text of each tracked line (see {@link lastVisibleLinesOf}),
   * keyed by line prefix. An increment repeats a tracked line only when its
   * current text differs. Absent means no comparison: only new facts compose
   * an increment.
   */
  readonly lastLines?: Readonly<Record<string, string>>
  /** The mounted map's display environment (mode and basemap), when the map unit is mounted. */
  readonly mapEnvironment?: { readonly mode: 'map' | 'scene'; readonly basemap: string }
  /** The mounted map's study AOI; `null` when none is set, `undefined` when no map unit is mounted. */
  readonly mapAoi: { readonly name?: string; readonly ring: readonly (readonly [number, number])[] } | null | undefined
  /** Visual-proposal review state, when the map unit is mounted. */
  readonly mapProposals?: readonly { readonly id: string; readonly name: string; readonly status: VisualProposalStatus }[]
  /** Visual-change review state, when the map unit is mounted. */
  readonly mapChanges?: readonly { readonly id: string; readonly name: string; readonly status: VisualChangeStatus }[]
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

/** Prefix of the user-viewport line; the agent reads it back from the newest visible snapshot. */
export const USER_VIEWPORT_LINE_PREFIX = '用户视窗:'

/**
 * Render the user's settled camera as one line.
 * @param viewport - the reported camera.
 * @returns the line, prefixed with {@link USER_VIEWPORT_LINE_PREFIX}.
 */
export function userViewportLineOf(viewport: NonNullable<SnapshotInputs['userViewport']>): string {
  const [minX, minY, maxX, maxY] = viewport.extent.map(round)
  return `${USER_VIEWPORT_LINE_PREFIX} center=[${round(viewport.center[0])}, ${round(viewport.center[1])}] zoom=${round(viewport.zoom)} 可见范围=[${minX}, ${minY}, ${maxX}, ${maxY}] wkid=${viewport.wkid} ${viewport.mode === 'scene' ? '3D' : '2D'}（用户当前所见，可据此理解「这里」「这片区域」等指代）`
}

/** Prefix of the stop-advisory line every snapshot carries. */
const STOP_LINE_PREFIX = '停止建议:'

/**
 * Prefixes of the lines an increment repeats when the model's newest visible
 * copy differs: map state the user or a tool can change between steps, and
 * the stop advisory. Each tracked line is rendered by one helper shared by
 * the baseline and the increment, so equal state yields equal text.
 */
const TRACKED_LINE_PREFIXES = ['图层清单:', '视觉候选:', '视觉变化候选:', 'AOI:', USER_VIEWPORT_LINE_PREFIX, STOP_LINE_PREFIX] as const

/**
 * Read the newest visible text of every tracked line from the snapshots
 * still on the model surface.
 * @param texts - the visible snapshot texts with their event seqs, in any order.
 * @returns the newest line per tracked prefix.
 */
export function lastVisibleLinesOf(texts: readonly { readonly seq: number; readonly text: string }[]): Record<string, string> {
  const lines: Record<string, string> = {}
  for (const { text } of [...texts].sort((left, right) => left.seq - right.seq)) {
    for (const textLine of text.split('\n')) {
      const prefix = TRACKED_LINE_PREFIXES.find(candidate => textLine.startsWith(candidate))
      if (prefix !== undefined) lines[prefix] = textLine
    }
  }
  return lines
}

/**
 * Upper bound of the {@link composeBudgetNotice} size. Admission keeps the
 * notice's actual size free inside `maxContextBytes`, so the notice can
 * still be delivered when a snapshot no longer fits.
 */
export const STOP_NOTICE_RESERVE_BYTES = 512

/**
 * Compose the fixed-form increment injected when a snapshot no longer fits
 * the context-byte budget. The body does not depend on the goal, so one
 * visible notice suppresses a repeat for every later goal of the task.
 * @param goalRevision - the goal revision written into the header.
 * @param maxContextBytes - the configured context-byte limit.
 * @returns the notice snapshot.
 */
export function composeBudgetNotice(goalRevision: number, maxContextBytes: number): ComposedSnapshot {
  const advisory = budgetAdvisory({ code: 'context-bytes-exhausted', used: maxContextBytes, limit: maxContextBytes })
  const body = [
    `${STOP_LINE_PREFIX} ${stopLine(advisory)}`,
    '空间上下文快照已停止注入：之后的证据、计划与地图变化不再出现在快照中；以 partial 交付已有证据与未满足条件。',
  ].join('\n')
  const digest = digestOf(body)
  const text = `${headerOf('increment', goalRevision, digest)}\n${body}`
  return { kind: 'increment', digest, text, bytes: Buffer.byteLength(text, 'utf8') }
}

/** Truncate one line to the bounded snapshot width. */
function line(text: string, max = 160): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Render one coordinate at snapshot precision. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

/** Name human review and agent decisions without conflating their authors. */
function candidateStatus(status: VisualProposalStatus | VisualChangeStatus): string {
  switch (status) {
    case 'proposed': return '待确认'
    case 'accepted': return '已接受'
    case 'rejected': return '已拒绝'
    case 'agent-applied': return 'Agent 已应用'
    case 'agent-dismissed': return 'Agent 已排除'
  }
}

/**
 * Render one evidence entry line: identity, status, refs, the headline values
 * the record reported, its claim level, and its first limitation. Evidence
 * settled under an earlier goal revision is labelled with that revision.
 * @param goalRevision - the current goal revision.
 */
function evidenceLineFor(goalRevision: number): (entry: EvidenceEntry) => string {
  return entry => {
    const ref = entry.ref === undefined ? '' : ` ref=${entry.ref}`
    const digest = entry.contentDigest === undefined ? '' : ` digest=${entry.contentDigest.slice(0, 8)}`
    const scan = entry.scanFeatures === undefined ? '' : ` scan=${entry.scanFeatures}`
    const metrics = entry.metrics === undefined ? '' : ` ${entry.metrics.map(metricText).join(', ')}`
    const claim = entry.claimLevel === undefined ? '' : ` claim=${entry.claimLevel}`
    const earlier = entry.goalRevision === undefined || entry.goalRevision === goalRevision ? '' : ` [旧目标 goalRevision=${entry.goalRevision}]`
    const limitation = entry.limitations[0] === undefined ? '' : ` — ${entry.limitations[0]}`
    return `[${entry.evidenceId}] ${entry.tool} ${entry.status}${ref}${digest}${scan}${metrics}${claim}${earlier}${limitation}`
  }
}

/** Render one reported value as `name=value unit`; a missing value renders as `name=无`. */
function metricText(metric: NonNullable<EvidenceEntry['metrics']>[number]): string {
  const value = metric.value === null ? '无' : String(metric.value)
  return `${metric.name}=${value}${metric.unit === undefined ? '' : ` ${metric.unit}`}`
}

/** Render the budget lines shared by both snapshot kinds. */
function budgetLines(inputs: SnapshotInputs): string[] {
  const { budget, frame } = inputs
  const goalAcceptedAt = frame.goal?.acceptedAt
  const elapsed = goalAcceptedAt === undefined ? 0 : Math.max(0, inputs.nowMs - goalAcceptedAt)
  return [
    `预算: steps ${frame.budget.stepsUsed}/${budget.maxModelSteps ?? '不限'}, meta ${frame.budget.metaBytes}/${budget.maxMetaBytes} B, context ${frame.budget.contextBytes}/${budget.maxContextBytes} B, scan ${frame.budget.scanFeatures}/${budget.maxScanFeatures} features, elapsed ${elapsed}/${budget.maxElapsedMs} ms`,
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
    lines.push(`  输出: ${card.outputs.join('；')}`)
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
      + (plan.gaps.length === 0 ? '' : ` 缺口: ${plan.gaps.map(gap => `${gap.id}(${gap.status})`).join('/')}`)
      + (plan.goalRevision === goal.goalRevision ? '' : ` 写于旧目标，新计划须以 goal_revision=${goal.goalRevision} 提交`))
  lines.push(inputs.mapRevision === undefined
    ? '地图: map 容器未挂载'
    : `地图: revision=${inputs.mapRevision}, 图层=${inputs.mapLayerCount ?? 0}, 待定调用=${inputs.frame.pendingCalls.length}`)
  if (inputs.mapRevision !== undefined) {
    lines.push(layerListLine(inputs))
    lines.push(inputs.mapView === undefined
      ? '视窗: 未知'
      : `视窗: center=[${inputs.mapView.center[0]}, ${inputs.mapView.center[1]}] zoom=${inputs.mapView.zoom} wkid=${inputs.mapView.wkid}（当前显示范围，非研究区）`)
    if (inputs.userViewport !== undefined) lines.push(userViewportLineOf(inputs.userViewport))
    if (inputs.mapEnvironment !== undefined) {
      lines.push(`地图环境: ${inputs.mapEnvironment.mode === 'scene' ? '3D 场景' : '2D 地图'}, 底图=${line(inputs.mapEnvironment.basemap, 60)}`)
    }
    lines.push(proposalsLine(inputs), changesLine(inputs), aoiLine(inputs))
  }
  const resources = frame.resources.slice(-MAX_SNAPSHOT_RESOURCES)
  lines.push(resources.length === 0
    ? '资源候选: 无（用 catalog_register 登记或 catalog_resolve 解析精确版本）'
    : `资源候选: ${resources.map(resource => resourceCandidateLine(resource, inputs.refAvailability)).join('; ')}`)
  const evidence = frame.evidence.slice(-MAX_SNAPSHOT_EVIDENCE)
  lines.push(evidence.length === 0
    ? '证据: 尚无已结算记录（unknown/not_applicable/partial/blocked 不会被渲染为成功）'
    : `证据:\n${evidence.map(evidenceLineFor(goal.goalRevision)).map(text => `  ${text}`).join('\n')}`)
  lines.push(...cardLines(inputs))
  lines.push('工具能力: 以本轮模型请求提供的工具 schema 为准；方法建议不代表工具已挂载。缺少所需工具时报告缺口，不虚构执行结果。')
  const refusal = budgetRefusalOf(inputs)
  const stop = evaluateStops(inputs.frame, refusal)
  lines.push(`${STOP_LINE_PREFIX} ${stopLine(stop)}`)
  lines.push(...budgetLines(inputs))
  return lines.join('\n')
}

/** Render the tracked layer-list line, clipped at eight layers with an explicit note. */
function layerListLine(inputs: SnapshotInputs): string {
  const layers = inputs.mapLayers.slice(0, 8)
  return layers.length === 0
    ? '图层清单: 无（用 map_add_layer 加载或 map_draw 绘制）'
    : `图层清单: ${layers.map(layer => `${layer.id}=${line(layer.name, 40)}(${layer.visible ? '显示' : '隐藏'})`).join(', ')}${inputs.mapLayers.length > 8 ? ` …另有 ${inputs.mapLayers.length - 8} 层未列出` : ''}`
}

/** Render the tracked visual-candidate line (newest five). */
function proposalsLine(inputs: SnapshotInputs): string {
  const proposals = inputs.mapProposals ?? []
  return proposals.length === 0
    ? '视觉候选: 无（map_markup 的候选未经用户确认，不当作已确认目标）'
    : `视觉候选: ${proposals.slice(-5).map(proposal => `${proposal.id}=${line(proposal.name, 40)}(${candidateStatus(proposal.status)})`).join(', ')}${proposals.length > 5 ? ` …另有 ${proposals.length - 5} 条未列出` : ''}（confidence 为模型自评，非概率）`
}

/** Render the tracked visual-change-candidate line (newest five). */
function changesLine(inputs: SnapshotInputs): string {
  const changes = inputs.mapChanges ?? []
  return changes.length === 0
    ? '视觉变化候选: 无（map_mark_changes 的两图候选未经用户确认，不当作已确认变化）'
    : `视觉变化候选: ${changes.slice(-5).map(change => `${change.id}=${line(change.name, 40)}(${candidateStatus(change.status)})`).join(', ')}${changes.length > 5 ? ` …另有 ${changes.length - 5} 条未列出` : ''}（发布日不是发生日期，confidence 不是概率）`
}

/** Render the tracked AOI line; the viewport is never presented as the study area. */
function aoiLine(inputs: SnapshotInputs): string {
  if (inputs.mapAoi === null || inputs.mapAoi === undefined) return 'AOI: 未设置（研究区未定义；视窗不是 AOI）'
  const lons = inputs.mapAoi.ring.map(point => point[0])
  const lats = inputs.mapAoi.ring.map(point => point[1])
  return `AOI: ${inputs.mapAoi.name === undefined ? '未命名' : line(inputs.mapAoi.name, 40)} 外接框=[${round(Math.min(...lons))}, ${round(Math.min(...lats))}, ${round(Math.max(...lons))}, ${round(Math.max(...lats))}]（研究区，≠视窗）`
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
  const last = inputs.lastLines
  // The viewport line always compares; it repeats only after the user moved.
  const viewportLine = inputs.userViewport === undefined ? undefined : userViewportLineOf(inputs.userViewport)
  const changedLines = [
    ...(viewportLine === undefined || viewportLine === last?.[USER_VIEWPORT_LINE_PREFIX] ? [] : [viewportLine]),
    ...(last === undefined || inputs.mapRevision === undefined
      ? []
      : [layerListLine(inputs), proposalsLine(inputs), changesLine(inputs), aoiLine(inputs)].filter(text => last[prefixOf(text)] !== text)),
  ]
  const stopText = `${STOP_LINE_PREFIX} ${stopLine(evaluateStops(frame, budgetRefusalOf(inputs)))}`
  const stopChanged = last !== undefined && last[STOP_LINE_PREFIX] !== stopText
  if (newEvidence.length === 0 && newResources.length === 0 && !planChanged && changedLines.length === 0 && !stopChanged) return undefined
  lines.push(`自上次注入 seq=${sinceSeq} 的新事实:`)
  lines.push(...changedLines)
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
    lines.push(`新证据:\n${newEvidence.map(evidenceLineFor(frame.goal?.goalRevision ?? 0)).map(text => `  ${text}`).join('\n')}`)
  }
  lines.push(stopText)
  lines.push(...budgetLines(inputs))
  return lines.join('\n')
}

/** The tracked prefix one rendered tracked line starts with. */
function prefixOf(text: string): string {
  return TRACKED_LINE_PREFIXES.find(prefix => text.startsWith(prefix)) ?? text
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
