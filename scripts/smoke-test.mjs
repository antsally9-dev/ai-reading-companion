import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { createJiti } from "jiti";

let requestHandler = async () => {
  throw new Error("Unexpected network request in smoke test.");
};
let registeredViewFactory = null;
let registeredViewType = null;

class Plugin {
  async loadData() {
    return this.testData;
  }

  async saveData(data) {
    this.testData = data;
  }

  registerView(type, factory) {
    registeredViewType = type;
    registeredViewFactory = factory;
  }

  addSettingTab() {}
  registerDomEvent() {}
  registerEvent() {}
  addCommand() {}
  addRibbonIcon() {}
}

class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.app;
  }
}
class MarkdownView {}
class Modal {}
class PluginSettingTab {
  constructor(app, plugin) {
    this.app = app;
    this.plugin = plugin;
  }
}
class SecretComponent {}
class Setting {}
class Component {
  load() {}
  unload() {}
  registerDomEvent() {}
}

const obsidianMock = {
  Component,
  ItemView,
  MarkdownView,
  MarkdownRenderer: { render: async () => {} },
  Modal,
  Notice: class {},
  Plugin,
  PluginSettingTab,
  Platform: {
    isMobile: false,
    isMobileApp: false,
  },
  SecretComponent,
  Setting,
  arrayBufferToBase64: (buffer) => Buffer.from(buffer).toString("base64"),
  moment: () => ({
    format: (pattern) =>
      pattern === "YYYY-MM-DD" ? "2026-08-05" : "2026-08-05 10:00",
  }),
  normalizePath: (path) => String(path).replaceAll("\\", "/"),
  requestUrl: (options) => requestHandler(options),
  setIcon: () => {},
};

const entryPath = process.env.PLUGIN_BUNDLE_PATH
  ? resolve(process.env.PLUGIN_BUNDLE_PATH)
  : resolve("main.js");
const compiledModule = new Module(entryPath);
compiledModule.filename = entryPath;
compiledModule.paths = Module._nodeModulePaths(process.cwd());

const originalLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === "obsidian"
    ? obsidianMock
    : originalLoad(request, parent, isMain);

try {
  compiledModule._compile(
    `const document = {}; const window = { setTimeout, clearTimeout };\n${readFileSync(entryPath, "utf8")}`,
    entryPath,
  );
} finally {
  Module._load = originalLoad;
}

const AiReadingCompanionPlugin =
  compiledModule.exports.default ?? compiledModule.exports;
const jiti = createJiti(import.meta.url);
const sourceModulePaths = [
  "../src/agent-runtime.ts",
  "../src/ask-question-use-case.ts",
  "../src/complex-question.ts",
  "../src/context-builder.ts",
  "../src/conversation-branch.ts",
  "../src/conversation-domain.ts",
  "../src/external-prompt.ts",
  "../src/knowledge-identity.ts",
  "../src/memory-store.ts",
  "../src/model-transport.ts",
  "../src/plugin-data-store.ts",
  "../src/question-routing.ts",
  "../src/responses-api.ts",
  "../src/run-controller.ts",
  "../src/run-metrics.ts",
  "../src/run-plan.ts",
  "../src/session-store.ts",
  "../src/tool-gateway.ts",
  "../src/web-search.ts",
];
let sourceModules;
Module._load = (request, parent, isMain) =>
  request === "obsidian"
    ? obsidianMock
    : originalLoad(request, parent, isMain);
try {
  sourceModules = await Promise.all(
    sourceModulePaths.map((path) => jiti.import(path)),
  );
} finally {
  Module._load = originalLoad;
}
const sourceExports = Object.assign(
  {},
  ...sourceModules,
  compiledModule.exports,
);
const {
  AgentRuntime,
  AskQuestionUseCase,
  BoundedSessionStore,
  ContextBuilder,
  KnowledgeScopeRetriever,
  LearningMemoryStore,
  ModelTransport,
  ModelTransportError,
  PluginDataStore,
  RunMetricsStore,
  RunCancelledError,
  RunController,
  ToolGateway,
  buildExternalAiPrompt,
  buildResponsesRequestBody,
  buildQuestionRecords,
  canonicalizePublicPageUrl,
  classifyKnowledgeIdentity,
  classifyModelTransportError,
  createAgentRunPlan,
  dedupeQuestionContextItems,
  detectLearningPreferenceSignal,
  determineQuestionToolNeeds,
  extractModelUsage,
  extractResponsesAssistantMessage,
  fetchWebPage,
  findKnowledgeScopeForFile,
  makeResponsesUrl,
  normalizeQuestionConversation,
  pathIsWithinScope,
  parseComplexQuestionPlan,
  questionLooksComplex,
  searchHistoricalQuestions,
  selectConversationBranch,
  shouldPlanComplexQuestion,
  ConversationGraph,
  createStableConversationId,
  migrateLegacyConversationSession,
  validateConversationSession,
} = sourceExports;
assert.equal(typeof AgentRuntime, "function");
assert.equal(typeof AskQuestionUseCase, "function");
assert.equal(typeof normalizeQuestionConversation, "function");
assert.equal(typeof ContextBuilder, "function");
assert.equal(typeof ModelTransport, "function");
assert.equal(typeof ModelTransportError, "function");
assert.equal(typeof PluginDataStore, "function");
assert.equal(typeof BoundedSessionStore, "function");
assert.equal(typeof ConversationGraph, "function");
assert.equal(typeof buildExternalAiPrompt, "function");
assert.equal(typeof dedupeQuestionContextItems, "function");
assert.equal(typeof LearningMemoryStore, "function");
assert.equal(typeof RunMetricsStore, "function");
assert.equal(typeof RunController, "function");
assert.equal(typeof ToolGateway, "function");
assert.equal(typeof KnowledgeScopeRetriever, "function");
assert.equal(typeof selectConversationBranch, "function");
assert.equal(typeof createStableConversationId, "function");
assert.equal(typeof migrateLegacyConversationSession, "function");
assert.equal(typeof validateConversationSession, "function");
assert.equal(typeof canonicalizePublicPageUrl, "function");
assert.equal(typeof fetchWebPage, "function");

const injectedModelRequests = [];
const injectedModelTransport = new ModelTransport({
  httpClient: {
    async request(request) {
      injectedModelRequests.push(request);
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: "",
        json: {
          choices: [{ message: { content: "Answer from a fake HTTP client" } }],
          usage: { prompt_tokens: 12, completion_tokens: 4 },
        },
      };
    },
  },
});
const injectedModelResponse = await injectedModelTransport.send({
  protocol: "chat_completions",
  baseUrl: "https://model.example.com/v1",
  model: "test-model",
  headers: { Authorization: "Bearer fake" },
  messages: [{ role: "user", content: "Test dependency injection" }],
});
assert.equal(injectedModelRequests.length, 1);
assert.equal(
  injectedModelRequests[0].url,
  "https://model.example.com/v1/chat/completions",
);
assert.equal(
  injectedModelResponse.assistantMessage.content,
  "Answer from a fake HTTP client",
);
assert.equal(injectedModelResponse.usage.totalTokens, 16);

assert.equal(
  canonicalizePublicPageUrl("https://Example.COM:443/docs?q=1#section"),
  "https://example.com/docs?q=1",
);
for (const blockedUrl of [
  "file:///etc/passwd",
  "http://example.com/insecure",
  "https://user:password@example.com/private",
  "https://example.com:8443/private",
  "http://127.0.0.1/admin",
  "http://2130706433/admin",
  "http://169.254.169.254/latest/meta-data",
  "http://100.100.100.200/latest/meta-data",
  "http://192.168.1.10/",
  "http://[::1]/",
  "http://[::ffff:127.0.0.1]/",
  "http://metadata.google.internal/",
  "http://printer.local/",
  "http://intranet/",
]) {
  assert.throws(
    () => canonicalizePublicPageUrl(blockedUrl),
    /Page fetch/,
    `unsafe page URL must be rejected: ${blockedUrl}`,
  );
}

const fetchConfig = {
  httpClient: {
    request: (request) => requestHandler(request),
  },
  provider: "kimi",
  endpoint: "",
  apiKey: "",
  resultLimit: 5,
  modelBaseUrl: "https://api.kimi.com/coding/v1",
  allowedFetchUrls: new Set(["https://docs.example.com/guide?q=1#intro"]),
};
let secureFetchRequests = 0;
requestHandler = async () => {
  secureFetchRequests += 1;
  return {
    status: 200,
    headers: { "content-type": "text/markdown", "content-length": "15" },
    text: "# Trusted guide",
  };
};
await assert.rejects(
  fetchWebPage(fetchConfig, "https://docs.example.com/guide?q=2"),
  /exact URL returned by web search/,
);
assert.equal(secureFetchRequests, 0, "provenance denial must happen before I/O");
const secureFetchResult = await fetchWebPage(
  fetchConfig,
  "https://docs.example.com/guide?q=1",
);
assert.match(secureFetchResult.content, /Trusted guide/);
assert.equal(secureFetchRequests, 1);

requestHandler = async () => {
  secureFetchRequests += 1;
  return {
    status: 200,
    headers: { "content-length": String(1024 * 1024 + 1) },
    text: "oversized",
  };
};
await assert.rejects(
  fetchWebPage(fetchConfig, "https://docs.example.com/guide?q=1"),
  /1 MiB safety limit/,
);

const directFetchRequestsBefore = secureFetchRequests;
await assert.rejects(
  fetchWebPage(
    {
      ...fetchConfig,
      provider: "tavily",
    },
    "https://docs.example.com/guide?q=1",
  ),
  /cannot validate every redirect hop and final URL/,
);
assert.equal(
  secureFetchRequests,
  directFetchRequestsBefore,
  "direct requestUrl fetching must fail closed before network I/O",
);

const provenancePlugin = new AiReadingCompanionPlugin();
provenancePlugin.getWebSearchProvider = () => "kimi";
provenancePlugin.searchWebWithConfiguredProfiles = async () => ({
  content: "Registered search result",
  sources: [
    {
      title: "Registered",
      url: "https://docs.example.com/registered",
      snippet: "",
      siteName: "docs.example.com",
      date: "",
    },
  ],
});
provenancePlugin.makeWebSearchRuntimeConfig = () => ({
  ...fetchConfig,
  allowedFetchUrls: undefined,
});
const [provenanceSearchTool, provenanceFetchTool] =
  provenancePlugin.createWebAgentTools(
    "https://api.kimi.com/coding/v1",
    {},
    "",
  );
requestHandler = async () => ({
  status: 200,
  headers: { "content-type": "text/markdown" },
  text: "# Registered page",
});
await assert.rejects(
  provenanceFetchTool.execute(
    { url: "https://docs.example.com/registered" },
    { toolCallId: "fetch-before-search" },
  ),
  /returned by web search/,
);
await provenanceSearchTool.execute(
  { query: "registered source" },
  { toolCallId: "search-register" },
);
await assert.rejects(
  provenanceFetchTool.execute(
    { url: "https://docs.example.com/unregistered" },
    { toolCallId: "fetch-unregistered" },
  ),
  /exact URL returned by web search/,
);
const registeredFetch = await provenanceFetchTool.execute(
  { url: "https://docs.example.com/registered" },
  { toolCallId: "fetch-registered" },
);
assert.match(registeredFetch.content, /Registered page/);

const independentSearchPlugin = new AiReadingCompanionPlugin();
independentSearchPlugin.getWebSearchProvider = () => "tavily";
const independentTools = independentSearchPlugin.createWebAgentTools(
  "https://model.example.com/v1",
  {},
  "",
);
assert.equal(independentTools.length, 1);
assert.equal(independentTools[0].definition.function.name, "WebSearch");

