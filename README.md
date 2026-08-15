# AI Reading Companion

AI Reading Companion lets you select text in any Obsidian Markdown note, discuss it with an OpenAI-compatible model, collect answer excerpts in an editable draft, and save only the draft you confirm.

The conversation, reasoning output, search results, and unselected answer text are not written to your Vault automatically.

## Features

- Multi-turn chat grounded in the selected passage.
- A bounded local conversation list that restores up to 20 recent temporary sessions after the view or Obsidian reloads.
- A visible per-answer Context Receipt showing which context categories were used, trimmed, or omitted.
- Select any part of an answer to reveal a contextual **Add to draft** action, or add an entire answer with one click.
- Collect passages across multiple turns in a per-conversation editable draft, then save them together.
- Named model configurations that preserve separate provider, endpoint, model ID, API protocol, hosted-tool settings, and SecretStorage key references, with one-click switching, duplication, and deletion.
- OpenAI, Kimi Coding, GLM Coding Plan, Volcengine Ark, and custom OpenAI-compatible provider presets.
- Per-configuration support for both Chat Completions and Responses API, including provider-hosted `web_search` tools and source annotations.
- Optional images from Obsidian embeds, Markdown images, local Vault files, or public URLs.
- Independent web-search configuration with Kimi Coding, GLM Coding Plan, Tavily, Brave Search, Exa, Serper, self-hosted SearXNG, and generic Remote MCP adapters.
- Coding-plan credential reuse: supported bundled search services can use the already selected model API key.
- Two search behaviors: model-controlled function calls, or search-before-chat for models without tool calling.
- Inline source citations, a visible source list, and limited page fetching for relevant results.
- Optional folder-scoped local retrieval without a whole-vault vector index. The model can search only folders you allow and read only temporary references returned during the current run.
- Identity-aware local evidence lanes that keep personal or user-curated notes from being crowded out by imported material, while marking uncertain ownership as unknown rather than guessing.
- Bounded retrieval of related historical questions without replaying old AI answers as evidence.
- Candidate-based learning-preference memory: only repeated, explicit preference signals become reviewable, and only preferences you confirm affect future answer style.
- A local runtime-diagnostics summary for latency, failures, cancellation, context trimming, and source/tool counts; diagnostic records contain no note text, questions, answers, paths, URLs, or credentials.
- A visible Stop action, request timeout, lifecycle status, and per-tool call/result budgets.
- Review and edit a web-source excerpt before saving it to a configurable inbox; existing notes are never overwritten.
- Save confirmed excerpts to the source note or a configurable central note.
- Optionally collect each source document's confirmed Q&A in `Folder/Note/AI conversations.md`.
- Include the selected source passage in a native Obsidian callout that is collapsed by default.
- Configurable destination heading and Markdown save template.
- Pop-out or right-sidebar conversation view on desktop.
- A mobile-first full-tab view with Conversation, Passage, and Draft sections.
- Touch-friendly text selection and direct image-tap question entry on phones and tablets.
- Configurable behavior for ordinary internal links.

## How to use

1. Select text, text plus images, or right-click a rendered image directly in any Markdown note.
2. Right-click and choose **Ask AI about selected text or image**, or run the command from the command palette.
3. Continue the conversation in the pop-out or sidebar view.
4. Select the exact part of an assistant answer that you want to keep, then choose **Add to draft** beside the selection. Repeat across any number of turns.
5. Edit the collected passages in the left-side draft and choose **Save draft**.

### Mobile

1. Add **AI Reading Companion: Ask AI about selected text or image** to Obsidian's mobile toolbar, or use the plugin ribbon action.
2. To ask about text, select it and run that action.
3. To ask about an image, tap the rendered image, then tap **Ask AI about this image**.
4. Use the **Conversation**, **Passage**, and **Draft** tabs to switch without stacking all three areas on one screen.
5. Use the conversation selector above the tabs to return to an earlier selection.

On tablets, Obsidian may provide more room, but the same touch-safe workflow is used whenever the app is running in mobile mode.

By default, the excerpt is appended to the source note under:

```markdown
## AI excerpts
```

The heading is created automatically when it does not exist. You can instead save every confirmed excerpt to one central note.

## Provider setup

Each model configuration can use either the OpenAI-compatible Chat Completions protocol or Responses API. The adapter converts the same conversation and local function tools to the selected wire format.

The first setting, **Interface language**, switches the complete settings page between English and Simplified Chinese. English remains the default for marketplace installations, and the choice is stored without changing any provider, key, search, or saving configuration.

