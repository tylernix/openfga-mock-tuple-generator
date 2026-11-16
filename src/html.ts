import type { Resolved } from './config.js'
import { askedBins, askedText, binned, isGated, type Bin, type EdgeReport, type Layout, type Projection, type Report } from './generate.js'
import type { Compiled } from './model.js'
import type { Neighborhood } from './neighborhood.js'

export interface HtmlInput {
  /** The config id the files are named after. */
  id: string
  report: Report
  compiled: Compiled
  /** Objects per type in the whole store. */
  counts: Record<string, number>
  neighborhood?: Neighborhood
  /** Why there is no neighborhood, when there is none. */
  noSample?: string
}

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
const num = (n: number) => Math.round(n).toLocaleString('en-US')
const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n))
const pct = (x: number) => `${(x * 100).toFixed(x > 0 && x < 0.1 ? 1 : 0)}%`

const PALETTE = ['#3b6fb6', '#d9822b', '#4c9a6a', '#a4549c', '#c4483f', '#5b9aa0', '#8a7a2c', '#6b6b6b', '#c46a8e', '#4f4fa8']

const CSS = `
body { font: 14px/1.45 system-ui, sans-serif; color: #1c2430; margin: 0 auto; max-width: 1100px; padding: 24px; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 36px 0 6px; }
.meta, .note { color: #566; margin: 2px 0 10px; } .note { font-size: 13px; }
.banner { border-radius: 6px; padding: 8px 12px; margin: 12px 0; } .bad { background: #fde8e6; border: 1px solid #e8a39d; }
.warn { background: #fff6dd; border: 1px solid #e6cf85; } .ok { background: #e7f4ec; border: 1px solid #9ccfb0; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.card { border: 1px solid #d8dde4; border-radius: 8px; padding: 10px 12px; }
.card h3 { font: 600 13px ui-monospace, Menlo, monospace; margin: 0 0 2px; word-break: break-all; }
.card .sub { color: #566; font-size: 12px; margin-bottom: 4px; } .card .cap { font-size: 12px; color: #344; margin: 6px 0 0; }
svg text { font-family: system-ui, sans-serif; } .legend span { display: inline-block; margin-right: 14px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
`

/** Bars for binned counts. Equal-width bars, so geometric bins read as a log axis. */
function bars(bins: Bin[], o: { width: number; height?: number; marks?: { label: string; value: number }[]; color?: string }): string {
  const h = o.height ?? 84
  const top = 16
  const w = o.width
  const max = Math.max(...bins.map((b) => b.n), 1)
  const bw = (w - 8) / bins.length
  const range = (b: Bin) => (b.from === b.to ? String(b.from) : `${b.from} to ${b.to}`)
  const rects = bins
    .map((b, i) => {
      const bh = Math.max(1, (b.n / max) * h)
      return `<rect x="${(4 + i * bw + 0.5).toFixed(1)}" y="${(top + h - bh).toFixed(1)}" width="${Math.max(1, bw - 1).toFixed(1)}" height="${bh.toFixed(1)}" fill="${o.color ?? '#3b6fb6'}"><title>${range(b)}: ${num(b.n)}</title></rect>`
    })
    .join('')
  const at = (v: number) => {
    const j = bins.findIndex((b) => v >= b.from && v <= b.to)
    return j < 0 ? (v < bins[0].from ? 0 : bins.length - 1) : j
  }
  const marks = new Map<number, string[]>()
  for (const m of o.marks ?? []) marks.set(at(m.value), [...(marks.get(at(m.value)) ?? []), m.label])
  const lines = [...marks.entries()]
    .map(([j, labels]) => {
      const x = 4 + (j + 0.5) * bw
      const anchor = x > w - 40 ? 'end' : x < 40 ? 'start' : 'middle'
      return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${top - 2}" y2="${top + h}" stroke="#c4483f" stroke-dasharray="3 2"/><text x="${x.toFixed(1)}" y="${top - 5}" font-size="10" fill="#c4483f" text-anchor="${anchor}">${labels.join(' = ')}</text>`
    })
    .join('')
  const axis = `<line x1="4" x2="${w - 4}" y1="${top + h + 0.5}" y2="${top + h + 0.5}" stroke="#9aa4b2"/>`
  const labels = `<text x="4" y="${top + h + 14}" font-size="10" fill="#566">${bins[0].from}</text><text x="${w - 4}" y="${top + h + 14}" font-size="10" fill="#566" text-anchor="end">${bins[bins.length - 1].to}</text>`
  return `<svg viewBox="0 0 ${w} ${top + h + 20}" width="100%" role="img">${rects}${axis}${lines}${labels}</svg>`
}

