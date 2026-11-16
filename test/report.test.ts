import { describe, expect, it } from 'vitest'
import { resolve } from '../src/config.js'
import { askedBins, binned, generate, layout, project } from '../src/generate.js'
import { renderPlanHtml, renderReportHtml } from '../src/html.js'
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
