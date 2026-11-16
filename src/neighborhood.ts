import type { Resolved } from './config.js'
import { generate } from './generate.js'
import type { Compiled } from './model.js'
import { memorySink } from './output.js'

export interface HoodNode {
  id: string
  type: string
  /** Steps from the root. */
  hop: number
}

export interface HoodEdge {
  from: string
  to: string
  relation: string
}

export interface Neighborhood {
  tenant: number
  root: string
  hops: number
  nodes: HoodNode[]
  edges: HoodEdge[]
  /** True when neighbors were left out to keep the picture readable. */
  capped: boolean
}

const HOPS = 2
/** The sample builds one tenant and the shared block in memory, so a huge one is skipped. */
const MAX_SAMPLE_TUPLES = 300_000

/** The index of a middle-sized tenant, by tuples. */
export function medianTenant(sizes: ArrayLike<number>): number {
  return Array.from({ length: sizes.length }, (_, t) => t).sort((a, b) => sizes[a] - sizes[b] || a - b)[Math.floor(sizes.length / 2)] ?? 0
}

/** Why a sample is not drawn, or undefined when it is cheap enough. */
export function sampleSkipReason(tenantTuples: number, sharedTuples: number): string | undefined {
  const total = Math.round(tenantTuples + sharedTuples)
  return total > MAX_SAMPLE_TUPLES
    ? `No sample drawn: a middle-sized tenant plus the shared block is about ${total.toLocaleString('en-US')} tuples, more than the ${MAX_SAMPLE_TUPLES.toLocaleString('en-US')} this page builds in memory for a picture.`
    : undefined
}
const MAX_NODES = 120
/** Neighbors taken per node: the root shows more than the nodes around it, which would otherwise crowd it out. */
const PER_NODE = [40, 8]
const MAX_EDGES = 400

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A small piece of the store drawn from one tenant: a seeded random object of the type with the most tuples,
 * and what is connected to it within two steps. The same config and tenant always give the same piece.
 */
export function neighborhood(c: Compiled, r: Resolved, tenant: number): Neighborhood | undefined {
  const sink = memorySink()
  generate(c, r, { sink, tenants: [tenant] })
  const tuples = sink.tuples
  if (!tuples.length) return undefined

  const nodeOf = (type: string, id: string) => `${type}:${id}`
  const adjacent = new Map<string, { to: string; relation: string }[]>()
  const link = (a: string, b: string, relation: string) => {
    let list = adjacent.get(a)
    if (!list) adjacent.set(a, (list = []))
    list.push({ to: b, relation })
  }
  const asObject = new Map<string, Map<string, number>>()
  for (const t of tuples) {
    const from = nodeOf(t.userType, t.userId)
    const to = nodeOf(t.objectType, t.objectId)
    link(from, to, t.relation)
    link(to, from, t.relation)
    let ids = asObject.get(t.objectType)
    if (!ids) asObject.set(t.objectType, (ids = new Map()))
    ids.set(to, (ids.get(to) ?? 0) + 1)
  }

  const busiest = [...asObject.entries()].sort((a, b) => [...b[1].values()].reduce((s, n) => s + n, 0) - [...a[1].values()].reduce((s, n) => s + n, 0))[0][1]
  const candidates = [...busiest.keys()]
  const root = candidates[Math.floor(mulberry32(r.seed ^ Math.imul(tenant + 1, 2654435761))() * candidates.length)]

  const hop = new Map<string, number>([[root, 0]])
  let capped = false
  let frontier = [root]
  for (let h = 0; h < HOPS; h++) {
    const next: string[] = []
    for (const node of frontier) {
      let taken = 0
      for (const { to } of adjacent.get(node) ?? []) {
        if (hop.has(to)) continue
        if (taken >= PER_NODE[h] || hop.size >= MAX_NODES) {
          capped = true
          continue
        }
        hop.set(to, h + 1)
        next.push(to)
        taken++
      }
    }
    frontier = next
  }

  const edges: HoodEdge[] = []
  const seen = new Set<string>()
  for (const t of tuples) {
    const from = nodeOf(t.userType, t.userId)
    const to = nodeOf(t.objectType, t.objectId)
    if (!hop.has(from) || !hop.has(to)) continue
    const key = `${from}|${t.relation}|${to}`
    if (seen.has(key)) continue
    seen.add(key)
    if (edges.length >= MAX_EDGES) {
      capped = true
      break
    }
    edges.push({ from, to, relation: t.relation })
  }

  const nodes = [...hop.entries()].map(([id, h]) => ({ id, type: id.slice(0, id.indexOf(':')), hop: h }))
  return { tenant, root, hops: HOPS, nodes, edges, capped }
}