interface GraphEdge {
  key: string
  tuples: number
  /** Hover text. */
  tip: string
}

function modelGraph(compiled: Compiled, counts: Record<string, number>, edges: GraphEdge[]): string {
  const used = new Set(compiled.edges.flatMap((e) => [e.objectType, e.subjectType]))
  const types = compiled.types.filter((t) => used.has(t))
  const n = types.length
  const W = 900
  const H = 430 + 40 * Math.max(0, n - 6)
  const cx = W / 2
  const cy = H / 2
  const rx = W / 2 - 150
  const ry = H / 2 - 70
  const pos = new Map(types.map((t, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n
    return [t, { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a), hw: Math.max(48, 4.4 * t.length + 12), hh: 21 }]
  }))
  const color = (t: string) => PALETTE[compiled.types.indexOf(t) % PALETTE.length]
  const maxTuples = Math.max(...edges.map((e) => e.tuples), 1)
  const widthOf = (tuples: number) => 1 + (5 * Math.log10(1 + tuples)) / Math.log10(1 + maxTuples)
  const byKey = new Map(edges.map((e) => [e.key, e]))

  const clip = (p: { x: number; y: number; hw: number; hh: number }, tx: number, ty: number) => {
    const dx = tx - p.x
    const dy = ty - p.y
    const t = Math.min(dx ? p.hw / Math.abs(dx) : Infinity, dy ? p.hh / Math.abs(dy) : Infinity)
    return { x: p.x + dx * t, y: p.y + dy * t }
  }

  // Parallel edges between the same two types are fanned out by offsetting the bend: 0, +1, -1, +2, -2, ...
  const groups = new Map<string, number>()
  const slot = (k: number) => (k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2))
  const loops = new Map<string, number>()

  const parts = compiled.edges.map((e) => {
    const r = byKey.get(e.key)
    if (!r) return ''
    const a = pos.get(e.subjectType)!
    const b = pos.get(e.objectType)!
    const label = `${e.relation}${e.subjectRelation ? `(${e.subjectRelation})` : ''} ${compact(r.tuples)}`
    const tip = r.tip
    const sw = widthOf(r.tuples).toFixed(1)
    let d: string
    let lx: number
    let ly: number
    if (e.subjectType === e.objectType) {
      const i = loops.get(e.subjectType) ?? 0
      loops.set(e.subjectType, i + 1)
      const ux = a.x - cx
      const uy = a.y - cy
      const len = Math.hypot(ux, uy) || 1
      const nx = ux / len
      const ny = uy / len
      const tx = -ny
      const ty = nx
      const reach = 62 + 26 * i
      const s = { x: a.x + nx * 8 + tx * -20, y: a.y + ny * 8 + ty * -20 }
      const t = { x: a.x + nx * 8 + tx * 20, y: a.y + ny * 8 + ty * 20 }
      const p1 = clip(a, s.x + nx * 30, s.y + ny * 30)
      const p2 = clip(a, t.x + nx * 30, t.y + ny * 30)
      d = `M${p1.x.toFixed(1)},${p1.y.toFixed(1)} C${(a.x + nx * reach + tx * -34).toFixed(1)},${(a.y + ny * reach + ty * -34).toFixed(1)} ${(a.x + nx * reach + tx * 34).toFixed(1)},${(a.y + ny * reach + ty * 34).toFixed(1)} ${p2.x.toFixed(1)},${p2.y.toFixed(1)}`
      lx = a.x + nx * (reach + 8)
      ly = a.y + ny * (reach + 8)
    } else {
      const [p, q] = e.subjectType < e.objectType ? [a, b] : [b, a]
      const pair = [e.subjectType, e.objectType].sort().join('|')
      const k = groups.get(pair) ?? 0
      groups.set(pair, k + 1)
      const len = Math.hypot(q.x - p.x, q.y - p.y) || 1
      const bend = slot(k) * 44
      const mx = (p.x + q.x) / 2 + (-(q.y - p.y) / len) * bend
      const my = (p.y + q.y) / 2 + ((q.x - p.x) / len) * bend
      const s = clip(a, mx, my)
      const t = clip(b, mx, my)
      d = `M${s.x.toFixed(1)},${s.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${t.x.toFixed(1)},${t.y.toFixed(1)}`
      lx = 0.25 * s.x + 0.5 * mx + 0.25 * t.x
      ly = 0.25 * s.y + 0.5 * my + 0.25 * t.y
    }
    return `<path d="${d}" fill="none" stroke="#7a8696" stroke-opacity="0.75" stroke-width="${sw}" marker-end="url(#arrow)"><title>${esc(tip)}</title></path><text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" font-size="10" text-anchor="middle" fill="#2b3544" stroke="#fff" stroke-width="3" paint-order="stroke"><title>${esc(tip)}</title>${esc(label)}</text>`
  })

  const nodes = types
    .map((t) => {
      const p = pos.get(t)!
      return `<g><rect x="${(p.x - p.hw).toFixed(1)}" y="${(p.y - p.hh).toFixed(1)}" width="${p.hw * 2}" height="${p.hh * 2}" rx="8" fill="${color(t)}"/><text x="${p.x.toFixed(1)}" y="${(p.y - 2).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="600" fill="#fff">${esc(t)}</text><text x="${p.x.toFixed(1)}" y="${(p.y + 13).toFixed(1)}" text-anchor="middle" font-size="10" fill="#fff" fill-opacity="0.9">${compact(counts[t] ?? 0)} objects</text></g>`
    })
    .join('')
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="9" markerHeight="9" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#7a8696"/></marker></defs>${parts.join('')}${nodes}</svg>`
}

