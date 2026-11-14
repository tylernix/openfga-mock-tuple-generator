import type { EdgeSettings, Resolved } from './config.js'
import { createEvaluator, TupleIndex } from './evaluate.js'
import { generationOrder, type Compiled, type Edge, type EdgeKind } from './model.js'
import type { Sink } from './output.js'
import { countCdf, describeDist, drawCount, hashString, levelSizes, meanCount, normal, pickDistinct, rngFor, splitByWeights, uuidOf } from './random.js'

/**
 * Builds a store tenant by tenant and streams it out.
 *
 * - Tenant first: every type is split into per-tenant index ranges before any tuple is written, and an
 *   edge picks subjects from its object's own tenant. Types above the tenant, or listed as global, are one
 *   shared pool, generated once before the tenants.
 * - Deterministic per object: each object's draws come from a stream keyed by (seed, edge, object index),
 *   so a tenant generated alone is byte-for-byte its slice of the full store, and changing one edge's
 *   settings changes no other edge's tuples.
 * - Checked, not hoped: nesting depth, cycles, containers and tenant boundaries are re-derived from the
 *   written tuples and reported as violations. Anything clipped or skipped is counted in the report.
 * - Bounded memory: only structure (one container and parent index per object) and the relations that
 *   gates read are kept, per tenant.
 */
export interface Layout {
  tenants: number
  tenantType: string | null
  global: Set<string>
  /** Per type: tenant t owns [bounds[t], bounds[t + 1]). A global type has [0, count]. */
  bounds: Map<string, number[]>
}

export function layout(c: Compiled, r: Resolved): Layout {
  const weights = Array.from({ length: r.tenants }, (_, t) => (t + 1) ** -r.skew)
  const bounds = new Map<string, number[]>()
  for (const type of c.types) {
    if (r.global.has(type)) bounds.set(type, [0, r.counts[type]])
    else if (type === r.plan.type) bounds.set(type, Array.from({ length: r.tenants + 1 }, (_, t) => t))
    else bounds.set(type, splitByWeights(r.counts[type], weights))
  }
  return { tenants: r.tenants, tenantType: r.plan.type, global: r.global, bounds }
}

/** [lo, hi) of a type as seen from a tenant; -1 is the shared block, which sees every object. */
export function rangeOf(lay: Layout, type: string, tenant: number): [number, number] {
  const b = lay.bounds.get(type)!
  return lay.global.has(type) || tenant < 0 ? [0, b[b.length - 1]] : [b[tenant], b[tenant + 1]]
}

/** Only plain subjects on assignments are gated. */
export const isGated = (e: Edge) => !!e.gate && !e.subjectRelation && (e.kind === 'assignment' || e.kind === 'block')

export interface Projection {
  perEdge: Map<string, number>
  perTenant: Float64Array
  shared: number
  total: number
}

/** Expected tuples without generating anything. Gated and nesting edges are upper estimates. */
export function project(c: Compiled, r: Resolved, lay = layout(c, r)): Projection {
  const perEdge = new Map<string, number>()
  const perTenant = new Float64Array(lay.tenants)
  let shared = 0
  for (const e of c.edges) {
    const cfg = r.edges.get(e.key)!
    const fixedMean = cfg.dist.kind === 'share' ? undefined : meanCount(cfg.dist, 0)
    const expected = (tenant: number) => {
      const [olo, ohi] = rangeOf(lay, e.objectType, tenant)
      const [slo, shi] = rangeOf(lay, e.subjectType, tenant)
      const objects = ohi - olo
      const subjects = shi - slo
      if (e.kind === 'nesting') return cfg.depth > 0 ? objects * cfg.coverage : 0
      if (e.kind === 'wildcard') return objects * cfg.coverage
      if (cfg.perLevel) return objects * (cfg.perLevel.reduce((a, b) => a + b, 0) / cfg.perLevel.length)
      if (cfg.per === 'subject') return subjects * cfg.coverage * Math.min(fixedMean ?? meanCount(cfg.dist, objects), objects)
      const reachable = cfg.crossTenant > 0 ? r.counts[e.subjectType] : subjects
      return objects * cfg.coverage * Math.min(fixedMean ?? meanCount(cfg.dist, subjects), reachable)
    }
    let sum = 0
    if (lay.global.has(e.objectType)) {
      sum = expected(-1)
      shared += sum
    } else {
      for (let t = 0; t < lay.tenants; t++) {
        const x = expected(t)
        perTenant[t] += x
        sum += x
      }
    }
    perEdge.set(e.key, sum)
  }
  let total = shared
  for (const x of perTenant) total += x
  return { perEdge, perTenant, shared, total }
}

