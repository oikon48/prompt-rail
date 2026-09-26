# Changelog

## 0.6.0

- Removed the digit hotkeys from the vertical pane: a click focuses the pane, so the first nine rows grew a `1:` prefix and shifted under the pointer, and the digits reached only the oldest nine prompts; a click and `/prompt-rail next` and `prev` jump to a prompt

## 0.5.3

- Fixed a prompt showing up as two or three bars when it did not go straight into a turn: one queued while a turn ran, one delivered into the running turn, or one sent from Remote Control; it now shows one bar from the moment it is sent, which takes its stored row once that is drawn
- Fixed prompts in a long session being listed in the order their rows were drawn (close to reverse after a reload), with older prompts missing and no turn details, because a transcript over 4 MiB was never read; it is now read with `tail`, from where the last read ended, without holding the session while it loads
- Fixed a prompt drawn under an id the engine derives from its stored uuid being listed twice, placing the reader under the newest prompt, and refusing jumps
- Changed a prompt delivered into a running turn to be listed on its own, with the turn's details staying on the prompt that started it

## 0.5.2

- Fixed a prompt sent while an artifact is open in the viewer being listed as the `<artifact-view-context>` block the engine puts ahead of it; the rail now shows the typed text, and a tag typed by hand is kept as typed

## 0.5.1

- Fixed jumping to a prompt and then scrolling flipping the heavy bar back to the prompt jumped to, and sometimes moving the transcript a turn away; the rail now redraws only its own sites, not every transcript row it hooks

## 0.5.0

- Changed the default mode to the horizontal rail above the prompt, since the engine seats an unasked pane only from 144 columns; a mode already chosen stays as it is
- Added CI that validates and tests the plugin on every push and pull request, and weekly against the latest Claude Code
- Changed the README to say the desktop app shows no rail

## 0.4.0

- Changed the plugin's name from turn-rail to prompt-rail: the `/prompt-rail` command, the pane id, the mode setting key and the marketplace entry take the new name, and the repository moves to oikon48/prompt-rail

## 0.3.1

- Fixed `/turn-rail <mode>` failing where the setting has no /config row, as in the desktop app's SDK sessions; the mode now applies to the session and a toast says it was not saved
- Fixed a mode kept for the session only being lost when the module reloads

## 0.3.0

- Added an off mode, chosen in the mode setting or with `/turn-rail off`
- Changed the horizontal rail to a text line over one row of bars, the bar of the prompt being read heavy
- Changed the text line to show the newest prompt while none is on screen
- Removed the colored turn marks; how a turn went stays in its hover card
- Removed the status line position, so the rail never pins a status line
- Fixed the focus ring lingering on the horizontal rail's bars and the vertical pane's rows

## 0.2.0

- Added a hover card that sums up each turn: its duration, tool calls, edited files and how it ended
- Added a dotted tick for prompts that cannot be scrolled to
- Added a mode setting in /config, and `/turn-rail next` and `prev` as keyboard routes
- Added digit hotkeys for the first nine rows while the vertical pane has the keyboard
- Fixed slash-command rows and interruption notices being listed as prompts
- Fixed replies the transcript read has not seen yet placing the reader under the prompt before
- Fixed abandoned branches staying listed after /rewind
- Fixed the rail showing while a subagent's transcript is in view; it now holds a note

## 0.1.0

- Added a rail of the session's prompts, as a pane beside the transcript or a band above the prompt; hover a tick to read a prompt and click it to jump there
- Added listing of prompts from the stored transcript, so a resumed session shows its earlier prompts
- Added separate entries for a repeated prompt
