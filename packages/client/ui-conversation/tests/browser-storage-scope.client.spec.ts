// @vitest-environment jsdom
/** Eager Conversation reads and delayed Store materialization share one application adapter. */
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserStorage } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createConversationStore, readConversationDraft, readConversationViewPreference } from '../src/client/stores.ts'
import { readContentWidth, saveContentWidth } from '../src/client/content-width.ts'

const session = 'shared-session' as SessionId
afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

it('restores DSH → Map A → Map B → Map A drafts, views and widths independently', () => {
  const namespaces = ['', 'map-harness:A', 'map-harness:B']
  for (const [index, namespace] of namespaces.entries()) {
    const storage = createBrowserStorage(namespace, window)
    expect(readConversationDraft(session, storage).text).toBe('')
    expect(readConversationViewPreference(session, storage)).toBeNull()
    expect(readContentWidth(storage)).toBeNull()
    const state = createConversationStore().create(session, storage)
    state.actions.setDraft(`draft-${index}`)
    state.actions.setView(`view-${index}`)
    saveContentWidth(storage, 700 + index * 100)
  }
  const before = localStorage.getItem(`dsh.conversation.${session}`)
  const a = createBrowserStorage('map-harness:A', window)
  expect(readConversationDraft(session, a).text).toBe('draft-1')
  expect(readConversationViewPreference(session, a)).toBe('view-1')
  expect(createConversationStore().create(session, a).getSnapshot().draft).toBe('draft-1')
  expect(readContentWidth(a)).toBe(800)
  createConversationStore().create(session, a).clearPersisted()
  expect(readConversationDraft(session, a).text).toBe('')
  expect(localStorage.getItem(`dsh.conversation.${session}`)).toBe(before)
  expect(readConversationDraft(session).text).toBe('draft-0')
  expect(readContentWidth(createBrowserStorage())).toBe(700)
})

it('keeps width defaults on corrupt or denied storage and reports a failed save', () => {
  const storage = createBrowserStorage('map-harness:A', window)
  storage.setItem('dsh.conversation.contentWidth', 'invalid')
  expect(readContentWidth(storage)).toBeNull()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const denied = createBrowserStorage('map-harness:A', { get localStorage(): Storage { throw new Error('denied') } })
  expect(readContentWidth(denied)).toBeNull()
  saveContentWidth(denied, 900)
  expect(error).toHaveBeenCalledTimes(2)
})
