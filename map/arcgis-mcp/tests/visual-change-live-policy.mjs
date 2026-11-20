/**
 * Admission for the opt-in two-image live qualification. The spec's authority
 * line and the explicit environment switch must agree before any relay,
 * browser, credential or image action starts.
 */
import { readFileSync } from 'node:fs'
import { visualChangeSpecPath } from './visual-change-live-paths.mjs'

/** Explicit opt-in switch; absent means the lane sends no images. */
export const LIVE_ENV = 'MAP_VISUAL_CHANGE_LIVE'

const closedDecision = /^- \[[xX]\] \[decision\][^\n]*$/gmu
const placeholder = /^(?:todo|tbd|pending|placeholder|<[^>]+>)$/iu

/**
 * Resolve one admitted live run, or a reason that keeps the lane inert.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @param {string} content - current spec text.
 * @returns the admission result with model, budget and authority reference.
 */
export function visualChangeLiveAdmission(env = process.env, content = readFileSync(visualChangeSpecPath(), 'utf8')) {
  const enabled = env[LIVE_ENV] === '1'
  const line = [...content.matchAll(closedDecision)].at(-1)?.[0] ?? ''
  const parse = key => new RegExp(`\\|\\s*${key}:\\s*([^|]+)`, 'u').exec(line)?.[1]?.trim()
  const authorityMatch = /\|\s*authority:\s*user:([^\s|]+)/u.exec(line)
  const authority = authorityMatch?.[1]
  const answer = parse('answer')
  const model = parse('model')
  const budget = parse('budget')
  const reason = !enabled ? `${LIVE_ENV} is not enabled`
    : authority === undefined ? 'the spec authority decision is not closed'
      : answer === undefined ? 'the closed decision must carry an answer'
        : placeholder.test(answer) ? 'the closed decision answer cannot be a placeholder'
        : model === undefined ? 'the closed decision must name the model'
          : budget === undefined ? 'the closed decision must name the budget'
      : env.MAP_VISUAL_CHANGE_MODEL === undefined ? 'MAP_VISUAL_CHANGE_MODEL is required'
        : env.MAP_VISUAL_CHANGE_BUDGET === undefined ? 'MAP_VISUAL_CHANGE_BUDGET is required'
          : env.MAP_VISUAL_CHANGE_AUTHORITY !== authority ? 'MAP_VISUAL_CHANGE_AUTHORITY must match the closed decision'
            : env.MAP_VISUAL_CHANGE_MODEL !== model ? 'MAP_VISUAL_CHANGE_MODEL must match the closed decision'
              : env.MAP_VISUAL_CHANGE_BUDGET !== budget ? 'MAP_VISUAL_CHANGE_BUDGET must match the closed decision'
                : undefined
  return {
    enabled,
    ok: reason === undefined,
    reason,
    authority,
    answer,
    model,
    budget,
  }
}

/**
 * Build the inert result the live fixture returns before any side effect.
 * @param {object} admission - result of `visualChangeLiveAdmission`.
 * @returns the deterministic skipped report.
 */
export function skippedVisualChangeLiveReport(admission) {
  return {
    ok: false,
    skipped: true,
    reason: admission.reason,
    relayRequests: 0,
    browserLaunches: 0,
    sentImages: 0,
  }
}
