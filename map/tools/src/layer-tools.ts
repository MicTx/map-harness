/**
 * The layer presentation tools: `layer_set_state` (batch visibility,
 * opacity, and display-group changes as the single fine-grained state
 * channel) and `layer_set_style` (whole-layer symbol via symbol/preset/auto,
 * plus per-feature overrides) over the session's authoritative
 * `mapContainer` projection. Both are pure projection changes — they propose
 * versioned `map-change` v5 metas under the same commit protocol as every
 * other mutation (CAS against `targetRevision`, native-direct pairing,
 * zero-residue refusals), never a second state channel.
 *
 * Semantic checks run at this boundary AND again at the fold: heatmap
 * presentations require an all-Point layer without a classification style;
 * override ids must exist in the layer's data (`featureIdOf` keys); presets
 * resolve explicitly into full symbols before validation — no implicit
 * defaults cross the tool boundary.
 */
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  type MapChange,
  type MapContainerService,
  type MapPendingCall,
  type MapProjectedLayer,
  type MapProjectionState,
  buildMapChangeMeta,
  validateMapChangeCandidate,
} from '@map-harness/map-container'
import {
  SYMBOL_PRESET_IDS,
  autoSymbolOf,
  resolveSymbolPreset,
  validateFeatureOverrides,
  validateSymbolStyle,
  overridesVersionOf,
  symbolVersionOf,
  type FeatureOverride,
  type SymbolStyle,
  type SymbolStyleDraft,
} from '@map-harness/map-layers'
import { featureIdOf } from '@map-harness/spatial-viz'
import { SpatialError } from './spatial-errors.ts'
import { serviceOf } from './service-context.ts'
import { sessionOf } from './catalog-tools.ts'
import { decodeJsonParam } from './json-param.ts'
import { renderJson } from './output.ts'

/** Reach the projection read face from the tool's execution context (host-plane service). */
function mapServiceOf(exec: ToolRunContext): MapContainerService {
  const map = serviceOf<MapContainerService>(exec, 'map')
  if (map === undefined) throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', 'map container service unavailable in this process')
  return map
}

/** Resolve the accepted `tool/call` this execution pairs with (native-direct rule). */
function requirePendingLayerMutation(
  exec: ToolRunContext,
  service: MapContainerService,
  session: ReturnType<typeof sessionOf>,
  name: 'layer_set_state' | 'layer_set_style',
): MapPendingCall {
  if (exec.parent !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', 'layer tools support native model-direct calls only; nested dispatch cannot change the map')
  }
  exec.signal.throwIfAborted()
  const pending = service.pendingCallOf(session, exec.callId)
  if (pending === undefined) {
    throw new SpatialError('SPATIAL_SERVICE_UNAVAILABLE', `${name} requires its accepted tool/call in the session log before execution`)
  }
  if (pending.name !== name) {
    throw new SpatialError('INVALID_ARGUMENT', `session call ${exec.callId} is paired with tool ${pending.name}, not ${name}`)
  }
  return pending
}

/** Refuse when the caller's expected revision no longer matches the accepted one. */
function assertExpectedRevision(state: MapProjectionState, expected: unknown): void {
  if (expected === undefined) return
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    throw new SpatialError('INVALID_ARGUMENT', 'expected_revision must be a non-negative integer')
  }
  if (expected !== state.revision) {
    throw new SpatialError('INVALID_ARGUMENT', `expected_revision ${expected} is stale: the map is at revision ${state.revision}; re-read map_get_state and re-decide`)
  }
}

/** Resolve one target layer or name every current id in the refusal. */
function requireLayer(state: MapProjectionState, layerId: string): MapProjectedLayer {
  const layer = state.layers.find(candidate => candidate.id === layerId)
  if (layer === undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `unknown layer_id "${layerId}"; current layers: ${state.layers.map(candidate => candidate.id).join(', ') || '(none)'}`)
  }
  return layer
}

