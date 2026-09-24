# turn-rail

turn-rail is a Claude Code plugin that shows the prompts of the current session as a rail of ticks. Hovering a tick shows the prompt's text, and clicking it scrolls the transcript to that prompt. The tick for the prompt you are reading stands out and follows you as you scroll.

It is built on Claude Code's function hooks (Mods), which are early access. The hook API may change between Claude Code releases, so treat this plugin as experimental.

## Requirements

You need Claude Code 2.1.280 or newer with function hooks enabled. Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your environment or in the `env` block of `~/.claude/settings.json`. The horizontal rail and the click to jump work best in the fullscreen terminal layout (`"tui": "fullscreen"`), where the terminal reports mouse clicks and the engine owns the transcript's scrolling.

## Install

```bash
claude plugin marketplace add oikon48/turn-rail
```

```bash
claude plugin install turn-rail@oikon48
```

The repository doubles as the `oikon48` marketplace, where more plugins may be listed later. While the repository is private, adding the marketplace needs git access to it (an SSH key or `gh auth login`).

Start a new session afterwards. The rail opens on its own when the session starts.

## Usage

The rail is driven by the `/turn-rail` command, named after the plugin so it does not collide with other plugins' commands. The rail has two modes and can be turned off. All three live in one setting, the plugin's "Rail mode", which `/config` lists as a single row; selecting it opens a picker with `off`, `vertical` and `horizontal`. `/turn-rail off`, `/turn-rail vertical` and `/turn-rail horizontal` are shortcuts that write the same setting. Either way the change applies at once and is kept for later sessions, since Claude Code stores it under `pluginConfigs` in `~/.claude/settings.json`. A mode saved by an earlier version of the plugin moves into the setting the next time a session starts.

`/turn-rail vertical` is the default. It docks a pane beside the transcript with one row per prompt, a tick and the prompt's first line. The row of the prompt you are reading is drawn bright with a thick tick. If you drag the pane narrower than 12 columns, the rows shrink to ticks and the hovered prompt's text appears above the prompt input instead.

`/turn-rail horizontal` closes the pane and draws the rail in the band above the prompt input, as four rows: a row of marks that also separates it from the transcript, two rows of upright bars, and a text line. The prompt you are reading stands two rows tall and its text is shown dimmed on the text line. Hovering a bar raises it to two rows and replaces the text line with that prompt. When there are more prompts than the row can hold, it shows a window centered on the prompt you are reading, with `‹` and `›` marking the prompts elided on either side. Clicking a bar jumps without leaving a focus highlight on it, since the band keeps its focus ring off the bars.

`/turn-rail off` closes the pane and leaves the band above the prompt input empty. The rail stays off in later sessions until you pick a mode again.

A mark before each tick tells how that prompt's turn went: a yellow `•` while it runs, a red `×` when it was interrupted or ended in an API error, and a green `•` when it edited files. The horizontal rail draws the marks in its top row, above the bars. They use the theme's warning, error and success colors, so they follow the theme you picked.

A hovered prompt's card also sums up the turn it started on the same line, as the transcript records it: how long it took, whether it is still running or was interrupted or ended in an API error, how many tool calls it made, and the names of the files it edited with Edit or Write, for example `#3 fix the overflow · 1m 23s · 4 tools · app.ts, README.md`. When the band is narrow, the prompt's text is cut first so the summary keeps its room.

A prompt whose click the engine refused because its row is not drawn in the transcript gets a dotted tick (`┄`, or `┆` in the horizontal rail) from then on, so you can tell it apart before clicking it again.

`/turn-rail next` and `/turn-rail prev` scroll the transcript to the prompt after or before the one you are reading, passing over prompts with a dotted tick. They run at once even while a turn is streaming. While the vertical pane has the keyboard (ctrl+x tab, or Tab onto it), its first nine rows show `1:` to `9:` in front of the tick, and pressing that digit jumps to the prompt. Esc gives the keyboard back to the prompt input. Claude Code does not let a plugin define keybindings of its own, so these commands and the pane's digits are the keyboard routes.

When the vertical pane is not on screen, because the terminal is too narrow to seat it or because you closed it, the status line under the prompt input shows where you are instead, as `#3/12` (`#–/12` until a prompt is known to be on screen). It clears once the pane is drawn again, and the horizontal rail needs no status line.

Running `/turn-rail` with no argument reopens the rail in the current mode. While the rail is off it opens nothing and says which command turns it on. While a subagent's transcript is in view, the rail steps aside, since its prompts belong to the main conversation.

## How it works

The plugin reads the session's transcript file to list every prompt, including the ones the terminal has not drawn yet after a resume, and to learn which prompt each reply and tool call belongs to. It follows the chain of parent rows back from the newest one, so prompts abandoned with `/rewind` are left out. Transcript rows are drawn under their transcript uuid, so a click can ask the engine to scroll that row into view. The prompt you are reading is the one that owns the topmost row in the latest batch of on-screen reports the engine sends while you scroll. A reply or tool row that the transcript did not hold yet when it was last read, such as one from the turn still running or the last reply of a turn that just ended, counts as the newest prompt's. The rail asks for a redraw only when the list or the prompt you are reading changes, and when a turn ends it reads the transcript again only if the file's size or modification time changed.

## Limitations

The hover text in horizontal mode and the narrow vertical rail rely on the band above the prompt, which only the terminal draws. In the Claude desktop app the plugin always shows the vertical list with text, and that path has not been checked in the desktop app yet.

The dock's width is shared by every plugin pane and remembered by Claude Code once you resize it, so the pane may open wider than the rail needs. Drag its edge to narrow it.

Prompts sent before a `/compact` stay drawn in the transcript and can still be jumped to. A row the rail lists but the transcript does not draw, such as the `/compact` command's own row that shows up in the list right after a compaction, cannot be. The rail only learns this when a click on it is refused, so the tick turns dotted after the first try, and `/clear` forgets it.

Near the end of the transcript the last prompts may already be in view below the top row. The transcript cannot scroll any further, so `/turn-rail next` stays where it is and the thick tick keeps marking the prompt at the top. The digit hotkeys cover the first nine prompts of the list only.

The turn summary is part of the hover card, so it shows in horizontal mode and on the narrow vertical rail. The wide vertical rail and the desktop list draw the prompt's text in the row itself and have no card. A turn still running has no duration yet, and its tool count and files catch up when the turn ends.

## Development

Load the plugin from this checkout for one session with `claude --plugin-dir plugins/turn-rail`. Saving a file reloads the hooks module in a running interactive session.

Generate type declarations for your Claude Code build into `.claude/types` (ignored by git) by running `/plugin-types .claude/types` inside a session opened in this repository. The `tsconfig.json` here picks them up.

```bash
claude plugin validate plugins/turn-rail
```

```bash
claude plugin test plugins/turn-rail
```
