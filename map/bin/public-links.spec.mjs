/** Public-snapshot link stripping: unpublished targets lose their link, everything else is byte-identical. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remainingUnpublishedLinks, stripStagedUnpublishedLinks, stripUnpublishedLinks, unpublishedTargetOf } from './public-links.mjs'

const classification = {
  published: ['README.md', 'docs/guide.md', 'docs/sub/page.md', 'map/docs/a.md'],
  excluded: ['.agents/notes/x.md', '.agents/skills/s/SKILL.md', 'snapshots/session/a/session.v4.jsonl', '.spec/specs/p/spec.md'],
}
const isUnpublished = unpublishedTargetOf(classification)

test('the predicate names only tracked paths the snapshot does not publish', () => {
  assert.equal(isUnpublished('../.agents/notes/x.md', 'docs/guide.md'), true, 'an excluded file')
  assert.equal(isUnpublished('../.agents/skills', 'docs/guide.md'), true, 'an excluded directory')
  assert.equal(isUnpublished('../snapshots/session/a/session.v4.jsonl#L2', 'docs/guide.md'), true, 'a fragment does not hide the target')
  assert.equal(isUnpublished('sub/page.md', 'docs/guide.md'), false, 'a published file')
  assert.equal(isUnpublished('sub', 'docs/guide.md'), false, 'a published directory')
  assert.equal(isUnpublished('../missing.md', 'docs/guide.md'), false, 'a link already broken in the private repo is left to its own gates')
  assert.equal(isUnpublished('https://example.com/.agents/x.md', 'docs/guide.md'), false, 'an external URL')
  assert.equal(isUnpublished('/.agents/notes/x.md', 'docs/guide.md'), false, 'a root-absolute URL')
  assert.equal(isUnpublished('#section', 'docs/guide.md'), false, 'an in-page anchor')
  assert.equal(isUnpublished('../../../outside.md', 'docs/guide.md'), false, 'a target outside the repository')
})

test('links, images, definitions, and their references become plain text; everything else is unchanged', () => {
  const source = [
    '# Guide',
    '',
    'See [the note](../.agents/notes/x.md) and [`page`](sub/page.md).',
    'Recorded in [this **session**](../snapshots/session/a/session.v4.jsonl "title").',
    '![shot](../.spec/specs/p/spec.md)',
    'Reference [skill][s] and [kept][k] and [s].',
    '',
    '[s]: ../.agents/skills/s/SKILL.md',
    '[k]: sub/page.md',
    '',
    '```md',
    '[not a link](../.agents/notes/x.md)',
    '```',
    'Inline `[code](../.agents/notes/x.md)` stays.',
    'Autolinks <https://example.com/a> and https://example.com/b stay.',
    '',
  ].join('\n')
  const { text, removed } = stripUnpublishedLinks(source, 'docs/guide.md', isUnpublished)
  assert.equal(removed, 6, 'three inline links or images, one definition, and two references to it')
  assert.equal(text, [
    '# Guide',
    '',
    'See the note and [`page`](sub/page.md).',
    'Recorded in this **session**.',
    'shot',
    'Reference skill and [kept][k] and s.',
    '',
    '[k]: sub/page.md',
    '',
    '```md',
    '[not a link](../.agents/notes/x.md)',
    '```',
    'Inline `[code](../.agents/notes/x.md)` stays.',
    'Autolinks <https://example.com/a> and https://example.com/b stay.',
    '',
  ].join('\n'))
  assert.deepEqual(stripUnpublishedLinks(text, 'docs/guide.md', isUnpublished), { text, removed: 0 }, 'stripping is idempotent')
})

test('an image inside an unpublished link is stripped on a later pass', () => {
  const { text, removed } = stripUnpublishedLinks('[![badge](../.spec/specs/p/spec.md)](../.agents/notes/x.md)\n', 'docs/guide.md', isUnpublished)
  assert.equal(text, 'badge\n')
  assert.equal(removed, 2)
})

test('a staged tree is rewritten in place once per real file, and the scan finds nothing left', t => {
  const stage = mkdtempSync(join(tmpdir(), 'map-public-links-'))
  t.after(() => rmSync(stage, { recursive: true, force: true }))
  mkdirSync(join(stage, 'docs/sub'), { recursive: true })
  mkdirSync(join(stage, 'map/docs'), { recursive: true })
  writeFileSync(join(stage, 'docs/guide.md'), 'Go [here](../.agents/notes/x.md).\n')
  writeFileSync(join(stage, 'docs/sub/page.md'), 'Plain page.\n')
  writeFileSync(join(stage, 'map/docs/a.md'), 'Same [note](../../.agents/notes/x.md).\n')
  symlinkSync('docs/guide.md', join(stage, 'README.md'))
  const staged = { ...classification }
  assert.deepEqual(remainingUnpublishedLinks(stage, staged), ['docs/guide.md: ../.agents/notes/x.md', 'map/docs/a.md: ../../.agents/notes/x.md'])
  const result = stripStagedUnpublishedLinks(stage, staged)
  assert.deepEqual(result, { changedDocuments: ['docs/guide.md', 'map/docs/a.md'], removedLinks: 2 })
  assert.equal(readFileSync(join(stage, 'docs/guide.md'), 'utf8'), 'Go here.\n')
  assert.equal(readFileSync(join(stage, 'docs/sub/page.md'), 'utf8'), 'Plain page.\n', 'a document without such links is untouched')
  assert.deepEqual(remainingUnpublishedLinks(stage, staged), [])
})
