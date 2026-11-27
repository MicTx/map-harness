import test from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { WaybackOfficialTransport } from '../src/wayback-transport.ts'

const workerUrl = new URL('../lib/wayback-worker.js', import.meta.url)
const delay = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function config() {
  return {
    10: {
      itemID: '903f0abe9c3b452dafe1ca5b8dd858b9',
      itemTitle: 'World Imagery (Wayback 2014-02-20)',
      itemURL: 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/10/{level}/{row}/{col}',
      metadataLayerUrl: 'https://metadata.maptiles.arcgis.com/arcgis/rest/services/World_Imagery_Metadata_2014_r01/MapServer',
      metadataLayerItemID: '78e801fab4d24ab9a6053c7a461479be',
      layerIdentifier: 'WB_2014_R01',
    },
  }
}

function start(t, handler) {
  const worker = new Worker(workerUrl)
  const results = new Map()
  worker.on('message', message => {
    if (message.kind === 'fetch') {
      void handler(message).then(body => {
        if (body instanceof Error) worker.postMessage({ kind: 'response', id: message.id, error: body.message })
        else worker.postMessage({ kind: 'response', id: message.id, status: 200, body: Buffer.from(body).toString('base64') })
      })
    } else if (message.kind === 'result') {
      results.get(message.id)?.resolve(message)
    }
  })
  t.after(async () => { await worker.terminate() })
  return {
    call(id, operation, payload = {}) {
      const result = delay()
      results.set(id, result)
      worker.postMessage({ kind: 'call', id, operation, ...payload })
      return result.promise
    },
  }
}

test('concurrent official metadata reads retain their own fetch owner', async t => {
  const seen = []
  const worker = start(t, async message => {
    seen.push(message)
    if (message.url.includes('waybackconfig.json')) return JSON.stringify(config())
    return JSON.stringify({ features: [{ attributes: { SRC_DATE2: 1_600_000_000_000, NICE_DESC: 'Example', SAMP_RES: 0.5 } }] })
  })
  await worker.call(1, 'list')
  const point = { longitude: 116, latitude: 39 }
  const results = await Promise.all([
    worker.call(2, 'metadata', { point, zoom: 12, releaseNumber: 10 }),
    worker.call(3, 'metadata', { point, zoom: 12, releaseNumber: 10 }),
  ])
  assert.equal(results.every(result => result.error === undefined), true)
  const metadataRequests = seen.filter(message => message.url.includes('/query?'))
  assert.deepEqual(metadataRequests.map(message => message.owner).sort(), [2, 3])
})

test('local comparisons do not report differing releases when tile reads fail', async t => {
  const worker = start(t, async message => {
    if (message.url.includes('waybackconfig.json')) return JSON.stringify(config())
    if (message.url.includes('/tilemap/')) return JSON.stringify({ data: [1], select: [10], size: [12] })
    return new Error('tile read failed')
  })
  const result = await worker.call(1, 'local', {
    point: { longitude: 116, latitude: 39 },
    zoom: 12,
  })
  assert.equal(typeof result.error, 'string')
})

test('production transport passes official metadata through its admitted network', async () => {
  const paths = []
  let closed = false
  const network = {
    async request(input) {
      paths.push(input.url.pathname)
      const data = input.url.pathname.endsWith('/waybackconfig.json')
        ? JSON.stringify(config())
        : JSON.stringify({ features: [{ attributes: { SRC_DATE2: 1_600_000_000_000, NICE_DESC: 'Example', SAMP_RES: 0.5 } }] })
      return { status: 200, body: Buffer.from(data), contentType: 'application/json', cache: {} }
    },
    dispose() { closed = true },
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    assert.equal((await transport.getWaybackItems()).length, 1)
    const result = await transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, new AbortController().signal)
    assert.equal(result.date, 1_600_000_000_000)
    assert.equal(result.provider, 'Example')
    assert.equal(paths.some(path => path.endsWith('/11/query')), true)
  } finally {
    await transport.dispose()
  }
  assert.equal(closed, true)
})

