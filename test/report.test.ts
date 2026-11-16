import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolve } from '../src/config.js'
import { askedBins, binned, generate, layout, project } from '../src/generate.js'
import { renderPlanHtml, renderReportHtml, niceTop } from '../src/html.js'
import { medianTenant, neighborhood, sampleSkipReason } from '../src/neighborhood.js'
import { memorySink } from '../src/output.js'
import { config, model } from './helpers.js'

const small = (name: string) => Object.fromEntries(model(name).types.map((t) => [t, 40]))
const setup = (name: string) => {
  const c = model(name)
  const r = resolve(c, config(name, { counts: small(name) }))
  const report = generate(c, r, { sink: memorySink() })
  return { c, r, report }
}

describe('the plan page', () => {
  const planOf = (name: string) => {
    const c = model(name)
    const r = resolve(c, config(name, { counts: small(name) }))
    const lay = layout(c, r)
    const projection = project(c, r, lay)
    return { c, r, lay, projection }
  }

  it('says nothing was built, lists every edge, and carries no script', () => {
    const { c, r, lay, projection } = planOf('drive')
    const html = renderPlanHtml({ id: 'x', compiled: c, resolved: r, layout: lay, projection })
    expect(html).toContain('Nothing has been built')
    for (const e of c.edges) expect(html).toContain(e.key)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('One neighborhood')
  })

  it('explains why there is no sample instead of building a huge one', () => {
    const { c, r, lay, projection } = planOf('drive')
    const html = renderPlanHtml({ id: 'x', compiled: c, resolved: r, layout: lay, projection, noSample: 'No sample drawn: too big' })
    expect(html).toContain('No sample drawn: too big')
    expect(sampleSkipReason(1_000_000, 0)).toMatch(/No sample drawn/)
    expect(sampleSkipReason(1_000, 500)).toBeUndefined()
  })

  it('picks a middle-sized tenant', () => {
    expect(medianTenant([5, 1, 9, 3, 7])).toBe(0)
    expect(medianTenant([])).toBe(0)
  })
})

describe('asked distributions', () => {
  it('are drawn from the config for a spread, and sum to one', () => {
    const { c, r } = setup('drive')
    const shown = c.edges.map((e) => ({ e, a: askedBins(e, r.edges.get(e.key)!) })).filter((x) => x.a)
    expect(shown.length).toBeGreaterThan(0)
    for (const { a } of shown) {
      expect(a!.p50).toBeLessThanOrEqual(a!.p90)
      expect(a!.bins.reduce((s, b) => s + b.n, 0)).toBeGreaterThan(900_000)
    }
  })

  it('are not drawn for nesting, wildcard or pool-dependent edges', () => {
    const { c, r } = setup('drive')
    for (const e of c.edges.filter((x) => x.kind === 'nesting' || x.kind === 'wildcard')) expect(askedBins(e, r.edges.get(e.key)!)).toBeUndefined()
  })
})

describe('README images', () => {
  it('exist, and are small enough for a repo', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const readme = readFileSync(join(root, 'README.md'), 'utf8')
    const images = [...readme.matchAll(/(?:src="|\]\()(images\/[^"\s)]+)/g)].map((m) => m[1])
    expect(images.length).toBeGreaterThan(0)
    for (const image of images) {
      expect(existsSync(join(root, image)), image).toBe(true)
      expect(statSync(join(root, image)).size, `${image} is over 300 KB`).toBeLessThan(300_000)
    }
  })
})

describe('chart axes', () => {
  const charts = (html: string) => html.split('<svg class="chart"').slice(1).map((chunk) => chunk.slice(0, chunk.indexOf('</svg>')))

  it('rounds the top of the y axis to 1, 2 or 5 times a power of ten', () => {
    expect(niceTop(1)).toBe(1)
    expect(niceTop(3)).toBe(5)
    expect(niceTop(7)).toBe(10)
    expect(niceTop(12)).toBe(20)
    expect(niceTop(0.3)).toBe(0.5)
    expect(niceTop(0)).toBe(1)
  })

  it('gives every chart on the report page a y axis with ticks and both titles', () => {
    const { c, r, report } = setup('drive')
    const html = renderReportHtml({ id: 'x', report, compiled: c, counts: r.counts })
    const all = charts(html)
    expect(all.length).toBeGreaterThan(3)
    for (const svg of all) {
      expect(svg).toContain('rotate(-90)')
      expect(svg).toMatch(/text-anchor="end">0<\/text>/)
      expect(svg).toMatch(/y="[\d.]+" font-size="10" fill="#344" text-anchor="middle">[^<]+<\/text>/)
    }
  })

  it('gives every chart on the plan page a y axis, as a share for the asked distributions', () => {
    const c = model('drive')
    const r = resolve(c, config('drive', { counts: small('drive') }))
    const lay = layout(c, r)
    const html = renderPlanHtml({ id: 'x', compiled: c, resolved: r, layout: lay, projection: project(c, r, lay) })
    const all = charts(html)
    expect(all.length).toBeGreaterThan(1)
    for (const svg of all) expect(svg).toContain('rotate(-90)')
    expect(all.some((svg) => svg.includes('%</text>'))).toBe(true)
  })
})

