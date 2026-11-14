import { edgeQuestion, type Compiled, type Edge, type EdgeKind } from './model.js'
import type { Dist } from './random.js'
import { suggestTenant, tenantPlan, type TenantPlan } from './tenants.js'

/** How many subjects an object gets: a number, a range, a skewed spread, or a share of the pool. */
export type CountInput = number | { min: number; max: number } | { typical: number; p90: number; max: number } | { share: number }

export interface EdgeInput {
  /** Written by `init` for the reader; ignored. */
  question?: string
  kind?: string
  /** Share of objects that get any (0 to 1). */
  coverage?: number
  count?: CountInput
  /** Which side `count` describes: subjects per object (default), or objects per subject ("groups per user"). */
  per?: 'object' | 'subject'
  /** How unevenly subjects are picked: 0 is even; 1 makes a few subjects several times as popular. */
  popularity?: number
  /** Share of this edge's picks that come from another tenant (guests). Default 0. */
  crossTenant?: number
  /** Nesting: levels below a top-level object. A hard limit. */
  depth?: number
  /** Nesting: how many times larger each level is than the one above. Omit for one top per container. */
  branching?: number
  /** Average subjects per object on each nesting level, top first. Replaces coverage and count. */
  perLevel?: number[]
  /** Condition context written on every tuple of a conditioned edge. */
  context?: Record<string, unknown>
}

export interface Config {
  model: string
  seed?: number
  ids?: 'index' | 'uuid'
  tenant?: { type?: string | null; count?: number; skew?: number }
  /** Types that are one pool shared by every tenant. */
  global?: string[]
  counts: Record<string, number>
  edges?: Record<string, EdgeInput>
}

export interface EdgeSettings {
  coverage: number
  dist: Dist
  per: 'object' | 'subject'
  popularity: number
  crossTenant: number
  depth: number
  branching?: number
  perLevel?: number[]
  context?: Record<string, unknown>
}

export interface Resolved {
  seed: number
  ids: 'index' | 'uuid'
  tenants: number
  skew: number
  global: Set<string>
  counts: Record<string, number>
  edges: Map<string, EdgeSettings>
  plan: TenantPlan
  warnings: string[]
}

const FIELDS: Record<EdgeKind, (keyof EdgeInput)[]> = {
  container: ['coverage', 'count', 'popularity'],
  nesting: ['coverage', 'depth', 'branching'],
  wildcard: ['coverage'],
  assignment: ['coverage', 'count', 'per', 'popularity', 'crossTenant', 'perLevel', 'context'],
  block: ['coverage', 'count', 'per', 'popularity', 'crossTenant', 'perLevel', 'context'],
}

/** Relations written as usersets somewhere (`group#member`): their direct edges are memberships. */
const usersetRelations = (c: Compiled) => new Set(c.edges.filter((e) => e.subjectRelation).map((e) => `${e.subjectType}#${e.subjectRelation}`))

/** A starting point per edge. These are guesses, written into the config so they are seen and changed. */
export function defaultEdge(c: Compiled, e: Edge, tenantType: string | null): EdgeInput {
  if (e.kind === 'container') return { coverage: 1, count: 1 }
  if (e.kind === 'nesting') return { coverage: e.tupleset ? 0.9 : 0.3, depth: 3 }
  if (e.kind === 'wildcard') return { coverage: 0.02 }
  if (e.kind === 'block') return e.tupleset ? { coverage: 0.1, count: 1 } : { coverage: 0.1, count: { min: 1, max: 2 } }
  if (e.subjectRelation) return { coverage: 0.3, count: { min: 1, max: 3 } }
  if (e.objectType === tenantType && /(^|_)(member|user)s?$/i.test(e.relation)) return { coverage: 1, count: { share: 1 } }
  if (usersetRelations(c).has(`${e.objectType}#${e.relation}`)) return { coverage: 1, count: { typical: 8, p90: 40, max: 2000 } }
  return { coverage: 0.5, count: { typical: 2, p90: 6, max: 100 } }
}

export function defaultCount(c: Compiled, type: string, tenantType: string | null): number {
  if (type === tenantType) return 100
  if (c.principals.includes(type)) return 10_000
  const contains = [...c.containers.values()].some((list) => list.includes(type))
  const groupLike = c.edges.some((e) => e.subjectRelation && e.subjectType === type)
  return contains || groupLike ? 1_000 : 100_000
}