test('Wayback source launch works under the supported tsx ESM hook', async () => {
  const { spawnSync } = await import('node:child_process')
  const script = `import { WaybackOfficialTransport } from './map/map-container/src/wayback-transport.ts'
    const network = { request: async () => ({ status: 200, body: Buffer.from(${JSON.stringify(JSON.stringify(config()))}), contentType: 'application/json', cache: {} }), dispose() {} }
    const transport = new WaybackOfficialTransport(undefined, { network })
    try { console.log((await transport.getWaybackItems()).length) } finally { await transport.dispose() }`
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', script], {
    cwd: new URL('../../..', import.meta.url), encoding: 'utf8', timeout: 15_000,
  })
  assert.equal(result.signal, null, result.stderr)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), '1')
})

test('production transport rejects a failed official comparison tile even when the library catches it', async () => {
  const requests = []
  const network = {
    async request(input) {
      requests.push(input.url.pathname)
      if (input.payload === 'image') throw new Error('tile transport failed')
      const data = input.url.pathname.endsWith('/waybackconfig.json')
        ? JSON.stringify(config())
        : JSON.stringify({ data: [1], select: [10], size: [12] })
      return { status: 200, body: Buffer.from(data), contentType: 'application/json', cache: {} }
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    await assert.rejects(
      transport.getWaybackItemsWithLocalChanges({ longitude: 116, latitude: 39 }, 12, new AbortController().signal),
      { code: 'SOURCE_UNAVAILABLE' },
    )
    assert.equal(requests.some(path => path.includes('/tile/')), true)
  } finally {
    await transport.dispose()
  }
})

test('production transport rejects a catalog entry the official reader would silently drop', async () => {
  const records = config()
  records[20] = {
    ...records[10], itemID: '2'.repeat(32), metadataLayerItemID: '2'.repeat(32),
    itemTitle: 'World Imagery (Wayback 2015-01-01)', layerIdentifier: 'WB_2015_R01',
    itemURL: records[10].itemURL.replace('/tile/10/', '/tile/20/'),
    metadataLayerUrl: records[10].metadataLayerUrl.replace('2014', '2015'),
  }
  let body = JSON.stringify(records)
  const network = {
    async request() {
      return { status: 200, body: Buffer.from(body), contentType: 'application/json', cache: {} }
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    assert.equal((await transport.getWaybackItems()).length, 2)
    // The official reader filters an entry without metadataLayerUrl, which
    // would silently replace the verified catalog with a shorter list.
    const { metadataLayerUrl, ...damaged } = records[20]
    body = JSON.stringify({ ...records, 20: damaged })
    await assert.rejects(transport.getWaybackItems(), { code: 'SOURCE_UNAVAILABLE' })
  } finally {
    await transport.dispose()
  }
})

test('production transport binds metadata reads to the verified catalog identity', async () => {
  const network = {
    async request(input) {
      const data = input.url.pathname.endsWith('/waybackconfig.json')
        ? JSON.stringify(config())
        : JSON.stringify({ features: [{ attributes: { SRC_DATE2: 1_600_000_000_000, NICE_DESC: 'Example', SAMP_RES: 0.5 } }] })
      return { status: 200, body: Buffer.from(data), contentType: 'application/json', cache: {} }
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  const item = config()[10]
  const signal = new AbortController().signal
  try {
    const identity = { itemId: item.itemID, metadataLayerUrl: item.metadataLayerUrl }
    assert.equal((await transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, signal, identity)).date, 1_600_000_000_000)
    // The metadata layer is resolved from the reader's live config, so a
    // changed item must fail by name instead of querying a different layer.
    await assert.rejects(
      transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, signal,
        { ...identity, metadataLayerUrl: identity.metadataLayerUrl.replace('2014', '2015') }),
      { code: 'SOURCE_CHANGED' },
    )
    await assert.rejects(
      transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, signal,
        { ...identity, itemId: 'f'.repeat(32) }),
      { code: 'SOURCE_CHANGED' },
    )
  } finally {
    await transport.dispose()
  }
})

test('production transport rejects a malformed metadata body instead of reporting an unknown sample', async () => {
  let body = '{}'
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) {
        return { status: 200, body: Buffer.from(JSON.stringify(config())), contentType: 'application/json', cache: {} }
      }
      return { status: 200, body: Buffer.from(body), contentType: 'application/json', cache: {} }
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    await assert.rejects(
      transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, new AbortController().signal),
      { code: 'SOURCE_UNAVAILABLE' },
    )
    // A non-object feature would also collapse to null inside the official
    // reader, so it must fail before that normalization.
    body = '{"features":[null]}'
    await assert.rejects(
      transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, new AbortController().signal),
      { code: 'SOURCE_UNAVAILABLE' },
    )
    // Arrays are objects to `typeof` but carry no feature attributes; they must
    // not be collapsed into an "unknown acquisition date" sample.
    body = '{"features":[[]]}'
    await assert.rejects(
      transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, new AbortController().signal),
      { code: 'SOURCE_UNAVAILABLE' },
    )
    body = '{"features":[{"attributes":[]}]}'
    await assert.rejects(
      transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, new AbortController().signal),
      { code: 'SOURCE_UNAVAILABLE' },
    )
    // An honest empty feature set still maps to "no metadata", not a failure.
    body = '{"features": []}'
    assert.equal(await transport.getMetadata({ longitude: 116, latitude: 39 }, 12, 10, new AbortController().signal), null)
  } finally {
    await transport.dispose()
  }
})

