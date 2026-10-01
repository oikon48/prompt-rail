import type { EngineInterface, Register, Timer } from 'claude-code'

const PANE = 'prompt-rail'
// Rows the person typed (terminal composer, desktop/remote bridge, SDK host).
const PROMPT_KINDS = new Set(['composer', 'bridge', 'sdk'])
// Columns the docked rail asks for: a tick and a little air.
const RAIL_COLUMNS = 4
// Below this many body columns the vertical rail has no room to reveal the
// prompt beside a tick, so the band above the prompt shows it instead.
const INLINE_REVEAL_MIN_COLUMNS = 12
// Cells a hover card keeps for the prompt's text beside the turn's details.
const MIN_CARD_TEXT = 12
// The mode is the plugin's `mode` setting (userConfig), a row in /config. An
// earlier version kept it in the store under this key, shared by every session.
const LEGACY_MODE_KEY = 'mode'
// `session-mode:<session id>` -> a mode the setting could not keep (a session
// with no /config row for plugin fields), so a module reloaded mid-session
// starts in it again. Keyed by session, so a later session starts clean.
const SESSION_MODE_KEY_PREFIX = 'session-mode:'
const MODE_SETTING = 'prompt-rail.mode'
// `transcript:<session id>` -> { path, at }, so a hot-reloaded module (whose
// session.start carries no path) can rebuild its list. One key per session, so
// sessions starting together never rewrite each other's; the newest few stay.
const TRANSCRIPT_KEY_PREFIX = 'transcript:'
const KEPT_TRANSCRIPTS = 20
// The id a prompt row is drawn under before its message is stored; the stored
// row follows under its uuid.
const PROVISIONAL_ID = 'placeholder'
// User rows the engine writes around its own output (slash commands, bash
// mode, reminders), which are not prompts.
const WRAPPER = /^<(command-|local-command-|bash-|system-reminder|task-notification|user-prompt-submit-hook)/
// The viewer's state the engine puts ahead of a prompt sent while an artifact
// is open; the typed text follows it. No row field tells it from typed text,
// so only the engine's layout matches: the artifact id, a JSON line starting
// with "context", and the closing tag on a line of its own.
const VIEW_CONTEXT = /^\s*<artifact-view-context artifact="[^"]*">\n\{"context":[\s\S]*?\n<\/artifact-view-context>/
// The notice the engine stores as a user row when the person interrupts a turn.
const INTERRUPTED = /^\[Request interrupted by user/
// A message uuid, as the transcript stores it (see rowKey).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The rail is drawn again this many ms after the last onScreen report, and no
// later than SETTLE_MAX_MS after the first (see redrawRailSettled). Measured
// on the terminal: a replayed row is corrected within 13 ms, a layout settles
// within 18 ms.
const SETTLE_MS = 40
const SETTLE_MAX_MS = 120
// A row added at most this many ms before a prompt's notification may be that
// prompt's own: the engine draws a queued prompt's first row as it notifies.
const LATELY_MS = 250
// Cells kept left of the horizontal rail: off the window's edge, a pointer
// leaving the first bar crosses a cell and the surface sees the hover end.
const RAIL_INSET = 2
// The engine's refusal when no row is drawn under an id, as for a slash
// command's own row, which the transcript file holds but the surface skips.
// Other refusals (a race with another move) pass, so they leave the tick be.
const NOT_DRAWN = /nothing drawn/
// A count the rail's sites (the pane and the band) read while drawing, so
// bumping it draws them again, and them alone. `$.ui.invalidate('ui.render')`
// also draws every transcript row this module hooks, and rows drawn again
// while the person scrolls just after a jump move the viewport a turn away.
const MOVED = { plugin: 'prompt-rail', key: 'moved' } as const
// How long the band's text line shows the card of the bar the focus ring is
// on after the ring last moved: no event says the ring left the band.
const RING_CARD_MS = 4000
const USAGE = '[off|vertical|horizontal|next|prev|first|last|<n>|find <words>]'
// Commands that step through the prompts, each with the way it steps.
const STEP_COMMANDS = [
  ['prompt-rail-next', 'next'],
  ['prompt-rail-prev', 'previous'],
] as const

// vertical: ticks in a docked pane; horizontal: ticks in a row above the
// prompt; off: no rail at all. One setting, so /config keeps a single row.
type Mode = 'off' | 'vertical' | 'horizontal'
const isMode = (value: unknown): value is Mode => value === 'off' || value === 'vertical' || value === 'horizontal'

type Entry = { id: string; text: string }

// The key rows are matched by. A message the engine splits into several rows
// is drawn under ids derived from its stored uuid, the first four groups kept
// and the last replaced by the row's index, so a uuid is matched by those
// groups; any other id (a tool_use id, the provisional one) as it is.
export const rowKey = (id: string) => (UUID.test(id) ? id.slice(0, 24) : id)

// The id a prompt's row was last drawn under, which a jump scrolls to, from a
// map of row key -> drawn id; its own id while it has not been drawn.
export const drawnRow = (drawn: Map<string, string>, id: string) => drawn.get(rowKey(id)) ?? id

// Terminal cells a character takes: two for East Asian wide and emoji ranges.
const cells = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return isWide ? 2 : 1
}

const cellWidth = (text: string) => [...text].reduce((sum, char) => sum + cells(char), 0)

// `text` padded with spaces to `width` cells, so a card painted over the
// default line hides it whole.
const padTo = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - cellWidth(text)))

// The prompt on one line, cut to `width` terminal cells with an ellipsis.
const oneLine = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  if (chars.reduce((sum, char) => sum + cells(char), 0) <= width) return flat
  let out = ''
  let used = 0
  for (const char of chars) {
    if (used + cells(char) > width - 1) break
    out += char
    used += cells(char)
  }
  return `${out}…`
}

// A stacked rail reads rows apart; a row of ticks needs upright bars to. A
// dotted one marks a prompt the transcript does not draw, so a jump fails.
export const tick = (isCurrent: boolean, isUnreachable = false) => (isCurrent ? '━' : isUnreachable ? '┄' : '─')
export const bar = (isCurrent: boolean, isUnreachable = false) => (isCurrent ? '┃' : isUnreachable ? '┆' : '│')

// Record what a jump to `id` answered: a landing makes it reachable, a refusal
// for want of a drawn row unreachable, any other refusal says nothing. True
// when the set changed.
export const noteScroll = (unreachable: Set<string>, id: string, deny: string | undefined) => {
  const was = unreachable.has(id)
  if (deny === undefined) unreachable.delete(id)
  else if (NOT_DRAWN.test(deny)) unreachable.add(id)
  return unreachable.has(id) !== was
}

// The prompt one step from `current` in direction `dir`, passing over those
// `isSkipped` names; from an unknown place (-1), the first or the last. -1
// when there is none that way.
export const stepFrom = (current: number, count: number, dir: 1 | -1, isSkipped: (i: number) => boolean) => {
  let i = current >= 0 ? current + dir : dir > 0 ? 0 : count - 1
  for (; i >= 0 && i < count; i += dir) if (!isSkipped(i)) return i
  return -1
}

// The prompt `/prompt-rail <asked>` names among `texts`: `n` or `#n` by its
// number, `first`, `last`, or with `find <words>` the newest whose text holds
// them (case aside). -1 when none does; undefined when `asked` names none.
export const pickPrompt = (asked: string, texts: string[]) => {
  const number = /^#?(\d+)$/.exec(asked)
  if (number) {
    const i = Number(number[1]) - 1
    return i < texts.length ? i : -1
  }
  if (asked === 'first') return texts.length > 0 ? 0 : -1
  if (asked === 'last') return texts.length - 1
  const words = /^find\s+(.+)$/.exec(asked)?.[1]?.toLowerCase()
  if (words === undefined) return undefined
  for (let i = texts.length - 1; i >= 0; i--) if (texts[i]?.toLowerCase().includes(words)) return i
  return -1
}

