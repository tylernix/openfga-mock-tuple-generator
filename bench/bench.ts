/**
 * Benchmarks for fga-tuple-gen, so anyone can check what it does and how fast.
 *
 *   npx tsx bench/bench.ts            everything
 *   npx tsx bench/bench.ts --quick    skips the 100M-tuple run
 *
 * Prints Markdown. Needs the OpenFGA CLI (`fga`) on the PATH. Every scale run writes its whole CSV to the temp
 * folder, re-reads it and deletes it; the 10x run is about 4.3 GB, so it needs about 4.5 GB free (--quick skips it).
 * Each scale run is a separate process, so its peak memory is its own. Nothing here is mocked: the checks read the
 * files the tool wrote, and OpenFGA answers the assertions.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'
import { cpus, platform, release, tmpdir, totalmem } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolve, scaled, type Config } from '../src/config.js'
import { generate } from '../src/generate.js'
import { compile, loadModel } from '../src/model.js'
import { fileSink } from '../src/output.js'
import { verify } from '../src/verify.js'
import { build, config, line, model, type Patch } from '../test/helpers.js'

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url))
/** The configs the scale runs use. They are real files, so anyone can run them: `build bench/gdrive.gen.json --scale 10`. */
const JOBS = {
  gdrive: here('./gdrive.gen.json'),
  simple: here('./simple.gen.json'),
  gated: here('./gated.gen.json'),
} as const
type JobName = keyof typeof JOBS
interface Job { name: JobName; factor: number }

/** A bench config file, compiled against its model and scaled the way `--scale` does. */
function loadJob(name: JobName, factor: number) {
  const file = JOBS[name]
  const cfg: Config = JSON.parse(readFileSync(file, 'utf8'))
  const modelPath = resolvePath(dirname(file), cfg.model)
  const c = compile(loadModel(modelPath))
  return { c, r: resolve(c, scaled(cfg, factor)), modelPath }
}

