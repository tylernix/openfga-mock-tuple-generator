import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { inDir, latestConfig, newPlanId, planId, runDir, stamp } from '../src/names.js'
import { moveSelection, parseCount, visibleWindow } from '../src/prompt.js'

describe('config names', () => {
  const at = new Date(2026, 10, 13, 9, 5)

  it('stamps local date and time to the minute', () => {
    expect(stamp(at)).toBe('20261113-0905')
  })

  it('adds a number when the id is taken, so two inits in one minute do not collide', () => {
    const taken = new Set([join('.', '20261113-0905'), join('.', '20261113-0905-2')])
    expect(newPlanId('.', at, (p) => taken.has(p))).toBe('20261113-0905-3')
    expect(newPlanId('.', at, () => false)).toBe('20261113-0905')
  })

  it('picks the most recently modified config, plain gen.json included', () => {
    const list = () => [
      { name: 'gen.json', modified: 300 },
      { name: '20261113-0905.gen.json', modified: 200 },
      { name: '20261113-0906.gen.json', modified: 100 },
    ]
    expect(latestConfig(['d'], list)).toBe(join('d', 'gen.json'))
  })

  it('looks in every run folder, output/ and the current folder, and takes the newest', () => {
    const files: Record<string, { name: string; modified: number }[]> = {
      'output/20261113-0905': [{ name: '20261113-0905.gen.json', modified: 100 }],
      output: [],
      '.': [{ name: 'gen.json', modified: 50 }],
    }
    const dirs = ['output/20261113-0905', 'output', '.']
    expect(latestConfig(dirs, (d) => files[d])).toBe(join('output/20261113-0905', '20261113-0905.gen.json'))
    files['.'][0].modified = 500
    expect(latestConfig(dirs, (d) => files[d])).toBe(join('.', 'gen.json'))
  })

  it('puts a bare name in the given folder and leaves a path with a folder alone', () => {
    expect(inDir('tuples.csv', 'output/x')).toBe(join('output/x', 'tuples.csv'))
    expect(inDir('./tuples.csv', 'output/x')).toBe('./tuples.csv')
    expect(inDir('/tmp/tuples.csv', 'output/x')).toBe('/tmp/tuples.csv')
  })

  it('names a store and its folder after the config, not the clock', () => {
    expect(planId('output/20261113-2149/20261113-2149.gen.json')).toBe('20261113-2149')
    expect(planId('20261113-2149-2.gen.json')).toBe('20261113-2149-2')
    expect(planId('gen.json')).toBe('gen')
    expect(runDir('output/20261113-2149/20261113-2149.gen.json')).toBe(join('output', '20261113-2149'))
    expect(runDir('bench/simple.gen.json')).toBe(join('output', 'simple'))
  })

  it('breaks a tie by name, numbers compared as numbers', () => {
    const list = () => [
      { name: '20261113-0905-2.gen.json', modified: 1 },
      { name: '20261113-0905-10.gen.json', modified: 1 },
      { name: '20261113-0905.gen.json', modified: 1 },
    ]
    expect(latestConfig(['d'], list)).toBe(join('d', '20261113-0905-10.gen.json'))
  })

  it('returns nothing when the folder has no config', () => {
    expect(latestConfig(['d'], () => [])).toBeUndefined()
  })
})

describe('menu helpers', () => {
  it('moves with arrows and j/k, and wraps', () => {
    expect(moveSelection(0, 'down', 3)).toBe(1)
    expect(moveSelection(2, 'down', 3)).toBe(0)
    expect(moveSelection(0, 'up', 3)).toBe(2)
    expect(moveSelection(1, 'j', 3)).toBe(2)
    expect(moveSelection(1, 'k', 3)).toBe(0)
    expect(moveSelection(1, 'home', 3)).toBe(0)
    expect(moveSelection(1, 'end', 3)).toBe(2)
  })

  it('keeps the selected row inside the visible window', () => {
    const [start, end] = visibleWindow(9, 10, 4)
    expect(end - start).toBe(4)
    expect(start <= 9 && 9 < end).toBe(true)
    expect(visibleWindow(0, 3, 10)).toEqual([0, 3])
  })

  it('reads whole numbers with separators and rejects the rest', () => {
    expect(parseCount('5000')).toBe(5000)
    expect(parseCount('5,000')).toBe(5000)
    expect(parseCount('5_000')).toBe(5000)
    expect(parseCount('5.5')).toBeUndefined()
    expect(parseCount('five')).toBeUndefined()
    expect(parseCount('')).toBeUndefined()
  })
})