function edgeCard(e: EdgeReport, subjectType: string, objectType: string): string {
  const sub = `${e.kind} · ${num(e.tuples)} tuples · ${pct(e.coverage)} of ${num(e.eligible)} covered`
  let body = ''
  if (e.depth) {
    const bins = Object.entries(e.depth.containers).map(([d, n]) => ({ from: Number(d), to: Number(d), n }))
    body += `<div>${bins.length ? bars(bins, { width: 300, marks: [{ label: `asked ${e.depth.asked}`, value: e.depth.asked }] }) : ''}</div><p class="cap">Containers by their deepest object. Asked ${e.depth.asked}, reached ${e.depth.max}.</p>`
  } else if (e.histogram?.length && e.count) {
    const side = e.per === 'subject' ? subjectType : objectType
    body += `<div>${e.histogram.length > 1 ? bars(e.histogram, { width: 300, marks: [{ label: 'p50', value: e.count.p50 }, { label: 'p90', value: e.count.p90 }] }) : ''}</div><p class="cap">Tuples per ${esc(side)} (each ${esc(side)} that has any): p50 ${e.count.p50} · p90 ${e.count.p90} · max ${e.count.max}</p>`
  } else {
    body += `<p class="cap">${esc(e.asked)}</p>`
  }
  if (e.otherHistogram?.length && e.other) {
    body += `<div>${bars(e.otherHistogram, { width: 300, color: '#d9822b', marks: [{ label: 'p50', value: e.other.p50 }, { label: 'p90', value: e.other.p90 }] })}</div><p class="cap">The other side, tuples per ${esc(e.other.of)}: p50 ${e.other.p50} · p90 ${e.other.p90} · max ${e.other.max} · ${pct(e.other.withAny / e.other.pool)} have any</p>`
  }
  return `<div class="card"><h3>${esc(e.key)}</h3><div class="sub">${esc(sub)}</div>${body}</div>`
}

