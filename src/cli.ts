#!/usr/bin/env -S npx tsx
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultConfig, resolve, scaled, type Config } from './config.js'
import { generate, layout, project } from './generate.js'
import { compile, loadModel, modelDsl } from './model.js'
import { fileSink, type Format } from './output.js'
import { formatPlan, formatReport, formatVerdict } from './report.js'
import { verify } from './verify.js'

const USAGE = `fga-tuple-gen: mock tuple stores for any OpenFGA model

  init <model.fga|model.json> [--out gen.json] [--interactive]
      Writes a config with every type and edge, defaults filled in, and the question each edge answers.
  plan <gen.json> [--scale 0.01]
      Tenants, projected tuples per edge and warnings. Writes nothing.
  build <gen.json> --out <file> [--format csv|jsonl|yaml] [--tenants 0,3,9] [--scale 0.01] [--report report.json]
      Streams the store to a file and prints asked versus realized. Exits 1 if a rule is broken.
  verify <gen.json> [--max-tuples 20000] [--scale 0.01] [--keep <dir>]
      Loads a pilot (whole tenants of the full store) into OpenFGA's in-memory server and compares answers.
`

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) positional.push(argv[i])
    else if (argv[i].includes('=')) flags.set(argv[i].slice(2, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1))
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(argv[i].slice(2), argv[++i])
    else flags.set(argv[i].slice(2), 'true')
  }
  return { positional, flags }
}

function load(configPath: string, flags: Map<string, string>) {
  if (!configPath) throw new Error('missing the config file')
  let cfg: Config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (flags.has('scale')) cfg = scaled(cfg, Number(flags.get('scale')))
  if (typeof cfg.model !== 'string') throw new Error('the config needs "model": a path to the model file')
  const modelPath = resolvePath(dirname(configPath), cfg.model)
  const model = loadModel(modelPath)
  const compiled = compile(model)
  return { cfg, compiled, resolved: resolve(compiled, cfg), modelPath }
}

async function interview(cfg: Config, types: string[], nesting: string[]): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (question: string, fallback: string) => (await rl.question(`${question} [${fallback}]: `)).trim() || fallback
  try {
    const tenant = await ask(`Which type is a tenant (an organization, a site)? One of ${types.join(', ')}, or "none"`, cfg.tenant?.type ?? 'none')
    if (tenant === 'none') cfg.tenant = { type: null, count: Number(await ask('How many separate tenants should the store be split into?', '1')), skew: cfg.tenant?.skew ?? 1 }
    else cfg.tenant = { type: tenant, skew: cfg.tenant?.skew ?? 1 }
    for (const type of types) cfg.counts[type] = Number(await ask(`How many ${type} objects in the whole store?`, String(cfg.counts[type])))
    for (const key of nesting) cfg.edges![key].depth = Number(await ask(`${key}: how many levels below a top-level object, at most?`, String(cfg.edges![key].depth ?? 3)))
  } finally {
    rl.close()
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  if (!command || command === 'help' || flags.has('help')) return void console.log(USAGE)

  if (command === 'init') {
    const modelPath = positional[0]
    if (!modelPath) throw new Error('init needs a model file')
    const out = flags.get('out') ?? 'gen.json'
    if (existsSync(out) && !flags.has('force')) throw new Error(`${out} already exists; pass --force to overwrite it`)
    const compiled = compile(loadModel(modelPath))
    const cfg = defaultConfig(compiled, relative(dirname(resolvePath(out)), resolvePath(modelPath)) || basename(modelPath))
    if (flags.has('interactive')) await interview(cfg, compiled.types, compiled.edges.filter((e) => e.kind === 'nesting').map((e) => e.key))
    resolve(compiled, cfg)
    writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n')
    console.log(`Wrote ${out}: ${compiled.types.length} types, ${compiled.edges.length} edges. Edit the counts and edges, then run plan.`)
    return
  }

  if (command === 'plan') {
    const { compiled, resolved } = load(positional[0], flags)
    const lay = layout(compiled, resolved)
    console.log(formatPlan(compiled, resolved, lay, project(compiled, resolved, lay)))
    return
  }

  if (command === 'build') {
    const { compiled, resolved, modelPath } = load(positional[0], flags)
    const out = flags.get('out')
    if (!out) throw new Error('build needs --out <file>')
    const format = (flags.get('format') ?? (out.endsWith('.yaml') ? 'yaml' : out.endsWith('.jsonl') ? 'jsonl' : 'csv')) as Format
    if (!['csv', 'jsonl', 'yaml'].includes(format)) throw new Error('--format must be csv, jsonl or yaml')
    const tenants = flags.get('tenants')?.split(',').map(Number)
    const sink = fileSink(out, format, format === 'yaml' ? { name: basename(modelPath), dsl: modelDsl(compiled.model) } : undefined)
    const report = generate(compiled, resolved, { sink, ...(tenants ? { tenants } : {}) })
    sink.close()
    if (flags.has('report')) writeFileSync(flags.get('report')!, JSON.stringify(report, null, 2) + '\n')
    console.log(formatReport(report))
    console.log(`\nWrote ${out}. Run verify to have OpenFGA check a pilot of this store.`)
    if (report.violationCount) process.exitCode = 1
    return
  }

  if (command === 'verify') {
    const { compiled, resolved } = load(positional[0], flags)
    const dir = flags.get('keep') ?? mkdtempSync(join(tmpdir(), 'fga-tuple-gen-pilot-'))
    const verdict = verify(compiled, resolved, { dir, ...(flags.has('max-tuples') ? { maxTuples: Number(flags.get('max-tuples')) } : {}) })
    console.log(formatVerdict(verdict))
    if (!verdict.ok) process.exitCode = 1
    return
  }

  throw new Error(`unknown command "${command}"\n\n${USAGE}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
