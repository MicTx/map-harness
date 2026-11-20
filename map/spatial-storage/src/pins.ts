/**
 * Backup pins: explicit, named holds on store targets (published versions
 * and staging entries alike) that cleanup must respect. A pin is added by
 * the operation that needs the target to survive — a backup window, a manual
 * hold — and removed when the operation ends; it never expires on its own.
 *
 * @module @map-harness/spatial-storage/pins
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RefTargetKind } from './refs.ts'

/** The target kinds a pin can hold; staging entries pin by their row id. */
export type PinTargetKind = RefTargetKind | 'staging'

/** One recorded pin. */
export interface StorePin {
  readonly pinId: string
  readonly targetKind: PinTargetKind
  readonly targetId: string
  readonly reason: string
  readonly createdAt: string
}

/**
 * Pin one target with a named reason; the same target+reason pair is
 * idempotent.
 * @param db - the open store handle.
 * @param target - the pin's target kind and id.
 * @param reason - the operation name holding the pin (recorded, not interpreted).
 * @returns the pin id.
 */
export function pinTarget(db: DatabaseSync, target: { kind: PinTargetKind; id: string }, reason: string): string {
  const pinId = randomUUID()
  db.prepare('INSERT OR IGNORE INTO backup_pins (pin_id, target_kind, target_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(pinId, target.kind, target.id, reason, new Date().toISOString())
  const row = db.prepare('SELECT pin_id FROM backup_pins WHERE target_kind = ? AND target_id = ? AND reason = ?')
    .get(target.kind, target.id, reason) as { pin_id: string }
  return row.pin_id
}

/**
 * Remove one pin by id.
 * @param db - the open store handle.
 * @param pinId - the id {@link pinTarget} returned.
 */
export function unpinTarget(db: DatabaseSync, pinId: string): void {
  db.prepare('DELETE FROM backup_pins WHERE pin_id = ?').run(pinId)
}

/**
 * List every live pin.
 * @param db - the open store handle.
 * @returns the pins in creation order.
 */
export function listPins(db: DatabaseSync): readonly StorePin[] {
  const rows = db.prepare(
    'SELECT pin_id AS pinId, target_kind AS targetKind, target_id AS targetId, reason, created_at AS createdAt FROM backup_pins ORDER BY created_at, pin_id',
  ).all() as unknown as Array<StorePin>
  return rows
}
