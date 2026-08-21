import assert from "node:assert/strict";
import { createServer, get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

const debugPort = Number(process.argv[2] || 9223);
const closeBrowserAfterRun = process.argv.includes("--close");
const targetUrl = `http://127.0.0.1:${debugPort}/json`;
const requests = [];

const modelServer = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    const parsed = body ? JSON.parse(body) : {};
    requests.push({ url: request.url, body: parsed });
    if (request.url?.endsWith("/responses")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: "response-acceptance-1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "Responses acceptance complete with hosted search annotation.",
                annotations: [
                  {
                    type: "url_citation",
                    url: "https://example.com/acceptance",
                    title: "Acceptance source",
                  },
                ],
              },
            ],
          },
        ],
      }));
      return;
    }
    const hasToolResult = Array.isArray(parsed.messages)
      && parsed.messages.some((message) => message?.role === "tool");
    const message = hasToolResult
      ? {
          role: "assistant",
          content:
            "Acceptance complete: the selected passage, bounded local evidence, and tool result reached the Agent Runtime.",
        }
      : {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "acceptance-search-1",
              type: "function",
              function: {
                name: "SearchKnowledgeScope",
                arguments: JSON.stringify({ query: "Harness context permissions stop" }),
              },
            },
          ],
        };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
});

await new Promise((resolve, reject) => {
  modelServer.once("error", reject);
  modelServer.listen(0, "127.0.0.1", resolve);
});
const modelPort = modelServer.address().port;

function readJson(url) {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode || 0) >= 400) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

const pages = await readJson(targetUrl);
const page = pages.find((candidate) => candidate.url === "app://obsidian.md/index.html");
if (!page) {
  throw new Error(`No Obsidian page found on remote debugging port ${debugPort}.`);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let requestId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function send(method, params = {}) {
  requestId += 1;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || "Obsidian evaluation failed.",
    );
  }
  return result.result.value;
}