export interface EdgeReport {
  key: string
  kind: EdgeKind
  tuples: number
  asked: string
  /** Objects the edge could be written on (subjects, when counted per subject). */
  eligible: number
  covered: number
  coverage: number
  per: 'object' | 'subject'
  /** Realized count per covered object (or subject). */
  count?: { p50: number; p90: number; max: number; mean: number }
  /** Kolmogorov-Smirnov distance between realized counts and the asked distribution (0 is a perfect fit). */
  ks?: number
  /** The side that was not asked for: tuples per subject (or per object, when counted per subject). */
  other?: { of: string; pool: number; withAny: number; p50: number; p90: number; max: number; mean: number }
  /** Objects that wanted more subjects than their pool holds. */
  clipped: number
  /** Objects skipped because nobody passed the gate. */
  gateEmpty: number
  crossTenant: number
  duplicatesDropped: number
  /** Nesting only. `containers` counts containers by their deepest object. */
  depth?: { asked: number; max: number; containers: Record<string, number> }
}

export interface Report {
  tuples: number
  tenants: { total: number; generated: number }
  edges: EdgeReport[]
  /** Broken rules. A store with any is not to be used. */
  violations: string[]
  violationCount: number
  warnings: string[]
  elapsedMs: number
  peakRssMb: number
}

export interface GenerateOptions {
  sink: Sink
  /** Only these tenants (plus the shared block). Each is identical to its slice of the full store. */
  tenants?: number[]
  onTenant?: (done: number, total: number) => void
}

interface Stats {
  tuples: number
  eligible: number
  covered: number
  clipped: number
  gateEmpty: number
  cross: number
  dropped: number
  counts: Map<number, number>
  other: Map<number, number>
  otherPool: number
  otherAny: number
  depths: Map<number, number>
  maxDepth: number
}

interface Scope {
  tenant: number
  /** Per container edge: each object's (first) container, by position in the scope's range. */
  containerOf: Map<string, Int32Array>
  /** Per nesting type: each object's level in its tree. */
  levelOf: Map<string, Uint8Array>
  /** Per nesting type: each object's parent (an index of the same type), or -1. */
  parentOf: Map<string, Int32Array>
  /** Tuples of the relations gates read. */
  index: TupleIndex
  family: Map<string, Map<number, Set<number>>>
}

const bump = (hist: Map<number, number>, k: number) => hist.set(k, (hist.get(k) ?? 0) + 1)

function quantiles(hist: Map<number, number>) {
  const keys = [...hist.keys()].sort((a, b) => a - b)
  let total = 0
  let sum = 0
  for (const k of keys) {
    total += hist.get(k)!
    sum += k * hist.get(k)!
  }
  const at = (q: number) => {
    let seen = 0
    for (const k of keys) {
      seen += hist.get(k)!
      if (seen >= q * total) return k
    }
    return 0
  }
  return { p50: at(0.5), p90: at(0.9), max: keys[keys.length - 1] ?? 0, mean: total ? sum / total : 0 }
}

function ksDistance(hist: Map<number, number>, cdf: (k: number) => number): number {
  const keys = [...hist.keys()].sort((a, b) => a - b)
  let total = 0
  for (const k of keys) total += hist.get(k)!
  let seen = 0
  let worst = 0
  for (const k of keys) {
    worst = Math.max(worst, Math.abs(seen / total - cdf(k - 1)))
    seen += hist.get(k)!
    worst = Math.max(worst, Math.abs(seen / total - cdf(k)))
  }
  return worst
}

const MAX_LISTED_VIOLATIONS = 20
/** A subject can be at most this many times as popular as the median one. */
const MAX_POPULARITY_RATIO = 50

