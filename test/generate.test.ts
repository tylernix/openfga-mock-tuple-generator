import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolve, scaled, type Config } from '../src/config.js'
import { generate } from '../src/generate.js'
import { compile, generationOrder, loadModel } from '../src/model.js'
import { memorySink, objectOf, userOf } from '../src/output.js'
import { levelSizes, pickDistinct, rngFor } from '../src/random.js'
import { suggestTenant } from '../src/tenants.js'
import { verify } from '../src/verify.js'
import { build, config, depthOf, edgeOf, fixture, line, linkMap, model } from './helpers.js'

const small = { user: 600, organization: 12, group: 120, folder: 600, document: 3_000 }

describe('reading the model', () => {
  it('classifies every directly assignable restriction by how the model uses it', () => {
    const kinds = Object.fromEntries(model('drive').edges.map((e) => [e.key, e.kind]))
    expect(kinds).toEqual({
      'organization#member:user': 'assignment',
      'organization#admin:user': 'assignment',
      'group#org:organization': 'container',
      'group#member:user': 'assignment',
      'group#member:group#member': 'nesting',
      'group#manager:user': 'assignment',
      'folder#org:organization': 'container',
      'folder#parent:folder': 'nesting',
      'folder#viewer:user': 'assignment',
      'folder#viewer:group#member': 'assignment',
      'document#folder:folder': 'container',
      'document#owner:user': 'assignment',
      'document#viewer:user': 'assignment',
      'document#viewer:user:*': 'wildcard',
      'document#viewer:group#member': 'assignment',
      'document#viewer:user with in_office_hours': 'assignment',
      'document#guest:user with in_office_hours': 'assignment',
      'document#public:user:*': 'wildcard',
      'document#blocked:user': 'block',
    })
    expect(model('drive').principals).toEqual(['user'])
  })

  it('finds gates, what they read, and an order that writes those first', () => {
    const c = model('gated')
    const member = c.edges.find((e) => e.key === 'team#member:user')!
    expect(member.gate).toHaveLength(1)
    expect(member.deps).toEqual(['org#member', 'team#org'])
    expect(c.edges.find((e) => e.key === 'project#screened:user')!.kind).toBe('block')
    const order = generationOrder(c).map((e) => e.key)
    expect(order.indexOf('org#member:user')).toBeLessThan(order.indexOf('team#member:user'))
    expect(order.indexOf('team#member:user')).toBeLessThan(order.indexOf('team#lead:user'))
    expect(order.indexOf('project#team:team')).toBeLessThan(order.indexOf('project#org:org'))
  })

  it('suggests the tenant type from containment', () => {
    expect(suggestTenant(model('drive')).type).toBe('organization')
    expect(suggestTenant(model('gated')).type).toBe('org')
    // Groups and folders contain documents here, but things that nest in themselves are not tenants.
    expect(suggestTenant(model('nested')).type).toBe('drive')
  })
})

describe('the config', () => {
  it('lists every problem at once', () => {
    const c = model('drive')
    const cfg = config('drive', { edges: { 'document#viewer:user': { depth: 2 }, 'folder#parent:folder': { coverage: 2 } } })
    delete (cfg.counts as Record<string, number>).folder
    cfg.edges!['document#editor:user'] = { coverage: 1 }
    expect(() => resolve(c, cfg)).toThrow(/4 problem/)
  })

  it('scales every count, keeping at least one of each', () => {
    expect(scaled(config('drive', { counts: small }), 0.01).counts).toEqual({ user: 6, organization: 1, group: 1, folder: 6, document: 30 })
  })

  it('needs only a model and a count per type, and says which count is missing', () => {
    const c = model('minimal')
    const smallest = { model: fixture('minimal'), counts: { user: 1_000, document: 10_000 } }
    const resolved = resolve(c, smallest)
    expect(resolved.warnings).toEqual(['No settings for document#viewer:user; used the default (assignment).'])
    const sink = memorySink()
    const report = generate(c, resolved, { sink })
    expect(report.violationCount).toBe(0)
    expect(sink.tuples.length).toBeGreaterThan(10_000)
    expect(sink.tuples.every((t) => t.relation === 'viewer' && t.objectType === 'document' && t.userType === 'user')).toBe(true)
    expect(() => resolve(c, { model: smallest.model, counts: { document: 10_000 } })).toThrow('counts.user is missing')
  })

  it('sets one edge on its own: exactly 3 viewers on every document', () => {
    const c = model('minimal')
    const sink = memorySink()
    generate(c, resolve(c, { model: fixture('minimal'), counts: { user: 1_000, document: 10_000 }, edges: { 'document#viewer:user': { coverage: 1, count: 3 } } }), { sink })
    const viewers = new Map<string, number>()
    for (const t of sink.tuples) viewers.set(objectOf(t), (viewers.get(objectOf(t)) ?? 0) + 1)
    expect(viewers.size).toBe(10_000)
    expect([...viewers.values()].every((n) => n === 3)).toBe(true)
  })
})

