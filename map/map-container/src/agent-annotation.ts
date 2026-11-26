/** Versioned agent-owned annotation updates. */
import { z } from 'zod'
import { validateSymbolStyle } from '@map-harness/map-layers'
import { parseUserChangeRecord } from './user-change.ts'
import type { AgentAnnotationChange, AgentAnnotationMeta } from './protocol.ts'

/** Durable metadata discriminator for an agent annotation operation. */
export const AGENT_ANNOTATION_META_KIND = 'map-agent-annotation'
/** Current agent annotation metadata version. */
export const AGENT_ANNOTATION_SCHEMA_VERSION = 1

const agentChangeSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('annotation-layer-style'),
    symbol: z.custom(value => value === null || validateSymbolStyle(value).length === 0),
  }).strict(),
  z.object({
    op: z.literal('annotation-layer-order'),
    layerIds: z.array(z.string().min(1).max(128)).min(1).max(32)
      .refine(ids => new Set(ids).size === ids.length),
  }).strict(),
  ...(['visual-proposal-apply', 'visual-proposal-dismiss'] as const).map(op => z.object({
    op: z.literal(op), proposalId: z.string().regex(/^vprop-[0-9a-f]{24}$/u),
  }).strict()),
  ...(['visual-change-apply', 'visual-change-dismiss'] as const).map(op => z.object({
    op: z.literal(op), changeId: z.string().regex(/^vchange-[0-9a-f]{24}$/u),
  }).strict()),
])

const envelope = z.object({
  kind: z.literal(AGENT_ANNOTATION_META_KIND),
  schemaVersion: z.literal(AGENT_ANNOTATION_SCHEMA_VERSION),
  sourceCallSeq: z.number().int().nonnegative(),
  targetRevision: z.number().int().nonnegative(),
  operationId: z.string().regex(/^[A-Za-z0-9._:-]{1,96}$/u),
  sessionId: z.string().min(1).max(128),
  at: z.string().datetime(),
  featureId: z.string().regex(/^ann-[0-9a-f]{24}$/u).optional(),
  change: z.unknown(),
}).strict()

/**
 * Decode and validate an agent annotation operation without inferring identity.
 * @param value - untrusted tool-result metadata.
 * @returns the bounded metadata, or undefined when invalid.
 */
export function decodeAgentAnnotationMeta(value: unknown): AgentAnnotationMeta | undefined {
  const parsed = envelope.safeParse(value)
  if (!parsed.success) return undefined
  let encoded: string | undefined
  try {
    encoded = JSON.stringify(parsed.data)
  } catch (error) {
    if (error instanceof TypeError) return undefined
    throw error
  }
  if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > 16 * 1024) return undefined
  const { featureId, ...base } = parsed.data
  const record = parseUserChangeRecord({
    operationId: parsed.data.operationId,
    targetRevision: parsed.data.targetRevision,
    sessionId: parsed.data.sessionId,
    at: parsed.data.at,
    change: parsed.data.change,
  })
  if (record !== undefined && (record.change.op === 'annotation-update'
    || record.change.op === 'annotation-delete' || record.change.op === 'annotation-undo')) {
    if (featureId !== undefined) return undefined
    return { ...base, change: record.change }
  }
  const agentChange = agentChangeSchema.safeParse(parsed.data.change)
  if (!agentChange.success) return undefined
  const requiresFeature = agentChange.data.op === 'visual-proposal-apply' || agentChange.data.op === 'visual-change-apply'
  if (requiresFeature !== (featureId !== undefined)) return undefined
  return { ...base, ...(featureId === undefined ? {} : { featureId }), change: agentChange.data as AgentAnnotationChange }
}