const externalPrompt = buildExternalAiPrompt({
  provider: "chatgpt",
  question: "How does a tool remain available after context compaction?",
  questionPath: ["What is a tool?", "How is it loaded?"],
  contextItems: [
    {
      id: "source-1",
      kind: "source_excerpt",
      relation: "support",
      text: "A tool definition is supplied with the model request.",
      sourceFile: "Agent/book.md",
    },
    {
      id: "answer-1",
      kind: "assistant_excerpt",
      relation: "origin",
      text: "The previous assistant claimed that the definition is always resident.",
      messageId: 4,
    },
    {
      id: "answer-duplicate",
      kind: "assistant_excerpt",
      relation: "support",
      text: "The previous assistant claimed that the definition is always resident.",
      messageId: 4,
    },
  ],
  learningPreferences: "Use concrete examples.",
  requestWebSearch: true,
});
assert.match(externalPrompt, /# Current question/);
assert.match(externalPrompt, /## S1/);
assert.match(externalPrompt, /## A1/);
assert.doesNotMatch(externalPrompt, /## A2/);
assert.match(externalPrompt, /unverified previous AI explanations/);
assert.match(externalPrompt, /Use web search/);
assert.equal(typeof buildResponsesRequestBody, "function");
assert.equal(typeof extractResponsesAssistantMessage, "function");
assert.equal(typeof determineQuestionToolNeeds, "function");
assert.equal(typeof extractModelUsage, "function");
assert.equal(makeResponsesUrl("https://example.com/v1/chat/completions"), "https://example.com/v1/responses");
assert.equal(
  questionLooksComplex(
    "请分别处理三个可以独立研究的问题，并在最后合并结论。第一，解释不同类型的工具在整个 Agent 中的调用位置、权限边界和完整使用流程是什么？第二，说明 Codex 和 Claude Code 的 ask user questions 是普通工具、控制工具还是交互协议，它们分别如何暂停并恢复执行？第三，解释 plan 工具怎样更新任务状态、怎样影响后续决策，以及它与模型推理和运行时控制之间是什么关系？",
  ),
  true,
);
assert.deepEqual(determineQuestionToolNeeds("请在当前文件夹的笔记里检索相关讨论"), {
  localKnowledge: true,
  webSearch: false,
});
assert.deepEqual(determineQuestionToolNeeds("这个和我之前讨论的 Memory 生成有什么关系？"), {
  localKnowledge: true,
  webSearch: false,
});
assert.deepEqual(determineQuestionToolNeeds("请查找最新的官方文档和来源链接"), {
  localKnowledge: false,
  webSearch: true,
});
assert.deepEqual(determineQuestionToolNeeds("请解释所选原文中的这个概念"), {
  localKnowledge: false,
  webSearch: false,
});
assert.deepEqual(
  extractModelUsage({
    usage: {
      input_tokens: 1200,
      output_tokens: 300,
      total_tokens: 1500,
      input_tokens_details: { cached_tokens: 800 },
      output_tokens_details: { reasoning_tokens: 120 },
    },
  }),
  {
    inputTokens: 1200,
    cachedInputTokens: 800,
    outputTokens: 300,
    reasoningTokens: 120,
    totalTokens: 1500,
  },
);
assert.equal(shouldPlanComplexQuestion("A short question?", "auto"), false);
assert.deepEqual(
  parseComplexQuestionPlan(
    '```json\n{"should_decompose":true,"rationale":"three concerns","subquestions":["工具在哪里调用？","ask user 如何工作？","plan 如何工作？","多余问题"]}\n```',
  ).subquestions,
  ["工具在哪里调用？", "ask user 如何工作？", "plan 如何工作？"],
);

const mobileRunPlan = createAgentRunPlan({
  mobile: true,
  apiProtocol: "responses",
  webSearchRoute: "hosted",
  knowledgeScopePath: "Knowledge/AI",
  toolGrants: [],
});
assert.equal(mobileRunPlan.device, "mobile");
assert.equal(mobileRunPlan.images.maxCount, 4);
assert.equal(Object.isFrozen(mobileRunPlan), true);
assert.equal(Object.isFrozen(mobileRunPlan.context), true);

const branchedConversation = [
  { id: 1, role: "user", content: "Root question", parentAssistantMessageId: null },
  { id: 2, role: "assistant", content: "Root answer", parentQuestionMessageId: 1 },
  { id: 3, role: "user", content: "Branch A question", parentAssistantMessageId: 2 },
  { id: 4, role: "assistant", content: "Branch A answer", parentQuestionMessageId: 3 },
  { id: 5, role: "user", content: "Branch B question", parentAssistantMessageId: 2 },
  { id: 6, role: "assistant", content: "Branch B answer", parentQuestionMessageId: 5 },
  { id: 7, role: "user", content: "Branch A follow-up", parentAssistantMessageId: 4 },
];
assert.deepEqual(
  selectConversationBranch(branchedConversation, 7).map((message) => message.id),
  [1, 2, 3, 4, 7],
  "only ancestors of the selected branch endpoint should enter model context",
);
assert.deepEqual(
  selectConversationBranch(branchedConversation, 6).map((message) => message.id),
  [1, 2, 5, 6],
  "an assistant endpoint should retain its own question and ancestors",
);
assert.deepEqual(selectConversationBranch(branchedConversation, 999), []);
assert.deepEqual(
  selectConversationBranch(
    [
      { id: 1, role: "user", content: "cycle", parentAssistantMessageId: 2 },
      { id: 2, role: "assistant", content: "cycle", parentQuestionMessageId: 1 },
    ],
    2,
  ).map((message) => message.id),
  [1, 2],
  "malformed relationship cycles must terminate deterministically",
);

const conversationGraph = new ConversationGraph(branchedConversation, 7);
assert.deepEqual(
  conversationGraph.childrenOf(2).map((message) => message.id),
  [3, 5],
  "the graph should expose sibling questions without flattening their branches",
);
assert.deepEqual(
  conversationGraph.questionPath().map((message) => message.id),
  [1, 3, 7],
  "the active endpoint should resolve to a stable ancestor question path",
);
assert.equal(conversationGraph.parentOf(7).id, 4);
const fallbackGraph = new ConversationGraph(branchedConversation, "missing");
assert.equal(fallbackGraph.activeEndpointMessageId, 7);
assert.ok(
  fallbackGraph.issues.some((issue) => issue.code === "invalid_active_endpoint"),
);

const stableQuestionId = createStableConversationId(
  "question",
  "session A",
  "local/1",
);
assert.equal(
  stableQuestionId,
  createStableConversationId("question", "session A", "local/1"),
);
assert.notEqual(
  stableQuestionId,
  createStableConversationId("question", "session B", "local/1"),
);

const legacyConversationInput = {
  context: {
    sourceFile: "Reading/legacy.md",
    heading: "Legacy heading",
    excerpt: "Legacy source",
  },
  createdAt: 100,
  messages: [
    { role: "user", content: "Legacy question" },
    { role: "assistant", content: "Legacy answer" },
  ],
  pendingQuestions: [
    {
      id: "pending-legacy",
      text: "Follow-up",
      status: "asked",
      sourceExcerpt: "Legacy answer",
      sourceMessageId: "legacy-answer",
      questionMessageId: "legacy-question",
      answerMessageId: "legacy-answer",
      sourceStart: 3,
      sourceEnd: 9,
      contextItems: [
        {
          id: "context-legacy",
          kind: "assistant_excerpt",
          relation: "origin",
          text: "Legacy answer",
        },
      ],
    },
  ],
  excerptRecords: [
    {
      id: "excerpt-legacy",
      text: "Keep this",
      sourceMessageId: "legacy-answer",
      sourceQuestionMessageId: "legacy-question",
      linkedQuestionKey: "pending:pending-legacy",
    },
  ],
  excerptDraft: "Editable legacy draft",
};
const legacyConversationSnapshot = JSON.stringify(legacyConversationInput);
const migratedConversation = migrateLegacyConversationSession(
  legacyConversationInput,
  "import-1",
);
assert.equal(JSON.stringify(legacyConversationInput), legacyConversationSnapshot);
assert.match(String(migratedConversation.session.id), /^arc:session:/);
assert.match(String(migratedConversation.session.messages[0].id), /^arc:message:/);
assert.equal(
  migratedConversation.session.messages[1].parentQuestionMessageId,
  migratedConversation.session.messages[0].id,
);
assert.equal(migratedConversation.session.context.sourceHeading, "Legacy heading");
assert.equal(
  migratedConversation.session.pendingQuestions[0].questionMessageId,
  "legacy-question",
);
assert.equal(
  migratedConversation.session.pendingQuestions[0].contextItems[0].kind,
  "assistant_excerpt",
);
assert.equal(
  migratedConversation.session.excerptRecords[0].linkedQuestionKey,
  "pending:pending-legacy",
);
assert.equal(migratedConversation.session.excerptDraft, "Editable legacy draft");
assert.ok(migratedConversation.migrated);
assert.equal(migratedConversation.valid, true);
assert.ok(
  migratedConversation.issues.some(
    (issue) => issue.code === "inferred_parent_relationship",
  ),
);
const canonicalConversation = migrateLegacyConversationSession(
  migratedConversation.session,
);
assert.equal(canonicalConversation.migrated, false);
assert.equal(canonicalConversation.valid, true);

const invalidConversationIssues = validateConversationSession({
  id: "invalid-session",
  context: { sourceFile: "Reading/invalid.md", excerpt: "" },
  createdAt: 1,
  updatedAt: 1,
  messages: [
    { id: "duplicate", role: "user", content: "Q" },
    { id: "duplicate", role: "assistant", content: "A" },
    {
      id: "dangling",
      role: "user",
      content: "Q2",
      parentAssistantMessageId: "missing-answer",
    },
  ],
  pendingQuestions: [],
  excerptRecords: [],
  excerptDraft: "",
  activePathMessageId: "missing-endpoint",
});
assert.ok(
  invalidConversationIssues.some((issue) => issue.code === "duplicate_message_id"),
);
assert.ok(
  invalidConversationIssues.some((issue) => issue.code === "dangling_parent"),
);
assert.ok(
  invalidConversationIssues.some((issue) => issue.code === "invalid_active_endpoint"),
);

const builtContext = new ContextBuilder().build({
  runId: "context-test",
  budgets: {
    totalCharacters: 2400,
    systemCharacters: 300,
    passageCharacters: 500,
    conversationCharacters: 1000,
    localEvidenceCharacters: 300,
    webEvidenceCharacters: 300,
    compactionCharacters: 300,
  },
  systemPrompt: "Answer carefully.",
  selectedPassage: "P".repeat(900),
  conversation: [
    { role: "user", content: `Old question ${"q".repeat(500)}` },
    { role: "assistant", content: `Old answer ${"a".repeat(700)}` },
    { role: "user", content: "Latest question" },
  ],
  localEvidence: "Local evidence",
  webEvidence: "Web evidence",
  knowledgeScopePath: "Knowledge/AI",
  webSearchRoute: "hosted",
});
assert.equal(builtContext.receipt.runId, "context-test");
assert.ok(builtContext.receipt.totalCharacters <= 2400);
assert.equal(
  builtContext.receipt.sections.find(
    (section) => section.kind === "selected_passage",
  ).truncated,
  true,
);
assert.ok(
  builtContext.messages.some(
    (message) =>
      message.role === "user" && String(message.content).includes("Latest question"),
  ),
);
const evidencePriorityContext = new ContextBuilder().build({
  runId: "context-evidence-priority",
  budgets: {
    totalCharacters: 1000,
    systemCharacters: 100,
    passageCharacters: 200,
    conversationCharacters: 200,
    questionHistoryCharacters: 500,
    confirmedMemoryCharacters: 100,
    localEvidenceCharacters: 350,
    webEvidenceCharacters: 150,
    compactionCharacters: 50,
  },
  systemPrompt: "System",
  selectedPassage: "Selected passage",
  conversation: [{ role: "user", content: "Current question" }],
  questionHistory: "H".repeat(500),
  confirmedMemory: "Preference",
  localEvidence: "L".repeat(350),
  webEvidence: "W".repeat(150),
  webSearchRoute: "independent",
});
assert.equal(
  evidencePriorityContext.receipt.sections.find(
    (section) => section.kind === "local_evidence",
  ).includedCharacters,
  350,
  "factual local evidence must receive its budget before historical continuity cues",
);
assert.ok(
  evidencePriorityContext.receipt.sections.find(
    (section) => section.kind === "question_history",
  ).includedCharacters < 500,
  "historical questions should yield first when the global context budget is exhausted",
);

const useCaseModelRequests = [];
const askQuestionUseCase = new AskQuestionUseCase({
  modelTransport: {
    send: async (options) => {
      useCaseModelRequests.push(options);
      return {
        assistantMessage: {
          role: "assistant",
          content: "A platform-independent answer.",
        },
        sources: [{ title: "Source", url: "https://example.com/source" }],
        usage: {
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 30,
          reasoningTokens: 0,
          totalTokens: 150,
        },
        hostedToolCalls: [],
        status: 200,
      };
    },
  },
});
const useCaseAnswer = await askQuestionUseCase.execute({
  mobile: false,
  apiProtocol: "chat_completions",
  webSearchRoute: "disabled",
  maxAgentToolRounds: 3,
  toolGrants: [],
  runtimeTools: [],
  model: {
    baseUrl: "https://example.com/v1",
    model: "test-model",
    headers: { Authorization: "Bearer test" },
    maxOutputTokens: 1024,
  },
  context: {
    systemPrompt: "Explain clearly.",
    selectedPassage: "Selected source passage.",
    conversationOrQuestion: "What does this mean?",
    confirmedMemory: "Prefer examples.",
  },
  complexQuestionMode: "off",
  dedupeSources: (sources) => sources.slice(0, 1),
});
assert.equal(useCaseAnswer.content, "A platform-independent answer.");
assert.equal(useCaseAnswer.runPlan.maxToolRounds, 0);
assert.equal(useCaseAnswer.contextReceipt.imageCount, 0);
assert.equal(useCaseAnswer.runtimeMetrics.providerUsage.totalTokens, 150);
assert.equal(useCaseModelRequests.length, 1);
assert.ok(
  useCaseModelRequests[0].messages.some(
    (message) =>
      message.role === "system" &&
      String(message.content).includes("Selected source passage"),
  ),
);
assert.equal(classifyModelTransportError(401, "bad key").kind, "authentication");
assert.equal(classifyModelTransportError(429, "rate limit").retryable, true);
assert.equal(classifyModelTransportError(400, "bad request").retryable, false);

const storedFiles = new Map();
let pluginDataDocument = { uiLanguage: "en" };
const pluginDataStore = new PluginDataStore({
  loadData: async () => pluginDataDocument,
  saveData: async (data) => {
    await Promise.resolve();
    pluginDataDocument = data;
  },
});
const pluginSectionAdapter = pluginDataStore.createSectionAdapter();
await Promise.all([
  pluginDataStore.saveSettings({ uiLanguage: "zh-CN", model: "test" }),
  pluginSectionAdapter.write("sessions", JSON.stringify({ version: 1, sessions: [1] })),
  pluginSectionAdapter.write("runMetrics", JSON.stringify({ version: 1, metrics: [2] })),
]);
assert.equal((await pluginDataStore.loadSettings()).uiLanguage, "zh-CN");
assert.deepEqual(JSON.parse(await pluginSectionAdapter.read("sessions")).sessions, [1]);
assert.deepEqual(JSON.parse(await pluginSectionAdapter.read("runMetrics")).metrics, [2]);
await pluginDataStore.saveSettings({ uiLanguage: "en", model: "updated" });
assert.deepEqual(JSON.parse(await pluginSectionAdapter.read("sessions")).sessions, [1]);

const boundedStore = new BoundedSessionStore({
  adapter: {
    exists: async (path) => storedFiles.has(path),
    read: async (path) => storedFiles.get(path),
    write: async (path, value) => storedFiles.set(path, value),
    remove: async (path) => storedFiles.delete(path),
  },
  path: "plugin/sessions.json",
  maxSessions: 2,
  maxBytes: 20_000,
  maxAgeMs: 60_000,
});
const now = Date.now();
const boundedSaveResult = await boundedStore.save([
  {
    id: 1,
    createdAt: now - 3,
    updatedAt: now - 3,
    pendingQuestions: [{ id: 1, text: "First?", status: "pending", createdAt: now }],
  },
  { id: 2, createdAt: now - 2, updatedAt: now - 2 },
  {
    id: 3,
    createdAt: now - 1,
    updatedAt: now - 1,
    excerptDraft: "Unsaved excerpt draft restored after reload",
    excerptCount: 1,
    excerptRecords: [
      {
        id: "excerpt-1",
        text: "A retained answer fragment",
        sourceMessageId: 5,
        sourceQuestionMessageId: 4,
        linkedQuestionKey: "message:4",
      },
    ],
    pendingQuestions: [
      {
        id: "draft-1",
        text: "",
        status: "pending",
        isDraft: true,
        sourceExcerpt: "A retained answer fragment",
        sourceMessageId: 5,
      },
    ],
  },
]);
const keptSessions = boundedSaveResult.sessions;
assert.deepEqual(keptSessions.map((session) => session.id), [3, 2]);
assert.equal(boundedSaveResult.report.status, "ok");
assert.deepEqual((await boundedStore.load()).map((session) => session.id), [3, 2]);
assert.equal(
  (await boundedStore.load())[0].excerptDraft,
  "Unsaved excerpt draft restored after reload",
);
assert.equal((await boundedStore.load())[0].excerptRecords[0].linkedQuestionKey, "message:4");
assert.equal((await boundedStore.load())[0].pendingQuestions[0].isDraft, true);

const compactedFiles = new Map();
const compactedStore = new BoundedSessionStore({
  adapter: {
    exists: async (path) => compactedFiles.has(path),
    read: async (path) => compactedFiles.get(path),
    write: async (path, value) => compactedFiles.set(path, value),
  },
  path: "plugin/compacted-sessions.json",
  maxSessions: 3,
  maxBytes: 16_384,
  maxAgeMs: 60_000,
});
const retainedDraft = "User-reviewed excerpt draft ".repeat(80);
const retainedPendingQuestion = "How does the retained branch continue?";
const compactedSaveResult = await compactedStore.save(
  [
    {
      id: "older-session",
      createdAt: now - 2,
      updatedAt: now - 2,
      messages: [
        {
          id: "old-answer",
          role: "assistant",
          content: "Disposable older history ".repeat(1_200),
          createdAt: now - 2,
        },
      ],
    },
    {
      id: "active-session",
      createdAt: now - 1,
      updatedAt: now - 10,
      context: {
        sourceFile: "Learning/active.md",
        heading: "Active source",
        startLine: 8,
        endLine: 12,
        excerpt: "Large selected source passage ".repeat(900),
      },
      activePathMessageId: "answer-2",
      excerptDraft: retainedDraft,
      pendingQuestions: [
        {
          id: "pending-1",
          text: retainedPendingQuestion,
          status: "pending",
          sourceMessageId: "answer-2",
          createdAt: now,
        },
      ],
      messages: [
        {
          id: "question-1",
          role: "user",
          content: "Root question ".repeat(600),
          createdAt: now - 5,
          parentAssistantMessageId: null,
        },
        {
          id: "answer-1",
          role: "assistant",
          content: "Root answer ".repeat(1_000),
          createdAt: now - 4,
          parentQuestionMessageId: "question-1",
          reasoning_content: "Rebuildable reasoning ".repeat(800),
          runtimeMetrics: { rounds: 4, diagnostic: "x".repeat(8_000) },
        },
        {
          id: "question-2",
          role: "user",
          content: "Child question ".repeat(600),
          createdAt: now - 3,
          parentAssistantMessageId: "answer-1",
        },
        {
          id: "answer-2",
          role: "assistant",
          content: "Current answer ".repeat(1_000),
          createdAt: now - 2,
          parentQuestionMessageId: "question-2",
          contextReceipt: { sections: [{ content: "x".repeat(9_000) }] },
        },
      ],
    },
  ],
  { activeSessionId: "active-session" },
);
assert.equal(compactedSaveResult.sessions[0].id, "active-session");
assert.equal(compactedSaveResult.report.status, "degraded");
assert.equal(compactedSaveResult.report.protectedSessionId, "active-session");
assert.ok(compactedSaveResult.report.shortenedMessages > 0);
assert.ok(compactedSaveResult.report.reasons.includes("messages_shortened"));
assert.equal(
  JSON.parse(compactedFiles.get("plugin/compacted-sessions.json")).degradation.status,
  "degraded",
);
const restoredCompactedSession = (await compactedStore.load())[0];
assert.equal(restoredCompactedSession.id, "active-session");
assert.equal(restoredCompactedSession.excerptDraft, retainedDraft);
assert.equal(
  restoredCompactedSession.pendingQuestions[0].text,
  retainedPendingQuestion,
);
assert.equal(restoredCompactedSession.activePathMessageId, "answer-2");
assert.equal(
  restoredCompactedSession.messages.find((message) => message.id === "answer-2")
    .parentQuestionMessageId,
  "question-2",
);
assert.ok(
  restoredCompactedSession.messages.some((message) =>
    String(message.content).includes("Older message shortened"),
  ),
);

const essentialFiles = new Map();
const essentialStore = new BoundedSessionStore({
  adapter: {
    exists: async (path) => essentialFiles.has(path),
    read: async (path) => essentialFiles.get(path),
    write: async (path, value) => essentialFiles.set(path, value),
  },
  path: "plugin/essential-overflow.json",
  maxBytes: 16_384,
});
const essentialDraft = "Confirmed user draft ".repeat(1_200);
const essentialSaveResult = await essentialStore.save(
  [
    {
      id: "only-active-session",
      createdAt: now,
      updatedAt: now,
      excerptDraft: essentialDraft,
      pendingQuestions: [
        { id: "q", text: "Keep this question", status: "pending", createdAt: now },
      ],
      messages: [],
    },
  ],
  { activeSessionId: "only-active-session" },
);
assert.equal(essentialSaveResult.sessions.length, 1);
assert.equal(essentialSaveResult.report.exceedsLimit, true);
assert.ok(
  essentialSaveResult.report.reasons.includes("essential_data_exceeds_limit"),
);
assert.equal(
  JSON.parse(essentialFiles.get("plugin/essential-overflow.json")).sessions.length,
  1,
);
assert.equal((await essentialStore.load())[0].excerptDraft, essentialDraft);

const legacyFiles = new Map([
  [
    "plugin/legacy-sessions.json",
    JSON.stringify({
      version: 1,
      updatedAt: now,
      sessions: [
        {
          id: "legacy-session",
          createdAt: now,
          updatedAt: now,
          excerptDraft: "Legacy draft",
          pendingQuestionsExpanded: true,
          currentPathExpanded: false,
          futureUiExtension: { retained: true },
          pendingQuestions: [
            { id: "legacy-q", text: "Legacy question", status: "pending" },
          ],
        },
      ],
    }),
  ],
]);
const legacyStore = new BoundedSessionStore({
  adapter: {
    exists: async (path) => legacyFiles.has(path),
    read: async (path) => legacyFiles.get(path),
    write: async (path, value) => legacyFiles.set(path, value),
  },
  path: "plugin/legacy-sessions.json",
});
const restoredLegacySessions = await legacyStore.load();
assert.equal(restoredLegacySessions[0].excerptDraft, "Legacy draft");
assert.equal(restoredLegacySessions[0].pendingQuestions[0].text, "Legacy question");
assert.equal(restoredLegacySessions[0].pendingQuestionsExpanded, true);
assert.equal(restoredLegacySessions[0].currentPathExpanded, false);
assert.deepEqual(restoredLegacySessions[0].futureUiExtension, { retained: true });
await legacyStore.save(restoredLegacySessions, { activeSessionId: "legacy-session" });
const resavedLegacySession = (await legacyStore.load())[0];
assert.equal(resavedLegacySession.pendingQuestionsExpanded, true);
assert.equal(resavedLegacySession.currentPathExpanded, false);
assert.deepEqual(resavedLegacySession.futureUiExtension, { retained: true });
const linkedQuestionRecord = buildQuestionRecords({
  id: "session-a",
  createdAt: now,
  pendingQuestions: [
    {
      id: "q1",
      text: "How?",
      status: "resolved",
      sourceExcerpt: "A quote",
      sourceMessageId: 3,
      parentQuestionMessageId: 2,
      sourceStart: 12,
      sourceEnd: 20,
      isDraft: false,
      contextItems: [
        {
          id: "answer-context",
          kind: "assistant_excerpt",
          relation: "origin",
          text: "A quote",
        },
      ],
      questionMessageId: 4,
      answerMessageId: 5,
    },
  ],
})[0];
assert.equal(linkedQuestionRecord.sourceExcerpt, "A quote");
assert.equal(linkedQuestionRecord.sourceMessageId, 3);
assert.equal(linkedQuestionRecord.parentQuestionMessageId, 2);
assert.equal(linkedQuestionRecord.sourceStart, 12);
assert.equal(linkedQuestionRecord.sourceEnd, 20);
assert.notEqual(linkedQuestionRecord.isDraft, true);
assert.equal(linkedQuestionRecord.contextItems[0].kind, "assistant_excerpt");
assert.equal(linkedQuestionRecord.questionMessageId, 4);
assert.equal(linkedQuestionRecord.answerMessageId, 5);
assert.equal(
  classifyKnowledgeIdentity(
    { path: "Clips/article.md" },
    { frontmatter: { arc_type: "external_material", source_url: "https://example.com" } },
  ).identity,
  "external_material",
);
assert.equal(
  classifyKnowledgeIdentity(
    { path: "Knowledge/mine.md" },
    { frontmatter: { arc_type: "personal_knowledge" } },
  ).epistemicStatus,
  "confirmed_by_user",
);
assert.equal(
  classifyKnowledgeIdentity({ path: "Unknown/note.md" }, null).identity,
  "unknown",
);

const questionHistory = searchHistoricalQuestions(
  [
    {
      id: "old-session",
      createdAt: now - 100,
      context: { sourceFile: "Knowledge/AI/memory.md" },
      messages: [
        { id: 1, role: "user", content: "How does memory update?", createdAt: now - 90 },
        { id: 2, role: "assistant", content: "This old answer must not be returned." },
      ],
    },
  ],
  "memory update",
  { scopePath: "Knowledge/AI" },
);
assert.equal(questionHistory.length, 1);
assert.match(questionHistory[0].text, /memory update/i);
assert.doesNotMatch(JSON.stringify(questionHistory), /old answer/i);

assert.match(
  detectLearningPreferenceSignal("我更容易通过具体例子和流程来理解概念。"),
  /具体例子/,
);
assert.equal(detectLearningPreferenceSignal("Memory 的更新是什么？"), "");
const memoryFiles = new Map();
const memoryAdapter = {
  exists: async (path) => memoryFiles.has(path),
  read: async (path) => memoryFiles.get(path),
  write: async (path, value) => memoryFiles.set(path, value),
};
const learningMemoryStore = new LearningMemoryStore({
  adapter: memoryAdapter,
  path: "plugin/learning-memory.json",
});
for (const sessionId of ["s1", "s2", "s3"]) {
  await learningMemoryStore.observe(
    "我更容易通过具体例子和流程来理解概念。",
    { sessionId, sourceFile: "Knowledge/AI/memory.md" },
  );
}
const readyMemory = (await learningMemoryStore.load())[0];
assert.equal(readyMemory.status, "ready_for_review");
assert.equal(await learningMemoryStore.getConfirmedPrompt(), "");
await learningMemoryStore.setStatus(readyMemory.id, "confirmed");
assert.match(await learningMemoryStore.getConfirmedPrompt(), /具体例子/);
const rejectedMemoryStore = new LearningMemoryStore({
  adapter: memoryAdapter,
  path: "plugin/rejected-learning-memory.json",
});
const rejectedCandidate = await rejectedMemoryStore.observe(
  "我更容易通过具体案例来理解复杂概念。",
  { sessionId: "reject-1" },
);
await rejectedMemoryStore.setStatus(rejectedCandidate.id, "rejected");
const suppressedCandidate = await rejectedMemoryStore.observe(
  "我更容易通过具体案例来理解复杂概念。",
  { sessionId: "reject-2" },
);
assert.equal(suppressedCandidate.status, "rejected");
assert.equal((await rejectedMemoryStore.load()).length, 1);

const metricsStore = new RunMetricsStore({
  adapter: memoryAdapter,
  path: "plugin/run-metrics.json",
});
await metricsStore.append({
  id: "run-1",
  startedAt: now,
  durationMs: 1200,
  outcome: "completed",
  errorKind: "",
  protocol: "responses",
  device: "desktop",
  webSearchRoute: "hosted",
  estimatedInputTokens: 1200,
  contextCharacters: 4800,
  contextBudgetCharacters: 70000,
  trimmedSections: 1,
  imageCount: 0,
  localSourceCount: 2,
  webSourceCount: 1,
  modelRounds: 1,
  providerInputTokens: 1000,
  providerCachedInputTokens: 600,
  providerOutputTokens: 200,
  providerReasoningTokens: 80,
  providerTotalTokens: 1200,
  hostedToolCalls: 1,
  toolCalls: 0,
  toolAttempts: 3,
  toolSuccesses: 2,
  toolBudgetDenials: 1,
  toolCacheHits: 0,
  toolDiagnostics: [
    {
      toolName: "ReadKnowledgePassages",
      attempts: 3,
      successes: 2,
      budgetDenials: 1,
      cacheHits: 0,
    },
  ],
});
const metricSummary = await metricsStore.summarize();
assert.equal(metricSummary.count, 1);
assert.equal(metricSummary.completed, 1);
assert.equal(metricSummary.trimmingRate, 1);
assert.equal(metricSummary.toolAttempts, 3);
assert.equal(metricSummary.toolBudgetDenials, 1);
assert.equal(metricSummary.providerUsageRuns, 1);
assert.equal(metricSummary.providerTotalTokens, 1200);
assert.equal(metricSummary.providerCachedInputTokens, 600);

const runEvents = [];
const runController = new RunController();
const pendingRun = runController.start(
  async () => new Promise(() => {}),
  {
    observers: [{ onEvent: (event) => runEvents.push(event.stage) }],
  },
);
pendingRun.cancel("user");
await assert.rejects(
  pendingRun.result,
  (error) => error instanceof RunCancelledError && error.reason === "user",
);
assert.deepEqual(runEvents, ["created", "cancel_requested", "cancelled"]);
assert.equal(runController.isActive(pendingRun.runId), false);

const guardedToolCalls = [];
const guardedGateway = new ToolGateway({
  tools: [
    {
      definition: {
        type: "function",
        function: { name: "Guarded", parameters: { type: "object" } },
      },
      execute: async (arguments_) => {
        guardedToolCalls.push(arguments_);
        return { content: "Allowed once" };
      },
    },
  ],
  grants: [
    {
      id: "guarded-grant",
      toolName: "Guarded",
      maxCalls: 1,
      maxResultCharacters: 100,
    },
  ],
});
const guardedTool = guardedGateway.asRuntimeTools()[0];
assert.equal(
  (await guardedTool.execute({ value: 1 }, { toolCallId: "g1", round: 0 }))
    .content,
  "Allowed once",
);
await assert.rejects(
  guardedTool.execute({ value: 2 }, { toolCallId: "g2", round: 1 }),
  /call budget/,
);
assert.equal(guardedToolCalls.length, 1);
const cacheGateway = new ToolGateway({
  tools: [
    {
      definition: {
        type: "function",
        function: { name: "Cached", parameters: { type: "object" } },
      },
      execute: async () => ({ content: "shared evidence" }),
    },
  ],
  grants: [
    {
      id: "cache-grant",
      toolName: "Cached",
      maxCalls: 1,
      maxResultCharacters: 100,
    },
  ],
});
const cachedTool = cacheGateway.asRuntimeTools()[0];
assert.equal(
  (await cachedTool.execute({ b: 2, a: 1 }, { toolCallId: "c1", round: 0 }))
    .content,
  "shared evidence",
);
assert.match(
  (await cachedTool.execute({ a: 1, b: 2 }, { toolCallId: "c2", round: 1 }))
    .content,
  /already completed/i,
);
assert.deepEqual(cacheGateway.getDiagnostics(), {
  attempts: 2,
  successes: 1,
  budgetDenials: 0,
  cacheHits: 1,
  resultCharacters: 15,
  resultBudgetCharacters: 0,
  resultBudgetDenials: 0,
  resultTruncations: 0,
  tools: [
    {
      toolName: "Cached",
      attempts: 2,
      successes: 1,
      budgetDenials: 0,
      cacheHits: 1,
      resultCharacters: 15,
      resultTruncations: 0,
    },
  ],
});
const deniedGateway = new ToolGateway({
  tools: [
    {
      definition: {
        type: "function",
        function: { name: "Denied", parameters: { type: "object" } },
      },
      execute: async () => ({ content: "must not execute" }),
    },
  ],
  grants: [],
});
await assert.rejects(
  deniedGateway.asRuntimeTools()[0].execute({}, { toolCallId: "d1", round: 0 }),
  /No permission grant/,
);
const truncatingGateway = new ToolGateway({
  tools: [
    {
      definition: {
        type: "function",
        function: { name: "Bounded", parameters: { type: "object" } },
      },
      execute: async () => ({ content: "x".repeat(200) }),
    },
  ],
  grants: [
    {
      id: "bounded-grant",
      toolName: "Bounded",
      maxCalls: 1,
      maxResultCharacters: 40,
    },
  ],
});
const truncatedToolResult = await truncatingGateway
  .asRuntimeTools()[0]
  .execute({}, { toolCallId: "b1", round: 0 });
assert.match(truncatedToolResult.content, /Tool result truncated/);
assert.ok(truncatedToolResult.content.length < 200);

const sharedBudgetGateway = new ToolGateway({
  tools: [
    {
      definition: {
        type: "function",
        function: { name: "SharedBudget", parameters: { type: "object" } },
      },
      execute: async (arguments_) => ({ content: String(arguments_.value || "") }),
    },
  ],
  grants: [
    {
      id: "shared-budget-grant",
      toolName: "SharedBudget",
      maxCalls: 3,
      maxResultCharacters: 100,
    },
  ],
  maxTotalResultCharacters: 12,
});
const sharedBudgetTool = sharedBudgetGateway.asRuntimeTools()[0];
assert.equal(
  (await sharedBudgetTool.execute(
    { value: "abcdef" },
    { toolCallId: "shared-1", round: 0 },
  )).content,
  "abcdef",
);
const sharedBudgetSecondResult = await sharedBudgetTool.execute(
  { value: "ghijklmnop" },
  { toolCallId: "shared-2", round: 1 },
);
assert.equal(sharedBudgetSecondResult.content.length, 6);
assert.equal(
  sharedBudgetSecondResult.artifacts.sharedEvidenceBudgetTruncated,
  true,
);
assert.equal(sharedBudgetGateway.getDiagnostics().resultCharacters, 12);
assert.equal(sharedBudgetGateway.getDiagnostics().resultTruncations, 1);
assert.equal(sharedBudgetTool.isAvailable?.(), false);
await assert.rejects(
  sharedBudgetTool.execute(
    { value: "new evidence" },
    { toolCallId: "shared-3", round: 2 },
  ),
  /shared tool evidence budget/i,
);
assert.equal(sharedBudgetGateway.getDiagnostics().resultBudgetDenials, 1);

assert.equal(pathIsWithinScope("Knowledge/AI/memory.md", "Knowledge/AI"), true);
assert.equal(pathIsWithinScope("Knowledge/Other.md", "Knowledge/AI"), false);
assert.equal(
  findKnowledgeScopeForFile("Knowledge/AI/Agents/memory.md", [
    "Knowledge",
    "Knowledge/AI",
  ]),
  "Knowledge/AI",
);
assert.equal(
  findKnowledgeScopeForFile("Knowledge/AI/Agents/memory.md", []),
  "Knowledge/AI/Agents",
);
assert.equal(findKnowledgeScopeForFile("root-note.md", []), "");
const localMemoryFile = {
  path: "Knowledge/AI/memory.md",
  basename: "memory",
  stat: { mtime: 10 },
};
const outsideFile = {
  path: "Private/secrets.md",
  basename: "secrets",
  stat: { mtime: 20 },
};
const retriever = new KnowledgeScopeRetriever({
  app: {
    vault: {
      getMarkdownFiles: () => [localMemoryFile, outsideFile],
      cachedRead: async (file) => {
        assert.equal(file, localMemoryFile);
        return "# Memory update\n\nMemory is updated after a confirmed learning event.";
      },
    },
    metadataCache: {
      getFileCache: (file) =>
        file === localMemoryFile
          ? { headings: [{ heading: "Memory update" }] }
          : { headings: [{ heading: "Secret" }] },
    },
  },
  scopePath: "Knowledge/AI",
  currentFilePath: "Knowledge/AI/current.md",
});
const scopeMatches = await retriever.search("How does memory update?");
assert.equal(scopeMatches.length, 1);
assert.equal(scopeMatches[0].path, localMemoryFile.path);
assert.match(
  await retriever.read([scopeMatches[0].sourceRef]),
  /\[\[Knowledge\/AI\/memory\.md#Memory update\|memory › Memory update\]\]/,
);
await assert.rejects(
  retriever.read(["Knowledge/AI/memory.md"]),
  /Unknown or expired local source reference/,
);

const laneFiles = [
  {
    path: "Knowledge/AI/my-memory.md",
    basename: "my-memory",
    stat: { mtime: 1 },
    identity: "personal_knowledge",
  },
  ...Array.from({ length: 7 }, (_, index) => ({
    path: `Knowledge/AI/imported-${index + 1}.md`,
    basename: `memory-update-imported-${index + 1}`,
    stat: { mtime: 10 + index },
    identity: "external_material",
  })),
];
const laneRetriever = new KnowledgeScopeRetriever({
  app: {
    vault: {
      getMarkdownFiles: () => laneFiles,
      cachedRead: async (file) =>
        file.identity === "personal_knowledge"
          ? "My own note mentions memory update once."
          : "Imported memory update memory update memory update.",
    },
    metadataCache: {
      getFileCache: (file) => ({
        frontmatter: { arc_type: file.identity },
        headings: [{ heading: file.basename }],
      }),
    },
  },
  scopePath: "Knowledge/AI",
});
const laneMatches = await laneRetriever.search("memory update", 3);
assert.equal(laneMatches.length, 3);
assert.ok(
  laneMatches.some((match) => match.identity === "personal_knowledge"),
  "personal knowledge must retain a lane when external material scores higher",
);
assert.equal(
  (await laneRetriever.search("memory update")).length,
  6,
  "the default candidate count must fit two reads of three refs each",
);
const cacheBoundFiles = Array.from({ length: 120 }, (_, index) => ({
  path: `Knowledge/Bounded/note-${index}.md`,
  basename: `note-${index}`,
  stat: { mtime: index + 1 },
}));
const cacheBoundApp = {
  vault: {
    getMarkdownFiles: () => cacheBoundFiles,
    cachedRead: async (file) => `${file.basename}\n${"x".repeat(24_000)}`,
  },
  metadataCache: { getFileCache: () => null },
};
const cacheBoundRetriever = new KnowledgeScopeRetriever({
  app: cacheBoundApp,
  scopePath: "Knowledge/Bounded",
});
const firstBoundedIndex = await cacheBoundRetriever.getScopeIndex(cacheBoundFiles);
assert.ok(
  [...firstBoundedIndex.values()].reduce(
    (total, entry) => total + entry.text.length,
    0,
  ) <= 2_000_000,
);
const secondBoundedIndex = await cacheBoundRetriever.getScopeIndex([
  ...cacheBoundFiles,
].reverse());
assert.ok(
  [...secondBoundedIndex.values()].reduce(
    (total, entry) => total + entry.text.length,
    0,
  ) <= 2_000_000,
  "the runtime body index must remain bounded after file ordering changes",
);

const runtimeEvents = [];
let runtimeModelRound = 0;
const genericRuntimeResult = await new AgentRuntime().run({
  messages: [{ role: "user", content: "Use the echo tool." }],
  tools: [
    {
      definition: {
        type: "function",
        function: {
          name: "Echo",
          description: "Echo a value.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
      execute: async (arguments_, context) => ({
        content: `Echo: ${arguments_.value}`,
        artifacts: { callId: context.toolCallId },
      }),
    },
  ],
  maxToolRounds: 2,
  requestAssistant: async (messages, definitions) => {
    runtimeModelRound += 1;
    assert.equal(definitions[0].function.name, "Echo");
    if (runtimeModelRound === 1) {
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "echo-call-1",
            type: "function",
            function: {
              name: "Echo",
              arguments: JSON.stringify({ value: "runtime" }),
            },
          },
        ],
      };
    }
    assert.equal(messages.at(-1).role, "tool");
    assert.equal(messages.at(-1).content, "Echo: runtime");
    return { role: "assistant", content: "Runtime complete." };
  },
  onEvent: (event) => runtimeEvents.push(event.type),
});
assert.equal(genericRuntimeResult.assistantMessage.content, "Runtime complete.");
assert.equal(genericRuntimeResult.toolRecords.length, 1);
assert.equal(
  genericRuntimeResult.toolRecords[0].result.artifacts.callId,
  "echo-call-1",
);
assert.deepEqual(runtimeEvents, [
  "runtime_start",
  "model_response",
  "tool_start",
  "tool_result",
  "model_response",
  "runtime_complete",
]);

let degradedModelRound = 0;
const degradedGateway = new ToolGateway({
  tools: [
    {
      definition: {
        type: "function",
        function: { name: "Limited", parameters: { type: "object" } },
      },
      execute: async (arguments_) => ({ content: `Evidence ${arguments_.value}` }),
    },
  ],
  grants: [
    {
      id: "limited-grant",
      toolName: "Limited",
      maxCalls: 1,
      maxResultCharacters: 100,
    },
  ],
});
const degradedRuntimeResult = await new AgentRuntime().run({
  messages: [{ role: "user", content: "Use limited evidence, then answer." }],
  tools: degradedGateway.asRuntimeTools(),
  maxToolRounds: 3,
  requestAssistant: async (messages, definitions) => {
    degradedModelRound += 1;
    if (degradedModelRound <= 2) {
      return {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: `limited-${degradedModelRound}`,
            type: "function",
            function: {
              name: "Limited",
              arguments: JSON.stringify({ value: degradedModelRound }),
            },
          },
        ],
      };
    }
    assert.equal(definitions.length, 0, "exhausted tools must be withdrawn");
    assert.match(messages.at(-1).content, /unavailable for the remainder/i);
    return { role: "assistant", content: "Completed with existing evidence." };
  },
});
assert.equal(
  degradedRuntimeResult.assistantMessage.content,
  "Completed with existing evidence.",
);
assert.equal(
  degradedGateway.getDiagnostics().budgetDenials,
  0,
  "an exhausted tool should be withdrawn before another budget-denied execution",
);

const plugin = new AiReadingCompanionPlugin();

const testConfigDir = ".test-config";
const legacySessionPath = `${testConfigDir}/plugins/ai-reading-companion/sessions.json`;
const legacyPluginFiles = new Map([
  [
    legacySessionPath,
    JSON.stringify({ version: 1, updatedAt: Date.now(), sessions: [] }),
  ],
]);

plugin.testData = {
  aiBaseUrl: "https://api.kimi.com/coding/",
  aiModel: "k3",
  aiKeySecret: "legacy-kimi-secret-reference",
};
plugin.app = {
  workspace: {
    on: () => ({}),
    getActiveFile: () => ({ path: "Reading/image-note.md" }),
    getLeavesOfType: () => [],
  },
  vault: {
    configDir: testConfigDir,
    adapter: {
      exists: async (path) => legacyPluginFiles.has(path),
      read: async (path) => legacyPluginFiles.get(path),
      remove: async (path) => legacyPluginFiles.delete(path),
    },
  },
  metadataCache: {
    getFirstLinkpathDest: (target) => {
      if (target === "assets/chart.png") {
        return {
          path: "Reading/assets/chart.png",
          name: "chart.png",
          extension: "png",
          stat: { size: 2048 },
        };
      }
      if (target === "images/fig1-3.svg") {
        return {
          path: "Reading/images/fig1-3.svg",
          name: "fig1-3.svg",
          extension: "svg",
          stat: { size: 4096 },
        };
      }
      return null;
    },
  },
};
plugin.manifest = { id: "ai-reading-companion" };
await plugin.onload();
assert.equal(
  legacyPluginFiles.has(legacySessionPath),
  false,
);
assert.equal(plugin.testData.localData.sections.sessions.version, 1);
assert.equal(plugin.settings.aiProvider, "kimi");
assert.equal(plugin.settings.webSearchProvider, "kimi");
assert.equal(plugin.getModelProfiles().length, 1);
const migratedKimiProfile = plugin.getActiveModelProfile();
assert.equal(migratedKimiProfile.provider, "kimi");
assert.equal(migratedKimiProfile.model, "k3");
assert.equal(migratedKimiProfile.apiProtocol, "chat_completions");
assert.equal(migratedKimiProfile.hostedWebSearchType, "");
assert.equal(migratedKimiProfile.webSearchRoute, "independent");
const migratedKimiSearchProfile =
  plugin.getActiveIndependentSearchProfile();
assert.equal(migratedKimiSearchProfile.provider, "kimi");
assert.deepEqual(migratedKimiProfile.independentSearchProfileIds, [
  migratedKimiSearchProfile.id,
]);
assert.equal(
  plugin.isIndependentSearchProfileProtected(migratedKimiSearchProfile),
  true,
);
assert.equal(
  migratedKimiProfile.keySecret,
  "legacy-kimi-secret-reference",
);
const arkProfile = await plugin.addModelProfile({
  name: "Volcengine Ark · DeepSeek V4 Flash",
  provider: "volcengine",
  baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  model: "deepseek-v4-flash-ga-260731",
});
assert.equal(plugin.settings.activeAiModelProfileId, arkProfile.id);
assert.equal(plugin.settings.aiProvider, "volcengine");
assert.equal(plugin.settings.aiKeySecret, "");
assert.equal(arkProfile.apiProtocol, "responses");
assert.equal(arkProfile.hostedWebSearchType, "web_search");
assert.equal(arkProfile.webSearchRoute, "hosted");
assert.equal(
  plugin.getModelProfiles()[0].keySecret,
  "legacy-kimi-secret-reference",
);
await plugin.switchModelProfile(migratedKimiProfile.id);
assert.equal(plugin.settings.aiProvider, "kimi");
assert.equal(plugin.settings.aiKeySecret, "legacy-kimi-secret-reference");
assert.equal(plugin.getWebSearchExecutionMode(), "independent");
await plugin.switchModelProfile(arkProfile.id);
assert.equal(plugin.getWebSearchExecutionMode(), "hosted");
await plugin.switchModelProfile(migratedKimiProfile.id);
assert.equal(plugin.getWebSearchExecutionMode(), "independent");
const duplicatedProfile = await plugin.duplicateActiveModelProfile();
assert.equal(plugin.getModelProfiles().length, 3);
assert.equal(duplicatedProfile.keySecret, "legacy-kimi-secret-reference");
assert.equal(await plugin.deleteActiveModelProfile(), true);
assert.equal(plugin.getModelProfiles().length, 2);
await plugin.switchModelProfile(arkProfile.id);
assert.equal(await plugin.deleteActiveModelProfile(), true);
assert.equal(plugin.getModelProfiles().length, 1);
assert.equal(await plugin.deleteActiveModelProfile(), false);
assert.equal(plugin.settings.aiProvider, "kimi");
const presetSwitchProfile = await plugin.addModelProfile({
  name: "Preset switch test",
});
await plugin.applyProviderPresetToActiveModel("volcengine");
assert.equal(plugin.getActiveModelProfile().id, presetSwitchProfile.id);
assert.equal(plugin.getActiveModelProfile().webSearchRoute, "hosted");
assert.equal(plugin.getActiveModelProfile().hostedWebSearchType, "web_search");
await plugin.applyProviderPresetToActiveModel("kimi");
assert.equal(plugin.getActiveModelProfile().webSearchRoute, "independent");
assert.equal(plugin.getActiveIndependentSearchProfile().provider, "kimi");
await plugin.applyProviderPresetToActiveModel("glm_coding");
assert.equal(plugin.getActiveModelProfile().webSearchRoute, "independent");
assert.equal(plugin.getActiveIndependentSearchProfile().provider, "glm_coding");
assert.equal(
  plugin.getActiveIndependentSearchProfile().endpoint,
  "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
);
assert.equal(plugin.getActiveIndependentSearchProfile().credentialMode, "model");
assert.equal(plugin.getActiveIndependentSearchProfile().mcpToolName, "webSearchPrime");
assert.equal(
  plugin.getActiveIndependentSearchProfile().mcpQueryArgument,
  "search_query",
);
await plugin.applyProviderPresetToActiveModel("kimi");
const protectedKimiSearchProfile =
  plugin.getActiveIndependentSearchProfile();
assert.equal(protectedKimiSearchProfile.provider, "kimi");
assert.equal(
  plugin.isIndependentSearchProfileProtected(protectedKimiSearchProfile),
  true,
);
assert.ok(plugin.getIndependentSearchProfiles().length >= 2);
await plugin.switchEditingIndependentSearchProfile(
  protectedKimiSearchProfile.id,
);
assert.equal(await plugin.deleteEditingIndependentSearchProfile(), false);
const protectedKimiAfterProviderEdit =
  await plugin.saveIndependentSearchProfile({
    ...protectedKimiSearchProfile,
    provider: "tavily",
  });
assert.equal(protectedKimiAfterProviderEdit.provider, "kimi");
await plugin.applyProviderPresetToActiveModel("openai");
assert.equal(plugin.getActiveModelProfile().webSearchRoute, "disabled");
assert.equal(plugin.createIndependentSearchProfile().provider, "tavily");
const portableSearchProfile = await plugin.saveIndependentSearchProfile(
  plugin.createIndependentSearchProfile({
    name: "Portable Tavily",
    provider: "tavily",
    endpoint: "https://api.tavily.com/search",
    credentialMode: "search",
  }),
);
assert.equal(plugin.getActiveModelProfile().webSearchRoute, "disabled");
assert.equal(
  plugin.getActiveModelProfile().independentSearchProfileIds.includes(
    portableSearchProfile.id,
  ),
  false,
);
await plugin.applyProviderPresetToActiveModel("custom");
assert.equal(plugin.getActiveModelProfile().webSearchRoute, "independent");
assert.equal(
  plugin.getActiveModelProfile().independentSearchProfileIds[0],
  portableSearchProfile.id,
);
assert.equal(plugin.getActiveIndependentSearchProfile().provider, "tavily");
assert.equal(await plugin.deleteActiveModelProfile(), true);
assert.equal(plugin.getModelProfiles().length, 1);
assert.equal(plugin.settings.internalLinkOpenMode, "tab");
assert.equal(plugin.settings.uiLanguage, "en");
assert.equal(plugin.t("Model"), "Model");
plugin.settings.uiLanguage = "zh-CN";
assert.equal(plugin.t("Model"), "模型");
assert.equal(
  plugin.t("Default endpoint for {{provider}}. You can override it for a compatible proxy.", {
    provider: "Tavily",
  }),
  "Tavily 的默认地址，也可以改为兼容代理地址。",
);
plugin.settings.uiLanguage = "en";
assert.equal(typeof registeredViewFactory, "function");

obsidianMock.Platform.isMobile = true;
let mobileViewState = null;
let popoutRequested = false;
const mobileLeaf = {
  setViewState: async (state) => {
    mobileViewState = state;
  },
};
plugin.app.workspace = {
  getLeavesOfType: () => [],
  getLeaf: (mode) => {
    assert.equal(mode, "tab");
    return mobileLeaf;
  },
  openPopoutLeaf: () => {
    popoutRequested = true;
  },
};
assert.equal(await plugin.getAiConversationLeaf(), mobileLeaf);
assert.equal(mobileViewState.type, registeredViewType);
assert.equal(popoutRequested, false);
obsidianMock.Platform.isMobile = false;
plugin.app.workspace = {
  on: () => ({}),
  getActiveFile: () => ({ path: "Reading/image-note.md" }),
};

const view = registeredViewFactory({ app: plugin.app });
view.renderActiveSession = () => {};
view.contentEl = {
  win: {
    requestAnimationFrame: (callback) => callback(),
    setTimeout,
  },
};
const imageInfo = { file: { path: "Reading/image-note.md" } };
const imageOnlyEditor = {
  somethingSelected: () => false,
  getSelection: () => "",
  getCursor: () => ({ line: 4, ch: 0 }),
  getLine: (line) =>
    line === 4 ? "![[assets/chart.png]]" : line === 2 ? "## Charts" : "",
};
assert.equal(plugin.canUseSelection(imageOnlyEditor, imageInfo), true);
const imageOnlyContext = plugin.getSelectionContext(imageOnlyEditor, imageInfo);
assert.equal(imageOnlyContext.excerpt, "![[assets/chart.png]]");
assert.equal(imageOnlyContext.images.length, 1);
assert.equal(imageOnlyContext.images[0].explicitlySelected, true);
assert.equal(view.createSession(imageOnlyContext).imageSelections[0].selected, true);

const pathMessages = [
  { id: 101, role: "user", content: "Q1", parentAssistantMessageId: null },
  { id: 102, role: "assistant", content: "A1", parentQuestionMessageId: 101 },
  { id: 103, role: "user", content: "Q2", parentAssistantMessageId: 102 },
  { id: 104, role: "assistant", content: "A2", parentQuestionMessageId: 103 },
  { id: 105, role: "user", content: "Q3", parentAssistantMessageId: 104 },
  { id: 106, role: "assistant", content: "A3", parentQuestionMessageId: 105 },
];
const originalPathTestState = {
  messages: view.messages,
  activePathMessageId: view.activePathMessageId,
  viewedMessageId: view.viewedMessageId,
  updateCurrentPathWorkspace: view.updateCurrentPathWorkspace,
  syncActiveSession: view.syncActiveSession,
  setCompactViewTab: view.setCompactViewTab,
};
view.messages = pathMessages;
view.activePathMessageId = 106;
view.viewedMessageId = 106;
view.updateCurrentPathWorkspace = () => {};
view.syncActiveSession = () => {};
view.setCompactViewTab = () => {};
view.jumpToConversationMessage(101, { preservePath: true });
assert.equal(view.activePathMessageId, 106);
assert.deepEqual(
  view.getCurrentQuestionPath().map((message) => message.content),
  ["Q1", "Q2", "Q3"],
);
view.jumpToConversationMessage(101);
assert.equal(view.activePathMessageId, 106);
assert.equal(view.viewedMessageId, 101);
view.continueFromConversationMessage(101);
assert.equal(view.activePathMessageId, 102);
assert.equal(view.viewedMessageId, 102);
view.messages = originalPathTestState.messages;
view.activePathMessageId = originalPathTestState.activePathMessageId;
view.viewedMessageId = originalPathTestState.viewedMessageId;
view.updateCurrentPathWorkspace = originalPathTestState.updateCurrentPathWorkspace;
view.syncActiveSession = originalPathTestState.syncActiveSession;
view.setCompactViewTab = originalPathTestState.setCompactViewTab;

const imageEmbed = {
  getAttribute: (name) => (name === "src" ? "images/fig1-3.svg" : null),
};
const renderedImage = {
  ownerDocument: {},
  parentElement: imageEmbed,
  getAttribute: (name) =>
    name === "src"
      ? "app://obsidian.md/Reading/images/fig1-3.svg"
      : name === "alt"
        ? "Agent trajectory"
        : null,
  closest: (selector) =>
    selector === "img"
      ? renderedImage
      : selector.includes("markdown-source-view")
      ? {}
      : selector.includes("internal-embed")
        ? imageEmbed
        : null,
};
plugin.captureImageContext({ target: renderedImage });
assert.equal(plugin.lastContextImage.target, "images/fig1-3.svg");
const renderedImageEditor = {
  somethingSelected: () => false,
  getSelection: () => "",
  getCursor: () => ({ line: 8, ch: 0 }),
  getLine: () => "Unrelated paragraph text",
};
assert.equal(plugin.canUseSelection(renderedImageEditor, imageInfo), true);
const renderedImageContext = plugin.getSelectionContext(
  renderedImageEditor,
  imageInfo,
);
assert.equal(renderedImageContext.excerpt, "![[images/fig1-3.svg]]");
assert.equal(renderedImageContext.images[0].extension, "svg");
plugin.lastContextImage = null;

const mixedEditor = {
  somethingSelected: () => true,
  getSelection: () => "Search summary\n\n![[assets/chart.png]]",
  getCursor: (side) =>
    side === "from" ? { line: 2, ch: 0 } : { line: 4, ch: 22 },
  getLine: (line) => (line === 2 ? "## Charts" : ""),
};
const mixedContext = plugin.getSelectionContext(mixedEditor, imageInfo);
assert.match(mixedContext.excerpt, /Search summary/);
assert.equal(mixedContext.images.length, 1);
assert.equal(mixedContext.images[0].explicitlySelected, true);

const selectedAnswerClasses = new Set();
const selectedQuestionClasses = new Set();
const selectedAnswerMessage = {
  id: 9,
  parentQuestionMessageId: 8,
  bodyEl: {},
  selectedText: "",
  selectionAddButton: {
    disabled: true,
    addClass: (name) => selectedAnswerClasses.add(name),
    removeClass: (name) => selectedAnswerClasses.delete(name),
  },
  questionSelectionButton: {
    disabled: true,
    addClass: (name) => selectedQuestionClasses.add(name),
    removeClass: (name) => selectedQuestionClasses.delete(name),
  },
  actionStatusEl: { textContent: "" },
};
let toolbarSelection = null;
view.getSelectionInfoWithin = () => ({
  text: "A focused answer excerpt",
  rect: { left: 20, top: 30, width: 100, height: 20 },
});
view.showSelectionToolbar = (message, rect) => {
  view.selectedMessage = message;
  toolbarSelection = { message, rect };
};
view.captureMessageSelection(selectedAnswerMessage);
assert.equal(selectedAnswerMessage.selectedText, "A focused answer excerpt");
assert.equal(selectedAnswerMessage.selectionAddButton.disabled, false);
assert.equal(selectedAnswerClasses.has("is-ready"), true);
assert.equal(selectedAnswerMessage.questionSelectionButton.disabled, false);
assert.equal(selectedQuestionClasses.has("is-ready"), true);
assert.match(selectedAnswerMessage.actionStatusEl.textContent, /24/);
assert.equal(toolbarSelection.message, selectedAnswerMessage);

await view.startSession({
  excerpt: "First selected passage",
  sourceFile: "Reading/first.md",
  sourceHeading: "First concept",
  images: [],
});
view.messages.push({ role: "assistant", content: "First answer" });
view.addTextToExcerptDraft("First retained excerpt");
view.addTextToExcerptDraft("Second retained excerpt");
view.pendingQuestionInputEl = {
  value: "How does the Harness stop a running tool?",
  focus: () => {},
};
  view.pendingQuestionSource = "Harness controls tool calls and stop boundaries.";
  view.pendingQuestionSourceMessageId = 9;
  view.addPendingQuestion();
assert.equal(view.pendingQuestions.length, 1);
assert.equal(view.pendingQuestions[0].status, "pending");
  assert.equal(
    view.pendingQuestions[0].sourceExcerpt,
    "Harness controls tool calls and stop boundaries.",
  );
  assert.equal(view.pendingQuestions[0].sourceMessageId, 9);
assert.equal(
  view.pendingQuestions[0].contextItems.some(
    (item) => item.kind === "source_excerpt",
  ),
  true,
);
assert.equal(
  view.pendingQuestions[0].contextItems.some(
    (item) => item.kind === "assistant_excerpt",
  ),
  true,
);
view.attachSelectionToPendingQuestion(
  "A second answer fragment linked to the same question.",
  selectedAnswerMessage,
);
assert.equal(
  view.pendingQuestions[0].contextItems.filter(
    (item) => item.kind === "assistant_excerpt",
  ).length,
  2,
);
const pendingQuestionId = view.pendingQuestions[0].id;
view.setPendingQuestionStatus(pendingQuestionId, "parked");
assert.equal(view.pendingQuestions[0].status, "parked");
view.setPendingQuestionStatus(pendingQuestionId, "pending");
assert.equal(view.pendingQuestions[0].status, "pending");
view.hideSelectionToolbar = () => {
  view.selectedMessage = null;
};
selectedAnswerMessage.selectedText = "A focused answer excerpt";
view.addTextToExcerptDraft(
  selectedAnswerMessage.selectedText,
  selectedAnswerMessage,
);
assert.equal(selectedAnswerMessage.selectedText, "");
assert.equal(selectedAnswerMessage.selectionAddButton.disabled, true);
assert.equal(selectedAnswerClasses.has("is-ready"), false);
assert.equal(selectedAnswerMessage.questionSelectionButton.disabled, true);
assert.equal(selectedQuestionClasses.has("is-ready"), false);
view.syncActiveSession();
const firstSessionId = view.activeSession.id;
await view.startSession({
  excerpt: "Second selected passage",
  sourceFile: "Reading/second.md",
  sourceHeading: "Second concept",
  images: [],
});
assert.equal(view.sessions.length, 2);
assert.equal(view.getSessionTitle(view.activeSession), "Second concept");
view.switchSession(firstSessionId);
assert.equal(view.messages[0].content, "First answer");
assert.equal(
  view.excerptDraft,
  "First retained excerpt\n\nSecond retained excerpt\n\nA focused answer excerpt",
);
assert.equal(view.excerptCount, 3);
assert.equal(view.pendingQuestions.length, 1);
assert.equal(
  view.pendingQuestions[0].text,
  "How does the Harness stop a running tool?",
);
view.appendMessage = () => {};
view.updateCurrentPathWorkspace = () => {};
view.importExternalAnswer(
  pendingQuestionId,
  "claude",
  "Claude's imported answer stays in the local conversation.",
);
assert.equal(view.pendingQuestions[0].status, "asked");
assert.equal(view.pendingQuestions[0].externalProvider, "claude");
assert.equal(view.messages.at(-1).externalResponse, true);
assert.equal(view.messages.at(-1).externalProvider, "claude");
view.deleteSession(firstSessionId);
assert.equal(view.sessions.length, 1);

const genericRequests = [];
requestHandler = async (options) => {
  genericRequests.push(options);
  return {
    status: 200,
    json: { choices: [{ message: { content: "Grounded answer" } }] },
  };
};
plugin.app = {
  secretStorage: { getSecret: () => "test-only-key" },
};
plugin.settings = {
  aiProvider: "custom",
  aiBaseUrl: "https://example.com/v1/",
  aiModel: "example-model",
  aiKeySecret: "test-secret",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: true,
};
const genericAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Explain this.",
  [],
  false,
  true,
);
assert.equal(genericAnswer, "Grounded answer");
assert.equal(genericRequests[0].url, "https://example.com/v1/chat/completions");
assert.equal(genericRequests[0].headers.Authorization, "Bearer test-only-key");
assert.equal("tools" in JSON.parse(genericRequests[0].body), false);

await plugin.askAi(
  { excerpt: "Selected passage" },
  branchedConversation,
  [],
  false,
  false,
  { branchEndpointMessageId: 7 },
);
const branchRequestMessages = JSON.parse(genericRequests.at(-1).body).messages;
const branchRequestText = branchRequestMessages
  .filter((message) => message.role === "user" || message.role === "assistant")
  .map((message) => message.content);
assert.deepEqual(branchRequestText, [
  "Root question",
  "Root answer",
  "Branch A question",
  "Branch A answer",
  "Branch A follow-up",
]);
assert.equal(
  branchRequestText.some((content) => String(content).includes("Branch B")),
  false,
  "the main AI request must not leak a sibling branch into context",
);

const complexRequests = [];
requestHandler = async (options) => {
  complexRequests.push(JSON.parse(options.body));
  const index = complexRequests.length;
  const contents = [
    JSON.stringify({
      should_decompose: true,
      rationale: "two independent concerns",
      subquestions: ["How does the first mechanism work?", "How does the second mechanism work?"],
    }),
    "First focused analysis.",
    "Second focused analysis.",
    "Synthesized complex answer.",
  ];
  return {
    status: 200,
    json: { choices: [{ message: { content: contents[index - 1] } }] },
  };
};
plugin.settings.complexQuestionMode = "always";
plugin.settings.localKnowledgeEnabled = false;
const complexAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Explain the first mechanism and its execution flow. Also explain the second mechanism and how it differs from the first one.",
  [],
  true,
  false,
);
assert.equal(complexAnswer.content, "Synthesized complex answer.");
assert.equal(complexAnswer.runtimeMetrics.decomposedSubquestions, 2);
assert.equal(complexAnswer.runtimeMetrics.rounds, 4);
assert.equal(complexRequests.length, 4);
assert.equal("tools" in complexRequests.at(-1), false);
plugin.settings.complexQuestionMode = "auto";

const responsesRequests = [];
requestHandler = async (options) => {
  responsesRequests.push(options);
  return {
    status: 200,
    json: {
      id: "resp-hosted-search-1",
      output: [
        {
          type: "web_search_call",
          id: "search-1",
          status: "completed",
          action: {
            type: "search",
            query: "Obsidian official website",
            sources: [
              {
                title: "Obsidian",
                url: "https://obsidian.md/",
                snippet: "The official Obsidian website.",
              },
            ],
          },
        },
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "The current source is Obsidian.",
              annotations: [
                {
                  type: "url_citation",
                  title: "Obsidian",
                  url: "https://obsidian.md/",
                },
              ],
            },
          ],
        },
      ],
    },
  };
};
plugin.app = {
  secretStorage: { getSecret: () => "ark-test-key" },
};
plugin.settings = {
  aiProvider: "volcengine",
  aiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  aiModel: "deepseek-v4-flash-ga-260731",
  aiKeySecret: "ark-secret",
  aiApiProtocol: "responses",
  aiHostedWebSearchType: "web_search",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: true,
  webSearchProvider: "tavily",
  webSearchEndpoint: "https://api.tavily.com/search",
  webSearchKeySecret: "unused-search-secret",
  localKnowledgeEnabled: false,
};
assert.equal(plugin.supportsWebSearch(), true);
assert.equal(plugin.getResolvedWebSearchRoute(), "hosted");
plugin.settings.webSearchExecutionMode = "independent";
assert.equal(plugin.getResolvedWebSearchRoute(), "independent");
assert.equal(plugin.supportsWebSearch(), true);
plugin.settings.webSearchExecutionMode = "disabled";
assert.equal(plugin.getResolvedWebSearchRoute(), "disabled");
assert.equal(plugin.supportsWebSearch(), false);
plugin.settings.webSearchExecutionMode = "hosted";
const responsesAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Find the official source.",
  [],
  true,
  true,
);
assert.equal(responsesAnswer.content, "The current source is Obsidian.");
assert.equal(responsesAnswer.sources.length, 1);
assert.equal(responsesAnswer.sources[0].url, "https://obsidian.md/");
assert.equal(responsesRequests.length, 1);
assert.equal(
  responsesRequests[0].url,
  "https://ark.cn-beijing.volces.com/api/v3/responses",
);
const responsesRequestBody = JSON.parse(responsesRequests[0].body);
assert.equal(responsesRequestBody.store, false);
assert.equal(responsesRequestBody.tools[0].type, "web_search");
assert.equal(Array.isArray(responsesRequestBody.input), true);
assert.equal(
  responsesRequestBody.input.some((item) => item.role === "user"),
  true,
);

