import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Local date and time to the minute, like 20261113-0936. */
export function stamp(now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}`
}

/** A config file name that is not taken yet: 20261113-0936.gen.json, then 20261113-0936-2.gen.json within the same minute. */
export function newConfigName(dir = '.', now = new Date(), exists: (path: string) => boolean = existsSync): string {
  const base = stamp(now)
  for (let n = 1; ; n++) {
    const name = `${base}${n === 1 ? '' : `-${n}`}.gen.json`
    if (!exists(join(dir, name))) return name
  }
}

export interface ConfigFile {
  name: string
  modified: number
}

const isConfig = (name: string) => name === 'gen.json' || name.endsWith('.gen.json')

const listConfigs = (dir: string): ConfigFile[] =>
  readdirSync(dir).filter(isConfig).map((name) => ({ name, modified: statSync(join(dir, name)).mtimeMs }))

/** The config to use when none is named: the most recently modified `gen.json` or `*.gen.json` in `dir`. */
export function latestConfig(dir = '.', list: (dir: string) => ConfigFile[] = listConfigs): string | undefined {
  const configs = list(dir).filter((f) => isConfig(f.name))
  // Equal times (two inits in one minute) fall back to the suffix number, so -2 comes after the first.
  configs.sort((a, b) => b.modified - a.modified || suffix(b.name) - suffix(a.name) || b.name.localeCompare(a.name))
  return configs.length ? join(dir, configs[0].name) : undefined
}

const suffix = (name: string) => Number(/^\d{8}-\d{4}-(\d+)\.gen\.json$/.exec(name)?.[1] ?? 1)
