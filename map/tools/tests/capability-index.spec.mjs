import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  ARCGIS_MAP_TOOL_NAMES,
  COLLAB_TOOL_NAMES,
  DATA_CHAIN_TOOL_NAMES,
  DATA_TOOL_NAMES,
  DECISION_MODEL_TOOL_NAMES,
  DECISION_TOOL_NAMES,
  GEO_TOOL_NAMES,
  LAYER_TOOL_NAMES,
  RUN_TOOL_NAMES,
  SCALE_TOOL_NAMES,
  STAT_TOOL_NAMES,
  STREAM_TOOL_NAMES,
  TERRAIN_TOOL_NAMES,
  VIZ_TOOL_NAMES,
} from '../src/mcp-service.ts'
import { SPATIAL_MCP_TOOL_NAMES, SPATIAL_TOOL_CATALOG } from '../src/spatial-catalog.ts'
import { DIRECT_SPATIAL_HANDLERS } from '../src/a-index.ts'

/** The family name arrays whose union is the fixed catalog, with their source labels. */
const FAMILY_ARRAYS = {
  ARCGIS_MAP_TOOL_NAMES,
  GEO_TOOL_NAMES,
  DATA_CHAIN_TOOL_NAMES,
  DATA_TOOL_NAMES,
  DECISION_TOOL_NAMES,
  RUN_TOOL_NAMES,
  STAT_TOOL_NAMES,
  DECISION_MODEL_TOOL_NAMES,
  VIZ_TOOL_NAMES,
  COLLAB_TOOL_NAMES,
  LAYER_TOOL_NAMES,
  TERRAIN_TOOL_NAMES,
  STREAM_TOOL_NAMES,
  SCALE_TOOL_NAMES,
}

const catalogPath = fileURLToPath(new URL('../../arcgis-mcp/src/catalog.ts', import.meta.url))
const docPath = fileURLToPath(new URL('../../docs/arcgis-mcp.md', import.meta.url))

test('spatial tool names are unique and every family array contributes', () => {
  const names = [...SPATIAL_MCP_TOOL_NAMES]
  assert.equal(new Set(names).size, names.length, 'duplicate name in SPATIAL_MCP_TOOL_NAMES')
  for (const [label, familyNames] of Object.entries(FAMILY_ARRAYS)) {
    assert.ok(familyNames.length > 0, label + ' must not be empty')
    assert.deepEqual(new Set(familyNames).size, familyNames.length, 'duplicate name in ' + label)
  }
  const union = Object.values(FAMILY_ARRAYS).flat()
  assert.deepEqual(new Set(union).size, union.length, 'a name appears in two family arrays')
  assert.deepEqual([...union].sort(), [...names].sort(), 'family union must equal SPATIAL_MCP_TOOL_NAMES')
})

test('every catalog name has exactly one complete identity row', () => {
  assert.deepEqual(SPATIAL_TOOL_CATALOG.map(row => row.name).sort(), [...SPATIAL_MCP_TOOL_NAMES].sort())
  for (const row of SPATIAL_TOOL_CATALOG) {
    assert.match(row.name, /^[a-z][a-z0-9_]*$/, row.name + ' is not a snake_case tool name')
    assert.ok(typeof row.family === 'string' && row.family.length > 0, row.name + ' lacks a family')
    assert.equal(row.owner, '@map-harness/map-tools', row.name + ' has the wrong owner')
    assert.equal(row.provider, '@map-harness/arcgis-mcp', row.name + ' has the wrong provider')
    if (row.metaKind === null) assert.equal(row.metaSchemaVersion, null, row.name + ' carries a version without a meta kind')
    else {
      assert.equal(typeof row.metaSchemaVersion, 'number', row.name + ' carries a meta kind without a version')
      assert.ok(row.metaSchemaVersion >= 1, row.name + ' version must be positive')
    }
  }
})

test('the direct fallback covers the catalog exhaustively and only the catalog', () => {
  assert.deepEqual(Object.keys(DIRECT_SPATIAL_HANDLERS).sort(), [...SPATIAL_MCP_TOOL_NAMES].sort())
})

test('the internal MCP provider registers exactly the catalog names', () => {
  const source = readFileSync(catalogPath, 'utf8')
  const registered = [...source.matchAll(/server\.registerTool\('([a-z_]+)'/g)].map(match => match[1])
  assert.equal(new Set(registered).size, registered.length, 'duplicate server.registerTool name in arcgis-mcp catalog.ts')
  assert.deepEqual([...registered].sort(), [...SPATIAL_MCP_TOOL_NAMES].sort())
})

test('the tool directory doc covers every catalog name', () => {
  const doc = readFileSync(docPath, 'utf8')
  for (const name of SPATIAL_MCP_TOOL_NAMES) {
    assert.ok(doc.includes(name), 'map/docs/arcgis-mcp.md never mentions ' + name)
  }
})
