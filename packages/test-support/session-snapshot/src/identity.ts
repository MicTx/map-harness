/** Relationship-preserving identity redaction for committed session snapshots. */

const UUID_FRAGMENT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const SHORT_JOB_ID_RE = /-[0-9a-f]{16}$/i
const LEGACY_TOKEN_RE = /^\{\{(?:sessionId|messageId)\}\}$/
const CANONICAL_TOKEN_RE = /^\{\{(session|message|approval|workflow|command|rpc|retry|digest|id):([1-9]\d*)\}\}$/
const ID_KEY_RE = /(?:^id$|Id$|Ids$)/

type IdentityKind = 'session' | 'message' | 'approval' | 'workflow' | 'command' | 'rpc' | 'retry' | 'digest' | 'id'

const SPATIAL_SNAPSHOT_HEADER =
  /^spatial-context\/snapshot v1 kind=(?:baseline|increment) goal=\d+ digest=([0-9a-f]{16}|\{\{digest:[1-9]\d*\}\})/
const SPATIAL_BUDGET = /(预算: steps \d+\/(?:\d+|不限), meta \d+\/\d+ B, context )\d+(\/\d+ B, scan \d+\/\d+ features, elapsed )\d+(\/\d+ ms)/
const MAP_TOOL_NAME = new RegExp(`^(?:${[
  'catalog_(?:register|resolve)', 'map_(?:add_layer|save|observe|use)', 'geo_(?:buffer|area|intersect|distance)',
  'data_(?:import|export)',
  'layer_set_(?:state|style)',
  'run_(?:submit|get|cancel)', 'viz_(?:create_style|classify|compare|aggregate)', 'stats_(?:zonal|autocorrelation|hotspot)',
  'pattern_(?:change|cluster|flow)', 'attribution_(?:association|explain|effect)', 'forecast_(?:validate|fit|predict)',
  'scenario_compare', 'location_allocate', 'terrain_(?:add_layer|viewshed)', 'geo_line_of_sight',
  'stream_(?:open|advance|pause|resume|materialize)', 'scale_(?:ingest|read|scan)',
].join('|')})$`)

interface ParsedLog {
  readonly records: Record<string, unknown>[]
  readonly trailingNewline: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseLog(log: string): ParsedLog {
  return {
    records: log.split(/\r?\n/)
      .filter(line => line.trim() !== '')
      .map(line => JSON.parse(line) as Record<string, unknown>),
    trailingNewline: log.endsWith('\n'),
  }
}

function messageId(value: unknown): string | undefined {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.role !== 'string'
    || !Array.isArray(value.content)
    || !isRecord(value.source)) return undefined
  return value.id
}

function redactedCandidate(value: string): boolean {
  return UUID_FRAGMENT_RE.test(value) || SHORT_JOB_ID_RE.test(value)
    || LEGACY_TOKEN_RE.test(value) || CANONICAL_TOKEN_RE.test(value)
}

/**
 * Replace volatile opaque ids while preserving equality relationships across a parent and its child logs.
 * Map tool JSON additionally claims opaque resource-read, artifact, run, observation and view identities.
 * Streamed arguments claim run and observation identities by value; a shared call id is not equality evidence.
 * Packed pieces that straddle a claimed identity are rewritten in place, keeping their count and timings.
 * Paired map receipts normalize capture/deadline clocks, not epochs or counters.
 * Unexhausted elapsed budgets retain their configured limit as 0/limit; unlimited budgets use 0/null.
 * Exhausted or invalid pairs stay exact.
 * Identified spatial-context messages normalize elapsed time, its dependent context-byte
 * counter and body digest; business metrics and budget limits remain exact where recoverable.
 * @param logs - one scenario's primary-first session JSONL fixtures.
 * @returns compact JSONL with typed first-seen identity tokens.
 */
