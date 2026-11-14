/**
 * Benchmarks for fga-tuple-gen, so anyone can check what it does and how fast.
 *
 *   npx tsx bench/bench.ts            everything
 *   npx tsx bench/bench.ts --quick    skips the 100M-tuple run
 *
 * Prints Markdown. Needs the OpenFGA CLI (`fga`) on the PATH. Each scale run is a separate process, so its
 * peak memory is its own. Nothing here is mocked: the checks read the files the tool wrote, and OpenFGA
 * answers the assertions.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultConfig, resolve, scaled } from '../src/config.js'
import { generate } from '../src/generate.js'
import { compile, loadModel } from '../src/model.js'
import { fileSink } from '../src/output.js'
import { verify } from '../src/verify.js'
import { build, config, line, model, type Patch } from '../test/helpers.js'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
const JOBS = {
  gdrive: { model: here('./models/gdrive.fga'), base: { user: 200_000, organization: 500, group: 20_000, folder: 150_000, document: 2_000_000 } },
  gated: { model: here('../test/fixtures/gated.fga'), base: { user: 100_000, org: 200, team: 10_000, project: 100_000 } },
} as const
type JobName = keyof typeof JOBS
interface Job { name: JobName; factor: number; sink: 'file' | 'discard' }

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const md = (rows: string[][]) => [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n')
let failed = false
const verdict = (ok: boolean) => {
  if (!ok) failed = true
  return ok ? 'PASS' : 'FAIL'
}

/** One generation run, in its own process. */
function child(job: Job) {
  const spec = JOBS[job.name]
  const c = compile(loadModel(spec.model))
  const cfg = scaled({ ...defaultConfig(c, spec.model), counts: { ...spec.base } }, job.factor)
  const r = resolve(c, cfg)
  const dir = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-bench-'))
  const file = job.sink === 'file' ? join(dir, 'store.csv') : '/dev/null'
  const sink = fileSink(file, 'csv')
  const started = Date.now()
  const report = generate(c, r, { sink })
  sink.close()
  const seconds = (Date.now() - started) / 1000
  const out = {
    tuples: report.tuples,
    tenants: r.tenants,
    seconds,
    peakRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    fileMb: job.sink === 'file' ? Math.round(statSync(file).size / 1e6) : undefined,
    violations: report.violationCount,
    depth: report.edges.filter((e) => e.depth).map((e) => `${e.depth!.max}/${e.depth!.asked}`).join(', '),
    objects: Object.values(r.counts).reduce((a, b) => a + b, 0),
  }
  rmSync(dir, { recursive: true, force: true })
  console.log(JSON.stringify(out))
}