function hoodGraph(h: Neighborhood, compiled: Compiled): string {
  const W = 900
  const cols = [0, 1, 2].slice(0, h.hops + 1)
  const colX = [110, 450, 790]
  const typeIdx = (t: string) => compiled.types.indexOf(t)
  const color = (t: string) => PALETTE[Math.max(0, typeIdx(t)) % PALETTE.length]
  const byHop = cols.map((c) => h.nodes.filter((n) => n.hop === c).sort((a, b) => typeIdx(a.type) - typeIdx(b.type) || a.id.localeCompare(b.id, 'en', { numeric: true })))
  const tallest = Math.max(...byHop.map((c) => c.length), 1)
  const H = Math.max(300, 50 + 17 * tallest)
  const pos = new Map<string, { x: number; y: number }>()
  byHop.forEach((col, c) => col.forEach((n, i) => pos.set(n.id, { x: colX[c], y: col.length === 1 ? H / 2 : 30 + (i * (H - 60)) / (col.length - 1) })))
  const lines = h.edges
    .map((e) => {
      const a = pos.get(e.from)!
      const b = pos.get(e.to)!
      const touchesRoot = e.from === h.root || e.to === h.root
      const bend = (a.x + b.x) / 2
      return `<path d="M${a.x},${a.y.toFixed(1)} C${bend},${a.y.toFixed(1)} ${bend},${b.y.toFixed(1)} ${b.x},${b.y.toFixed(1)}" fill="none" stroke="${touchesRoot ? '#3b6fb6' : '#9aa4b2'}" stroke-opacity="${touchesRoot ? 0.6 : 0.35}"><title>${esc(`${e.from} ${e.relation} ${e.to}`)}</title></path>`
    })
    .join('')
  const dots = h.nodes
    .map((n) => {
      const p = pos.get(n.id)!
      const label = n.hop <= 1 || byHop[n.hop].length <= 40
      const anchorLeft = n.hop === h.hops
      return `<circle cx="${p.x}" cy="${p.y.toFixed(1)}" r="${n.id === h.root ? 8 : 5}" fill="${color(n.type)}" stroke="#fff"><title>${esc(n.id)}</title></circle>${label ? `<text x="${p.x + (anchorLeft ? -10 : 10)}" y="${(p.y + 3.5).toFixed(1)}" font-size="10" fill="#2b3544" text-anchor="${anchorLeft ? 'end' : 'start'}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(n.id)}</text>` : ''}`
    })
    .join('')
  const heads = cols.map((c) => `<text x="${colX[c]}" y="14" text-anchor="middle" font-size="11" fill="#566">${c === 0 ? 'the object' : `${c} step${c > 1 ? 's' : ''} away`} (${byHop[c].length})</text>`).join('')
  const types = [...new Set(h.nodes.map((n) => n.type))]
  const legend = `<p class="legend">${types.map((t) => `<span><i style="background:${color(t)}"></i>${esc(t)}</span>`).join('')}</p>`
  return `${legend}<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">${heads}${lines}${dots}</svg>`
}

function hoodSection(h: Neighborhood, compiled: Compiled, lead: string): string {
  return `<h2>One neighborhood</h2><p class="note">${lead} ${esc(h.root)} in tenant ${h.tenant} (a middle-sized one), and what is connected to it within ${h.hops} steps: ${h.nodes.length} objects, ${h.edges.length} tuples${h.capped ? '. Nearest first; more neighbors exist and were left out to keep this readable' : ''}. The pick is seeded, so the same config shows the same piece. Hover a dot or a line for its name.</p>${hoodGraph(h, compiled)}`
}