1. Create or select a named configuration. Existing single-model settings are migrated automatically without exposing or discarding their SecretStorage key reference.
2. Choose a provider preset.
3. The provider preset declaratively chooses the recommended API protocol, web route, and—when the provider publishes a compatible bundled search interface—the matching independent-search adapter. Volcengine Ark defaults to Responses API with provider-hosted `web_search`; Kimi Coding and GLM Coding Plan default to Chat Completions with their matching plan-search adapter. Providers without a paired adapter reuse an already configured portable independent service such as Tavily; if none exists, web access remains off instead of reusing an incompatible coding-plan credential. Future presets use the same mapping instead of adding UI-specific special cases.
4. Open **Advanced model connection settings** only when a compatible proxy or custom endpoint requires a different protocol, URL, or hosted-search tool declaration.
5. Review the API base URL. Presets provide a default; custom providers and proxies accept any compatible root or full `chat/completions` or `responses` URL.
6. Enter the model ID supported by that provider and select or create an API key in Obsidian SecretStorage.
7. Run **Test connection**. Switch configurations from the same list whenever you want to use another account or provider.

## Web search setup

Web access has two mutually exclusive execution paths for each request:

- A Responses API model configuration can declare a provider-hosted search tool. The provider performs the search inside its service and returns the final model output plus source annotations. The plugin does not make a second search request.
- Otherwise, the plugin can use an independently configured search service. This lets a compatible model without native search support receive current results.

Each named model configuration stores one explicit **Web access route**:

- **Provider-hosted search** requires a hosted tool on the active Responses API model configuration.
- **Independent search service** uses one named search configuration or an ordered failover list associated with the active model configuration. It can be used with Chat Completions or Responses API models.
- **No web access** disables both paths.

There is no automatic failover between hosted search, independent search, and disabled access. Switching model configurations also switches their saved web-access route, independent-search policy, and selected search configuration(s). Independent services are saved separately and grouped by established protocols and adapters: vendor bundled endpoints, REST search APIs, or Streamable HTTP MCP. A custom URL is not treated as a universal search protocol because authentication, request bodies, and result formats vary by provider.

1. Review **How this model accesses the web**. Provider presets choose a sensible route automatically: Volcengine Ark uses provider-hosted search, while Kimi Coding and GLM Coding Plan use their matching independent search adapter. You can override this route explicitly.
2. For an independent route, use **Use the selected configuration** for normal use. If you explicitly need backups, choose **Try backup configurations when the first one is unavailable** and arrange the backup order. Switching advances only for timeouts, rate limits, quota/balance errors, and server failures; authentication and configuration errors stop immediately.
3. Choose the credential source when the provider supports it:
   - **Reuse model API key** avoids duplicate configuration when search is included in the same coding plan.
   - **Use a separate search API key** is required when the search product has independent credentials or billing.
4. Expand **Manage search configurations (advanced)** only when you need to add or edit a search service. For an external search API, confirm its endpoint. For a generic Remote MCP server, also confirm the search tool name and query argument. SearXNG keys are optional.
   - When the active model provider has a paired plan-search adapter, the plugin keeps one provider-default search configuration available. For example, selecting Kimi Coding guarantees a Kimi Coding search configuration; that default cannot be deleted or converted to another provider while Kimi Coding is active. Duplicated or separately created configurations remain removable.
5. Choose a behavior:
   - **Model decides** exposes `WebSearch` and `FetchURL` functions. Use it with models that support OpenAI-style function calling.
   - **Search every question first** retrieves results before each model request. Use it with models that do not support function calling.
6. Choose **Test search**. This sends only a neutral test query, never note content.

Existing Kimi Coding configurations are migrated automatically to the Kimi Coding plan search adapter. This is plugin-executed search, not a provider-hosted Responses API tool. Disabling the search provider leaves normal chat unchanged.

The GLM Coding Plan preset connects to its official `webSearchPrime` Remote MCP endpoint and reuses the selected GLM model key by default. The generic Remote MCP option covers other plans that publish a Streamable HTTP MCP server. Its URL field is deliberately labeled as an MCP endpoint: an ordinary REST search URL, local stdio MCP, or vendor CLI-only tool is not compatible. Some coding plans also require a different general-platform key for search even when model access uses a subscription key.

## Local knowledge setup

Local retrieval is deliberately folder-scoped and lexical in this version; it does not create embeddings or a whole-vault index. Inside the selected scope, the plugin maintains a bounded, incremental in-memory body-term cache in addition to note metadata. The cache is discarded with the plugin process and never expands beyond the authorized folder.

1. Under **Local knowledge**, enable folder-scoped retrieval.
2. Add one Vault-relative folder per line to the allowlist.
3. Start a conversation from a note. The composer defaults to the deepest allowed folder containing that note.
4. Use the folder selector to choose another allowed scope or **Current note only** before sending.

The first retrieval pass compares the question with cached filenames, headings, aliases, tags, links, and bounded body terms, then reads only a few high-scoring passages. Results are balanced across personal/user-curated notes, external material, and unknown identity; every passage retains that identity and an epistemic-status label in the Context Receipt. Further tool calls accept temporary source references, not arbitrary file paths. Retrieved notes may be imported material, so the model is instructed not to treat them as the user's own knowledge or as a proven connection without textual support.

Related historical questions from the same selected scope may be included as continuity cues. The plugin does not include the old assistant answer, and a prior question is never treated as supporting evidence.

