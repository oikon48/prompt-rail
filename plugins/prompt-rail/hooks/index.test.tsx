import { test, expect, mock } from 'claude-code/testing'
import { bar, drawnRow, noteScroll, rowKey, stepFrom, tick, turnLine } from './index.tsx'

const SURFACES = ['terminal', 'desktop'] as const

const prompt = (text: string, onScreen: { first: number; last: number; of: number } | null) => ({
  text,
  origin: { kind: 'composer' as const },
  isExpanded: false,
  onScreen,
})

const pane = (placement: 'dock' | 'inline', bodyColumns = placement === 'dock' ? 4 : 60) => ({
  title: 'Prompts',
  isFocused: false,
  bodyColumns,
  placement,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
})

test('the terminal dock draws a tick per prompt, other seats draw the text, presses route', async ($, on) => {
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
  })
  // Stand in for the engine's own drawing of a prompt row.
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })

  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', null) })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm2', props: prompt('second prompt', { first: 0, last: 3, of: 4 }) })

  const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock') })
  expect((await rail.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([' ─ ', ' ━ '])
  expect((await rail.press({ key: 'jump-1' }))?.element).toBe('jump-1')
  await rail.unmount()

  // The desktop has no band to reveal a card in, so its dock lists the text.
  const desktopDock = await $.ui.mount({ plugin: 'prompt-rail', surface: 'desktop', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 40) })
  expect((await desktopDock.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['─ first prompt', '━ second prompt'])
  expect((await desktopDock.press({ key: 'jump-1' }))?.element).toBe('jump-1')
  await desktopDock.unmount()

  for (const surface of SURFACES) {
    const list = await $.ui.mount({ plugin: 'prompt-rail', surface, component: 'Pane', requestId: 'prompt-rail', props: pane('inline') })
    expect((await list.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['─ first prompt', '━ second prompt'])
    await list.unmount()
  }
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const drawPrompts = async ($: any, on: any) => {
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  // Stand in for the engine's empty band when the plugin passes it on.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  mock.store(on)
  on('config.set', ($: any, e: any) => ({ value: e.value }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({}))
  on('ui.toast', () => {})
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', null) })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm2', props: prompt('second prompt', { first: 0, last: 3, of: 4 }) })
}

test('a narrow vertical rail leaves the prompt text to hidden cards in the band', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 4) })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ key: 'card-0' }))?.props.display).toBe('none')
  expect(await band.find({ type: 'Text', text: /first prompt/ })).toBeDefined()
})

test('a wide vertical rail shows each prompt beside its tick and keeps the band empty', async ($, on) => {
  await drawPrompts($, on)
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 37) })
  expect((await rail.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([' ─ first prompt', ' ━ second prompt'])
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'card-0' })).toBeUndefined()
})

test('wide characters are cut by the cells they take', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm3', props: prompt('日本語のプロンプト', null) })
  const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 12) })
  expect((await rail.findAll({ type: 'Button' })).map(b => b.props.label)[2]).toBe(' ─ 日本語…')
})

test('/prompt-rail horizontal draws a text line over one row of bars, heavy where being read', async ($, on) => {
  await drawPrompts($, on)
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // One bar per prompt, the one on screen heavy.
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['│', '┃'])
  // The text line, above the bars, shows the prompt on screen until a bar is hovered.
  const drawn = await band.findAll({})
  const line = drawn.findIndex((node: any) => node.type === 'Text' && /^#2 second prompt$/.test(String(node.text)))
  expect(line).toBeGreaterThanOrEqual(0)
  expect(line).toBeLessThan(drawn.findIndex((node: any) => node.type === 'Button'))
  expect((await band.find({ key: 'card-0' }))?.props.display).toBe('none')
  expect((await band.press({ key: 'jump-0' }))?.element).toBe('jump-0')
})

