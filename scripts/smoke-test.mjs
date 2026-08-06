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
    `const document = {};\n${readFileSync(entryPath, "utf8")}`,
    entryPath,
  );
} finally {
  Module._load = originalLoad;
}

const AiReadingCompanionPlugin =
  compiledModule.exports.default ?? compiledModule.exports;
const plugin = new AiReadingCompanionPlugin();

plugin.testData = {
  aiBaseUrl: "https://api.kimi.com/coding/",
};
plugin.app = {
  workspace: {
    on: () => ({}),
    getActiveFile: () => ({ path: "Reading/image-note.md" }),
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
await plugin.onload();
assert.equal(plugin.settings.aiProvider, "kimi");
assert.equal(plugin.settings.internalLinkOpenMode, "tab");
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

await view.startSession({
  excerpt: "First selected passage",
  sourceFile: "Reading/first.md",
  sourceHeading: "First concept",
  images: [],
});
view.messages.push({ role: "assistant", content: "First answer" });
view.addTextToExcerptDraft("First retained excerpt");
view.addTextToExcerptDraft("Second retained excerpt");
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
  "First retained excerpt\n\nSecond retained excerpt",
);
assert.equal(view.excerptCount, 2);
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
