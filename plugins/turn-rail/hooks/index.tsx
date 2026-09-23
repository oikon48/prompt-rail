import type { EngineInterface, Register } from 'claude-code'

const PANE = 'turn-rail'
// Rows the person typed (terminal composer, desktop/remote bridge, SDK host).
const PROMPT_KINDS = new Set(['composer', 'bridge', 'sdk'])
// Columns the docked rail asks for: a tick and a little air.
const RAIL_COLUMNS = 4
// Below this many body columns the vertical rail has no room to reveal the
// prompt beside a tick, so the band above the prompt shows it instead.
const INLINE_REVEAL_MIN_COLUMNS = 12
const MODE_KEY = 'mode'
// Session id -> its transcript path, so a hot-reloaded module (whose
// session.start carries no path) can rebuild its list. The newest few are kept.
const TRANSCRIPTS_KEY = 'transcripts'
const KEPT_TRANSCRIPTS = 20
// onScreen reports that arrive within this many ms of each other are one pass
// of the surface (a scroll, or a redraw), read together.
const PASS_MS = 150
// Cells kept left of the horizontal rail: off the window's edge, a pointer
// leaving the first bar crosses a cell and the surface sees the hover end.
const RAIL_INSET = 2

// vertical: ticks in a docked pane; horizontal: ticks in a row above the prompt.
type Mode = 'vertical' | 'horizontal'
const isMode = (value: unknown): value is Mode => value === 'vertical' || value === 'horizontal'

type Entry = { id: string; text: string }

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()

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

type TranscriptIndex = {
  prompts: Entry[]
  // Assistant row uuid -> index into prompts of the prompt it answers.
  owners: [string, number][]
}

// The person's prompts in a transcript JSONL, in order, keyed by message uuid,
// and the prompt each assistant row answers. Tool results, meta rows,
// sidechains and command wrappers are not prompts.
const indexTranscript = (jsonl: string): TranscriptIndex => {
  const prompts: Entry[] = []
  const owners: [string, number][] = []
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row?.isSidechain || typeof row?.uuid !== 'string') continue
    if (row.type === 'assistant') {
      if (prompts.length > 0) owners.push([row.uuid, prompts.length - 1])
      continue
    }
    if (row.type !== 'user' || row.isMeta || row.isCompactSummary || row.message?.role !== 'user') continue
    const content = row.message.content
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      if (content.some((block: any) => block?.type === 'tool_result')) continue
      text = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
    }
    text = text.trim()
    if (!text || text.startsWith('<')) continue
    prompts.push({ id: row.uuid, text })
  }
  return { prompts, owners }
}

// The transcript's index, or undefined before the file exists (a fresh session).
async function readTranscript($: EngineInterface, transcriptPath: string) {
  try {
    return indexTranscript(await $.fs.read(transcriptPath))
  } catch {
    return undefined
  }
}

// Remember a session's transcript path, keeping only the newest few sessions.
async function rememberTranscript($: EngineInterface, sessionId: string, transcriptPath: string) {
  const stored = await $.store.get(TRANSCRIPTS_KEY)
  const known = stored && typeof stored === 'object' ? (stored as Record<string, string>) : {}
  const rest = Object.entries(known).filter(([id]) => id !== sessionId)
  const kept = [...rest.slice(-(KEPT_TRANSCRIPTS - 1)), [sessionId, transcriptPath] as const]
  await $.store.set(TRANSCRIPTS_KEY, Object.fromEntries(kept))
}

// The transcript path remembered for this session, if any.
async function rememberedTranscript($: EngineInterface) {
  const stored = await $.store.get(TRANSCRIPTS_KEY)
  if (!stored || typeof stored !== 'object') return undefined
  const path = (stored as Record<string, unknown>)[await $.session.id()]
  return typeof path === 'string' ? path : undefined
}

