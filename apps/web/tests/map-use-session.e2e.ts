// Web e2e scenario: the formal recorded-session layer for map observe/use.
// A real chromium drives the shipped web surface with the map-web bundle
// enabled, so the session owns a live map occurrence; the recorded model
// runs map_add_layer → map_observe → map_use(pan) → map_observe → map_use(finish)
// against the REAL ArcGIS client. Basemap tiles come from a fixed fixture PNG
// so record and replay stay hermetic; the observation id minted at runtime is
// rescripted on replay through replay.override.json `{{fromRequest:…}}`
// bindings against the request corpus.
// The retained v4 recording supplies replay; DSH_SNAPSHOT=refresh updates only
// the separate current-writer oracle and request-header sidecars.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { MapSourceService } from '@map-harness/map-container'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'
import { createMapUseRequestVerifier, deriveMapUseRequestPlan } from './map-use-session-replay.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/map-use-session', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/map-use-session/session.v4.jsonl', import.meta.url))
const OVERRIDE = fileURLToPath(new URL('../../../snapshots/web/map-use-session/replay.override.json', import.meta.url))
const OVERLAY = fileURLToPath(new URL('../../../snapshots/web/map-use-session/map-use-session.overlay.yml', import.meta.url))
const PRESET = fileURLToPath(new URL('../../../snapshots/web/map-use-session/map-use-session.preset.yml', import.meta.url))
const TILE_FIXTURE = fileURLToPath(new URL('../../../map/arcgis-mcp/tests/fixtures/layer-workbench/tile.png', import.meta.url))
const MODE = webSnapshotMode()

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'map-user-change': { kind: 'map-user-change'; form: 'notice'; summary: string }
  }
}

type MapHarnessHandle = { screenOf(longitude: number, latitude: number): { readonly x: number; readonly y: number } | null }
type ScreenBox = { left: number; top: number; right: number; bottom: number }

declare global {
  interface Window {
    __mapHarness?: Map<string, MapHarnessHandle>
  }
}

/** Hover the real fixture point and prove its attribute card stays around the feature, inside the map, and clear of floating DOM. */
async function assertFeatureHoverPlacement(page: Page): Promise<void> {
  const target = await page.evaluate(() => {
    const handle = window.__mapHarness?.values().next().value
    const screen = handle?.screenOf(116.3913, 39.9075) ?? null
    const canvas = document.querySelector('[data-map-canvas]')?.getBoundingClientRect()
    return screen === null || canvas === undefined ? null : { x: canvas.left + screen.x, y: canvas.top + screen.y }
  })
  expect(target).not.toBeNull()
  await page.mouse.move(target!.x, target!.y)
  const card = page.locator('[data-map-feature-card]')
  await card.waitFor({ state: 'visible', timeout: 15_000 })
  const metrics = await page.evaluate(({ x, y }) => {
    const map = document.querySelector('[data-map-container]')?.getBoundingClientRect()
    const cardElement = document.querySelector<HTMLElement>('[data-map-feature-card]')
    const cardRect = cardElement?.getBoundingClientRect()
    const obstacles = [...document.querySelectorAll('[data-map-panel], [data-map-panel-toggle], [data-map-workbench], [data-map-use-status], [data-map-state], [data-map-source-error], .esri-view-attribution, .esri-ui .esri-component')]
      .filter(element => element !== cardElement && !cardElement?.contains(element))
      .map(element => ({ rect: element.getBoundingClientRect(), style: getComputedStyle(element) }))
      .filter(item => item.rect.width > 0 && item.rect.height > 0 && item.style.display !== 'none' && item.style.visibility !== 'hidden')
      .map(item => ({ left: item.rect.left, top: item.rect.top, right: item.rect.right, bottom: item.rect.bottom }))
    const anchor = { left: x, top: y, right: x, bottom: y }
    const intersects = (left: ScreenBox, right: ScreenBox) =>
      left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom
    const cardBox = cardRect === undefined
      ? null
      : { left: cardRect.left, top: cardRect.top, right: cardRect.right, bottom: cardRect.bottom }
    return {
      map: map === undefined ? null : { left: map.left, top: map.top, right: map.right, bottom: map.bottom },
      card: cardBox === null || cardElement === null ? null : {
        ...cardBox,
        side: cardElement.dataset.mapFeatureSide ?? null,
        overlap: cardElement.dataset.mapFeatureOverlap ?? null,
      },
      anchor,
      anchorOverlap: cardBox === null || intersects(cardBox, anchor),
      obstacleOverlaps: obstacles.map(obstacle => cardBox === null || intersects(cardBox, obstacle)),
    }
  }, target!)
  expect(metrics.map).not.toBeNull()
  expect(metrics.card).not.toBeNull()
  expect(metrics.card!.left).toBeGreaterThanOrEqual(metrics.map!.left - 1)
  expect(metrics.card!.top).toBeGreaterThanOrEqual(metrics.map!.top - 1)
  expect(metrics.card!.right).toBeLessThanOrEqual(metrics.map!.right + 1)
  expect(metrics.card!.bottom).toBeLessThanOrEqual(metrics.map!.bottom + 1)
  expect(metrics.anchorOverlap).toBe(false)
  expect(metrics.obstacleOverlaps.some(Boolean)).toBe(false)
  expect(metrics.card!.overlap).toBe('0')
  const evidence = process.env.MAP_USE_EVIDENCE_DIR
  if (evidence !== undefined) {
    await mkdir(evidence, { recursive: true })
    await card.screenshot({ path: join(evidence, 'map-use-hover-1280.png') })
  }
  await card.getByRole('button').click()
  await card.waitFor({ state: 'hidden', timeout: 5_000 })
}