// What the transcript records of the turn a prompt started: how long it took
// (`durationMs` as the engine reported it, else `spanMs` from the prompt to
// the latest reply), how many tools it called, the paths of the files it
// edited (Edit and Write), and, unless it simply answered, how it went.
export type Turn = { durationMs?: number; spanMs?: number; tools: number; files: string[]; outcome?: Outcome }
// A turn still running, stopped by the person, or ended by an API error.
type Outcome = 'running' | 'interrupted' | 'error'
const OUTCOME_WORDS: Record<Outcome, string> = { running: 'running', interrupted: 'interrupted', error: 'API error' }

// A duration as the rail shows it: `7s`, `1m 23s`, `1h 2m`.
const duration = (ms: number) => {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`
}

// The files a turn line names before it counts the rest.
const NAMED_FILES = 3

const EDITING_TOOLS = new Set(['Edit', 'Write'])
const segments = (path: string) => path.split(/[\\/]/).filter(Boolean)

// Each path by its file name, or by its folder and name where two share one.
const fileNames = (paths: string[]) => {
  const base = (path: string) => segments(path).at(-1) ?? path
  return paths.map(path =>
    paths.some(other => other !== path && base(other) === base(path)) ? segments(path).slice(-2).join('/') : base(path),
  )
}

// A turn on one line: `1m 23s · 4 tools · app.ts, README.md`, each part left
// out when the transcript has nothing for it; empty when it has nothing.
// Given `maxCells`, it names fewer files (down to a count) to fit in them.
export const turnLine = (turn: Turn | undefined, maxCells = Infinity) => {
  if (!turn) return ''
  const parts: string[] = []
  const ms = turn.durationMs ?? turn.spanMs
  if (ms !== undefined) parts.push(duration(ms))
  if (turn.outcome) parts.push(OUTCOME_WORDS[turn.outcome])
  if (turn.tools > 0) parts.push(`${turn.tools} ${turn.tools === 1 ? 'tool' : 'tools'}`)
  const names = fileNames(turn.files)
  const withFiles = (named: number) => {
    if (names.length === 0) return parts.join(' · ')
    const rest = names.length - named
    const files =
      named > 0
        ? `${names.slice(0, named).join(', ')}${rest > 0 ? ` +${rest}` : ''}`
        : `${names.length} ${names.length === 1 ? 'file' : 'files'}`
    return [...parts, files].join(' · ')
  }
  for (let named = Math.min(NAMED_FILES, names.length); named > 0; named--) {
    const line = withFiles(named)
    if (cellWidth(line) <= maxCells) return line
  }
  return withFiles(0)
}

type TranscriptIndex = {
  prompts: Entry[]
  // The turn each prompt started, in the same order.
  turns: Turn[]
  // Reply row uuid or tool_use id -> index into prompts of the prompt it answers.
  owners: [string, number][]
  // Every row uuid the file holds, live branch or not.
  known: Set<string>
}

// The uuids on the live branch: the chain of parents from the last row. A
// /rewind leaves the abandoned branch in the file; a /compact boundary starts
// a new chain whose logicalParentUuid links back to the rows before it.
const liveBranch = (rows: any[]) => {
  const byId = new Map<string, any>()
  for (const row of rows) byId.set(row.uuid, row)
  const live = new Set<string>()
  let row = [...rows].reverse().find(candidate => !candidate.isSidechain)
  while (row && !live.has(row.uuid)) {
    live.add(row.uuid)
    const parent = row.parentUuid ?? row.logicalParentUuid
    row = typeof parent === 'string' ? byId.get(parent) : undefined
  }
  return live
}

// What the index reads of a transcript row, and nothing else: a long
// session's rows are kept between reads, and most of their bytes are tool
// results and replies the rail never shows. Undefined for a line that is not
// a row (a torn last line while the engine appends, or no uuid).
const parseRow = (line: string): any => {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof row?.uuid !== 'string') return undefined
  const content = row.message?.content
  const blocks = Array.isArray(content)
    ? content.flatMap((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
        if (block?.type === 'tool_result') return [{ type: 'tool_result' }]
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          const path = block.input?.file_path
          return [{ type: 'tool_use', id: block.id, name: block.name, input: typeof path === 'string' ? { file_path: path } : {} }]
        }
        return []
      })
    : content
  return {
    uuid: row.uuid,
    parentUuid: row.parentUuid,
    logicalParentUuid: row.logicalParentUuid,
    isSidechain: row.isSidechain,
    type: row.type,
    subtype: row.subtype,
    durationMs: row.durationMs,
    isApiErrorMessage: row.isApiErrorMessage,
    isMeta: row.isMeta,
    isCompactSummary: row.isCompactSummary,
    timestamp: row.timestamp,
    message: row.message && { role: row.message.role, content: typeof content === 'string' ? content : blocks },
    attachment: row.attachment?.type === 'queued_command' ? { type: row.attachment.type, prompt: row.attachment.prompt } : undefined,
  }
}

// The rows of a transcript JSONL's text, in order.
const parseRows = (jsonl: string) => jsonl.split('\n').flatMap(line => (line.trim() ? (parseRow(line) ?? []) : []))

// The person's prompts on the live branch of a transcript's rows, in order,
// keyed by message uuid, and the prompt each reply row and tool call answers
// (a tool row is drawn under its tool_use id). Tool results, meta rows,
// sidechains and the engine's wrapper rows are not prompts.
const indexRows = (rows: any[]): TranscriptIndex => {
  const live = liveBranch(rows)
  const prompts: Entry[] = []
  const owners: [string, number][] = []
  const turns: Turn[] = []
  // When each turn started and when its latest reply was written.
  const times: { start: number; last: number }[] = []
  // The prompt that started the turn being read: a prompt delivered into a
  // turn is listed, but the turn's details stay with the one that started it.
  let started = -1
  for (const row of rows) {
    if (row.isSidechain || !live.has(row.uuid)) continue
    const turn = turns[started]
    if (row.type === 'system' && row.subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      if (turn) turn.durationMs = (turn.durationMs ?? 0) + row.durationMs
      continue
    }
    if (row.type === 'assistant') {
      if (prompts.length === 0 || !turn) continue
      // A reply places the reader under the latest prompt, delivered or not.
      const owner = prompts.length - 1
      owners.push([row.uuid, owner])
      if (row.isApiErrorMessage === true) turn.outcome = 'error'
      const at = Date.parse(row.timestamp)
      if (Number.isFinite(at)) times[started]!.last = at
      const blocks = Array.isArray(row.message?.content) ? row.message.content : []
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue
        owners.push([block.id, owner])
        turn.tools++
        const path = block.input?.file_path
        if (EDITING_TOOLS.has(block.name) && typeof path === 'string' && !turn.files.includes(path)) turn.files.push(path)
      }
      continue
    }
    // A prompt typed while a turn ran and delivered into it is stored as a
    // queued_command attachment, never as a user row of its own.
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
      const prompt = row.attachment.prompt
      const text = typeof prompt === 'string' ? prompt.replace(VIEW_CONTEXT, '').trim() : ''
      if (!text || WRAPPER.test(text) || text.startsWith('/')) continue
      prompts.push({ id: row.uuid, text })
      turns.push({ tools: 0, files: [] })
      times.push({ start: NaN, last: NaN })
      continue
    }
    if (row.type !== 'user' || row.isMeta || row.isCompactSummary || row.message?.role !== 'user') continue
    const content = row.message.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
    }
    text = text.replace(VIEW_CONTEXT, '').trim()
    // An interruption notice ends its turn; one mid tool call rides with the
    // call's result, so it is read before tool results are passed over.
    if (INTERRUPTED.test(text)) {
      if (turn) turn.outcome = 'interrupted'
      continue
    }
    if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) continue
    // A slash command's own row is not a prompt: the render hook skips it too,
    // so it is never drawn and could not be scrolled to.
    if (!text || WRAPPER.test(text) || text.startsWith('/')) continue
    prompts.push({ id: row.uuid, text })
    turns.push({ tools: 0, files: [] })
    started = prompts.length - 1
    const at = Date.parse(row.timestamp)
    times.push({ start: at, last: at })
  }
  turns.forEach((turn, i) => {
    const time = times[i]
    if (time && Number.isFinite(time.start) && time.last > time.start) turn.spanMs = time.last - time.start
  })
  return { prompts, turns, owners, known: new Set(rows.map(row => row.uuid)) }
}

// The engine's cap on one $.fs.read; a larger transcript is streamed.
const READ_CAP = 4 * 1024 * 1024
const encoder = new TextEncoder()

// The transcript as last read: its size and modification time, the rows of
// its complete lines and the byte where they end, and where the last row
// starts, which a later read of a long session's file checks is still there.
// Whether a read is under way, and the path whose file could not be read,
// said once.
type Seen = {
  path: string
  size: number
  mtimeMs: number
  rows: any[]
  offset: number
  lastStart: number
  lastUuid: string | undefined
  isReading: boolean
  warned: string
}
const unseen = (): Seen => ({
  path: '',
  size: -1,
  mtimeMs: -1,
  rows: [],
  offset: 0,
  lastStart: 0,
  lastUuid: undefined,
  isReading: false,
  warned: '',
})

// Take the complete lines of `text`, which starts at byte `at` of the file,
// into `seen`, and return the rest: a line the engine is still writing, or
// the last of a file with no newline at its end.
const takeLines = (seen: Seen, text: string, at: number) => {
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) {
    const row = line.trim() ? parseRow(line) : undefined
    if (row) {
      seen.rows.push(row)
      seen.lastStart = at
      seen.lastUuid = row.uuid
    }
    at += encoder.encode(line).length + 1
  }
  seen.offset = at
  return rest
}

// The index of the rows read, and of a last line with no newline yet when it
// parses whole (it is read again once it has one).
const indexSeen = (seen: Seen, rest: string) => {
  const last = rest.trim() ? parseRow(rest) : undefined
  return indexRows(last ? [...seen.rows, last] : seen.rows)
}

// Read the file on from the last row read, with tail, since $.fs.read takes
// no more than READ_CAP. That row comes first and must still be there, else
// the file was replaced: false then, and nothing is taken. Otherwise the rest
// after the last complete line.
async function streamRows($: EngineInterface, path: string, seen: Seen) {
  let expected = seen.lastUuid
  let at = expected === undefined ? seen.offset : seen.lastStart
  let carry = ''
  const child = $.process.spawn({ argv: ['tail', '-c', `+${at + 1}`, path] })
  for await (const piece of child) {
    if (piece.stream !== 'stdout') continue
    let text = carry + piece.text
    if (expected !== undefined) {
      const end = text.indexOf('\n')
      if (end < 0) {
        carry = text
        continue
      }
      const line = text.slice(0, end)
      if (parseRow(line)?.uuid !== expected) return false
      expected = undefined
      at += encoder.encode(line).length + 1
      text = text.slice(end + 1)
    }
    carry = takeLines(seen, text, at)
    at = seen.offset
  }
  const { code } = await child.result
  if (code !== 0) throw new Error(`tail exited with ${code}`)
  return carry
}

// Stream a transcript too large for $.fs.read, from its start when it was
// replaced; its index, or undefined when it could not be read, which is said
// once for the file.
async function readLarge($: EngineInterface, path: string, seen: Seen, size: number, mtimeMs: number) {
  try {
    let rest = await streamRows($, path, seen)
    if (rest === false) {
      Object.assign(seen, { rows: [], offset: 0, lastStart: 0, lastUuid: undefined })
      rest = await streamRows($, path, seen)
      if (rest === false) return undefined
    }
    Object.assign(seen, { path, size, mtimeMs })
    return indexSeen(seen, rest)
  } catch (err) {
    if (seen.warned !== path) {
      seen.warned = path
      const megabytes = Math.round(size / 1024 / 1024)
      $.ui.toast(`prompt-rail: the transcript is ${megabytes} MB, too large to read here (${(err as Error).message}); prompts are listed as they are drawn`)
    }
    return undefined
  }
}

// The transcript's index, or undefined when it is as `seen` last read it (a
// long session's file is not parsed again for a turn that wrote nothing),
// before the file exists (a fresh session), or while another read is under
// way. Records what it read in `seen`. A file over READ_CAP is read on from
// where the last read ended; when that is more than READ_CAP, as on resuming a
// long session, it is read without holding the hook, and `whenLate` gets the
// index once it is done.
async function readTranscript($: EngineInterface, path: string, seen: Seen, whenLate: (index: TranscriptIndex) => void) {
  if (seen.isReading) return undefined
  try {
    const { size, mtimeMs } = await $.fs.stat(path)
    if (seen.path === path && seen.size === size && seen.mtimeMs === mtimeMs) return undefined
    if (seen.path !== path || size < seen.offset) Object.assign(seen, { ...unseen(), warned: seen.warned })
    if (size <= READ_CAP) {
      const text = await $.fs.read(path)
      Object.assign(seen, { rows: [], lastStart: 0, lastUuid: undefined })
      const rest = takeLines(seen, text, 0)
      Object.assign(seen, { path, size, mtimeMs })
      return indexSeen(seen, rest)
    }
    seen.isReading = true
    const reading = readLarge($, path, seen, size, mtimeMs).finally(() => {
      seen.isReading = false
    })
    if (size - seen.offset <= READ_CAP) return await reading
    void reading.then(index => index && whenLate(index))
    return undefined
  } catch {
    seen.isReading = false
    return undefined
  }
}

// Remember this session's transcript path under its own key, then drop all
// but the newest few sessions' keys.
async function rememberTranscript($: EngineInterface, sessionId: string, transcriptPath: string) {
  await $.store.set(`${TRANSCRIPT_KEY_PREFIX}${sessionId}`, { path: transcriptPath, at: Date.now() })
  const keys = (await $.store.keys()).filter(key => key.startsWith(TRANSCRIPT_KEY_PREFIX))
  if (keys.length <= KEPT_TRANSCRIPTS) return
  const dated = await Promise.all(
    keys.map(async key => {
      const value = (await $.store.get(key)) as { at?: unknown } | undefined
      return { key, at: typeof value?.at === 'number' ? value.at : 0 }
    }),
  )
  dated.sort((x, y) => y.at - x.at)
  await Promise.all(dated.slice(KEPT_TRANSCRIPTS).map(({ key }) => $.store.delete(key)))
}

// Open the pane where the mode draws the rail in it; close it elsewhere (off,
// or horizontal on the terminal, where the band carries the rail).
async function seatRail($: EngineInterface, mode: Mode, isTerminal: boolean) {
  if (mode === 'off' || (mode === 'horizontal' && isTerminal)) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: 'Prompts', columns: RAIL_COLUMNS })
  }
}

// Write the mode setting, as a change in /config would; say so if refused.
// A session with no /config row for plugin fields (the desktop app's SDK
// sessions) throws instead of denying, and the mode then holds for this
// session only.
async function writeMode($: EngineInterface, mode: Mode) {
  try {
    const result = await $.config.set({ key: MODE_SETTING, value: mode })
    if (result.deny) $.ui.toast(`prompt-rail: the mode was not saved: ${result.deny}`)
  } catch (err) {
    await $.store.set(`${SESSION_MODE_KEY_PREFIX}${await $.session.id()}`, mode)
    $.ui.toast(`prompt-rail: ${mode} for this session; the mode was not saved: ${(err as Error).message}`)
  }
}

// Scroll the transcript to a prompt's row, drawn under `target`, from a
// dispatch that answers the person's own input (a press, a typed command): a
// transcript row moves only then. Records whether the prompt could be reached,
// and returns whether the transcript scrolled to it.
async function jumpTo($: EngineInterface, id: string, target: string, unreachable: Set<string>) {
  try {
    const result = await $.ui.scroll({ to: { requestId: target }, block: 'start' })
    if (result.deny) $.ui.toast(`prompt-rail: ${result.deny}`)
    if (noteScroll(unreachable, id, result.deny)) await redrawRail($)
    return !result.deny
  } catch (err) {
    $.ui.toast(`prompt-rail: ${(err as Error).message}`)
    return false
  }
}

// Draw the rail's sites again, and them alone (see MOVED).
async function redrawRail($: EngineInterface) {
  const { value = 0 } = await $.state.get(MOVED)
  await $.state.set(MOVED, value + 1)
}

// The same from a render hook, which may not write state: once its dispatch ends.
function redrawRailLater($: EngineInterface) {
  $.clock.after(0, () => void redrawRail($))
}

// The timers of a redraw waiting for onScreen reports to settle.
type Settle = { quiet?: Timer; latest?: Timer }

// Draw the rail again once onScreen reports settle, if `isStale` then says the
// drawing no longer shows the prompt being read: SETTLE_MS after the last
// report, and no later than SETTLE_MAX_MS after the first, so reports that
// never pause (a scroll held down, a running tool row) still redraw it. A
// remounted row replays where it was last seen and a layout may settle over
// two frames; the surface corrects both within a frame or two.
function redrawRailSettled($: EngineInterface, settle: Settle, isStale: () => boolean) {
  const fire = () => {
    settle.quiet?.cancel()
    settle.latest?.cancel()
    settle.quiet = undefined
    settle.latest = undefined
    if (isStale()) void redrawRail($)
  }
  settle.quiet?.cancel()
  settle.quiet = $.clock.after(SETTLE_MS, fire)
  settle.latest ??= $.clock.after(SETTLE_MAX_MS, fire)
}

// After one onScreen report: a row that said it is cut at the viewport's top
// is confirmed once a replay would have been corrected (see SETTLE_MS), and
// the rail is drawn again once reports settle.
function afterReport<Row>($: EngineInterface, settle: Settle, cut: Row | undefined, confirm: (row: Row) => void, isStale: () => boolean) {
  if (cut !== undefined) $.clock.after(SETTLE_MS, () => confirm(cut))
  redrawRailSettled($, settle, isStale)
}

// The transcript path remembered for this session, if any.
async function rememberedTranscript($: EngineInterface) {
  const value = (await $.store.get(`${TRANSCRIPT_KEY_PREFIX}${await $.session.id()}`)) as { path?: unknown } | undefined
  return typeof value?.path === 'string' ? value.path : undefined
}

export const register: Register = (on, options) => {
  let entries: Entry[] = []
  // Assistant row key -> the key of the prompt it answers, from the transcript.
  let owners = new Map<string, string>()
  // Prompt id -> the turn it started, from the transcript.
  let turns = new Map<string, Turn>()
  // Prompt row key -> how long its turns took as the engine reported them on
  // ending, for a turn whose turn_duration row the transcript lacks yet.
  const reported = new Map<string, number>()
  // Prompt row key -> how its turn ended as the engine reported it, and whether the
  // newest prompt's turn is running now.
  const ended = new Map<string, Outcome>()
  let isRunning = false
  // How many prompts were listed when the session last came to rest (a turn
  // ended, or the session started), and whether the running turn is a
  // continuation with no typed text. A new prompt's turn may start before its
  // row is stored, so the newest entry is the running turn's own only once a
  // prompt has been listed since the rest; text alone cannot tell, since the
  // person may send the same text twice.
  let listedAtRest = 0
  let isContinuation = false
  // The text of the prompt that started the main loop's latest turn, and the
  // id of its entry once its row is drawn (see listDrawn).
  let turnText = ''
  let starter: string | undefined
  // The entry of the prompt that started the latest turn, not the newest,
  // since a prompt delivered into the turn comes after it, with the same text
  // or not.
  const turnEntry = () => {
    const started = entries.find(entry => entry.id === starter)
    if (started) return started
    for (let i = entries.length - 1; i >= 0; i--) if (turnText && entries[i]!.text === turnText) return entries[i]
    return entries[entries.length - 1]
  }
  const isRunningFor = (id: string) => {
    if (!isRunning || turnEntry()?.id !== id) return false
    return isContinuation || entries.length > listedAtRest
  }
  // A prompt's turn as the rail shows it: the transcript's record, completed
  // by what the engine reported before the transcript had it.
  const turnOf = (id: string): Turn | undefined => {
    const turn = turns.get(id)
    const ms = turn?.durationMs ?? reported.get(rowKey(id))
    const outcome = isRunningFor(id) ? 'running' : (turn?.outcome ?? ended.get(rowKey(id)))
    if (!turn && ms === undefined && outcome === undefined) return undefined
    return { tools: 0, files: [], ...turn, ...(ms === undefined ? {} : { durationMs: ms }), ...(outcome ? { outcome } : {}) }
  }
  // The transcript rows (prompts, replies, tool rows) the viewport shows, by
  // component and the id each is drawn under: the key its prompt is found by,
  // where it is on screen, and when it said so. A row reports only when that
  // changes, so one that stays whole in the viewport is silent while others
  // scroll past it; it is dropped once it says it left.
  type Shown = { name: string; key: string; first: number; order: number }
  const onScreen = new Map<string, Shown>()
  let reports = 0
  // The row key of the prompt being read, kept while no known row shows.
  let reading: string | undefined
  // The prompt the rail last drew as being read, and the redraw waiting for
  // reports to settle.
  let drawnCurrent = -1
  const settle: Settle = {}
  // The prompt a jump landed on, read while the rows that came into view as it
  // landed are all that show: one near the end cannot reach the viewport's
  // top, so rows of earlier prompts stay above it. `shown` holds those rows'
  // prompts; `isSettled` once they had SETTLE_MAX_MS to report.
  let landed: { key: string; shown: Set<number>; isSettled: boolean } | undefined
  // Prompts whose rows the surface does not draw, learnt from a refused jump.
  const unreachable = new Set<string>()
  const seen: Seen = unseen()
  // Row key -> the id a prompt's row was last drawn under (see drawnRow).
  const drawn = new Map<string, string>()
  // The ids of the prompts the last transcript read listed.
  let filed = new Set<string>()

  const addPrompt = (id: string, text: string) => {
    // A new prompt is drawn under a provisional id before it is stored, then
    // again under its uuid: list the stored row only, so a repeated prompt
    // ("continue" twice) still gets an entry of its own.
    if (id === PROVISIONAL_ID || entries.some(entry => rowKey(entry.id) === rowKey(id))) return false
    entries = [...entries, { id, text }]
    return true
  }

  // A prompt that does not go straight into a turn (queued behind the running
  // one, delivered into it, or sent from Remote Control) is drawn under ids the
  // engine never stores before its stored row comes. Its entry is pending
  // meanwhile: rows drawn with its text are other names of it (row key ->
  // entry id), and its stored row takes its place in the list.
  const pending = new Set<string>()
  const aliases = new Map<string, string>()
  // Texts of prompts sent and not stored yet: from prompt.submit or
  // session.receive until the stored row is drawn or the main loop rests.
  const waiting = new Set<string>()
  // The text of the prompt last drawn under the provisional id, until its
  // stored row is drawn.
  let provisional: string | undefined
  // Entries added since the last notification, placeholder or turn edge, and
  // when: the engine may draw a queued prompt's first row before its
  // notification, which then takes it for that prompt's.
  let lately: { id: string; at: number }[] = []
  // When each waiting text's notification came, and the pending entries
  // delivered into the running turn: a row of theirs drawn well after the
  // notification is the attachment the turn read, and no provisional row
  // follows, so the turn's end leaves them pending no more.
  const notifiedAt = new Map<string, number>()
  const delivered = new Set<string>()

  const pendingWith = (text: string) => entries.find(entry => pending.has(entry.id) && entry.text === text)
  // The entry a drawn row belongs to, by its own key or as another name.
  const entryKeyOf = (key: string) => {
    if (entries.some(entry => rowKey(entry.id) === key)) return key
    const id = aliases.get(key)
    return id === undefined ? key : rowKey(id)
  }

  // A prompt with `text` was sent: its rows are pending until the stored one
  // is drawn. True when the list changed.
  const noteSent = (text: string) => {
    waiting.add(text)
    const now = Date.now()
    notifiedAt.set(text, now)
    const fresh = new Set(lately.filter(item => now - item.at <= LATELY_MS).map(item => item.id))
    lately = []
    const own = entries.filter(entry => fresh.has(entry.id) && entry.text === text && !pending.has(entry.id))
    const held = pendingWith(text) ?? own[0]
    if (!held || own.length === 0) return false
    pending.add(held.id)
    const others = new Set(own.filter(entry => entry !== held).map(entry => entry.id))
    for (const id of others) aliases.set(rowKey(id), held.id)
    entries = entries.filter(entry => !others.has(entry.id))
    return others.size > 0
  }

  // List a prompt row as it is drawn; true when the list changed.
  const listDrawn = (id: string, text: string) => {
    if (id === PROVISIONAL_ID) {
      provisional = text
      lately = []
      return false
    }
    const key = rowKey(id)
    if (entries.some(entry => rowKey(entry.id) === key)) {
      // A stored row a transcript read listed first still ends its prompt.
      if (provisional === text) {
        provisional = undefined
        waiting.delete(text)
        if (isRunning) starter = entries.find(entry => rowKey(entry.id) === key)?.id
      }
      return false
    }
    const alias = aliases.get(key)
    if (alias !== undefined) {
      drawn.set(rowKey(alias), id)
      return false
    }
    if (provisional === text) {
      provisional = undefined
      waiting.delete(text)
      if (isRunning) starter = id
      const held = pendingWith(text)
      if (!held) return addPrompt(id, text)
      // The stored row takes the place of the entry that waited for it.
      entries = entries.map(entry => (entry === held ? { id, text } : entry))
      pending.delete(held.id)
      for (const [name, target] of aliases) if (target === held.id) aliases.set(name, id)
      aliases.set(rowKey(held.id), id)
      return true
    }
    if (waiting.has(text)) {
      const held = pendingWith(text)
      if (held) {
        // Another row of the waiting prompt; a jump goes to the one drawn last.
        aliases.set(key, held.id)
        drawn.set(rowKey(held.id), id)
        if (isRunning && Date.now() - (notifiedAt.get(text) ?? Date.now()) > LATELY_MS) delivered.add(held.id)
        return false
      }
      pending.add(id)
      return addPrompt(id, text)
    }
    const isAdded = addPrompt(id, text)
    if (isAdded) lately = [...lately, { id, at: Date.now() }]
    // A turn's prompt drawn with no provisional row, as the session's first.
    if (isAdded && isRunning && starter === undefined && text === turnText) starter = id
    return isAdded
  }

  // Record one onScreen report: where a row is on screen, or null once it left.
  // Rows drawn while a subagent's transcript is in view are not the main
  // conversation's, which alone the rail lists. Returns the row when it says
  // it is cut at the viewport's top, for dropAbove to confirm.
  const see = (component: string, id: string, place: { first: number } | null) => {
    if (viewAgent !== undefined) return undefined
    const name = `${component}\u0000${id}`
    if (place === null) {
      onScreen.delete(name)
      if (landed && !isLandedShown()) landed = undefined
      return undefined
    }
    const row = { name, key: rowKey(id), first: place.first, order: ++reports }
    onScreen.set(name, row)
    noteLandedRow(row.key)
    return row.first > 0 ? row : undefined
  }

  // The index of the prompt a drawn row belongs to, a reply counting as its
  // prompt's; undefined for a row that places no one.
  const indexOfRow = (key: string, promptIndex: Map<string, number>) => {
    if (key === PROVISIONAL_ID) return undefined
    const id = entryKeyOf(key)
    const ownerId = owners.get(id)
    // A reply or tool row the transcript read does not know was written
    // after it: the Stop hook reads before the turn's last reply is stored,
    // and a running turn's rows come later still. A turn's start reads the
    // file again, so only the newest turn can own it.
    return promptIndex.get(id) ?? (ownerId === undefined ? entries.length - 1 : promptIndex.get(ownerId))
  }
  const promptIndexes = () => new Map(entries.map((entry, i) => [rowKey(entry.id), i]))

  const landedIndex = () => (landed ? entries.findIndex(entry => rowKey(entry.id) === landed?.key) : -1)
  const isLandedShown = () => {
    const i = landedIndex()
    const promptIndex = promptIndexes()
    return i >= 0 && [...onScreen.values()].some(row => indexOfRow(row.key, promptIndex) === i)
  }
  // A row of a prompt that was not in view as the jump landed: the person
  // scrolled, so the top row says who is read again.
  const noteLandedRow = (key: string) => {
    if (!landed) return
    const i = indexOfRow(key, promptIndexes())
    if (i === undefined) return
    if (!landed.isSettled) landed.shown.add(i)
    else if (!landed.shown.has(i)) landed = undefined
  }

  // The prompt of the row that last said it is cut at the viewport's top: that
  // row is the top one, so a row of an earlier prompt still listed left
  // without saying so, as rows do in a jump. Unless a row of an earlier prompt
  // said it is on screen since: the viewport then moved above the cut row,
  // which left without saying so itself.
  const topIndex = (promptIndex: Map<string, number>) => {
    const rows = [...onScreen.values()].flatMap(row => {
      const i = indexOfRow(row.key, promptIndex)
      return i === undefined ? [] : [{ i, first: row.first, order: row.order }]
    })
    let top: (typeof rows)[number] | undefined
    for (const row of rows) {
      if (row.first <= 0 || (top && row.order < top.order)) continue
      if (rows.some(other => other.i < row.i && other.order > row.order)) continue
      top = row
    }
    return top?.i
  }

  // A row still cut at the viewport's top a while after it said so is the top
  // one: drop the rows of earlier prompts for good, so they cannot come back
  // when it turns whole. Not sooner: a remounted row replays where it was last
  // seen and says where it is a frame later. Not when a row of an earlier
  // prompt said it is on screen since, as then the viewport moved above it.
  const dropAbove = (cut: Shown) => {
    const row = onScreen.get(cut.name)
    if (!row || row.first <= 0) return
    const promptIndex = promptIndexes()
    const top = indexOfRow(row.key, promptIndex)
    if (top === undefined) return
    const isAbove = (other: Shown) => (indexOfRow(other.key, promptIndex) ?? top) < top
    if ([...onScreen.values()].some(other => other.order > row.order && isAbove(other))) return
    for (const [name, other] of onScreen) if (isAbove(other)) onScreen.delete(name)
  }

  // Where the person is reading: the prompt that the topmost row on screen
  // belongs to. Kept while no known row shows.
  const currentIndex = () => {
    const jumped = landedIndex()
    if (jumped >= 0) {
      reading = landed?.key
      return jumped
    }
    landed = undefined
    const promptIndex = promptIndexes()
    // Rows above the top one are read past until it is confirmed (see dropAbove).
    const top = topIndex(promptIndex)
    let best = -1
    for (const row of onScreen.values()) {
      const i = indexOfRow(row.key, promptIndex)
      if (i === undefined || (top !== undefined && i < top)) continue
      if (best < 0 || i < best) best = i
    }
    const entry = entries[best]
    if (entry) reading = rowKey(entry.id)
    if (reading === undefined) return -1
    // By key, and through another name, so a stored row that takes a pending
    // entry's place, or a rewind that drops an earlier prompt, keeps it.
    const key = entryKeyOf(reading)
    return entries.findIndex(entry => rowKey(entry.id) === key)
  }
  // Whether the rail's drawing no longer shows the prompt being read.
  const isDrawnStale = () => currentIndex() !== drawnCurrent

  // After a jump lands, the rows before it left and the prompt jumped to is
  // at the top, though rows may not say so: a row that stays whole is silent,
  // and one that unmounts may never report it left.
  const landOn = (id: string, target: string, index: number) => {
    onScreen.clear()
    const name = `UserMessage\u0000${target}`
    onScreen.set(name, { name, key: rowKey(target), first: 0, order: ++reports })
    reading = rowKey(id)
    const jump = { key: rowKey(id), shown: new Set([index]), isSettled: false }
    landed = jump
    return jump
  }

  // Whether the transcript read knows a drawn row, as a prompt or a reply.
  const isKnownRow = (key: string) => {
    const id = entryKeyOf(key)
    return entries.some(entry => rowKey(entry.id) === id) || owners.has(id)
  }

  // The rail's sites say whose transcript is in view; the rows a switch
  // leaves were another transcript's, and those it brings report anew.
  const noteView = (agentId: string | undefined) => {
    if (agentId !== viewAgent) {
      onScreen.clear()
      landed = undefined
    }
    viewAgent = agentId
  }

  // A change of the setting reloads this module with the new value.
  let mode: Mode = isMode(options.mode) ? options.mode : 'horizontal'
  // The subagent whose transcript is in view, as the rail's sites last drew;
  // undefined for the main conversation, whose rows alone the rail lists.
  let viewAgent: string | undefined
  // Only the terminal draws the band; elsewhere the pane is the one site.
  let isTerminal = false
  let railColumns = 0
  // The horizontal bar whose card the text line shows, while the ring is on
  // it, and the timer that stops showing it.
  let ringed: number | undefined
  let ringFade: Timer | undefined
  const unring = () => {
    ringFade?.cancel()
    ringFade = undefined
    ringed = undefined
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      // Named after the plugin: a plugin's commands share one namespace with
      // every other plugin's and the built-ins, so a generic name would collide.
      name: 'prompt-rail',
      description:
        'Show the prompt rail: vertical (a pane beside the transcript), horizontal (above the prompt) or off; next, prev, first, last, a number or find <words> jumps to a prompt.',
      argumentHint: USAGE,
      // Runs while a turn streams, so next and prev move through it then too.
      immediate: true,
    })
    // Argument-free, so a keybinding can name them (`command:prompt-rail-next`):
    // a binding runs a command bare.
    for (const [name, way] of STEP_COMMANDS) {
      await $.command.register({ name, description: `Jump to the ${way} prompt in the prompt rail.`, immediate: true })
    }
    isTerminal = e.surface === 'terminal'
    // Move a mode an earlier version stored into the setting, once. Writing
    // the setting reloads this module, so everything after it is best effort.
    const stored = await $.store.get(LEGACY_MODE_KEY)
    if (stored !== undefined) await $.store.delete(LEGACY_MODE_KEY)
    if (isMode(stored) && stored !== mode) {
      mode = stored
      await writeMode($, mode)
    }
    // A mode kept for this session only outlives a reload of this module.
    const kept = await $.store.get(`${SESSION_MODE_KEY_PREFIX}${await $.session.id()}`)
    if (isMode(kept)) mode = kept
    // Also fired after a hot reload, when the list starts empty: rebuild it from
    // the transcript this session's classic SessionStart remembered.
    const transcriptPath = await rememberedTranscript($)
    const index = transcriptPath === undefined ? undefined : await readTranscript($, transcriptPath, seen, index => {
      if (merge(index)) void redrawRail($)
    })
    if (index && merge(index)) await redrawRail($)
    if (!isRunning) listedAtRest = entries.length
    // Unasked, the engine seats a pane only from 144 columns (110 once the
    // person has opened it with /prompt-rail); below that it waits undrawn.
    await seatRail($, mode, isTerminal)
    return next(e)
  })

  // The prompt a command asks for: its index among the entries, or why none
  // (undefined when the command asks for no prompt).
  const askedIndex = (command: string, asked: string): number | undefined => {
    const way = STEP_COMMANDS.find(([name]) => name === command)?.[1]
    if (way !== undefined || asked === 'next' || asked === 'prev') {
      const dir = way === 'next' || asked === 'next' ? 1 : -1
      return stepFrom(currentIndex(), entries.length, dir, isUnreachable)
    }
    return pickPrompt(asked, entries.map(entry => entry.text))
  }
  const missingFor = (command: string, asked: string) => {
    if (command === 'prompt-rail-next' || asked === 'next') return 'no later prompt'
    if (command === 'prompt-rail-prev' || asked === 'prev') return 'no earlier prompt'
    return `no prompt ${asked}`
  }

  on('command.run', async ($, e, next) => {
    const isStep = STEP_COMMANDS.some(([name]) => name === e.command)
    if (!isStep && e.command !== 'prompt-rail') return next(e)
    const asked = isStep ? '' : e.args.trim()
    unring()
    const index = askedIndex(e.command, asked)
    if (index !== undefined) {
      // The main conversation's rows are not drawn beside a subagent's, so a
      // jump would be refused and wrongly dot a prompt that can be reached.
      if (viewAgent !== undefined) {
        $.ui.toast('prompt-rail: jumps move through the main conversation; switch back to it first')
        return {}
      }
      const entry = entries[index]
      const target = entry && drawnRow(drawn, entry.id)
      if (entry && target && (await jumpTo($, entry.id, target, unreachable))) {
        const jump = landOn(entry.id, target, index)
        $.clock.after(SETTLE_MAX_MS, () => {
          jump.isSettled = true
        })
        if (isDrawnStale()) await redrawRail($)
      }
      if (!entry) $.ui.toast(`prompt-rail: ${missingFor(e.command, asked)}`)
      return {}
    }
    if (asked && !isMode(asked)) {
      $.ui.toast(`prompt-rail: /prompt-rail ${USAGE}`)
      return {}
    }
    // Reopening a rail that is off would only close it again: say how to turn it on.
    if (!asked && mode === 'off') {
      $.ui.toast('prompt-rail: the rail is off; /prompt-rail vertical or /prompt-rail horizontal turns it on')
      return {}
    }
    if (isMode(asked)) mode = asked
    await seatRail($, mode, isTerminal)
    await redrawRail($)
    // Last: a changed setting reloads this module, which then starts in it.
    if (isMode(asked)) await writeMode($, asked)
    return {}
  })

  // Rebuild the list from the transcript file, whose uuids are the ids the
  // transcript rows are drawn under. A resumed session so lists prompts the
  // surface has not drawn yet; a row drawn but not stored yet stays after them,
  // and one the file holds off the live branch (rewound away) drops out. True
  // when the list or the prompt being read changed, so the rail needs a redraw.
  const merge = (index: TranscriptIndex) => {
    // A turn's details count as the list's: a turn that ends changes its card.
    const listed = (list: Entry[]) => list.map(entry => `${entry.id}\u0000${entry.text}\u0000${turnLine(turnOf(entry.id))}`).join('\u0001')
    const before = { list: listed(entries), current: currentIndex() }
    // An entry whose row, or another name of it, the file holds is listed
    // from the file.
    const known = new Set([...index.known].map(rowKey))
    for (const [name, id] of aliases) if (known.has(name)) known.add(rowKey(id))
    // An entry the last read listed and this one does not is gone from the
    // file (replaced under the rail), not a row drawn before it was stored.
    entries = [...index.prompts, ...entries.filter(entry => !known.has(rowKey(entry.id)) && !filed.has(entry.id))]
    filed = new Set(index.prompts.map(entry => entry.id))
    const ids = new Set(entries.map(entry => entry.id))
    for (const id of pending) if (!ids.has(id) || known.has(rowKey(id))) pending.delete(id)
    for (const [name, id] of aliases) if (!ids.has(id)) aliases.delete(name)
    owners = new Map(index.owners.map(([id, i]) => [rowKey(id), rowKey(index.prompts[i]?.id ?? '')]))
    turns = new Map(index.prompts.map((entry, i) => [entry.id, index.turns[i] ?? { tools: 0, files: [] }]))
    return listed(entries) !== before.list || currentIndex() !== before.current
  }

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      entries = []
      owners = new Map()
      turns = new Map()
      reported.clear()
      ended.clear()
      isRunning = false
      onScreen.clear()
      landed = undefined
      reading = undefined
      drawnCurrent = -1
      unreachable.clear()
      drawn.clear()
      filed = new Set()
      pending.clear()
      aliases.clear()
      waiting.clear()
      provisional = undefined
      lately = []
      turnText = ''
      starter = undefined
      notifiedAt.clear()
      delivered.clear()
      Object.assign(seen, unseen())
      await redrawRail($)
    } else {
      const index = await readTranscript($, e.transcript_path, seen, index => {
      if (merge(index)) void redrawRail($)
    })
      if (index && merge(index)) await redrawRail($)
    }
    listedAtRest = entries.length
    await rememberTranscript($, e.session_id, e.transcript_path)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const index = await readTranscript($, e.transcript_path, seen, index => {
      if (merge(index)) void redrawRail($)
    })
    if (index && merge(index)) await redrawRail($)
    return next(e)
  })

  // A main-loop turn starts (a subagent's run raises none): the newest
  // prompt's turn is running.
  on('turn.start', async ($, e, next) => {
    isRunning = true
    // The transcript follows the new turn down from the prompt jumped to.
    landed = undefined
    isContinuation = e.text.trim() === ''
    turnText = e.text.replace(VIEW_CONTEXT, '').trim()
    starter = undefined
    lately = []
    // Every row of the turns before is stored by now: read them, so a row the
    // index does not know can only be this turn's (see currentIndex).
    const index = seen.path
      ? await readTranscript($, seen.path, seen, index => {
          if (merge(index)) void redrawRail($)
        })
      : undefined
    if (index) {
      merge(index)
      // A row the file no longer holds (rewound or compacted away) would
      // count as this turn's.
      for (const [name, row] of onScreen) if (!isKnownRow(row.key)) onScreen.delete(name)
    }
    await redrawRail($)
    return next(e)
  })

  // A main-loop turn ended: its prompt is the one that started it (see
  // turnEntry). The transcript's
  // turn_duration row is written after the Stop hook reads the file, so keep
  // the engine's figure and how the turn ended until a later read has them.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const entry = turnEntry()
    if (e.agentId === undefined) {
      isRunning = false
      // A prompt still waiting now is queued behind this turn; its rows to
      // come follow its provisional row.
      waiting.clear()
      notifiedAt.clear()
      for (const id of delivered) pending.delete(id)
      delivered.clear()
      lately = []
      listedAtRest = entries.length
      if (entry) {
        // By row key: a prompt drawn under a derived id is listed under its
        // stored uuid once the transcript is read.
        const key = rowKey(entry.id)
        reported.set(key, (reported.get(key) ?? 0) + e.durationMs)
        if (e.reason === 'aborted') ended.set(key, 'interrupted')
        if (e.reason === 'error') ended.set(key, 'error')
      }
      await redrawRail($)
    }
    return result
  })

  // A prompt was sent: typed, or delivered from Remote Control. Its rows drawn
  // before the stored one are pending (see listDrawn).
  on('prompt.submit', async ($, e, next) => {
    unring()
    if (PROMPT_KINDS.has(e.origin.kind) && noteSent(e.text.replace(VIEW_CONTEXT, '').trim())) await redrawRail($)
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    if (PROMPT_KINDS.has(e.origin.kind) && noteSent(e.text.replace(VIEW_CONTEXT, '').trim())) await redrawRail($)
    return next(e)
  })

  // Record every prompt row as it is drawn, and which rows the viewport shows.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // A slash command's row is drawn as a user row too; it is not a prompt.
    const text = e.props.text.replace(VIEW_CONTEXT, '').trim()
    if (PROMPT_KINDS.has(e.props.origin.kind) && text && !text.startsWith('/')) {
      drawn.set(rowKey(e.requestId), e.requestId)
      if (listDrawn(e.requestId, text)) redrawRailLater($)
      if (e.props.onScreen !== undefined) {
        afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
      }
    }
    return next(e)
  })

  // A reply or a tool row on screen places the person under the prompt it
  // answers. Tool rows are drawn under their tool_use id; a collapsed group
  // counts as its first call.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, e.requestId, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const id = e.props.calls.find(call => call.tool_use_id)?.tool_use_id
    if (id && e.props.onScreen !== undefined) {
      afterReport($, settle, see(e.component, id, e.props.onScreen), dropAbove, isDrawnStale)
    }
    return next(e)
  })

  const isUnreachable = (i: number) => unreachable.has(entries[i]?.id ?? '')

  // A prompt's text and its turn's details on one line `width` cells wide: the
  // text is cut first, down to a few words, then the details name fewer files.
  const withTurn = (entry: Entry, width: number) => {
    const details = turnLine(turnOf(entry.id), width - MIN_CARD_TEXT - ' · '.length)
    if (!details) return oneLine(entry.text, width)
    const room = Math.max(MIN_CARD_TEXT, width - cellWidth(details) - ' · '.length)
    return `${oneLine(entry.text, room)} · ${details}`
  }

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Read so a moved prompt being read draws the pane again (see MOVED).
    await $.state.get(MOVED)
    const { Box, Text, Button } = $.ui.resolve(e)
    const isRail = e.props.placement === 'dock' && e.surface === 'terminal'
    noteView(e.props.view.agentId)
    const nextColumns = isRail ? e.props.bodyColumns : 0
    if (nextColumns !== railColumns) {
      // The band decides from this whether it carries the cards.
      railColumns = nextColumns
      redrawRailLater($)
    }
    // The rail lists the main conversation's prompts, which a subagent's
    // transcript does not hold, so pressing one there could not scroll to it.
    if (e.props.view.agentId !== undefined) {
      const hasRoom = !isRail || e.props.bodyColumns >= INLINE_REVEAL_MIN_COLUMNS
      return <Text dimColor wrap="truncate-end">{hasRoom ? 'Prompts of the main conversation only' : '·'}</Text>
    }
    if (entries.length === 0) {
      return <Text dimColor>{isRail ? '·' : 'No prompts yet'}</Text>
    }
    const current = currentIndex()
    drawnCurrent = current
    // Docked on the terminal: one row per prompt, its tick and its text, the
    // whole row pressable. Too narrow for text, ticks alone (the band shows it).
    if (isRail) {
      const hasRoom = e.props.bodyColumns >= INLINE_REVEAL_MIN_COLUMNS
      const width = Math.max(4, e.props.bodyColumns - 4)
      return (
        <Box flexDirection="column">
          {entries.map((entry, i) => (
            <Button
              key={`jump-${i}`}
              plain
              dimColor={i !== current}
              label={
                hasRoom
                  ? ` ${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, width)}`
                  : ` ${tick(i === current, isUnreachable(i))} `
              }
              hover={{ scope: `prompt-rail-${i}`, inverse: true, dimColor: false }}
              onPress={() => {}}
            />
          ))}
        </Box>
      )
    }
    // Elsewhere (inline, or a surface with no band for the card): list the text.
    const width = Math.max(8, e.props.bodyColumns - 3)
    return (
      <Box flexDirection="column">
        {entries.map((entry, i) => (
          <Button
            key={`jump-${i}`}
            plain
            dimColor={i !== current}
            label={`${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, width)}`}
            onPress={() => {}}
          />
        ))}
      </Box>
    )
  })

  // The band above the prompt (terminal only). Horizontal: the rail itself, a
  // row of ticks with the hovered prompt beside them. Vertical with a dock too
  // narrow to reveal beside a tick: hidden cards the rail's ticks reveal.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await $.state.get(MOVED)
    noteView(e.props.view.agentId)
    // Nothing while the rail is off, a survey holds the band or a subagent's transcript is in view.
    if (mode === 'off' || e.props.hasSurvey || e.props.view.agentId !== undefined || entries.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cards = (width: number) =>
      entries.map((entry, i) => (
        <Box key={`card-${i}`} display="none" hover={{ scope: `prompt-rail-${i}`, display: 'flex' }}>
          <Text dimColor>{`#${i + 1} `}</Text>
          <Text wrap="truncate-end">{withTurn(entry, width)}</Text>
        </Box>
      ))

    if (mode === 'horizontal') {
      // Two rows: the text line, then the bars beside the prompt. The text line
      // shows the prompt being read, dim, and the hovered one's card painted
      // over it; the bar of the prompt being read is heavy.
      const width = Math.max(8, e.props.bodyColumns - 2 - RAIL_INSET)
      const current = currentIndex()
      drawnCurrent = current
      const shownRing = ringed !== undefined && ringed < entries.length ? ringed : undefined
      // More prompts than cells: a window of bars centered on the prompt being
      // read (the newest when none is known), `‹` and `›` marking what it hides.
      // It stays put while the ring moves: the ring keeps its place in the row,
      // not its bar, so a shifted window would move it to another prompt.
      const isOverflowing = entries.length > width
      const capacity = isOverflowing ? width - 2 : entries.length
      const center = current >= 0 ? current : entries.length - 1
      const first = Math.min(Math.max(0, center - Math.floor(capacity / 2)), entries.length - capacity)
      const shown = entries.slice(first, first + capacity)
      const hidesAfter = first + capacity < entries.length
      const label = (i: number) => `#${i + 1} ${oneLine(entries[i]?.text ?? '', width - `#${i + 1} `.length)}`
      // The hovered prompt's card also sums up its turn.
      const card = (i: number) => {
        const entry = entries[i]
        return entry ? `#${i + 1} ${withTurn(entry, width - `#${i + 1} `.length)}` : ''
      }
      return (
        <Box flexDirection="column" paddingLeft={RAIL_INSET}>
          <Box height={1} width={width}>
            {/* With no prompt known on screen, the newest: an empty line reads as a broken rail. */}
            {shownRing === undefined ? <Text dimColor wrap="truncate-end">{label(center)}</Text> : <Text wrap="truncate-end">{padTo(card(shownRing), width)}</Text>}
            {entries.map((_, i) => (
              <Box key={`card-${i}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `prompt-rail-${i}`, display: 'flex' }}>
                <Text wrap="truncate-end">{padTo(card(i), width)}</Text>
              </Box>
            ))}
          </Box>
          <Box flexDirection="row">
            {isOverflowing ? <Text dimColor>{first > 0 ? '‹' : ' '}</Text> : null}
            {shown.map((entry, offset) => {
              const i = first + offset
              return (
                <Button
                  key={`jump-${i}`}
                  plain
                  dimColor={i !== current}
                  label={bar(i === current, isUnreachable(i))}
                  hover={{ scope: `prompt-rail-${i}`, inverse: true, dimColor: false }}
                  autoFocus={i === center || undefined}
                  onPress={() => {}}
                />
              )
            })}
            {hidesAfter ? <Text dimColor>›</Text> : null}
          </Box>
        </Box>
      )
    }

    if (railColumns > 0 && railColumns < INLINE_REVEAL_MIN_COLUMNS) {
      return <Box flexDirection="column">{cards(Math.max(8, e.props.bodyColumns - 8))}</Box>
    }
    return next(e)
  })

  // The band holds the keyboard after a click or ctrl+x tab: the ring starts
  // on the bar of the prompt being read, the arrows move it, Enter jumps. A
  // scroll is refused here (it is no press), so the text line shows the
  // ringed prompt's card instead, for RING_CARD_MS after each move.
  on('ui.focus', { component: 'AbovePrompt', plugin: 'prompt-rail' }, async ($, e, next) => {
    if (mode !== 'horizontal') return next(e)
    const result = await next(e)
    const index = Number(/^jump-(\d+)/.exec(e.element ?? '')?.[1])
    if (result.deny || !Number.isInteger(index)) return result
    unring()
    ringed = index
    ringFade = $.clock.after(RING_CARD_MS, () => {
      unring()
      void redrawRail($)
    })
    await redrawRail($)
    return result
  })

  // In the pane, a ringed row and the row under the pointer light at once and
  // read as two highlights. Keep the ring off the rows; a click still presses,
  // and /prompt-rail next and prev are its keyboard route. The engine's own
  // stops (the close mark, the tabs) carry no plugin, so the matcher leaves
  // them be.
  on('ui.focus', { component: 'Pane', requestId: PANE, plugin: 'prompt-rail' }, async () => ({
    deny: 'prompt-rail: the rail takes clicks, not the focus ring',
  }))

  // Scroll from the press dispatch itself (a click).
  on('ui.press', { plugin: 'prompt-rail' }, async ($, e, next) => {
    const index = Number(/^jump-(\d+)/.exec(e.element)?.[1])
    unring()
    const entry = entries[index]
    const target = entry && drawnRow(drawn, entry.id)
    if (entry && target && (await jumpTo($, entry.id, target, unreachable))) {
      const jump = landOn(entry.id, target, index)
      $.clock.after(SETTLE_MAX_MS, () => {
        jump.isSettled = true
      })
      if (isDrawnStale()) await redrawRail($)
    }
    return next(e)
  })
}