test('with no prompt on screen the text line shows the newest one and no bar is heavy', async ($, on) => {
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  mock.store(on)
  on('config.set', ($: any, e: any) => ({ value: e.value }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({}))
  on('ui.toast', () => {})
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', null) })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm2', props: prompt('second prompt', null) })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // An empty line reads as a broken rail; the heavy bar still means "being read".
  expect(await band.find({ type: 'Text', text: /^#2 second prompt$/ })).toBeDefined()
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['│', '│'])
})

test('the horizontal band keeps the focus ring off its bars', async ($, on) => {
  const moves: (string | undefined)[] = []
  // Stand in for the engine moving the ring.
  on('ui.focus', ($: any, e: any) => {
    moves.push(e.element)
    return {}
  })
  await drawPrompts($, on)
  const focus = (component: 'AbovePrompt' | 'Pane', plugin: string, element: string) =>
    $.ui.focus({ component, requestId: component === 'Pane' ? 'prompt-rail' : 'above-prompt', plugin, element, origin: { kind: 'person' } })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  // A lit bar left behind after a click reads as a stuck hover, so the ring
  // stays where it was; a press still jumps.
  expect((await focus('AbovePrompt', 'prompt-rail', 'jump-0')).deny).toBeDefined()
  expect((await focus('AbovePrompt', 'prompt-rail', 'jump-1')).deny).toBeDefined()
  expect(moves).toEqual([])
  // Another plugin's element in the band moves it.
  await focus('AbovePrompt', 'survey', 'yes')
  expect(moves).toEqual(['yes'])
})

test('the vertical pane keeps the focus ring off its rows, the engine\'s own stops aside', async ($, on) => {
  const moves: (string | undefined)[] = []
  // Stand in for the engine moving the ring.
  on('ui.focus', ($: any, e: any) => {
    moves.push(e.element ?? 'engine stop')
    return {}
  })
  await drawPrompts($, on)
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  // A ringed row beside the row under the pointer lights two rows at once;
  // the digits still jump while the pane holds the keyboard.
  const ringed = await $.ui.focus({ component: 'Pane', requestId: 'prompt-rail', plugin: 'prompt-rail', element: 'jump-0', origin: { kind: 'person' } })
  expect(ringed.deny).toBeDefined()
  expect(moves).toEqual([])
  // The pane's close mark is the engine's, so the ring still reaches it.
  await $.ui.focus({ component: 'Pane', requestId: 'prompt-rail', origin: { kind: 'person' } })
  expect(moves).toEqual(['engine stop'])
})

test('with several prompts on screen only the topmost one is heavy', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm3', props: prompt('third prompt', { first: 0, last: 1, of: 2 }) })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // m2 and m3 both show; m2 is the one being read.
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['│', '┃', '│'])
  expect(await band.find({ type: 'Text', text: /^#2 second prompt$/ })).toBeDefined()
})

// A transcript JSONL from rows given in order; each row's parent is the one
// before it unless it names its own (`parentUuid`, null at a chain's root).
const jsonl = (rows: Record<string, unknown>[]) =>
  rows
    .map((row, i) => JSON.stringify({ parentUuid: i === 0 ? null : rows[i - 1]?.uuid, ...row }))
    .join('\n')

const TRANSCRIPT = jsonl([
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first stored prompt' } },
  {
    type: 'assistant',
    uuid: 'a1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: '<div> why does this overflow?' } },
  { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/prompt-rail</command-name>' } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: 'continue' } },
  { type: 'user', uuid: 'u4', message: { role: 'user', content: 'continue' } },
])

// alpha -> beta -> gamma, then /rewind to before beta and delta sent instead.
const FORKED = jsonl([
  { type: 'user', uuid: 'p1', message: { role: 'user', content: 'alpha' } },
  { type: 'assistant', uuid: 'q1', message: { role: 'assistant', content: [{ type: 'text', text: 'alpha' }] } },
  { type: 'user', uuid: 'p2', message: { role: 'user', content: 'beta' } },
  { type: 'assistant', uuid: 'q2', message: { role: 'assistant', content: [{ type: 'text', text: 'beta' }] } },
  { type: 'user', uuid: 'p3', message: { role: 'user', content: 'gamma' } },
  { type: 'assistant', uuid: 'q3', message: { role: 'assistant', content: [{ type: 'text', text: 'gamma' }] } },
  { type: 'user', uuid: 'p4', parentUuid: 'q1', message: { role: 'user', content: 'delta' } },
  { type: 'assistant', uuid: 'q4', message: { role: 'assistant', content: [{ type: 'text', text: 'delta' }] } },
  { type: 'system', uuid: 's1' },
])

// A prompt, then /compact: the boundary starts a new chain whose logical parent
// is the last row before it.
const COMPACTED = jsonl([
  { type: 'user', uuid: 'p1', message: { role: 'user', content: 'before compact' } },
  { type: 'assistant', uuid: 'q1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  { type: 'system', uuid: 'b1', parentUuid: null, logicalParentUuid: 'q1', subtype: 'compact_boundary' },
  { type: 'user', uuid: 'p2', message: { role: 'user', content: 'after compact' } },
])

// What the world beneath the plugin holds and counts: the transcript file's
// text (a test may change it), how often the plugin read it, how often it
// asked for a redraw of everything it hooks and of the rail alone, the
// settings it wrote, and the panes it opened or closed.
type Beneath = {
  transcript: string
  mtimeMs: number
  reads: number
  invalidations: number
  railRedraws: number
  settings: Map<string, unknown>
  panes: string[]
  commands: unknown[]
  toasts: string[]
  // Whether the surface draws the pane it is asked to open, and each line the
  // plugin pinned as its status (undefined for a clear).
  placed: boolean
  status: (string | undefined)[]
}
const beneath = (transcript = TRANSCRIPT): Beneath => ({
  transcript,
  mtimeMs: 1,
  reads: 0,
  invalidations: 0,
  railRedraws: 0,
  settings: new Map(),
  panes: [],
  commands: [],
  toasts: [],
  placed: true,
  status: [],
})

// The world beneath the plugin for a session whose transcript is TRANSCRIPT,
// with a store in memory the test can read.
const world = (on: any, initial: Record<string, unknown> = {}, transcript = TRANSCRIPT, disk: Beneath = beneath(transcript)) => {
  const store = new Map<string, unknown>(Object.entries(initial))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('fs.read', ($: any, e: any) => {
    disk.reads++
    return { value: e.path === '/t/s1.jsonl' ? disk.transcript : '' }
  })
  on('fs.stat', ($: any, e: any) => ({
    value: { kind: 'file', size: e.path === '/t/s1.jsonl' ? disk.transcript.length : 0, mtimeMs: disk.mtimeMs, isLink: false },
  }))
  on('ui.invalidate', () => {
    disk.invalidations++
    return { value: undefined }
  })
  on('state.set', ($: any, e: any, next: any) => {
    disk.railRedraws++
    return next(e)
  })
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', ($: any, e: any) => {
    disk.commands.push(e)
    return { value: { command: e.name } }
  })
  on('config.set', ($: any, e: any) => {
    disk.settings.set(e.key, e.value)
    return { value: e.value }
  })
  on('ui.open', ($: any, e: any) => {
    disk.panes.push(`open ${e.id}`)
    return { value: disk.placed ? { isPlaced: true } : { isPlaced: false, reason: 'the terminal is 100 columns wide' } }
  })
  on('ui.status', ($: any, e: any) => {
    disk.status.push(e.text)
    return { value: undefined }
  })
  on('ui.close', ($: any, e: any) => {
    disk.panes.push(`close ${e.id}`)
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    disk.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }))
  on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.tool }))
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: 'reply' }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => $.ui.resolve(e).Box({}))
  return store
}

const railLabels = async ($: any) => {
  const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 40) })
  return (await rail.findAll({ type: 'Button' })).map((b: any) => String(b.props.label).slice(3))
}

test('the session start remembers its transcript under its own key', async ($, on) => {
  const store = world(on, { 'transcript:s0': { path: '/t/s0.jsonl', at: 1 } })
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect((store.get('transcript:s1') as any)?.path).toBe('/t/s1.jsonl')
  // Another session's entry is left alone: no shared map is rewritten.
  expect(store.get('transcript:s0')).toEqual({ path: '/t/s0.jsonl', at: 1 })
})

test('a reload lists the prompts again from the remembered transcript', async ($, on) => {
  // A reloaded module has no list; session.start fires again and rebuilds it.
  world(on, { 'transcript:s1': { path: '/t/s1.jsonl', at: 1 } })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).length).toBe(4)
})

test('prompts are listed in transcript order, wrappers left out, repeats kept', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first stored prompt', '<div> why does this overflow?', 'continue', 'continue'])
})

// A prompt sent while an artifact is open in the viewer: the engine stores the
// viewer's state ahead of the typed text.
const VIEWED = '<artifact-view-context artifact="bb04">\n{"context":{"mode":"edit","slideId":"s38"}}\n</artifact-view-context>\n\nswap the image'

test('the artifact view context ahead of a stored prompt is left out of its text', async ($, on) => {
  world(on, {}, jsonl([{ type: 'user', uuid: 'v1', message: { role: 'user', content: VIEWED } }]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['swap the image'])
})

test('the artifact view context ahead of a drawn prompt is left out of its text', async ($, on) => {
  world(on, {}, jsonl([]))
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'v1', props: prompt(VIEWED, null) })
  expect(await railLabels($)).toEqual(['swap the image'])
})

