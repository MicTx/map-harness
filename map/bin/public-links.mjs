/**
 * Strip Markdown links whose relative target is a tracked path the public
 * snapshot does not publish, keeping the link text. The public tree drops
 * agent state, task packages, and session recordings; a link into them
 * would be broken on GitHub and would name private material.
 *
 * Only targets that exist in the private repository are rewritten. A link
 * that is already broken there is left unchanged for the repository's own
 * link gates to report, and external, root-absolute, and in-page targets
 * are never touched. Code spans and fenced code are not link nodes, so they
 * stay byte-identical.
 */
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, posix, relative } from 'node:path'
import {
  isExternalOrAbsoluteMarkdownUrl,
  markdownDestination,
  parseMarkdown,
  splitMarkdownUrlTarget,
  visitMarkdown,
} from '../../scripts/markdown.ts'

/** Rewrite passes per document; an image inside a link needs a second pass. */
const MAX_PASSES = 4

/** Every ancestor directory of the given repository-relative files. */
function directoriesOf(files) {
  const dirs = new Set()
  for (const file of files) {
    let dir = posix.dirname(file)
    while (dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir)
      dir = posix.dirname(dir)
    }
  }
  return dirs
}

/**
 * Build the predicate that decides whether one authored link target is a
 * tracked path the snapshot does not publish.
 * @param {{ published: string[], excluded: string[] }} classification - the snapshot's path classification.
 * @returns {(url: string, file: string) => boolean} the predicate over a raw URL and its source file.
 */
export function unpublishedTargetOf({ published, excluded }) {
  const publishedFiles = new Set(published)
  const publishedDirs = directoriesOf(published)
  const trackedFiles = new Set([...published, ...excluded])
  const trackedDirs = directoriesOf(trackedFiles)
  return (url, file) => {
    if (isExternalOrAbsoluteMarkdownUrl(url)) return false
    const { path } = splitMarkdownUrlTarget(url)
    if (path === '') return false
    let decoded = path
    try { decoded = decodeURIComponent(path) } catch { /* A malformed escape is matched as authored; the private link gates own it. */ }
    const target = posix.normalize(posix.join(posix.dirname(file), decoded)).replace(/\/+$/u, '')
    if (target === '' || target === '.' || target.startsWith('../')) return false
    if (publishedFiles.has(target) || publishedDirs.has(target)) return false
    return trackedFiles.has(target) || trackedDirs.has(target)
  }
}

/**
 * The authored URL of one link, image, or definition. An autolink (a bare or
 * angle-bracket URL, the former generated without source offsets) has no
 * label; its URL is always absolute, so it never names an unpublished
 * repository path.
 */
function authoredUrl(source, node) {
  if (node.position === undefined) return node.url
  if (node.type === 'link' && source[node.position.start.offset] !== '[') return node.url
  return markdownDestination(source, node).url
}

/** The raw label source between a node's first `[` and its matching `]`. */
function labelSource(raw) {
  const first = raw.indexOf('[')
  let depth = 0
  for (let index = first; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '\\') index += 1
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return raw.slice(first + 1, index)
    }
  }
  throw new Error(`public-links: cannot locate the label of ${JSON.stringify(raw)}`)
}

/** The end offset of one block node including its trailing line break, so a removed definition leaves no blank line behind. */
function lineEnd(source, end) {
  if (source[end] === '\r' && source[end + 1] === '\n') return end + 2
  return source[end] === '\n' ? end + 1 : end
}

/** One rewrite pass: the non-overlapping edits for unpublished links, images, definitions, and references to them. */
function passEdits(source, file, isUnpublished) {
  const tree = parseMarkdown(source)
  const edits = []
  const removedDefinitions = new Set()
  visitMarkdown(tree, node => {
    if (node.type !== 'definition') return true
    if (isUnpublished(authoredUrl(source, node), file)) {
      edits.push({ start: node.position.start.offset, end: lineEnd(source, node.position.end.offset), text: '' })
      removedDefinitions.add(node.identifier)
    }
    return false
  })
  visitMarkdown(tree, node => {
    const unpublishedInline = (node.type === 'link' || node.type === 'image')
      && isUnpublished(authoredUrl(source, node), file)
    const unpublishedReference = (node.type === 'linkReference' || node.type === 'imageReference')
      && removedDefinitions.has(node.identifier)
    if (!unpublishedInline && !unpublishedReference) return true
    const { start, end } = { start: node.position.start.offset, end: node.position.end.offset }
    edits.push({ start, end, text: labelSource(source.slice(start, end)) })
    return false
  })
  return edits
}

/**
 * Rewrite one Markdown source: each link or image whose target is unpublished
 * becomes its label source, each such reference definition is removed, and
 * each reference to a removed definition becomes its label.
 * @param {string} source - the Markdown text.
 * @param {string} file - its repository-relative path, for resolving relative targets.
 * @param {(url: string, file: string) => boolean} isUnpublished - the target predicate.
 * @returns {{ text: string, removed: number }} the rewritten text and the number of removed links.
 */
export function stripUnpublishedLinks(source, file, isUnpublished) {
  let text = source
  let removed = 0
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const edits = passEdits(text, file, isUnpublished).sort((left, right) => right.start - left.start)
    if (edits.length === 0) return { text, removed }
    for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
    removed += edits.length
  }
  throw new Error(`public-links: ${file} still links to unpublished paths after ${MAX_PASSES} passes`)
}

/**
 * The regular Markdown files of a staged tree: published `.md` files plus
 * the in-tree targets of `.md` symlinks, each once.
 */
function stagedMarkdown(stage, published) {
  const files = new Set()
  for (const file of published) {
    if (!file.endsWith('.md')) continue
    const absolute = join(stage, file)
    if (!lstatSync(absolute).isSymbolicLink()) {
      files.add(file)
      continue
    }
    const target = relative(realpathSync(stage), realpathSync(absolute)).split('\\').join('/')
    if (!target.startsWith('../')) files.add(target)
  }
  return [...files].sort()
}

/**
 * Rewrite every staged Markdown file in place.
 * @param {string} stage - the staged public tree.
 * @param {{ published: string[], excluded: string[] }} classification - the snapshot's path classification.
 * @returns {{ changedDocuments: string[], removedLinks: number }} the rewritten documents and removed link count.
 */
export function stripStagedUnpublishedLinks(stage, classification) {
  const isUnpublished = unpublishedTargetOf(classification)
  const changedDocuments = []
  let removedLinks = 0
  for (const file of stagedMarkdown(stage, classification.published)) {
    const path = join(stage, file)
    const source = readFileSync(path, 'utf8')
    const { text, removed } = stripUnpublishedLinks(source, file, isUnpublished)
    if (removed === 0) continue
    writeFileSync(path, text)
    changedDocuments.push(file)
    removedLinks += removed
  }
  return { changedDocuments, removedLinks }
}

/**
 * List the staged Markdown files that still link to an unpublished path,
 * without rewriting anything.
 * @param {string} stage - the staged public tree.
 * @param {{ published: string[], excluded: string[] }} classification - the snapshot's path classification.
 * @returns {string[]} one `file: url` entry per remaining link.
 */
export function remainingUnpublishedLinks(stage, classification) {
  const isUnpublished = unpublishedTargetOf(classification)
  const remaining = []
  for (const file of stagedMarkdown(stage, classification.published)) {
    const source = readFileSync(join(stage, file), 'utf8')
    visitMarkdown(parseMarkdown(source), node => {
      if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
        const url = authoredUrl(source, node)
        if (isUnpublished(url, file)) remaining.push(`${file}: ${url}`)
      }
      return true
    })
  }
  return remaining
}