const responsesKnowledgeFile = {
  path: "Knowledge/AI/known-memory.md",
  basename: "known-memory",
  extension: "md",
  stat: { mtime: 40 },
};
const mixedResponsesRequests = [];
requestHandler = async (options) => {
  mixedResponsesRequests.push(options);
  if (mixedResponsesRequests.length === 1) {
    return {
      status: 200,
      json: {
        id: "resp-local-tool-1",
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        output: [
          {
            type: "function_call",
            call_id: "knowledge-call-1",
            name: "RetrieveKnowledgeEvidence",
            arguments: JSON.stringify({ query: "memory update" }),
          },
        ],
      },
    };
  }
  return {
    status: 200,
    json: {
      id: "resp-local-tool-2",
      usage: {
        input_tokens: 120,
        output_tokens: 20,
        total_tokens: 140,
        input_tokens_details: { cached_tokens: 50 },
      },
      output: [
        {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "Responses and local tools can share one runtime.",
              annotations: [],
            },
          ],
        },
      ],
    },
  };
};
plugin.app = {
  secretStorage: { getSecret: () => "ark-test-key" },
  vault: {
    getMarkdownFiles: () => [responsesKnowledgeFile],
    cachedRead: async () =>
      "# Memory update\n\nDurable memory changes after a confirmed learning event.",
  },
  metadataCache: {
    getFileCache: () => ({ headings: [{ heading: "Memory update" }] }),
  },
};
plugin.settings = {
  aiProvider: "volcengine",
  aiBaseUrl: "https://ark.cn-beijing.volces.com/api/v3/responses",
  aiModel: "deepseek-v4-flash-ga-260731",
  aiKeySecret: "ark-secret",
  aiApiProtocol: "responses",
  aiHostedWebSearchType: "web_search",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: true,
  webSearchProvider: "disabled",
  localKnowledgeEnabled: true,
  knowledgeScopePaths: ["Knowledge/AI"],
};
const mixedResponsesAnswer = await plugin.askAi(
  {
    excerpt: "How memory changes.",
    sourceFile: "Knowledge/AI/current.md",
    sourceHeading: "Memory update",
  },
  "Search my Obsidian notes about memory update and find the latest official source.",
  [],
  true,
  true,
  { knowledgeScopePath: "Knowledge/AI" },
);
assert.equal(
  mixedResponsesAnswer.content,
  "Responses and local tools can share one runtime.",
);
assert.equal(mixedResponsesRequests.length, 2);
assert.equal(mixedResponsesAnswer.runtimeMetrics.providerUsage.totalTokens, 250);
assert.equal(mixedResponsesAnswer.runtimeMetrics.providerUsage.cachedInputTokens, 50);
assert.equal(mixedResponsesAnswer.runtimeMetrics.modelCallDiagnostics.length, 2);
const firstMixedResponsesBody = JSON.parse(mixedResponsesRequests[0].body);
assert.equal(
  firstMixedResponsesBody.tools.some((tool) => tool.type === "web_search"),
  true,
);
assert.equal(
  firstMixedResponsesBody.tools.some(
    (tool) => tool.type === "function" && tool.name === "RetrieveKnowledgeEvidence",
  ),
  true,
);
const secondMixedResponsesBody = JSON.parse(mixedResponsesRequests[1].body);
assert.equal(
  secondMixedResponsesBody.input.some(
    (item) =>
      item.type === "function_call_output" &&
      item.call_id === "knowledge-call-1",
  ),
  true,
);