let result;
try {
  await send("Page.bringToFront");
  result = await evaluate(`
    (async () => {
      const pluginId = "ai-reading-companion";
      if (app.plugins.plugins[pluginId]
          && typeof app.plugins.unloadPlugin === "function") {
        await app.plugins.unloadPlugin(pluginId);
      }
      if (!app.plugins.manifests[pluginId]
          && typeof app.plugins.loadManifests === "function") {
        await app.plugins.loadManifests();
      }
      if (!app.plugins.plugins[pluginId]
          && typeof app.plugins.setEnable === "function") {
        await app.plugins.setEnable(true);
      }
      if (!app.plugins.plugins[pluginId]
          && typeof app.plugins.enablePlugin === "function") {
        await app.plugins.enablePlugin(pluginId);
      }
      if (!app.plugins.plugins[pluginId] && app.plugins.manifests[pluginId]) {
        await app.plugins.loadPlugin(pluginId);
      }
      const plugin = app.plugins.plugins[pluginId];
      if (!plugin) {
        const managerMethods = Object.getOwnPropertyNames(
          Object.getPrototypeOf(app.plugins),
        ).filter((name) => /plugin|restrict|enable|load/i.test(name));
        throw new Error(
          "AI Reading Companion could not be loaded in the isolated profile. "
          + "Manifest visible: " + Boolean(app.plugins.manifests[pluginId])
          + "; restrictedMode=" + String(app.plugins.restrictedMode)
          + "; enabled=" + String(app.plugins.enabledPlugins?.has?.(pluginId))
          + "; methods=" + managerMethods.join(","),
        );
      }
      const sourceFile = "40.专题与项目/Claude Code 深度学习/Claude Code Harness 架构精读_架构优先版.md";
      const scopePath = "40.专题与项目/Claude Code 深度学习";
      const sourceNote = app.vault.getAbstractFileByPath(sourceFile);
      if (!sourceNote) {
        throw new Error("The acceptance source note was not found.");
      }
      const sourceBefore = {
        mtime: sourceNote.stat?.mtime || 0,
        size: sourceNote.stat?.size || 0,
      };

      const settings = plugin.settings;
      const originalHistory = plugin.buildHistoricalQuestionContext;
      const originalPreferences = plugin.getConfirmedLearningPreferences;
      const events = [];
      try {
        plugin.settings = {
          ...settings,
          aiBaseUrl: "http://127.0.0.1:${modelPort}/v1",
          aiModel: "agent-acceptance-model",
          aiKeySecret: "",
          aiApiProtocol: "chat_completions",
          aiHostedWebSearchType: "",
          aiModelProfiles: [],
          activeAiModelProfileId: "",
          aiWebSearchEnabled: false,
          webSearchExecutionMode: "disabled",
          localKnowledgeEnabled: true,
          knowledgeScopePaths: [],
        };
        plugin.buildHistoricalQuestionContext = async () =>
          "- Earlier user question: How does Harness control permissions?";
        plugin.getConfirmedLearningPreferences = async () =>
          "- Explain difficult architecture using a concrete execution flow.";

        const chatAnswer = await plugin.askAi(
          {
            excerpt:
              "Harness is the execution boundary connecting the model, context, tools, permissions, and stop control.",
            sourceFile,
            sourceHeading: "Agent acceptance",
          },
          [
            {
              role: "user",
              content: "How do context, permission grants, and stop control work together?",
            },
          ],
          [],
          true,
          false,
          {
            knowledgeScopePath: scopePath,
            sessionId: "agent-acceptance-session",
            emit: (stage, detail) => events.push({ stage, detail }),
          },
        );
        plugin.settings = {
          ...plugin.settings,
          aiApiProtocol: "responses",
          aiHostedWebSearchType: "web_search",
          webSearchExecutionMode: "hosted",
          localKnowledgeEnabled: false,
        };
        const responsesAnswer = await plugin.askAi(
          {
            excerpt: "Provider-hosted search remains isolated from client tools.",
            sourceFile,
            sourceHeading: "Responses acceptance",
          },
          "Find a current source for the hosted-search acceptance test.",
          [],
          true,
          true,
        );
        const cancellationEvents = [];
        const cancellationRun = plugin.runController.start(
          async () => new Promise(() => {}),
          {
            observers: [
              { onEvent: (event) => cancellationEvents.push(event.stage) },
            ],
          },
        );
        cancellationRun.cancel("user");
        let cancellationReason = "";
        try {
          await cancellationRun.result;
        } catch (error) {
          cancellationReason = error?.reason || error?.name || "unknown";
        }
        const leaf = await plugin.getAiConversationLeaf();
        const view = leaf.view;
        await view.startSession({
          excerpt: "A root answer may lead to sibling follow-up questions.",
          sourceFile,
          sourceHeading: "UI branch semantics acceptance",
          sourceLineStart: 1,
          sourceLineEnd: 1,
          lineRange: "1-1",
          images: [],
        });
        const uiSessionId = view.activeSession.id;
        let uiStructure;
        try {
          const rootQuestion = {
            id: view.nextMessageId++,
            role: "user",
            content: "What is the root idea?",
            parentAssistantMessageId: null,
          };
          const rootAnswer = {
            id: view.nextMessageId++,
            role: "assistant",
            content: "The root answer has two aspects.",
            parentQuestionMessageId: rootQuestion.id,
            sources: [],
          };
          const firstChildQuestion = {
            id: view.nextMessageId++,
            role: "user",
            content: "How does the first aspect work?",
            parentAssistantMessageId: rootAnswer.id,
          };
          const firstChildAnswer = {
            id: view.nextMessageId++,
            role: "assistant",
            content: "The first aspect answer.",
            parentQuestionMessageId: firstChildQuestion.id,
            sources: [],
          };
          const secondChildQuestion = {
            id: view.nextMessageId++,
            role: "user",
            content: "How does the second aspect work?",
            parentAssistantMessageId: rootAnswer.id,
          };
          const secondChildAnswer = {
            id: view.nextMessageId++,
            role: "assistant",
            content: "The second aspect answer.",
            parentQuestionMessageId: secondChildQuestion.id,
            sources: [],
          };
          view.messages.push(
            rootQuestion,
            rootAnswer,
            firstChildQuestion,
            firstChildAnswer,
            secondChildQuestion,
            secondChildAnswer,
          );
          view.activePathMessageId = secondChildAnswer.id;
          view.viewedMessageId = secondChildAnswer.id;
          view.renderActiveSession();

          const initialTreeNodes = view.contentEl.querySelectorAll(
            ".ai-agent-question-tree-node",
          );
          const firstChildNode = view.contentEl.querySelector(
            '[data-question-message-id="' + firstChildQuestion.id + '"]',
          );
          firstChildNode.querySelector(".ai-agent-question-tree-select").click();
          const endpointAfterNavigation = view.activePathMessageId;
          const viewedAfterNavigation = view.viewedMessageId;
          const refreshedFirstChildNode = view.contentEl.querySelector(
            '[data-question-message-id="' + firstChildQuestion.id + '"]',
          );
          refreshedFirstChildNode
            .querySelector(".ai-agent-question-tree-continue")
            .click();
          const endpointAfterContinue = view.activePathMessageId;

          const drawerTrigger = view.contentEl.querySelector(
            ".ai-agent-session-drawer-trigger",
          );
          drawerTrigger.click();
          const drawer = view.contentEl.querySelector(
            ".ai-agent-session-drawer",
          );
          const drawerOpened = drawerTrigger.getAttribute("aria-expanded") === "true"
            && drawer.hidden === false;
          view.contentEl.dispatchEvent(new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
          }));
          const drawerClosedWithEscape =
            drawerTrigger.getAttribute("aria-expanded") === "false"
            && drawer.hidden === true;

          uiStructure = {
            treeNodeCount: initialTreeNodes.length,
            siblingDepths: Array.from(initialTreeNodes).map(
              (node) => node.getAttribute("data-depth"),
            ),
            endpointBeforeNavigation: secondChildAnswer.id,
            endpointAfterNavigation,
            viewedAfterNavigation,
            firstChildQuestionId: firstChildQuestion.id,
            endpointAfterContinue,
            firstChildAnswerId: firstChildAnswer.id,
            drawerOpened,
            drawerClosedWithEscape,
            hasSingleContextScroll: Boolean(
              view.contentEl.querySelector(
                ".ai-agent-context-panel > .ai-agent-context-scroll",
              ),
            ),
          };
        } finally {
          view.deleteSession(uiSessionId);
        }
        const sourceAfter = {
          mtime: sourceNote.stat?.mtime || 0,
          size: sourceNote.stat?.size || 0,
        };
        return {
          pluginVersion: plugin.manifest.version,
          answer: chatAnswer.content,
          events: events.map((event) => event.stage),
          receipt: chatAnswer.contextReceipt,
          runPlan: chatAnswer.runPlan,
          runtimeMetrics: chatAnswer.runtimeMetrics,
          sourceCount: chatAnswer.contextReceipt?.localSources?.length || 0,
          responses: {
            answer: responsesAnswer.content,
            sourceCount: responsesAnswer.sources?.length || 0,
            runPlan: responsesAnswer.runPlan,
          },
          cancellation: {
            reason: cancellationReason,
            events: cancellationEvents,
          },
          uiStructure,
          sourceUnchanged:
            sourceBefore.mtime === sourceAfter.mtime
            && sourceBefore.size === sourceAfter.size,
          commands: [
            "review-learning-memory-candidates",
            "show-agent-runtime-diagnostics",
          ].map((id) => Boolean(app.commands.commands[
            "ai-reading-companion:" + id
          ])),
        };
      } finally {
        plugin.settings = settings;
        plugin.buildHistoricalQuestionContext = originalHistory;
        plugin.getConfirmedLearningPreferences = originalPreferences;
      }
    })()
  `);
} finally {
  if (closeBrowserAfterRun) {
    await Promise.race([
      send("Browser.close").catch(() => {}),
      delay(1_000),
    ]);
  }
  socket.close();
  await new Promise((resolve) => modelServer.close(resolve));
}