test('a typed artifact view context tag is kept, since it is not the viewer\'s state', async ($, on) => {
  world(on, {}, jsonl([]))
  const typed = '<artifact-view-context artifact="demo">example</artifact-view-context> explain this'
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'v1', props: prompt(typed, null) })
  const labels = await railLabels($)
  expect(labels.length).toBe(1)
  expect(labels[0]).toMatch(/^<artifact-view-context artifact="de/)
})

test('a repeated prompt gets its own entry; the provisional row is not listed', async ($, on) => {
  world(on)
  const draw = async (requestId: string, text: string) => {
    const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId, props: prompt(text, null) })
    await row.unmount()
  }
  await draw('placeholder', 'continue')
  await draw('x1', 'continue')
  await draw('placeholder', 'continue')
  await draw('x2', 'continue')
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

// A message the engine splits into rows is drawn under ids derived from its
// stored uuid: the first four groups, then the row's index (seen in 2.1.283).
const SPLIT_IDS = {
  first: 'dae2bfb1-3f75-4882-a3e4-6f43dc45b51c',
  firstRow: 'dae2bfb1-3f75-4882-a3e4-000000000000',
  reply: 'e59aaf08-414b-4bb2-9945-895150ed76c7',
  replyRow: 'e59aaf08-414b-4bb2-9945-000000000001',
  second: '35939e29-64ae-48ff-bc1d-432a998b2414',
}
const SPLIT = jsonl([
  { type: 'user', uuid: SPLIT_IDS.first, message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: SPLIT_IDS.reply, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  { type: 'user', uuid: SPLIT_IDS.second, message: { role: 'user', content: 'second' } },
])
const drawSplit = ($: any, component: 'UserMessage' | 'AssistantMessage', requestId: string, onScreen: { first: number; last: number; of: number } | null) =>
  $.ui.mount({
    plugin: 'prompt-rail',
    surface: 'terminal',
    component,
    requestId,
    props: component === 'UserMessage' ? prompt('first', onScreen) : { text: 'reply', isFirstOfReply: true, onScreen },
  })

test('a prompt drawn under an id derived from its stored uuid is listed once, drawn first', async ($, on) => {
  world(on, {}, SPLIT)
  await drawSplit($, 'UserMessage', SPLIT_IDS.firstRow, null)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first', 'second'])
})

test('a prompt drawn under an id derived from its stored uuid is listed once, read first', async ($, on) => {
  world(on, {}, SPLIT)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await drawSplit($, 'UserMessage', SPLIT_IDS.firstRow, null)
  expect(await railLabels($)).toEqual(['first', 'second'])
})

test('a prompt row on screen under a derived id places the reader under that prompt', async ($, on) => {
  world(on, {}, SPLIT)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await drawSplit($, 'UserMessage', SPLIT_IDS.firstRow, { first: 0, last: 1, of: 2 })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['┃', '│'])
})

test('a reply row on screen under a derived id places the reader under its prompt', async ($, on) => {
  world(on, {}, SPLIT)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await drawSplit($, 'AssistantMessage', SPLIT_IDS.replyRow, { first: 0, last: 1, of: 2 })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['┃', '│'])
})

test('a jump to a stored prompt scrolls to the id its row was drawn under', () => {
  const drawn = new Map([[rowKey(SPLIT_IDS.firstRow), SPLIT_IDS.firstRow]])
  expect(drawnRow(drawn, SPLIT_IDS.first)).toBe(SPLIT_IDS.firstRow)
  // A prompt not drawn yet is looked for under its own id.
  expect(drawnRow(drawn, SPLIT_IDS.second)).toBe(SPLIT_IDS.second)
  expect(drawnRow(drawn, 'u1')).toBe('u1')
})

// How the engine draws a prompt that does not go straight into a turn, as
// seen in 2.1.283 (tmux and Herdr alike):
// - queued while a turn runs and sent once it ends: two rows it never
//   stores, around prompt.submit, then the provisional row and the stored one;
// - delivered into the running turn: the same two rows, then the row of the
//   queued_command attachment the transcript stores, with no provisional row;
// - sent from Remote Control, even at rest: session.receive, one row it never
//   stores, the provisional row, prompt.submit, then the stored row.
const drawRow = async ($: any, requestId: string, text: string, onScreen: { first: number; last: number; of: number } | null = null) => {
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId, props: prompt(text, onScreen) })
  await row.unmount()
}
const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const sendQueued = async ($: any, text: string, ids: [string, string, string]) => {
  await drawRow($, ids[0], text)
  await submit($, text)
  await drawRow($, ids[1], text)
  await drawRow($, 'placeholder', text)
  await drawRow($, ids[2], text)
}
// The world plus the engine's own answers to the events these tests raise.
const queueWorld = (on: any, transcript = jsonl([])) => {
  const disk = beneath(transcript)
  world(on, {}, transcript, disk)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('session.receive', ($: any, e: any) => ({ text: e.text }))
  return disk
}
const sendFirst = async ($: any, text: string, id: string) => {
  await submit($, text)
  await drawRow($, 'placeholder', text)
  await $.turn.start({ text, turnId: `t-${id}` })
  await drawRow($, id, text)
}

test('a prompt queued while a turn runs is listed once', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await sendQueued($, 'queued', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['first', 'queued'])
})

test('a queued prompt is listed once as soon as it is sent', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'queued')
  await submit($, 'queued')
  await drawRow($, 'q2', 'queued')
  expect(await railLabels($)).toEqual(['first', 'queued'])
})

test('queue rows drawn just before the notification make one entry', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'queued')
  await drawRow($, 'q2', 'queued')
  await submit($, 'queued')
  expect(await railLabels($)).toEqual(['first', 'queued'])
})

test('a prompt queued behind the same text keeps both entries', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'continue', 's1')
  await sendQueued($, 'continue', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a prompt drawn at rest is kept when a queued prompt has the same text', async ($, on) => {
  // As on a resume whose transcript cannot be read: the rows are drawn only.
  queueWorld(on)
  await drawRow($, 'old', 'continue')
  await sendFirst($, 'go on', 's1')
  await sendQueued($, 'continue', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['continue', 'go on', 'continue'])
})

test('a row drawn well before a prompt with its text is sent stays its own entry', async ($, on) => {
  queueWorld(on)
  await drawRow($, 'old', 'continue')
  await new Promise(resolve => setTimeout(resolve, 300))
  await sendFirst($, 'continue', 's1')
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a prompt whose turn starts with no provisional row is not taken for a queued one', async ($, on) => {
  // The session's first prompt: its turn starts, then its stored row is drawn.
  queueWorld(on)
  await $.turn.start({ text: 'first', turnId: 't1' })
  await drawRow($, 's1', 'first')
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await sendFirst($, 'first', 's2')
  expect(await railLabels($)).toEqual(['first', 'first'])
})