/** The model-facing summary of one layer's presentation state. */
function layerStateSummary(layer: MapProjectedLayer): { layer_id: string; visible: boolean; opacity: number; group?: string } {
  return {
    layer_id: layer.id,
    visible: layer.visible,
    opacity: layer.opacity,
    ...(layer.group === undefined ? {} : { group: layer.group }),
  }
}

/**
 * `layer_set_state`: propose one batched presentation-state change
 * (visibility, opacity, display group) for 1..32 existing layers — one new
 * revision, undoable as one operation. This is the fine-grained state
 * channel: replacing a whole layer to flip its visibility burns the rendered
 * identity; this change never touches data or digests.
 */
export const layerSetState = defineTool({
  name: 'layer_set_state',
  description:
    'Batch-update layer presentation state on the session map: visibility, opacity (0..1), and display group per layer, as ONE revision (one undo). '
    + 'Give 1..32 entries [{layer_id, visible?, opacity?, group?}] (group null clears it; each entry sets at least one field). '
    + 'Layer data, order, and styles stay untouched — this never re-admits or replaces a layer.',
  parameters: {
    states: {
      type: 'json',
      required: true,
      description: 'Array of 1..32 entries: {layer_id, visible?: boolean, opacity?: number 0..1, group?: string 1..64 chars | null}.',
    },
    expected_revision: { type: 'number', description: 'Refuse unless the map is still at this revision (from map_get_state).' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const { states: rawStates, expected_revision: expectedRevision } = args as { states?: unknown; expected_revision?: unknown }
    const decoded = decodeJsonParam(rawStates, 'states')
    if (decoded === undefined || !Array.isArray(decoded) || decoded.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'states must be a non-empty array of {layer_id, visible?, opacity?, group?} entries')
    }
    if (decoded.length > 32) {
      throw new SpatialError('INVALID_ARGUMENT', 'states accepts at most 32 entries; split larger batches into sequential calls')
    }
    const seen = new Set<string>()
    for (const [at, entry] of decoded.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new SpatialError('INVALID_ARGUMENT', `states[${at}] must be an object`)
      }
      const { layer_id: layerId, visible, opacity, group } = entry as Record<string, unknown>
      if (typeof layerId !== 'string' || layerId.length === 0) {
        throw new SpatialError('INVALID_ARGUMENT', `states[${at}].layer_id must be a non-empty string`)
      }
      if (seen.has(layerId)) {
        throw new SpatialError('INVALID_ARGUMENT', `duplicate states entry for layer "${layerId}"; one entry per layer per call`)
      }
      seen.add(layerId)
      if (visible !== undefined && typeof visible !== 'boolean') {
        throw new SpatialError('INVALID_ARGUMENT', `states[${at}].visible must be a boolean`)
      }
      if (opacity !== undefined && (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1)) {
        throw new SpatialError('INVALID_ARGUMENT', `states[${at}].opacity must be a number in [0, 1]`)
      }
      if (group !== null && group !== undefined && (typeof group !== 'string' || group.length === 0 || group.length > 64)) {
        throw new SpatialError('INVALID_ARGUMENT', `states[${at}].group must be a string of 1..64 characters, or null to clear`)
      }
      if (visible === undefined && opacity === undefined && group === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `states[${at}] sets no field; give visible, opacity, or group`)
      }
    }
    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingLayerMutation(exec, service, session, 'layer_set_state')
    const state = service.stateOf(session)
    assertExpectedRevision(state, expectedRevision)
    for (const entry of decoded) {
      requireLayer(state, (entry as { layer_id: string }).layer_id)
    }
    const change = {
      op: 'set-layer-state',
      states: decoded.map(entry => {
        const { layer_id: layerId, visible, opacity, group } = entry as Record<string, unknown>
        return {
          layerId: layerId as string,
          ...(visible === undefined ? {} : { visible: visible as boolean }),
          ...(opacity === undefined ? {} : { opacity: opacity as number }),
          ...(group === undefined ? {} : { group: group as string | null }),
        }
      }),
    } as const
    let targetRevision: number
    try {
      targetRevision = validateMapChangeCandidate(state, change)
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw new SpatialError('INVALID_ARGUMENT', `layer_set_state refused: ${error.message}`)
      }
      throw error
    }
    exec.signal.throwIfAborted()
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    return {
      updated: change.states.map(entry => entry.layerId),
      states: change.states.map(entry => {
        const layer = state.layers.find(candidate => candidate.id === entry.layerId)
        if (layer === undefined) return { layer_id: entry.layerId }
        return layerStateSummary({
          ...layer,
          visible: entry.visible ?? layer.visible,
          opacity: entry.opacity ?? layer.opacity,
          ...(entry.group === undefined
            ? (layer.group === undefined ? {} : { group: layer.group })
            : (entry.group === null ? {} : { group: entry.group })),
        })
      }),
      target_revision: targetRevision,
      meta,
    }
  },
})

