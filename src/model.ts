import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashString } from './random.js'

/**
 * Reads an authorization model and turns every directly assignable type restriction into an edge:
 * one way a tuple can be written. Edges are classified by how the model uses them, with no notion of
 * which relations matter to a caller:
 *   container   followed by `from`, pointing at another object type (document#folder: [folder])
 *   nesting     a type inside itself: a parent link, or a userset of its own relation (group#member: [group#member])
 *   wildcard    a public grant (user:*)
 *   block       only ever read on the right of `but not`
 *   assignment  everything else: people and groups given a relation
 */
export type EdgeKind = 'container' | 'nesting' | 'assignment' | 'block' | 'wildcard'

export interface Edge {
  /** "object#relation:subject[#relation][:*][ with condition]", the key used in the config. */
  key: string
  hash: number
  objectType: string
  relation: string
  subjectType: string
  subjectRelation?: string
  wildcard: boolean
  condition?: string
  kind: EdgeKind
  /** The relation is followed by `from` on its type. */
  tupleset: boolean
  /** Other operands of the intersection this direct relation sits in: only subjects passing them are written. */
  gate?: any[]
  /** Relations (type#relation) the gate reads. Their edges are generated first. */
  deps: string[]
  /** Set when several edges write the same object, relation and subject kind (they differ by condition). */
  family?: string
}

export interface Compiled {
  model: any
  types: string[]
  edges: Edge[]
  /** Types that are given relations: users, service accounts. */
  principals: string[]
  /** Child type to the types that contain it. */
  containers: Map<string, string[]>
}