test('a sent prompt the transcript listed first still ends its provisional row', async ($, on) => {
  // The turn's start read the file before the stored row was drawn.
  queueWorld(on, jsonl([{ type: 'user', uuid: 's1', message: { role: 'user', content: 'continue' } }]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await sendFirst($, 'continue', 's1')
  await sendQueued($, 'continue', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a prompt sent from Remote Control at rest is listed once', async ($, on) => {
  queueWorld(on)
  await $.session.receive({ text: 'remote one', origin: { kind: 'bridge' } })
  await drawRow($, 'r1', 'remote one')
  await drawRow($, 'placeholder', 'remote one')
  await $.prompt.submit({ text: 'remote one', wait: false, origin: { kind: 'bridge' } })
  await $.turn.start({ text: 'remote one', turnId: 't1' })
  await drawRow($, 's1', 'remote one')
  expect(await railLabels($)).toEqual(['remote one'])
})

test('a prompt delivered into the running turn is listed once and read on its own row', async ($, on) => {
  queueWorld(on)
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'mid')
  await submit($, 'mid')
  await drawRow($, 'q2', 'mid')
  // The attachment row is the one left on screen once the turn reads it.
  await drawRow($, 'a1', 'mid', { first: 0, last: 1, of: 2 })
  expect(await railLabels($)).toEqual(['first', 'mid'])
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['│', '┃'])
})

// A prompt delivered into the running turn: its queue rows around the
// notification, then, once a tool call ends, the row of its attachment.
const deliver = async ($: any, text: string, ids: [string, string, string]) => {
  await drawRow($, ids[0], text)
  await submit($, text)
  await drawRow($, ids[1], text)
  await new Promise(resolve => setTimeout(resolve, 300))
  await drawRow($, ids[2], text)
}

test('a turn keeps its details when a prompt with its text is delivered into it', async ($, on) => {
  queueWorld(on)
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await sendFirst($, 'continue', 's1')
  await deliver($, 'continue', ['q1', 'q2', 'a1'])
  await $.turn.complete({ answer: 'done', durationMs: 12500, isAborted: true, turnId: 't-s1', reason: 'aborted' })
  expect(await railLabels($)).toEqual(['continue', 'continue'])
  await drawRow($, 's1', 'continue', { first: 0, last: 1, of: 2 })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 continue · 12s · interrupted\s*$/ })).toBeDefined()
})

test('a delivered prompt keeps its bar when the same text is sent after its turn', async ($, on) => {
  // As where the transcript cannot be read: the delivery is known from draws only.
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await deliver($, 'continue', ['q1', 'q2', 'a1'])
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-s1', reason: 'answer' })
  await sendFirst($, 'continue', 's2')
  expect(await railLabels($)).toEqual(['first', 'continue', 'continue'])
})

// A prompt delivered into the running turn, stored as a queued_command
// attachment inside the turn the first prompt started.
const DELIVERED = [
  { type: 'user', uuid: 's1', timestamp: '2026-09-24T00:00:00.000Z', message: { role: 'user', content: 'first' } },
  {
    type: 'assistant',
    uuid: 'b1',
    timestamp: '2026-09-24T00:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 8' } }] },
  },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] } },
  { type: 'attachment', uuid: 'a1', attachment: { type: 'queued_command', prompt: 'mid' } },
  { type: 'assistant', uuid: 'b2', timestamp: '2026-09-24T00:00:14.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 14000 },
]

test('a prompt delivered into a turn is listed from the transcript, the turn staying with its first prompt', async ($, on) => {
  queueWorld(on, jsonl(DELIVERED))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  expect(await railLabels($)).toEqual(['first', 'mid'])
  await drawRow($, 's1', 'first', { first: 0, last: 1, of: 2 })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first · 14s · 1 tool\s*$/ })).toBeDefined()
})

test('a delivered prompt drawn before the transcript is read is listed once after it', async ($, on) => {
  const disk = queueWorld(on, jsonl(DELIVERED.slice(0, 3)))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await drawRow($, 'q1', 'mid')
  await submit($, 'mid')
  await drawRow($, 'q2', 'mid')
  await drawRow($, 'a1', 'mid')
  disk.transcript = jsonl(DELIVERED)
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(await railLabels($)).toEqual(['first', 'mid'])
})

test('what the engine reported of a turn goes to the prompt that started it, not one delivered into it', async ($, on) => {
  queueWorld(on)
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'mid')
  await submit($, 'mid')
  await drawRow($, 'a1', 'mid')
  await $.turn.complete({ answer: 'done', durationMs: 12500, isAborted: true, turnId: 't-s1', reason: 'aborted' })
  await drawRow($, 's1', 'first', { first: 0, last: 1, of: 2 })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first · 12s · interrupted\s*$/ })).toBeDefined()
})

test('a tool row at the top of the viewport places the reader under its prompt', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await $.ui.mount({
    plugin: 'prompt-rail',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 't1',
    props: { tool_use_id: 't1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false, onScreen: { first: 0, last: 1, of: 2 } },
  })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u3', props: prompt('continue', { first: 0, last: 1, of: 2 }) })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first stored prompt$/ })).toBeDefined()
})

test('after /rewind only the live branch is listed', async ($, on) => {
  world(on, {}, FORKED)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['alpha', 'delta'])
})

test('a drawn row from an abandoned branch drops out once the transcript is read', async ($, on) => {
  world(on, {}, FORKED)
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'p2', props: prompt('beta', null) })
  await row.unmount()
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['alpha', 'delta'])
})

test('prompts before a compaction stay listed', async ($, on) => {
  world(on, {}, COMPACTED)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['before compact', 'after compact'])
})

test("while a subagent's transcript is in view the pane holds a note, not the rail", async ($, on) => {
  await drawPrompts($, on)
  const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: { ...pane('dock', 37), view: { agentId: 'ag1' } } })
  expect(await rail.findAll({ type: 'Button' })).toEqual([])
  expect(await rail.find({ type: 'Text', text: /main conversation/ })).toBeDefined()
})

test("while a subagent's transcript is in view the band stays empty", async ($, on) => {
  await drawPrompts($, on)
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'ag1' } } })
  expect(await band.findAll({ type: 'Button' })).toEqual([])
})

// Twelve prompts, the one at `reading` on screen, in a horizontal band ten
// cells wide: eight bars fit between the two elision marks.
const overflowBand = async ($: any, on: any, reading: number) => {
  world(on)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  for (let i = 0; i < 12; i++) {
    const onScreen = i === reading ? { first: 0, last: 1, of: 2 } : null
    await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: `p${i}`, props: prompt(`prompt ${i}`, onScreen) })
  }
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 14 } })
  const lower = (await band.findAll({ type: 'Button' })).map((b: any) => String(b.props.key)).filter((key: string) => /^jump-\d+$/.test(key))
  const marks = (await band.findAll({ type: 'Text' })).map((t: any) => t.text).filter((text: string) => text === '‹' || text === '›')
  return { lower, marks }
}