const GRAPH_NOTE = 'Each box is a type, with how many objects it has. Each arrow is one way a tuple can be written, from the subject to the object it is written on. Line width follows the tuple count (log scale).'

export interface PlanHtmlInput {
  id: string
  compiled: Compiled
  resolved: Resolved
  layout: Layout
  projection: Projection
  neighborhood?: Neighborhood
  /** Why there is no neighborhood, when there is none. */
  noSample?: string
}

/** The page `plan` writes: what the config says will be built, before anything is. */
export function renderPlanHtml(input: PlanHtmlInput): string {
  const { compiled, resolved: r, layout: lay, projection: p, id } = input
  const sizes = [...p.perTenant].sort((a, b) => a - b)
  const sizeHist = new Map<number, number>()
  for (const s of sizes) sizeHist.set(Math.round(s), (sizeHist.get(Math.round(s)) ?? 0) + 1)
  const median = sizes.length ? sizes[Math.floor(sizes.length / 2)] : 0
  const sizeBlock = lay.tenants > 1
    ? `<h2>Projected tuples per tenant</h2><p class="note">${num(lay.tenants)} ${esc(r.plan.type ?? 'tenant')}(s), skew ${r.skew}. Smallest about ${num(sizes[0])}, median about ${num(median)}, largest about ${num(sizes[sizes.length - 1])}${p.shared >= 1 ? `; the shared block adds about ${num(p.shared)}` : ''}. Bars are equal-width bins that grow along the axis, so a long tail stays visible.</p>${bars(binned(sizeHist, Math.min(24, Math.max(6, Math.ceil(2 * Math.sqrt(sizes.length))))), { width: 900, height: 110, color: '#4c9a6a', marks: [{ label: 'median', value: Math.round(median) }] })}`
    : ''
  const layoutLines = [
    r.plan.above.length ? `Above the tenant, shared by all: ${r.plan.above.join(', ')}.` : '',
    r.plan.inside.length ? `Inside a tenant by the model: ${r.plan.inside.join(', ')}.` : '',
    r.plan.assumed.length && lay.tenants > 1 ? `Split per tenant by assumption: ${r.plan.assumed.join(', ')}.` : '',
  ].filter(Boolean)
  const warnings = r.warnings.length ? `<div class="banner warn"><b>Warnings</b><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''
  const cards = compiled.edges.map((e) => {
    const cfg = r.edges.get(e.key)!
    const projected = p.perEdge.get(e.key) ?? 0
    const asked = askedBins(e, cfg)
    const sub = `${e.kind}${isGated(e) ? ', gated' : ''} · about ${num(projected)} tuples`
    const side = cfg.per === 'subject' && (e.kind === 'assignment' || e.kind === 'block') ? e.subjectType : e.objectType
    const body = asked
      ? `<div>${asked.bins.length > 1 ? bars(asked.bins, { width: 300, marks: [{ label: 'p50', value: asked.p50 }, { label: 'p90', value: asked.p90 }] }) : ''}</div><p class="cap">As configured: ${esc(askedText(e, cfg))}. Tuples per ${esc(side)} that has any: p50 ${asked.p50} · p90 ${asked.p90}.</p>`
      : `<p class="cap">As configured: ${esc(askedText(e, cfg))}.</p>`
    return `<div class="card"><h3>${esc(e.key)}</h3><div class="sub">${esc(sub)}</div>${body}</div>`
  })
  const graphEdges = compiled.edges.map((e) => {
    const projected = p.perEdge.get(e.key) ?? 0
    return { key: e.key, tuples: projected, tip: `${e.key}: about ${num(projected)} tuples. ${askedText(e, r.edges.get(e.key)!)}` }
  })
  const hood = input.neighborhood
  const hoodBlock = hood ? hoodSection(hood, compiled, 'Not projected, generated: one middle-sized tenant was built in memory for this picture, so it is a real sample.') : input.noSample ? `<h2>One neighborhood</h2><p class="note">${esc(input.noSample)}</p>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(id)} plan</title><style>${CSS}</style></head><body>