const localKnowledgeRequests = [];
const localKnowledgeFile = {
  path: "Knowledge/AI/memory-update.md",
  basename: "memory-update",
  extension: "md",
  stat: { mtime: 30 },
};
plugin.app = {
  secretStorage: { getSecret: () => "" },
  vault: {
    getMarkdownFiles: () => [localKnowledgeFile],
    cachedRead: async () =>
      "# Memory update\n\nOnly a confirmed learning event should update durable memory.",
  },
  metadataCache: {
    getFileCache: () => ({ headings: [{ heading: "Memory update" }] }),
  },
};
plugin.settings = {
  aiProvider: "custom",
  aiBaseUrl: "https://local-model.example/v1",
  aiModel: "local-context-model",
  aiKeySecret: "",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: false,
  webSearchProvider: "disabled",
  localKnowledgeEnabled: true,
  knowledgeScopePaths: ["Knowledge/AI"],
};
requestHandler = async (options) => {
  localKnowledgeRequests.push(options);
  return {
    status: 200,
    json: { choices: [{ message: { content: "Local context answer" } }] },
  };
};
assert.equal(
  await plugin.askAi(
    {
      excerpt: "How memory changes.",
      sourceFile: "Knowledge/AI/current.md",
      sourceHeading: "Memory update",
    },
    "When should memory update?",
    [],
    false,
    false,
    { knowledgeScopePath: "Knowledge/AI" },
  ),
  "Local context answer",
);
const localKnowledgeBody = JSON.parse(localKnowledgeRequests[0].body);
assert.equal(
  Array.isArray(localKnowledgeBody.tools),
  false,
);
assert.equal(
  localKnowledgeBody.messages.some((message) =>
    String(message.content).includes(
      "Only a confirmed learning event should update durable memory.",
    ),
  ),
  false,
);