/** A complete config for a model: every type and edge, with defaults and the question each edge answers. */
export function defaultConfig(c: Compiled, modelPath: string): Config & { _help: string[] } {
  const tenant = suggestTenant(c)
  return {
    _help: [
      'counts: how many objects of each type exist in the whole store.',
      `tenant: ${tenant.reason}. Every type is split per tenant unless listed in "global". skew 0 makes tenants equal; 1 makes the largest far bigger than the typical one.`,
      'edges: one entry per way a tuple can be written. coverage is the share of objects that get any (0 to 1).',
      'count is how many each gets: a number, {"min","max"}, {"typical","p90","max"} or {"share"} of the pool.',
      'per: "subject" makes count mean objects per subject ("groups per user"). crossTenant is the share of picks from another tenant.',
      'Nesting edges take depth (a hard limit on levels below the top) and optionally branching.',
    ],
    model: modelPath,
    seed: 1,
    ids: 'index',
    tenant: { type: tenant.type, ...(tenant.type ? {} : { count: 1 }), skew: 1 },
    global: [],
    counts: Object.fromEntries(c.types.map((t) => [t, defaultCount(c, t, tenant.type)])),
    edges: Object.fromEntries(c.edges.map((e) => [e.key, { question: edgeQuestion(e), kind: e.kind, ...defaultEdge(c, e, tenant.type) }])),
  }
}

function toDist(count: CountInput, where: string, problems: string[]): Dist {
  const bad = (why: string): Dist => {
    problems.push(`${where}.count ${why}`)
    return { kind: 'fixed', n: 1 }
  }
  if (typeof count === 'number') return Number.isFinite(count) && count >= 0 ? { kind: 'fixed', n: count } : bad('must be a number >= 0')
  if (!count || typeof count !== 'object') return bad('must be a number or an object')
  if ('share' in count) return count.share > 0 && count.share <= 1 ? { kind: 'share', share: count.share } : bad('share must be above 0 and at most 1')
  if ('typical' in count) {
    const { typical, p90, max } = count
    if (!(typical >= 1 && p90 >= typical && max >= p90)) return bad('needs 1 <= typical <= p90 <= max')
    return { kind: 'lognormal', median: typical, sigma: Math.log(p90 / typical) / 1.2816, max: Math.round(max) }
  }
  if ('min' in count) {
    if (!(Number.isInteger(count.min) && Number.isInteger(count.max) && count.min >= 0 && count.max >= count.min)) return bad('needs whole numbers with 0 <= min <= max')
    return { kind: 'uniform', min: count.min, max: count.max }
  }
  return bad('is not a number, {min,max}, {typical,p90,max} or {share}')
}