export const register: Register = (on) => {
  let entries: Entry[] = []
  // Assistant row uuid -> the prompt it answers, from the transcript.
  let owners = new Map<string, string>()
  // Which transcript rows (prompts and replies) the viewport shows, by id, as
  // last reported. A row that left the viewport away from its edges may keep a
  // stale `true` here, so the current prompt is read from the latest pass alone.
  const onScreen = new Map<string, boolean>()
  let pass = { at: 0, rows: new Map<string, boolean>() }
  let lastCurrent = -1

  const addPrompt = (id: string, text: string) => {
    if (entries.some(entry => entry.id === id)) return false
    // A new prompt is drawn under a provisional id before it is stored, then
    // again under its uuid; keep the first until the transcript settles it.
    if (entries.some(entry => normalize(entry.text) === normalize(text))) return false
    entries = [...entries, { id, text }]
    return true
  }

  // Record one onScreen report; true when it changed what is known.
  const see = (id: string, isShown: boolean) => {
    const now = Date.now()
    if (now - pass.at > PASS_MS) pass = { at: now, rows: new Map() }
    pass.at = now
    pass.rows.set(id, isShown)
    if (onScreen.get(id) === isShown) return false
    onScreen.set(id, isShown)
    return true
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

  let mode: Mode = 'vertical'
  // Only the terminal draws the band; elsewhere the pane is the one site.
  let isTerminal = false
  let railColumns = 0

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'prompts',
      description: 'Show the prompt rail: vertical (a pane beside the transcript) or horizontal (above the prompt).',
      argumentHint: '[vertical|horizontal]',
    })
    const stored = await $.store.get(MODE_KEY)
    if (isMode(stored)) mode = stored
    isTerminal = e.surface === 'terminal'
    // Also fired after a hot reload, when the list starts empty: rebuild it from
    // the transcript this session's classic SessionStart remembered.
    const transcriptPath = await rememberedTranscript($)
    const index = transcriptPath === undefined ? undefined : await readTranscript($, transcriptPath)
    if (index) {
      merge(index)
      $.ui.invalidate('ui.render')
    }
    // Unasked, the engine seats a pane only from 144 columns (110 once the
    // person has opened it with /prompts); below that it waits undrawn.
    if (mode === 'vertical' || !isTerminal) await $.ui.open({ id: PANE, title: 'Prompts', columns: RAIL_COLUMNS })
    return next(e)
  })

  on('command.run', { command: 'prompts' }, async ($, e) => {
    const asked = e.args.trim()
    if (asked && !isMode(asked)) {
      $.ui.toast('turn-rail: /prompts [vertical|horizontal]')
      return {}
    }
    if (isMode(asked)) {
      mode = asked
      await $.store.set(MODE_KEY, mode)
    }
    if (mode === 'horizontal' && isTerminal) {
      await $.ui.close({ id: PANE })
    } else {
      await $.ui.open({ id: PANE, title: 'Prompts', columns: RAIL_COLUMNS })
    }
    $.ui.invalidate('ui.render')
    return {}
  })

  // Rebuild the list from the transcript file, whose uuids are the ids the
  // transcript rows are drawn under. A resumed session so lists prompts the
  // surface has not drawn yet, and a provisional id gives way to the stored one.
  const merge = (index: TranscriptIndex) => {
    const seededIds = new Set(index.prompts.map(p => p.id))
    const seededTexts = new Set(index.prompts.map(p => normalize(p.text)))
    const drawnOnly = entries.filter(entry => !seededIds.has(entry.id) && !seededTexts.has(normalize(entry.text)))
    entries = [...index.prompts, ...drawnOnly]
    owners = new Map(index.owners.map(([id, i]) => [id, index.prompts[i]?.id ?? '']))
  }

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      entries = []
      owners = new Map()
      onScreen.clear()
      pass = { at: 0, rows: new Map() }
      lastCurrent = -1
    } else {
      const index = await readTranscript($, e.transcript_path)
      if (index) merge(index)
    }
    await rememberTranscript($, e.session_id, e.transcript_path)
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const index = await readTranscript($, e.transcript_path)
    if (index) {
      merge(index)
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // Record every prompt row as it is drawn, and which rows the viewport shows.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // A slash command's row is drawn as a user row too; it is not a prompt.
    if (PROMPT_KINDS.has(e.props.origin.kind) && !e.props.text.trimStart().startsWith('/')) {
      const isAdded = addPrompt(e.requestId, e.props.text)
      const isMoved = e.props.onScreen !== undefined && see(e.requestId, e.props.onScreen !== null)
      if (isAdded || isMoved) $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // A reply on screen places the person under the prompt it answers.
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.props.onScreen !== undefined && see(e.requestId, e.props.onScreen !== null)) $.ui.invalidate('ui.render')
    return next(e)
  })

  // A stacked rail reads rows apart; a row of ticks needs upright bars to.
  const tick = (isCurrent: boolean) => (isCurrent ? '━' : '─')
  const bar = (isCurrent: boolean) => (isCurrent ? '┃' : '│')

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const isRail = e.props.placement === 'dock' && e.surface === 'terminal'
    const nextColumns = isRail ? e.props.bodyColumns : 0
    if (nextColumns !== railColumns) {
      // The band decides from this whether it carries the cards.
      railColumns = nextColumns
      $.ui.invalidate('ui.render')
    }
    if (entries.length === 0) {
      return <Text dimColor>{isRail ? '·' : 'No prompts yet'}</Text>
    }
    const current = currentIndex()
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
              label={hasRoom ? ` ${tick(i === current)} ${oneLine(entry.text, width)}` : ` ${tick(i === current)} `}
              hover={{ scope: `turn-rail-${i}`, inverse: true, dimColor: false }}
              onPress={() => {}}
            />
          ))}
        </Box>
      )
    }
    // Elsewhere (inline, or a surface with no band for the card): list the text.
    const width = Math.max(8, e.props.bodyColumns - 4)
    return (
      <Box flexDirection="column">
        {entries.map((entry, i) => (
          <Button
            key={`jump-${i}`}
            plain
            dimColor={i !== current}
            label={`${tick(i === current)} ${oneLine(entry.text, width)}`}
            onPress={() => {}}
          />
        ))}
      </Box>
    )
  })

  // The band above the prompt (terminal only). Horizontal: the rail itself, a
  // row of ticks with the hovered prompt beside them. Vertical with a dock too
  // narrow to reveal beside a tick: hidden cards the rail's ticks reveal.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey || entries.length === 0) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const cards = (width: number) =>
      entries.map((entry, i) => (
        <Box key={`card-${i}`} display="none" hover={{ scope: `turn-rail-${i}`, display: 'flex' }}>
          <Text dimColor>{`#${i + 1} `}</Text>
          <Text wrap="truncate-end">{oneLine(entry.text, width)}</Text>
        </Box>
      ))

    if (mode === 'horizontal') {
      // Four rows: a blank one parting the rail from the transcript, two of
      // bars, then the text line beside the prompt. A bar stands two rows only
      // for the prompt being read and the hovered one. The text line shows the
      // prompt being read, dim, and the hovered one's card painted over it.
      const width = Math.max(8, e.props.bodyColumns - 2 - RAIL_INSET)
      const first = Math.max(0, entries.length - (width - 1))
      const shown = entries.slice(first)
      const current = currentIndex()
      const label = (i: number) => `#${i + 1} ${oneLine(entries[i]?.text ?? '', width - `#${i + 1} `.length)}`
      return (
        <Box flexDirection="column" paddingLeft={RAIL_INSET}>
          <Text> </Text>
          {(['upper', 'lower'] as const).map(row => (
            <Box flexDirection="row">
              {first > 0 ? <Text dimColor>{row === 'lower' ? '‹' : ' '}</Text> : null}
              {shown.map((entry, offset) => {
                const i = first + offset
                // An empty upper cell turns solid under the hover's inverse.
                const glyph = row === 'lower' ? bar(i === current) : i === current ? '┃' : ' '
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
            </Box>
          ))}
          <Box height={1} width={width}>
            <Text dimColor wrap="truncate-end">{current >= 0 ? label(current) : ' '}</Text>
            {entries.map((_, i) => (
              <Box key={`card-${i}`} position="absolute" top={0} left={0} display="none" hover={{ scope: `turn-rail-${i}`, display: 'flex' }}>
                <Text wrap="truncate-end">{padTo(label(i), width)}</Text>
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

  // Scroll from the press dispatch itself: a transcript row moves only while
  // the call answers the person's own input.
  on('ui.press', { plugin: 'turn-rail' }, async ($, e, next) => {
    const index = Number(/^jump-(\d+)/.exec(e.element)?.[1])
    const entry = entries[index]
    if (!entry) return next(e)
    try {
      const result = await $.ui.scroll({ to: { requestId: entry.id }, block: 'start' })
      if (result.deny) $.ui.toast(`turn-rail: ${result.deny}`)
    } catch (err) {
      $.ui.toast(`turn-rail: ${(err as Error).message}`)
    }
    return next(e)
  })
}
