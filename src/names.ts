import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Every file a run writes goes here, so the project folder stays clean. */
export const OUTPUT_DIR = 'output'

/** A bare name (tuples.csv) lands in output/. A path with a folder in it (./tuples.csv, /tmp/x.csv) is used as given. */
export function inOutput(path: string): string {
  return basename(path) === path ? join(OUTPUT_DIR, path) : path
}

/** Local date and time to the minute, like 20261113-0936. */
export function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`
}

/** `<stamp><ext>` that is not taken in `dir`: 20261113-0936, then 20261113-0936-2 within the same minute. */
function freeName(ext: string, dir: string, now: Date, exists: (path: string) => boolean): string {
  const base = stamp(now)
  for (let n = 1; ; n++) {
    const name = `${base}${n === 1 ? '' : `-${n}`}${ext}`
    if (!exists(join(dir, name))) return name
  }
}

/** A config file name that is not taken yet: 20261113-0936.gen.json, then 20261113-0936-2.gen.json within the same minute. */
export function newConfigName(dir = OUTPUT_DIR, now = new Date(), exists: (path: string) => boolean = existsSync): string {
  return freeName('.gen.json', dir, now, exists)
}

/** The id a config carries in its name: 20261113-2149 for 20261113-2149.gen.json. Everything built from it is named after it, whenever it is built. */
export function planId(configPath: string): string {
  return basename(configPath).replace(/\.json$/, '').replace(/\.gen$/, '')
}

export interface ConfigFile {
  name: string
  modified: number
}

const isConfig = (name: string) => name === 'gen.json' || name.endsWith('.gen.json')

const listConfigs = (dir: string): ConfigFile[] =>
  existsSync(dir) ? readdirSync(dir).filter(isConfig).map((name) => ({ name, modified: statSync(join(dir, name)).mtimeMs })) : []

/** The config to use when none is named: the most recently modified `gen.json` or `*.gen.json` in output/, else in the current folder. */
export function latestConfig(dirs: string[] = [OUTPUT_DIR, '.'], list: (dir: string) => ConfigFile[] = listConfigs): string | undefined {
  const configs = dirs.flatMap((dir) => list(dir).filter((f) => isConfig(f.name)).map((f) => ({ ...f, dir })))
  // Equal times (two inits in one minute) fall back to the suffix number, so -2 comes after the first.
  configs.sort((a, b) => b.modified - a.modified || suffix(b.name) - suffix(a.name) || b.name.localeCompare(a.name))
  return configs.length ? join(configs[0].dir, configs[0].name) : undefined
}

const suffix = (name: string) => Number(/^\d{8}-\d{4}-(\d+)\.gen\.json$/.exec(name)?.[1] ?? 1)
