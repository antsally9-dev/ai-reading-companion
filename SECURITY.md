# Security policy

Please report security issues privately through GitHub Security Advisories after the repository is published. Do not include API keys, private notes, or other sensitive Vault data in a public issue.

The plugin stores only Obsidian SecretStorage key names in plugin settings. The model secret is read at request time and sent only to the configured model API host. A separately selected web-search secret is sent only to the configured search endpoint.

Temporary conversations, confirmed learning preferences, and content-free runtime diagnostics are stored locally in bounded sections of Obsidian's plugin `data.json`. Runtime diagnostics never contain note text, questions, answers, paths, URLs, source excerpts, API keys, or tool results. The plugin does not upload telemetry. Users can clear all local Agent data from plugin settings without removing connection or saving configuration.

When a search provider is explicitly configured to reuse the model credential, the selected model secret is also sent to that search provider's endpoint. This is intended for coding plans that document a shared model/search entitlement. Verify the endpoint and provider terms before enabling credential reuse.

In model-controlled web mode, relevant public pages can be fetched and supplied to the model as untrusted reference material. Direct page fetching rejects credentials in URLs and blocks local or private-network addresses. Custom model, search, proxy, and SearXNG endpoints should be configured only when you trust their operators.
