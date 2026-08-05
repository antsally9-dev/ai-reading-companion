import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";

let requestHandler = async () => {
  throw new Error("Unexpected network request in smoke test.");
};

class Plugin {
  async loadData() {
    return this.testData;
  }

  async saveData(data) {
    this.testData = data;
  }
}

class ItemView {}
class MarkdownView {}
class PluginSettingTab {}
class SecretComponent {}
class Setting {}
class Component {
  load() {}
  unload() {}
}

const obsidianMock = {
  Component,
  ItemView,
  MarkdownView,
  MarkdownRenderer: { render: async () => {} },
  Notice: class {},
  Plugin,
  PluginSettingTab,
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

const entryPath = resolve("main.js");
const compiledModule = new Module(entryPath);
compiledModule.filename = entryPath;
compiledModule.paths = Module._nodeModulePaths(process.cwd());

const originalLoad = Module._load;
Module._load = (request, parent, isMain) =>
  request === "obsidian"
    ? obsidianMock
    : originalLoad(request, parent, isMain);

try {
  compiledModule._compile(readFileSync(entryPath, "utf8"), entryPath);
} finally {
  Module._load = originalLoad;
}

const AiReadingCompanionPlugin =
  compiledModule.exports.default ?? compiledModule.exports;
const plugin = new AiReadingCompanionPlugin();

plugin.testData = {
  aiBaseUrl: "https://api.kimi.com/coding/",
};
await plugin.loadSettings();
assert.equal(plugin.settings.aiProvider, "kimi");
assert.equal(plugin.settings.internalLinkOpenMode, "tab");

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
let noteContent = "# Topic\n\nOriginal note.";
plugin.app = {
  vault: {
    getAbstractFileByPath: () => sourceFile,
    process: async (_file, update) => {
      noteContent = update(noteContent);
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
  },
  "What does it mean?",
  "My confirmed excerpt",
  false,
);
assert.match(noteContent, /## AI excerpts/);
assert.match(noteContent, /> My confirmed excerpt/);
assert.doesNotMatch(noteContent, /Grounded answer/);