export function generate(c: Compiled, r: Resolved, opts: GenerateOptions): Report {
  const started = Date.now()
  const lay = layout(c, r)
  const order = generationOrder(c)
  const isGlobal = (type: string) => lay.global.has(type)
  const typeHash = new Map(c.types.map((t) => [t, hashString(`type:${t}`)]))
  const idOf = r.ids === 'uuid' ? (type: string, i: number) => uuidOf(r.seed, typeHash.get(type)!, i) : (_type: string, i: number) => String(i)
  const retain = new Set(c.edges.filter(isGated).flatMap((e) => e.deps))
  const containerEdges = new Map<string, Edge[]>()
  for (const e of order) if (e.kind === 'container') containerEdges.set(e.objectType, [...(containerEdges.get(e.objectType) ?? []), e])
  const containersOf = (type: string) => containerEdges.get(type) ?? []

  const stats = new Map<string, Stats>(c.edges.map((e) => [e.key, {
    tuples: 0, eligible: 0, covered: 0, clipped: 0, gateEmpty: 0, cross: 0, dropped: 0,
    counts: new Map(), other: new Map(), otherPool: 0, otherAny: 0, depths: new Map(), maxDepth: 0,
  }]))
  const violations: string[] = []
  let violationCount = 0
  const violate = (message: string) => {
    if (violationCount++ < MAX_LISTED_VIOLATIONS) violations.push(message)
  }

  const newScope = (tenant: number): Scope => ({ tenant, containerOf: new Map(), levelOf: new Map(), parentOf: new Map(), index: new TupleIndex(), family: new Map() })
  const shared = newScope(-1)
  const range = (scope: Scope, type: string) => rangeOf(lay, type, scope.tenant)

  const tenantOf = (type: string, i: number) => {
    const b = lay.bounds.get(type)!
    let lo = 0
    let hi = b.length - 2
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (b[mid] <= i) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** The container `e` gave object `i`, or -1. Shared types keep theirs in the shared block. */
  const containerAt = (e: Edge, i: number, current: Scope): number => {
    const scope = isGlobal(e.objectType) ? shared : current
    const arr = scope.containerOf.get(e.key)
    if (!arr) return -1
    const j = i - range(scope, e.objectType)[0]
    return j >= 0 && j < arr.length ? arr[j] : -1
  }

  /** An object's container of type `target`, reached through its other containers (a task's org is its project's org). */
  const ancestorAt = (type: string, i: number, target: string, current: Scope, seen: Set<string>, top = true): number => {
    if (!top) {
      for (const e of containersOf(type)) {
        if (e.subjectType !== target) continue
        const direct = containerAt(e, i, current)
        if (direct >= 0) return direct
      }
    }
    for (const e of containersOf(type)) {
      if (e.subjectType === target || seen.has(e.subjectType)) continue
      const via = containerAt(e, i, current)
      if (via < 0) continue
      seen.add(e.subjectType)
      const up = ancestorAt(e.subjectType, via, target, current, seen, false)
      if (up >= 0) return up
    }
    return -1
  }

  const emit = (scope: Scope, e: Edge, st: Stats, cfg: EdgeSettings, obj: number, subj: number): boolean => {
    if (e.family) {
      let byObject = scope.family.get(e.family)
      if (!byObject) scope.family.set(e.family, (byObject = new Map()))
      let seen = byObject.get(obj)
      if (!seen) byObject.set(obj, (seen = new Set()))
      if (seen.has(subj)) {
        st.dropped++
        return false
      }
      seen.add(subj)
    }
    if (subj >= 0 && lay.tenants > 1 && !isGlobal(e.objectType) && !isGlobal(e.subjectType) && tenantOf(e.objectType, obj) !== tenantOf(e.subjectType, subj)) {
      st.cross++
      if (cfg.crossTenant <= 0) violate(`${e.key}: ${e.objectType}:${obj} and ${e.subjectType}:${subj} are in different tenants`)
    }
    st.tuples++
    if (retain.has(`${e.objectType}#${e.relation}`)) {
      scope.index.add(`${e.subjectType}:${subj < 0 ? '*' : subj}${e.subjectRelation ? `#${e.subjectRelation}` : ''}`, e.relation, `${e.objectType}:${obj}`, !!e.condition)
    }
    opts.sink.write({
      userType: e.subjectType,
      userId: subj < 0 ? '*' : idOf(e.subjectType, subj),
      ...(e.subjectRelation ? { userRelation: e.subjectRelation } : {}),
      relation: e.relation,
      objectType: e.objectType,
      objectId: idOf(e.objectType, obj),
      ...(e.condition ? { condition: e.condition, ...(cfg.context ? { context: cfg.context } : {}) } : {}),
      tenant: scope.tenant,
    })
    return true
  }

  const record = (st: Stats, k: number) => {
    st.covered++
    bump(st.counts, k)
  }

  // Tuples per member of the side that was not asked for. A shared pool is revisited by every tenant, so it is folded once at the end.
  const runWide = new Map<string, Int32Array>()
  const fold = (arr: Int32Array, st: Stats) => {
    st.otherPool += arr.length
    for (const v of arr) {
      if (!v) continue
      st.otherAny++
      bump(st.other, v)
    }
  }
  const tracker = (e: Edge, type: string, scope: Scope, st: Stats) => {
    const [lo, hi] = range(scope, type)
    const wide = scope.tenant >= 0 && isGlobal(type)
    let arr = wide ? runWide.get(e.key) : undefined
    if (!arr) {
      arr = new Int32Array(hi - lo)
      if (wide) runWide.set(e.key, arr)
    }
    const counts = arr
    return {
      add: (i: number) => {
        if (i >= lo && i < hi) counts[i - lo]++
      },
      done: () => {
        if (!wide) fold(counts, st)
      },
    }
  }

  const weights = (e: Edge, cfg: EdgeSettings, lo: number, hi: number) => {
    const cum = new Float64Array(hi - lo + 1)
    const stream = (e.hash ^ 0x632be5ab) >>> 0
    for (let j = 0; j < hi - lo; j++) cum[j + 1] = cum[j] + Math.min(MAX_POPULARITY_RATIO, Math.exp(cfg.popularity * normal(rngFor(r.seed, stream, lo + j))))
    return cum
  }

  const genContainer = (scope: Scope, e: Edge, cfg: EdgeSettings, st: Stats) => {
    const [olo, ohi] = range(scope, e.objectType)
    const [slo, shi] = range(scope, e.subjectType)
    const arr = new Int32Array(ohi - olo).fill(-1)
    scope.containerOf.set(e.key, arr)
    const own = scope.tenant >= 0 && e.subjectType === lay.tenantType
    const derivable = containersOf(e.objectType).some((x) => x.subjectType !== e.subjectType)
    const cum = !own && cfg.popularity > 0 && shi > slo ? weights(e, cfg, slo, shi) : undefined
    // A nested object sits where its parent sits: a subfolder is in its parent's drive. Parents come first in index order.
    const parents = scope.parentOf.get(e.objectType)
    const track = tracker(e, e.subjectType, scope, st)
    st.eligible += ohi - olo
    for (let i = olo; i < ohi; i++) {
      const rand = rngFor(r.seed, e.hash, i)
      const inherited = parents && parents[i - olo] >= 0 ? arr[parents[i - olo] - olo] : -1
      if (inherited < 0 && rand() >= cfg.coverage) continue
      const derived = inherited >= 0 ? inherited : own ? scope.tenant : derivable ? ancestorAt(e.objectType, i, e.subjectType, scope, new Set()) : -1
      let picks: number[]
      if (derived >= 0) picks = [derived]
      else {
        const want = drawCount(cfg.dist, rand, shi - slo)
        if (want > shi - slo) st.clipped++
        picks = pickDistinct(rand, slo, shi, want, cum)
      }
      if (!picks.length) continue
      arr[i - olo] = picks[0]
      record(st, picks.length)
      for (const s of picks) if (emit(scope, e, st, cfg, i, s)) track.add(s)
    }
    track.done()
  }

  const genNesting = (scope: Scope, e: Edge, cfg: EdgeSettings, st: Stats) => {
    const [olo, ohi] = range(scope, e.objectType)
    const n = ohi - olo
    st.eligible += n
    if (cfg.depth <= 0 || !n) return
    // A tree never leaves its container: a folder's parent is a folder of the same organization.
    const boxEdge = containersOf(e.objectType)[0]
    const boxArr = boxEdge ? scope.containerOf.get(boxEdge.key) : undefined
    const boxes = new Map<number, number[]>()
    for (let j = 0; j < n; j++) {
      if (rngFor(r.seed, e.hash, olo + j)() >= cfg.coverage) continue
      const box = boxArr ? boxArr[j] : 0
      const members = boxes.get(box)
      if (members) members.push(j)
      else boxes.set(box, [j])
    }
    const parent = new Int32Array(n).fill(-1)
    const level = scope.levelOf.get(e.objectType) ?? new Uint8Array(n)
    scope.levelOf.set(e.objectType, level)
    const firstTree = !scope.parentOf.has(e.objectType)
    const globalParent = firstTree ? new Int32Array(n).fill(-1) : undefined
    if (globalParent) scope.parentOf.set(e.objectType, globalParent)
    for (const members of boxes.values()) {
      const sizes = levelSizes(members.length, cfg.depth, cfg.branching)
      let start = sizes[0]
      for (let l = 1; l < sizes.length; l++) {
        const above = start - sizes[l - 1]
        for (let m = start; m < start + sizes[l]; m++) {
          const j = members[m]
          const rand = rngFor(r.seed, e.hash, olo + j)
          rand() // the coverage draw
          const p = members[above + Math.floor(rand() * sizes[l - 1])]
          parent[j] = p
          level[j] = l
          if (globalParent) globalParent[j] = olo + p
          // A userset nesting puts the child inside the parent; a parent link points the child at its parent.
          if (e.subjectRelation) emit(scope, e, st, cfg, olo + p, olo + j)
          else emit(scope, e, st, cfg, olo + j, olo + p)
          st.covered++
        }
        start += sizes[l]
      }
    }

    // Re-derive depth, cycles and containers from the parents actually written.
    const depth = new Int32Array(n).fill(-1)
    for (let j = 0; j < n; j++) {
      const chain: number[] = []
      let at = j
      while (at >= 0 && depth[at] === -1) {
        depth[at] = -2
        chain.push(at)
        at = parent[at]
      }
      let base = -1
      if (at >= 0 && depth[at] === -2) violate(`${e.key}: ${e.objectType}:${olo + at} is its own ancestor`)
      else if (at >= 0) base = depth[at]
      for (let k = chain.length - 1; k >= 0; k--) depth[chain[k]] = ++base
    }
    const deepest = new Map<number, number>()
    for (let j = 0; j < n; j++) {
      const box = boxArr ? boxArr[j] : 0
      if (parent[j] >= 0 && boxArr && boxArr[parent[j]] !== box) violate(`${e.key}: ${e.objectType}:${olo + j} and its parent are in different ${boxEdge!.subjectType}s`)
      deepest.set(box, Math.max(deepest.get(box) ?? 0, depth[j]))
    }
    for (const d of deepest.values()) {
      bump(st.depths, d)
      st.maxDepth = Math.max(st.maxDepth, d)
      if (d > cfg.depth) violate(`${e.key}: a tree is ${d} levels deep, over the asked ${cfg.depth}`)
    }
  }

  const genWildcard = (scope: Scope, e: Edge, cfg: EdgeSettings, st: Stats) => {
    const [olo, ohi] = range(scope, e.objectType)
    st.eligible += ohi - olo
    for (let i = olo; i < ohi; i++) {
      if (rngFor(r.seed, e.hash, i)() >= cfg.coverage) continue
      record(st, 1)
      emit(scope, e, st, cfg, i, -1)
    }
  }

  /** An exclusion link (client#deleted: [site]) points at the object's own container of that type. */
  const genAlias = (scope: Scope, e: Edge, cfg: EdgeSettings, st: Stats, link: Edge) => {
    const [olo, ohi] = range(scope, e.objectType)
    st.eligible += ohi - olo
    for (let i = olo; i < ohi; i++) {
      if (rngFor(r.seed, e.hash, i)() >= cfg.coverage) continue
      const container = containerAt(link, i, scope)
      if (container < 0) continue
      record(st, 1)
      emit(scope, e, st, cfg, i, container)
    }
  }

  const genPerObject = (scope: Scope, e: Edge, cfg: EdgeSettings, st: Stats) => {
    const [olo, ohi] = range(scope, e.objectType)
    const [slo, shi] = range(scope, e.subjectType)
    const pool = shi - slo
    const outside = cfg.crossTenant > 0 && scope.tenant >= 0 ? r.counts[e.subjectType] - pool : 0
    const gateNode = isGated(e) ? (e.gate!.length === 1 ? e.gate![0] : { intersection: { child: e.gate } }) : undefined
    const ev = gateNode ? createEvaluator(c.model, [scope.index, shared.index]) : undefined
    const cache = new WeakMap<Set<string>, Int32Array>()
    /** Subjects of the edge's type who pass the gate, inside this tenant, in index order. */
    const candidatesOf = (set: Set<string>): Int32Array => {
      let arr = cache.get(set)
      if (arr) return arr
      const prefix = `${e.subjectType}:`
      const out: number[] = []
      if (set.has(`${prefix}*`)) for (let j = slo; j < shi; j++) out.push(j)
      else {
        for (const s of set) {
          if (!s.startsWith(prefix) || s.includes('#')) continue
          const j = Number(s.slice(prefix.length))
          if (j >= slo && j < shi) out.push(j)
        }
        out.sort((a, b) => a - b)
      }
      arr = Int32Array.from(out)
      cache.set(set, arr)
      return arr
    }
    const cum = !gateNode && cfg.popularity > 0 && pool > 0 ? weights(e, cfg, slo, shi) : undefined
    const levels = cfg.perLevel ? (isGlobal(e.objectType) ? shared : scope).levelOf.get(e.objectType) : undefined
    const track = tracker(e, e.subjectType, scope, st)
    st.eligible += ohi - olo
    for (let i = olo; i < ohi; i++) {
      const rand = rngFor(r.seed, e.hash, i)
      const u = rand()
      let fromLevel: number | undefined
      if (cfg.perLevel) {
        const average = cfg.perLevel[Math.min(levels ? levels[i - olo] : 0, cfg.perLevel.length - 1)]
        fromLevel = Math.floor(average) + (u < average - Math.floor(average) ? 1 : 0)
        if (fromLevel <= 0) continue
      } else if (u >= cfg.coverage) continue
      const candidates = ev ? candidatesOf(ev.evalNode(gateNode, `${e.objectType}:${i}`, e.relation).set) : undefined
      const size = candidates ? candidates.length : pool
      const want = fromLevel ?? drawCount(cfg.dist, rand, size)
      if (want <= 0) continue
      if (candidates && !size) {
        st.gateEmpty++
        continue
      }
      let cross = 0
      if (outside > 0) for (let k = 0; k < want; k++) if (rand() < cfg.crossTenant) cross++
      if (want - cross > size) st.clipped++
      const picks = candidates
        ? pickDistinct(rand, 0, size, want).map((j) => candidates[j])
        : pickDistinct(rand, slo, shi, want - cross, cum)
      if (cross) {
        const guests = new Set<number>()
        const wanted = Math.min(cross, outside)
        while (guests.size < wanted) {
          const x = Math.floor(rand() * outside)
          guests.add(x < slo ? x : x + pool)
        }
        picks.push(...guests)
      }
      if (!picks.length) continue
      record(st, picks.length)
      for (const s of picks) if (emit(scope, e, st, cfg, i, s)) track.add(s)
    }
    track.done()
  }

  const genPerSubject = (scope: Scope, e: Edge, cfg: EdgeSettings, st: Stats) => {
    const [olo, ohi] = range(scope, e.objectType)
    const [slo, shi] = range(scope, e.subjectType)
    const pool = ohi - olo
    const cum = cfg.popularity > 0 && pool > 0 ? weights(e, cfg, olo, ohi) : undefined
    const track = tracker(e, e.objectType, scope, st)
    st.eligible += shi - slo
    for (let j = slo; j < shi; j++) {
      const rand = rngFor(r.seed, e.hash, j)
      if (rand() >= cfg.coverage) continue
      const want = drawCount(cfg.dist, rand, pool)
      if (want > pool) st.clipped++
      const picks = pickDistinct(rand, olo, ohi, want, cum)
      if (!picks.length) continue
      record(st, picks.length)
      for (const o of picks) if (emit(scope, e, st, cfg, o, j)) track.add(o)
    }
    track.done()
  }

  const run = (scope: Scope, e: Edge) => {
    const cfg = r.edges.get(e.key)!
    const st = stats.get(e.key)!
    if (e.kind === 'container') return genContainer(scope, e, cfg, st)
    if (e.kind === 'nesting') return genNesting(scope, e, cfg, st)
    if (e.kind === 'wildcard') return genWildcard(scope, e, cfg, st)
    const link = e.kind === 'block' && e.tupleset ? containersOf(e.objectType).find((x) => x.subjectType === e.subjectType) : undefined
    if (link) return genAlias(scope, e, cfg, st, link)
    return cfg.per === 'subject' ? genPerSubject(scope, e, cfg, st) : genPerObject(scope, e, cfg, st)
  }

  /** Every container a nested object and its parent both have must be the same one. */
  const checkContainers = (scope: Scope) => {
    for (const [type, parents] of scope.parentOf) {
      const lo = range(scope, type)[0]
      for (const link of containersOf(type)) {
        const arr = scope.containerOf.get(link.key)
        if (!arr) continue
        for (let j = 0; j < parents.length; j++) {
          if (parents[j] < 0 || arr[j] < 0 || arr[parents[j] - lo] < 0 || arr[j] === arr[parents[j] - lo]) continue
          violate(`${link.key}: ${type}:${lo + j} and its parent are in different ${link.subjectType}s`)
        }
      }
    }
  }

  for (const e of order) if (isGlobal(e.objectType)) run(shared, e)
  checkContainers(shared)
  const tenantEdges = order.filter((e) => !isGlobal(e.objectType))
  const chosen = opts.tenants ?? Array.from({ length: lay.tenants }, (_, t) => t)
  for (const t of chosen) if (!Number.isInteger(t) || t < 0 || t >= lay.tenants) throw new Error(`tenant ${t} is out of range (0 to ${lay.tenants - 1})`)
  chosen.forEach((t, done) => {
    const scope = newScope(t)
    for (const e of tenantEdges) run(scope, e)
    checkContainers(scope)
    opts.onTenant?.(done + 1, chosen.length)
  })
  for (const [key, arr] of runWide) fold(arr, stats.get(key)!)

  const warnings = [...r.warnings]
  const edges: EdgeReport[] = c.edges.map((e) => {
    const cfg = r.edges.get(e.key)!
    const st = stats.get(e.key)!
    const perSubject = cfg.per === 'subject' && (e.kind === 'assignment' || e.kind === 'block')
    const asked = e.kind === 'nesting' ? `depth ${cfg.depth}${cfg.branching ? `, branching ${cfg.branching}` : ''}, ${Math.round(cfg.coverage * 100)}% nested`
      : e.kind === 'wildcard' ? `${(cfg.coverage * 100).toFixed(1)}% public`
      : cfg.perLevel ? `per level ${cfg.perLevel.join(' / ')}`
      : `${describeDist(cfg.dist)} per ${perSubject ? e.subjectType : e.objectType}, ${Math.round(cfg.coverage * 100)}% covered`
    const cdf = e.kind !== 'nesting' && e.kind !== 'wildcard' && !cfg.perLevel && !isGated(e) ? countCdf(cfg.dist) : undefined
    const ks = cdf && st.covered ? ksDistance(st.counts, cdf) : undefined
    // Off target beyond what the number of objects explains (99% Kolmogorov-Smirnov bound).
    if (ks !== undefined && ks > Math.max(0.1, 1.63 / Math.sqrt(st.covered))) warnings.push(`${e.key}: realized counts are off the asked spread (KS ${ks.toFixed(2)}); ${st.clipped} wanted more than their pool holds.`)
    if (st.gateEmpty) warnings.push(`${e.key}: ${st.gateEmpty} ${e.objectType}(s) skipped because nobody passed the gate.`)
    if (st.dropped) warnings.push(`${e.key}: ${st.dropped} tuple(s) dropped because another edge already wrote the same subject on the same object.`)
    const shallow = [...st.depths].filter(([d]) => d < cfg.depth).reduce((sum, [, count]) => sum + count, 0)
    if (e.kind === 'nesting' && shallow) warnings.push(`${e.key}: ${shallow} container(s) are shallower than the asked depth ${cfg.depth} because they hold too few nested ${e.objectType}s.`)
    return {
      key: e.key,
      kind: e.kind,
      tuples: st.tuples,
      asked,
      eligible: st.eligible,
      covered: st.covered,
      coverage: st.eligible ? st.covered / st.eligible : 0,
      per: perSubject ? 'subject' : 'object',
      ...(st.counts.size ? { count: quantiles(st.counts) } : {}),
      ...(ks !== undefined ? { ks } : {}),
      ...(st.otherPool ? { other: { of: perSubject ? e.objectType : e.subjectType, pool: st.otherPool, withAny: st.otherAny, ...quantiles(st.other) } } : {}),
      clipped: st.clipped,
      gateEmpty: st.gateEmpty,
      crossTenant: st.cross,
      duplicatesDropped: st.dropped,
      ...(e.kind === 'nesting' ? { depth: { asked: cfg.depth, max: st.maxDepth, containers: Object.fromEntries([...st.depths].sort((a, b) => a[0] - b[0])) } } : {}),
    }
  })
  return {
    tuples: edges.reduce((sum, e) => sum + e.tuples, 0),
    tenants: { total: lay.tenants, generated: chosen.length },
    edges,
    violations,
    violationCount,
    warnings,
    elapsedMs: Date.now() - started,
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
  }
}
