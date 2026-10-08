/**
 * Numeric-kernel fixtures with mature-reference cross-checks: the Student-t
 * and normal quantiles are pinned against published statistical-table values
 * (R qt()/qnorm() and classical tables), the incomplete beta against its
 * closed forms and the symmetry identity, OLS against hand-solved systems
 * including a singular design, and Pearson/Spearman against textbook
 * examples. Every check states its tolerance in advance.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  averageRanks,
  betainc,
  invertMatrix,
  normalQuantile,
  olsFit,
  pearson,
  solveLinear,
  spearman,
  tCdf,
  tQuantile,
} from '../src/linalg.ts'

test('tQuantile reproduces the published Student-t table values', () => {
  // R: qt(0.975, df) for df 1, 5, 10, 30, 100.
  assert.ok(Math.abs(tQuantile(0.975, 1) - 12.706204736432095) < 1e-9, `df=1 (got ${tQuantile(0.975, 1)})`)
  assert.ok(Math.abs(tQuantile(0.975, 5) - 2.5705818366147395) < 1e-9, `df=5 (got ${tQuantile(0.975, 5)})`)
  assert.ok(Math.abs(tQuantile(0.975, 10) - 2.2281388519649385) < 1e-9, `df=10 (got ${tQuantile(0.975, 10)})`)
  assert.ok(Math.abs(tQuantile(0.975, 30) - 2.0422724563012378) < 1e-9, `df=30 (got ${tQuantile(0.975, 30)})`)
  assert.ok(Math.abs(tQuantile(0.975, 100) - 1.9839715184496334) < 1e-8, `df=100 (got ${tQuantile(0.975, 100)})`)
  // The t distribution converges to the normal as df grows.
  assert.ok(Math.abs(tQuantile(0.975, 1e6) - normalQuantile(0.975)) < 1e-4)
})

test('normalQuantile reproduces the published qnorm values', () => {
  assert.ok(Math.abs(normalQuantile(0.975) - 1.959963984540054) < 1e-8, `q97.5 (got ${normalQuantile(0.975)})`)
  assert.ok(Math.abs(normalQuantile(0.95) - 1.6448536269514722) < 1e-8, `q95 (got ${normalQuantile(0.95)})`)
  assert.ok(Math.abs(normalQuantile(0.5)) < 1e-8)
  assert.ok(Math.abs(normalQuantile(0.8) - 0.8416212335729143) < 1e-7, `q80 (got ${normalQuantile(0.8)})`)
})

test('tCdf inverts tQuantile and betainc keeps its closed forms', () => {
  assert.ok(Math.abs(tCdf(tQuantile(0.975, 10), 10) - 0.975) < 1e-10)
  // I_x(1, b) has closed form 1 − (1−x)^b.
  assert.ok(Math.abs(betainc(1, 3, 0.4) - (1 - 0.6 ** 3)) < 1e-12)
  // Symmetry: I_x(a,b) = 1 − I_{1−x}(b,a).
  assert.ok(Math.abs(betainc(2.5, 3.5, 0.3) - (1 - betainc(3.5, 2.5, 0.7))) < 1e-12)
  // Student-t CDF at 0 is exactly 1/2 for any df.
  assert.ok(Math.abs(tCdf(0, 7) - 0.5) < 1e-12)
})

test('OLS solves hand-checked systems and refuses singular designs', () => {
  // y = 2 + 3x on x = 1..4: exact fit with zero residual sigma.
  const X = [[1, 1], [1, 2], [1, 3], [1, 4]]
  const fit = olsFit(X, [5, 8, 11, 14])
  assert.ok(fit !== undefined)
  assert.ok(Math.abs(fit.beta[0] - 2) < 1e-12)
  assert.ok(Math.abs(fit.beta[1] - 3) < 1e-12)
  assert.equal(fit.df, 2)
  assert.ok(Math.abs(fit.rSquared - 1) < 1e-12)
  // Noisy fit refits the slope: y = [5,9,11,13] → beta = [3, 2.6], RSS 1.2, df 2.
  const noisy = olsFit(X, [5, 9, 11, 13])
  assert.ok(noisy !== undefined)
  assert.ok(Math.abs(noisy.beta[1] - 2.6) < 1e-12)
  assert.ok(Math.abs(noisy.sigma - Math.sqrt(0.6)) < 1e-12, `sigma (got ${noisy.sigma})`)
  // The (X'X)⁻¹ diagonal gives the classic slope se sigma/√Sxx = √0.6/√5.
  assert.ok(Math.abs(noisy.se[1] - Math.sqrt(0.6 / 5)) < 1e-12, `slope se (got ${noisy.se[1]})`)
  // A duplicated column is singular: the fit refuses instead of inventing betas.
  assert.equal(olsFit([[1, 1, 1], [1, 2, 2], [1, 3, 3]], [1, 2, 3]), undefined)
  assert.equal(solveLinear([[1, 2], [2, 4]], [1, 2]), undefined)
})

test('solveLinear and invertMatrix round-trip', () => {
  const a = [[4, 1], [1, 3]]
  const inv = invertMatrix(a)
  assert.ok(inv !== undefined)
  const product = a.map((row, i) => Array.from({ length: 2 }, (_, k) => row.reduce((s, v, j) => s + v * (inv[j]?.[k] ?? 0), 0)))
  assert.ok(Math.abs(product[0]?.[0] - 1) < 1e-12 && Math.abs(product[0]?.[1]) < 1e-12, `A·A⁻¹ row 0 (got ${product[0]})`)
  assert.ok(Math.abs(product[1]?.[0]) < 1e-12 && Math.abs(product[1]?.[1] - 1) < 1e-12, `A·A⁻¹ row 1 (got ${product[1]})`)
  // 4x + y = 7 and x + 3y = 8 → x = 13/11, y = 25/11.
  const x = solveLinear(a, [7, 8])
  assert.deepEqual(x?.map(value => Math.round(value * 1e9) / 1e9), [1.181818182, 2.272727273])
})

test('Pearson and Spearman match textbook examples with average-tie ranks', () => {
  // Perfect linear relation.
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [2, 4, 6, 8]) - 1) < 1e-12)
  // Anscombe-style negative example: r = −1 on an exact line.
  assert.ok(Math.abs(pearson([1, 2, 3], [9, 7, 5]) + 1) < 1e-12)
  assert.equal(pearson([3, 3, 3], [1, 2, 3]), undefined, 'a constant side has no correlation')
  // Spearman with ties: (1,2,2,4) ranks to (1, 2.5, 2.5, 4).
  assert.deepEqual(averageRanks([1, 2, 2, 4]), [1, 2.5, 2.5, 4])
  // Classic monotone set: ranks correlate perfectly even non-linearly.
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [1, 4, 9, 16, 25]) - 1) < 1e-12)
})
