import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Every file a run writes goes here, so the project folder stays clean. */
export const OUTPUT_DIR = 'output'

/** The id a config carries in its name: 20261113-2149 for 20261113-2149.gen.json. Everything built from it is named after it, whenever it is built. */
export function planId(configPath: string): string {
  return basename(configPath).replace(/\.json$/, '').replace(/\.gen$/, '')
}

/** The folder holding a config and everything built from it: output/20261113-2149. */
export const runDir = (configPath: string) => join(OUTPUT_DIR, planId(configPath))

/** A bare name (tuples.csv) lands in `dir`. A path with a folder in it (./tuples.csv, /tmp/x.csv) is used as given. */
export function inDir(path: string, dir: string): string {
  return basename(path) === path ? join(dir, path) : path
}

/** Local date and time to the minute, like 20261113-0936. */
export function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`
}

/** A new plan id whose folder is not taken in `dir`: 20261113-0936, then 20261113-0936-2 within the same minute. */
export function newPlanId(dir = OUTPUT_DIR, now = new Date(), exists: (path: string) => boolean = existsSync): string {
  const base = stamp(now)
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`
    if (!exists(join(dir, id))) return id
  }
}

export interface ConfigFile {
  name: string
  modified: number
}

const isConfig = (name: string) => name === 'gen.json' || name.endsWith('.gen.json')

const listConfigs = (dir: string): ConfigFile[] =>
  existsSync(dir) ? readdirSync(dir).filter(isConfig).map((name) => ({ name, modified: statSync(join(dir, name)).mtimeMs })) : []

/** Where configs can be: each run folder in output/, then output/ itself, then the current folder. */
export function configDirs(): string[] {
  const runs = existsSync(OUTPUT_DIR) ? readdirSync(OUTPUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(OUTPUT_DIR, d.name)) : []
  return [...runs, OUTPUT_DIR, '.']
}

/** The config to use when none is named: the most recently modified `gen.json` or `*.gen.json` in the places above. */
export function latestConfig(dirs: string[] = configDirs(), list: (dir: string) => ConfigFile[] = listConfigs): string | undefined {
  const configs = dirs.flatMap((dir) => list(dir).filter((f) => isConfig(f.name)).map((f) => ({ ...f, dir })))
  // Equal times (two inits in one minute) fall back to the suffix number, so -2 comes after the first.
  configs.sort((a, b) => b.modified - a.modified || suffix(b.name) - suffix(a.name) || b.name.localeCompare(a.name))
  return configs.length ? join(configs[0].dir, configs[0].name) : undefined
}

const suffix = (name: string) => Number(/^\d{8}-\d{4}-(\d+)\.gen\.json$/.exec(name)?.[1] ?? 1)
