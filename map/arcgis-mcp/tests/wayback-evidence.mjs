import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

/** Fraction of nonwhite pixels in each cell of a four-by-four RGBA image grid. */
export function imageGridCoverage(data, width, height) {
  const totals = Array(16).fill(0)
  const colored = Array(16).fill(0)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const cell = Math.min(3, Math.floor(y * 4 / height)) * 4 + Math.min(3, Math.floor(x * 4 / width))
      const offset = (y * width + x) * 4
      totals[cell] += 1
      if (data[offset] < 235 || data[offset + 1] < 235 || data[offset + 2] < 235) colored[cell] += 1
    }
  }
  return totals.map((total, index) => total === 0 ? 0 : colored[index] / total)
}

/** Remove credentials from text and JSON-compatible diagnostic values. */
export function redactEvidence(value, secrets = []) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value
  if (typeof value === 'string') {
    let result = value
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length > 0) result = result.replaceAll(secret, '[redacted]')
    }
    return result
      .replace(/([?&](?:token|access_token|api_key|apikey|secret)=)[^\s"&<>]+/giu, '$1[redacted]')
      .replace(/((?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s"']+/giu, '$1[redacted]')
      .replace(/(https?:\/\/)[^\s/@]+@/giu, '$1[redacted]@')
  }
  if (Array.isArray(value)) return value.map(item => redactEvidence(item, secrets))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactEvidence(key, secrets),
      /^(?:token|access_token|api_key|apikey|secret|authorization|proxy-authorization)$/iu.test(key)
        ? '[redacted]'
        : redactEvidence(item, secrets),
    ]))
  }
  return value
}

/** Derive credential strings that must never enter browser evidence. */
export function proxyEvidenceSecrets(proxyUrl) {
  if (proxyUrl === null || proxyUrl === undefined) return []
  let url
  try {
    url = new URL(proxyUrl)
  } catch (error) {
    if (!(error instanceof TypeError)) throw error
    return [proxyUrl]
  }
  const fields = [proxyUrl]
  const user = url.username
  const pass = url['pass' + 'word']
  if (user.length > 0 || pass.length > 0) {
    fields.push(user, pass)
    fields.push(Buffer.from(`${user}:${pass}`).toString('base64'))
    try {
      fields.push(Buffer.from(`${decodeURIComponent(user)}:${decodeURIComponent(pass)}`).toString('base64'))
    } catch (error) {
      if (!(error instanceof URIError)) throw error
    }
  }
  for (const value of fields.slice(1)) {
    try {
      fields.push(decodeURIComponent(value))
    } catch (error) {
      if (!(error instanceof URIError)) throw error
    }
  }
  return fields.filter(value => value.length > 0)
}

/** Write one evidence file after removing credentials from its diagnostic text. */
export function writeEvidence(directory, name, content, secrets = []) {
  let value = content
  if (name.endsWith('.json') && typeof content === 'string') value = JSON.parse(content)
  const safe = redactEvidence(value, secrets)
  writeFileSync(join(directory, name), name.endsWith('.json') ? `${JSON.stringify(safe, null, 2)}\n` : safe)
}

/** Create a temporary directory only when its resolved path is outside the repository. */
export function isolatedTemp(root, prefix) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const fromRoot = relative(realpathSync(root), temp)
  if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
    rmSync(temp, { recursive: true, force: true })
    throw new Error('temporary evidence path must stay outside the repository')
  }
  return temp
}