export function redactSessionSnapshotIds(logs: readonly string[]): string[] {
  const parsed = logs.map(parseLog)
  // Observation identities must not collide with canonical references encountered later.
  const reservedTokens = new Set(logs.flatMap(log => log.match(/\{\{id:[1-9]\d*\}\}/g) ?? []))
  const tokenByValue = new Map<string, string>()
  const nextByKind = new Map<IdentityKind, number>()
  const spatialTexts = new Set<string>()

  const claim = (value: unknown, kind: IdentityKind, always = false): void => {
    if (typeof value !== 'string' || value.length === 0 || tokenByValue.has(value)) return
    if (!always && !redactedCandidate(value)) return
    const canonical = CANONICAL_TOKEN_RE.exec(value)
    if (canonical !== null) {
      const canonicalKind = canonical[1] as IdentityKind
      const ordinal = Number(canonical[2])
      nextByKind.set(canonicalKind, Math.max(nextByKind.get(canonicalKind) ?? 0, ordinal))
      tokenByValue.set(value, value)
      return
    }
    let next = (nextByKind.get(kind) ?? 0) + 1
    while (reservedTokens.has(`{{${kind}:${next}}}`)) next += 1
    nextByKind.set(kind, next)
    tokenByValue.set(value, `{{${kind}:${next}}}`)
  }

  for (const log of parsed) {
    const header = log.records[0]
    if (header?.type === 'session') claim(header.id, 'session', true)
  }

  const collect = (value: unknown, recordType?: unknown): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\bas message ([0-9a-f-]{36})\b/gi)) claim(match[1], 'message')
      for (const match of value.matchAll(/\bAnonymous user: ([0-9a-f-]{36})\b/gi)) claim(match[1], 'id')
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, recordType)
      return
    }
    if (!isRecord(value)) return

    const identifiedMessage = messageId(value)
    if (identifiedMessage !== undefined) claim(identifiedMessage, 'message')
    for (const [childKey, item] of Object.entries(value)) {
      if (recordType === 'approval/asked' || recordType === 'approval/decided') {
        if (childKey === 'id') claim(item, 'approval')
      } else if (childKey === 'commandId') {
        claim(item, 'command', true)
      } else if (childKey === 'rpcId') {
        claim(item, 'rpc', true)
      } else if (childKey === 'retryId') {
        claim(item, 'retry')
      } else if (childKey === 'runId') {
        claim(item, 'workflow')
      } else if (ID_KEY_RE.test(childKey)) {
        claim(item, 'id')
      }
      collect(item, recordType)
    }
  }
  const collectMapJson = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (CANONICAL_TOKEN_RE.test(value)) claim(value, 'id')
      if (/^art-[0-9a-f-]{36}@v\d+$/.test(value)) claim(value, 'id')
      if (key === 'readId') claim(value, 'id')
      if (key === 'readAt' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) claim(value, 'id', true)
      if (key === 'run_id') claim(value, 'workflow')
      if (key === 'observation_id' || key === 'view_id') claim(value, 'id')
      if (key === 'operation_ref' && /^op-[0-9a-f]{24}$/.test(value)) claim(value, 'id', true)
    } else if (Array.isArray(value)) {
      for (const item of value) collectMapJson(item)
    } else if (isRecord(value)) {
      for (const [name, item] of Object.entries(value)) collectMapJson(item, name)
    }
  }
  const collectSpatialTexts = (value: unknown): void => {
    if (typeof value === 'string') {
      const digest = SPATIAL_SNAPSHOT_HEADER.exec(value)?.[1]
      if (digest !== undefined) {
        spatialTexts.add(value)
        claim(digest, 'digest', true)
      }
    } else if (Array.isArray(value)) {
      for (const item of value) collectSpatialTexts(item)
    } else if (isRecord(value)) {
      for (const item of Object.values(value)) collectSpatialTexts(item)
    }
  }
  for (const log of parsed) {
    const tools = new Map<string, string>()
    for (const record of log.records) {
      const data = isRecord(record.data) ? record.data : undefined
      if (record.type === 'tool/call' && typeof data?.callId === 'string' && typeof data.name === 'string') {
        tools.set(data.callId, data.name)
      }
      if (record.type === 'user/message' && isRecord(data?.source)
        && (data.source.plugin === '@map-harness/spatial-context' || data.source.kind === 'plugin:@map-harness/spatial-context')) {
        collectSpatialTexts(data)
      }
      const message = isRecord(data?.message) ? data.message : undefined
      if (record.type === 'assistant/message' && Array.isArray(data?.stream)) {
        // Identities are claimed by value everywhere; a shared call id does not
        // establish that a streamed id equals the settled argument's token.
        const settled = isRecord(message) && Array.isArray(message.content) ? message.content : []
        for (const block of settled) {
          if (!isRecord(block) || block.type !== 'tool-call' || typeof block.id !== 'string' || typeof block.arguments !== 'string') continue
          const run = /\{\{workflow:[1-9]\d*\}\}/.exec(block.arguments)?.[0]
          const observation = /"observation_id"\s*:\s*"(\{\{id:[1-9]\d*\}\})"/.exec(block.arguments)?.[1]
          if (run !== undefined) claim(run, 'workflow')
          if (observation !== undefined) claim(observation, 'id')
        }
        for (const member of data.stream) {
          if (!isRecord(member) || member.type !== 'tool-call-chunks' || !Array.isArray(member.args)) continue
          let decoded: unknown
          try {
            decoded = JSON.parse(member.args.filter(piece => typeof piece === 'string').join(''))
          } catch (error: unknown) {
            // Partial arguments and non-JSON deltas contribute no identity claims.
            if (error instanceof SyntaxError) continue
            throw error
          }
          collectMapJson(decoded)
        }
      }
      if (record.type === 'tool/result' && typeof message?.toolCallId === 'string'
        && MAP_TOOL_NAME.test(tools.get(message.toolCallId) ?? '') && Array.isArray(message.content)) {
        const toolName = tools.get(message.toolCallId)
        const meta = isRecord(data?.meta) ? data.meta : undefined
        const receipt = isRecord(meta?.record) ? meta.record : undefined
        const mapUse = toolName === 'map_use' && meta?.kind === 'map-use'
        if (toolName === 'map_observe' && meta?.kind === 'map-observation'
          && receipt !== undefined && typeof receipt.capturedAt === 'string'
          && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(receipt.capturedAt)) {
          receipt.capturedAt = '{{clock}}'
        }
        if (mapUse && receipt !== undefined && typeof receipt.expiresAtMs === 'number' && receipt.expiresAtMs >= 0) {
          receipt.expiresAtMs = 0
        }
        for (const block of message.content) {
          if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') continue
          let decoded: unknown
          try {
            decoded = JSON.parse(block.text)
          } catch (error: unknown) {
            // Tool error prose is not a JSON result and contributes no identity claims.
            if (error instanceof SyntaxError) continue
            throw error
          }
          collectMapJson(decoded)
          if (mapUse && isRecord(decoded) && isRecord(decoded.budget)) {
            const { elapsedMs, elapsedRemainingMs } = decoded.budget
            // Only an unexhausted pair identifies the configured elapsed limit.
            if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
              if (elapsedRemainingMs === null) {
                decoded.budget.elapsedMs = 0
                block.text = JSON.stringify(decoded)
              } else if (typeof elapsedRemainingMs === 'number' && elapsedRemainingMs > 0
                && Number.isFinite(elapsedMs + elapsedRemainingMs)) {
                decoded.budget.elapsedMs = 0
                decoded.budget.elapsedRemainingMs = elapsedMs + elapsedRemainingMs
                block.text = JSON.stringify(decoded)
              }
            }
          }
        }
      }
      if (record.type === 'feedback/message-put' && isRecord(record.data) && isRecord(record.data.item)) {
        claim(record.data.item.version, 'id')
      }
      collect(record, record.type)
    }
  }

  const replacements = [...tokenByValue]
    .sort(([left], [right]) => right.length - left.length)

  // Preserve recorded timing and chunk count when a claimed identity crosses delta boundaries.
  for (const log of parsed) {
    for (const record of log.records) {
      const data = isRecord(record.data) ? record.data : undefined
      if (record.type !== 'assistant/message' || !Array.isArray(data?.stream)) continue
      const message = isRecord(data.message) ? data.message : undefined
      if (!Array.isArray(message?.content)) continue
      const calls = new Set(message.content.flatMap(block =>
        isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string' ? [block.id] : []))
      for (const member of data.stream) {
        if (!isRecord(member) || member.type !== 'tool-call-chunks'
          || typeof member.id !== 'string' || !calls.has(member.id)
          || !Array.isArray(member.args) || !member.args.every(piece => typeof piece === 'string')) continue
        const pieces: string[] = member.args
        let joined = pieces.join('')
        const lengths = pieces.map(piece => piece.length)
        let changed = false
        for (const [source, token] of replacements) {
          if (!/^(?:obs|run)-[0-9a-f-]{36}$/i.test(source)) continue
          const at = joined.indexOf(source)
          if (at < 0) continue
          const end = at + source.length
          let offset = 0
          for (let index = 0; index < lengths.length; index += 1) {
            const length = lengths[index] as number
            const overlap = Math.max(0, Math.min(offset + length, end) - Math.max(offset, at))
            lengths[index] = length - overlap + (offset <= at && at < offset + length ? token.length : 0)
            offset += length
          }
          joined = joined.slice(0, at) + token + joined.slice(end)
          changed = true
        }
        if (!changed) continue
        let offset = 0
        member.args = lengths.map((length) => {
          const part = joined.slice(offset, offset + length)
          offset += length
          return part
        })
      }
    }
  }

  const replace = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const exact = tokenByValue.get(value)
      if (exact !== undefined) return exact
      let output = value
      for (const [source, token] of replacements) output = output.split(source).join(token)
      if (spatialTexts.has(value)) output = output.replace(SPATIAL_BUDGET, '$1{{contextBytes}}$2{{elapsed}}$3')
      return output
    }
    if (Array.isArray(value)) return value.map(replace)
    if (isRecord(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    }
    return value
  }

  return parsed.map((log) => {
    const content = log.records.map(record => JSON.stringify(replace(record))).join('\n')
    return log.trailingNewline ? `${content}\n` : content
  })
}
