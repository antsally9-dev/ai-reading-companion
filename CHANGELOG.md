# Changelog

## Unreleased

- Added direct right-click detection for rendered Live Preview images, without requiring the editor cursor to be moved onto the image source line.
- Added image-only and mixed text-plus-image context-menu entry points; images explicitly included in the selection now start checked.
- Added an editable per-conversation excerpt draft: select text in any AI answer, use the contextual action, collect multiple passages, then save once.
- Fixed Obsidian's default button height collapsing conversation previews so the selected source text is now always visible in the conversation list.
- Replaced hover-only source previews with an always-visible vertical conversation timeline.
- Added a per-document companion-note destination under `Folder/Note/AI conversations.md` with a configurable filename.
- Added the selected source passage to the default template as a collapsed native Obsidian callout.
- Changed conversation-list titles to begin with the selected source text for faster switching.
- Added conversation numbers, active-state labels, cleaned selection previews, and line ranges so sessions from the same heading remain distinguishable.
- Fixed conversation-list overflow and text overlap in narrow sidebars.
- Made rendered AI answers explicitly text-selectable inside Obsidian views.
- Added a one-click action to select an entire answer for saving.
- Added an in-memory conversation list with switching, per-conversation deletion, and clear-all controls.

## 1.0.0

- Ask an OpenAI-compatible model about selected Markdown in a multi-turn view.
- Include explicitly selected local or remote images in the first turn.
- Use Kimi Coding web search and page fetch with visible sources.
- Save only user-confirmed answer excerpts to the source note or a central note.
- Configure the destination heading and Markdown save template.
- Open ordinary internal links in a tab, split, pop-out window, or current view.
