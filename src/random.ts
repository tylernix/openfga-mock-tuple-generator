/**
 * Deterministic draws. Every draw comes from a stream keyed by (seed, edge, object index), so an
 * object's tuples depend only on its own inputs: not on generation order, and not on other edges.
 */

/** FNV-1a. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const mix = (h: number) => {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** An independent stream (sfc32) for one (seed, stream, index). */
export function rngFor(seed: number, stream: number, index: number): () => number {
  let a = mix(seed ^ 0x9e3779b9)
  let b = mix(stream + 0x7f4a7c15)
  let c = mix((index >>> 0) ^ 0x2545f491)
  let d = mix(Math.floor(index / 4294967296) + 1)
  const next = () => {
    const t = (((a + b) | 0) + d) | 0
    d = (d + 1) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  for (let i = 0; i < 12; i++) next()
  return next
}

export const normal = (rand: () => number) => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())

/** Standard normal CDF (Abramowitz-Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * x)
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2
}

/** Standard normal quantile (Acklam). */
export function normalQuantile(p: number): number {
  const q = Math.min(1 - 1e-12, Math.max(1e-12, p))
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (q < lo || q > 1 - lo) {
    const r = Math.sqrt(-2 * Math.log(q < lo ? q : 1 - q))
    const x = (((((c[0] * r + c[1]) * r + c[2]) * r + c[3]) * r + c[4]) * r + c[5]) / ((((d[0] * r + d[1]) * r + d[2]) * r + d[3]) * r + 1)
    return q < lo ? x : -x
  }
  const r = q - 0.5
  const s = r * r
  return ((((((a[0] * s + a[1]) * s + a[2]) * s + a[3]) * s + a[4]) * s + a[5]) * r) / (((((b[0] * s + b[1]) * s + b[2]) * s + b[3]) * s + b[4]) * s + 1)
}

/** How many subjects an object gets, once it gets any. */
export type Dist =
  | { kind: 'fixed'; n: number }
  | { kind: 'uniform'; min: number; max: number }
  | { kind: 'lognormal'; median: number; sigma: number; max: number }
  /** A share of the pool the object picks from (0 to 1). */
  | { kind: 'share'; share: number }

const lognormalAt = (d: Extract<Dist, { kind: 'lognormal' }>, z: number) => Math.max(1, Math.min(d.max, Math.round(d.median * Math.exp(d.sigma * z))))

export function drawCount(d: Dist, rand: () => number, pool: number): number {
  if (d.kind === 'fixed') {
    const whole = Math.floor(d.n)
    return whole + (rand() < d.n - whole ? 1 : 0)
  }
  if (d.kind === 'uniform') return d.min + Math.floor(rand() * (d.max - d.min + 1))
  if (d.kind === 'lognormal') return lognormalAt(d, normal(rand))
  return pool > 0 ? Math.max(1, Math.round(d.share * pool)) : 0
}

export function meanCount(d: Dist, pool: number): number {
  if (d.kind === 'fixed') return d.n
  if (d.kind === 'uniform') return (d.min + d.max) / 2
  if (d.kind === 'share') return pool > 0 ? Math.max(1, Math.round(d.share * pool)) : 0
  let sum = 0
  for (let i = 0; i < 400; i++) sum += lognormalAt(d, normalQuantile((i + 0.5) / 400))
  return sum / 400
}

/** P(count <= k) for a count drawn with no pool limit; undefined when the count depends on the pool. */
export function countCdf(d: Dist): ((k: number) => number) | undefined {
  if (d.kind === 'share') return undefined
  if (d.kind === 'fixed') {
    const whole = Math.floor(d.n)
    return (k) => (k >= Math.ceil(d.n) ? 1 : k >= whole ? 1 - (d.n - whole) : 0)
  }
  if (d.kind === 'uniform') return (k) => Math.min(1, Math.max(0, (Math.floor(k) - d.min + 1) / (d.max - d.min + 1)))
  return (k) => {
    if (k < 1) return 0
    if (k >= d.max) return 1
    return d.sigma > 0 ? normalCdf(Math.log((k + 0.5) / d.median) / d.sigma) : k + 0.5 >= d.median ? 1 : 0
  }
}