<h1>${esc(id)}: plan</h1>
<p class="meta">About ${num(p.total)} tuples across ${num(lay.tenants)} tenant(s). Nothing has been built. These are projections from the config; the sample at the end is the one thing actually generated. Gated and nesting edges are upper estimates. Run <code>build</code> for the realized numbers.</p>
${layoutLines.length ? `<p class="note">${layoutLines.map(esc).join(' ')}</p>` : ''}${warnings}
<h2>How the types connect</h2>
<p class="note">${GRAPH_NOTE} Labels show the relation and the projected tuples.</p>
${modelGraph(compiled, r.counts, graphEdges)}
${sizeBlock}
<h2>What each edge was asked for</h2>
<p class="note">Drawn from the config, not from tuples. Red dashes mark p50 and p90. Edges whose count depends on the pool, on nesting levels or on a gate show only their description.</p>
<div class="grid">${cards.join('')}</div>
${hoodBlock}
</body></html>
`
}

export function renderReportHtml(input: HtmlInput): string {
  const { report, compiled, id } = input
  const typeOf = new Map(compiled.edges.map((e) => [e.key, e]))
  const seconds = (report.elapsedMs / 1000).toFixed(1)
  const banner = report.violationCount
    ? `<div class="banner bad"><b>${report.violationCount} rule violation(s); do not use this store.</b><ul>${report.violations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></div>`
    : `<div class="banner ok">Rules held: depth, cycles, containers, tenant boundaries.</div>`
  const warnings = report.warnings.length ? `<div class="banner warn"><b>Warnings</b><ul>${report.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''
  const sizes = report.tenantSizes
  const sizeBlock = sizes
    ? `<h2>Tuples per tenant</h2><p class="note">${num(report.tenants.generated)} tenants. Smallest ${num(sizes.min)}, median ${num(sizes.median)}, largest ${num(sizes.max)}. Bars are equal-width bins that grow along the axis, so a long tail stays visible.</p>${bars(sizes.bins, { width: 900, height: 110, color: '#4c9a6a', marks: [{ label: 'median', value: sizes.median }] })}`
    : ''
  const hood = input.neighborhood
  const hoodBlock = hood ? hoodSection(hood, compiled, 'A sample:') : input.noSample ? `<h2>One neighborhood</h2><p class="note">${esc(input.noSample)}</p>` : ''
  const cards = report.edges.map((e) => {
    const def = typeOf.get(e.key)
    return edgeCard(e, def?.subjectType ?? '', def?.objectType ?? '')
  })
  const graphEdges = report.edges.map((e) => {
    const def = typeOf.get(e.key)
    return { key: e.key, tuples: e.tuples, tip: `${e.key}: ${num(e.tuples)} tuples${e.count ? `, per ${e.per === 'subject' ? def?.subjectType : def?.objectType}: p50 ${e.count.p50}, p90 ${e.count.p90}, max ${e.count.max}` : ''}` }
  })
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(id)} report</title><style>${CSS}</style></head><body>
<h1>${esc(id)}</h1>
<p class="meta">${num(report.tuples)} tuples from ${num(report.tenants.generated)} of ${num(report.tenants.total)} tenant(s) in ${seconds}s, peak memory ${num(report.peakRssMb)} MB.</p>
${banner}${warnings}
<h2>How the types connect</h2>
<p class="note">${GRAPH_NOTE} Labels show the relation and the tuples written.</p>
${modelGraph(compiled, input.counts, graphEdges)}
${sizeBlock}
<h2>Distribution per edge</h2>
<p class="note">Blue: how many tuples each object (or subject) that has any got. Orange: the same count from the other side. Red dashes mark p50 and p90.</p>
<div class="grid">${cards.join('')}</div>
${hoodBlock}
</body></html>
`
}