function environment() {
  const version = spawnSync('fga', ['--version'], { encoding: 'utf8' }).stdout.match(/v`?([\d.]+)/)?.[1] ?? 'unknown'
  const cpu = cpus()
  console.log(`## Environment\n\n- ${cpu[0].model}, ${cpu.length} cores, ${Math.round(totalmem() / 2 ** 30)} GB RAM`)
  console.log(`- ${platform()} ${release()}, Node ${process.version}, OpenFGA CLI ${version}`)
  console.log(`- ${new Date().toISOString().slice(0, 10)}. One run each; speeds vary by a few percent between runs.\n`)
}

function scale(quick: boolean) {
  const jobs: { label: string; job: Job }[] = [
    { label: 'gdrive, 0.01x', job: { name: 'gdrive', factor: 0.01, sink: 'file' } },
    { label: 'gdrive, 0.1x', job: { name: 'gdrive', factor: 0.1, sink: 'file' } },
    { label: 'gdrive, 1x', job: { name: 'gdrive', factor: 1, sink: 'file' } },
    { label: 'gdrive, 1x', job: { name: 'gdrive', factor: 1, sink: 'discard' } },
    ...(quick ? [] : [{ label: 'gdrive, 10x', job: { name: 'gdrive', factor: 10, sink: 'discard' } as Job }]),
    { label: 'gated, 1x', job: { name: 'gated', factor: 1, sink: 'file' } },
  ]
  const rows = [['model, size', 'output', 'objects', 'tenants', 'tuples', 'seconds', 'tuples / second', 'peak memory (MB)', 'file (MB)', 'rule violations', 'depth reached / asked']]
  for (const { label, job } of jobs) {
    process.stderr.write(`scale: ${label} (${job.sink})\n`)
    const run = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', JSON.stringify(job)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const last = run.stdout.trim().split('\n').pop() ?? ''
    if (run.status !== 0 || !last.startsWith('{')) {
      failed = true
      rows.push([label, job.sink, 'failed', '', '', '', '', '', '', '', (run.stderr || run.stdout).trim().split('\n').pop()?.slice(0, 80) ?? '', ''])
      continue
    }
    const x = JSON.parse(last)
    if (x.violations) failed = true
    rows.push([label, job.sink === 'file' ? 'CSV file' : '/dev/null', num(x.objects), num(x.tenants), num(x.tuples), x.seconds.toFixed(1), num(x.tuples / x.seconds), num(x.peakRssMb), x.fileMb === undefined ? '-' : num(x.fileMb), String(x.violations), x.depth || '-'])
  }
  console.log('## Scale and speed\n')
  console.log(md(rows))
  console.log('\n"/dev/null" means the tuples were generated and formatted as CSV, then written to /dev/null: generation without the disk. Each row is a new process.\n')
}

const hash = (lines: string[]) => createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)

function determinism() {
  const small = { user: 600, organization: 12, group: 120, folder: 600, document: 3_000 }
  const full = build('drive', { counts: small })
  const rows = [['check', 'result', 'detail']]
  const again = build('drive', { counts: small })
  rows.push(['same config twice writes the same store', verdict(hash(full.lines) === hash(again.lines)), `sha256 ${hash(full.lines)} both times, ${num(full.lines.length)} tuples`])
  const other = build('drive', { counts: small, seed: 2 })
  rows.push(['a different seed writes a different store', verdict(hash(full.lines) !== hash(other.lines)), `sha256 ${hash(other.lines)}`])
  let alone = 0
  let identical = true
  for (let t = 0; t < 12; t++) {
    const solo = build('drive', { counts: small }, [t]).lines
    alone += solo.length
    identical &&= hash(solo) === hash(full.tuples.filter((x) => x.tenant === t).map(line))
  }
  rows.push(['each tenant built alone is exactly its slice of the full store', verdict(identical), `12 tenants, ${num(alone)} tuples`])
  const reversed = build('drive', { counts: small }, Array.from({ length: 12 }, (_, t) => 11 - t)).lines
  rows.push(['tenants can be built in any order', verdict(hash([...reversed].sort()) === hash([...full.lines].sort())), 'tenants 11 down to 0, compared as sets'])
  const edited = build('drive', { counts: small, edges: { 'folder#viewer:user': { count: { min: 5, max: 9 }, coverage: 1 } } })
  const others = (tuples: typeof full.tuples) => hash(tuples.filter((t) => !(t.objectType === 'folder' && t.relation === 'viewer' && !t.userRelation)).map(line))
  rows.push(["changing one edge's settings changes no other edge's tuples", verdict(others(full.tuples) === others(edited.tuples)), `folder#viewer:user went from ${num(full.report.edges.find((e) => e.key === 'folder#viewer:user')!.tuples)} to ${num(edited.report.edges.find((e) => e.key === 'folder#viewer:user')!.tuples)} tuples`])
  console.log('## Determinism\n')
  console.log(md(rows))
  console.log()
}