export function describeDist(d: Dist): string {
  if (d.kind === 'fixed') return `${d.n}`
  if (d.kind === 'uniform') return `${d.min} to ${d.max}`
  if (d.kind === 'share') return `${Math.round(d.share * 100)}% of the pool`
  return `typical ${d.median}, p90 ${Math.round(d.median * Math.exp(1.2816 * d.sigma))}, max ${d.max}`
}

function search(cum: Float64Array, u: number): number {
  let lo = 0
  let hi = cum.length - 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cum[mid + 1] <= u) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * `k` distinct indexes from [lo, hi). `cum` (cumulative weights over the pool, length pool + 1) picks
 * unevenly. Every path is exact: there is no fallback that changes the distribution.
 */
export function pickDistinct(rand: () => number, lo: number, hi: number, k: number, cum?: Float64Array): number[] {
  const n = hi - lo
  if (k <= 0 || n <= 0) return []
  if (k >= n) return Array.from({ length: n }, (_, j) => lo + j)
  const seen = new Set<number>()
  if (!cum) {
    if (k * 2 >= n) {
      const all = new Int32Array(n)
      for (let j = 0; j < n; j++) all[j] = lo + j
      for (let j = 0; j < k; j++) {
        const r = j + Math.floor(rand() * (n - j))
        const swap = all[j]
        all[j] = all[r]
        all[r] = swap
      }
      return Array.from(all.subarray(0, k))
    }
    while (seen.size < k) seen.add(lo + Math.floor(rand() * n))
    return [...seen]
  }
  for (let tries = 4 * k + 32; seen.size < k && tries > 0; tries--) seen.add(lo + search(cum, rand() * cum[n]))
  if (seen.size < k) {
    // Redrawing stalls when a few weights dominate. Exponential clocks give the same distribution in one pass.
    const keys: [number, number][] = []
    for (let j = 0; j < n; j++) if (!seen.has(lo + j)) keys.push([-Math.log(1 - rand()) / (cum[j + 1] - cum[j]), lo + j])
    keys.sort((x, y) => x[0] - y[0])
    for (let j = 0; seen.size < k; j++) seen.add(keys[j][1])
  }
  return [...seen]
}

/** Splits `total` over the weights (largest remainder); returns offsets, length weights + 1. */
export function splitByWeights(total: number, weights: number[], atLeast = 0): number[] {
  const floor = Math.min(atLeast, Math.floor(total / Math.max(1, weights.length)))
  const rest = total - floor * weights.length
  const sum = weights.reduce((x, y) => x + y, 0)
  const exact = weights.map((w) => (sum > 0 ? (rest * w) / sum : rest / weights.length))
  const sizes = exact.map(Math.floor)
  let left = rest - sizes.reduce((x, y) => x + y, 0)
  const byFraction = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((x, y) => y[0] - x[0] || x[1] - y[1])
  for (const [, i] of byFraction) if (left-- > 0) sizes[i]++
  const out = [0]
  for (const s of sizes) out.push(out[out.length - 1] + s + floor)
  return out
}

/**
 * Objects per level of one tree, top first, for `m` objects and at most `depth` levels below the top.
 * Every level holds at least one object, so the tree is exactly min(depth, m - 1) deep.
 * Without `branching` the tree has one top; with it, level sizes grow by that factor and the top may hold several.
 */
export function levelSizes(m: number, depth: number, branching?: number): number[] {
  const d = Math.min(depth, m - 1)
  if (d <= 0) return [m]
  if (branching) {
    const offsets = splitByWeights(m, Array.from({ length: d + 1 }, (_, l) => branching ** l), 1)
    return offsets.slice(1).map((end, i) => end - offsets[i])
  }
  let lo = 1
  let hi = Math.max(2, m)
  const below = (r: number) => {
    let sum = 0
    for (let l = 1; l <= d; l++) sum += r ** l
    return sum
  }
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (below(mid) < m - 1) lo = mid
    else hi = mid
  }
  const offsets = splitByWeights(m - 1, Array.from({ length: d }, (_, l) => hi ** (l + 1)), 1)
  return [1, ...offsets.slice(1).map((end, i) => end - offsets[i])]
}

/** A stable UUID (version 4 layout) for one object. */
export function uuidOf(seed: number, stream: number, index: number): string {
  const rand = rngFor(seed ^ 0x1b873593, stream, index)
  let h = ''
  for (let i = 0; i < 4; i++) h += Math.floor(rand() * 4294967296).toString(16).padStart(8, '0')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`
}