test('an overflowing horizontal rail keeps the prompt being read near the start', async ($, on) => {
  const { lower, marks } = await overflowBand($, on, 2)
  expect(lower).toEqual(['jump-0', 'jump-1', 'jump-2', 'jump-3', 'jump-4', 'jump-5', 'jump-6', 'jump-7'])
  expect(marks).toEqual(['›'])
})

test('an overflowing horizontal rail centers the prompt being read', async ($, on) => {
  const { lower, marks } = await overflowBand($, on, 6)
  expect(lower).toEqual(['jump-2', 'jump-3', 'jump-4', 'jump-5', 'jump-6', 'jump-7', 'jump-8', 'jump-9'])
  expect(marks).toEqual(['‹', '›'])
})

test('an overflowing horizontal rail keeps the prompt being read near the end', async ($, on) => {
  const { lower, marks } = await overflowBand($, on, 10)
  expect(lower).toEqual(['jump-4', 'jump-5', 'jump-6', 'jump-7', 'jump-8', 'jump-9', 'jump-10', 'jump-11'])
  expect(marks).toEqual(['‹'])
})

// The engine's answer for a row the transcript does not draw (a slash
// command's own row, for one), and one for a move that lost a race. The kit
// does not answer a plugin's scroll to a transcript row, so the press itself
// is checked in a live session; these pin what the plugin makes of an answer.
const NOT_DRAWN = 'nothing drawn under that requestId'
const MOVED = 'the window moved meanwhile'

test('a jump refused because nothing is drawn marks the prompt unreachable', () => {
  const unreachable = new Set<string>()
  expect(noteScroll(unreachable, 'm1', NOT_DRAWN)).toBe(true)
  expect([...unreachable]).toEqual(['m1'])
  // Told again, nothing changes, so nothing is redrawn.
  expect(noteScroll(unreachable, 'm1', NOT_DRAWN)).toBe(false)
})

test('a jump refused for a passing reason leaves the prompt as it was', () => {
  const unreachable = new Set<string>(['m2'])
  expect(noteScroll(unreachable, 'm1', MOVED)).toBe(false)
  expect(noteScroll(unreachable, 'm2', MOVED)).toBe(false)
  expect([...unreachable]).toEqual(['m2'])
})

test('a jump that lands makes the prompt reachable again', () => {
  const unreachable = new Set<string>(['m1'])
  expect(noteScroll(unreachable, 'm1', undefined)).toBe(true)
  expect([...unreachable]).toEqual([])
})

test('an unreachable prompt is drawn with a dotted tick and bar, unless being read', () => {
  expect([tick(false), tick(true), tick(false, true), tick(true, true)]).toEqual(['─', '━', '┄', '━'])
  expect([bar(false), bar(true), bar(false, true), bar(true, true)]).toEqual(['│', '┃', '┆', '┃'])
})

test('an unchanged transcript is not read again when a turn ends', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(disk.reads).toBe(1)
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.reads).toBe(1)
  // A turn that wrote to it is read.
  disk.transcript = `${TRANSCRIPT}\n${JSON.stringify({ type: 'user', uuid: 'u5', parentUuid: 'u4', message: { role: 'user', content: 'fifth' } })}`
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.reads).toBe(2)
  expect(await railLabels($)).toEqual(['first stored prompt', '<div> why does this overflow?', 'continue', 'continue', 'fifth'])
})

test('a turn that changes neither the list nor the prompt being read redraws nothing', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await railLabels($)
  const before = { invalidations: disk.invalidations, railRedraws: disk.railRedraws }
  // Same list, rewritten on disk (a row the index skips was appended).
  disk.transcript = `${TRANSCRIPT}\n${JSON.stringify({ type: 'system', uuid: 's9', parentUuid: 'u4', subtype: 'turn_duration' })}`
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.reads).toBe(2)
  expect(disk.invalidations).toBe(before.invalidations)
  expect(disk.railRedraws).toBe(before.railRedraws)
})

test('a scroll redraws the rail only when the prompt being read changes, and never the transcript', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  const clock = mock.clock(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const shown = { first: 0, last: 1, of: 2 }
  const u1 = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u1', props: prompt('first stored prompt', shown) })
  const u2 = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u2', props: prompt('<div> why does this overflow?', shown) })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const heavy = async () => (await band.findAll({ type: 'Button' })).map((b: any) => b.props.label).indexOf('┃')
  await clock.settle()
  expect(await heavy()).toBe(0)
  const before = { invalidations: disk.invalidations, railRedraws: disk.railRedraws }
  // The lower row leaves the viewport; the topmost one, and so the prompt being read, stays.
  await u2.redraw(prompt('<div> why does this overflow?', null))
  await clock.settle()
  expect(disk.railRedraws).toBe(before.railRedraws)
  // Now the top row leaves as the next one enters: the prompt being read moves.
  await u1.redraw(prompt('first stored prompt', null))
  await u2.redraw(prompt('<div> why does this overflow?', shown))
  await clock.settle()
  expect(disk.railRedraws).toBe(before.railRedraws + 1)
  expect(await heavy()).toBe(1)
  // Drawing every transcript row again mid-scroll moves the viewport the
  // person is scrolling, right after a jump, a whole turn away.
  expect(disk.invalidations).toBe(before.invalidations)
})

test('/prompt-rail <mode> writes the mode setting and switches at once', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('horizontal')
  expect(disk.panes.at(-1)).toBe('close prompt-rail')
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).length).toBe(4)
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('vertical')
  expect(disk.panes.at(-1)).toBe('open prompt-rail')
})

// A session with no /config row for the plugin's fields (the desktop app's
// SDK sessions) makes $.config.set throw rather than deny.
test('/prompt-rail <mode> still switches when the setting has no /config row', async ($, on) => {
  const toasts: string[] = []
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  mock.store(on)
  on('session.id', () => ({ value: 's1' }))
  on('config.set', () => {
    throw new Error('$.config.set: no /config row with key prompt-rail.mode ($.config.list names them)')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({}))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(e.text)
  })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', { first: 0, last: 1, of: 2 }) })
  const answer = await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  expect(answer).toBeDefined()
  // The mode applies to this session even though it could not be kept.
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).length).toBe(1)
  expect(toasts.at(-1)).toMatch(/not saved/)
})

// A module reloaded mid-session starts again from the setting; a mode the
// setting could not keep is kept for the session under its id instead.
test('a mode kept for the session only survives a reload of the module', async ($, on) => {
  const disk = beneath()
  world(on, { 'session-mode:s1': 'off' }, TRANSCRIPT, disk)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.panes).toEqual(['close prompt-rail'])
})

