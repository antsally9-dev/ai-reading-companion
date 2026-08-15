import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";

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
const {
  AgentRuntime,
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
  buildResponsesRequestBody,
  buildQuestionRecords,
  classifyKnowledgeIdentity,
  classifyModelTransportError,
  createAgentRunPlan,
  detectLearningPreferenceSignal,
  extractResponsesAssistantMessage,
  findKnowledgeScopeForFile,
  makeResponsesUrl,
  pathIsWithinScope,
  searchHistoricalQuestions,
} = compiledModule.exports;
assert.equal(typeof AgentRuntime, "function");
assert.equal(typeof ContextBuilder, "function");
assert.equal(typeof ModelTransport, "function");
assert.equal(typeof ModelTransportError, "function");
assert.equal(typeof PluginDataStore, "function");
assert.equal(typeof BoundedSessionStore, "function");
assert.equal(typeof LearningMemoryStore, "function");
assert.equal(typeof RunMetricsStore, "function");
assert.equal(typeof RunController, "function");
assert.equal(typeof ToolGateway, "function");
assert.equal(typeof KnowledgeScopeRetriever, "function");
assert.equal(typeof buildResponsesRequestBody, "function");
assert.equal(typeof extractResponsesAssistantMessage, "function");
assert.equal(makeResponsesUrl("https://example.com/v1/chat/completions"), "https://example.com/v1/responses");

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
const keptSessions = await boundedStore.save([
  {
    id: 1,
    createdAt: now - 3,
    updatedAt: now - 3,
    pendingQuestions: [{ id: 1, text: "First?", status: "pending", createdAt: now }],
  },
  { id: 2, createdAt: now - 2, updatedAt: now - 2 },
  { id: 3, createdAt: now - 1, updatedAt: now - 1 },
]);
assert.deepEqual(keptSessions.map((session) => session.id), [3, 2]);
assert.deepEqual((await boundedStore.load()).map((session) => session.id), [3, 2]);
assert.equal(
  buildQuestionRecords({
    id: "session-a",
    createdAt: now,
    pendingQuestions: [
      { id: "q1", text: "How?", status: "resolved", sourceExcerpt: "A quote" },
    ],
  })[0].sourceExcerpt,
  "A quote",
);
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
  toolCalls: 0,
});
const metricSummary = await metricsStore.summarize();
assert.equal(metricSummary.count, 1);
assert.equal(metricSummary.completed, 1);
assert.equal(metricSummary.trimmingRate, 1);

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
  ...Array.from({ length: 4 }, (_, index) => ({
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
view.addPendingQuestion();
assert.equal(view.pendingQuestions.length, 1);
assert.equal(view.pendingQuestions[0].status, "pending");
assert.equal(
  view.pendingQuestions[0].sourceExcerpt,
  "Harness controls tool calls and stop boundaries.",
);
const pendingQuestionId = view.pendingQuestions[0].id;
view.setPendingQuestionStatus(pendingQuestionId, "parked");
assert.equal(view.pendingQuestions[0].status, "parked");
view.setPendingQuestionStatus(pendingQuestionId, "pending");
assert.equal(view.pendingQuestions[0].status, "pending");
view.hideSelectionToolbar = () => {
  view.selectedMessage = null;
};
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
        output: [
          {
            type: "function_call",
            call_id: "knowledge-call-1",
            name: "SearchKnowledgeScope",
            arguments: JSON.stringify({ query: "memory update", limit: 3 }),
          },
        ],
      },
    };
  }
  return {
    status: 200,
    json: {
      id: "resp-local-tool-2",
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
  "When should memory update?",
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
const firstMixedResponsesBody = JSON.parse(mixedResponsesRequests[0].body);
assert.equal(
  firstMixedResponsesBody.tools.some((tool) => tool.type === "web_search"),
  true,
);
assert.equal(
  firstMixedResponsesBody.tools.some(
    (tool) => tool.type === "function" && tool.name === "SearchKnowledgeScope",
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
  localKnowledgeBody.tools.some(
    (tool) => tool.function.name === "SearchKnowledgeScope",
  ),
  true,
);
assert.equal(
  localKnowledgeBody.messages.some((message) =>
    String(message.content).includes(
      "Only a confirmed learning event should update durable memory.",
    ),
  ),
  true,
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
