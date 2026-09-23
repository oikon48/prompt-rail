import { test, expect, mock } from 'claude-code/testing'

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

  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', null) })
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm2', props: prompt('second prompt', { first: 0, last: 3, of: 4 }) })

  const rail = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'Pane', requestId: 'turn-rail', props: pane('dock') })
  expect((await rail.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([' ─ ', ' ━ '])
  expect((await rail.press({ key: 'jump-1' }))?.element).toBe('jump-1')
  await rail.unmount()

  // The desktop has no band to reveal a card in, so its dock lists the text.
  const desktopDock = await $.ui.mount({ plugin: 'turn-rail', surface: 'desktop', component: 'Pane', requestId: 'turn-rail', props: pane('dock', 40) })
  expect((await desktopDock.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['─ first prompt', '━ second prompt'])
  expect((await desktopDock.press({ key: 'jump-1' }))?.element).toBe('jump-1')
  await desktopDock.unmount()

  for (const surface of SURFACES) {
    const list = await $.ui.mount({ plugin: 'turn-rail', surface, component: 'Pane', requestId: 'turn-rail', props: pane('inline') })
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
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({}))
  on('ui.toast', () => {})
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', null) })
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm2', props: prompt('second prompt', { first: 0, last: 3, of: 4 }) })
}

test('a narrow vertical rail leaves the prompt text to hidden cards in the band', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'Pane', requestId: 'turn-rail', props: pane('dock', 4) })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.find({ key: 'card-0' }))?.props.display).toBe('none')
  expect(await band.find({ type: 'Text', text: /first prompt/ })).toBeDefined()
})

test('a wide vertical rail shows each prompt beside its tick and keeps the band empty', async ($, on) => {
  await drawPrompts($, on)
  const rail = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'Pane', requestId: 'turn-rail', props: pane('dock', 37) })
  expect((await rail.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([' ─ first prompt', ' ━ second prompt'])
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'card-0' })).toBeUndefined()
})

test('wide characters are cut by the cells they take', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm3', props: prompt('日本語のプロンプト', null) })
  const rail = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'Pane', requestId: 'turn-rail', props: pane('dock', 12) })
  expect((await rail.findAll({ type: 'Button' })).map(b => b.props.label)[2]).toBe(' ─ 日本語…')
})

test('/prompts horizontal draws bars over a text line, tall only where being read', async ($, on) => {
  await drawPrompts($, on)
  await $.command.run({ command: 'prompts', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // Upper row: only the prompt on screen stands a bar; lower row: every prompt.
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([' ', '┃', '│', '┃'])
  // The text line shows the prompt on screen until a bar is hovered.
  expect(await band.find({ type: 'Text', text: /^#2 second prompt$/ })).toBeDefined()
  expect((await band.find({ key: 'card-0' }))?.props.display).toBe('none')
  expect((await band.press({ key: 'jump-0' }))?.element).toBe('jump-0')
  expect((await band.press({ key: 'jump-0-upper' }))?.element).toBe('jump-0-upper')
})

test('with several prompts on screen only the topmost one stands tall', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm3', props: prompt('third prompt', { first: 0, last: 1, of: 2 }) })
  await $.command.run({ command: 'prompts', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // m2 and m3 both show; m2 is the one being read.
  expect((await band.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual([' ', '┃', ' ', '│', '┃', '│'])
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
  { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/prompts</command-name>' } },
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

// The world beneath the plugin for a session whose transcript is TRANSCRIPT,
// with a store in memory the test can read.
const world = (on: any, initial: Record<string, unknown> = {}, transcript = TRANSCRIPT) => {
  const store = new Map<string, unknown>(Object.entries(initial))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return {}
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return {}
  })
  on('fs.read', ($: any, e: any) => ({ value: e.path === '/t/s1.jsonl' ? transcript : '' }))
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'prompts' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({}))
  on('ui.toast', () => {})
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }))
  on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.tool }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => $.ui.resolve(e).Box({}))
  return store
}

const railLabels = async ($: any) => {
  const rail = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'Pane', requestId: 'turn-rail', props: pane('dock', 40) })
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
  world(on, { mode: 'horizontal', 'transcript:s1': { path: '/t/s1.jsonl', at: 1 } })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).length).toBe(8)
})

test('prompts are listed in transcript order, wrappers left out, repeats kept', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first stored prompt', '<div> why does this overflow?', 'continue', 'continue'])
})

test('a repeated prompt gets its own entry; the provisional row is not listed', async ($, on) => {
  world(on)
  const draw = async (requestId: string, text: string) => {
    const row = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId, props: prompt(text, null) })
    await row.unmount()
  }
  await draw('placeholder', 'continue')
  await draw('x1', 'continue')
  await draw('placeholder', 'continue')
  await draw('x2', 'continue')
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a tool row at the top of the viewport places the reader under its prompt', async ($, on) => {
  world(on, { mode: 'horizontal' })
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.ui.mount({
    plugin: 'turn-rail',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 't1',
    props: { tool_use_id: 't1', tool: 'Bash', input: {}, isRunning: false, isErrored: false, isInterrupted: false, onScreen: { first: 0, last: 1, of: 2 } },
  })
  await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u3', props: prompt('continue', { first: 0, last: 1, of: 2 }) })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ type: 'Text', text: /^#1 first stored prompt$/ })).toBeDefined()
})

test('after /rewind only the live branch is listed', async ($, on) => {
  world(on, {}, FORKED)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['alpha', 'delta'])
})

test('a drawn row from an abandoned branch drops out once the transcript is read', async ($, on) => {
  world(on, {}, FORKED)
  const row = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: 'p2', props: prompt('beta', null) })
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
  const rail = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'Pane', requestId: 'turn-rail', props: { ...pane('dock', 37), view: { agentId: 'ag1' } } })
  expect(await rail.findAll({ type: 'Button' })).toEqual([])
  expect(await rail.find({ type: 'Text', text: /main conversation/ })).toBeDefined()
})

test("while a subagent's transcript is in view the band stays empty", async ($, on) => {
  await drawPrompts($, on)
  await $.command.run({ command: 'prompts', args: 'horizontal' })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'ag1' } } })
  expect(await band.findAll({ type: 'Button' })).toEqual([])
})

// Twelve prompts, the one at `reading` on screen, in a horizontal band ten
// cells wide: eight bars fit between the two elision marks.
const overflowBand = async ($: any, on: any, reading: number) => {
  world(on, { mode: 'horizontal' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  for (let i = 0; i < 12; i++) {
    const onScreen = i === reading ? { first: 0, last: 1, of: 2 } : null
    await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'UserMessage', requestId: `p${i}`, props: prompt(`prompt ${i}`, onScreen) })
  }
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 14 } })
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