// Inside the estimator repo tsx is installed one level up; in the standalone repo it is next to the tool.
function findTsx(from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', 'tsx')
    if (existsSync(bin)) return bin
    if (dirname(dir) === dir) throw new Error('tsx is not installed')
  }
}

describe('the README steps, with no config file named', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const tsx = findTsx(root)
  const cli = join(root, 'src', 'cli.ts')
  const simple = join(root, 'bench', 'models', 'simple.fga')
  const dirs: string[] = []
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

  function run(cwd: string, args: string[], input = '') {
    return spawnSync(tsx, [cli, ...args], { cwd, input, encoding: 'utf8' })
  }

  it('init writes a timestamped config in its own folder that plan and build then use by themselves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)

    const init = run(dir, ['init', simple], 'organization\n500\n5\n1000\n')
    expect(init.status, init.stderr).toBe(0)
    expect(readdirSync(dir)).toEqual(['output'])
    const runs = readdirSync(join(dir, 'output'))
    expect(runs).toHaveLength(1)
    const id = runs[0]
    expect(id).toMatch(/^\d{8}-\d{4}$/)
    expect(readdirSync(join(dir, 'output', id))).toEqual([`${id}.gen.json`])
    expect(init.stdout).toContain(`Wrote ${join('output', id, `${id}.gen.json`)}`)

    const plan = run(dir, ['plan'])
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.stdout).toContain(`Using ${join('output', id, `${id}.gen.json`)}`)

    const build = run(dir, ['build'])
    expect(build.status, build.stderr).toBe(0)
    expect(readdirSync(join(dir, 'output', id)).sort()).toEqual([`${id}.gen.json`, `${id}.report.html`, `${id}.report.json`, `${id}.tuples.csv`])
    expect(readdirSync(dir)).toEqual(['output'])
  })

  it('a store is named after its config, so building again gives the same name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', '20200101-0000.gen.json'])
    const first = run(dir, ['build'])
    const second = run(dir, ['build'])
    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(readdirSync(join(dir, 'output', '20200101-0000')).sort()).toEqual(['20200101-0000.gen.json', '20200101-0000.report.html', '20200101-0000.report.json', '20200101-0000.tuples.csv'])
  })

  it('a scaled or partial build gets its own name and cannot overwrite the full store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', '20200101-0000.gen.json'])
    expect(run(dir, ['build', '--scale', '0.01']).status).toBe(0)
    expect(run(dir, ['build', '--tenants', '0,1']).status).toBe(0)
    expect(readdirSync(join(dir, 'output', '20200101-0000')).filter((f) => f.endsWith('.tuples.csv')).sort()).toEqual([
      '20200101-0000.scale-0.01.tuples.csv',
      '20200101-0000.tenants-0-1.tuples.csv',
    ])
  })

  it('an explicit --out bare name lands in the config folder, a path with a folder is used as given', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', 'a.gen.json'])
    expect(run(dir, ['build', '--out', 'mine.csv']).status).toBe(0)
    expect(run(dir, ['build', '--out', './here.csv']).status).toBe(0)
    expect(readdirSync(join(dir, 'output', 'a'))).toContain('mine.csv')
    expect(readdirSync(dir)).toContain('here.csv')
  })

  it('verify keeps its pilot file in the config folder, named after the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', '20200101-0000.gen.json'])
    const verify = run(dir, ['verify', '--max-tuples', '3000'])
    expect(verify.status, verify.stdout + verify.stderr).toBe(0)
    const files = readdirSync(join(dir, 'output', '20200101-0000'))
    expect(files).toContain('20200101-0000.pilot.yaml')
    // The OpenFGA editor extension takes over .fga.yaml and stops validating past 1,000 tuples.
    expect(files.filter((f) => f.endsWith('.fga.yaml'))).toEqual([])
  })

  it('--skip asks nothing, even when it comes before the model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    const init = run(dir, ['init', '--skip', simple, '--out', 'x.gen.json'])
    expect(init.status, init.stderr).toBe(0)
    expect(init.stdout).not.toContain('Which type is a tenant')
    expect(readdirSync(join(dir, 'output', 'x'))).toContain('x.gen.json')
  })

  it('the file you name wins over the newest one, and a bare name is found in its folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', 'mine.gen.json'])
    run(dir, ['init', simple, '--skip', '--out', 'newer.gen.json'])
    utimesSync(join(dir, 'output', 'newer', 'newer.gen.json'), new Date(), new Date(Date.now() + 60_000))
    const plan = run(dir, ['plan', 'mine.gen.json'])
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.stdout).not.toContain('Using')
  })

  it('prints a per-edge table that fits an 80-column terminal and writes the full report beside the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    const build = run(dir, ['build', join(root, 'bench', 'gdrive.gen.json'), '--scale', '0.01'])
    expect(build.status, build.stderr).toBe(0)
    const lines = build.stdout.split('\n')
    const start = lines.indexOf('Realized, per edge:')
    expect(start).toBeGreaterThan(-1)
    const table = lines.slice(start + 1, lines.indexOf('', start + 1))
    expect(table.length).toBeGreaterThan(10)
    expect(Math.max(...table.map((l) => l.length))).toBeLessThanOrEqual(80)

    const files = readdirSync(join(dir, 'output', 'gdrive'))
    expect(files).toContain('gdrive.scale-0.01.report.json')
    const report = JSON.parse(readFileSync(join(dir, 'output', 'gdrive', 'gdrive.scale-0.01.report.json'), 'utf8'))
    expect(report.edges[0]).toHaveProperty('asked')
    expect(build.stdout).toContain('gdrive.scale-0.01.report.json')
    expect(build.stdout).toContain('gdrive.scale-0.01.report.html')
    const html = readFileSync(join(dir, 'output', 'gdrive', 'gdrive.scale-0.01.report.html'), 'utf8')
    expect(html).toContain('<svg')
    expect(html).toContain('document#viewer:user')
  })

  it('shows each default as [default: N], and Enter writes exactly that number', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    const init = run(dir, ['init', simple, '--out', 'd.gen.json'], 'organization\n\n\n\n')
    expect(init.status, init.stderr).toBe(0)
    expect(init.stdout).toContain('How many user objects in the whole store? [default: 10,000]: 10,000')
    expect(init.stdout).toContain('How many document objects in the whole store? [default: 100,000]: 100,000')
    const config = JSON.parse(readFileSync(join(dir, 'output', 'd', 'd.gen.json'), 'utf8'))
    expect(config.counts).toEqual({ user: 10000, organization: 100, document: 100000 })
  })

  it('finds a config left flat in output/ and builds it into its own folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', './seed.gen.json'])
    mkdirSync(join(dir, 'output'))
    // The model path is relative to the config, so point it at the model before moving the file.
    const config = { ...JSON.parse(readFileSync(join(dir, 'seed.gen.json'), 'utf8')), model: simple }
    writeFileSync(join(dir, 'output', '20200202-0000.gen.json'), JSON.stringify(config))
    rmSync(join(dir, 'seed.gen.json'))
    const build = run(dir, ['build'])
    expect(build.status, build.stderr).toBe(0)
    expect(build.stdout).toContain(`Using ${join('output', '20200202-0000.gen.json')}`)
    expect(readdirSync(join(dir, 'output', '20200202-0000'))).toEqual(['20200202-0000.report.html', '20200202-0000.report.json', '20200202-0000.tuples.csv'])
  })

  it('still finds a config left in the project folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    run(dir, ['init', simple, '--skip', '--out', './old.gen.json'])
    const plan = run(dir, ['plan'])
    expect(plan.status, plan.stderr).toBe(0)
    expect(plan.stdout).toContain(`Using ${join('.', 'old.gen.json')}`)
  })

  it('says what to do when the folder has no config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'notes.txt'), '')
    const plan = run(dir, ['plan'])
    expect(plan.status).not.toBe(0)
    expect(plan.stderr).toContain('no config file')
  })

  it('a count that is not a number is an error when answers are piped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuplegen-'))
    dirs.push(dir)
    const init = run(dir, ['init', simple], 'organization\nlots\n')
    expect(init.status).not.toBe(0)
    expect(init.stderr).toContain('is not a whole number')
  })
})
