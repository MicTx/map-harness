/**
 * The cc-switch by-name credential resolver. Credential references carry a
 * store and a provider name (`cc-switch:DeepSeek`); the value is fetched at
 * the execution round that opens a source — the cc-switch store is the
 * rotation point for this deployment's keys, so a load-time snapshot would
 * go stale the moment the switcher switches — and the resolved key lives
 * only in the reader's memory for that stream's lifetime. It never enters
 * config defaults, logs, error text, summaries, or checkpoints.
 *
 * The resolver opens the store read-only, selects the named provider rows,
 * extracts the API key from each row's `settings_config` JSON, and refuses
 * loudly — by name, never by value — when the store is missing, the schema
 * does not match, no provider carries the name, or same-named providers
 * disagree on the key.
 *
 * @module @map-harness/stream-providers/credentials
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CREDENTIAL_STORE, credentialRefProblem } from './contract.ts'
import { StreamProvidersError } from './errors.ts'

/** Default store location: `<home>/.cc-switch/cc-switch.db`. */
export function defaultCcSwitchDbPath(): string {
  return join(homedir(), '.cc-switch', 'cc-switch.db')
}

/** One parsed by-name credential reference. */
export interface ParsedCredentialRef {
  /** The credential store the reference names; always `cc-switch` here. */
  readonly store: string
  /** The provider name inside the store. */
  readonly name: string
}

/**
 * Parse a by-name credential reference into its store and name.
 * @param ref - the reference string (`cc-switch:<name>`).
 * @returns the parsed reference.
 * @throws {StreamProvidersError} with `STREAM_PROVIDERS_CONFIG_INVALID` when the grammar is refused.
 */
export function parseCredentialRef(ref: string): ParsedCredentialRef {
  const problem = credentialRefProblem(ref)
  if (problem !== undefined) {
    throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', problem)
  }
  const separator = ref.indexOf(':')
  return { store: ref.slice(0, separator), name: ref.slice(separator + 1) }
}

/** Options the resolver accepts. */
export interface CredentialResolveOptions {
  /** Store database path override; the default is `<home>/.cc-switch/cc-switch.db`. */
  readonly dbPath?: string
}

/** One candidate row the store returned for a name. */
interface ProviderRow {
  readonly app_type: string | null
  readonly settings_config: string | null
}

/**
 * Resolve one by-name credential reference to its API key value, fetched
 * from the cc-switch store at the execution round that needs it.
 * @param ref - the reference string (`cc-switch:<name>`).
 * @param options - store path override (tests point this at a fixture store).
 * @returns the resolved API key; the caller holds it in memory only.
 * @throws {StreamProvidersError} with `STREAM_PROVIDERS_CREDENTIAL_STORE_UNAVAILABLE`
 * when the store cannot be opened or its schema does not match;
 * `STREAM_PROVIDERS_CREDENTIAL_UNRESOLVED` when no provider carries the name,
 * none carries an API key, or same-named providers disagree on the key.
 */
export function resolveCredentialRef(ref: string, options?: CredentialResolveOptions): string {
  const parsed = parseCredentialRef(ref)
  if (parsed.store !== CREDENTIAL_STORE) {
    throw new StreamProvidersError('STREAM_PROVIDERS_CONFIG_INVALID', `credential reference names store "${parsed.store}"; only ${CREDENTIAL_STORE}:<name> is supported`)
  }
  const dbPath = options?.dbPath ?? defaultCcSwitchDbPath()
  let database: DatabaseSync
  try {
    database = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    throw new StreamProvidersError(
      'STREAM_PROVIDERS_CREDENTIAL_STORE_UNAVAILABLE',
      `the ${CREDENTIAL_STORE} store is not readable for credential name "${parsed.name}" (${describe(error)}); point ccSwitchDb at the store or provision the name in cc-switch`,
    )
  }
  let rows: ProviderRow[]
  try {
    const raw = database.prepare('SELECT app_type, settings_config FROM providers WHERE name = ?').all(parsed.name)
    rows = []
    for (const record of raw) {
      rows.push({
        app_type: typeof record.app_type === 'string' ? record.app_type : null,
        settings_config: typeof record.settings_config === 'string' ? record.settings_config : null,
      })
    }
  } catch (error) {
    database.close()
    throw new StreamProvidersError(
      'STREAM_PROVIDERS_CREDENTIAL_STORE_UNAVAILABLE',
      `the ${CREDENTIAL_STORE} store does not expose its providers table for credential name "${parsed.name}" (${describe(error)}); the store schema this plane reads has changed`,
    )
  }
  database.close()

  if (rows.length === 0) {
    throw new StreamProvidersError(
      'STREAM_PROVIDERS_CREDENTIAL_UNRESOLVED',
      `credential name "${parsed.name}" matches no provider in the ${CREDENTIAL_STORE} store; provision it in cc-switch or fix the reference`,
    )
  }
  const keys = new Map<string, string[]>()
  for (const row of rows) {
    const key = extractApiKey(row, parsed.name)
    if (key === undefined) continue
    const appTypes = keys.get(key) ?? []
    if (row.app_type !== null) appTypes.push(row.app_type)
    keys.set(key, appTypes)
  }
  if (keys.size === 0) {
    throw new StreamProvidersError(
      'STREAM_PROVIDERS_CREDENTIAL_UNRESOLVED',
      `credential name "${parsed.name}" matches ${String(rows.length)} provider row(s) in the ${CREDENTIAL_STORE} store, none carrying an api key in its settings`,
    )
  }
  if (keys.size > 1) {
    const candidates = [...new Set(rows.map(row => row.app_type ?? '?'))].join(', ')
    throw new StreamProvidersError(
      'STREAM_PROVIDERS_CREDENTIAL_UNRESOLVED',
      `credential name "${parsed.name}" matches providers that disagree on the key (app types: ${candidates}); disambiguate the provider name in cc-switch`,
    )
  }
  for (const value of keys.keys()) {
    return value
  }
  // Unreachable past the size checks above; fail loud rather than return undefined.
  throw new StreamProvidersError('STREAM_PROVIDERS_CREDENTIAL_UNRESOLVED', `credential name "${parsed.name}" produced no key`)
}

/** Extract a non-empty API key from one provider row's settings JSON; any structural miss yields undefined. */
function extractApiKey(row: ProviderRow, name: string): string | undefined {
  if (row.settings_config === null) return undefined
  let settings: unknown
  try {
    settings = JSON.parse(row.settings_config)
  } catch {
    return undefined
  }
  if (typeof settings !== 'object' || settings === null) return undefined
  const key = (settings as { apiKey?: unknown }).apiKey
  if (typeof key !== 'string' || key.length === 0) return undefined
  void name
  return key
}

/** Render one caught error as a bounded, sanitized reason (no paths, no values). */
function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const first = message.split('\n', 1)[0] ?? 'unknown error'
  // Strip anything that smells like a filesystem path before it enters diagnostics.
  const pathless = first.replace(/(?:[A-Za-z]:[\\/]|\/)[^ \t]*/g, '<path>')
  return pathless.length > 160 ? `${pathless.slice(0, 159)}…` : pathless
}