/** Re-reads the CSV with code that shares nothing with the generator and checks it against the model. */
function auditFile() {
  const modelPath = JOBS.gdrive.model
  const c = compile(loadModel(modelPath))
  const dir = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-bench-'))
  const path = join(dir, 'store.csv')
  const sink = fileSink(path, 'csv')
  const asked = 3
  const cfg = scaled({ ...defaultConfig(c, modelPath), counts: { ...JOBS.gdrive.base } }, 0.1)
  generate(c, resolve(c, cfg), { sink })
  sink.close()

  const allowed = new Set<string>()
  for (const d of c.model.type_definitions) {
    for (const [rel, meta] of Object.entries<any>(d.metadata?.relations ?? {})) {
      for (const t of meta.directly_related_user_types ?? []) allowed.add(`${d.type}#${rel}@${t.type}#${t.relation ?? ''}`)
    }
  }
  const rows = readFileSync(path, 'utf8').split('\n')
  rows.shift()
  while (rows.length && !rows[rows.length - 1]) rows.pop()

  const seen = new Set<string>()
  let invalid = 0
  let duplicates = 0
  const orgsOfUser = new Map<string, Set<string>>()
  const groupOrg = new Map<string, string>()
  const folderOrg = new Map<string, string>()
  const docFolder = new Map<string, string>()
  const folderParent = new Map<string, string>()
  const groupParent = new Map<string, string>()
  for (const row of rows) {
    const [ut, uid, ur, rel, ot, oid] = row.split(',')
    if (!allowed.has(`${ot}#${rel}@${ut}#${ur}`)) invalid++
    if (seen.has(row)) duplicates++
    else seen.add(row)
    if (ot === 'organization' && rel === 'member') orgsOfUser.set(`user:${uid}`, (orgsOfUser.get(`user:${uid}`) ?? new Set()).add(`organization:${oid}`))
    else if (ot === 'group' && rel === 'org') groupOrg.set(`group:${oid}`, `organization:${uid}`)
    else if (ot === 'folder' && rel === 'org') folderOrg.set(`folder:${oid}`, `organization:${uid}`)
    else if (ot === 'document' && rel === 'folder') docFolder.set(`document:${oid}`, `folder:${uid}`)
    else if (ot === 'folder' && rel === 'parent') folderParent.set(`folder:${oid}`, `folder:${uid}`)
    else if (ot === 'group' && rel === 'member' && ut === 'group') groupParent.set(`group:${uid}`, `group:${oid}`)
  }
  seen.clear()

  const depthOf = (parents: Map<string, string>) => {
    const depth = new Map<string, number>()
    let max = 0
    let cycles = 0
    for (const start of parents.keys()) {
      const chain: string[] = []
      let at: string | undefined = start
      while (at !== undefined && !depth.has(at) && chain.length <= parents.size) {
        chain.push(at)
        at = parents.get(at)
      }
      if (at !== undefined && !depth.has(at)) {
        cycles++
        continue
      }
      let d = at === undefined ? -1 : depth.get(at)!
      for (let i = chain.length - 1; i >= 0; i--) depth.set(chain[i], ++d)
    }
    for (const d of depth.values()) max = Math.max(max, d)
    return { max, cycles }
  }
  const folders = depthOf(folderParent)
  const groups = depthOf(groupParent)
  let outside = 0
  for (const [child, parent] of folderParent) if (folderOrg.get(child) !== folderOrg.get(parent)) outside++
  for (const [child, parent] of groupParent) if (groupOrg.get(child) !== groupOrg.get(parent)) outside++

  const orgOf = (object: string) => {
    const type = object.slice(0, object.indexOf(':'))
    return type === 'organization' ? object : type === 'group' ? groupOrg.get(object) : type === 'folder' ? folderOrg.get(object) : folderOrg.get(docFolder.get(object) ?? '')
  }
  let checked = 0
  let crossing = 0
  for (const row of rows) {
    const [ut, uid, , , ot, oid] = row.split(',')
    if (ut !== 'user' && ut !== 'group') continue
    const subjectOrg = ut === 'user' ? [...(orgsOfUser.get(`user:${uid}`) ?? [])][0] : groupOrg.get(`group:${uid}`)
    checked++
    if (subjectOrg !== orgOf(`${ot}:${oid}`)) crossing++
  }
  const multi = [...orgsOfUser.values()].filter((s) => s.size > 1).length
  rmSync(dir, { recursive: true, force: true })

  const out = [['check, on the file written at 0.1x', 'result', 'detail']]
  out.push(['every tuple is a type restriction the model allows', verdict(invalid === 0), `${num(rows.length)} tuples read, ${invalid} not allowed`])
  out.push(['no tuple written twice', verdict(duplicates === 0), `${duplicates} duplicates`])
  out.push([`folder trees no deeper than the asked ${asked}, no cycles`, verdict(folders.max <= asked && folders.max > 0 && !folders.cycles), `deepest ${folders.max}, ${folders.cycles} cycles, ${num(folderParent.size)} nested folders`])
  out.push([`group trees no deeper than the asked ${asked}, no cycles`, verdict(groups.max <= asked && groups.max > 0 && !groups.cycles), `deepest ${groups.max}, ${groups.cycles} cycles, ${num(groupParent.size)} nested groups`])
  out.push(['every nested object is in the same organization as its parent', verdict(outside === 0), `${outside} of ${num(folderParent.size + groupParent.size)} parents outside`])
  out.push(['every user and group sits in the organization of the object it is written on', verdict(crossing === 0 && checked > 0), `${crossing} of ${num(checked)} tuples cross organizations`])
  out.push(['every user is in one organization', verdict(multi === 0), `${multi} users in two or more`])
  console.log('## Independent check of the output file\n')
  console.log(md(out))
  console.log('\nThis re-reads the CSV and derives everything from the tuples and the model JSON. It uses none of the generator\'s own reports.\n')
}

