/**
 * The small numeric kernel every decision computation shares: deterministic
 * ordinary least squares via normal equations with partial-pivot solving, the
 * regularized incomplete beta function and the Student-t / normal quantiles
 * the effect and forecast intervals need, Pearson and Spearman correlation,
 * and average-tie ranking. Dimensions stay tiny (≤ 9 regressor columns), so
 * dense normal equations are exact enough and every fixture can pin answers
 * against published quantile values.
 *
 * @module @map-harness/spatial-decision/linalg
 */

/** One fitted OLS regression: coefficients, their standard errors, and fit quality. */
export interface OlsFit {
  /** Coefficients, one per design column (the first column is the intercept when included). */
  readonly beta: readonly number[]
  /** (XᵀX)⁻¹, kept for the prediction-variance formula of new rows. */
  readonly xtxInv: readonly (readonly number[])[]
  /** Residual standard deviation sqrt(RSS / df); 0 when df is 0. */
  readonly sigma: number
  /** Residual degrees of freedom n − p. */
  readonly df: number
  /** Fitted values over the design rows. */
  readonly fitted: readonly number[]
  /** Coefficient standard errors (0 for a singular column). */
  readonly se: readonly number[]
  /** Coefficient of determination against the intercept-only model. */
  readonly rSquared: number
}

/** Drop rows any of the read columns left undefined or non-numeric. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Solve the linear system `a · x = b` by Gaussian elimination with partial
 * pivoting. A singular system returns `undefined`; callers refuse honestly
 * instead of inventing coefficients.
 * @param a - the square coefficient matrix (consumed copy).
 * @param b - the right-hand side.
 * @returns the solution vector, or `undefined` for a singular system.
 */
export function solveLinear(a: readonly (readonly number[])[], b: readonly number[]): number[] | undefined {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i] as number])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = row
    }
    const pivotRow = m[pivot]
    const current = m[col]
    if (pivotRow === undefined || current === undefined) return undefined
    if (Math.abs(pivotRow[col] ?? 0) < 1e-12) return undefined
    if (pivot !== col) {
      m[pivot] = current
      m[col] = pivotRow
    }
    for (let row = col + 1; row < n; row++) {
      const target = m[row]
      if (target === undefined) continue
      const factor = (target[col] ?? 0) / (pivotRow[col] ?? 1)
      for (let k = col; k <= n; k++) {
        target[k] = (target[k] ?? 0) - factor * (pivotRow[k] ?? 0)
      }
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    const source = m[row]
    if (source === undefined) return undefined
    let sum = source[n] ?? 0
    for (let k = row + 1; k < n; k++) sum -= (source[k] ?? 0) * (x[k] ?? 0)
    x[row] = sum / (source[row] ?? 1)
  }
  return x
}

/**
 * Invert one small square matrix by Gauss–Jordan elimination.
 * @returns the inverse, or `undefined` for a singular matrix.
 */
export function invertMatrix(a: readonly (readonly number[])[]): number[][] | undefined {
  const n = a.length
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row]?.[col] ?? 0) > Math.abs(m[pivot]?.[col] ?? 0)) pivot = row
    }
    if (pivot !== col) {
      const moved = m[pivot]
      const displaced = m[col]
      if (moved === undefined || displaced === undefined) return undefined
      m[pivot] = displaced
      m[col] = moved
    }
    const pivotRow = m[col]
    if (pivotRow === undefined) return undefined
    const pivotValue = pivotRow[col] ?? 0
    if (Math.abs(pivotValue) < 1e-12) return undefined
    for (let k = 0; k < 2 * n; k++) {
      pivotRow[k] = (pivotRow[k] ?? 0) / pivotValue
    }
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const target = m[row]
      if (target === undefined) continue
      const factor = target[col] ?? 0
      if (factor === 0) continue
      for (let k = 0; k < 2 * n; k++) {
        target[k] = (target[k] ?? 0) - factor * (pivotRow[k] ?? 0)
      }
    }
  }
  return m.map(row => (row ?? []).slice(n))
}

/**
 * Fit ordinary least squares of `y` on the design matrix `X` (rows in the
 * same order). The intercept-only guard is the caller's: a design with zero
 * columns is refused.
 * @param X - the n×p design matrix.
 * @param y - the response vector.
 * @returns the fit, or `undefined` when the normal equations are singular.
 */