const repoRoot = (name: string) => fileURLToPath(new URL(`../../../${name}`, import.meta.url))

/** The map-web bundle plus every @map-harness package its patch layer mounts. */
const MAP_PROFILE_PACKAGES = [
  { dir: repoRoot('map/client-ui-brand') },
  { dir: repoRoot('map/lbs-keyring') },
  { dir: repoRoot('map/ui-settings-lbs') },
  { dir: repoRoot('map/map-container') },
  { dir: repoRoot('map/arcgis-mcp') },
  { dir: repoRoot('map/tools') },
  { dir: repoRoot('map/spatial-catalog') },
  { dir: repoRoot('map/spatial-context') },
  { dir: repoRoot('map/spatial-accessibility') },
  { dir: repoRoot('map/spatial-collab') },
  { dir: repoRoot('map/spatial-connect') },
  { dir: repoRoot('map/mcp-transport') },
  { dir: repoRoot('map/stream-providers') },
  { dir: repoRoot('map/profiles/map-web'), enabled: true },
]

const GEOJSON_NAME = 'sample-points.geojson'
const GEOJSON_TEXT = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [116.3913, 39.9075] }, properties: { name: 'map-use-session' } },
  ],
})

/** Minimal MapServer metadata so the preset TileLayer can build its tile cache without network access. */
const MAPSERVER_METADATA = JSON.stringify({
  currentVersion: 11.5,
  capabilities: 'Map,Query',
  singleFusedMapCache: true,
  spatialReference: { wkid: 3857 },
  fullExtent: { xmin: -20037508.342789244, ymin: -20037508.342789244, xmax: 20037508.342789244, ymax: 20037508.342789244 },
  supportedImageFormatTypes: 'PNG32,PNG',
  tileInfo: {
    rows: 256,
    cols: 256,
    dpi: 96,
    format: 'PNG',
    origin: { x: -20037508.342789244, y: 20037508.342789244 },
    spatialReference: { wkid: 3857 },
    lods: Array.from({ length: 20 }, (_value, level) => ({
      level,
      resolution: 156543.03392800014 / 2 ** level,
      scale: 591657527.591555 / 2 ** level,
    })),
  },
  layers: [],
})