/** Validates a config against its model and fills in defaults. Throws one error listing every problem. */
export function resolve(c: Compiled, cfg: Config): Resolved {
  const problems: string[] = []
  const warnings: string[] = []
  const counts: Record<string, number> = {}
  for (const type of c.types) {
    const n = cfg.counts?.[type]
    if (n === undefined) problems.push(`counts.${type} is missing`)
    else if (!Number.isSafeInteger(n) || n < 0) problems.push(`counts.${type} must be a whole number >= 0`)
    else counts[type] = n
  }
  for (const type of Object.keys(cfg.counts ?? {})) if (!c.types.includes(type)) problems.push(`counts.${type}: the model has no type "${type}"`)

  const tenantType = cfg.tenant?.type === undefined ? suggestTenant(c).type : cfg.tenant.type
  if (tenantType && !c.types.includes(tenantType)) problems.push(`tenant.type: the model has no type "${tenantType}"`)
  if (tenantType && cfg.tenant?.count !== undefined) problems.push('tenant.count only applies when tenant.type is null; the number of tenants is counts of the tenant type')
  const tenants = tenantType ? counts[tenantType] ?? 1 : cfg.tenant?.count ?? 1
  if (!Number.isSafeInteger(tenants) || tenants < 1) problems.push('the number of tenants must be a whole number >= 1')
  const skew = cfg.tenant?.skew ?? 1
  if (!(skew >= 0)) problems.push('tenant.skew must be >= 0')
  for (const type of cfg.global ?? []) if (!c.types.includes(type)) problems.push(`global: the model has no type "${type}"`)
  if (tenantType && cfg.global?.includes(tenantType)) problems.push('global cannot include the tenant type')
  const plan = tenantPlan(c, tenantType, cfg.global ?? [])
  const global = new Set([...plan.above, ...(cfg.global ?? [])])
  if (tenantType && tenants === 1) {
    const deeper = plan.inside.filter((t) => [...c.containers.values()].some((list) => list.includes(t)) && counts[t] > 1)
    if (deeper.length) warnings.push(`There is 1 ${tenantType}, so the whole store is one tenant. A type inside it may be the real tenant: ${deeper.join(', ')}.`)
  }

  const known = new Map(c.edges.map((e) => [e.key, e]))
  for (const key of Object.keys(cfg.edges ?? {})) if (!known.has(key)) problems.push(`edges["${key}"]: the model has no such edge`)
  const nestingTypes = new Set(c.edges.filter((e) => e.kind === 'nesting').map((e) => e.objectType))
  const edges = new Map<string, EdgeSettings>()
  for (const e of c.edges) {
    const where = `edges["${e.key}"]`
    const given = cfg.edges?.[e.key]
    if (!given) warnings.push(`No settings for ${e.key}; used the default (${e.kind}).`)
    const input: EdgeInput = { ...defaultEdge(c, e, tenantType), ...(given ?? {}) }
    for (const field of Object.keys(given ?? {}) as (keyof EdgeInput)[]) {
      if (field === 'question' || field === 'kind') continue
      if (!FIELDS[e.kind].includes(field)) problems.push(`${where}.${field} does not apply to a ${e.kind} edge (allowed: ${FIELDS[e.kind].join(', ')})`)
    }
    const coverage = input.coverage ?? 1
    if (!(coverage >= 0 && coverage <= 1)) problems.push(`${where}.coverage must be from 0 to 1`)
    const depth = input.depth ?? 3
    if (!Number.isInteger(depth) || depth < 0) problems.push(`${where}.depth must be a whole number >= 0`)
    else if (e.kind === 'nesting' && depth > 20) warnings.push(`${e.key}: depth ${depth} is close to OpenFGA's default limit of 25 levels per check.`)
    if (input.branching !== undefined && !(input.branching >= 1)) problems.push(`${where}.branching must be >= 1`)
    const popularity = input.popularity ?? 0
    if (!(popularity >= 0)) problems.push(`${where}.popularity must be >= 0`)
    let crossTenant = input.crossTenant ?? 0
    if (!(crossTenant >= 0 && crossTenant <= 1)) problems.push(`${where}.crossTenant must be from 0 to 1`)
    if (crossTenant > 0 && (tenants < 2 || global.has(e.objectType) || global.has(e.subjectType))) {
      warnings.push(`${e.key}: crossTenant ignored; it needs two or more tenants and neither type in a shared pool.`)
      crossTenant = 0
    }
    if (crossTenant > 0 && e.gate) problems.push(`${where}.crossTenant cannot be combined with a gated relation`)
    const per = input.per ?? 'object'
    if (per !== 'object' && per !== 'subject') problems.push(`${where}.per must be "object" or "subject"`)
    if (per === 'subject') {
      if (e.gate) problems.push(`${where}.per: "subject" cannot be combined with a gated relation`)
      if (input.perLevel) problems.push(`${where}.per: "subject" cannot be combined with perLevel`)
      if (crossTenant > 0) problems.push(`${where}.per: "subject" cannot be combined with crossTenant`)
      if (global.has(e.subjectType) && !global.has(e.objectType)) problems.push(`${where}.per: "subject" needs the subject type split per tenant, or both types shared`)
    }
    if (input.perLevel) {
      if (!Array.isArray(input.perLevel) || !input.perLevel.length || input.perLevel.some((v) => !(v >= 0))) problems.push(`${where}.perLevel must be a list of numbers >= 0`)
      if (!nestingTypes.has(e.objectType)) problems.push(`${where}.perLevel needs ${e.objectType} to nest in itself`)
    }
    if (input.context && !e.condition) problems.push(`${where}.context only applies to an edge with a condition`)
    if (e.gate && (e.subjectRelation || e.kind === 'container' || e.kind === 'nesting')) warnings.push(`${e.key}: the gate on this relation is not applied (only plain subjects on assignments are gated).`)
    edges.set(e.key, {
      coverage,
      dist: toDist(input.count ?? 1, where, problems),
      per: per === 'subject' ? 'subject' : 'object',
      popularity,
      crossTenant,
      depth,
      ...(input.branching ? { branching: input.branching } : {}),
      ...(input.perLevel ? { perLevel: input.perLevel } : {}),
      ...(input.context ? { context: input.context } : {}),
    })
  }
  if (cfg.ids !== undefined && cfg.ids !== 'index' && cfg.ids !== 'uuid') problems.push('ids must be "index" or "uuid"')
  if (cfg.seed !== undefined && !Number.isSafeInteger(cfg.seed)) problems.push('seed must be a whole number')
  if (problems.length) throw new Error(`The config has ${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`)
  return { seed: cfg.seed ?? 1, ids: cfg.ids ?? 'index', tenants, skew, global, counts, edges, plan, warnings }
}

/** The same config at a fraction of the size: every count scaled, at least one of each. */
export function scaled(cfg: Config, factor: number): Config {
  if (!(factor > 0)) throw new Error('--scale must be above 0')
  const counts = Object.fromEntries(Object.entries(cfg.counts).map(([t, n]) => [t, n === 0 ? 0 : Math.max(1, Math.round(n * factor))]))
  const tenant = cfg.tenant?.count ? { ...cfg.tenant, count: Math.max(1, Math.round(cfg.tenant.count * factor)) } : cfg.tenant
  return { ...cfg, counts, ...(tenant ? { tenant } : {}) }
}