test('a mode the setting cannot keep is kept for the session', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's1' }))
  on('config.set', () => {
    throw new Error('$.config.set: no /config row with key prompt-rail.mode')
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => {})
  await $.command.run({ command: 'prompt-rail', args: 'off' })
  expect(store.get('session-mode:s1')).toBe('off')
})

test('the mode no longer lives in the store: an earlier version\'s moves to the setting', async ($, on) => {
  const disk = beneath()
  const store = world(on, { mode: 'vertical' }, TRANSCRIPT, disk)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.settings.get('prompt-rail.mode')).toBe('vertical')
  expect(store.has('mode')).toBe(false)
  expect(disk.panes).toEqual(['open prompt-rail'])
})

test('a session starts in the mode the setting holds, horizontal by default', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.settings.size).toBe(0)
  // The band carries the rail on the terminal, at any width: no pane opens.
  expect(disk.panes).toEqual(['close prompt-rail'])
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).length).toBeGreaterThan(0)
})

test('/prompt-rail off hides the rail until a mode turns it back on', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'prompt-rail', args: 'off' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('off')
  expect(disk.panes.at(-1)).toBe('close prompt-rail')
  // No pane and no band.
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.findAll({ type: 'Button' })).toEqual([])
  // Bare /prompt-rail says how to turn it on instead of opening anything.
  const panes = disk.panes.length
  await $.command.run({ command: 'prompt-rail', args: '' })
  expect(disk.panes.length).toBe(panes)
  expect(disk.toasts.at(-1)).toMatch(/off/)
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('horizontal')
  await band.unmount()
  const onBand = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await onBand.findAll({ type: 'Button' })).length).toBeGreaterThan(0)
})

// The kit loads the module with its default options, so the session starts
// again after the command, as a module reloaded with the setting off does.
test('a session starts with no rail while the setting is off', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'off' })
  disk.panes.length = 0
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.panes).toEqual(['close prompt-rail'])
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.findAll({ type: 'Button' })).toEqual([])
})

test('the next and previous prompts step over ones that cannot be scrolled to', () => {
  const none = () => false
  expect([stepFrom(1, 4, 1, none), stepFrom(1, 4, -1, none)]).toEqual([2, 0])
  // At either end there is nowhere to go.
  expect([stepFrom(3, 4, 1, none), stepFrom(0, 4, -1, none)]).toEqual([-1, -1])
  // Unknown where the reader is: the first or the last prompt.
  expect([stepFrom(-1, 4, 1, none), stepFrom(-1, 4, -1, none)]).toEqual([0, 3])
  const second = (i: number) => i === 2
  expect([stepFrom(1, 4, 1, second), stepFrom(3, 4, -1, second)]).toEqual([3, 1])
  expect(stepFrom(-1, 0, 1, none)).toBe(-1)
})

test('/prompt-rail runs mid-turn and takes next and prev', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.commands).toEqual([expect.objectContaining({ name: 'prompt-rail', immediate: true, argumentHint: '[off|vertical|horizontal|next|prev]' })])
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'next' })
  await $.command.run({ command: 'prompt-rail', args: 'prev' })
  // Neither is taken for a bad argument, and neither changes the mode.
  expect(disk.toasts.filter(text => text.includes('/prompt-rail ['))).toEqual([])
  expect(disk.settings.size).toBe(0)
})

test('a focused vertical pane gives its first nine rows the digits as hotkeys', async ($, on) => {
  world(on)
  for (let i = 0; i < 10; i++) {
    const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: `p${i}`, props: prompt(`prompt ${i}`, null) })
    await row.unmount()
  }
  const hotkeys = async (surface: 'terminal' | 'desktop', placement: 'dock' | 'inline', isFocused: boolean) => {
    const site = await $.ui.mount({ plugin: 'prompt-rail', surface, component: 'Pane', requestId: 'prompt-rail', props: { ...pane(placement, 40), isFocused } })
    const keys = (await site.findAll({ type: 'Button' })).map((b: any) => b.props.hotkey)
    await site.unmount()
    return keys
  }
  const digits = ['1', '2', '3', '4', '5', '6', '7', '8', '9', undefined]
  expect(await hotkeys('terminal', 'dock', true)).toEqual(digits)
  expect(await hotkeys('desktop', 'inline', true)).toEqual(digits)
  // Unfocused, a digit would never reach it, and `1:` would only crowd the row.
  expect(await hotkeys('terminal', 'dock', false)).toEqual(Array(10).fill(undefined))
})

test('a focused pane makes room for the hotkey so each row stays one line', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm3', props: prompt('a long prompt that would not fit beside its tick and hotkey', null) })
  const labels = async (bodyColumns: number) => {
    const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: { ...pane('dock', bodyColumns), isFocused: true } })
    // The surface draws a plain Button with a hotkey as `1: label`.
    const drawn = (await rail.findAll({ type: 'Button' })).map((b: any) => `${b.props.hotkey}: ${b.props.label}`)
    await rail.unmount()
    return drawn
  }
  const wide = await labels(30)
  expect(wide[2]).toBe('3: ─ a long prompt that woul…')
  // A row still leaves the frame a cell.
  expect(Math.max(...wide.map(label => label.length))).toBeLessThanOrEqual(29)
  // Too narrow for text: the hotkey and the tick fill the rail.
  expect(await labels(4)).toEqual(['1: ─', '2: ━', '3: ─'])
})

// Two turns: the first edits files and records its duration, the second only
// replies, so its duration comes from the rows' timestamps.
const TURNS = jsonl([
  { type: 'user', uuid: 'u1', timestamp: '2026-09-24T00:00:00.000Z', message: { role: 'user', content: 'first' } },
  {
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-24T00:00:10.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/src/app.ts', old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  {
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-09-24T00:01:00.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't3', name: 'Write', input: { file_path: '/w/README.md', content: '' } },
        { type: 'tool_use', id: 't4', name: 'Edit', input: { file_path: '/w/src/app.ts', old_string: 'b', new_string: 'c' } },
      ],
    },
  },
  { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 83000, timestamp: '2026-09-24T00:01:23.000Z' },
  { type: 'user', uuid: 'u2', timestamp: '2026-09-24T00:02:00.000Z', message: { role: 'user', content: 'second' } },
  { type: 'assistant', uuid: 'a3', timestamp: '2026-09-24T00:02:07.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
])

