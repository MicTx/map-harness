/** dsh-loaded HTTP fixture: serve the deterministic authorization refusal in record and replay alike, never a tool result. */
export const name = 'map-baidu-denied-fixture'

/** Install a process-local, vendor-specific transport with a bounded request budget. */
export function apply(ctx) {
  const original = globalThis.fetch
  let requests = 0
  const transport = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.hostname !== 'api.map.baidu.com') return original(input, init)
    if (url.protocol !== 'https:' || url.pathname !== '/directionlite/v1/driving') {
      throw new Error('authorization fixture received an unexpected vendor endpoint')
    }
    if (++requests > 3) throw new Error('authorization fixture exceeded its three-request budget')
    if (url.searchParams.get('coord_type') !== 'wgs84' || url.searchParams.get('ret_coordtype') !== 'gcj02') {
      throw new Error('authorization fixture requires the documented coordinate parameters')
    }
    init?.signal?.throwIfAborted()
    // Serve the deterministic refusal in record mode too: a re-record must
    // reproduce the scenario's subject (the app's handling of this vendor
    // refusal), not capture the live vendor's variable denial prose.
    return new Response(JSON.stringify({ status: 240, message: 'APP 服务被禁用' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  ctx.effect(() => {
    globalThis.fetch = transport
    return () => {
      if (globalThis.fetch !== transport) throw new Error('authorization fixture lost transport ownership')
      globalThis.fetch = original
    }
  })
}
