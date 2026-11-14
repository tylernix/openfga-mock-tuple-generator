#!/usr/bin/env -S npx tsx
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve as resolvePath } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { defaultConfig, resolve, scaled, type Config } from './config.js'
import { generate, layout, project } from './generate.js'
import { compile, loadModel, modelDsl, type Compiled } from './model.js'
import { inDir, latestConfig, newPlanId, OUTPUT_DIR, planId, runDir } from './names.js'
import { fileSink, type Format } from './output.js'
import { parseCount, select } from './prompt.js'
import { formatPlan, formatReport, formatVerdict } from './report.js'
import { suggestTenant } from './tenants.js'
import { verify } from './verify.js'

const USAGE = `fga-tuple-gen: mock tuple stores for any OpenFGA model

  init <model.fga|model.json> [--out <file>] [--skip] [--force]
      Asks a few questions, then writes a config with every type and edge, defaults filled in, and the question each edge answers.
      --skip asks nothing and writes every default.
      The config goes in its own folder, output/<date>-<time>/<date>-<time>.gen.json, like output/20261113-0936/20261113-0936.gen.json,
      unless you pass --out.
  plan [config.gen.json] [--scale 0.01]
      Tenants, projected tuples per edge and warnings. Writes nothing.
  build [config.gen.json] [--out <file>] [--format csv|jsonl|yaml] [--tenants 0,3,9] [--scale 0.01] [--report <file>]
      Streams the store to <config id>.tuples.csv in the config's folder and prints what was realized per edge.
      The full report (what was asked, the other side, clipped counts) is written beside it as <config id>.report.json.
      Exits 1 if a rule is broken.
  verify [config.gen.json] [--max-tuples 20000] [--scale 0.01] [--out <file>]
      Loads a pilot (whole tenants of the full store) into OpenFGA's in-memory server and compares answers.
      The test file it loads is kept as <config id>.pilot.fga.yaml in the config's folder.

  Everything built from a config goes in output/<config id>/. A bare name after --out or --report lands there;
  a path with a folder is used as given.
  plan, build and verify use the newest config in output/ (then in this folder) when you do not name one.
`

// Flags that never take a value, so `init --skip model.fga` keeps model.fga as the model.
const SWITCHES = new Set(['skip', 'force', 'help'])

function parseArgs(argv: string[]) {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) positional.push(argv[i])
    else if (argv[i].includes('=')) flags.set(argv[i].slice(2, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1))
    else if (!SWITCHES.has(argv[i].slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags.set(argv[i].slice(2), argv[++i])
    else flags.set(argv[i].slice(2), 'true')
  }
  return { positional, flags }
}