test('a turn is summed up as its duration, tool calls and edited files', () => {
  expect(turnLine({ durationMs: 83000, tools: 4, files: ['app.ts', 'README.md'] })).toBe('1m 23s · 4 tools · app.ts, README.md')
  expect(turnLine({ durationMs: 7000, tools: 1, files: [] })).toBe('7s · 1 tool')
  expect(turnLine({ durationMs: 3_720_000, tools: 0, files: [] })).toBe('1h 2m')
  expect(turnLine({ tools: 0, files: [] })).toBe('')
  expect(turnLine({ durationMs: 500, tools: 5, files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] })).toBe('0s · 5 tools · a.ts, b.ts, c.ts +2')
})

test('the hover card in the horizontal rail carries the turn\'s details', async ($, on) => {
  world(on, {}, TURNS)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first · 1m 23s · 4 tools · app\.ts, README\.md\s*$/ })).toBeDefined()
  // No turn_duration row: the time from the prompt to the turn's last row.
  expect(await band.find({ type: 'Text', text: /^#2 second · 7s\s*$/ })).toBeDefined()
})

test('a narrow band keeps room for the details by cutting the prompt first', async ($, on) => {
  world(on, {}, jsonl([
    { type: 'user', uuid: 'u1', timestamp: '2026-09-24T00:00:00.000Z', message: { role: 'user', content: 'a prompt far too long to fit in a narrow band beside its details' } },
    { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 9000 },
  ]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 40 } })
  // Thirty-six cells: `#1 `, the text cut to 28, then ` · 9s`.
  const card = await band.find({ type: 'Text', text: /^#1 a prompt far too long to fi… · 9s\s*$/ })
  expect(card).toBeDefined()
  expect(String(card?.text).trimEnd().length).toBeLessThanOrEqual(36)
})

test('the hover card of a narrow vertical rail carries the turn\'s details', async ($, on) => {
  world(on, {}, TURNS)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 4) })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^first · 1m 23s · 4 tools · app\.ts, README\.md$/ })).toBeDefined()
})

test('a turn that ends redraws the rail, so its card carries the new details', async ($, on) => {
  const first = { type: 'user', uuid: 'u1', timestamp: '2026-09-24T00:00:00.000Z', message: { role: 'user', content: 'first' } }
  const disk = beneath(jsonl([first]))
  world(on, {}, disk.transcript, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await railLabels($)
  const before = { invalidations: disk.invalidations, railRedraws: disk.railRedraws }
  disk.transcript = jsonl([first, { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 4000 }])
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.railRedraws).toBe(before.railRedraws + 1)
  expect(disk.invalidations).toBe(before.invalidations)
})

test('nothing the rail learns draws the transcript rows again', async ($, on) => {
  // Every row the module hooks would be drawn again, and rows drawn again
  // while the person scrolls just after a jump move the viewport a turn away.
  const first = { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }
  const disk = beneath(jsonl([first]))
  world(on, {}, disk.transcript, disk)
  const clock = mock.clock(on)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('ui.scroll', () => ({ value: { deny: NOT_DRAWN } }))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  // A new prompt is drawn, its turn runs and ends, and the transcript has it.
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u2', props: prompt('second', null) })
  await $.turn.start({ text: 'second', turnId: 't1' })
  await $.turn.complete({ answer: 'done', durationMs: 3000, isAborted: false, turnId: 't1', reason: 'answer' })
  disk.transcript = jsonl([first, { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } }])
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  // The pane narrows, and a jump is refused for want of a drawn row.
  const rail = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 40) })
  await rail.redraw(pane('dock', 4))
  await rail.press({ key: 'jump-0' })
  await clock.settle()
  expect(disk.railRedraws).toBeGreaterThan(0)
  expect(disk.invalidations).toBe(0)
})

test('a turn that just ended shows the duration the engine reported before the transcript has it', async ($, on) => {
  // At the Stop hook the transcript holds neither the turn_duration row nor
  // the turn's last reply: the rows' timestamps alone would say 7s.
  world(on, {}, TURNS)
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  // A subagent's turn is not the prompt's.
  await $.turn.complete({ answer: '', durationMs: 99000, isAborted: false, turnId: 'sub', agentId: 'ag1', reason: 'answer' })
  await $.turn.complete({ answer: 'done', durationMs: 12500, isAborted: false, turnId: 'main', reason: 'answer' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#2 second · 12s\s*$/ })).toBeDefined()
  // The turn_duration row the transcript records wins where it has one.
  expect(await band.find({ type: 'Text', text: /^#1 first · 1m 23s · 4 tools · app\.ts, README\.md\s*$/ })).toBeDefined()
})

test('what the engine reported of a turn stays with its prompt once the stored row replaces a derived one', async ($, on) => {
  const disk = beneath(jsonl([]))
  world(on, {}, disk.transcript, disk)
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await drawSplit($, 'UserMessage', SPLIT_IDS.firstRow, null)
  await $.turn.complete({ answer: 'done', durationMs: 12500, isAborted: true, turnId: 'main', reason: 'aborted' })
  disk.transcript = jsonl([{ type: 'user', uuid: SPLIT_IDS.first, message: { role: 'user', content: 'first' } }])
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first · 12s · interrupted\s*$/ })).toBeDefined()
})

test('next and prev wait while a subagent transcript is in view', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  const sub = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: { ...pane('dock', 40), view: { agentId: 'ag1' } } })
  await $.command.run({ command: 'prompt-rail', args: 'next' })
  // No jump is tried there, so no refusal can dot a main-conversation prompt.
  expect(disk.toasts).toEqual(['prompt-rail: next and prev move through the main conversation; switch back to it first'])
  await sub.unmount()
  expect((await railLabels($)).length).toBe(4)
  const main = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await main.unmount()
  await $.command.run({ command: 'prompt-rail', args: 'prev' })
  expect(disk.toasts.filter(text => text.includes('switch back'))).toHaveLength(1)
})

test('files that share a name are told apart by their folder', async ($, on) => {
  expect(turnLine({ tools: 2, files: ['/p/web/index.ts', '/p/api/index.ts', '/p/README.md'] })).toBe('2 tools · web/index.ts, api/index.ts, README.md')
  world(on, {}, jsonl([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/web/index.ts' } },
          { type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/p/api/index.ts' } },
          { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/p/api/index.ts' } },
        ],
      },
    },
  ]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first · 3 tools · web\/index\.ts, api\/index\.ts\s*$/ })).toBeDefined()
})

test('a turn line too long for its room names fewer files and keeps the count', () => {
  const turn = { durationMs: 9000, tools: 3, files: ['/w/alpha.ts', '/w/beta.ts', '/w/gamma.ts'] }
  expect(turnLine(turn)).toBe('9s · 3 tools · alpha.ts, beta.ts, gamma.ts')
  expect(turnLine(turn, 26)).toBe('9s · 3 tools · alpha.ts +2')
  expect(turnLine(turn, 25)).toBe('9s · 3 tools · 3 files')
})

