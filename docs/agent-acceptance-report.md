# Agent Runtime acceptance report

Date: 2026-08-14  
Plugin version: 1.2.0  
Acceptance source: `40.专题与项目/Claude Code 深度学习/Claude Code Harness 架构精读_架构优先版.md`

## Acceptance method

The acceptance run combines static review, production compilation, bounded smoke tests, and an end-to-end run inside an isolated Obsidian profile. The Obsidian run uses a loopback-only fake model service, so it exercises the installed plugin without consuming a real API quota or sending note content to an external provider.

The end-to-end path is:

`selected passage -> ContextBuilder -> folder-scoped retrieval -> ToolGateway -> AgentRuntime -> ModelTransport -> tool result -> final answer -> Context Receipt`

A second end-to-end request exercises the Responses API path with a provider-hosted `web_search` declaration and source annotation parsing.

## Results

| Area | Result | Evidence |
|---|---|---|
| Frozen Run Plan and budgets | Pass | Desktop/mobile plans are frozen; text, image, round, timeout, and tool grants are bounded. |
| Context priority and Receipt | Pass | Selected passage, confirmed preferences, recent conversation, factual evidence, historical questions, and compaction have separate receipts. Factual local/Web evidence receives budget before historical continuity cues. |
| Chat Completions tool loop | Pass | Installed plugin made two local model requests, registered `SearchKnowledgeScope` and `ReadKnowledgePassages`, executed one tool call, and returned a final answer. |
| Responses API hosted search | Pass | Installed plugin sent `store: false`, declared `web_search`, parsed final text, and collected one URL annotation without making an independent search request. |
| Folder permission boundary | Pass | Retrieval only accepted the selected authorized scope; arbitrary paths were rejected and only temporary source refs could be read. |
| Knowledge identity lanes | Pass | Personal/user-curated evidence keeps a retrieval lane when higher-scoring imported material is present; unknown ownership is not guessed. |
| Historical question continuity | Pass | Related user questions can be retrieved inside the selected scope; old assistant answers are excluded. |
| Learning-preference memory | Pass | Three distinct sessions are required before review; unconfirmed memory does not enter Context; rejected preferences are suppressed rather than recreated. |
| Tool permission and result budgets | Pass | Missing grants and excess calls are denied; oversized tool text is truncated before it returns to the model. |
| Stop control | Pass | Real Obsidian lifecycle was `created -> cancel_requested -> cancelled`, with the cancellation reason preserved as `user`. |
| Session and metric storage bounds | Pass | Session count/age/bytes and metric count/age/bytes are bounded; image binaries and diagnostic content are excluded. |
| Knowledge-write boundary | Pass | The acceptance source note's size and modification time were unchanged after both Agent requests. |
| Release quality | Pass | ESLint, TypeScript, production build, release-size guard, and smoke suite pass. |

## Findings fixed during acceptance

1. Rejected learning preferences could be rediscovered as a new candidate. A matching rejected record now suppresses automatic recreation; the user can still confirm or delete it manually.
2. Historical questions could consume total Context budget before factual local or Web evidence. Evidence now receives budget first; history yields when the global limit is tight.
3. The incremental body-term cache could theoretically accumulate beyond its character cap after file-order changes. Each refresh now evicts unprocessed entries and enforces the two-million-character hard bound.

## Residual risks

- Provider-specific behavior cannot be proven by a fake service. Real Kimi, GLM, Volcengine, OpenAI-compatible proxy, and independent-search accounts still require opt-in connection tests because authentication, quotas, and protocol deviations are external state.
- The desktop acceptance run does not reproduce mobile memory pressure, soft-keyboard behavior, or every image decoder. Mobile layout smoke tests and image budgets pass, but one physical-device pass remains appropriate before marketplace release.
- Retrieval relevance is lexical rather than semantic. The bounded diagnostics should be used to determine whether missed retrievals justify a later semantic index; no vector database should be added without evidence.
- Responses are buffered rather than token-streamed. Cancellation stops the request and prevents stale UI writes, but it cannot make a provider that buffers its response emit partial tokens.

## Repeat commands

```bash
npm run verify
npm run test:agent-ui -- 9223
```

The second command requires an Obsidian instance exposing the DevTools protocol on the supplied port. It temporarily overrides model settings in memory, restores them in `finally`, and uses a loopback-only model server.
