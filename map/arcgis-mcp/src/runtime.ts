import { randomUUID } from 'node:crypto'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  SPATIAL_MCP_TOOL_NAMES,
  type ArcgisMcpService,
  type ArcgisMcpToolDescriptor,
  type SpatialToolName,
} from '@map-harness/map-tools'
import { Client, type CallToolResult, type Tool } from '@modelcontextprotocol/client'
import { InMemoryTransport, McpServer, type ServerContext } from '@modelcontextprotocol/server'
import { registerArcgisMapTools } from './catalog.ts'

/** Private MCP request metadata key carrying an unguessable execution binding. */
export const EXECUTION_TOKEN_META_KEY = 'map-harness/execution-token'

/** Connected provider runtime and its quiescent cleanup operation. */
export interface ArcgisMcpRuntime {
  readonly service: ArcgisMcpService
  /** Abort in-flight requests, close both protocol peers, and release bindings. */
  dispose(): Promise<void>
}

/** Throw the caller's cancellation reason while preserving a standard fallback. */
function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  signal.throwIfAborted()
  throw new DOMException('ArcGIS MCP call canceled', 'AbortError')
}

/** Freeze the tools/list generation consumed by agent-scoped adapters. */
function freezeCatalog(tools: Tool[]): readonly ArcgisMcpToolDescriptor[] {
  const expected = new Set<string>(SPATIAL_MCP_TOOL_NAMES)
  const seen = new Set<string>()
  const catalog = tools.map((tool): ArcgisMcpToolDescriptor => {
    if (!expected.has(tool.name)) throw new Error(`ArcGIS MCP server listed unsupported tool "${tool.name}"`)
    if (seen.has(tool.name)) throw new Error(`ArcGIS MCP server listed duplicate tool "${tool.name}"`)
    seen.add(tool.name)
    return Object.freeze({
      name: tool.name as SpatialToolName,
      description: tool.description ?? '',
      inputSchema: Object.freeze({ ...tool.inputSchema }),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
      ...(tool.execution?.taskSupport === 'required' ? { taskRequired: true } : {}),
    })
  })
  if (seen.size !== expected.size) {
    const missing = [...expected].filter(name => !seen.has(name))
    throw new Error(`ArcGIS MCP server omitted required tools: ${missing.join(', ')}`)
  }
  return Object.freeze(catalog)
}

/** Read one trusted execution token from MCP request metadata. */
function executionToken(context: ServerContext): string {
  const token = context.mcpReq._meta?.[EXECUTION_TOKEN_META_KEY]
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('ArcGIS MCP request lacks a trusted execution binding')
  }
  return token
}

/**
 * Create and initialize the internal MCP client/server pair.
 * @returns a ready service whose catalog came from tools/list and whose calls use tools/call.
 */
export async function createArcgisMcpRuntime(): Promise<ArcgisMcpRuntime> {
  const bindings = new Map<string, ToolExecution>()
  const inFlight = new Set<Promise<CallToolResult>>()
  const lifecycle = new AbortController()
  let disposed = false
  let disposal: Promise<void> | undefined

  const server = new McpServer(
    { name: 'map-harness-arcgis', version: '0.1.0' },
    { capabilities: {} },
  )
  registerArcgisMapTools(server, (context) => {
    const execution = bindings.get(executionToken(context))
    if (execution === undefined) throw new Error('ArcGIS MCP execution binding is absent or expired')
    return execution
  })

  const client = new Client({ name: 'map-harness', version: '0.1.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  try {
    await client.connect(clientTransport)
  } catch (error: unknown) {
    await server.close()
    throw error
  }

  let listed: Awaited<ReturnType<Client['listTools']>>
  try {
    listed = await client.listTools()
  } catch (error: unknown) {
    await client.close()
    await server.close()
    throw error
  }
  const catalog = freezeCatalog(listed.tools)
  const toolByName = new Map(listed.tools.map(tool => [tool.name, tool] as const))

  const service: ArcgisMcpService = {
    catalog: () => catalog,
    async callTool(name, args, execution): Promise<CallToolResult> {
      if (disposed) throw new Error('ArcGIS MCP provider is disposed')
      if (execution.agent?.session.id === undefined) {
        throw new Error('ArcGIS MCP tools require an agent session caller')
      }
      throwIfAborted(execution.signal)
      const tool = toolByName.get(name)
      if (tool === undefined) throw new Error(`unknown ArcGIS MCP tool "${name}"`)

      let token = randomUUID()
      while (bindings.has(token)) token = randomUUID()
      bindings.set(token, execution)
      const signal = AbortSignal.any([execution.signal, lifecycle.signal])
      let operation: Promise<CallToolResult> | undefined
      try {
        operation = client.callTool({
          name,
          arguments: args,
          _meta: { [EXECUTION_TOKEN_META_KEY]: token },
        }, { signal, toolDefinition: tool })
        inFlight.add(operation)
        return await operation
      } finally {
        if (operation !== undefined) inFlight.delete(operation)
        bindings.delete(token)
      }
    },
  }

  async function disposeRuntime(): Promise<void> {
    disposed = true
    lifecycle.abort(new DOMException('ArcGIS MCP provider disposed', 'AbortError'))
    await Promise.allSettled([...inFlight])
    bindings.clear()
    const errors: unknown[] = []
    try {
      await client.close()
    } catch (error: unknown) {
      errors.push(error)
    }
    try {
      await server.close()
    } catch (error: unknown) {
      errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'ArcGIS MCP transport disposal failed')
  }

  return {
    service,
    dispose: () => disposal ??= disposeRuntime(),
  }
}