const num = (n: number) => Math.round(n).toLocaleString('en-US')
const md = (rows: string[][]) => [rows[0], rows[0].map(() => '---'), ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n')
let failed = false
const verdict = (ok: boolean) => {
  if (!ok) failed = true
  return ok ? 'PASS' : 'FAIL'
}

/** Every `object#relation@subject` shape the model allows, as it appears in a CSV row. */
function allowedKeys(model: any): Set<string> {
  const allowed = new Set<string>()
  for (const d of model.type_definitions) {
    for (const [rel, meta] of Object.entries<any>(d.metadata?.relations ?? {})) {
      for (const t of meta.directly_related_user_types ?? []) allowed.add(`${d.type}#${rel}@${t.type}#${t.relation ?? ''}`)
    }
  }
  return allowed
}

/** Reads a CSV in chunks, so a multi-gigabyte file needs no memory, and counts rows the model does not allow. */
function rereadCsv(path: string, allowed: Set<string>): { rows: number; notAllowed: number } {
  const fd = openSync(path, 'r')
  const buffer = Buffer.alloc(16 * 1024 * 1024)
  let carry = ''
  let lines = 0
  let notAllowed = 0
  const check = (line: string) => {
    if (lines++ === 0) return // the header
    const f = line.split(',', 6)
    if (!allowed.has(`${f[4]}#${f[3]}@${f[0]}#${f[2]}`)) notAllowed++
  }
  for (;;) {
    const n = readSync(fd, buffer, 0, buffer.length, null)
    if (!n) break
    const parts = (carry + buffer.toString('utf8', 0, n)).split('\n')
    carry = parts.pop()!
    for (const part of parts) check(part)
  }
  if (carry) check(carry)
  closeSync(fd)
  return { rows: lines - 1, notAllowed }
}

/** One generation run, in its own process: writes the whole CSV, then re-reads the file and deletes it. */
function child(job: Job) {
  const { c, r } = loadJob(job.name, job.factor)
  const dir = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-bench-'))
  const file = join(dir, 'store.csv')
  const sink = fileSink(file, 'csv')
  const started = Date.now()
  const report = generate(c, r, { sink })
  sink.close()
  const seconds = (Date.now() - started) / 1000
  const peakRssMb = Math.round(process.resourceUsage().maxRSS / 1024)
  const fileMb = Math.round(statSync(file).size / 1e6)
  const reread = rereadCsv(file, allowedKeys(c.model))
  const out = {
    tuples: report.tuples,
    tenants: r.tenants,
    seconds,
    peakRssMb,
    fileMb,
    rows: reread.rows,
    notAllowed: reread.notAllowed,
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
    { label: 'gdrive, 0.01x', job: { name: 'gdrive', factor: 0.01 } },
    { label: 'gdrive, 0.1x', job: { name: 'gdrive', factor: 0.1 } },
    { label: 'gdrive, 1x', job: { name: 'gdrive', factor: 1 } },
    ...(quick ? [] : [{ label: 'gdrive, 10x', job: { name: 'gdrive', factor: 10 } as Job }]),
    { label: 'simple, 1x', job: { name: 'simple', factor: 1 } },
    { label: 'simple, 10x', job: { name: 'simple', factor: 10 } },
    ...(quick ? [] : [
      { label: 'simple, 100x', job: { name: 'simple', factor: 100 } as Job },
      { label: 'simple, 300x', job: { name: 'simple', factor: 300 } as Job },
    ]),
    { label: 'gated, 1x', job: { name: 'gated', factor: 1 } },
  ]
  const rows = [['model, size', 'objects', 'tenants', 'tuples', 'seconds', 'tuples / second', 'peak memory (MB)', 'CSV size (MB)', 'rows re-read from the file', 'rows the model does not allow', 'rule violations', 'depth reached / asked']]
  for (const { label, job } of jobs) {
    process.stderr.write(`scale: ${label}\n`)
    const run = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--child', JSON.stringify(job)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    const last = run.stdout.trim().split('\n').pop() ?? ''
    if (run.status !== 0 || !last.startsWith('{')) {
      failed = true
      rows.push([label, 'failed', '', '', '', '', '', '', '', '', (run.stderr || run.stdout).trim().split('\n').pop()?.slice(0, 80) ?? '', ''])
      continue
    }
    const x = JSON.parse(last)
    if (x.violations || x.notAllowed || x.rows !== x.tuples) failed = true
    rows.push([label, num(x.objects), num(x.tenants), num(x.tuples), x.seconds.toFixed(1), num(x.tuples / x.seconds), num(x.peakRssMb), num(x.fileMb), num(x.rows), num(x.notAllowed), String(x.violations), x.depth || '-'])
  }
  console.log('## Scale and speed\n')
  console.log(md(rows))
  console.log('\nEvery row writes the whole CSV to disk, then re-reads the file line by line and counts the rows. The file is deleted afterwards. Seconds include writing the file. Each row is a new process.\n')
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
  const { c, r } = loadJob('gdrive', 0.1)
  const dir = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-bench-'))
  const path = join(dir, 'store.csv')
  const sink = fileSink(path, 'csv')
  const asked = 3
  generate(c, r, { sink })
  sink.close()

  const allowed = allowedKeys(c.model)
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

/** The simple config: re-reads its CSV with code that shares nothing with the generator and checks what the model promises. */
function auditSimple() {
  const { c, r } = loadJob('simple', 1)
  const dir = mkdtempSync(join(tmpdir(), 'fga-tuple-gen-bench-'))
  const path = join(dir, 'store.csv')
  const sink = fileSink(path, 'csv')
  generate(c, r, { sink })
  sink.close()

  const allowed = allowedKeys(c.model)
  const rows = readFileSync(path, 'utf8').split('\n')
  rows.shift()
  while (rows.length && !rows[rows.length - 1]) rows.pop()

  let invalid = 0
  const memberOf = new Map<string, Set<string>>()
  const orgOfDoc = new Map<string, string>()
  const owners = new Map<string, number>()
  const viewers = new Map<string, number>()
  const ownerOrgChecks: [string, string][] = []
  const viewerOrgChecks: [string, string][] = []
  const docsPerOrg = new Map<string, number>()
  for (const row of rows) {
    const [ut, uid, ur, rel, ot, oid] = row.split(',')
    if (!allowed.has(`${ot}#${rel}@${ut}#${ur}`)) invalid++
    if (ot === 'organization' && rel === 'member') memberOf.set(`user:${uid}`, (memberOf.get(`user:${uid}`) ?? new Set()).add(oid))
    else if (ot === 'document' && rel === 'org') {
      orgOfDoc.set(oid, uid)
      docsPerOrg.set(uid, (docsPerOrg.get(uid) ?? 0) + 1)
    } else if (ot === 'document' && rel === 'owner') {
      owners.set(oid, (owners.get(oid) ?? 0) + 1)
      ownerOrgChecks.push([uid, oid])
    } else if (ot === 'document' && rel === 'viewer') {
      viewers.set(oid, (viewers.get(oid) ?? 0) + 1)
      viewerOrgChecks.push([uid, oid])
    }
  }
  const outside = (checks: [string, string][]) => checks.filter(([user, doc]) => !memberOf.get(`user:${user}`)?.has(orgOfDoc.get(doc) ?? '')).length
  const docs = r.counts.document
  const notOneOwner = [...owners.values()].filter((n) => n !== 1).length + (docs - owners.size)
  const shared = viewers.size / docs
  const sizes = [...docsPerOrg.values()].sort((a, b) => b - a)
  rmSync(dir, { recursive: true, force: true })

  const out = [['check, on the simple file written at 1x', 'result', 'detail']]
  out.push(['every tuple is a type restriction the model allows', verdict(invalid === 0), `${num(rows.length)} tuples read, ${invalid} not allowed`])
  out.push(['every document has exactly one owner', verdict(notOneOwner === 0), `${num(docs)} documents, ${num(notOneOwner)} without exactly one`])
  out.push(['every document is in exactly one organization', verdict(orgOfDoc.size === docs && docsPerOrg.size <= r.counts.organization), `${num(orgOfDoc.size)} of ${num(docs)} documents have one`])
  out.push(['every owner is a member of the document\'s organization', verdict(outside(ownerOrgChecks) === 0 && ownerOrgChecks.length > 0), `${num(outside(ownerOrgChecks))} of ${num(ownerOrgChecks.length)} owners are not`])
  out.push(['every direct viewer is a member of the document\'s organization', verdict(outside(viewerOrgChecks) === 0 && viewerOrgChecks.length > 0), `${num(outside(viewerOrgChecks))} of ${num(viewerOrgChecks.length)} viewers are not`])
  out.push(['about 30% of documents are shared with direct viewers, as asked', verdict(Math.abs(shared - 0.3) < 0.01), `${(shared * 100).toFixed(1)}% of documents`])
  out.push(['organizations differ in size (skew 1)', verdict(sizes.length > 1 && sizes[0] > 10 * sizes[sizes.length - 1]), `largest ${num(sizes[0])} documents, smallest ${num(sizes[sizes.length - 1])}`])
  console.log('## Independent check of the simple output file\n')
  console.log(md(out))
  console.log('\nThe simple config is the one in the README. This re-reads its CSV and checks, from the tuples alone, what the model and the config promise.\n')
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
  const row = (label: string, v: ReturnType<typeof verify>, started: number) => rows.push([label, num(v.tuples), String(v.tenants.length), `${v.listUsers.passing + v.incomplete}/${v.listUsers.total}`, `${v.checks.passing}/${v.checks.total}`, String(v.skipped), ((Date.now() - started) / 1000).toFixed(1), verdict(v.ok)])
  {
    // The README's simple config, as the benchmark file has it.
    const { c, r } = loadJob('simple', 1)
    const started = Date.now()
    row('simple (the README example)', verify(c, r, { dir: join(work, 'simple'), maxTuples: 20_000, perType: 10 }), started)
  }
  for (const [i, cs] of cases.entries()) {
    const c = model(cs.name)
    const started = Date.now()
    row(cs.label, verify(c, resolve(c, config(cs.name, cs.patch)), { dir: join(work, String(i)), maxTuples: cs.max, perType: 10 }), started)
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
  auditSimple()
  referee()
  scale(quick)
  if (failed) {
    console.log('**A check failed.**')
    process.exitCode = 1
  }
}
