import { emitKeypressEvents } from 'node:readline'

export interface Choice {
  label: string
  hint?: string
}

/** The highlighted row after a key press. Wraps at both ends. */
export function moveSelection(index: number, key: string, count: number): number {
  if (!count) return 0
  if (key === 'up' || key === 'k') return (index - 1 + count) % count
  if (key === 'down' || key === 'j') return (index + 1) % count
  if (key === 'home') return 0
  if (key === 'end') return count - 1
  return index
}

/** The rows to draw, [from, to): at most `max` of them, scrolled so the highlighted row is in view. */
export function visibleWindow(index: number, count: number, max: number): [number, number] {
  const size = Math.min(count, Math.max(1, max))
  const from = Math.min(Math.max(0, index - Math.floor(size / 2)), count - size)
  return [from, from + size]
}

/** A whole number, plain or with thousands separators (5000, 5,000, 5_000). Anything else is undefined. */
export function parseCount(text: string): number | undefined {
  const t = text.trim()
  if (!/^\d[\d,_]*$/.test(t)) return undefined
  const n = Number(t.replace(/[,_]/g, ''))
  return Number.isSafeInteger(n) ? n : undefined
}

const ESC = '\x1b['
const bold = (s: string) => `${ESC}1m${s}${ESC}0m`
const dim = (s: string) => `${ESC}2m${s}${ESC}0m`
const cyan = (s: string) => `${ESC}36m${s}${ESC}0m`

interface Key {
  name?: string
  ctrl?: boolean
}

/**
 * A menu: move with the arrow keys (or j and k), choose with Enter. Needs a terminal on both ends.
 * Returns the index chosen, and leaves one line behind: the question and the answer.
 */
export function select(
  question: string,
  choices: Choice[],
  start = 0,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<number> {
  const wasRaw = input.isRaw
  let index = Math.min(Math.max(0, start), choices.length - 1)
  let drawn = 0

  const draw = () => {
    if (drawn) output.write(`${ESC}${drawn}A`)
    const columns = output.columns || 80
    const [from, to] = visibleWindow(index, choices.length, (output.rows || 24) - 4)
    let text = ''
    for (let i = from; i < to; i++) {
      const { label, hint } = choices[i]
      const room = Math.max(0, columns - label.length - 6)
      const shown = hint && room > 3 ? `  ${dim(hint.length > room ? `${hint.slice(0, room - 1)}…` : hint)}` : ''
      text += `\r${ESC}2K${i === index ? `${cyan('❯')} ${bold(label)}` : `  ${label}`}${shown}\n`
    }
    const where = choices.length > to - from ? ` (${index + 1} of ${choices.length})` : ''
    text += `\r${ESC}2K${dim(`↑/↓ to move, Enter to choose${where}`)}\n`
    output.write(text)
    drawn = to - from + 1
  }

  return new Promise((resolve) => {
    const finish = () => {
      input.removeListener('keypress', onKey)
      input.setRawMode(!!wasRaw)
      input.pause()
    }
    const onKey = (_text: string, key: Key | undefined) => {
      const name = key?.name ?? ''
      if ((key?.ctrl && name === 'c') || name === 'escape') {
        finish()
        output.write(`${ESC}?25h\n`)
        process.exit(130)
      }
      if (name === 'return' || name === 'enter') {
        finish()
        // Replace the menu with the answer, so the session reads as a list of questions and answers.
        output.write(`${ESC}${drawn + 1}A\r${ESC}J${ESC}?25h${cyan('✔')} ${question} ${bold(choices[index].label)}\n`)
        resolve(index)
        return
      }
      index = moveSelection(index, name || (_text ?? ''), choices.length)
      draw()
    }
    emitKeypressEvents(input)
    input.setRawMode(true)
    input.resume()
    output.write(`${question}\n${ESC}?25l`)
    draw()
    input.on('keypress', onKey)
  })
}