describe('the configs the README shows', () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const readme = read('../README.md')
  const load = (file: string) => {
    const path = fileURLToPath(new URL(`../bench/${file}`, import.meta.url))
    const cfg: Config = JSON.parse(readFileSync(path, 'utf8'))
    const c = compile(loadModel(resolvePath(dirname(path), cfg.model)))
    return { cfg, c, text: readFileSync(path, 'utf8').trim() }
  }
  const built = (file: string) => {
    const { cfg, c } = load(file)
    const r = resolve(c, cfg)
    const sink = memorySink()
    const report = generate(c, r, { sink })
    return { r, report, tuples: sink.tuples }
  }

  it('shows each config and the simple model exactly as the files have them', () => {
    expect(readme).toContain(load('simple.smallest.gen.json').text)
    expect(readme).toContain(load('simple.gen.json').text)
    expect(readme).toContain(read('../bench/models/simple.fga').trim())
  })

  it('the smallest config builds with a warning for each relation it leaves at the default', () => {
    const { r, report, tuples } = built('simple.smallest.gen.json')
    expect(r.warnings).toEqual([
      'No settings for organization#member:user; used the default (assignment).',
      'No settings for document#org:organization; used the default (container).',
      'No settings for document#owner:user; used the default (assignment).',
      'No settings for document#viewer:user; used the default (assignment).',
    ])
    expect(report.violationCount).toBe(0)
    expect(tuples.length).toBeGreaterThan(398_000)
    expect(tuples.length).toBeLessThan(402_000)
    // "every user belongs to one organization"
    const orgs = new Map<string, number>()
    for (const t of tuples) if (t.objectType === 'organization' && t.relation === 'member') orgs.set(userOf(t), (orgs.get(userOf(t)) ?? 0) + 1)
    expect(orgs.size).toBe(5_000)
    expect([...orgs.values()].every((n) => n === 1)).toBe(true)
  })

  it('simple.gen.json gives every document one owner from its own organization, and shares 30% of them', () => {
    const { report, tuples } = built('simple.gen.json')
    expect(report.violationCount).toBe(0)
    const memberOf = new Map<string, string>()
    const orgOfDoc = new Map<string, string>()
    for (const t of tuples) {
      if (t.objectType === 'organization' && t.relation === 'member') memberOf.set(userOf(t), objectOf(t))
      else if (t.objectType === 'document' && t.relation === 'org') orgOfDoc.set(`document:${t.objectId}`, userOf(t))
    }
    const owners = new Map<string, number>()
    const shared = new Set<string>()
    for (const t of tuples) {
      if (t.objectType !== 'document') continue
      if (t.relation === 'owner') {
        owners.set(objectOf(t), (owners.get(objectOf(t)) ?? 0) + 1)
        expect(memberOf.get(userOf(t))).toBe(orgOfDoc.get(objectOf(t)))
      } else if (t.relation === 'viewer') shared.add(objectOf(t))
    }
    expect(owners.size).toBe(100_000)
    expect([...owners.values()].every((n) => n === 1)).toBe(true)
    expect(shared.size / 100_000).toBeGreaterThan(0.29)
    expect(shared.size / 100_000).toBeLessThan(0.31)
  })
})

