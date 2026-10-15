# prompt-rail

A rail of your prompts for Claude Code. Hover to read one, click to jump back to it.

prompt-rail is a mod: it draws a row of bars above the prompt input, or a pane beside the transcript, with one tick for each prompt you sent in the session. Hovering a tick shows the prompt and a short summary of its turn, and clicking it scrolls the transcript to that prompt. Commands step through the prompts from the keyboard.

It needs Claude Code v2.1.287 or later, in the terminal or in the Code tab of the Claude desktop app. Mouse works best with `"tui": "fullscreen"`.

## Install

From the Claude directory, or from the plugin's own marketplace:

```bash
claude plugin marketplace add oikon48/prompt-rail
claude plugin install prompt-rail@oikon48
```

Start a new session and the rail opens on its own.

## Commands

| Command | |
| --- | --- |
| `/prompt-rail horizontal` | Bars above the prompt input (the default) |
| `/prompt-rail vertical` | A pane beside the transcript |
| `/prompt-rail off` | Hide the rail |
| `/prompt-rail next`, `prev` | Jump to the next or previous prompt |
| `/prompt-rail first`, `last` | Jump to the first or the newest prompt |
| `/prompt-rail 12`, `#12` | Jump to prompt #12 |
| `/prompt-rail find <words>` | Jump to the newest prompt that holds the words |
| `/prompt-rail-next`, `/prompt-rail-prev` | Jump to the next or previous prompt, for a keybinding |
| `/prompt-rail-toggle` | Hide the rail, or bring it back, for a keybinding |
| `/prompt-rail` | Reopen the rail in the current layout |

The layout is also the "Rail mode" row in `/config`, and it is kept across sessions.

In the horizontal layout, `ctrl+x tab` moves the focus to the bars: `←` `→` move across them, `Enter` jumps to the prompt, `Esc` returns to the prompt input.

## What it reads, runs, and stores

prompt-rail makes no network requests and sends nothing anywhere. Everything it does stays on your machine:

- It reads the current session's transcript file (the `.jsonl` file Claude Code writes for the session) to list your prompts and their turns.
- When a transcript is too large to read in one call, it streams the file with `tail -c +N <transcript>`. On a Windows path where `tail` cannot start, it runs `powershell -NoProfile -NonInteractive` with a short script that copies the same file from that position. It runs no other program.
- It keeps the chosen layout in the "Rail mode" setting, and in the mod's own store it keeps the layout last on and the transcript paths of the most recent sessions, so a resumed session can find its rail again.

## Limitations

- The Claude desktop app draws the horizontal rail, but a click cannot jump there, since the app gives a plugin no way to scroll its transcript.
- A `/compact` command's own row cannot be jumped to.
- Near the end of the transcript, `next` cannot scroll further.

## Source and license

Source, issues, and the full README with screenshots: https://github.com/oikon48/prompt-rail

[MIT](https://github.com/oikon48/prompt-rail/blob/main/LICENSE)
