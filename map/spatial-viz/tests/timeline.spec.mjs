/**
 * Timeline fixtures: calendar frame enumeration in real timezones (UTC and
 * Asia/Shanghai), 缺测 frames that stay unoccupied instead of being filled,
 * local frame labels, and the pure play/pause/step state machine whose output
 * never carries a model-facing field.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TimelineError,
  axisAdvance,
  axisGoto,
  axisPause,
  axisPlay,
  axisStep,
  createTimeAxis,
  currentFrame,
  formatFrameLabel,
  framesOf,
} from '../src/index.ts'

const DAY_MS = 24 * 60 * 60 * 1000

/** A day-granularity UTC binding over the first week of 2026. */
function utcWeekBinding() {
  return { timeField: 'observed_at', timezone: 'UTC', granularity: 'day', window: { from: '2026-01-01T00:00:00Z', to: '2026-01-08T00:00:00Z' } }
}

test('framesOf enumerates every calendar frame of the window', () => {
  const frames = framesOf(utcWeekBinding(), [])
  assert.equal(frames.length, 7)
  assert.equal(frames[0].startMs, Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(frames[0].endMs, Date.parse('2026-01-02T00:00:00Z'))
  assert.equal(frames[6].startMs, Date.parse('2026-01-07T00:00:00Z'))
  assert.equal(frames[6].endMs, Date.parse('2026-01-08T00:00:00Z'))
})

test('an empty frame stays in the axis as unoccupied — 缺测 is a mark, not a gap', () => {
  const observed = [Date.parse('2026-01-02T06:00:00Z'), Date.parse('2026-01-05T12:00:00Z')]
  const frames = framesOf(utcWeekBinding(), observed)
  assert.equal(frames.map(frame => frame.occupied).join(','), 'false,true,false,false,true,false,false')
  assert.equal(frames.filter(frame => !frame.occupied).length, 5)
})

test('observations outside the window never occupy a frame', () => {
  const observed = [Date.parse('2025-12-31T23:59:59Z'), Date.parse('2026-01-08T00:00:00Z')]
  const frames = framesOf(utcWeekBinding(), observed)
  assert.equal(frames.some(frame => frame.occupied), false)
})

test('Asia/Shanghai frames bind the local calendar: the day bin floors to local midnight', () => {
  const binding = {
    timeField: 'observed_at',
    timezone: 'Asia/Shanghai',
    granularity: 'day',
    window: { from: '2026-01-01T00:00:00+08:00', to: '2026-01-03T00:00:00+08:00' },
  }
  const frames = framesOf(binding, [])
  assert.equal(frames.length, 2)
  assert.equal(frames[0].startMs, Date.parse('2026-01-01T00:00:00+08:00'))
  assert.equal(formatFrameLabel(frames[0], 'Asia/Shanghai', 'day'), '2026-01-01')
  // A UTC reader sees the same frame start as 16:00 the previous day.
  assert.equal(formatFrameLabel(frames[0], 'UTC', 'day'), '2025-12-31')
})

test('hour frames in Asia/Shanghai step through local hours across the +08 offset', () => {
  const binding = {
    timeField: 't',
    timezone: 'Asia/Shanghai',
    granularity: 'hour',
    window: { from: '2026-03-01T22:00:00+08:00', to: '2026-03-02T02:00:00+08:00' },
  }
  const frames = framesOf(binding, [Date.parse('2026-03-01T23:30:00+08:00')])
  assert.equal(frames.length, 4)
  assert.equal(frames.map(frame => frame.occupied).join(','), 'false,true,false,false')
  assert.equal(formatFrameLabel(frames[1], 'Asia/Shanghai', 'hour'), '2026-03-01 23:00')
  assert.equal(formatFrameLabel(frames[3], 'Asia/Shanghai', 'hour'), '2026-03-02 01:00')
})

test('month and week frames bind their calendar units', () => {
  const month = {
    timeField: 't', timezone: 'UTC', granularity: 'month',
    window: { from: '2025-11-15T00:00:00Z', to: '2026-02-01T00:00:00Z' },
  }
  const months = framesOf(month, [])
  assert.deepEqual(months.map(frame => formatFrameLabel(frame, 'UTC', 'month')), ['2025-11', '2025-12', '2026-01'])
  assert.equal(months[0].startMs, Date.parse('2025-11-01T00:00:00Z'))
  const week = {
    timeField: 't', timezone: 'UTC', granularity: 'week',
    window: { from: '2026-01-01T00:00:00Z', to: '2026-01-15T00:00:00Z' },
  }
  const weeks = framesOf(week, [])
  // 2026-01-01 is a Thursday; the week bin floors to Monday 2025-12-29.
  assert.equal(formatFrameLabel(weeks[0], 'UTC', 'week'), '2025-12-29')
  assert.equal(formatFrameLabel(weeks[1], 'UTC', 'week'), '2026-01-05')
  assert.equal(formatFrameLabel(weeks[2], 'UTC', 'week'), '2026-01-12')
})

test('bad windows and timezones refuse with named codes', () => {
  assert.throws(() => framesOf({ ...utcWeekBinding(), window: { from: 'nope', to: '2026-01-02T00:00:00Z' } }), (error) => {
    assert.ok(error instanceof TimelineError)
    assert.equal(error.code, 'invalid-window')
    return true
  })
  assert.throws(() => framesOf({ ...utcWeekBinding(), window: { from: '2026-01-08T00:00:00Z', to: '2026-01-01T00:00:00Z' } }), (error) => {
    assert.equal(error.code, 'invalid-window')
    return true
  })
  assert.throws(() => framesOf({ ...utcWeekBinding(), timezone: 'Mars/Olympus' }), (error) => {
    assert.equal(error.code, 'unknown-timezone')
    return true
  })
})

test('a window wider than the frame cap refuses instead of truncating', () => {
  const binding = {
    timeField: 't', timezone: 'UTC', granularity: 'hour',
    window: { from: '2020-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' },
  }
  assert.throws(() => framesOf(binding, []), (error) => {
    assert.equal(error.code, 'too-many-frames')
    return true
  })
})

test('the axis state machine steps, clamps, records visits, and never wraps under playback', () => {
  const frames = framesOf(utcWeekBinding(), [])
  let axis = createTimeAxis(frames)
  assert.equal(axis.index, 0)
  assert.deepEqual(axis.visited, [0])
  axis = axisStep(axis, 1)
  axis = axisStep(axis, 1)
  assert.equal(axis.index, 2)
  assert.deepEqual(axis.visited, [0, 1, 2])
  assert.equal(axis.changeCount, 2)
  // Clamp at both ends: the state object is untouched.
  const backAtZero = axisStep(axisStep(axis, -1), -1)
  assert.equal(backAtZero.index, 0)
  assert.equal(axisStep(backAtZero, -1), backAtZero)
  const atEnd = axisGoto(axis, 6)
  assert.equal(axisStep(atEnd, 1), atEnd)
  // Goto clamps and dedupes history.
  assert.equal(axisGoto(axis, 2), axis)
  const jumped = axisGoto(axis, 99)
  assert.equal(jumped.index, 6)
  assert.deepEqual(jumped.visited, [0, 1, 2, 6])
})

test('play advances to the end and stops there; pause freezes; replay is deterministic', () => {
  const frames = framesOf(utcWeekBinding(), [])
  let axis = axisPlay(createTimeAxis(frames, 4))
  assert.equal(axis.playing, true)
  axis = axisAdvance(axis)
  assert.equal(axis.index, 5)
  axis = axisAdvance(axis)
  assert.equal(axis.index, 6)
  // The last frame stops playback instead of wrapping.
  axis = axisAdvance(axis)
  assert.equal(axis.index, 6)
  assert.equal(axis.playing, false)
  assert.equal(axisAdvance(axis), axis)
  axis = axisPlay(axis)
  assert.equal(axis.playing, true)
  axis = axisPause(axis)
  assert.equal(axis.playing, false)
  assert.equal(axisPause(axis), axis)
  // Determinism: the same press sequence from the start ends paused on frame 6.
  let replay = createTimeAxis(frames, 4)
  replay = axisPlay(replay)
  for (let at = 0; at < 10; at += 1) replay = axisAdvance(replay)
  assert.equal(replay.index, 6)
  assert.equal(replay.playing, false)
  assert.deepEqual(replay.visited, [4, 5, 6])
})

test('axis state is plain JSON and carries no model-facing field', () => {
  const frames = framesOf(utcWeekBinding(), [])
  const axis = axisPlay(axisStep(createTimeAxis(frames), 1))
  const text = JSON.stringify(axis)
  const roundTrip = JSON.parse(text)
  assert.deepEqual(roundTrip, axis)
  // Playback state is UI-local by construction: no event, message, channel,
  // or request field exists anywhere in the serialized state.
  for (const banned of ['event', 'message', 'request', 'tool', 'model']) {
    assert.equal(text.includes(banned), false, `axis state must not carry a ${banned} field`)
  }
  assert.equal(currentFrame(axis).startMs, frames[1].startMs)
})

test('frame windows are exact: an observation on the last millisecond occupies its frame', () => {
  const observed = [Date.parse('2026-01-06T23:59:59.999Z')]
  const frames = framesOf(utcWeekBinding(), observed)
  assert.equal(frames[5].occupied, true)
  assert.equal(frames.slice(0, 5).concat(frames.slice(6)).some(frame => frame.occupied), false)
  assert.equal(frames[5].endMs - frames[5].startMs, DAY_MS)
})