function referee() {
  const work = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-bench-'))
  const cases: { name: string; label: string; patch: Patch; max: number }[] = [
    { name: 'drive', label: 'drive (wildcards, conditions, nesting)', patch: { counts: { user: 600, organization: 12, group: 120, folder: 600, document: 3_000 } }, max: 6_000 },
    { name: 'gated', label: 'gated (intersections, exclusions)', patch: { counts: { user: 500, org: 10, team: 60, project: 300 } }, max: 6_000 },
    { name: 'rbac', label: 'rbac (roles with no org link)', patch: { counts: { user: 400, organization: 8, group: 40, role: 40, resource: 800 } }, max: 6_000 },
    { name: 'nested', label: 'nested (two containers per folder)', patch: { counts: { user: 200, group: 20, drive: 12, template: 9, folder: 900, document: 500 }, tenant: { type: null, count: 1 } }, max: 6_000 },
    { name: 'drive', label: 'drive, larger pilot', patch: { counts: { user: 6_000, organization: 40, group: 1_200, folder: 6_000, document: 30_000 } }, max: 60_000 },
  ]
  const rows = [['model', 'pilot tuples', 'tenants', 'ListUsers', 'Check', 'not asserted', 'seconds', 'result']]
  for (const [i, cs] of cases.entries()) {
    const c = model(cs.name)
    const started = Date.now()
    const v = verify(c, resolve(c, config(cs.name, cs.patch)), { dir: join(work, String(i)), maxTuples: cs.max, perType: 10 })
    rows.push([cs.label, num(v.tuples), String(v.tenants.length), `${v.listUsers.passing + v.incomplete}/${v.listUsers.total}`, `${v.checks.passing}/${v.checks.total}`, String(v.skipped), ((Date.now() - started) / 1000).toFixed(1), verdict(v.ok)])
  }
  console.log('## OpenFGA agrees\n')
  console.log(md(rows))
  console.log('\nThe pilot is whole tenants, exactly as in the full store, loaded into the CLI\'s in-memory OpenFGA (`fga model test`). OpenFGA answers ListUsers and Check on a spread of objects and must match what the generator\'s own evaluator says. "Not asserted" answers read a condition or a public grant, or list more than 200 users.\n')
  rmSync(work, { recursive: true, force: true })
}

if (process.argv[2] === '--child') child(JSON.parse(process.argv[3]))
else {
  const quick = process.argv.includes('--quick')
  console.log('# fga-tuple-gen benchmarks\n')
  environment()
  determinism()
  auditFile()
  referee()
  scale(quick)
  if (failed) {
    console.log('**A check failed.**')
    process.exitCode = 1
  }
}