test('production transport reports a catalog snapshot change for a missing local release', async () => {
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) {
        return { status: 200, body: Buffer.from(JSON.stringify(config())), contentType: 'application/json', cache: {} }
      }
      if (input.url.pathname.includes('/tilemap/')) {
        return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [20], size: [12] })), contentType: 'application/json', cache: {} }
      }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    await assert.rejects(
      transport.getWaybackItemsWithLocalChanges({ longitude: 116, latitude: 39 }, 12, new AbortController().signal),
      { code: 'SOURCE_CHANGED' },
    )
  } finally {
    await transport.dispose()
  }
})

test('local comparison keeps one frame per distinct tile image when the newest repeats the oldest', async () => {
  const records = config()
  for (const [id, date, layer] of [[20, '2015-01-01', 'WB_2015_R01'], [30, '2016-01-01', 'WB_2016_R01']]) {
    records[id] = {
      ...records[10], itemID: String(id).padStart(32, '0'), itemTitle: `World Imagery (Wayback ${date})`,
      itemURL: records[10].itemURL.replace('/tile/10/', `/tile/${id}/`), layerIdentifier: layer,
    }
  }
  const frame = background => sharp({ create: { width: 256, height: 256, channels: 3, background } }).jpeg().toBuffer()
  const pixels = { 10: await frame('#101010'), 20: await frame('#202020') }
  pixels[30] = pixels[10]
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) return { status: 200, body: Buffer.from(JSON.stringify(records)), contentType: 'application/json', cache: {} }
      const tilemap = /\/tilemap\/(\d+)\//.exec(input.url.pathname)
      if (tilemap) return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [Number(tilemap[1])], size: [12] })), contentType: 'application/json', cache: {} }
      const tile = /\/tile\/(\d+)\//.exec(input.url.pathname)
      if (tile) return { status: 200, body: Buffer.from(pixels[tile[1]]), contentType: 'image/jpeg', cache: {} }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    const result = await transport.getWaybackItemsWithLocalChanges({ longitude: 0, latitude: 0 }, 12, new AbortController().signal)
    // A, B, A: the newest release repeats the oldest imagery, so there is no
    // second distinct frame to compare and the middle release stays "recent".
    assert.deepEqual(result.map(item => item.releaseNum), [10, 20])
  } finally {
    await transport.dispose()
  }
})