assert.equal(
  requests.length,
  3,
  "the runtime should make two Chat Completions rounds and one Responses request",
);
assert.equal(requests[0].url, "/v1/chat/completions");
assert.ok(Array.isArray(requests[0].body.tools));
assert.ok(
  requests[0].body.tools.some((tool) => tool.function?.name === "SearchKnowledgeScope"),
  "the authorized scope search tool must be registered",
);
const firstMessages = JSON.stringify(requests[0].body.messages);
assert.match(firstMessages, /execution boundary connecting the model/);
assert.match(firstMessages, /Earlier user question/);
assert.match(firstMessages, /concrete execution flow/);
assert.ok(
  requests[1].body.messages.some(
    (message) =>
      message.role === "tool"
      && message.tool_call_id === "acceptance-search-1",
  ),
  "the second model round must contain the tool result",
);
assert.equal(requests[2].url, "/v1/responses");
assert.equal(requests[2].body.store, false);
assert.ok(
  requests[2].body.tools.some((tool) => tool.type === "web_search"),
  "the Responses request must declare only the configured hosted-search protocol tool",
);
assert.match(result.answer, /Acceptance complete/);
assert.match(result.responses.answer, /Responses acceptance complete/);
assert.equal(result.responses.sourceCount, 1);
assert.equal(result.responses.runPlan.apiProtocol, "responses");
assert.equal(result.responses.runPlan.webSearchRoute, "hosted");
assert.equal(result.cancellation.reason, "user");
assert.deepEqual(result.cancellation.events, [
  "created",
  "cancel_requested",
  "cancelled",
]);
assert.equal(result.uiStructure.treeNodeCount, 3);
assert.deepEqual(result.uiStructure.siblingDepths, ["1", "2", "2"]);
assert.equal(
  result.uiStructure.endpointAfterNavigation,
  result.uiStructure.endpointBeforeNavigation,
  "viewing a question-tree node must not change the branch endpoint",
);
assert.equal(
  result.uiStructure.viewedAfterNavigation,
  result.uiStructure.firstChildQuestionId,
  "viewing a question-tree node must update only the viewed message",
);
assert.equal(
  result.uiStructure.endpointAfterContinue,
  result.uiStructure.firstChildAnswerId,
  "only the explicit continue action may change the branch endpoint",
);
assert.equal(result.uiStructure.drawerOpened, true);
assert.equal(result.uiStructure.drawerClosedWithEscape, true);
assert.equal(result.uiStructure.hasSingleContextScroll, true);
assert.equal(
  result.sourceUnchanged,
  true,
  "asking the Agent must not write to the source note automatically",
);
assert.deepEqual(result.commands, [true, true]);
assert.equal(result.runPlan.apiProtocol, "chat_completions");
assert.equal(result.runPlan.webSearchRoute, "disabled");
assert.equal(result.runPlan.knowledgeScopePath, "40.专题与项目/Claude Code 深度学习");
assert.equal(result.runtimeMetrics.rounds, 2);
assert.equal(result.runtimeMetrics.toolCalls, 1);
assert.ok(result.sourceCount > 0, "the Context Receipt must expose used local evidence");
assert.ok(
  result.receipt.sections.some(
    (section) => section.kind === "question_history" && section.included,
  ),
);
assert.ok(
  result.receipt.sections.some(
    (section) => section.kind === "confirmed_memory" && section.included,
  ),
);
assert.deepEqual(result.events, [
  "assembling_context",
  "executing_tool",
  "calling_model",
  "executing_tool",
  "calling_model",
  "calling_model",
]);

process.stdout.write(`${JSON.stringify({
  ok: true,
  pluginVersion: result.pluginVersion,
  modelRequests: requests.length,
  registeredTools: requests[0].body.tools.map((tool) => tool.function?.name),
  runtimeMetrics: result.runtimeMetrics,
  receiptSections: result.receipt.sections.map((section) => ({
    kind: section.kind,
    included: section.included,
    truncated: section.truncated,
    characters: section.includedCharacters,
  })),
  localSourceCount: result.sourceCount,
  responses: result.responses,
  cancellation: result.cancellation,
  uiStructure: result.uiStructure,
  sourceUnchanged: result.sourceUnchanged,
  lifecycle: result.events,
}, null, 2)}\n`);
