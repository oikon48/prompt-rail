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

const TRANSCRIPT = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first stored prompt' } },
  { type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second stored prompt' } },
]
  .map(row => JSON.stringify(row))
  .join('\n')

const answerTranscript = (on: any) => {
  on('fs.read', ($: any, e: any) => ({ value: e.path === '/t/s1.jsonl' ? TRANSCRIPT : '' }))
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}))
}

test('the session start remembers where its transcript is', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return {}
  })
  answerTranscript(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(store.get('transcripts')).toEqual({ s1: '/t/s1.jsonl' })
})

test('a reload lists the prompts again from the remembered transcript', async ($, on) => {
  // A reloaded module has no list; session.start fires again and rebuilds it.
  mock.store(on, { mode: 'horizontal', transcripts: { s1: '/t/s1.jsonl' } })
  answerTranscript(on)
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => $.ui.resolve(e).Box({}))
  on('ui.close', () => ({}))
  on('command.register', () => ({ value: { command: 'prompts' } }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  const band = await $.ui.mount({ plugin: 'turn-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await band.findAll({ type: 'Button' })).length).toBe(4)
  expect(await band.find({ key: 'card-1' })).toBeDefined()
})