test('the maximum supported catalog leaves room for every local tile request', async () => {
  const records = {}
  for (let id = 1; id <= 256; id += 1) {
    const date = new Date(Date.UTC(2010, 0, id)).toISOString().slice(0, 10)
    records[id] = {
      ...config()[10], itemID: String(id).padStart(32, '0'), itemTitle: `World Imagery (Wayback ${date})`,
      itemURL: config()[10].itemURL.replace('/tile/10/', `/tile/${id}/`), layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
    }
  }
  const pixel = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#456789' } }).png().toBuffer()
  let tileReads = 0
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) return { status: 200, body: Buffer.from(JSON.stringify(records)), contentType: 'application/json', cache: {} }
      const tilemap = /\/tilemap\/(\d+)\//.exec(input.url.pathname)
      if (tilemap) return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [Number(tilemap[1])], size: [pixel.length] })), contentType: 'application/json', cache: {} }
      if (input.url.pathname.includes('/tile/')) { tileReads += 1; return { status: 200, body: pixel, contentType: 'image/png', cache: {} } }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network, operationTimeoutMs: 120_000 }, workerUrl)
  try {
    const result = await transport.getWaybackItemsWithLocalChanges({ longitude: 0, latitude: 0 }, 12, new AbortController().signal)
    assert.equal(tileReads, 256)
    assert.equal(result.length, 1)
  } finally {
    await transport.dispose()
  }
})

test('local comparison retains the latest release when a non-early frame repeats', async () => {
  const records = config()
  for (const [id, date] of [[20, '2015-01-01'], [30, '2016-01-01'], [40, '2017-01-01']]) {
    records[id] = {
      ...records[10], itemID: String(id).padStart(32, '0'), itemTitle: `World Imagery (Wayback ${date})`,
      itemURL: records[10].itemURL.replace('/tile/10/', `/tile/${id}/`), layerIdentifier: `WB_${date.slice(0, 4)}_R01`,
    }
  }
  const frame = background => sharp({ create: { width: 256, height: 256, channels: 3, background } }).png().toBuffer()
  const pixels = { 10: await frame('#101010'), 20: await frame('#202020'), 30: await frame('#303030') }
  pixels[40] = pixels[20]
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) return { status: 200, body: Buffer.from(JSON.stringify(records)), contentType: 'application/json', cache: {} }
      const tilemap = /\/tilemap\/(\d+)\//.exec(input.url.pathname)
      if (tilemap) return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [Number(tilemap[1])], size: [12] })), contentType: 'application/json', cache: {} }
      const tile = /\/tile\/(\d+)\//.exec(input.url.pathname)
      if (tile) return { status: 200, body: pixels[tile[1]], contentType: 'image/png', cache: {} }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    const result = await transport.getWaybackItemsWithLocalChanges({ longitude: 0, latitude: 0 }, 12, new AbortController().signal)
    assert.equal(result.at(0).releaseNum, 10)
    assert.equal(result.at(-1).releaseNum, 40)
  } finally {
    await transport.dispose()
  }
})

test('local comparison does not treat differently encoded identical pixels as different imagery', async () => {
  const records = config()
  records[20] = {
    ...records[10], itemID: '20'.padStart(32, '0'), itemTitle: 'World Imagery (Wayback 2015-01-01)',
    itemURL: records[10].itemURL.replace('/tile/10/', '/tile/20/'), layerIdentifier: 'WB_2015_R01',
  }
  const frame = { create: { width: 256, height: 256, channels: 3, background: '#4286a6' } }
  const first = await sharp(frame).png({ compressionLevel: 1 }).toBuffer()
  const second = await sharp(frame).png({ compressionLevel: 9 }).toBuffer()
  assert.equal(first.equals(second), false)
  assert.equal((await sharp(first).raw().toBuffer()).equals(await sharp(second).raw().toBuffer()), true)
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) return { status: 200, body: Buffer.from(JSON.stringify(records)), contentType: 'application/json', cache: {} }
      const tilemap = /\/tilemap\/(\d+)\//.exec(input.url.pathname)
      if (tilemap) return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [Number(tilemap[1])], size: [12] })), contentType: 'application/json', cache: {} }
      const tile = /\/tile\/(\d+)\//.exec(input.url.pathname)
      if (tile) return { status: 200, body: Number(tile[1]) === 10 ? first : second, contentType: 'image/png', cache: {} }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    const result = await transport.getWaybackItemsWithLocalChanges({ longitude: 0, latitude: 0 }, 12, new AbortController().signal)
    assert.deepEqual(result.map(item => item.releaseNum), [10])
  } finally {
    await transport.dispose()
  }
})