## Learning-preference memory

The plugin observes only explicit statements about how you prefer to learn or receive explanations. A signal remains a local candidate until similar evidence appears in three distinct conversations, after which it becomes ready for review. Use **Review learning memory candidates** from the command palette to confirm, reject, or delete it. Only confirmed preferences enter the model context, and they control presentation style rather than factual conclusions. Candidates become stale after 90 days; confirmed preferences are marked for review after 180 days without use. The store is capped at 50 records.

Use **Show agent runtime diagnostics** to inspect local p50/p95 duration, completion and cancellation counts, context-trimming rate, and categorized failures. This is operational diagnostics, not telemetry: it remains in Obsidian's plugin `data.json`, keeps at most 200 records for 30 days, is capped at 256 KB, and can be cleared from the dialog or the plugin settings.

## Saving a web source

Open **Sources used this turn** beneath an answer and choose **Review and save**. Edit the title and excerpt, optionally add why you kept it, review the destination, and confirm. Only the reviewed fields are written to the configured Web source inbox. If the filename already exists, the plugin creates a timestamped copy instead of overwriting it.

## Agent Runtime architecture

The model/tool loop is implemented by a provider-neutral `AgentRuntime`. It owns model turns, tool-call parsing, tool registration, tool-result messages, round limits, cancellation checks, runtime events, and final-response detection. A frozen `RunPlan` defines the current request's budgets and grants. `ContextBuilder` selects bounded context and produces a visible receipt, while `ModelTransport` translates Chat Completions or Responses API requests and classifies transport errors. A `RunController` owns stop and timeout semantics, and a `ToolGateway` enforces explicit grants, call budgets, result-size limits, and abort propagation before any client-executed tool runs. Provider-hosted Responses tools execute on the provider side and return source annotations through the protocol adapter.

Tools are registered as a definition plus an async executor. Executors return model-visible text and optional internal `artifacts`; for example, the WebSearch and FetchURL tools return source records as artifacts, which the reading view turns into its source list. The runtime itself does not contain web-search, note, or knowledge-base logic.

Temporary sessions are stored separately from plugin settings with count, age, and byte limits. Older conversation turns are compacted once into a deterministic role-labelled continuity block when they exceed the current context budget. Scoped retrieval separates evidence identity, historical questions provide continuity without old AI answers, and confirmed learning preferences affect explanation style only. See [the staged Agent development plan](docs/agent-development-plan.md) for scope, acceptance criteria, and deliberately deferred work.

## Save template

The default template records the time, source note, heading, line range, question, and confirmed answer excerpt. Available variables:

`{{timestamp}}`, `{{date}}`, `{{sourceLink}}`, `{{sourceFile}}`, `{{sourceHeading}}`, `{{sourceLabel}}`, `{{lineRange}}`, `{{question}}`, `{{answer}}`, `{{questionQuote}}`, and `{{answerQuote}}`.

## Data and network disclosure

When you send a question, the plugin sends the selected passage, your question, the current conversation history, the configured system prompt, and any images you explicitly selected to the configured API endpoint.

When provider-hosted search is enabled, the configured Responses API host receives the conversation and performs its hosted search internally; the plugin receives the final response and source annotations. Otherwise, the current question or a model-generated query is sent to the separately configured search provider. In model-controlled mode, the plugin may also fetch a limited amount of text from relevant public HTTP or HTTPS pages; local and private-network page addresses are blocked. Search results and fetched pages are sent to the chat model as untrusted reference material. A web source is written to the Vault only after you review and confirm its visible save form.

When local retrieval is enabled for a conversation, the plugin compares the question with cached metadata and a bounded in-memory body-term index inside the selected allowed folder, and may read a few matching note passages. Those passages, their Obsidian links, identity labels, related historical questions, and confirmed learning preferences may be sent to the configured chat model. No whole-vault index or vector database is built. Selected answer text first stays in the temporary editable draft; only the draft you explicitly save is written to the Vault.

To recover interrupted work, the plugin stores bounded temporary-session data inside Obsidian's plugin `data.json`. It keeps at most 20 recent sessions for 30 days and caps the session section at 2 MB. It does not copy image binaries, store API keys, or treat these temporary conversations as user-confirmed knowledge. Clearing the conversation list removes the stored session list.

Learning-preference candidates and confirmations are stored in a separate bounded section of the same `data.json`. Operational counters use another bounded section that deliberately excludes user content, file paths, URLs, source excerpts, and credentials. The **Local data and privacy** section in plugin settings explains these limits and can clear all three local Agent-data sections without deleting model, search, or saving configurations. Versions that used `sessions.json`, `learning-memory.json`, and `run-metrics.json` migrate those files once and remove them after a successful migration.

The plugin contains no telemetry, advertising, or background analytics. The model API key is sent only to the configured model host, and the separate search key is sent only to the configured search endpoint. Only configure endpoints you trust.

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