/** The config a command reads: the one named, or else the newest in output/. Says which, so it is never a surprise. */
function configArg(positional: string[]): string {
  const named = positional[0]
  // A bare name that is not here is looked for where init puts configs: its own folder in output/.
  if (named) return [named, join(runDir(named), named), join(OUTPUT_DIR, named)].find((p) => existsSync(p)) ?? named
  const found = latestConfig()
  if (!found) throw new Error(`no config file. Name one, or run init first to write one in ${OUTPUT_DIR}/.`)
  console.log(`Using ${found}`)
  return found
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

async function interview(cfg: Config, c: Compiled): Promise<void> {
  const types = c.types
  const nesting = c.edges.filter((e) => e.kind === 'nesting').map((e) => e.key)
  const terminal = !!(process.stdin.isTTY && process.stdout.isTTY)
  let rl: ReturnType<typeof createInterface> | undefined
  let lines: AsyncIterator<string> | undefined
  const ask = async (question: string, fallback: string) => {
    // One line per question. `rl.question` drops lines that arrive before it is called, which loses piped answers.
    if (!rl) {
      rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
      lines = rl[Symbol.asyncIterator]()
    }
    process.stdout.write(`${question} [default: ${fallback}]: `)
    const next = await lines!.next()
    const answer = next.done ? '' : next.value.trim()
    // A terminal echoes what you type; piped answers are echoed so the transcript reads.
    if (next.done || !process.stdin.isTTY) process.stdout.write(`${answer || fallback}\n`)
    return answer || fallback
  }
  const askNumber = async (question: string, fallback: number): Promise<number> => {
    for (;;) {
      const answer = await ask(question, fallback.toLocaleString('en-US'))
      const n = parseCount(answer)
      if (n !== undefined) return n
      const message = `"${answer}" is not a whole number.`
      if (!terminal) throw new Error(message)
      console.log(`  ${message} Try again, for example 5000 or 5,000.`)
    }
  }

  console.log(terminal ? 'Use the arrow keys and Enter to choose. For numbers, type one, or press Enter to use the [default: ...] shown.' : 'Answer each question, or press Enter to use the [default: ...] shown.')
  console.log('The shape of each relation (how many per object) is left at its default: edit "edges" in the file it writes.\n')
  try {
    // Types with no relations (users) cannot contain anything, so they are not offered.
    const candidates = types.filter((t) => Object.keys(c.model.type_definitions.find((d: any) => d.type === t)?.relations ?? {}).length)
    const suggestion = suggestTenant(c)
    let tenant: string
    if (terminal) {
      const choices = [
        ...candidates.map((label) => ({ label, ...(label === suggestion.type ? { hint: `suggested: ${suggestion.reason}` } : {}) })),
        { label: 'none', hint: 'one store; you choose how many tenants to split it into' },
      ]
      const start = suggestion.type && candidates.includes(suggestion.type) ? candidates.indexOf(suggestion.type) : choices.length - 1
      const picked = await select('Which type is a tenant? (an organization, a site)', choices, start)
      tenant = picked === candidates.length ? 'none' : candidates[picked]
    } else {
      tenant = await ask(`Which type is a tenant (an organization, a site)? One of ${candidates.join(', ')}, or "none"`, cfg.tenant?.type ?? 'none')
      if (tenant !== 'none' && !candidates.includes(tenant)) throw new Error(`"${tenant}" cannot be a tenant. Choose one of: ${candidates.join(', ')}, none.`)
    }
    if (tenant === 'none') cfg.tenant = { type: null, count: await askNumber('How many separate tenants should the store be split into?', 1), skew: cfg.tenant?.skew ?? 1 }
    else cfg.tenant = { type: tenant, skew: cfg.tenant?.skew ?? 1 }
    for (const type of types) cfg.counts[type] = await askNumber(`How many ${type} objects in the whole store?`, cfg.counts[type])
    for (const key of nesting) cfg.edges![key].depth = await askNumber(`${key}: how many levels below a top-level object, at most?`, cfg.edges![key].depth ?? 3)
  } finally {
    rl?.close()
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const { positional, flags } = parseArgs(rest)
  if (!command || command === 'help' || flags.has('help')) return void console.log(USAGE)

  if (command === 'init') {
    const modelPath = positional[0]
    if (!modelPath) throw new Error('init needs a model file')
    const given = flags.get('out')
    const id = given ? '' : newPlanId()
    const out = given ? inDir(given, runDir(given)) : join(OUTPUT_DIR, id, `${id}.gen.json`)
    if (existsSync(out) && !flags.has('force')) throw new Error(`${out} already exists; pass --force to overwrite it`)
    const compiled = compile(loadModel(modelPath))
    const cfg = defaultConfig(compiled, relative(dirname(resolvePath(out)), resolvePath(modelPath)) || basename(modelPath))
    const ask = !flags.has('skip')
    if (ask) await interview(cfg, compiled)
    resolve(compiled, cfg)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n')
    console.log(`${ask ? '\n' : ''}Wrote ${out}: ${compiled.types.length} types, ${compiled.edges.length} edges.`)
    console.log(
      flags.has('out')
        ? `Next: npx tsx src/cli.ts plan ${out}   (then verify, then build). Edit its counts and edges any time.`
        : `Next: npx tsx src/cli.ts plan   (then verify, then build). They use ${out}, the newest config. Edit its counts and edges any time.`,
    )
    return
  }

  if (command === 'plan') {
    const { compiled, resolved } = load(configArg(positional), flags)
    const lay = layout(compiled, resolved)
    console.log(formatPlan(compiled, resolved, lay, project(compiled, resolved, lay)))
    return
  }

  if (command === 'build') {
    const configPath = configArg(positional)
    const { compiled, resolved, modelPath } = load(configPath, flags)
    const explicit = flags.get('out')
    const format = (flags.get('format') ?? (explicit?.endsWith('.yaml') ? 'yaml' : explicit?.endsWith('.jsonl') ? 'jsonl' : 'csv')) as Format
    if (!['csv', 'jsonl', 'yaml'].includes(format)) throw new Error('--format must be csv, jsonl or yaml')
    const tenants = flags.get('tenants')?.split(',').map(Number)
    // Named after the config, not the clock: the same config always lands in the same file. A scaled or partial build gets its own name so it cannot overwrite a full store.
    const name = [planId(configPath), ...(flags.has('scale') ? [`scale-${flags.get('scale')}`] : []), ...(tenants ? [`tenants-${tenants.join('-')}`] : [])].join('.')
    const out = explicit ? inDir(explicit, runDir(configPath)) : join(runDir(configPath), `${name}.tuples.${format}`)
    mkdirSync(dirname(out), { recursive: true })
    const sink = fileSink(out, format, format === 'yaml' ? { name: basename(modelPath), dsl: modelDsl(compiled.model) } : undefined)
    const report = generate(compiled, resolved, { sink, ...(tenants ? { tenants } : {}) })
    sink.close()
    const reportPath = flags.has('report') ? inDir(flags.get('report')!, runDir(configPath)) : `${out.replace(/(\.tuples)?\.(csv|jsonl|yaml)$/, '')}.report.json`
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.log(formatReport(report, reportPath))
    console.log(`\nWrote ${out}`)
    console.log('Next: verify has OpenFGA check a pilot of this store.')
    if (report.violationCount) process.exitCode = 1
    return
  }

  if (command === 'verify') {
    const configPath = configArg(positional)
    const { compiled, resolved } = load(configPath, flags)
    const file = flags.has('out') ? inDir(flags.get('out')!, runDir(configPath)) : join(runDir(configPath), `${planId(configPath)}.pilot.fga.yaml`)
    const verdict = verify(compiled, resolved, { file, ...(flags.has('max-tuples') ? { maxTuples: Number(flags.get('max-tuples')) } : {}) })
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
