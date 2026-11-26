/**
 * Compile-time helpers for the map release build. Release artifacts are plain
 * compiled products; the complete allowlisted source tree is published in the
 * public repository, so no implementation hiding is applied here.
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'

const require = createRequire(new URL('../tools/package.json', import.meta.url))

/**
 * Write prepared compiler modules into the checkout for bundling and restore
 * their original bytes afterwards, including on failure.
 * @param {string} root - checkout root.
 * @param {Map<string, Buffer>} prepared - compiler module bytes by relative path.
 * @returns {() => void} restore callback.
 */
export function stagePreparedFiles(root, prepared) {
  const originals = new Map()
  for (const [file, bytes] of prepared) {
    originals.set(file, readFileSync(`${root}/${file}`))
    writeFileSync(`${root}/${file}`, bytes)
  }
  return () => { for (const [file, bytes] of originals) writeFileSync(`${root}/${file}`, bytes) }
}

/**
 * Embed named worker/page program constants into their compiled owner module
 * without rewriting the program text.
 * @param {string} file - compiled owner module path.
 * @param {Buffer} bytes - original compiled module.
 * @param {Record<string, string>} programs - named module constants and their evaluated values.
 * @returns {Buffer} compiled module with embedded program constants.
 */
export function inlineEmbeddedPrograms(file, bytes, programs) {
  const ts = require('typescript')
  const replacements = new Map(Object.entries(programs).map(([name, source]) => {
    if (name === 'TIANDITU_SDK_PAGE_HTML') {
      let scripts = 0
      const html = source.replace(/<script>([\s\S]*?)<\/script>/gu, (_match, code) => {
        scripts += 1
        return `<script>${code}</script>`
      })
      if (scripts !== 1 || !html.includes('__TIANDITU_SDK_KEY__')) throw new Error('SDK page embedding lost its script or key placeholder.')
      return [name, html]
    }
    return [name, source]
  }))
  const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const seen = new Set()
  const transformed = ts.transform(source, [context => node => {
    const visit = child => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && replacements.has(child.name.text)) {
        if (seen.has(child.name.text)) throw new Error('Embedded program declaration is ambiguous.')
        seen.add(child.name.text)
        return ts.factory.updateVariableDeclaration(child, child.name, child.exclamationToken, child.type, ts.factory.createStringLiteral(replacements.get(child.name.text)))
      }
      return ts.visitEachChild(child, visit, context)
    }
    return ts.visitNode(node, visit)
  }])
  try {
    if (seen.size !== replacements.size) throw new Error('Embedded program declaration is missing from the compiler output.')
    return Buffer.from(ts.createPrinter().printFile(transformed.transformed[0]))
  } finally { transformed.dispose() }
}

/**
 * Inline browser compiler constants before bundling.
 * @param {string} file - compiled browser module path.
 * @param {Buffer} bytes - original compiler output.
 * @param {Record<string, string>} definitions - shared JSON compiler expressions.
 * @returns {Buffer} compiler output with resolved public build constants.
 */
export function inlineBrowserDefines(file, bytes, definitions) {
  const ts = require('typescript')
  const source = ts.createSourceFile(file, bytes.toString('utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const literal = value => typeof value === 'string' ? ts.factory.createStringLiteral(value)
    : ts.factory.createObjectLiteralExpression(Object.entries(value).map(([key, child]) => ts.factory.createPropertyAssignment(ts.factory.createStringLiteral(key), literal(child))))
  const transformed = ts.transform(source, [context => node => {
    const visit = child => {
      if (ts.isPropertyAccessExpression(child)) {
        const expression = child.getText(source)
        if (Object.hasOwn(definitions, expression)) return literal(JSON.parse(definitions[expression]))
      }
      return ts.visitEachChild(child, visit, context)
    }
    return ts.visitNode(node, visit)
  }])
  try { return Buffer.from(ts.createPrinter().printFile(transformed.transformed[0])) } finally { transformed.dispose() }
}
