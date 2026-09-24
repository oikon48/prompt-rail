<div align="center">

# turn-rail

A rail of your prompts for Claude Code. Hover to read one, click to jump back to it.

![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-D97757)
![Claude Code 2.1.280+](https://img.shields.io/badge/Claude%20Code-2.1.280%2B-555)
![Function hooks](https://img.shields.io/badge/function%20hooks-experimental-orange)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

<img src="docs/demo.gif" alt="turn-rail demo: hovering the rail previews a prompt and its turn, clicking jumps the transcript to it" width="800">

</div>

## Quick start

1. Turn on function hooks (early access, Claude Code 2.1.280 or newer) by adding the flag to `~/.claude/settings.json`:

   ```json
   {
     "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1" }
   }
   ```

2. Add the marketplace and install the plugin:

   ```bash
   claude plugin marketplace add oikon48/turn-rail
   claude plugin install turn-rail@oikon48
   ```

3. Start a new session. The rail opens on its own.

Clicking and hovering work best in the fullscreen terminal layout (`"tui": "fullscreen"` in the same file), where the terminal reports the mouse. While this repository is private, adding the marketplace needs git access to it, through an SSH key or `gh auth login`.

## Why

Long Claude Code sessions bury your own prompts under replies, diffs and tool output. Scrolling back to find "the prompt where I asked for the tests" means reading the whole transcript again. turn-rail keeps one tick per prompt on screen, shows what each one asked and what its turn did, and scrolls the transcript straight to it when you click.

## Features

- One click jumps the transcript to any earlier prompt, and the rail lists every prompt of the session, including those from before a resume.
- Hovering a bar of the horizontal rail shows the prompt with a summary of its turn, such as `#3 fix the overflow · 1m 23s · 4 tools · app.ts, README.md`.
- The tick of the prompt you are reading stands out and follows you as you scroll.
- Two layouts: a docked pane beside the transcript, or a compact bar above the prompt input. Either can be turned off.
- It follows the live branch of the conversation, so prompts abandoned with `/rewind` drop out of the rail.
- `/turn-rail next` and `/turn-rail prev` step through prompts from the keyboard, even while a turn is streaming.

## Usage

### Layouts

The rail has two layouts, and you can also turn it off. All three are one setting, "Rail mode", which `/config` lists as a single row that opens a picker. The `/turn-rail` commands below write the same setting, the change applies at once, and it is kept for later sessions under `pluginConfigs` in `~/.claude/settings.json`.

Horizontal draws the rail in the band above the prompt input, as a text line over a row of bars, one bar per prompt. The bar of the prompt you are reading is thick, and its text is shown dimmed on the text line. Hovering a bar replaces the text line with that prompt and its turn summary. When there are more prompts than the row can hold, it shows a window around the prompt you are reading, with `‹` and `›` marking the prompts on either side.

Vertical, the default, docks a pane beside the transcript with one row per prompt: a tick and the prompt's first line. The row of the prompt you are reading is bright, with a thick tick. On a terminal too narrow to seat the pane, it waits until there is room, and the horizontal layout is the one to use there.

Off closes the pane and leaves the band above the prompt input empty until you pick a layout again.

### Commands

| Command | What it does |
| --- | --- |
| `/turn-rail` | Reopens the rail in the current layout. While the rail is off, it says how to turn it on. |
| `/turn-rail horizontal` | Shows the rail as bars above the prompt input. |
| `/turn-rail vertical` | Shows the rail as a pane beside the transcript. |
| `/turn-rail off` | Hides the rail. |
| `/turn-rail next` | Scrolls to the prompt after the one you are reading. |
| `/turn-rail prev` | Scrolls to the prompt before the one you are reading. |

### Keyboard

Claude Code does not let a plugin define keybindings of its own, so the keyboard routes are the `next` and `prev` commands and the pane's digits. While the vertical pane has the keyboard (ctrl+x tab, or Tab onto it), its first nine rows show `1:` to `9:`, and pressing a digit jumps to that prompt. Esc gives the keyboard back to the prompt input.

### Reading the ticks

A prompt whose jump Claude Code refused, because its row is not drawn in the transcript, gets a dotted tick (`┄`, or `┆` in the horizontal rail) from then on, and `next` and `prev` pass over it. While a subagent's transcript is in view, the rail steps aside, since its prompts belong to the main conversation.

## How it works

<details>
<summary>How the rail knows your prompts and where you are</summary>

The plugin reads the session's transcript file to list every prompt, including the ones the terminal has not drawn yet after a resume, and to learn which prompt each reply and tool call belongs to. It follows the chain of parent rows back from the newest one, so prompts abandoned with `/rewind` are left out.

Transcript rows are drawn under their transcript uuid, so a click asks Claude Code to scroll that row into view. The prompt you are reading is the one that owns the topmost row in the latest batch of on-screen reports that Claude Code sends while you scroll. A reply or tool row that the transcript did not hold yet when it was last read, such as one from the turn still running, counts as the newest prompt's.

The rail asks for a redraw only when the list or the prompt you are reading changes. When a turn ends, it reads the transcript again only if the file's size or modification time changed. It never writes to the status line, which stays yours.

</details>

## Limitations

turn-rail is built on function hooks, which are early access. The hook API may change between Claude Code releases, so treat the plugin as experimental.

The hover text of the horizontal rail relies on the band above the prompt, which only the terminal draws. In the Claude desktop app the plugin shows the vertical list with each prompt's text, and that path has not been checked there yet.

Claude Code shares one dock width among all plugin panes and remembers it once you resize it, so the pane may open wider than the rail needs. Drag its edge to narrow it, down to Claude Code's minimum of 24 columns.

Prompts sent before a `/compact` stay in the transcript and can still be jumped to. A row the rail lists but the transcript does not draw, such as the `/compact` command's own row right after a compaction, cannot be. The rail learns this only when a click on it is refused, so the tick turns dotted after the first try, and `/clear` forgets it.

Near the end of the transcript, the last prompts may already be in view below the top row. The transcript cannot scroll further, so `/turn-rail next` stays put and the thick tick keeps marking the prompt at the top. The digit hotkeys cover the first nine prompts only.

The turn summary is part of the horizontal rail's hover card. The vertical pane draws each prompt's text in its row and has no card. A turn still running has no duration yet, and its tool count and files catch up when the turn ends.

## Development

Load the plugin from this checkout for one session. Saving a file reloads the hooks module in a running interactive session.

```bash
claude --plugin-dir plugins/turn-rail
```

Generate type declarations for your Claude Code build into `.claude/types` (ignored by git) by running `/plugin-types .claude/types` inside a session opened in this repository. The `tsconfig.json` here picks them up.

```bash
claude plugin validate plugins/turn-rail
claude plugin test plugins/turn-rail
```

Installed copies update only when the version in `plugins/turn-rail/.claude-plugin/plugin.json` changes, so bump it with each release.

## License

[MIT](LICENSE)