/** Lowercase every `#RRGGBB` string in one decoded record (the contract admits lowercase hex only). */
function lowerHexColors(value: unknown): unknown {
  if (typeof value === 'string') return /^#[0-9A-Fa-f]{6}$/.test(value) ? value.toLowerCase() : value
  if (Array.isArray(value)) return value.map(lowerHexColors)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, lowerHexColors(entry)]))
  }
  return value
}

/**
 * Decode one model-authored symbol argument and stamp its derived
 * `symbolVersion`. The model writes the presentation; the digest is the
 * tool's job, so any version the model sent is replaced, never trusted.
 * @param raw - the `symbol` argument (object or JSON string).
 * @param layerId - the target layer id the refusal names.
 * @returns the versioned, validated symbol.
 */
export function modelSymbolOf(raw: unknown, layerId: string): SymbolStyle {
  const decoded = decodeJsonParam(raw, 'symbol')
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new SpatialError('INVALID_ARGUMENT', 'symbol must be a SymbolStyle record')
  }
  const { symbolVersion: _ignored, ...draft } = lowerHexColors(decoded) as Record<string, unknown>
  const symbol = { ...draft, symbolVersion: symbolVersionOf(draft as SymbolStyleDraft) } as SymbolStyle
  assertValidSymbol(symbol, layerId)
  return symbol
}

/** Validate one resolved symbol and surface its issues as one model-readable error. */
function assertValidSymbol(symbol: SymbolStyle, layerId: string): void {
  const issues = validateSymbolStyle(symbol)
  if (issues.length > 0) {
    const first = issues[0]
    throw new SpatialError('INVALID_ARGUMENT', `symbol for layer "${layerId}" rejected: ${first?.field} (${first?.code})`)
  }
}

/**
 * The heatmap exclusivity checks (tool side of the double rejection).
 * @param symbol - the resolved symbol.
 * @param layer - the layer it would style.
 */
export function assertHeatmapAdmissible(symbol: SymbolStyle, layer: MapProjectedLayer): void {
  if (symbol.presentation !== 'heatmap') return
  if (layer.style !== undefined) {
    throw new SpatialError('INVALID_ARGUMENT', `layer "${layer.id}" carries a classification style (viz_classify); a heatmap presentation is exclusive with it — clear the style first`)
  }
  const features = (layer.data as { features?: { geometry?: { type?: string } | null }[] } | undefined)?.features
  const allPoints = features !== undefined && features.every(feature => feature.geometry?.type === 'Point')
  if (!allPoints) {
    throw new SpatialError('GEOMETRY_UNSUPPORTED', `layer "${layer.id}" is not all-Point; a heatmap presentation requires point features`)
  }
}

/** Validate one bare override entry list and surface its issues. */
function assertValidOverrides(entries: readonly FeatureOverride[], layerId: string): void {
  const issues = validateFeatureOverrides({ overridesVersion: overridesVersionOf(entries), entries })
  if (issues.length > 0) {
    const first = issues[0]
    throw new SpatialError('INVALID_ARGUMENT', `overrides for layer "${layerId}" rejected: ${first?.field} (${first?.code})`)
  }
}

