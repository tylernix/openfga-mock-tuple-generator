import { ancestors, type Compiled } from './model.js'

/**
 * Tenancy: every object belongs to a tenant before any tuple is written, and both ends of a tuple
 * come from the same tenant unless the config says otherwise.
 *
 * The tenant type is a container type (organization, tenant, site). Types it is contained in sit above
 * tenants and are shared by all of them. Every other type is split per tenant, including types the
 * model does not tie to the tenant (roles and groups with no org link): that is an assumption, so it
 * is listed for the user to confirm, and `global` in the config moves a type to one shared pool.
 */
export interface TenantPlan {
  type: string | null
  /** Types the tenant type is contained in: shared by every tenant. */
  above: string[]
  /** Types the model places inside the tenant. */
  inside: string[]
  /** Types split per tenant by assumption: the model has no containment path from them to the tenant. */
  assumed: string[]
}

const ORG_LIKE = /^(org|organi[sz]ation|tenant|workspace|account|company|site|customer)s?$/i

/** Container types, most contained types first. A type that nests in itself (folders, groups) is never suggested. */
export function suggestTenant(c: Compiled): { type: string | null; reason: string } {
  const containerTypes = new Set([...c.containers.values()].flat())
  const selfNesting = new Set(c.edges.filter((e) => e.kind === 'nesting').map((e) => e.objectType))
  const reach = (type: string) => c.types.filter((t) => ancestors(c, t).has(type)).length
  const scored = [...containerTypes].filter((t) => !selfNesting.has(t)).map((type) => ({ type, reach: reach(type) }))
    .sort((a, b) => b.reach - a.reach || a.type.localeCompare(b.type))
  const named = scored.find((s) => ORG_LIKE.test(s.type))
  if (named) return { type: named.type, reason: `${named.type} contains ${named.reach} type(s) and is named like a tenant` }
  const root = scored.find((s) => !c.containers.get(s.type)?.length)
  if (root) return { type: root.type, reason: `${root.type} is the outermost container (${root.reach} type(s) inside)` }
  return { type: null, reason: 'no type contains the others: one tenant, unless tenant.count splits the store' }
}

export function tenantPlan(c: Compiled, type: string | null, global: Iterable<string>): TenantPlan {
  if (!type) return { type: null, above: [], inside: [], assumed: [] }
  const above = [...ancestors(c, type)]
  const shared = new Set([...above, ...global])
  const inside = c.types.filter((t) => t !== type && ancestors(c, t).has(type))
  const assumed = c.types.filter((t) => t !== type && !shared.has(t) && !inside.includes(t))
  return { type, above, inside, assumed }
}
