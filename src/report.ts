import type { Resolved } from './config.js'
import type { Layout, Projection, Report } from './generate.js'
import { isGated } from './generate.js'
import type { Compiled } from './model.js'
import type { Verdict } from './verify.js'

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`

function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
  return rows.map((row) => row.map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i]))).join('  ').trimEnd()).join('\n')
}

export function formatPlan(c: Compiled, r: Resolved, lay: Layout, projection: Projection): string {
  const out: string[] = []
  const plan = r.plan
  out.push(plan.type ? `Tenants: ${num(lay.tenants)} ${plan.type}(s), sizes skewed by ${r.skew}.` : `Tenants: ${num(lay.tenants)} (the model has no tenant type).`)
  if (plan.above.length) out.push(`  Above the tenant, shared by all: ${plan.above.join(', ')}`)
  if (plan.inside.length) out.push(`  Inside a tenant by the model: ${plan.inside.join(', ')}`)
  if (plan.assumed.length && lay.tenants > 1) out.push(`  Split per tenant by assumption (the model does not tie them to ${plan.type}): ${plan.assumed.join(', ')}`)
  const listed = [...r.global].filter((t) => !plan.above.includes(t))
  if (listed.length) out.push(`  One shared pool, as configured: ${listed.join(', ')}`)
  if (lay.tenants > 1) {
    const sizes = [...projection.perTenant].sort((a, b) => b - a)
    out.push(`  Projected tuples per tenant: largest ${num(sizes[0])}, median ${num(sizes[Math.floor(sizes.length / 2)])}, smallest ${num(sizes[sizes.length - 1])}; shared block ${num(projection.shared)}`)
    const empty = c.types.filter((t) => !lay.global.has(t) && r.counts[t] > 0 && r.counts[t] < lay.tenants)
    if (empty.length) out.push(`  Fewer objects than tenants, so some tenants have none: ${empty.join(', ')}`)
  }
  out.push('', 'Projected tuples per edge (gated and nesting edges are upper estimates):')
  const rows = [['edge', 'kind', 'tuples']]
  for (const e of c.edges) rows.push([e.key, `${e.kind}${isGated(e) ? ', gated' : ''}`, num(projection.perEdge.get(e.key) ?? 0)])
  rows.push(['total', '', num(projection.total)])
  out.push(table(rows))
  if (r.warnings.length) out.push('', 'Warnings:', ...r.warnings.map((w) => `  - ${w}`))
  return out.join('\n')
}

export function formatReport(report: Report): string {
  const out: string[] = []
  out.push(`${num(report.tuples)} tuples from ${num(report.tenants.generated)} of ${num(report.tenants.total)} tenant(s) in ${(report.elapsedMs / 1000).toFixed(1)}s, peak memory ${num(report.peakRssMb)} MB.`)
  out.push('', 'Asked versus realized, per edge:')
  const rows = [['edge', 'tuples', 'asked', 'covered', 'p50 / p90 / max', 'KS', 'other side p50 / p90 / max', 'clipped']]
  for (const e of report.edges) {
    rows.push([
      e.key,
      num(e.tuples),
      e.asked,
      pct(e.coverage),
      e.depth ? `depth max ${e.depth.max}` : e.count ? `${e.count.p50} / ${e.count.p90} / ${e.count.max}` : '-',
      e.ks === undefined ? '-' : e.ks.toFixed(2),
      e.other && e.other.withAny ? `${e.other.p50} / ${e.other.p90} / ${e.other.max} per ${e.other.of} (${pct(e.other.withAny / e.other.pool)} have any)` : '-',
      e.clipped ? num(e.clipped) : '-',
    ])
  }
  out.push(table(rows))
  const nested = report.edges.filter((e) => e.depth)
  if (nested.length) {
    out.push('', 'Nesting depth, containers by their deepest object:')
    for (const e of nested) out.push(`  ${e.key}: asked ${e.depth!.asked}; ${Object.entries(e.depth!.containers).map(([d, count]) => `depth ${d}: ${num(count)}`).join(', ') || 'none'}`)
  }
  const crossing = report.edges.filter((e) => e.crossTenant)
  out.push('', crossing.length ? `Cross-tenant tuples: ${crossing.map((e) => `${e.key} ${num(e.crossTenant)}`).join(', ')}` : 'Cross-tenant tuples: none.')
  if (report.warnings.length) out.push('', 'Warnings:', ...report.warnings.map((w) => `  - ${w}`))
  if (report.violationCount) out.push('', `VIOLATIONS (${report.violationCount}); do not use this store:`, ...report.violations.map((v) => `  - ${v}`))
  else out.push('', 'Rules held: depth within the asked limit, no cycles, trees inside their containers, no unasked cross-tenant tuples.')
  return out.join('\n')
}

export function formatVerdict(v: Verdict): string {
  const out: string[] = []
  out.push(`Pilot: tenant(s) ${v.tenants.join(', ')} and the shared block, ${num(v.tuples)} tuples, exactly as in the full store.`)
  out.push(`OpenFGA: ListUsers ${v.listUsers.passing}/${v.listUsers.total} passing, Checks ${v.checks.passing}/${v.checks.total} passing${v.skipped ? `, ${v.skipped} answers not asserted (conditions, public grants or long lists)` : ''}.`)
  if (v.incomplete) out.push(`  ${v.incomplete} more ListUsers answers were partial lists; OpenFGA's Check confirmed the users it left out, so they count as agreeing.`)
  if (v.reach.length) {
    out.push('', 'Reach on sampled objects (share of the tenant\'s users who hold the relation):')
    const rows = [['relation', 'objects', 'median', 'over half']]
    for (const row of v.reach) rows.push([row.relation, String(row.objects), pct(row.medianShare), String(row.overHalf)])
    out.push(table(rows))
  }
  if (v.warnings.length) out.push('', 'Warnings:', ...v.warnings.map((w) => `  - ${w}`))
  if (v.report.violationCount) out.push('', `VIOLATIONS (${v.report.violationCount}):`, ...v.report.violations.map((x) => `  - ${x}`))
  if (v.failures.length) out.push('', 'OpenFGA output:', ...v.failures.map((f) => `  ${f}`))
  out.push('', `${v.ok ? 'PASS' : 'FAIL'}. Test file: ${v.file}`)
  return out.join('\n')
}