let chatRound = 0;
const kimiRequests = [];
requestHandler = async (options) => {
  kimiRequests.push(options);
  if (options.url.endsWith("/search")) {
    return {
      status: 200,
      json: {
        search_results: [
          {
            title: "Primary source",
            url: "https://example.org/source",
            snippet: "Current information",
          },
        ],
      },
    };
  }

  chatRound += 1;
  if (chatRound === 1) {
    return {
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "tool-1",
                  type: "function",
                  function: {
                    name: "WebSearch",
                    arguments: JSON.stringify({ query: "current fact" }),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }
  return {
    status: 200,
    json: {
      choices: [
        {
          message: {
            content: "Answer with [source](https://example.org/source).",
          },
        },
      ],
    },
  };
};
plugin.settings = {
  aiProvider: "kimi",
  aiBaseUrl: "https://api.kimi.com/coding/v1",
  aiModel: "k3",
  aiKeySecret: "",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: true,
  webSearchProvider: "kimi",
  webSearchMode: "agent",
};
const kimiAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Find the current fact.",
  [],
  true,
  true,
);
assert.equal(kimiAnswer.sources.length, 1);
assert.equal(kimiAnswer.sources[0].url, "https://example.org/source");
assert.equal(kimiRequests.some((request) => request.url.endsWith("/search")), true);
assert.equal(
  JSON.parse(kimiRequests[0].body).tools[0].function.name,
  "WebSearch",
);

let tavilyChatRound = 0;
const tavilyRequests = [];
requestHandler = async (options) => {
  tavilyRequests.push(options);
  if (options.url === "https://api.tavily.com/search") {
    return {
      status: 200,
      json: {
        results: [
          {
            title: "Tavily source",
            url: "https://docs.example.com/current",
            content: "Independent search result",
          },
        ],
      },
    };
  }
  tavilyChatRound += 1;
  if (tavilyChatRound === 1) {
    return {
      status: 200,
      json: {
        choices: [
          {
            message: {
              content: "",
              tool_calls: [
                {
                  id: "tavily-tool-1",
                  type: "function",
                  function: {
                    name: "WebSearch",
                    arguments: JSON.stringify({ query: "independent search" }),
                  },
                },
              ],
            },
          },
        ],
      },
    };
  }
  return {
    status: 200,
    json: {
      choices: [
        {
          message: {
            content:
              "Answer with [Tavily source](https://docs.example.com/current).",
          },
        },
      ],
    },
  };
};
plugin.app = {
  secretStorage: {
    getSecret: (name) =>
      name === "model-secret" ? "model-key" : "search-key",
  },
};
plugin.settings = {
  aiProvider: "custom",
  aiBaseUrl: "https://model.example.com/v1",
  aiModel: "tool-capable-model",
  aiKeySecret: "model-secret",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: true,
  webSearchProvider: "tavily",
  webSearchEndpoint: "https://api.tavily.com/search",
  webSearchKeySecret: "search-secret",
  webSearchMode: "agent",
  webSearchResultCount: 5,
};
const tavilyAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Find an independent result.",
  [],
  true,
  true,
);
assert.equal(tavilyAnswer.sources[0].url, "https://docs.example.com/current");
const tavilySearchRequest = tavilyRequests.find(
  (request) => request.url === "https://api.tavily.com/search",
);
assert.equal(tavilySearchRequest.headers.Authorization, "Bearer search-key");
const tavilyChatRequest = tavilyRequests.find((request) =>
  request.url.endsWith("/chat/completions"),
);
assert.equal(tavilyChatRequest.headers.Authorization, "Bearer model-key");
const tavilyChatPayload = JSON.parse(tavilyChatRequest.body);
assert.deepEqual(
  tavilyChatPayload.tools.map((tool) => tool.function.name),
  ["WebSearch"],
  "independent providers without a hosted fetch adapter must not register FetchURL",
);
assert.match(
  tavilyChatPayload.messages.map((message) => message.content || "").join("\n"),
  /No page-fetch tool is available/,
);