/** An empty config, so the CLI can never read a remote store from ~/.fga.yaml. */
let emptyConfig: string | undefined
export function fgaRun(args: string[]): { ok: boolean; stdout: string; out: string } {
  if (!emptyConfig) {
    emptyConfig = join(mkdtempSync(join(tmpdir(), 'fga-tuple-gen-')), 'fga.yaml')
    writeFileSync(emptyConfig, '# empty: local only\n')
  }
  const run = spawnSync('fga', [...args, '--config', emptyConfig], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 })
  if ((run.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    throw new Error('The OpenFGA CLI (`fga`) is not on the PATH. It is needed to read .fga models and to verify stores.')
  }
  if (run.error) throw run.error
  return { ok: run.status === 0, stdout: run.stdout ?? '', out: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

export function fga(args: string[]): string {
  const run = fgaRun(args)
  if (!run.ok) throw new Error(`fga ${args.join(' ')} failed: ${run.out.trim()}`)
  return run.stdout
}

/** A model file as JSON: `.json` as is, anything else (`.fga`, `fga.mod`) through `fga model transform`. */
export function loadModel(path: string): any {
  if (path.endsWith('.json')) return JSON.parse(readFileSync(path, 'utf8'))
  const out = fga(['model', 'transform', '--file', path])
  return JSON.parse(out.slice(out.indexOf('{')))
}

/** The model as DSL text, for store files. */
export function modelDsl(model: any): string {
  const file = join(mkdtempSync(join(tmpdir(), 'fga-tuple-gen-')), 'model.json')
  writeFileSync(file, JSON.stringify(model))
  const out = fga(['model', 'transform', '--file', file, '--input-format', 'json'])
  return out.slice(out.indexOf('model')).trimEnd() + '\n'
}

const hasThis = (node: any): boolean =>
  !!node && (node.this !== undefined
    || (node.union?.child ?? node.intersection?.child ?? []).some(hasThis)
    || (!!node.difference && (hasThis(node.difference.base) || hasThis(node.difference.subtract))))

export function compile(model: any): Compiled {
  const defs = new Map<string, any>((model.type_definitions ?? []).map((d: any) => [d.type, d]))
  const types = [...defs.keys()]
  const restrictions = (type: string, rel: string): any[] => defs.get(type)?.metadata?.relations?.[rel]?.directly_related_user_types ?? []
  const rewrites = (type: string): [string, any][] => Object.entries<any>(defs.get(type)?.relations ?? {})

  // What each relation reads, and whether it reads it on the excluded side of a `but not`.
  const refs = new Map<string, { to: string; neg: boolean }[]>()
  const tuplesets = new Set<string>()
  const gates = new Map<string, any[]>()
  for (const type of types) {
    for (const [rel, rewrite] of rewrites(type)) {
      const key = `${type}#${rel}`
      const out: { to: string; neg: boolean }[] = []
      const walk = (node: any, neg: boolean) => {
        if (node.this !== undefined) {
          for (const t of restrictions(type, rel)) if (t.relation) out.push({ to: `${t.type}#${t.relation}`, neg })
        } else if (node.computedUserset) out.push({ to: `${type}#${node.computedUserset.relation}`, neg })
        else if (node.tupleToUserset) {
          const ts = node.tupleToUserset.tupleset.relation
          tuplesets.add(`${type}#${ts}`)
          out.push({ to: `${type}#${ts}`, neg })
          for (const t of restrictions(type, ts)) out.push({ to: `${t.type}#${node.tupleToUserset.computedUserset.relation}`, neg })
        } else if (node.union) node.union.child.forEach((c: any) => walk(c, neg))
        else if (node.intersection) {
          const kids: any[] = node.intersection.child
          if (kids.some((c) => c.this !== undefined) && !gates.has(key)) gates.set(key, kids.filter((c) => c.this === undefined))
          kids.forEach((c) => walk(c, neg))
        } else if (node.difference) {
          walk(node.difference.base, neg)
          walk(node.difference.subtract, !neg)
        }
      }
      walk(rewrite, false)
      refs.set(key, out)
    }
  }

  // Polarity from the top: relations nothing else reads are permissions; `but not` flips what it subtracts.
  const read = new Set<string>()
  for (const [from, list] of refs) for (const r of list) if (r.to !== from) read.add(r.to)
  const pos = new Set<string>()
  const neg = new Set<string>()
  const spread = (start: string) => {
    const stack: [string, boolean][] = [[start, false]]
    while (stack.length) {
      const [key, isNeg] = stack.pop()!
      const set = isNeg ? neg : pos
      if (set.has(key)) continue
      set.add(key)
      for (const r of refs.get(key) ?? []) stack.push([r.to, isNeg !== r.neg])
    }
  }
  for (const key of refs.keys()) if (!read.has(key)) spread(key)
  for (const key of refs.keys()) if (!pos.has(key) && !neg.has(key)) spread(key)

  // Types that can end up holding a relation: plain subjects reached by following the rewrite all the way down.
  const holderMemo = new Map<string, Set<string>>()
  const holderTypes = (type: string, rel: string): Set<string> => {
    const done = holderMemo.get(`${type}#${rel}`)
    if (done) return done
    const out = new Set<string>()
    const seen = new Set<string>()
    const stack: [string, string][] = [[type, rel]]
    while (stack.length) {
      const [t, r] = stack.pop()!
      const rewrite = defs.get(t)?.relations?.[r]
      if (seen.has(`${t}#${r}`) || !rewrite) continue
      seen.add(`${t}#${r}`)
      const walk = (node: any) => {
        if (node.this !== undefined) {
          for (const s of restrictions(t, r)) {
            if (s.relation) stack.push([s.type, s.relation])
            else out.add(s.type)
          }
        } else if (node.computedUserset) stack.push([t, node.computedUserset.relation])
        else if (node.tupleToUserset) {
          for (const s of restrictions(t, node.tupleToUserset.tupleset.relation)) stack.push([s.type, node.tupleToUserset.computedUserset.relation])
        } else if (node.union) node.union.child.forEach(walk)
        else if (node.intersection) node.intersection.child.forEach(walk)
        else if (node.difference) walk(node.difference.base)
      }
      walk(rewrite)
    }
    holderMemo.set(`${type}#${rel}`, out)
    return out
  }
  // What `X from link` reads on each link's subjects.
  const readThrough = new Map<string, Set<string>>()
  for (const type of types) {
    for (const [, rewrite] of rewrites(type)) {
      const walk = (node: any) => {
        if (!node || typeof node !== 'object') return
        if (node.tupleToUserset) {
          const key = `${type}#${node.tupleToUserset.tupleset.relation}`
          readThrough.set(key, (readThrough.get(key) ?? new Set()).add(node.tupleToUserset.computedUserset.relation))
        }
        for (const value of Object.values(node)) walk(value)
      }
      walk(rewrite)
    }
  }
  /**
   * A link points at a place (a folder, an organization) when what is read through it can be held by
   * another type: the folder's viewers are users. A link whose target only ever yields its own type
   * (`equivalent from owner_user`, user to user) points at people, and is an assignment.
   */
  const isPlace = (type: string, rel: string, subject: string) =>
    [...(readThrough.get(`${type}#${rel}`) ?? [])].some((x) => [...holderTypes(subject, x)].some((holder) => holder !== subject))

  // People: types with no relations, and plain subjects that no link treats as a place.
  const places = new Set<string>()
  const given = new Set<string>()
  for (const type of types) {
    for (const [rel, rewrite] of rewrites(type)) {
      if (!hasThis(rewrite)) continue
      for (const t of restrictions(type, rel)) {
        if (t.relation || t.type === type) continue
        if (tuplesets.has(`${type}#${rel}`) && isPlace(type, rel, t.type)) places.add(t.type)
        else given.add(t.type)
      }
    }
  }
  const principalSet = new Set<string>(types.filter((t) => !rewrites(t).length || (given.has(t) && !places.has(t))))

  /** Direct relations and tuplesets that evaluating the gate reads. */
  const gateDeps = (operands: any[], type: string, own: string): string[] => {
    const acc = new Set<string>()
    const seen = new Set<string>()
    const visit = (t: string, r: string) => {
      const rewrite = defs.get(t)?.relations?.[r]
      if (seen.has(`${t}#${r}`) || !rewrite) return
      seen.add(`${t}#${r}`)
      walk(rewrite, t, r)
    }
    const walk = (node: any, t: string, r: string) => {
      if (node.this !== undefined) {
        acc.add(`${t}#${r}`)
        for (const s of restrictions(t, r)) if (s.relation) visit(s.type, s.relation)
      } else if (node.computedUserset) visit(t, node.computedUserset.relation)
      else if (node.tupleToUserset) {
        const ts = node.tupleToUserset.tupleset.relation
        acc.add(`${t}#${ts}`)
        for (const s of restrictions(t, ts)) visit(s.type, node.tupleToUserset.computedUserset.relation)
      } else if (node.union) node.union.child.forEach((c: any) => walk(c, t, r))
      else if (node.intersection) node.intersection.child.forEach((c: any) => walk(c, t, r))
      else if (node.difference) {
        walk(node.difference.base, t, r)
        walk(node.difference.subtract, t, r)
      }
    }
    for (const op of operands) walk(op, type, own)
    acc.delete(`${type}#${own}`)
    return [...acc].sort()
  }

  const edges: Edge[] = []
  for (const type of types) {
    for (const [rel, rewrite] of rewrites(type)) {
      if (!hasThis(rewrite)) continue
      const relKey = `${type}#${rel}`
      const tupleset = tuplesets.has(relKey)
      const negOnly = neg.has(relKey) && !pos.has(relKey)
      const gate = gates.get(relKey)
      for (const t of restrictions(type, rel)) {
        const wildcard = t.wildcard !== undefined
        const nesting = !wildcard && t.type === type && ((tupleset && !t.relation) || t.relation === rel)
        const kind: EdgeKind = wildcard ? 'wildcard'
          : nesting ? 'nesting'
          : negOnly ? 'block'
          : tupleset && !t.relation && isPlace(type, rel, t.type) ? 'container'
          : 'assignment'
        const key = `${relKey}:${t.type}${t.relation ? `#${t.relation}` : ''}${wildcard ? ':*' : ''}${t.condition ? ` with ${t.condition}` : ''}`
        edges.push({
          key,
          hash: hashString(key),
          objectType: type,
          relation: rel,
          subjectType: t.type,
          ...(t.relation ? { subjectRelation: t.relation } : {}),
          wildcard,
          ...(t.condition ? { condition: t.condition } : {}),
          kind,
          tupleset,
          ...(gate ? { gate } : {}),
          deps: gate ? gateDeps(gate, type, rel) : [],
        })
      }
    }
  }
  const families = new Map<string, Edge[]>()
  for (const e of edges) {
    if (e.wildcard) continue
    const family = `${e.objectType}#${e.relation}:${e.subjectType}#${e.subjectRelation ?? ''}`
    families.set(family, [...(families.get(family) ?? []), e])
  }
  for (const [family, members] of families) if (members.length > 1) for (const e of members) e.family = family

  const containers = new Map<string, string[]>()
  for (const e of edges) {
    if (e.kind !== 'container') continue
    const list = containers.get(e.objectType) ?? []
    if (!list.includes(e.subjectType)) list.push(e.subjectType)
    containers.set(e.objectType, list)
  }
  return { model, types, edges, principals: types.filter((t) => principalSet.has(t)), containers }
}

/** Every type a type is (transitively) contained in. */
export function ancestors(c: Compiled, type: string, seen = new Set<string>()): Set<string> {
  for (const parent of c.containers.get(type) ?? []) {
    if (seen.has(parent)) continue
    seen.add(parent)
    ancestors(c, parent, seen)
  }
  return seen
}

/**
 * The order edges are generated in: containers (outer types first, and a type's innermost container
 * first, so an outer container can follow from it), each nesting right after its type's innermost
 * container (the tree is built inside it, and the type's other containers then follow the tree), then
 * the rest with every edge waiting for the relations its gate reads.
 */
export function generationOrder(c: Compiled): Edge[] {
  const depth = (type: string) => ancestors(c, type).size
  const structure = c.edges.filter((e) => e.kind === 'container').sort((a, b) =>
    depth(a.objectType) - depth(b.objectType) || depth(b.subjectType) - depth(a.subjectType) || a.key.localeCompare(b.key))
  for (const e of c.edges.filter((x) => x.kind === 'nesting').sort((a, b) => b.key.localeCompare(a.key))) {
    structure.splice(structure.findIndex((x) => x.kind === 'container' && x.objectType === e.objectType) + 1, 0, e)
  }
  const rank = { assignment: 0, wildcard: 1, block: 2 } as Record<EdgeKind, number>
  const pending = c.edges.filter((e) => e.kind !== 'container' && e.kind !== 'nesting').sort((a, b) => rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key))
  const waiting = new Map<string, number>()
  for (const e of pending) waiting.set(`${e.objectType}#${e.relation}`, (waiting.get(`${e.objectType}#${e.relation}`) ?? 0) + 1)
  const rest: Edge[] = []
  while (pending.length) {
    let i = pending.findIndex((e) => e.deps.every((d) => !waiting.get(d)))
    if (i < 0) i = 0 // gates that read each other: keep the listed order
    const [e] = pending.splice(i, 1)
    rest.push(e)
    waiting.set(`${e.objectType}#${e.relation}`, waiting.get(`${e.objectType}#${e.relation}`)! - 1)
  }
  return [...structure, ...rest]
}

/** The plain-language question an edge's settings answer. */
export function edgeQuestion(e: Edge): string {
  const subject = e.subjectRelation ? `${e.subjectType} ${e.subjectRelation}s` : `${e.subjectType}s`
  const gated = e.gate ? ' Only subjects who pass the rest of the rule are written.' : ''
  const condition = e.condition ? ` (written with condition ${e.condition})` : ''
  if (e.kind === 'container') return `Which ${e.subjectType} does each ${e.objectType} belong to (${e.relation})? Usually one.`
  if (e.kind === 'nesting') return `How many levels of ${e.objectType} sit inside a top-level ${e.objectType}, and what share of them are nested at all?`
  if (e.kind === 'wildcard') return `What share of ${e.objectType}s are open to every ${e.subjectType} (${e.relation})?`
  if (e.kind === 'block') return `What share of ${e.objectType}s have ${subject} excluded through ${e.relation}, and how many each?`
  return `For a typical ${e.objectType}, how many ${subject} hold ${e.relation}${condition}?${gated}`
}