/** Check every override id against the layer's actual feature-id set (`featureIdOf` keys). */
function assertOverrideIdsKnown(entries: readonly FeatureOverride[], layer: MapProjectedLayer): void {
  const features = (layer.data as { features?: readonly { id?: unknown }[] } | undefined)?.features ?? []
  const known = new Set<string>()
  for (const [index, feature] of features.entries()) {
    known.add(featureIdOf(feature, index))
  }
  for (const entry of entries) {
    for (const id of entry.featureIds) {
      if (!known.has(id)) {
        throw new SpatialError('INVALID_ARGUMENT', `overrides name unknown feature id "${id}" on layer "${layer.id}"; read the layer's feature ids from map_get_state or its attribute table first`)
      }
    }
  }
}

/**
 * `layer_set_style`: propose the presentation style of one layer — a whole-
 * layer symbol (`symbol` JSON, `preset` id, or `auto` for the deterministic
 * palette color) and/or per-feature `overrides` (or null to clear either).
 * One call restyling both composes into one revision.
 */
export const layerSetStyle = defineTool({
  name: 'layer_set_style',
  description:
    'Style one layer\'s presentation on the session map. Give exactly one symbol source — `symbol` (full SymbolStyle JSON), `preset` (a preset id like "marker-square-red-large"), or `auto` (deterministic palette color for the layer id) — '
    + 'and optionally `overrides` (per-feature patches [{featureIds, patch:{color?,sizePx?,opacity?,...}}]) or null to clear existing ones. '
    + 'symbol/preset/auto and overrides=null may combine in one call; symbol null clears the layer symbol back to auto. '
    + 'Heatmap presentations require an all-Point layer with no classification style.',
  parameters: {
    layer_id: { type: 'string', required: true, description: 'The layer id previously reported by map_add_layer / map_get_state.' },
    symbol: { type: 'json', description: 'SymbolStyle record you design (symbolVersion is derived by the tool; omit it) (single: point/line/fill blocks plus optional semantic — poi|facility|transit|road|route|boundary|water|green|building|landuse|aoi|hotspot, which supplies default blocks — and optional label {field, minZoom?, maxZoom?} for collision-free auto labels; heatmap: radius/ramp). Mutually exclusive with preset and auto; null clears the layer symbol.' },
    preset: { type: 'string', description: 'Preset id (e.g. "marker-square-red-large" or "preset:fill-translucent-orange"); expands to a full symbol.' },
    auto: { type: 'boolean', description: 'true: use the deterministic palette color for this layer id (autoSymbolOf).' },
    overrides: { type: 'json', description: 'Array of {featureIds, patch} entries (feature ids from the layer data), or null to clear existing overrides.' },
    expected_revision: { type: 'number', description: 'Refuse unless the map is still at this revision (from map_get_state).' },
  },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => {
      const { meta: _meta, ...rest } = value as Record<string, unknown>
      return renderJson(rest)
    },
    presentationMeta: (_args, value) => (value as { meta?: JsonValue }).meta ?? null,
  },
  async execute(args, exec) {
    const {
      layer_id: layerId,
      symbol: rawSymbol,
      preset,
      auto,
      overrides: rawOverrides,
      expected_revision: expectedRevision,
    } = args as { layer_id?: unknown; symbol?: unknown; preset?: unknown; auto?: unknown; overrides?: unknown; expected_revision?: unknown }
    if (typeof layerId !== 'string' || layerId.length === 0) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_id must be a non-empty string')
    }
    const symbolSources = [rawSymbol, preset, auto].filter(value => value !== undefined).length
    if (symbolSources > 1) {
      throw new SpatialError('INVALID_ARGUMENT', 'symbol, preset, and auto are mutually exclusive: give exactly one symbol source')
    }
    if (symbolSources === 0 && rawOverrides === undefined) {
      throw new SpatialError('INVALID_ARGUMENT', 'layer_set_style needs a symbol source (symbol/preset/auto) and/or overrides')
    }
    if (preset !== undefined && typeof preset !== 'string') {
      throw new SpatialError('INVALID_ARGUMENT', 'preset must be a preset id string')
    }
    if (auto !== undefined && typeof auto !== 'boolean') {
      throw new SpatialError('INVALID_ARGUMENT', 'auto must be a boolean')
    }
    if (preset !== undefined) {
      const resolved = resolveSymbolPreset(preset)
      if (resolved === undefined) {
        throw new SpatialError('INVALID_ARGUMENT', `unknown preset "${preset}"; presets: ${SYMBOL_PRESET_IDS.map(id => id.replace(/^preset:/, '')).join(', ')}`)
      }
    }

    const session = sessionOf(exec)
    const service = mapServiceOf(exec)
    const pending = requirePendingLayerMutation(exec, service, session, 'layer_set_style')
    const state = service.stateOf(session)
    assertExpectedRevision(state, expectedRevision)
    const layer = requireLayer(state, layerId)

    let symbolEntry: { layerId: string; symbol: SymbolStyle | null } | undefined
    if (rawSymbol !== undefined || preset !== undefined || auto !== undefined) {
      let symbol: SymbolStyle | null
      if (rawSymbol === null) {
        symbol = null
      } else if (preset !== undefined) {
        symbol = resolveSymbolPreset(preset as string)?.symbol as SymbolStyle
      } else if (auto === true) {
        symbol = autoSymbolOf(layerId)
      } else {
        symbol = modelSymbolOf(rawSymbol, layerId)
      }
      if (symbol !== null) {
        assertValidSymbol(symbol, layerId)
        assertHeatmapAdmissible(symbol, layer)
      }
      symbolEntry = { layerId, symbol }
    }

    let overridesEntry: { layerId: string; overrides: readonly FeatureOverride[] | null } | undefined
    if (rawOverrides !== undefined) {
      if (rawOverrides === null) {
        overridesEntry = { layerId, overrides: null }
      } else {
        const decoded = decodeJsonParam(rawOverrides, 'overrides')
        if (decoded === undefined || !Array.isArray(decoded) || decoded.length === 0) {
          throw new SpatialError('INVALID_ARGUMENT', 'overrides must be a non-empty array of {featureIds, patch} entries, or null to clear')
        }
        const entries = decoded as FeatureOverride[]
        assertValidOverrides(entries, layerId)
        assertOverrideIdsKnown(entries, layer)
        overridesEntry = { layerId, overrides: entries }
      }
    }

    const changes = [
      ...(symbolEntry === undefined ? [] : [{ op: 'set-symbol-style', entries: [symbolEntry] } as const]),
      ...(overridesEntry === undefined ? [] : [{ op: 'set-feature-overrides', entries: [overridesEntry] } as const]),
    ]
    const change: MapChange = changes.length === 2
      ? { op: 'patch', changes: [changes[0]!, changes[1]!] }
      : changes[0]!
    let targetRevision: number
    try {
      targetRevision = validateMapChangeCandidate(state, change)
    } catch (error) {
      if (error instanceof Error && 'code' in error) {
        throw new SpatialError('INVALID_ARGUMENT', `layer_set_style refused: ${error.message}`)
      }
      throw error
    }
    exec.signal.throwIfAborted()
    const meta: JsonValue = JSON.parse(JSON.stringify(buildMapChangeMeta(pending.callSeq, targetRevision, change)))
    const reportedSymbol = symbolEntry === undefined
      ? undefined
      : symbolEntry.symbol === null
        ? autoSymbolOf(layerId)
        : symbolEntry.symbol
    return {
      layer: layerStateSummary(layer),
      ...(reportedSymbol === undefined ? {} : { symbol_version: reportedSymbol.symbolVersion }),
      ...(overridesEntry === undefined ? {} : { overrides_version: overridesEntry.overrides === null ? null : overridesVersionOf(overridesEntry.overrides) }),
      target_revision: targetRevision,
      meta,
    }
  },
})