const preSearchRequests = [];
requestHandler = async (options) => {
  preSearchRequests.push(options);
  if (options.url === "https://api.tavily.com/search") {
    return {
      status: 200,
      json: {
        results: [
          {
            title: "Pre-search source",
            url: "https://example.net/pre-search",
            content: "Fresh context for a model without tools",
          },
        ],
      },
    };
  }
  return {
    status: 200,
    json: { choices: [{ message: { content: "Pre-search answer" } }] },
  };
};
plugin.settings.webSearchMode = "always";
const preSearchAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Use fresh information.",
  [],
  true,
  true,
);
assert.equal(preSearchAnswer.content, "Pre-search answer");
assert.equal(preSearchAnswer.sources[0].url, "https://example.net/pre-search");
const preSearchChatBody = JSON.parse(
  preSearchRequests.find((request) =>
    request.url.endsWith("/chat/completions"),
  ).body,
);
assert.equal("tools" in preSearchChatBody, false);
assert.equal(
  preSearchChatBody.messages.some((message) =>
    String(message.content).includes("https://example.net/pre-search"),
  ),
  true,
);

assert.equal(
  plugin.inferProviderFromBaseUrl(
    "https://open.bigmodel.cn/api/coding/paas/v4",
  ),
  "glm_coding",
);
const glmRequests = [];
requestHandler = async (options) => {
  glmRequests.push(options);
  if (options.url === "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp") {
    const payload = JSON.parse(options.body);
    if (payload.method === "initialize") {
      return {
        status: 200,
        headers: { "mcp-session-id": "glm-session-1" },
        json: {
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
          },
        },
      };
    }
    if (payload.method === "notifications/initialized") {
      return { status: 202, headers: {}, text: "" };
    }
    assert.equal(payload.method, "tools/call");
    assert.equal(payload.params.name, "webSearchPrime");
    assert.equal(payload.params.arguments.search_query, "Use plan search.");
    return {
      status: 200,
      headers: {},
      json: {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify([
                {
                  title: "GLM plan source",
                  url: "https://example.cn/glm-plan",
                  summary: "Search included with the coding plan",
                },
              ]),
            },
          ],
          isError: false,
        },
      },
    };
  }
  return {
    status: 200,
    json: { choices: [{ message: { content: "GLM plan answer" } }] },
  };
};
plugin.app = {
  secretStorage: { getSecret: () => "glm-coding-plan-key" },
};
plugin.settings = {
  aiProvider: "glm_coding",
  aiBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  aiModel: "glm-5",
  aiKeySecret: "glm-plan-secret",
  aiSystemPrompt: "Reading tutor",
  aiWebSearchEnabled: true,
  webSearchProvider: "glm_coding",
  webSearchEndpoint:
    "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp",
  webSearchCredentialMode: "model",
  webSearchKeySecret: "",
  webSearchMode: "always",
  webSearchResultCount: 5,
  webSearchMcpToolName: "webSearchPrime",
  webSearchMcpQueryArgument: "search_query",
};
const glmAnswer = await plugin.askAi(
  { excerpt: "Selected passage" },
  "Use plan search.",
  [],
  true,
  true,
);
assert.equal(glmAnswer.content, "GLM plan answer");
assert.equal(glmAnswer.sources[0].url, "https://example.cn/glm-plan");
const glmMcpRequests = glmRequests.filter((request) =>
  request.url.includes("/mcp/web_search_prime/mcp"),
);
assert.equal(glmMcpRequests.length, 3);
assert.equal(
  glmMcpRequests.every(
    (request) =>
      request.headers.Authorization === "Bearer glm-coding-plan-key",
  ),
  true,
);
assert.equal(glmMcpRequests[1].headers["Mcp-Session-Id"], "glm-session-1");
assert.equal(glmMcpRequests[2].headers["Mcp-Session-Id"], "glm-session-1");

