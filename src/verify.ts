import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Resolved } from './config.js'
import { createEvaluator, TupleIndex } from './evaluate.js'
import { generate, layout, project, rangeOf, type Report } from './generate.js'
import { fgaRun, modelDsl, type Compiled } from './model.js'
import { indent, memorySink, objectOf, userOf, yamlTuple, type OutTuple } from './output.js'

/**
 * OpenFGA as referee. A pilot (a few whole tenants, exactly as they are in the full store) is loaded
 * into the CLI's in-memory OpenFGA, which must agree on who holds each relation on a spread of objects.
 * It proves the tuples are accepted and mean what the report says; it says nothing about realism.
 */
export interface ReachRow {
  relation: string
  objects: number
  /** Share of the tenant's users who hold the relation on the median sampled object. */
  medianShare: number
  /** Sampled objects reached by more than half of their tenant's users. */
  overHalf: number
}

export interface Verdict extends RefereeResult {
  tenants: number[]
  tuples: number
  warnings: string[]
  report: Report
  file: string
}

/** Most users one ListUsers assertion may list. */
const MAX_LISTED_USERS = 200

/** A large, a middling and a small tenant that fit the tuple budget together. */
export function pilotTenants(perTenant: Float64Array, budget: number): number[] {
  const sized = [...perTenant].map((size, t) => ({ t, size })).filter((x) => x.size > 0).sort((a, b) => b.size - a.size)
  if (!sized.length) return [0]
  const fits = sized.filter((x) => x.size <= budget / 2)
  const pool = fits.length ? fits : [sized[sized.length - 1]]
  const out: number[] = []
  let used = 0
  for (const pick of [pool[0], pool[Math.floor(pool.length / 2)], pool[pool.length - 1]]) {
    if (out.includes(pick.t) || (out.length && used + pick.size > budget)) continue
    out.push(pick.t)
    used += pick.size
  }
  return out.sort((a, b) => a - b)
}

export interface Assertions {
  yaml: string
  listUsers: number
  checks: number
  skipped: number
  reach: ReachRow[]
}

