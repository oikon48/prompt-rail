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

The rail has two modes, switched with the `/prompts` command. The chosen mode is remembered across sessions.

`/prompts vertical` is the default. It docks a pane beside the transcript with one row per prompt, a tick and the prompt's first line. The row of the prompt you are reading is drawn bright with a thick tick. If you drag the pane narrower than 12 columns, the rows shrink to ticks and the hovered prompt's text appears above the prompt input instead.

`/prompts horizontal` closes the pane and draws the rail in the band above the prompt input, as four rows: a blank row that separates it from the transcript, two rows of upright bars, and a text line. The prompt you are reading stands two rows tall and its text is shown dimmed on the text line. Hovering a bar raises it to two rows and replaces the text line with that prompt. When there are more prompts than the row can hold, the oldest are elided behind a `‹`.

Running `/prompts` with no argument reopens the rail in the current mode.

## How it works

The plugin reads the session's transcript file to list every prompt, including the ones the terminal has not drawn yet after a resume, and to learn which prompt each reply and tool call belongs to. Transcript rows are drawn under their transcript uuid, so a click can ask the engine to scroll that row into view. The prompt you are reading is the one that owns the topmost row in the latest batch of on-screen reports the engine sends while you scroll.

## Limitations

The hover text in horizontal mode and the narrow vertical rail rely on the band above the prompt, which only the terminal draws. In the Claude desktop app the plugin always shows the vertical list with text, and that path has not been checked in the desktop app yet.

The dock's width is shared by every plugin pane and remembered by Claude Code once you resize it, so the pane may open wider than the rail needs. Drag its edge to narrow it.

Tool calls and replies made during the current turn are mapped to their prompt when the turn ends, so while a long turn is running, a viewport showing only that turn's new tool rows keeps the previous highlight.

## Development

Load the plugin from this checkout for one session with `claude --plugin-dir plugins/turn-rail`. Saving a file reloads the hooks module in a running interactive session.

Generate type declarations for your Claude Code build into `.claude/types` (ignored by git) by running `/plugin-types .claude/types` inside a session opened in this repository. The `tsconfig.json` here picks them up.

```bash
claude plugin validate plugins/turn-rail
```

```bash
claude plugin test plugins/turn-rail
```