describe('determinism', () => {
  it('writes the same store for the same config', () => {
    expect(build('drive', { counts: small }).lines).toEqual(build('drive', { counts: small }).lines)
    expect(build('drive', { counts: small, seed: 2 }).lines).not.toEqual(build('drive', { counts: small }).lines)
  })

  it('a tenant built alone is exactly its slice of the full store', () => {
    const full = build('drive', { counts: small })
    for (const tenant of [0, 5, 11]) {
      const alone = build('drive', { counts: small }, [tenant])
      expect(alone.lines).toEqual(full.tuples.filter((t) => t.tenant === tenant).map(line))
      expect(alone.lines.length).toBeGreaterThan(0)
    }
  })

  it("changing one edge's settings changes no other edge's tuples", () => {
    const before = build('drive', { counts: small })
    const after = build('drive', { counts: small, edges: { 'folder#viewer:user': { count: { min: 5, max: 9 }, coverage: 1 } } })
    const others = (tuples: typeof before.tuples) => tuples.filter((t) => !(t.objectType === 'folder' && t.relation === 'viewer' && !t.userRelation)).map(line)
    expect(others(after.tuples)).toEqual(others(before.tuples))
    expect(edgeOf(after.report, 'folder#viewer:user').tuples).toBeGreaterThan(edgeOf(before.report, 'folder#viewer:user').tuples * 2)
  })
})