/** What OpenFGA should answer on these tuples, as a store test file, plus how far each relation reaches. */
export function buildAssertions(c: Compiled, r: Resolved, dsl: string, tuples: OutTuple[], perType: number): Assertions {
  const lay = layout(c, r)
  const index = new TupleIndex()
  const tenantOfObject = new Map<string, Map<string, number>>()
  const principalsSeen = new Map<number, Set<string>>()
  const principalTypes = new Set(c.principals)
  // Links between objects (document#folder) hold no users; they are verified but not part of reach.
  const links = new Set(c.edges.filter((e) => e.tupleset && !principalTypes.has(e.subjectType)).map((e) => `${e.objectType}#${e.relation}`))
  for (const t of tuples) {
    index.add(userOf(t), t.relation, objectOf(t), !!t.condition)
    const byId = tenantOfObject.get(t.objectType) ?? new Map<string, number>()
    tenantOfObject.set(t.objectType, byId)
    byId.set(objectOf(t), t.tenant)
    if (!t.userRelation && t.userId !== '*' && principalTypes.has(t.userType)) {
      const seen = principalsSeen.get(t.tenant) ?? new Set<string>()
      principalsSeen.set(t.tenant, seen)
      seen.add(userOf(t))
    }
  }
  const ev = createEvaluator(c.model, [index])
  const principalCount = (tenant: number) => c.principals.reduce((sum, type) => {
    const [lo, hi] = rangeOf(lay, type, tenant)
    return sum + hi - lo
  }, 0)

  const listUsers: string[] = []
  const checkBy = new Map<string, { user: string; object: string; assertions: string[] }>()
  const shares = new Map<string, number[]>()
  let listCount = 0
  let checkCount = 0
  let skipped = 0
  const addCheck = (user: string, object: string, relation: string, expected: boolean) => {
    const key = `${user}|${object}`
    const entry = checkBy.get(key) ?? { user, object, assertions: [] }
    checkBy.set(key, entry)
    entry.assertions.push(`          ${relation}: ${expected}`)
    checkCount++
  }
  for (const def of c.model.type_definitions ?? []) {
    const relations = Object.keys(def.relations ?? {})
    const ids = [...(tenantOfObject.get(def.type)?.keys() ?? [])]
    if (!relations.length || !ids.length) continue
    const step = Math.max(1, Math.floor(ids.length / perType))
    for (let i = 0; i < ids.length && i / step < perType; i += step) {
      const object = ids[i]
      const tenant = tenantOfObject.get(def.type)!.get(object)!
      for (const relation of relations) {
        const held = ev.holders(object, relation)
        if (held.uncertain) {
          skipped++
          continue
        }
        const people = [...held.set].filter((s) => principalTypes.has(s.slice(0, s.indexOf(':')))).sort()
        const total = principalCount(tenant)
        if (total && !links.has(`${def.type}#${relation}`)) shares.set(`${def.type}#${relation}`, [...(shares.get(`${def.type}#${relation}`) ?? []), people.length / total])
        for (const type of c.principals) {
          const users = people.filter((s) => s.startsWith(`${type}:`))
          if (users.length > MAX_LISTED_USERS) {
            skipped++
            continue
          }
          listCount++
          listUsers.push(
            `      - object: ${object}`,
            '        user_filter:',
            `          - type: ${type}`,
            '        assertions:',
            `          ${relation}:`,
            ...(users.length ? ['            users:', ...users.map((u) => `              - ${u}`)] : ['            users: []']),
          )
        }
        if (people.length) addCheck(people[0], object, relation, true)
        for (const candidate of principalsSeen.get(tenant) ?? []) {
          if (held.set.has(candidate)) continue
          addCheck(candidate, object, relation, false)
          break
        }
      }
    }
  }
  const checks = [...checkBy.values()].flatMap((entry) => [`      - user: ${entry.user}`, `        object: ${entry.object}`, '        assertions:', ...entry.assertions])
  const yaml = [
    'name: fga-tuple-gen pilot',
    'model: |',
    indent(dsl),
    'tuples:',
    ...tuples.map(yamlTuple),
    'tests:',
    '  - name: the generated store means what the generator says',
    ...(checks.length ? ['    check:', ...checks] : []),
    ...(listUsers.length ? ['    list_users:', ...listUsers] : []),
  ].join('\n') + '\n'
  const reach = [...shares].map(([relation, list]) => {
    const sorted = [...list].sort((a, b) => a - b)
    return { relation, objects: list.length, medianShare: sorted[Math.floor(sorted.length / 2)], overHalf: list.filter((s) => s > 0.5).length }
  })
  return { yaml, listUsers: listCount, checks: checkCount, skipped, reach }
}

export interface VerifyOptions {
  /** The store test file to write. A second file, `.recheck.yaml`, is written beside it only when OpenFGA lists part of an answer. */
  file: string
  /** Tuple budget for the pilot (default 20,000). */
  maxTuples?: number
  /** Objects sampled per type (default 15). */
  perType?: number
  tenants?: number[]
}

export interface RefereeResult {
  ok: boolean
  listUsers: { passing: number; total: number }
  checks: { passing: number; total: number }
  /** ListUsers answers that were a partial list, where OpenFGA's own Check then confirmed the users left out. */
  incomplete: number
  /** Answers not asserted: they read a conditional tuple or a public grant, or list too many users. */
  skipped: number
  failures: string[]
  reach: ReachRow[]
}

const FAILED_LIST = /ListUsers\(object=\{Type:(\S+) Id:(\S+)\},relation=([^,]+),user_filter=\{[^}]*\}\): expected=\{Users:\[([^\]]*)\]\}, got=\{Users:\[([^\]]*)\]\}/
/** Users re-asked with Check per partial list. */
const RECHECK_USERS = 20

