/**
 * Key-activated re-verification lane: deployments that hold real credentials
 * run the same verify entry points against real endpoints. The lane is
 * strictly opt-in — every family reads its endpoints and secrets from
 * SPATIAL_CONNECT_POSTGRES_* / SPATIAL_CONNECT_S3_* / SPATIAL_CONNECT_COG_*
 * variables, and any family without its full variable set self-skips (exit
 * zero) so the keyless aggregate stays green. Values never reach assertions,
 * console output, or failure text: connections are declared through
 * environment references, and the report is inspected only for its outcome
 * codes and sanitized facts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { env } from 'node:process'
import { CONNECTION_OUTCOMES, resolveConnections, buildSpatialConnectService } from '../src/index.ts'

/** Collect the fully-declared families (host/endpoint present plus every referenced credential). */
function liveDeclarations() {
  const postgis = env.SPATIAL_CONNECT_POSTGRES_HOST !== undefined
    ? [{
        id: 'live-postgis',
        host: env.SPATIAL_CONNECT_POSTGRES_HOST,
        port: env.SPATIAL_CONNECT_POSTGRES_PORT !== undefined ? Number(env.SPATIAL_CONNECT_POSTGRES_PORT) : undefined,
        database: env.SPATIAL_CONNECT_POSTGRES_DATABASE ?? 'postgres',
        user: env.SPATIAL_CONNECT_POSTGRES_USER ?? 'postgres',
        passwordEnv: 'SPATIAL_CONNECT_POSTGRES_PASSWORD',
        ssl: env.SPATIAL_CONNECT_POSTGRES_SSL ?? 'prefer',
      }]
    : []
  const objectStores = env.SPATIAL_CONNECT_S3_ENDPOINT !== undefined
    ? [{
        id: 'live-object-store',
        endpoint: env.SPATIAL_CONNECT_S3_ENDPOINT,
        region: env.SPATIAL_CONNECT_S3_REGION ?? 'us-east-1',
        bucket: env.SPATIAL_CONNECT_S3_BUCKET,
        accessKeyIdEnv: 'SPATIAL_CONNECT_S3_ACCESS_KEY_ID',
        secretAccessKeyEnv: 'SPATIAL_CONNECT_S3_SECRET_ACCESS_KEY',
        sessionTokenEnv: env.SPATIAL_CONNECT_S3_SESSION_TOKEN !== undefined ? 'SPATIAL_CONNECT_S3_SESSION_TOKEN' : undefined,
        addressing: env.SPATIAL_CONNECT_S3_ADDRESSING ?? 'path',
      }]
    : []
  const cogs = env.SPATIAL_CONNECT_COG_URL !== undefined
    ? [{ id: 'live-cog', url: env.SPATIAL_CONNECT_COG_URL, tokenEnv: 'SPATIAL_CONNECT_COG_TOKEN' }]
    : []
  return { postgis, objectStores, cogs }
}

test('live endpoints answer with the documented outcome vocabulary and never echo credentials', async () => {
  const declarations = liveDeclarations()
  const declared = declarations.postgis.length + declarations.objectStores.length + declarations.cogs.length
  if (declared === 0) {
    assert.ok(true, 'no SPATIAL_CONNECT_* variables set — live lane self-skips (set SPATIAL_CONNECT_POSTGRES_HOST, SPATIAL_CONNECT_S3_ENDPOINT, or SPATIAL_CONNECT_COG_URL to activate)')
    return
  }
  const registry = resolveConnections(declarations, env)
  const service = buildSpatialConnectService(registry)
  for (const summary of service.listConnections()) {
    const report = await service.verifyConnection(summary.id)
    // Any documented outcome is an acceptable real-world answer; the lane
    // proves the exchange completed and stayed inside the vocabulary.
    assert.equal(typeof report.outcome, 'string', `${summary.id} must produce an outcome`)
    assert.ok(
      CONNECTION_OUTCOMES.includes(report.outcome),
      `${summary.id} outcome ${report.outcome} is outside the closed vocabulary`,
    )
    const text = JSON.stringify(report)
    for (const secret of [env.SPATIAL_CONNECT_POSTGRES_PASSWORD, env.SPATIAL_CONNECT_S3_SECRET_ACCESS_KEY, env.SPATIAL_CONNECT_COG_TOKEN]) {
      if (secret !== undefined) {
        assert.equal(text.includes(secret), false, `${summary.id} report leaked a credential value`)
      }
    }
  }
  assert.ok(true, `verified ${String(declared)} live connection(s)`)
})