/** Turn 1 binds the live map occurrence; the map surface materializes on the first real message. */
const BIND_PROMPT = `Load the workspace file ${GEOJSON_NAME} as a layer with map_add_layer (layer_id "points"), then reply exactly: layer loaded.`
/** Turn 2 exercises the observe→use→observe→finish assembly path. */
const USE_PROMPT =
  'On the session map run exactly this tool sequence, one call at a time and no other tools: '
  + 'map_observe; map_use action pan with dx_px 60 dy_px 40 citing the latest observation; '
  + 'map_observe again; map_use action finish. Then reply with the single line: map use session done.'

async function sendPrompt(page: Page, scaffold: WebScaffold, prompt: string): Promise<SessionId> {
  const input = page.locator('[data-composer-input][contenteditable="true"]').first()
  await input.waitFor({ timeout: 15_000 })
  await input.fill(prompt)
  const send = page.getByRole('button', { name: 'Send message' })
  await send.waitFor({ state: 'visible', timeout: 15_000 })
  await expect.poll(() => send.isEnabled(), { timeout: 15_000 }).toBe(true)
  const settled = scaffold.whenTurnSettled()
  await send.click()
  return settled
}

describe('web e2e: map-use-session recorded layer', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sessionId: SessionId | undefined
  let mapUseVerifier: ReturnType<typeof createMapUseRequestVerifier> | undefined

  beforeAll(async () => {
    if (MODE !== 'record') {
      const fixtureEvents = parseSessionLog(await readFile(FIXTURE, 'utf8'))
      mapUseVerifier = createMapUseRequestVerifier(deriveMapUseRequestPlan(fixtureEvents))
    }
    const verifier = mapUseVerifier
    scaffold = await launchWebScaffold({
      compareReplaySession: true,
      extraOverlayPath: [OVERLAY, PRESET],
      profile: { packages: MAP_PROFILE_PACKAGES },
      agentPresets: { default: 'map-use-session' },
      // The recorded session pins model `deepseek-flash`; the replay catalog
      // declares it image-capable (the live DeepSeek catalog lists image input
      // for this id) so map_observe's verified-image gate stays honest.
      replayProviders: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
          {
            id: 'deepseek-flash',
            name: 'DeepSeek-Flash',
            contextWindow: 1_048_576,
            inputModalities: ['text', 'image'],
            // Recorded request header: maxTokens, reasoningEffort, and the
            // in-history system-prompt update all came from the live catalog.
            defaultMaxTokens: 256_000,
            reasoningEfforts: ['off', 'low', 'high', 'max'],
            defaultReasoningEffort: 'high',
            systemPromptUpdate: 'in-history',
          },
          {
            id: 'deepseek-v4-flash-vision-exp',
            name: 'DeepSeek-V4-Flash-Vision-Exp',
            contextWindow: 1_000_000,
            inputModalities: ['text', 'image'] as const,
            defaultMaxTokens: 256_000,
            reasoningEfforts: ['off', 'low', 'high', 'max'],
            defaultReasoningEffort: 'high',
          },
        ],
      }],
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, replayOverride: OVERRIDE, paceMs: 15,
        ...(verifier === undefined ? {} : { replayVerifyResolvedEntry: (input) => { verifier.verifyResolvedEntry(input) } }) }),
    })
    await mkdir(`${scaffold.workspaceCwd}/workspace`, { recursive: true })
    await writeFile(`${scaffold.workspaceCwd}/workspace/${GEOJSON_NAME}`, GEOJSON_TEXT)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    // ArcGIS camera animations produce frame-dependent epoch counts; reduced
    // motion keeps the same camera transitions without timing-dependent frames.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1280, height: 900 })
    const tile = await readFile(TILE_FIXTURE)
    // Hermetic basemap: every imagery tile answers with the fixture PNG; other
    // ArcGIS Online traffic is refused instead of leaking to the network.
    // The host validates source identities; only the browser's render recipe and tile bytes are fixture-owned.
    await page.route('**/api/map/sources/render?*', async (route) => {
      const url = new URL(route.request().url())
      const session = url.searchParams.get('sessionId')
      if (session === null) return route.fallback()
      const sourceService = scaffold.ctx.get('mapSourceService') as MapSourceService
      const selection = sourceService.catalog.selection('esri-world-imagery', 'amap-imagery-labels')
      if (!selection.ok || selection.value.labels === null) throw new Error('fixture source selection is unavailable')
      const { basemap: base, labels } = selection.value
      const runtimeEpoch = '66666666-5555-4444-8333-222222222222'
      const nativeEpoch = '88888888-7777-4666-8555-444444444444'
      const query = new URLSearchParams({
        sessionId: session, role: 'labels', sourceId: labels.id, configDigest: labels.configDigest,
        runtimeEpoch, nativeEpoch, viewMode: 'map', viewWkid: '3857',
      })
      return route.fulfill({ json: {
        schemaVersion: 1, sessionId: session, runtimeEpoch, mode: 'map', engineWkid: 3857,
        basemap: { source: base, nativeEpoch: '77777777-6666-4555-8444-333333333333', layerKind: 'arcgis-tile', transport: 'public-preset', presetId: 'esri-world-imagery' },
        labels: { source: labels, nativeEpoch, layerKind: 'web-tile', transport: 'controlled', resourceHref: `/api/map/sources/resource?${query.toString()}` },
        earlyImagery: null, display: { labelsVisible: true, recentVisible: true, recentOpacity: 1, earlyVisible: false },
      } })
    })
    await page.route('**/api/map/sources/resource?*', (route) => {
      const url = new URL(route.request().url())
      return url.searchParams.get('sourceId') === 'amap-imagery-labels'
        ? route.fulfill({ contentType: 'image/png', body: tile })
        : route.fallback()
    })
    await page.route('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/**', route =>
      route.fulfill({ contentType: 'image/png', body: tile }))
    await page.route(/\.arcgisonline\.com\//, (route) => {
      const url = route.request().url()
      if (url.includes('/World_Imagery/MapServer') && new URL(url).searchParams.get('f') === 'json') {
        return route.fulfill({ contentType: 'application/json', body: MAPSERVER_METADATA })
      }
      if (url.includes('/World_Imagery/MapServer/tile/')) return route.fallback()
      return route.abort('blockedbyclient')
    })
    await page.route(/\.autonavi\.com\/appmaptile/, route =>
      route.fulfill({ contentType: 'image/png', body: tile, headers: { 'access-control-allow-origin': '*' } }))
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 240_000)

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      await scaffold?.close()
    }
  })

  // A retained behavior-baseline owner never re-records its canonical
  // generation (headless snapshot lane skips the same manifests in record
  // mode); the drive only runs keylessly through the committed script.
  it.skipIf(MODE === 'record')('records and replays bind + observe→use→observe→finish on the real client', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-map-use-session-drive'))
    if (MODE !== 'record') {
      // Drift guard: the committed fixture must carry exactly the two drive prompts.
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([BIND_PROMPT, USE_PROMPT])
    }
    await sendPrompt(page, scaffold, BIND_PROMPT)
    // Turn 1 materialized the right-Sidebar map tab and the live occurrence.
    const expand = page.locator('[data-sidebar-right-expand]')
    if (await page.locator('[data-sidebar-right-open]').count() === 0 && await expand.count() > 0) {
      await expand.click({ force: true, timeout: 5_000 })
    }
    await page.locator('[data-map-container]').first().waitFor({ timeout: 60_000 })
    await assertFeatureHoverPlacement(page)
    const panel = page.locator('[data-map-panel][data-map-panel-surface="unified"]').first()
    if (await panel.locator('[data-map-panel-collapse]').getAttribute('aria-expanded') === 'false') await panel.locator('[data-map-panel-collapse]').click()
    const panelSnapshots: string[] = []
    for (const tab of ['ai', 'imagery', 'annotation']) {
      await panel.locator(`[data-map-panel-tab="${tab}"]`).click()
      panelSnapshots.push(`## ${tab}\n\n${await captureStableAria(page, '[data-map-panel][data-map-panel-surface="unified"]', scaffold.workspaceCwd)}`)
    }
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'panel.expected.md'), panelSnapshots.join('\n\n'), MODE)
    await panel.locator('[data-map-panel-tab="ai"]').click()
    await page.waitForFunction(() => {
      const handle = window.__mapHarness?.values().next().value as {
        renderReceipt?: { status?: string; renderedRevision?: number; revision?: number; failedLayers?: unknown[] }
      } | undefined
      const receipt = handle?.renderReceipt
      return receipt?.status === 'rendered' && receipt.renderedRevision === receipt.revision && receipt.failedLayers?.length === 0
    }, undefined, { timeout: 30_000 })
    sessionId = await sendPrompt(page, scaffold, USE_PROMPT)
  }, 420_000)

  it.skipIf(MODE === 'record')('persists the observed images, paired actions, revisions and final map state', async () => {
    if (sessionId === undefined) throw new Error('the driven session did not settle')
    const events = await readPersistedEvents(scaffold, sessionId)
    const calls = events.filter((event): event is SessionEvent & { type: 'tool/call' } =>
      event.type === 'tool/call' && /^map_(?:observe|use)$/.test(event.data.name))
    expect(calls.map(event => event.data.name)).toEqual(['map_observe', 'map_use', 'map_observe', 'map_use'])
    const observations: { id: string; viewId: string; revision: number; cameraEpoch: number; gestureEpoch: number }[] = []
    for (const [index, call] of calls.entries()) {
      const matching = events.filter(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId)
      expect(matching).toHaveLength(1)
      const result = matching[0]
      if (result?.type !== 'tool/result') throw new Error(`missing result for ${call.data.name}`)
      expect(result.data.message.isError).toBe(false)
      const text = result.data.message.content.find(block => block.type === 'text')
      if (text?.type !== 'text') throw new Error(`missing text for ${call.data.name}`)
      const output = JSON.parse(text.text) as Record<string, unknown>
      if (call.data.name === 'map_observe') {
        const meta = result.data.meta
        if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || meta['kind'] !== 'map-observation') {
          throw new Error('map_observe did not persist an observation receipt')
        }
        const record = meta['record']
        if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error('missing observation record')
        const id = record['observationId']
        const viewId = record['viewId']
        const revision = record['mapRevision']
        expect(record['sources']).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'esri-world-imagery', kind: 'basemap', policy: 'fixed' }),
          expect.objectContaining({ id: 'amap-imagery-labels', kind: 'basemap', policy: 'unverified' }),
        ]))
        const cameraEpoch = record['cameraEpoch']
        const gestureEpoch = record['gestureEpoch']
        if (typeof id !== 'string' || typeof viewId !== 'string' || typeof revision !== 'number'
          || typeof cameraEpoch !== 'number' || typeof gestureEpoch !== 'number') throw new Error('invalid observation identity')
        expect(output['observation_id']).toBe(id)
        expect(output['view_id']).toBe(viewId)
        expect(output['revision']).toBe(observations.length + 1)
        expect(revision).toBe(observations.length + 1)
        expect(gestureEpoch).toBe(0)
        const image = result.data.message.content.find(block => block.type === 'image')
        if (image?.type !== 'image') throw new Error('map_observe did not persist an image')
        const bytes = (await scaffold.ctx.attachments.readImage(image.attachment)).data
        const digest = createHash('sha256').update(bytes).digest('hex')
        expect(image.attachment.attachmentId).toBe(`sha256:${digest}`)
        expect(image.attachment.mediaType).toBe('image/png')
        const attachment = record['attachment']
        if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) throw new Error('missing image receipt')
        expect(attachment['sha256']).toBe(digest)
        expect(attachment['attachmentId']).toBe(image.attachment.attachmentId)
        observations.push({ id, viewId, revision, cameraEpoch, gestureEpoch })
      } else {
        const observation = observations.at(-1)
        if (observation === undefined) throw new Error('map_use ran without an observation')
        const argumentsValue = JSON.parse(call.data.arguments) as Record<string, unknown>
        expect(argumentsValue['observation_id']).toBe(observation.id)
        if (index === 1) {
          expect(argumentsValue).toMatchObject({ action: 'pan', dx_px: 60, dy_px: 40 })
          expect(output).toMatchObject({ action: 'pan', observation_id: observation.id,
            source_revision: 1, candidate_revision: 2, status: 'candidate', rendered: false })
        } else {
          expect(argumentsValue['action']).toBe('finish')
          expect(output).toMatchObject({ action: 'finish', finished: true })
        }
        const meta = result.data.meta
        if (meta === null || typeof meta !== 'object' || Array.isArray(meta) || meta['kind'] !== 'map-use') {
          throw new Error('map_use did not persist an action receipt')
        }
        const record = meta['record']
        expect(record).toMatchObject({ observationId: observation.id, viewId: observation.viewId,
          targetRevision: observation.revision, action: argumentsValue['action'] })
      }
    }
    expect(observations).toHaveLength(2)
    expect(observations[1]?.viewId).toBe(observations[0]?.viewId)
    expect(observations[1]?.id).not.toBe(observations[0]?.id)
    expect(observations[1]!.cameraEpoch).toBeGreaterThan(observations[0]!.cameraEpoch)
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('the driven session has no live agent')
    const state = scaffold.ctx.map.stateOf(agent.session)
    expect(state.revision).toBe(2)
    expect(state.layers.map(layer => layer.id)).toContain('points')
    expect(state.latestObservation?.observationId).toBe(observations[1]?.id)
    expect(state.interaction).toMatchObject({ actions: 1, observations: 2, stopped: 'finished', request: null })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it.skipIf(MODE === 'record')('verifies every planned map_use observation binding', () => {
    const verifier = mapUseVerifier
    if (verifier === undefined) throw new Error('the replay verifier was not installed')
    expect(() => { verifier.assertComplete() }).not.toThrow()
  })

  it.skipIf(MODE === 'record')('replays a saved fixed release and snapshots the two-period panel', async () => {
    if (sessionId === undefined) throw new Error('the driven session did not settle')
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('the driven session has no live agent')
    const sourceService = scaffold.ctx.get('mapSourceService') as MapSourceService
    const earlySource = { ...sourceService.catalog.descriptorOf(brandString<Parameters<MapSourceService['catalog']['descriptorOf']>[0]>('esri-wayback')),
      title: 'World Imagery (Wayback 2014-02-20)',
      configDigest: '3cab1cb1d75f8ed0cf85d6260c7d8a0d9da6a9391069b62ca10609613ff8bb7d',
      release: { version: '10', publishedAt: '2014-02-20', acquiredAt: null },
    }
    const state = scaffold.ctx.map.stateOf(agent.session)
    const display = { ...state.imageryDisplay, earlySource, earlyVisible: true, recentOpacity: 0.5 }
    const summary = 'Show fixed early imagery'
    const record = { operationId: 'snapshot-wayback-blend', targetRevision: state.revision, change: { op: 'set-imagery-display', display } }
    const notice = `${summary}\n[map-user-change v7 imagery]\n${JSON.stringify(record)}`
    agent.inject(createUserMessage({ content: [{ type: 'text', text: notice }], source: { kind: 'map-user-change', form: 'notice', summary } }))
    await expect.poll(() => scaffold.ctx.map.stateOf(agent.session).imageryDisplay).toEqual(display)
    const panel = page.locator('[data-map-panel][data-map-panel-surface="unified"]').first()
    await panel.locator('[data-map-panel-tab="imagery"]').click()
    const recent = panel.locator('[data-map-imagery-row][data-imagery-kind="recent"]')
    const early = panel.locator('[data-map-imagery-row][data-imagery-kind="early"]')
    await expect.poll(() => recent.innerText()).toContain('50%')
    await expect.poll(() => early.innerText()).toContain('2014-02-20')
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'imagery-blend.expected.md'),
      await captureStableAria(page, '[data-map-panel][data-map-panel-surface="unified"]', scaffold.workspaceCwd), MODE)
  })

  it.skipIf(MODE !== 'replay')('keeps the committed scenario inventory exact', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'map-use-session.overlay.yml',
      'map-use-session.preset.yml',
      'imagery-blend.expected.md',
      'panel.expected.md',
      'replay.override.json',
      'session.v4.jsonl',
      'writer.expected.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
      'writer.expected.jsonl',
    ])
  })
})