/** Has OpenFGA load the tuples and answer the assertions. `file` is the store test file it writes. */
export function referee(c: Compiled, r: Resolved, dsl: string, tuples: OutTuple[], file: string, perType: number): RefereeResult {
  const built = buildAssertions(c, r, dsl, tuples, perType)
  writeFileSync(file, built.yaml)
  const run = fgaRun(['model', 'test', '--tests', file])
  const summary = (out: string, kind: string) => {
    const m = out.match(new RegExp(`${kind} (\\d+)/(\\d+) passing`))
    return m ? { passing: Number(m[1]), total: Number(m[2]) } : undefined
  }
  const listed = summary(run.out, 'ListUsers')
  const checked = summary(run.out, 'Checks')
  const base = { skipped: built.skipped, reach: built.reach, incomplete: 0 }
  if (!listed && !checked) {
    // Nothing ran: OpenFGA refused the store (an invalid tuple) or the model.
    const reason = run.out.includes(' due to ') ? run.out.slice(run.out.indexOf(' due to ') + 8) : run.out.split('\n').find((l) => l.trim() && !l.startsWith('Using config')) ?? 'no output'
    return { ...base, ok: false, listUsers: { passing: 0, total: built.listUsers }, checks: { passing: 0, total: built.checks }, failures: [`OpenFGA refused the store: ${reason.trim().split('\n')[0]}`] }
  }
  const listUsers = listed ?? { passing: 0, total: 0 }
  const checks = checked ?? { passing: 0, total: 0 }
  const failed = run.out.split('\n').filter((l) => l.startsWith('ⅹ'))
  // ListUsers can return part of the list (seen on a deep model). A list with nobody extra, whose
  // missing users OpenFGA's Check then confirms one by one, is OpenFGA's limit and not a wrong store.
  const partial: { line: string; object: string; relation: string; missing: string[] }[] = []
  for (const l of failed) {
    const m = l.match(FAILED_LIST)
    if (!m) continue
    const expected = m[4].split(' ').filter(Boolean)
    const got = new Set(m[5].split(' ').filter(Boolean))
    const missing = expected.filter((u) => !got.has(u))
    if (missing.length && [...got].every((u) => expected.includes(u))) partial.push({ line: l, object: `${m[1]}:${m[2]}`, relation: m[3], missing })
  }
  let incomplete = 0
  if (partial.length) {
    const recheck = partial.flatMap((p) => {
      const step = Math.max(1, Math.floor(p.missing.length / RECHECK_USERS))
      return p.missing.filter((_, i) => i % step === 0).slice(0, RECHECK_USERS).flatMap((user) => [`      - user: ${user}`, `        object: ${p.object}`, '        assertions:', `          ${p.relation}: true`])
    })
    const recheckFile = file.replace(/\.yaml$/, '.recheck.yaml')
    writeFileSync(recheckFile, [built.yaml.slice(0, built.yaml.indexOf('\ntests:\n')), 'tests:', '  - name: users a partial ListUsers left out', '    check:', ...recheck].join('\n') + '\n')
    const again = summary(fgaRun(['model', 'test', '--tests', recheckFile]).out, 'Checks')
    if (again && again.passing === again.total) incomplete = partial.length
  }
  const confirmed = new Set(incomplete ? partial.map((p) => p.line) : [])
  return {
    ...base,
    ok: listUsers.total + checks.total > 0 && listUsers.passing + incomplete === listUsers.total && checks.passing === checks.total,
    listUsers,
    checks,
    incomplete,
    failures: failed.filter((l) => !confirmed.has(l)).slice(0, 12).map((l) => (l.length > 300 ? `${l.slice(0, 300)}...` : l)),
  }
}

export function verify(c: Compiled, r: Resolved, opts: VerifyOptions): Verdict {
  const tenants = opts.tenants ?? pilotTenants(project(c, r).perTenant, opts.maxTuples ?? 20_000)
  const sink = memorySink()
  const report = generate(c, r, { sink, tenants })
  mkdirSync(dirname(opts.file), { recursive: true })
  const file = opts.file
  const result = referee(c, r, modelDsl(c.model), sink.tuples, file, opts.perType ?? 15)
  const warnings = result.reach.filter((row) => row.overHalf * 2 > row.objects)
    .map((row) => `${row.relation}: ${row.overHalf} of ${row.objects} sampled objects are reached by more than half of their tenant's users. Fine for org-wide access; a wiring problem otherwise.`)
  return { ...result, ok: result.ok && !report.violationCount, tenants, tuples: sink.tuples.length, warnings, report, file }
}