test('local comparison ignores RGB values hidden by full transparency', async () => {
  const records = config()
  records[20] = {
    ...records[10], itemID: '20'.padStart(32, '0'), itemTitle: 'World Imagery (Wayback 2015-01-01)',
    itemURL: records[10].itemURL.replace('/tile/10/', '/tile/20/'), layerIdentifier: 'WB_2015_R01',
  }
  const frame = background => sharp({ create: { width: 256, height: 256, channels: 4, background } }).png().toBuffer()
  const first = await frame({ r: 255, g: 0, b: 0, alpha: 0 })
  const second = await frame({ r: 0, g: 255, b: 0, alpha: 0 })
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) return { status: 200, body: Buffer.from(JSON.stringify(records)), contentType: 'application/json', cache: {} }
      const tilemap = /\/tilemap\/(\d+)\//.exec(input.url.pathname)
      if (tilemap) return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [Number(tilemap[1])], size: [12] })), contentType: 'application/json', cache: {} }
      const tile = /\/tile\/(\d+)\//.exec(input.url.pathname)
      if (tile) return { status: 200, body: Number(tile[1]) === 10 ? first : second, contentType: 'image/png', cache: {} }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    const result = await transport.getWaybackItemsWithLocalChanges({ longitude: 0, latitude: 0 }, 12, new AbortController().signal)
    assert.deepEqual(result.map(item => item.releaseNum), [10])
  } finally {
    await transport.dispose()
  }
})

test('official detector failures never log upstream error contents', async () => {
  const { spawnSync } = await import('node:child_process')
  const source = `import { Worker } from 'node:worker_threads';
    const worker = new Worker(new URL(${JSON.stringify(workerUrl.href)}), { execArgv: [] });
    worker.on('message', message => {
      if (message.kind === 'fetch') {
        const config = ${JSON.stringify(JSON.stringify(config()))};
        const response = message.url.includes('waybackconfig.json')
          ? { status: 200, body: Buffer.from(config).toString('base64') }
          : { error: 'sensitive-upstream-marker' };
        worker.postMessage({ kind: 'response', id: message.id, ...response });
      } else if (message.kind === 'result') {
        console.log(JSON.stringify(message));
        void worker.terminate();
      }
    });
    worker.postMessage({ kind: 'call', id: 1, operation: 'local', point: { longitude: 116, latitude: 39 }, zoom: 12 });`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).error, 'official Wayback operation failed')
  assert.doesNotMatch(result.stderr, /sensitive-upstream-marker/u)
})

test('production transport rejects malformed tilemap evidence instead of reporting no changes', async () => {
  let tilemap = '{"data":[]}'
  const pixel = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#334455' } }).png().toBuffer()
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) {
        return { status: 200, body: Buffer.from(JSON.stringify(config())), contentType: 'application/json', cache: {} }
      }
      if (input.url.pathname.includes('/tilemap/')) {
        return { status: 200, body: Buffer.from(tilemap), contentType: 'application/json', cache: {} }
      }
      if (input.url.pathname.includes('/tile/')) return { status: 200, body: pixel, contentType: 'image/png', cache: {} }
      throw new Error('unexpected request')
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  const read = () => transport.getWaybackItemsWithLocalChanges({ longitude: 116, latitude: 39 }, 12, new AbortController().signal)
  try {
    for (tilemap of ['{"data":[]}', '{"data":[2]}', 'not-json', '"sensitive-upstream-marker"', '{"data":[1]}']) {
      await assert.rejects(read(), { code: 'SOURCE_UNAVAILABLE' })
    }
    // Real official shapes: data=1 may omit select (10842), and data=0 may
    // carry a positive size; both stay acceptable to the official reader.
    tilemap = '{"data":[1],"size":[12]}'
    assert.deepEqual((await read()).map(item => item.releaseNum), [10])
    tilemap = '{"data":[0]}'
    assert.deepEqual(await read(), [])
    tilemap = '{"data":[0],"size":[0]}'
    assert.deepEqual(await read(), [])
  } finally {
    await transport.dispose()
  }
})

