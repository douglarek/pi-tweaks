# pi-tweaks

Small fullscreen UI tweaks for Pi.

## What we tweak

### Message hover brackets

Hover over any chat message to reveal a subtle left-side bracket spanning the entry. User messages, assistant text, thinking, tool calls/results, command output, custom entries, summaries, warnings, and status notices are all covered.

### Question timeline

A centered rail on the right gives each rendered user question its own short tick. Hovering extends the tick to the left, making it easier to click without shifting the rail or reflowing the transcript. The current question is highlighted, and long conversations use a sliding tick window instead of overlapping markers.

### Question previews

Hover over a tick to see a wrapped preview of the original question. Preview labels are in English; question text remains in its original language.

### Viewport navigation

Click a tick to scroll to its question. The destination message keeps a highlighted left-side bracket so it is easy to identify after the pointer leaves the rail; manual scrolling clears that destination marker. The arrows and mouse wheel over the rail move between questions. `/question-nav 3` provides keyboard-only navigation to the third question.

Navigation only changes the viewport. It does not change the active conversation branch, message history, model context, or the editor's draft.

### Native interactions stay native

Text selection/copy, links, thinking expansion, tool expansion, keyboard focus, and overlays remain on Pi's normal input path. Brackets and previews are screen decorations, not transcript text.

## Current scope

- Fullscreen mode; tested with Pi **1.0.4**.
- The rail appears with at least two rendered questions and enough terminal space. Skill headers and their accompanying question count as one user turn.
- Both tweaks are active whenever the extension is loaded; no separate switches or preference files.
- Runtime hooks and temporary gutter sizing are scoped to active instances and restored on unload/reload. Pi's installed source files are not modified. Private TUI hooks may require adaptation after Pi upgrades.
