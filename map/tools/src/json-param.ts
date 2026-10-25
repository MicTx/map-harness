/**
 * Model-facing `type:'json'` arguments arrive in two legal forms. The harness
 * projects `type:'json'` as an unconstrained property, so a model may send
 * either the already-parsed JSON value or that value encoded as a JSON string.
 * Tools that consume a specific shape decode here, then keep their existing
 * shape checks.
 * @module @map-harness/map-tools/json-param
 */
import { SpatialError } from './spatial-errors.ts'

/** Model-visible echo cap. Longer rejected strings are counted, not quoted. */
const MAX_ECHO_CHARS = 80

/**
 * Decode one `type:'json'` argument.
 *
 * A string is parsed as JSON. Anything else — including `undefined` for an
 * omitted optional — passes through unchanged, so the caller's existing shape
 * checks and error vocabulary stay the ones the model sees.
 * @param value - the raw argument the model sent.
 * @param name - the parameter name the refusal names.
 * @returns the decoded JSON value, or `value` when it was not a string.
 * @throws {SpatialError} `INVALID_ARGUMENT` when the string is not JSON. The
 *   message names `name` and never echoes more than {@link MAX_ECHO_CHARS}
 *   characters of the rejected string.
 */
export function decodeJsonParam(value: unknown, name: string): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch (error: unknown) {
    // The parser's own message quotes the input, so it never reaches the model.
    void error
    const echo = value.length <= MAX_ECHO_CHARS
      ? JSON.stringify(value)
      : `${value.length} characters`
    throw new SpatialError('INVALID_ARGUMENT', `${name} is a string that is not valid JSON (${echo})`)
  }
}
