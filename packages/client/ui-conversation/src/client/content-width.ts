/** Transcript width persistence owned by the Conversation composition. */
import type { BrowserStorage } from '@deepseek-ai/dsh-client-store'

const WIDTH_PREF_KEY = 'dsh.conversation.contentWidth'

/**
 * Read the preferred width without reaching another application's namespace.
 * @param storage - Composition-owned persistence adapter.
 * @returns A positive width, or null when absent, malformed, or inaccessible.
 */
export function readContentWidth(storage: BrowserStorage): number | null {
  let raw: string | null
  try { raw = storage.getItem(WIDTH_PREF_KEY) }
  catch (error) {
    console.error('Conversation width restoration failed; using the default width:', error)
    return null
  }
  if (raw === null) return null
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Save a completed width gesture; failure preserves the currently displayed layout.
 * @param storage - Composition-owned persistence adapter.
 * @param width - Resolved width in pixels.
 */
export function saveContentWidth(storage: BrowserStorage, width: number): void {
  try { storage.setItem(WIDTH_PREF_KEY, String(width)) }
  catch (error) { console.error('Conversation width persistence failed; retry the width change:', error) }
}