const sourceFile = {
  path: "Reading/topic.md",
  extension: "md",
  basename: "topic",
};
const vaultEntries = new Map([[sourceFile.path, sourceFile]]);
const noteContents = new Map([[sourceFile.path, "# Topic\n\nOriginal note."]]);
plugin.app = {
  vault: {
    getAbstractFileByPath: (path) => vaultEntries.get(path) || null,
    createFolder: async (path) => {
      vaultEntries.set(path, { path });
    },
    create: async (path, content) => {
      const basename = path.split("/").pop().replace(/\.md$/i, "");
      const file = { path, extension: "md", basename };
      vaultEntries.set(path, file);
      noteContents.set(path, content);
      return file;
    },
    process: async (file, update) => {
      noteContents.set(file.path, update(noteContents.get(file.path) || ""));
    },
  },
};
plugin.settings = {
  saveDestinationMode: "source",
  targetSectionHeading: "AI excerpts",
  autoCreateTargetSection: true,
  saveTemplate:
    "### {{timestamp}} · {{sourceLabel}}\n\n{{sourceLink}}\n\n{{answerQuote}}",
};
await plugin.saveConfirmedAiExcerpt(
  {
    sourceFile: sourceFile.path,
    sourceHeading: "Definition",
    lineRange: "4-6",
    excerpt: "The selected source passage.",
  },
  "What does it mean?",
  "My confirmed excerpt",
  false,
);
const noteContent = noteContents.get(sourceFile.path);
assert.match(noteContent, /## AI excerpts/);
assert.match(noteContent, /> My confirmed excerpt/);
assert.doesNotMatch(noteContent, /Grounded answer/);

plugin.settings = {
  saveDestinationMode: "companion",
  companionNoteName: "AI conversations.md",
  targetSectionHeading: "AI excerpts",
  autoCreateTargetSection: true,
  saveTemplate: [
    "### {{sourceLabel}}",
    "",
    "> [!quote]- Selected source passage",
    "{{sourceQuote}}",
    "",
    "> [!question] Question",
    "{{questionQuote}}",
    "",
    "> [!quote] Confirmed AI excerpt",
    "{{answerQuote}}",
  ].join("\n"),
};
const companionContext = {
  sourceFile: sourceFile.path,
  sourceHeading: "Definition",
  lineRange: "4-6",
  excerpt: "The selected source passage.",
};
const companionFile = await plugin.saveConfirmedAiExcerpt(
  companionContext,
  "Why does this matter?",
  "Companion answer",
  false,
);
assert.equal(companionFile.path, "Reading/topic/AI conversations.md");
const companionContent = noteContents.get(companionFile.path);
assert.match(companionContent, /> \[!quote\]- Selected source passage/);
assert.match(companionContent, /> The selected source passage\./);
assert.match(companionContent, /> Companion answer/);

plugin.settings.webSourceInboxPath = "AI Reading Companion/Web Sources";
const reviewedSourceFile = await plugin.saveReviewedWebSource(
  {
    title: "Memory design",
    url: "https://example.org/memory-design",
    siteName: "Example docs",
    snippet: "A model-generated search snippet that remains editable.",
  },
  {
    title: "Memory design",
    excerpt: "The excerpt I reviewed and chose to keep.",
    reflection: "Compare this with my update notes.",
    sourceFile: sourceFile.path,
    knowledgeScopePath: "Reading",
  },
);
assert.equal(
  reviewedSourceFile.path,
  "AI Reading Companion/Web Sources/Memory design.md",
);
const reviewedSourceContent = noteContents.get(reviewedSourceFile.path);
assert.match(reviewedSourceContent, /arc_type: external_material/);
assert.match(reviewedSourceContent, /The excerpt I reviewed and chose to keep\./);
assert.match(reviewedSourceContent, /Compare this with my update notes\./);
assert.doesNotMatch(reviewedSourceContent, /model-generated search snippet/);
const duplicateSourceFile = await plugin.saveReviewedWebSource(
  {
    title: "Memory design",
    url: "https://example.org/memory-design",
    siteName: "Example docs",
  },
  {
    title: "Memory design",
    excerpt: "A second independently reviewed excerpt.",
  },
);
assert.notEqual(duplicateSourceFile.path, reviewedSourceFile.path);
assert.equal(
  noteContents.get(reviewedSourceFile.path),
  reviewedSourceContent,
);

const failoverRequests = [];
requestHandler = async (options) => {
  failoverRequests.push(options.url);
  if (options.url.startsWith("https://primary-search.example/search")) {
    return { status: 503, json: {}, text: "temporarily unavailable" };
  }
  if (options.url.startsWith("https://backup-search.example/search")) {
    return {
      status: 200,
      json: {
        results: [
          {
            title: "Backup result",
            url: "https://example.com/backup",
            content: "Recovered through the second search configuration.",
            engine: "backup",
          },
        ],
      },
      text: "",
    };
  }
  throw new Error(`Unexpected failover request: ${options.url}`);
};
plugin.settings.independentSearchProfiles = [
  {
    id: "search-primary",
    name: "Primary search",
    provider: "searxng",
    endpoint: "https://primary-search.example/search",
    keySecret: "",
    credentialMode: "search",
    mode: "agent",
    resultCount: 5,
    mcpToolName: "",
    mcpQueryArgument: "",
  },
  {
    id: "search-backup",
    name: "Backup search",
    provider: "searxng",
    endpoint: "https://backup-search.example/search",
    keySecret: "",
    credentialMode: "search",
    mode: "agent",
    resultCount: 5,
    mcpToolName: "",
    mcpQueryArgument: "",
  },
];
plugin.settings.aiModelProfiles = [
  plugin.createModelProfile({
    id: "model-with-failover",
    name: "Model with failover",
    independentSearchStrategy: "failover",
    independentSearchProfileIds: ["search-primary", "search-backup"],
  }),
];
plugin.settings.activeAiModelProfileId = "model-with-failover";
const failoverResult = await plugin.searchWebWithConfiguredProfiles(
  "Obsidian",
);
assert.equal(failoverResult.searchProfile.id, "search-backup");
assert.equal(failoverResult.sources[0].title, "Backup result");
assert.equal(failoverRequests.length, 2);

const savedModelProfilesBeforeClear = plugin.testData.aiModelProfiles;
await plugin.clearLocalAgentData();
assert.deepEqual(plugin.testData.aiModelProfiles, savedModelProfilesBeforeClear);
assert.equal(
  Object.prototype.hasOwnProperty.call(plugin.testData.localData.sections, "sessions"),
  false,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    plugin.testData.localData.sections,
    "learningMemory",
  ),
  false,
);
assert.equal(
  Object.prototype.hasOwnProperty.call(
    plugin.testData.localData.sections,
    "runMetrics",
  ),
  false,
);