describe('nesting', () => {
  for (const depth of [1, 2, 5]) {
    it(`is never deeper than the asked ${depth}, with no cycles, and stays inside its organization`, () => {
      const { tuples, report } = build('drive', { counts: { ...small, folder: 4_000 }, edges: { 'folder#parent:folder': { depth, coverage: 1 } } })
      const parent = linkMap(tuples, 'folder', 'parent')
      const org = linkMap(tuples, 'folder', 'org')
      let deepest = 0
      for (const [child, p] of parent) {
        deepest = Math.max(deepest, depthOf(parent, child))
        expect(org.get(p)).toBe(org.get(child))
      }
      expect(deepest).toBe(depth)
      expect(edgeOf(report, 'folder#parent:folder').depth!.max).toBe(depth)
      expect(report.violationCount).toBe(0)
    })
  }

  it('keeps trees inside their organization when assignments are set per level', () => {
    const { tuples, report } = build('drive', { counts: small, edges: { 'folder#parent:folder': { depth: 3, coverage: 1 }, 'folder#viewer:user': { perLevel: [3, 1, 0, 0] } } })
    const parent = linkMap(tuples, 'folder', 'parent')
    const org = linkMap(tuples, 'folder', 'org')
    for (const [child, p] of parent) expect(org.get(p)).toBe(org.get(child))
    // Viewers sit only on the top two levels.
    for (const t of tuples) if (t.objectType === 'folder' && t.relation === 'viewer' && !t.userRelation) expect(depthOf(parent, objectOf(t))).toBeLessThan(2)
    expect(edgeOf(report, 'folder#viewer:user').tuples).toBeGreaterThan(0)
    expect(report.violationCount).toBe(0)
  })

  it('reports containers too small to reach the asked depth instead of hiding them', () => {
    const { report } = build('drive', { counts: { ...small, folder: 30 }, edges: { 'folder#parent:folder': { depth: 4, coverage: 1 } } })
    expect(report.warnings.join('\n')).toMatch(/folder#parent:folder: \d+ container\(s\) are shallower than the asked depth 4/)
  })

  it('gives a nested object every container its parent has, not only the first', () => {
    // One tenant, so drives and templates are picked freely: only inheritance can keep a tree together.
    const { tuples, report } = build('nested', { counts: { user: 200, group: 20, drive: 12, template: 9, folder: 900, document: 500 }, tenant: { type: null, count: 1 }, edges: { 'folder#parent:folder': { depth: 4, coverage: 1 } } })
    const parent = linkMap(tuples, 'folder', 'parent')
    const drive = linkMap(tuples, 'folder', 'drive')
    const template = linkMap(tuples, 'folder', 'template')
    expect(parent.size).toBeGreaterThan(800)
    expect(new Set(template.values()).size).toBeGreaterThan(3)
    for (const [child, p] of parent) {
      expect(drive.get(child)).toBe(drive.get(p))
      expect(template.get(child)).toBe(template.get(p))
    }
    expect(report.violationCount).toBe(0)
  })

  it('nests groups through usersets as a tree: child inside one parent', () => {
    const { tuples } = build('drive', { counts: small, edges: { 'group#member:group#member': { depth: 2, coverage: 1 } } })
    const parentOf = new Map<string, string>()
    for (const t of tuples) if (t.objectType === 'group' && t.userType === 'group') {
      expect(parentOf.has(`group:${t.userId}`)).toBe(false)
      parentOf.set(`group:${t.userId}`, objectOf(t))
    }
    expect(parentOf.size).toBeGreaterThan(50)
    for (const child of parentOf.keys()) expect(depthOf(parentOf, child)).toBeLessThanOrEqual(2)
  })

  it('level sizes always fill every level', () => {
    for (const [m, depth, branching] of [[1, 3, undefined], [2, 3, undefined], [4, 3, undefined], [50, 3, undefined], [50, 3, 4], [7, 6, 2], [1000, 5, undefined]] as const) {
      const sizes = levelSizes(m, depth, branching)
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(m)
      expect(sizes).toHaveLength(Math.min(depth, m - 1) + 1)
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(1)
      if (!branching && m > 1) expect(sizes[0]).toBe(1)
    }
  })
})

describe('tenancy', () => {
  it('keeps every tuple inside one organization by default', () => {
    const { tuples, report } = build('drive', { counts: small })
    const orgOfUser = new Map<string, string>()
    for (const t of tuples) if (t.objectType === 'organization' && t.relation === 'member') {
      expect(orgOfUser.has(userOf(t))).toBe(false)
      orgOfUser.set(userOf(t), objectOf(t))
    }
    const folderOrg = linkMap(tuples, 'folder', 'org')
    const groupOrg = linkMap(tuples, 'group', 'org')
    const docFolder = linkMap(tuples, 'document', 'folder')
    const orgOf = (object: string) => (object.startsWith('document:') ? folderOrg.get(docFolder.get(object)!) : object.startsWith('folder:') ? folderOrg.get(object) : object.startsWith('group:') ? groupOrg.get(object) : object)
    let checked = 0
    for (const t of tuples) {
      if (t.userId === '*' || t.userType === 'organization' || t.userType === 'folder') continue
      const subjectOrg = t.userType === 'user' ? orgOfUser.get(`user:${t.userId}`) : groupOrg.get(`group:${t.userId}`)
      expect(subjectOrg).toBe(orgOf(objectOf(t)))
      checked++
    }
    expect(checked).toBeGreaterThan(5_000)
    expect(report.edges.every((e) => e.crossTenant === 0)).toBe(true)
  })

  it('crosses tenants only on the edge that asks for it, at about the asked rate', () => {
    const { report } = build('drive', { counts: small, edges: { 'document#viewer:user': { crossTenant: 0.2 } } })
    const guests = edgeOf(report, 'document#viewer:user')
    expect(guests.crossTenant / guests.tuples).toBeGreaterThan(0.15)
    expect(guests.crossTenant / guests.tuples).toBeLessThan(0.25)
    expect(report.edges.filter((e) => e.crossTenant > 0).map((e) => e.key)).toEqual(['document#viewer:user'])
    expect(report.violationCount).toBe(0)
  })

  it('splits types the model does not tie to a tenant, unless they are listed as global', () => {
    const counts = { user: 400, organization: 8, group: 40, role: 40, resource: 800 }
    const orgsPerRole = (tuples: ReturnType<typeof build>['tuples']) => {
      const resourceOrg = linkMap(tuples, 'resource', 'org')
      const orgs = new Map<string, Set<string>>()
      for (const t of tuples) if (t.userType === 'role') orgs.set(t.userId, (orgs.get(t.userId) ?? new Set()).add(resourceOrg.get(objectOf(t))!))
      return Math.max(...[...orgs.values()].map((s) => s.size))
    }
    expect(resolve(model('rbac'), config('rbac', { counts })).plan.assumed).toEqual(['user', 'group', 'role'])
    expect(orgsPerRole(build('rbac', { counts }).tuples)).toBe(1)
    const shared = build('rbac', { counts, global: ['role', 'group', 'user'] })
    expect(orgsPerRole(shared.tuples)).toBeGreaterThan(1)
    expect(shared.report.violationCount).toBe(0)
  })

  it('follows containers upward: a project sits in its team\'s org', () => {
    // With no tenant type, orgs are picked freely, so the project's org can only come from its team.
    const { tuples } = build('gated', { counts: { user: 500, org: 10, team: 60, project: 300 }, tenant: { type: null, count: 1 } })
    const teamOrg = linkMap(tuples, 'team', 'org')
    const projectTeam = linkMap(tuples, 'project', 'team')
    const projectOrg = linkMap(tuples, 'project', 'org')
    expect(projectOrg.size).toBe(300)
    expect(new Set(teamOrg.values()).size).toBeGreaterThan(5)
    for (const [project, org] of projectOrg) expect(org).toBe(teamOrg.get(projectTeam.get(project)!))
  })

  it('can name objects with stable UUIDs', () => {
    const first = build('drive', { counts: small, ids: 'uuid' }, [3]).tuples
    expect(first.every((t) => t.userId === '*' || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(t.userId))).toBe(true)
    expect(build('drive', { counts: small, ids: 'uuid' }, [3]).tuples.map(line)).toEqual(first.map(line))
  })
})

describe('gates', () => {
  it('writes only subjects who pass the gate', () => {
    const { tuples, report } = build('gated', { counts: { user: 500, org: 10, team: 60, project: 300 } })
    const holders = (type: string, relation: string) => {
      const out = new Map<string, Set<string>>()
      for (const t of tuples) if (t.objectType === type && t.relation === relation) out.set(objectOf(t), (out.get(objectOf(t)) ?? new Set()).add(userOf(t)))
      return out
    }
    const orgMembers = holders('org', 'member')
    const teamMembers = holders('team', 'member')
    const teamOrg = linkMap(tuples, 'team', 'org')
    const projectTeam = linkMap(tuples, 'project', 'team')
    for (const [org, admins] of holders('org', 'admin')) for (const u of admins) expect(orgMembers.get(org)!.has(u)).toBe(true)
    for (const [team, members] of teamMembers) for (const u of members) expect(orgMembers.get(teamOrg.get(team)!)!.has(u)).toBe(true)
    for (const [team, leads] of holders('team', 'lead')) for (const u of leads) expect(teamMembers.get(team)!.has(u)).toBe(true)
    for (const [project, screened] of holders('project', 'screened')) for (const u of screened) expect(teamMembers.get(projectTeam.get(project)!)!.has(u)).toBe(true)
    expect(edgeOf(report, 'team#member:user').tuples).toBeGreaterThan(50)
    expect(edgeOf(report, 'team#lead:user').tuples).toBeGreaterThan(0)
    expect(edgeOf(report, 'project#screened:user').tuples).toBeGreaterThan(0)
  })
})

describe('wildcards and conditions', () => {
  const { tuples } = build('drive', { counts: small, edges: { 'document#viewer:user with in_office_hours': { context: { hour: 10 } } } })

  it('writes public grants only where the model allows them', () => {
    const publicGrants = tuples.filter((t) => t.userId === '*')
    expect(publicGrants.length).toBeGreaterThan(20)
    expect(publicGrants.every((t) => t.objectType === 'document' && (t.relation === 'viewer' || t.relation === 'public') && t.userType === 'user')).toBe(true)
  })

  it('writes conditional tuples with their condition and context, never doubling an unconditional one', () => {
    const conditional = tuples.filter((t) => t.condition)
    expect(conditional.length).toBeGreaterThan(500)
    expect(conditional.every((t) => t.condition === 'in_office_hours' && (t.relation === 'guest' || (t.relation === 'viewer' && t.context?.hour === 10)))).toBe(true)
    const keys = tuples.map((t) => `${userOf(t)} ${t.relation} ${objectOf(t)}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('asked versus realized', () => {
  it('counts per subject when asked: every user is in one to three groups', () => {
    const { tuples, report } = build('drive', { counts: small, edges: { 'group#member:user': { per: 'subject', count: { min: 1, max: 3 }, coverage: 1 } } })
    const groups = new Map<string, number>()
    for (const t of tuples) if (t.objectType === 'group' && t.relation === 'member' && t.userType === 'user') groups.set(t.userId, (groups.get(t.userId) ?? 0) + 1)
    // Users in an organization with no groups have nowhere to go; the report counts them.
    expect(groups.size + edgeOf(report, 'group#member:user').clipped).toBeGreaterThanOrEqual(small.user - 50)
    expect(Math.max(...groups.values())).toBeLessThanOrEqual(3)
    expect(edgeOf(report, 'group#member:user').per).toBe('subject')
  })

  it('fits the asked spread when pools are large, and says so when they are not', () => {
    const roomy = build('drive', { counts: { ...small, user: 60_000, group: 6_000 }, tenant: { type: 'organization', skew: 0 } })
    const fit = edgeOf(roomy.report, 'group#member:user')
    expect(fit.ks).toBeLessThan(0.05)
    expect(fit.count!.p50).toBeGreaterThanOrEqual(7)
    expect(fit.count!.p50).toBeLessThanOrEqual(9)
    const tight = build('drive', { counts: { ...small, user: 40 }, tenant: { type: 'organization', skew: 0 } })
    const clipped = edgeOf(tight.report, 'group#member:user')
    expect(clipped.clipped).toBeGreaterThan(0)
    expect(clipped.ks).toBeGreaterThan(0.1)
    expect(tight.report.warnings.join('\n')).toMatch(/group#member:user: realized counts are off the asked spread/)
  })

  it('reports the side that was not asked for', () => {
    const other = edgeOf(build('drive', { counts: small }).report, 'document#folder:folder').other!
    expect(other.of).toBe('folder')
    expect(other.pool).toBe(small.folder)
    expect(other.max).toBeGreaterThan(1)
  })

  it('picks unevenly when asked, exactly k distinct subjects either way', () => {
    const cum = new Float64Array(11)
    for (let j = 0; j < 10; j++) cum[j + 1] = cum[j] + (j === 0 ? 1_000 : 0.001)
    for (let i = 0; i < 50; i++) {
      const picks = pickDistinct(rngFor(1, 2, i), 100, 110, 6, cum)
      expect(new Set(picks).size).toBe(6)
      expect(picks).toContain(100)
      expect(picks.every((p) => p >= 100 && p < 110)).toBe(true)
    }
  })
})

describe('OpenFGA as referee', () => {
  const work = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-test-'))
  for (const [name, counts] of [
    ['drive', small],
    ['gated', { user: 500, org: 10, team: 60, project: 300 }],
    ['rbac', { user: 400, organization: 8, group: 40, role: 40, resource: 800 }],
  ] as const) {
    it(`agrees with the generator on a pilot of ${name}`, () => {
      const c = model(name)
      const verdict = verify(c, resolve(c, config(name, { counts })), { file: join(work, `${name}.fga.yaml`), maxTuples: 6_000, perType: 8 })
      expect(verdict.failures).toEqual([])
      expect(verdict.listUsers.total).toBeGreaterThan(20)
      expect(verdict.listUsers.passing).toBe(verdict.listUsers.total)
      expect(verdict.checks.passing).toBe(verdict.checks.total)
      expect(verdict.ok).toBe(true)
    })
  }

  it('fails when the store breaks a rule OpenFGA enforces', () => {
    const c = model('drive')
    const r = resolve(c, config('drive', { counts: small }))
    // A model that no longer allows public grants must reject the store that contains them.
    const strict = structuredClone(c.model)
    const viewer = strict.type_definitions.find((d: any) => d.type === 'document').metadata.relations.viewer
    viewer.directly_related_user_types = viewer.directly_related_user_types.filter((t: any) => !t.wildcard)
    const verdict = verify({ ...c, model: strict }, r, { file: join(work, 'strict.fga.yaml'), maxTuples: 6_000, perType: 4 })
    expect(verdict.ok).toBe(false)
  })
})
