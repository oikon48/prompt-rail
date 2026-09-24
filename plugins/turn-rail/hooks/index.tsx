import type { EngineInterface, Register } from 'claude-code'

const PANE = 'turn-rail'
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
const MODE_SETTING = 'turn-rail.mode'
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
// The notice the engine stores as a user row when the person interrupts a turn.
const INTERRUPTED = /^\[Request interrupted by user/
// onScreen reports that arrive within this many ms of each other are one pass
// of the surface (a scroll, or a redraw), read together.
const PASS_MS = 150
// Cells kept left of the horizontal rail: off the window's edge, a pointer
// leaving the first bar crosses a cell and the surface sees the hover end.
const RAIL_INSET = 2
// The engine's refusal when no row is drawn under an id, as for a slash
// command's own row, which the transcript file holds but the surface skips.
// Other refusals (a race with another move) pass, so they leave the tick be.
const NOT_DRAWN = /nothing drawn/

// vertical: ticks in a docked pane; horizontal: ticks in a row above the prompt.
type Mode = 'vertical' | 'horizontal'
const isMode = (value: unknown): value is Mode => value === 'vertical' || value === 'horizontal'

type Entry = { id: string; text: string }

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

// What the transcript records of the turn a prompt started: how long it took
// (`durationMs` as the engine reported it, else `spanMs` from the prompt to
// the latest reply), how many tools it called, the paths of the files it
// edited (Edit and Write), and, unless it simply answered, how it went.
export type Turn = { durationMs?: number; spanMs?: number; tools: number; files: string[]; outcome?: Outcome }
// A turn still running, stopped by the person, or ended by an API error.
type Outcome = 'running' | 'interrupted' | 'error'
const OUTCOME_WORDS: Record<Outcome, string> = { running: 'running', interrupted: 'interrupted', error: 'API error' }

// The mark beside a prompt's tick, by how its turn went, in theme colors.
type Mark = { glyph: string; color: string }
const MARKS: Record<Outcome | 'edited', Mark> = {
  running: { glyph: '•', color: 'warning' },
  interrupted: { glyph: '×', color: 'error' },
  error: { glyph: '×', color: 'error' },
  edited: { glyph: '•', color: 'success' },
}
export const markOf = (turn: Turn | undefined): Mark | undefined =>
  turn?.outcome ? MARKS[turn.outcome] : turn && turn.files.length > 0 ? MARKS.edited : undefined

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

// The person's prompts on the live branch of a transcript JSONL, in order,
// keyed by message uuid, and the prompt each reply row and tool call answers
// (a tool row is drawn under its tool_use id). Tool results, meta rows,
// sidechains and the engine's wrapper rows are not prompts.
const indexTranscript = (jsonl: string): TranscriptIndex => {
  const rows: any[] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (typeof row?.uuid === 'string') rows.push(row)
    } catch {
      // A torn last line while the engine appends; the next read has it whole.
    }
  }
  const live = liveBranch(rows)
  const prompts: Entry[] = []
  const owners: [string, number][] = []
  const turns: Turn[] = []
  // When each turn started and when its latest reply was written.
  const times: { start: number; last: number }[] = []
  for (const row of rows) {
    if (row.isSidechain || !live.has(row.uuid)) continue
    const turn = turns[turns.length - 1]
    if (row.type === 'system' && row.subtype === 'turn_duration' && typeof row.durationMs === 'number') {
      if (turn) turn.durationMs = (turn.durationMs ?? 0) + row.durationMs
      continue
    }
    if (row.type === 'assistant') {
      if (prompts.length === 0 || !turn) continue
      const owner = prompts.length - 1
      owners.push([row.uuid, owner])
      if (row.isApiErrorMessage === true) turn.outcome = 'error'
      const at = Date.parse(row.timestamp)
      if (Number.isFinite(at)) times[owner]!.last = at
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
    text = text.trim()
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
    const at = Date.parse(row.timestamp)
    times.push({ start: at, last: at })
  }
  turns.forEach((turn, i) => {
    const time = times[i]
    if (time && Number.isFinite(time.start) && time.last > time.start) turn.spanMs = time.last - time.start
  })
  return { prompts, turns, owners, known: new Set(rows.map(row => row.uuid)) }
}

