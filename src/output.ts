import { closeSync, openSync, writeSync } from 'node:fs'

export interface OutTuple {
  userType: string
  userId: string
  userRelation?: string
  relation: string
  objectType: string
  objectId: string
  condition?: string
  context?: Record<string, unknown>
  /** The tenant that wrote it; -1 is the shared block. Not part of the output. */
  tenant: number
}

export interface Sink {
  write(t: OutTuple): void
  close(): void
}

export type Format = 'csv' | 'jsonl' | 'yaml'

export const userOf = (t: OutTuple) => `${t.userType}:${t.userId}${t.userRelation ? `#${t.userRelation}` : ''}`
export const objectOf = (t: OutTuple) => `${t.objectType}:${t.objectId}`

const csvField = (s: string) => (/[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s)

/** One tuple as an entry of a store file's `tuples:` list. JSON is valid YAML, so context is written as JSON. */
export function yamlTuple(t: OutTuple): string {
  const lines = [`  - user: ${userOf(t)}`, `    relation: ${t.relation}`, `    object: ${objectOf(t)}`]
  if (t.condition) {
    lines.push('    condition:', `      name: ${t.condition}`)
    if (t.context) lines.push(`      context: ${JSON.stringify(t.context)}`)
  }
  return lines.join('\n')
}

function line(t: OutTuple, format: Format): string {
  if (format === 'csv') {
    return [t.userType, t.userId, t.userRelation ?? '', t.relation, t.objectType, t.objectId, t.condition ?? '', t.condition && t.context ? csvField(JSON.stringify(t.context)) : ''].join(',')
  }
  if (format === 'jsonl') {
    return JSON.stringify({ user: userOf(t), relation: t.relation, object: objectOf(t), ...(t.condition ? { condition: { name: t.condition, ...(t.context ? { context: t.context } : {}) } } : {}) })
  }
  return yamlTuple(t)
}

export const indent = (text: string, by = '  ') => text.trimEnd().split('\n').map((l) => `${by}${l}`).join('\n')

/**
 * Streams tuples to a file. `csv` is the `fga tuple write --file` layout; `yaml` is a store file
 * (`fga store import --file`) and needs the model's DSL.
 */
export function fileSink(path: string, format: Format, store?: { name: string; dsl: string }): Sink {
  const fd = openSync(path, 'w')
  let buffer: string[] = []
  let size = 0
  const flush = () => {
    if (buffer.length) writeSync(fd, buffer.join('\n') + '\n')
    buffer = []
    size = 0
  }
  const push = (text: string) => {
    buffer.push(text)
    size += text.length
    if (size > 1 << 20) flush()
  }
  if (format === 'csv') push('user_type,user_id,user_relation,relation,object_type,object_id,condition_name,condition_context')
  if (format === 'yaml') {
    if (!store) throw new Error('a yaml store file needs the model')
    push([`name: ${JSON.stringify(store.name)}`, 'model: |', indent(store.dsl), 'tuples:'].join('\n'))
  }
  return {
    write: (t) => push(line(t, format)),
    close: () => {
      flush()
      closeSync(fd)
    },
  }
}

export const nullSink: Sink = { write: () => {}, close: () => {} }

export function memorySink(): Sink & { tuples: OutTuple[] } {
  const tuples: OutTuple[] = []
  return { tuples, write: (t) => void tuples.push(t), close: () => {} }
}