test('production transport rejects a non-image comparison tile before dedupe', async () => {
  const network = {
    async request(input) {
      if (input.url.pathname.endsWith('/waybackconfig.json')) {
        return { status: 200, body: Buffer.from(JSON.stringify(config())), contentType: 'application/json', cache: {} }
      }
      if (input.url.pathname.includes('/tilemap/')) {
        return { status: 200, body: Buffer.from(JSON.stringify({ data: [1], select: [10], size: [12] })), contentType: 'application/json', cache: {} }
      }
      return { status: 200, body: Buffer.from('not-an-image'), contentType: 'image/jpeg', cache: {} }
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    await assert.rejects(
      transport.getWaybackItemsWithLocalChanges({ longitude: 116, latitude: 39 }, 12, new AbortController().signal),
      { code: 'SOURCE_UNAVAILABLE' },
    )
  } finally {
    await transport.dispose()
  }
})

test('production transport aborts held requests and awaits worker termination', async () => {
  const started = delay()
  const closed = delay()
  const network = {
    request(input) {
      started.resolve()
      return new Promise((resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          closed.resolve()
          reject(new Error('cancelled'))
        }, { once: true })
      })
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  const abort = new AbortController()
  const operation = transport.getWaybackItems(abort.signal)
  await started.promise
  abort.abort()
  await assert.rejects(operation, { code: 'SOURCE_CANCELLED' })
  await closed.promise
  await transport.dispose()
})

test('disposing transport waits for aborted network operations to settle', async () => {
  const started = delay()
  const cancelled = delay()
  const release = delay()
  const network = {
    request(input) {
      started.resolve()
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          cancelled.resolve()
          void release.promise.then(() => reject(new Error('cancelled')))
        }, { once: true })
      })
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  const operation = transport.getWaybackItems()
  await started.promise
  let disposed = false
  const disposal = transport.dispose().then(() => { disposed = true })
  await cancelled.promise
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  release.resolve()
  await disposal
  await assert.rejects(operation, { code: 'SOURCE_UNAVAILABLE' })
  assert.equal(disposed, true)
})

test('production transport reloads the official release catalog after a later call', async () => {
  let reads = 0
  const network = {
    async request() {
      reads += 1
      const next = config()
      if (reads > 1) {
        next[20] = {
          ...next[10], itemID: '2'.repeat(32), itemTitle: 'World Imagery (Wayback 2015-01-01)',
          itemURL: next[10].itemURL.replace('/tile/10/', '/tile/20/'), layerIdentifier: 'WB_2015_R01',
        }
      }
      return { status: 200, body: Buffer.from(JSON.stringify(next)), contentType: 'application/json', cache: {} }
    },
    dispose() {},
  }
  const transport = new WaybackOfficialTransport(undefined, { network }, workerUrl)
  try {
    assert.equal((await transport.getWaybackItems()).length, 1)
    assert.equal((await transport.getWaybackItems()).length, 2)
    assert.equal(reads, 2)
  } finally {
    await transport.dispose()
  }
})

test('production transport timeout aborts the owned network request', async () => {
  const started = delay()
  const stopped = delay()
  const network = {
    request(input) {
      started.resolve()
      return new Promise((_resolve, reject) => {
        input.signal.addEventListener('abort', () => {
          stopped.resolve()
          reject(new Error('cancelled'))
        }, { once: true })
      })
    },
    dispose() {},
  }
  const limits = { requestTimeoutMs: 200, maxResponseBytes: 8_388_608, maxConcurrentRequests: 4, maxQueuedRequests: 4, maxMetadataBytes: 1_048_576, cacheMaxBytes: 0, cacheMaxEntries: 0 }
  const transport = new WaybackOfficialTransport(limits, { network }, workerUrl)
  try {
    const operation = transport.getWaybackItems()
    // The worker must finish loading (including the image decoder) before the
    // shorter operation budget can elapse, so a hang here is a loud failure.
    const guard = setTimeout(() => { started.resolve() }, 5_000)
    await started.promise
    clearTimeout(guard)
    await assert.rejects(operation, { code: 'SOURCE_TIMEOUT' })
    await stopped.promise
  } finally {
    await transport.dispose()
  }
})
