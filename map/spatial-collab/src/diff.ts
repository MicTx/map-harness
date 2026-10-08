/**
 * The explainable conflict difference: what one failed patch assumed versus
 * what the authoritative document actually looks like, per failing
 * operation, plus the current layer identity face. The diff is data first —
 * the bounded text rendering exists for model-facing tool output.
 *
 * @module @map-harness/spatial-collab/diff
 */
import type { CollabConflictDiff, CollabDocument } from './contract.ts'

/** Maximum entries the text rendering prints before it counts the rest. */
const MAX_DIFF_LINES = 12

/**
 * Diff two document faces at layer identity level (added, removed, changed
 * digest, reordered) plus the view/mode/aoi values. This is the read face a
 * conflicting writer gets so it can re-decide explicitly — the server never
 * rewrites a stale patch into the new base.
 * @param base - the document the patch was prepared against (when known).
 * @param current - the authoritative document at conflict time.
 * @returns one bounded summary line naming every difference class.
 */
export function diffDocumentSummary(base: CollabDocument | undefined, current: CollabDocument): string {
  const parts: string[] = []
  if (base === undefined) {
    parts.push(`revision moved to ${current.revision}`)
  } else {
    const baseIds = new Set(base.layers.map(layer => layer.id))
    const currentIds = new Set(current.layers.map(layer => layer.id))
    const added = current.layers.filter(layer => !baseIds.has(layer.id)).map(layer => layer.id)
    const removed = base.layers.filter(layer => !currentIds.has(layer.id)).map(layer => layer.id)
    const changed = current.layers.filter(layer => {
      const before = base.layers.find(candidate => candidate.id === layer.id)
      return before !== undefined && before.digest !== layer.digest
    }).map(layer => layer.id)
    const orderChanged = added.length === 0 && removed.length === 0
      && base.layers.some((layer, index) => current.layers[index]?.id !== layer.id)
    if (added.length > 0) parts.push(`layers added: ${added.join(', ')}`)
    if (removed.length > 0) parts.push(`layers removed: ${removed.join(', ')}`)
    if (changed.length > 0) parts.push(`layers changed: ${changed.join(', ')}`)
    if (orderChanged) parts.push('layer order changed')
    if (JSON.stringify(base.view) !== JSON.stringify(current.view)) parts.push('view changed')
    if (base.mode !== current.mode) parts.push(`mode changed to ${current.mode}`)
    if (base.aoiDigest !== current.aoiDigest) parts.push('aoi changed')
    if (parts.length === 0) parts.push('no document content change since the base revision')
  }
  return parts.join('; ')
}

/**
 * Render one conflict diff as bounded model-facing text: every failing op on
 * its own line (up to the line bound), then the current layer identities.
 * @param diff - the conflict diff the engine returned.
 * @returns the text the tool embeds in its conflict response.
 */
export function renderConflictDiff(diff: CollabConflictDiff): string {
  const lines: string[] = []
  const entries = diff.entries.slice(0, MAX_DIFF_LINES)
  for (const entry of entries) {
    lines.push(`op[${entry.index}] ${entry.kind}: ${entry.code} — ${entry.detail}`)
  }
  if (diff.entries.length > entries.length) {
    lines.push(`… ${diff.entries.length - entries.length} more conflicting ops`)
  }
  const layers = diff.currentLayers.slice(0, MAX_DIFF_LINES)
  for (const layer of layers) {
    lines.push(`layer ${layer.id}${layer.digest === undefined ? '' : ` @${layer.digest}`}`)
  }
  if (diff.currentLayers.length > layers.length) {
    lines.push(`… ${diff.currentLayers.length - layers.length} more layers`)
  }
  lines.push(diff.summary)
  return lines.join('\n')
}
