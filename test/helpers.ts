import { fileURLToPath } from 'node:url'
import { defaultConfig, resolve, type Config, type EdgeInput } from '../src/config.js'
import { generate, type Report } from '../src/generate.js'
import { compile, loadModel, type Compiled } from '../src/model.js'
import { memorySink, objectOf, userOf, type OutTuple } from '../src/output.js'

export const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.fga`, import.meta.url))

const compiled = new Map<string, Compiled>()
export function model(name: string): Compiled {
  let c = compiled.get(name)
  if (!c) compiled.set(name, (c = compile(loadModel(fixture(name)))))
  return c
}

export interface Patch {
  counts?: Record<string, number>
  edges?: Record<string, EdgeInput>
  tenant?: Config['tenant']
  global?: string[]
  seed?: number
  ids?: Config['ids']
}

export function config(name: string, patch: Patch = {}): Config {
  const base = defaultConfig(model(name), fixture(name))
  const edges = { ...base.edges }
  for (const [key, value] of Object.entries(patch.edges ?? {})) edges[key] = { ...edges[key], ...value }
  return { ...base, ...patch, counts: { ...base.counts, ...patch.counts }, edges }
}

export function build(name: string, patch: Patch = {}, tenants?: number[]): { tuples: OutTuple[]; report: Report; lines: string[] } {
  const c = model(name)
  const sink = memorySink()
  const report = generate(c, resolve(c, config(name, patch)), { sink, ...(tenants ? { tenants } : {}) })
  return { tuples: sink.tuples, report, lines: sink.tuples.map(line) }
}

export const line = (t: OutTuple) => `${userOf(t)} ${t.relation} ${objectOf(t)}${t.condition ? ` with ${t.condition}` : ''}`
export const edgeOf = (report: Report, key: string) => report.edges.find((e) => e.key === key)!

/** object -> the single subject it points at through `relation`. */
export function linkMap(tuples: OutTuple[], objectType: string, relation: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const t of tuples) if (t.objectType === objectType && t.relation === relation && !t.userRelation) out.set(objectOf(t), userOf(t))
  return out
}

export function depthOf(parent: Map<string, string>, id: string): number {
  let depth = 0
  const seen = new Set([id])
  for (let at = parent.get(id); at; at = parent.get(at)) {
    if (seen.has(at)) throw new Error(`cycle at ${at}`)
    seen.add(at)
    depth++
  }
  return depth
}