describe('binned', () => {
  it('keeps exact values when there are few', () => {
    expect(binned(new Map([[1, 5], [3, 2]]))).toEqual([{ from: 1, to: 1, n: 5 }, { from: 3, to: 3, n: 2 }])
  })

  it('groups a long tail into at most maxBins bins that cover every value once', () => {
    const hist = new Map<number, number>()
    for (let k = 1; k <= 2000; k++) hist.set(k, Math.max(1, Math.round(5000 / k)))
    const bins = binned(hist, 24)
    expect(bins.length).toBeLessThanOrEqual(24)
    expect(bins[0].from).toBe(1)
    expect(bins[bins.length - 1].to).toBe(2000)
    expect(bins.every((b, i) => i === 0 || b.from === bins[i - 1].to + 1)).toBe(true)
    expect(bins.reduce((s, b) => s + b.n, 0)).toBe([...hist.values()].reduce((s, n) => s + n, 0))
  })

  it('returns nothing for an empty histogram', () => {
    expect(binned(new Map())).toEqual([])
  })
})

describe('the report carries the shape of each edge', () => {
  it('has a histogram per edge that adds up to the objects covered', () => {
    const { report } = setup('drive')
    const withCounts = report.edges.filter((e) => e.count)
    expect(withCounts.length).toBeGreaterThan(0)
    for (const e of withCounts) expect(e.histogram!.reduce((s, b) => s + b.n, 0)).toBe(e.covered)
  })

  it('has tenant sizes that cover every tenant built', () => {
    const { report } = setup('drive')
    const sizes = report.tenantSizes!
    expect(sizes.bins.reduce((s, b) => s + b.n, 0)).toBe(report.tenants.generated)
    expect(sizes.min).toBeLessThanOrEqual(sizes.median)
    expect(sizes.median).toBeLessThanOrEqual(sizes.max)
    expect(sizes.medianTenant).toBeGreaterThanOrEqual(0)
    expect(sizes.medianTenant).toBeLessThan(report.tenants.total)
  })
})

describe('neighborhood', () => {
  it('is the same piece every time, and only holds what it reaches', () => {
    const { c, r, report } = setup('drive')
    const tenant = report.tenantSizes!.medianTenant
    const a = neighborhood(c, r, tenant)!
    const b = neighborhood(c, r, tenant)!
    expect(a).toEqual(b)
    expect(a.nodes.filter((n) => n.hop === 0).map((n) => n.id)).toEqual([a.root])
    const ids = new Set(a.nodes.map((n) => n.id))
    expect(a.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true)
    expect(a.nodes.length).toBeLessThanOrEqual(121)
    expect(a.edges.length).toBeLessThanOrEqual(400)
  })

  it('picks a different object for a different seed', () => {
    const { c, r, report } = setup('drive')
    const other = resolve(c, { ...config('drive', { counts: small('drive') }), seed: 99 })
    const tenant = report.tenantSizes!.medianTenant
    expect(neighborhood(c, other, tenant)!.root).not.toBe(neighborhood(c, r, tenant)!.root)
  })
})

describe('the HTML report', () => {
  it('draws every edge, is one self-contained file, and runs no script', () => {
    const { c, r, report } = setup('drive')
    const html = renderReportHtml({ id: 'x', report, compiled: c, counts: r.counts, neighborhood: neighborhood(c, r, report.tenantSizes!.medianTenant) })
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<svg')
    for (const e of report.edges) expect(html).toContain(e.key.replaceAll('&', '&amp;'))
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/(src|href)=["']https?:/)
    expect(html).toContain('One neighborhood')
  })

  it('escapes text that came from the report', () => {
    const { c, r, report } = setup('drive')
    const html = renderReportHtml({ id: '<i>x</i>', report: { ...report, warnings: ['<b>bold</b> & more'] }, compiled: c, counts: r.counts })
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt; &amp; more')
    expect(html).not.toContain('<b>bold</b>')
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
  })

  it('shows rule violations as a banner that says not to use the store', () => {
    const { c, r, report } = setup('drive')
    const html = renderReportHtml({ id: 'x', report: { ...report, violationCount: 1, violations: ['a broke b'] }, compiled: c, counts: r.counts })
    expect(html).toContain('do not use this store')
    expect(html).toContain('a broke b')
  })
})
