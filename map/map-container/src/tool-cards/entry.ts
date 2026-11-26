/**
 * Dictionary entry types for map tool cards and the shared field builders the
 * dictionary composes. An entry names the user-facing action, the card icon
 * category, the argument fields a pending card lists, and the result fields a
 * completed card lists.
 * @module @map-harness/map-container/tool-cards/entry
 */
/** Card icon category; mirrors `ToolCardKind` from `@deepseek-ai/dsh-tools`. */
export type ToolCardKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'
import { fileOf, idOf, textOf } from './format.ts'

/** One labeled line on a card, read from one top-level key of an object. */
export interface CardField {
  /** Chinese display label. */
  readonly label: string
  /** Key read from the call arguments or the parsed result value; `a.b` reads a nested member. */
  readonly key: string
  /** Formatter; `undefined` omits the line. */
  readonly format: (value: unknown) => string | undefined
}

/** The display description of one map tool. */
export interface PresentationEntry {
  /** Short Chinese verb phrase, the card title prefix (e.g. `添加图层`). */
  readonly action: string
  /** Card icon category. */
  readonly kind: ToolCardKind
  /** Argument fields; the first that formats becomes the title subject. */
  readonly args: readonly CardField[]
  /** Result fields read from the JSON result value. */
  readonly result: readonly CardField[]
}

/**
 * Build one card field.
 * @param label - display label.
 * @param key - top-level key to read.
 * @param format - value formatter.
 * @returns the field.
 */
export function field(label: string, key: string, format: (value: unknown) => string | undefined): CardField {
  return { label, key, format }
}

/** Argument field: a catalog/artifact ref. */
export const refArg = (key = 'ref', label = '数据版本'): CardField => field(label, key, idOf)
/** Argument field: a workspace file path shown as its basename. */
export const pathArg = (key = 'path', label = '文件'): CardField => field(label, key, fileOf)
/** Argument field: a layer id. */
export const layerArg = (key = 'layer_id', label = '图层'): CardField => field(label, key, idOf)
/** Argument field: a free-text name. */
export const nameArg = (key = 'name', label = '名称'): CardField => field(label, key, textOf)
/** Argument field: a decision goal revision. */
export const goalArg: CardField = field('目标版本', 'goal_revision', idOf)
/** Argument field: the analyzed resource ref. */
export const resourceArg: CardField = field('数据', 'resource_ref', idOf)
/** Argument field: the analyzed attribute field. */
export const fieldArg = (key = 'field', label = '字段'): CardField => field(label, key, textOf)
/** Argument field: a stream id. */
export const streamArg: CardField = field('数据流', 'stream_id', idOf)
/** Argument field: a run id. */
export const runArg: CardField = field('任务', 'run_id', idOf)
/** Result field: the published artifact or resource ref. */
export const refResult = (key = 'ref', label = '产出版本'): CardField => field(label, key, idOf)
/** Result field: a free-text status. */
export const statusResult: CardField = field('状态', 'status', textOf)

/**
 * Build an entry.
 * @param action - title verb phrase.
 * @param kind - icon category.
 * @param args - argument fields.
 * @param result - result fields.
 * @returns the frozen entry.
 */
export function entry(action: string, kind: ToolCardKind, args: readonly CardField[], result: readonly CardField[] = []): PresentationEntry {
  return Object.freeze({ action, kind, args, result })
}