// The size and modification time of the transcript as last read.
type Seen = { path: string; size: number; mtimeMs: number }

// The transcript's index, or undefined when it is as `seen` last read it (a
// long session's file is not parsed again for a turn that wrote nothing) or
// before the file exists (a fresh session). Records what it read in `seen`.
async function readTranscript($: EngineInterface, transcriptPath: string, seen: Seen) {
  try {
    const { size, mtimeMs } = await $.fs.stat(transcriptPath)
    if (seen.path === transcriptPath && seen.size === size && seen.mtimeMs === mtimeMs) return undefined
    const index = indexTranscript(await $.fs.read(transcriptPath))
    Object.assign(seen, { path: transcriptPath, size, mtimeMs })
    return index
  } catch {
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

// Write the mode setting, as a change in /config would; say so if refused.
async function writeMode($: EngineInterface, mode: Mode) {
  const result = await $.config.set({ key: MODE_SETTING, value: mode })
  if (result.deny) $.ui.toast(`turn-rail: the mode was not saved: ${result.deny}`)
}

// Scroll the transcript to a prompt's row, from a dispatch that answers the
// person's own input (a press, a typed command): a transcript row moves only
// then. Records whether the row could be reached.
async function jumpTo($: EngineInterface, id: string, unreachable: Set<string>) {
  try {
    const result = await $.ui.scroll({ to: { requestId: id }, block: 'start' })
    if (result.deny) $.ui.toast(`turn-rail: ${result.deny}`)
    if (noteScroll(unreachable, id, result.deny)) $.ui.invalidate('ui.render')
  } catch (err) {
    $.ui.toast(`turn-rail: ${(err as Error).message}`)
  }
}

// Pin the position as this plugin's status line, or clear it, when it changed.
function pinStatus($: EngineInterface, text: string | undefined, pinned: { text?: string }) {
  if (pinned.text === text) return
  pinned.text = text
  $.ui.status(text)
}

// The transcript path remembered for this session, if any.
async function rememberedTranscript($: EngineInterface) {
  const value = (await $.store.get(`${TRANSCRIPT_KEY_PREFIX}${await $.session.id()}`)) as { path?: unknown } | undefined
  return typeof value?.path === 'string' ? value.path : undefined
}

export const register: Register = (on, options) => {
  let entries: Entry[] = []
  // Assistant row uuid -> the prompt it answers, from the transcript.
  let owners = new Map<string, string>()
  // Prompt id -> the turn it started, from the transcript.
  let turns = new Map<string, Turn>()
  // Prompt id -> how long its turns took as the engine reported them on
  // ending, for a turn whose turn_duration row the transcript lacks yet.
  const reported = new Map<string, number>()
  // Prompt id -> how its turn ended as the engine reported it, and whether the
  // newest prompt's turn is running now.
  const ended = new Map<string, Outcome>()
  let isRunning = false
  // A prompt's turn as the rail shows it: the transcript's record, completed
  // by what the engine reported before the transcript had it.
  const turnOf = (id: string): Turn | undefined => {
    const turn = turns.get(id)
    const ms = turn?.durationMs ?? reported.get(id)
    const outcome = isRunning && id === entries[entries.length - 1]?.id ? 'running' : (turn?.outcome ?? ended.get(id))
    if (!turn && ms === undefined && outcome === undefined) return undefined
    return { tools: 0, files: [], ...turn, ...(ms === undefined ? {} : { durationMs: ms }), ...(outcome ? { outcome } : {}) }
  }
  // The latest pass of onScreen reports: which transcript rows (prompts,
  // replies, tool rows) it said the viewport shows, by id. Only this pass is
  // read, since a row that left away from the viewport's edges is not told.
  let pass = { at: 0, rows: new Map<string, boolean>() }
  let lastCurrent = -1
  // Prompts whose rows the surface does not draw, learnt from a refused jump.
  const unreachable = new Set<string>()
  const seen: Seen = { path: '', size: -1, mtimeMs: -1 }

  const addPrompt = (id: string, text: string) => {
    // A new prompt is drawn under a provisional id before it is stored, then
    // again under its uuid: list the stored row only, so a repeated prompt
    // ("continue" twice) still gets an entry of its own.
    if (id === PROVISIONAL_ID || entries.some(entry => entry.id === id)) return false
    entries = [...entries, { id, text }]
    return true
  }

  // Record one onScreen report into the current pass.
  const see = (id: string, isShown: boolean) => {
    const now = Date.now()
    if (now - pass.at > PASS_MS) pass = { at: now, rows: new Map() }
    pass.at = now
    pass.rows.set(id, isShown)
  }

  // Where the person is reading: the prompt that the topmost row of the latest
  // pass belongs to, a reply counting as its prompt's. A scroll reports the
  // rows at the viewport's edges, a redraw every row, so the topmost shown row
  // of either is the viewport's top. Kept while no known row shows.
  const currentIndex = () => {
    const promptIndex = new Map(entries.map((entry, i) => [entry.id, i]))
    let best = -1
    for (const [id, isShown] of pass.rows) {
      if (!isShown) continue
      const ownerId = owners.get(id)
      const i = promptIndex.get(id) ?? (ownerId === undefined ? undefined : promptIndex.get(ownerId))
      if (i !== undefined && (best < 0 || i < best)) best = i
    }
    if (best >= 0) lastCurrent = best
    return lastCurrent < entries.length ? lastCurrent : -1
  }

  // Record one onScreen report; true when it moved the prompt being read, the
  // one thing a report changes in the drawing. A scroll that only reports the
  // viewport's edges and lands on another prompt redraws, and that redraw's
  // full pass of reports settles the prompt at the viewport's top.
  const seeMoves = (id: string, isShown: boolean) => {
    const before = currentIndex()
    see(id, isShown)
    return currentIndex() !== before
  }

  // A change of the setting reloads this module with the new value.
  let mode: Mode = isMode(options.mode) ? options.mode : 'vertical'
  // The subagent whose transcript is in view, as the rail's sites last drew;
  // undefined for the main conversation, whose rows alone the rail lists.
  let viewAgent: string | undefined
  // Whether the pane is drawn: opened and placed, or drawing now; undefined
  // until the session's first open answers, so nothing flickers before it.
  let paneShown: boolean | undefined
  const pinned: { text?: string } = {}
  // Where neither the pane nor the band shows the rail (a pane waiting for
  // room on a narrow terminal, or one the person closed), the status line
  // carries the position: `#3/12`, `#–/12` while no prompt is known on screen.
  const statusText = () => {
    if ((mode === 'horizontal' && isTerminal) || paneShown !== false || viewAgent !== undefined || entries.length === 0) return undefined
    const current = currentIndex()
    return `#${current >= 0 ? current + 1 : '–'}/${entries.length}`
  }
  // Only the terminal draws the band; elsewhere the pane is the one site.
  let isTerminal = false
  let railColumns = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      // Named after the plugin: a plugin's commands share one namespace with
      // every other plugin's and the built-ins, so a generic name would collide.
      name: 'turn-rail',
      description:
        'Show the prompt rail: vertical (a pane beside the transcript) or horizontal (above the prompt); next or prev jumps to the next or previous prompt.',
      argumentHint: '[vertical|horizontal|next|prev]',
      // Runs while a turn streams, so next and prev move through it then too.
      immediate: true,
    })
    isTerminal = e.surface === 'terminal'
    // Move a mode an earlier version stored into the setting, once. Writing
    // the setting reloads this module, so everything after it is best effort.
    const stored = await $.store.get(LEGACY_MODE_KEY)
    if (stored !== undefined) await $.store.delete(LEGACY_MODE_KEY)
    if (isMode(stored) && stored !== mode) {
      mode = stored
      await writeMode($, mode)
    }
    // Also fired after a hot reload, when the list starts empty: rebuild it from
    // the transcript this session's classic SessionStart remembered.
    const transcriptPath = await rememberedTranscript($)
    const index = transcriptPath === undefined ? undefined : await readTranscript($, transcriptPath, seen)
    if (index && merge(index)) $.ui.invalidate('ui.render')
    // Unasked, the engine seats a pane only from 144 columns (110 once the
    // person has opened it with /turn-rail); below that it waits undrawn.
    if (mode === 'vertical' || !isTerminal) {
      paneShown = (await $.ui.open({ id: PANE, title: 'Prompts', columns: RAIL_COLUMNS })).isPlaced
    } else {
      await $.ui.close({ id: PANE })
    }
    pinStatus($, statusText(), pinned)
    return next(e)
  })

  on('command.run', { command: 'turn-rail' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked === 'next' || asked === 'prev') {
      // The main conversation's rows are not drawn beside a subagent's, so a
      // jump would be refused and wrongly dot a prompt that can be reached.
      if (viewAgent !== undefined) {
        $.ui.toast('turn-rail: next and prev move through the main conversation; switch back to it first')
        return {}
      }
      const target = stepFrom(currentIndex(), entries.length, asked === 'next' ? 1 : -1, isUnreachable)
      const entry = entries[target]
      if (entry) await jumpTo($, entry.id, unreachable)
      else $.ui.toast(`turn-rail: no ${asked === 'next' ? 'later' : 'earlier'} prompt`)
      return {}
    }
    if (asked && !isMode(asked)) {
      $.ui.toast('turn-rail: /turn-rail [vertical|horizontal|next|prev]')
      return {}
    }
    if (isMode(asked)) mode = asked
    if (mode === 'horizontal' && isTerminal) {
      await $.ui.close({ id: PANE })
    } else {
      paneShown = (await $.ui.open({ id: PANE, title: 'Prompts', columns: RAIL_COLUMNS })).isPlaced
    }
    $.ui.invalidate('ui.render')
    pinStatus($, statusText(), pinned)
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
    entries = [...index.prompts, ...entries.filter(entry => !index.known.has(entry.id))]
    owners = new Map(index.owners.map(([id, i]) => [id, index.prompts[i]?.id ?? '']))
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
      pass = { at: 0, rows: new Map() }
      lastCurrent = -1
      unreachable.clear()
      Object.assign(seen, { path: '', size: -1, mtimeMs: -1 })
      $.ui.invalidate('ui.render')
    } else {
      const index = await readTranscript($, e.transcript_path, seen)
      if (index && merge(index)) $.ui.invalidate('ui.render')
    }
    pinStatus($, statusText(), pinned)
    await rememberTranscript($, e.session_id, e.transcript_path)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const index = await readTranscript($, e.transcript_path, seen)
    if (index && merge(index)) $.ui.invalidate('ui.render')
    pinStatus($, statusText(), pinned)
    return next(e)
  })

  // The pane closed, by this plugin or by the person: the status line takes
  // over while the rail is vertical.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    paneShown = false
    pinStatus($, statusText(), pinned)
    return result
  })

  // A main-loop turn starts (a subagent's run raises none): the newest
  // prompt's turn is running.
  on('turn.start', async ($, e, next) => {
    isRunning = true
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // A main-loop turn ended: its prompt is the newest. The transcript's
  // turn_duration row is written after the Stop hook reads the file, so keep
  // the engine's figure and how the turn ended until a later read has them.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const entry = entries[entries.length - 1]
    if (e.agentId === undefined) {
      isRunning = false
      if (entry) {
        reported.set(entry.id, (reported.get(entry.id) ?? 0) + e.durationMs)
        if (e.reason === 'aborted') ended.set(entry.id, 'interrupted')
        if (e.reason === 'error') ended.set(entry.id, 'error')
      }
      $.ui.invalidate('ui.render')
    }
    return result
  })

  // Record every prompt row as it is drawn, and which rows the viewport shows.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // A slash command's row is drawn as a user row too; it is not a prompt.
    if (PROMPT_KINDS.has(e.props.origin.kind) && !e.props.text.trimStart().startsWith('/')) {
      const isAdded = addPrompt(e.requestId, e.props.text)
      const isMoved = e.props.onScreen !== undefined && seeMoves(e.requestId, e.props.onScreen !== null)
      if (isAdded || isMoved) {
        $.ui.invalidate('ui.render')
        pinStatus($, statusText(), pinned)
      }
    }
    return next(e)
  })

  // A reply or a tool row on screen places the person under the prompt it
  // answers. Tool rows are drawn under their tool_use id; a collapsed group
  // counts as its first call.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.props.onScreen !== undefined && seeMoves(e.requestId, e.props.onScreen !== null)) {
      $.ui.invalidate('ui.render')
      pinStatus($, statusText(), pinned)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
    if (e.props.onScreen !== undefined && seeMoves(e.requestId, e.props.onScreen !== null)) {
      $.ui.invalidate('ui.render')
      pinStatus($, statusText(), pinned)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.onScreen !== undefined && seeMoves(e.requestId, e.props.onScreen !== null)) {
      $.ui.invalidate('ui.render')
      pinStatus($, statusText(), pinned)
    }
    return next(e)
  })
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
    const id = e.props.calls.find(call => call.tool_use_id)?.tool_use_id
    if (id && e.props.onScreen !== undefined && seeMoves(id, e.props.onScreen !== null)) {
      $.ui.invalidate('ui.render')
      pinStatus($, statusText(), pinned)
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

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isRail = e.props.placement === 'dock' && e.surface === 'terminal'
    viewAgent = e.props.view.agentId
    paneShown = true
    pinStatus($, statusText(), pinned)
    const nextColumns = isRail ? e.props.bodyColumns : 0
    if (nextColumns !== railColumns) {
      // The band decides from this whether it carries the cards.
      railColumns = nextColumns
      $.ui.invalidate('ui.render')
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
    // While the pane holds the keyboard, 1 to 9 jump to the first nine prompts.
    // The surface draws such a row as `1: label`, three cells the label gives up.
    const isKeyed = (i: number) => e.props.isFocused && i < 9
    const hotkey = (i: number) => (isKeyed(i) ? { hotkey: String(i + 1) } : {})
    // The cell before each tick marks how its turn went; it lights with the row.
    const mark = (entry: Entry, i: number) => {
      const found = markOf(turnOf(entry.id))
      return (
        <Text {...(found ? { color: found.color } : {})} hover={{ scope: `turn-rail-${i}`, inverse: true }}>
          {found?.glyph ?? ' '}
        </Text>
      )
    }
    // Docked on the terminal: one row per prompt, its tick and its text, the
    // whole row pressable. Too narrow for text, ticks alone (the band shows it).
    if (isRail) {
      const hasRoom = e.props.bodyColumns >= INLINE_REVEAL_MIN_COLUMNS
      const width = Math.max(4, e.props.bodyColumns - 5)
      return (
        <Box flexDirection="column">
          {entries.map((entry, i) => (
            <Box flexDirection="row">
              {/* A keyed tick alone fills a narrow rail: no cell for a mark. */}
              {isKeyed(i) && !hasRoom ? null : mark(entry, i)}
              <Button
              key={`jump-${i}`}
              plain
              {...hotkey(i)}
              dimColor={i !== current}
              label={
                isKeyed(i)
                  ? hasRoom
                    ? `${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, width - 2)}`
                    : tick(i === current, isUnreachable(i))
                  : hasRoom
                    ? ` ${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, width)}`
                    : ` ${tick(i === current, isUnreachable(i))} `
              }
              hover={{ scope: `turn-rail-${i}`, inverse: true, dimColor: false }}
              onPress={() => {}}
              />
            </Box>
          ))}
        </Box>
      )
    }
    // Elsewhere (inline, or a surface with no band for the card): list the text.
    const width = Math.max(8, e.props.bodyColumns - 4)
    return (
      <Box flexDirection="column">
        {entries.map((entry, i) => (
          <Box flexDirection="row">
            {mark(entry, i)}
            <Button
              key={`jump-${i}`}
              plain
              {...hotkey(i)}
              dimColor={i !== current}
              label={`${tick(i === current, isUnreachable(i))} ${oneLine(entry.text, isKeyed(i) ? width - 3 : width)}`}
              onPress={() => {}}
            />
          </Box>
        ))}
      </Box>
    )
  })

  // The band above the prompt (terminal only). Horizontal: the rail itself, a
  // row of ticks with the hovered prompt beside them. Vertical with a dock too
  // narrow to reveal beside a tick: hidden cards the rail's ticks reveal.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    viewAgent = e.props.view.agentId
    pinStatus($, statusText(), pinned)
    // Nothing while a survey holds the band or a subagent's transcript is in view.
    if (e.props.hasSurvey || e.props.view.agentId !== undefined || entries.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cards = (width: number) =>
      entries.map((entry, i) => (
        <Box key={`card-${i}`} display="none" hover={{ scope: `turn-rail-${i}`, display: 'flex' }}>
          <Text dimColor>{`#${i + 1} `}</Text>
          <Text wrap="truncate-end">{withTurn(entry, width)}</Text>
        </Box>
      ))

    if (mode === 'horizontal') {
      // Four rows: one of marks over the bars, which also parts the rail from
      // the transcript, two of bars, then the text line beside the prompt. A bar stands two rows only
      // for the prompt being read and the hovered one. The text line shows the
      // prompt being read, dim, and the hovered one's card painted over it.
      const width = Math.max(8, e.props.bodyColumns - 2 - RAIL_INSET)
      const current = currentIndex()
      // More prompts than cells: a window of bars centered on the prompt being
      // read (the newest when none is known), `‹` and `›` marking what it hides.
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
          <Box flexDirection="row">
            {isOverflowing ? <Text> </Text> : null}
            {shown.map(entry => {
              const found = markOf(turnOf(entry.id))
              return <Text {...(found ? { color: found.color } : {})}>{found?.glyph ?? ' '}</Text>
            })}
          </Box>
          {(['upper', 'lower'] as const).map(row => (
            <Box flexDirection="row">
              {isOverflowing ? <Text dimColor>{row === 'lower' && first > 0 ? '‹' : ' '}</Text> : null}
              {shown.map((entry, offset) => {
                const i = first + offset
                // An empty upper cell turns solid under the hover's inverse.
                const glyph = row === 'lower' ? bar(i === current, isUnreachable(i)) : i === current ? '┃' : ' '
                return (
                  <Button
                    key={row === 'lower' ? `jump-${i}` : `jump-${i}-upper`}
                    plain
                    dimColor={i !== current}
                    label={glyph}
                    hover={{ scope: `turn-rail-${i}`, inverse: true, dimColor: false }}
                    onPress={() => {}}
                  />
                )
              })}
              {row === 'lower' && hidesAfter ? <Text dimColor>›</Text> : null}
            </Box>
          ))}
          <Box height={1} width={width}>
            <Text dimColor wrap="truncate-end">{current >= 0 ? label(current) : ' '}</Text>
            {entries.map((_, i) => (
              <Box key={`card-${i}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `turn-rail-${i}`, display: 'flex' }}>
                <Text wrap="truncate-end">{padTo(card(i), width)}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    if (railColumns > 0 && railColumns < INLINE_REVEAL_MIN_COLUMNS) {
      return <Box flexDirection="column">{cards(Math.max(8, e.props.bodyColumns - 8))}</Box>
    }
    return next(e)
  })

  // Scroll from the press dispatch itself (a click or a hotkey).
  on('ui.press', { plugin: 'turn-rail' }, async ($, e, next) => {
    const index = Number(/^jump-(\d+)/.exec(e.element)?.[1])
    const entry = entries[index]
    if (entry) await jumpTo($, entry.id, unreachable)
    return next(e)
  })
}
