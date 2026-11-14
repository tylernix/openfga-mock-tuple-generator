/**
 * A small Check-semantics evaluator: who holds a relation on an object, given tuples. Used to pick
 * subjects for gated relations and to state what OpenFGA should answer when a store is verified.
 * Results are plain subjects ("user:7") and public markers ("user:*"); usersets are expanded.
 */
export class TupleIndex {
  private bySubjects = new Map<string, string[]>()
  private conditioned = new Set<string>()

  add(subject: string, relation: string, object: string, conditioned = false) {
    const key = `${object}#${relation}`
    const list = this.bySubjects.get(key)
    if (list) list.push(subject)
    else this.bySubjects.set(key, [subject])
    if (conditioned) this.conditioned.add(key)
  }
  get = (key: string) => this.bySubjects.get(key)
  hasCondition = (key: string) => this.conditioned.has(key)
}

export interface Held {
  set: Set<string>
  /** The answer read a conditional tuple or a public grant, so it is not a plain list of subjects. */
  uncertain: boolean
}

const EMPTY: Held = { set: new Set(), uncertain: false }
const typeOf = (id: string) => id.slice(0, id.indexOf(':'))
const has = (set: Set<string>, id: string) => set.has(id) || set.has(`${typeOf(id)}:*`)

export interface Evaluator {
  holders: (object: string, relation: string) => Held
  evalNode: (node: any, object: string, relation: string) => Held
}

/** `indexes` are read in order; an object's tuples live in exactly one of them. */
export function createEvaluator(model: any, indexes: TupleIndex[]): Evaluator {
  const defs = new Map<string, any>((model.type_definitions ?? []).map((d: any) => [d.type, d]))
  const lookup = (key: string) => {
    for (const index of indexes) {
      const hit = index.get(key)
      if (hit) return hit
    }
    return undefined
  }
  const conditioned = (key: string) => indexes.some((index) => index.hasCondition(key))
  const memo = new Map<string, Held>()
  const open = new Map<string, number>()
  // Lowest open relation an answer leaned on; an answer that leaned on one still open is not kept.
  let low = Infinity

  const union = (parts: Held[]): Held => {
    const full = parts.filter((p) => p.set.size || p.uncertain)
    if (!full.length) return EMPTY
    if (full.length === 1) return full[0]
    const set = new Set<string>()
    for (const p of full) for (const s of p.set) set.add(s)
    return { set, uncertain: full.some((p) => p.uncertain) }
  }

  const holders = (object: string, relation: string): Held => {
    const key = `${object}#${relation}`
    const done = memo.get(key)
    if (done) return done
    const at = open.get(key)
    if (at !== undefined) {
      low = Math.min(low, at)
      return EMPTY
    }
    const rewrite = defs.get(typeOf(object))?.relations?.[relation]
    if (!rewrite) return EMPTY
    const depth = open.size
    open.set(key, depth)
    const outer = low
    low = Infinity
    const result = evalNode(rewrite, object, relation)
    open.delete(key)
    const settled = low >= depth
    if (settled) memo.set(key, result)
    low = Math.min(outer, settled ? Infinity : low)
    return result
  }

  const evalNode = (node: any, object: string, relation: string): Held => {
    if (node.this !== undefined) {
      const key = `${object}#${relation}`
      const subjects = lookup(key)
      if (!subjects) return EMPTY
      const set = new Set<string>()
      let uncertain = conditioned(key)
      for (const s of subjects) {
        const hash = s.indexOf('#')
        if (hash < 0) {
          set.add(s)
          if (s.endsWith(':*')) uncertain = true
        } else {
          const inner = holders(s.slice(0, hash), s.slice(hash + 1))
          for (const x of inner.set) set.add(x)
          uncertain ||= inner.uncertain
        }
      }
      return { set, uncertain }
    }
    if (node.computedUserset) return holders(object, node.computedUserset.relation)
    if (node.tupleToUserset) {
      const key = `${object}#${node.tupleToUserset.tupleset.relation}`
      const parents = (lookup(key) ?? []).filter((s) => !s.includes('#') && !s.endsWith(':*'))
      const parts = parents.map((p) => holders(p, node.tupleToUserset.computedUserset.relation))
      const merged = union(parts)
      return conditioned(key) ? { set: merged.set, uncertain: true } : merged
    }
    if (node.union) return union(node.union.child.map((c: any) => evalNode(c, object, relation)))
    if (node.intersection) {
      const parts: Held[] = node.intersection.child.map((c: any) => evalNode(c, object, relation))
      const set = new Set<string>()
      for (const candidate of parts[0].set) if (parts.every((p) => has(p.set, candidate))) set.add(candidate)
      for (const p of parts.slice(1)) for (const candidate of p.set) if (!set.has(candidate) && parts.every((q) => has(q.set, candidate))) set.add(candidate)
      return { set, uncertain: parts.some((p) => p.uncertain) }
    }
    if (node.difference) {
      const base = evalNode(node.difference.base, object, relation)
      const subtract = evalNode(node.difference.subtract, object, relation)
      if (!subtract.set.size && !subtract.uncertain) return base
      const set = new Set<string>()
      for (const s of base.set) if (!has(subtract.set, s)) set.add(s)
      return { set, uncertain: base.uncertain || subtract.uncertain }
    }
    return EMPTY
  }

  return { holders, evalNode }
}
