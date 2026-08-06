# AI Reading Companion

AI Reading Companion lets you select text in any Obsidian Markdown note, discuss it with an OpenAI-compatible model, collect answer excerpts in an editable draft, and save only the draft you confirm.

The conversation, reasoning output, search results, and unselected answer text are not written to your Vault automatically.

## Features

- Multi-turn chat grounded in the selected passage.
- An in-memory conversation list that keeps separate selections available until the view or Obsidian closes.
- Select any part of an answer to reveal a contextual **Add to draft** action, or add an entire answer with one click.
- Collect passages across multiple turns in a per-conversation editable draft, then save them together.
- OpenAI, Kimi Coding, and custom OpenAI-compatible provider presets.
- Optional images from Obsidian embeds, Markdown images, local Vault files, or public URLs.
- Kimi Coding web search and page fetch with inline citations and a source list.
- Save confirmed excerpts to the source note or a configurable central note.
- Optionally collect each source document's confirmed Q&A in `Folder/Note/AI conversations.md`.
- Include the selected source passage in a native Obsidian callout that is collapsed by default.
- Configurable destination heading and Markdown save template.
- Pop-out or right-sidebar conversation view.
- Configurable behavior for ordinary internal links.

## How to use

1. Select text in any Markdown note.
2. Right-click and choose **Ask AI about selected text**, or run the command from the command palette.
3. Continue the conversation in the pop-out or sidebar view.
4. Select the exact part of an assistant answer that you want to keep, then choose **Add to draft** beside the selection. Repeat across any number of turns.
5. Edit the collected passages in the left-side draft and choose **Save draft**.

By default, the excerpt is appended to the source note under:

```markdown
## AI excerpts
```

The heading is created automatically when it does not exist. You can instead save every confirmed excerpt to one central note.

## Provider setup

The plugin uses the OpenAI-compatible `chat/completions` message format.

1. Choose a provider preset.
2. Enter the model ID supported by that provider.
3. Select or create an API key in Obsidian SecretStorage.
4. Run **Test connection**.

Kimi Coding is currently the only preset with integrated `/search` and `/fetch` web tools. Other OpenAI-compatible endpoints continue to work for chat, but the web toggle is disabled unless compatible search endpoints are available.

## Save template

The default template records the time, source note, heading, line range, question, and confirmed answer excerpt. Available variables:

`{{timestamp}}`, `{{date}}`, `{{sourceLink}}`, `{{sourceFile}}`, `{{sourceHeading}}`, `{{sourceLabel}}`, `{{lineRange}}`, `{{question}}`, `{{answer}}`, `{{questionQuote}}`, and `{{answerQuote}}`.

## Data and network disclosure

When you send a question, the plugin sends the selected passage, your question, the current conversation history, the configured system prompt, and any images you explicitly selected to the configured API endpoint.

When compatible web search is enabled, the model may search the web and fetch a limited number of relevant pages. Selected answer text first stays in the temporary editable draft; only the draft you explicitly save is written to the Vault.

The plugin contains no telemetry, advertising, or background analytics. Changing the custom API base URL causes the selected Secret to be used with that host, so only configure providers you trust.

## Installation from a release

Download `main.js`, `manifest.json`, and `styles.css` from a GitHub release and place them in:

```text
<vault>/.obsidian/plugins/ai-reading-companion/
```

Restart Obsidian and enable **AI Reading Companion** under Community plugins.

## Development

```bash
npm install
npm run dev
npm run build
npm run lint
npm run verify
```

`npm run verify` checks lint rules, compiles the production bundle, and confirms that package, manifest, compatibility, and release-file versions agree.

## Releasing

1. Update `minAppVersion` in `manifest.json` if compatibility changed.
2. Run `npm version patch`, `npm version minor`, or `npm version major`.
3. Push the commit and the version tag (without a `v` prefix).
4. Review and publish the draft GitHub release created by the release workflow.

The release contains `main.js`, `manifest.json`, and `styles.css`, as required by Obsidian.

## Author

[antsally9-dev](https://github.com/antsally9-dev)

## License

Apache License 2.0.