test('a long turn summary keeps its end in the card', async ($, on) => {
  world(on, {}, jsonl([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'a prompt that is long enough to be cut in the card' } },
    {
      type: 'assistant',
      uuid: 'a1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/w/a-long-file-name.ts' } },
          { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/w/another-long-name.ts' } },
        ],
      },
    },
    { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 9000 },
  ]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 50 } })
  // Forty-six cells: the file count stays whole at the end.
  const card = await band.find({ type: 'Text', text: /· 9s · 2 tools · 2 files\s*$/ })
  expect(card).toBeDefined()
  expect(String(card?.text).trimEnd().length).toBeLessThanOrEqual(46)
})

test('slash-command rows and interruption notices are not listed as prompts', async ($, on) => {
  world(on, {}, jsonl([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'user', uuid: 'i1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', uuid: 'c1', message: { role: 'user', content: '/compact' } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    { type: 'user', uuid: 'i2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first', 'second'])
})

// Three turns: interrupted, ended by an API error, and one that edited a file.
const OUTCOMES = jsonl([
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'partial' }] } },
  { type: 'user', uuid: 'i1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
  { type: 'assistant', uuid: 'a2', isApiErrorMessage: true, message: { role: 'assistant', content: [{ type: 'text', text: 'API Error' }] } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: 'third' } },
  { type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: '/w/a.ts' } }] } },
  { type: 'user', uuid: 'u4', message: { role: 'user', content: 'fourth' } },
])

// The turn details each hidden card of a narrow vertical rail carries.
const cardDetails = async ($: any) => {
  const site = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'Pane', requestId: 'prompt-rail', props: pane('dock', 4) })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const details = (await band.findAll({ type: 'Text' })).map((t: any) => String(t.text)).filter((text: string) => !/^#\d+ $/.test(text))
  await band.unmount()
  await site.unmount()
  return details
}

test('a turn is summed up with how it ended', () => {
  expect(turnLine({ durationMs: 7000, tools: 1, files: [], outcome: 'interrupted' })).toBe('7s · interrupted · 1 tool')
  expect(turnLine({ tools: 0, files: [], outcome: 'error' })).toBe('API error')
  expect(turnLine({ tools: 2, files: [], outcome: 'running' })).toBe('running · 2 tools')
})

test('no rail draws a colored mark; how a turn went is left to its card', async ($, on) => {
  world(on, {}, OUTCOMES)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  for (const [surface, placement] of [['terminal', 'dock'], ['desktop', 'inline']] as const) {
    const site = await $.ui.mount({ plugin: 'prompt-rail', surface, component: 'Pane', requestId: 'prompt-rail', props: pane(placement, 40) })
    expect(await site.findAll({ type: 'Text' })).toEqual([])
    await site.unmount()
  }
  expect(await cardDetails($)).toEqual(['first · interrupted', 'second · API error', 'third · 1 tool · a.ts', 'fourth'])
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const texts = await band.findAll({ type: 'Text' })
  expect(texts.filter((t: any) => t.props.color !== undefined || ['×', '•'].includes(t.text))).toEqual([])
  await band.unmount()
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  expect(await railLabels($)).toEqual(['first', 'second', 'third', 'fourth'])
})

test('the running turn\'s card says so until it ends, then how it ended', async ($, on) => {
  world(on, {}, '')
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await $.classic.SessionStart({ source: 'startup', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  // The prompt's row is stored and drawn, then its turn starts.
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u1', props: prompt('first', null) })
  await row.unmount()
  await $.turn.start({ text: 'first', turnId: 't1' })
  expect(await cardDetails($)).toEqual(['first · running'])
  await $.turn.complete({ answer: '', durationMs: 3000, isAborted: true, turnId: 't1', reason: 'aborted' })
  expect(await cardDetails($)).toEqual(['first · 3s · interrupted'])
})

// The status line belongs to the person: the rail pins nothing there, even
// where neither the pane nor the band shows it.
test('the rail never pins a status line', async ($, on) => {
  const disk = { ...beneath(), placed: false }
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u3', props: prompt('continue', { first: 0, last: 1, of: 2 }) })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.status).toEqual([])
})

test('a reply the transcript read has not seen yet counts as the newest prompt\'s', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  // The Stop hook read the file before the turn's last reply was written, so
  // the index does not know this row; only the newest turn can own it.
  await $.ui.mount({
    plugin: 'prompt-rail',
    surface: 'terminal',
    component: 'AssistantMessage',
    requestId: 'late-reply',
    props: { text: 'done', onScreen: { first: 0, last: 1, of: 2 } },
  })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#4 continue$/ })).toBeDefined()
})

test('a prompt still drawn under its provisional id places no one', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u1', props: prompt('first stored prompt', { first: 0, last: 1, of: 2 }) })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'placeholder', props: prompt('fifth', { first: 0, last: 1, of: 2 }) })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first stored prompt$/ })).toBeDefined()
})

test('a new prompt\'s turn runs under that prompt, not the one before it', async ($, on) => {
  world(on, {}, jsonl([{ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } }]))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  // The turn for "second" starts before its row is stored under its uuid.
  await $.turn.start({ text: 'second', turnId: 't2' })
  expect(await cardDetails($)).toEqual(['first'])
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u2', props: prompt('second', null) })
  await row.unmount()
  expect(await cardDetails($)).toEqual(['first', 'second · running'])
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't2', reason: 'answer' })
  // A continuation (no typed text) runs under the newest prompt at once.
  await $.turn.start({ text: '', turnId: 't3' })
  expect(await cardDetails($)).toEqual(['first', 'second · 1s · running'])
})

test('a repeated prompt\'s turn does not run under the earlier one with the same text', async ($, on) => {
  world(on)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'vertical' })
  // The transcript ends in "continue"; the person sends "continue" again.
  await $.turn.start({ text: 'continue', turnId: 't5' })
  const isRunning = async () => (await cardDetails($)).map((details: string) => details.endsWith('running'))
  expect(await isRunning()).toEqual([false, false, false, false])
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u5', props: prompt('continue', null) })
  await row.unmount()
  expect(await isRunning()).toEqual([false, false, false, false, true])
})

test('a late reply of the turn before stays with its prompt once a new one is sent', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'horizontal' })
  // The last reply of u4's turn was stored after the Stop hook read the file.
  disk.transcript = `${TRANSCRIPT}\n${JSON.stringify({ type: 'assistant', uuid: 'late', parentUuid: 'u4', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })}`
  disk.mtimeMs = 2
  await $.turn.start({ text: 'fifth', turnId: 't5' })
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u5', props: prompt('fifth', null) })
  await row.unmount()
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AssistantMessage', requestId: 'late', props: { text: 'done', onScreen: { first: 0, last: 1, of: 2 } } })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#4 continue$/ })).toBeDefined()
})