export function olsFit(X: readonly (readonly number[])[], y: readonly number[]): OlsFit | undefined {
  const n = y.length
  const p = X[0]?.length ?? 0
  if (n === 0 || p === 0) return undefined
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0))
  const xty: number[] = new Array<number>(p).fill(0)
  for (let i = 0; i < n; i++) {
    const row = X[i]
    if (row === undefined) return undefined
    for (let a = 0; a < p; a++) {
      xty[a] = (xty[a] ?? 0) + (row[a] ?? 0) * (y[i] ?? 0)
      for (let b = a; b < p; b++) {
        const value = (row[a] ?? 0) * (row[b] ?? 0)
        xtx[a]![b] = (xtx[a]?.[b] ?? 0) + value
        if (a !== b) xtx[b]![a] = (xtx[b]?.[a] ?? 0) + value
      }
    }
  }
  const xtxInv = invertMatrix(xtx)
  if (xtxInv === undefined) return undefined
  const beta = solveLinear(xtx, xty)
  if (beta === undefined) return undefined
  const fitted = X.map(row => row.reduce((sum, value, col) => sum + value * (beta[col] ?? 0), 0))
  const mean = y.reduce((sum, value) => sum + value, 0) / n
  let rss = 0
  let tss = 0
  for (let i = 0; i < n; i++) {
    rss += ((y[i] ?? 0) - (fitted[i] ?? 0)) ** 2
    tss += ((y[i] ?? 0) - mean) ** 2
  }
  const df = n - p
  const sigma2 = df > 0 ? rss / df : 0
  const se = beta.map((_, col) => Math.sqrt(Math.max(0, sigma2 * (xtxInv[col]?.[col] ?? 0))))
  return {
    beta,
    xtxInv,
    sigma: Math.sqrt(sigma2),
    df,
    fitted,
    se,
    rSquared: tss > 0 ? 1 - rss / tss : 0,
  }
}

/** The regularized incomplete beta function I_x(a, b) by the continued fraction (Numerical Recipes form). */
export function betainc(a: number, b: number, x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lbeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const bt = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta)
  if (x < (a + 1) / (a + b + 2)) {
    return bt * betacf(a, b, x) / a
  }
  return 1 - bt * betacf(b, a, 1 - x) / b
}

/** The continued-fraction evaluation the incomplete beta function uses (Lentz). */
function betacf(a: number, b: number, x: number): number {
  const MAX_ITER = 200
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - qab * x / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAX_ITER; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < EPS) break
  }
  return h
}

/** The natural log of the gamma function (Lanczos, g=7, n=9). */
export function logGamma(z: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ]
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z)
  }
  z -= 1
  let x = g[0] ?? 0
  for (let i = 1; i < 9; i++) {
    x += (g[i] ?? 0) / (z + i)
  }
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

/** The Student-t CDF at `t` with `df` degrees of freedom. */
export function tCdf(t: number, df: number): number {
  const x = df / (df + t * t)
  const tail = 0.5 * betainc(df / 2, 0.5, x)
  return t > 0 ? 1 - tail : tail
}

/**
 * The Student-t quantile at probability `p` for `df` degrees of freedom,
 * by bisection on the CDF (60 iterations bound the answer to ~1e-12).
 * @param p - the probability in (0, 1).
 * @param df - positive degrees of freedom.
 * @returns the quantile value.
 */
export function tQuantile(p: number, df: number): number {
  let lo = -1e4
  let hi = 1e4
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (tCdf(mid, df) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The standard-normal quantile at probability `p` (Acklam's rational
 * approximation, ~1.2e-9 relative accuracy, pinned against published values
 * by fixture).
 * @param p - the probability in (0, 1).
 * @returns the quantile value.
 */
export function normalQuantile(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  if (p < pLow || p > 1 - pLow) {
    const q = Math.sqrt(p < pLow ? -2 * Math.log(p) : -2 * Math.log(1 - p))
    const numerator = ((((c[0] ?? 0) * q + (c[1] ?? 0)) * q + (c[2] ?? 0)) * q + (c[3] ?? 0)) * q + (c[4] ?? 0)
    const numerator2 = numerator * q + (c[5] ?? 0)
    const denominator = ((((d[0] ?? 0) * q + (d[1] ?? 0)) * q + (d[2] ?? 0)) * q + (d[3] ?? 0)) * q + 1
    const value = numerator2 / denominator
    return p < pLow ? value : -value
  }
  const q = p - 0.5
  const r = q * q
  const numerator = (((((a[0] ?? 0) * r + (a[1] ?? 0)) * r + (a[2] ?? 0)) * r + (a[3] ?? 0)) * r + (a[4] ?? 0)) * r + (a[5] ?? 0)
  const denominator = (((((b[0] ?? 0) * r + (b[1] ?? 0)) * r + (b[2] ?? 0)) * r + (b[3] ?? 0)) * r + (b[4] ?? 0)) * r + 1
  return numerator * q / denominator
}

/** The Pearson correlation of two equal-length samples; `undefined` when either side is constant. */
export function pearson(x: readonly number[], y: readonly number[]): number | undefined {
  const n = x.length
  const mx = x.reduce((s, v) => s + v, 0) / n
  const my = y.reduce((s, v) => s + v, 0) / n
  let sxy = 0
  let sxx = 0
  let syy = 0
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - mx
    const dy = (y[i] ?? 0) - my
    sxy += dx * dy
    sxx += dx * dx
    syy += dy * dy
  }
  if (sxx === 0 || syy === 0) return undefined
  return sxy / Math.sqrt(sxx * syy)
}

/**
 * Average-tie ranks of one sample (rank 1 = smallest).
 * @returns the ranks in input order.
 */
export function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
  const ranks = new Array<number>(values.length).fill(0)
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && (order[j + 1]?.value ?? 0) === (order[i]?.value ?? 0)) j++
    const rank = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) {
      ranks[order[k]?.index ?? 0] = rank
    }
    i = j + 1
  }
  return ranks
}

/** The Spearman rank correlation of two samples; `undefined` when either side is constant. */
export function spearman(x: readonly number[], y: readonly number[]): number | undefined {
  return pearson(averageRanks(x), averageRanks(y))
}
