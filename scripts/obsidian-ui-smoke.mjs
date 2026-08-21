import { mkdir, writeFile } from "node:fs/promises";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const outputBefore = resolve(
  process.argv[2] || join(tmpdir(), "selection-to-draft-before.png"),
);
const outputAfter = resolve(
  process.argv[3] || join(tmpdir(), "selection-to-draft-after.png"),
);

function readJson(url) {
  return new Promise((resolveRequest, rejectRequest) => {
    get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolveRequest(JSON.parse(body));
        } catch (error) {
          rejectRequest(error);
        }
      });
    }).on("error", rejectRequest);
  });
}

const pages = await readJson("http://127.0.0.1:9222/json");
const page = pages.find((candidate) => candidate.url === "app://obsidian.md/index.html");
if (!page) {
  throw new Error("No Obsidian page found on remote debugging port 9222.");
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolveOpen, rejectOpen) => {
  socket.addEventListener("open", resolveOpen, { once: true });
  socket.addEventListener("error", rejectOpen, { once: true });
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
  return new Promise((resolveRequest, rejectRequest) => {
    pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest });
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
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Obsidian evaluation failed.",
    );
  }
  return result.result.value;
}

async function screenshot(path) {
  const capture = await send("Page.captureScreenshot", { format: "png" });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(capture.data, "base64"));
}

await send("Page.bringToFront");
const setup = await evaluate(`
  (async () => {
    const plugin = app.plugins.plugins["ai-reading-companion"];
    if (!plugin) throw new Error("AI Reading Companion is not enabled.");
    const leaf = await plugin.getAiConversationLeaf();
    const view = leaf.view;
    if (!view || typeof view.captureMessageSelection !== "function") {
      throw new Error("AI conversation view is not ready.");
    }

    for (const session of [...view.sessions]) {
      if (session.context?.sourceHeading !== "Harness 架构 · UI smoke") continue;
      session.isRequesting = false;
      if (session === view.activeSession) view.isRequesting = false;
      view.deleteSession(session.id);
    }

    await view.startSession({
      excerpt: "Harness 负责把模型、上下文和工具组织成可控的执行系统。",
      sourceFile: "40.专题与项目/Claude Code 深度学习/Claude Code Harness 架构精读_架构优先版.md",
      sourceHeading: "Harness 架构 · UI smoke",
      sourceLineStart: 1,
      sourceLineEnd: 1,
      images: [],
    });
    const message = {
      id: view.nextMessageId++,
      role: "assistant",
      content: "## Harness 的三个职责\\n\\nHarness 首先管理上下文，其次控制工具调用，最后负责权限与停止边界。\\n\\n这段测试回答只用于验证：选中文字后，可以直接加入待整理摘录，而不会立刻写入知识库。",
      sources: [],
    };
    view.messages.push(message);
    view.appendMessage(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));

    const walker = document.createTreeWalker(message.bodyEl, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.textContent.includes("管理上下文")) {
      node = walker.nextNode();
    }
    if (!node) throw new Error("Could not find rendered assistant text.");
    const start = node.textContent.indexOf("管理上下文");
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, Math.min(node.textContent.length, start + 18));
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    view.captureMessageSelection(message);
    message.bodyEl.scrollIntoView({ block: "center" });

    window.__aiReadingCompanionSmoke = { view, message, node, start };
    const toolbarRect = view.selectionToolbarEl.getBoundingClientRect();
    const rootRect = view.contentEl.getBoundingClientRect();
    return {
      selectedText: message.selectedText,
      selectionButtonEnabled: !message.selectionAddButton.disabled,
      selectionButtonReady: message.selectionAddButton.hasClass("is-ready"),
      questionButtonEnabled: !message.questionSelectionButton.disabled,
      questionButtonReady: message.questionSelectionButton.hasClass("is-ready"),
      toolbarVisible: !view.selectionToolbarEl.hasClass("is-hidden"),
      toolbarInsideView:
        toolbarRect.left >= rootRect.left && toolbarRect.right <= rootRect.right,
      draftBefore: view.excerptDraft,
    };
  })()
`);
await screenshot(outputBefore);

const queued = await evaluate(`
  (() => {
    const { view, message, node, start } = window.__aiReadingCompanionSmoke;
    message.selectionAddButton.click();
    if (view.contentEl.hasClass("is-compact-layout")) {
      view.setCompactViewTab("chat", false);
    }
    if (view.contentEl.hasClass("is-mobile-layout")) {
      view.setMobileViewTab("chat", false);
    }

    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, Math.min(node.textContent.length, start + 18));
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    view.captureMessageSelection(message);
    message.questionSelectionButton.click();
    view.pendingQuestionInputEl.value = "How does the Harness enforce stop boundaries?";
    view.pendingQuestionInputEl.dispatchEvent(new Event("input"));
    view.pendingQuestionAddButton.click();
    const question = view.pendingQuestions[0];
    return {
      draftAfter: view.excerptDraft,
      excerptCount: view.excerptCount,
      queueExpanded: view.pendingQuestionsExpanded,
      queuedQuestion: question.text,
      queuedSource: question.sourceExcerpt,
      queuedStatus: question.status,
      toolbarHidden: view.selectionToolbarEl.hasClass("is-hidden"),
      savedFile: view.draftSavedFile?.path || null,
    };
  })()
`);
await screenshot(outputAfter);

const saved = await evaluate(`
  (async () => {
    const { view } = window.__aiReadingCompanionSmoke;
    const plugin = app.plugins.plugins["ai-reading-companion"];
    const originalAskAi = plugin.askAi;
    plugin.askAi = async () => ({
      role: "assistant",
      content: "The queued question was answered by the UI smoke test.",
      sources: [],
    });
    try {
      const question = view.pendingQuestions[0];
      view.sessionImages = view.sessionImages || [];
      view.questionEl.value = "Unsent composer draft";
      await view.askPendingQuestion(question.id);
      return {
        questionStatus: question.status,
        userMessageAdded: view.messages.some(
          (message) =>
            message.role === "user" && message.pendingQuestionId === question.id,
        ),
        answerAdded: view.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.includes("queued question was answered"),
        ),
        composerDraftPreserved:
          view.questionEl.value === "Unsent composer draft",
        linkedQuestionMessageId: question.questionMessageId || null,
        linkedAnswerMessageId: question.answerMessageId || null,
        linkedTurnsPresent:
          view.messages.some((message) => message.id === question.questionMessageId) &&
          view.messages.some((message) => message.id === question.answerMessageId),
      };
    } finally {
      plugin.askAi = originalAskAi;
    }
  })()
`);

await evaluate(`
  (() => {
    const { view } = window.__aiReadingCompanionSmoke;
    const testSessionIds = view.sessions
      .filter((session) => session.context?.sourceHeading === "Harness 架构 · UI smoke")
      .map((session) => session.id);
    for (const sessionId of testSessionIds) {
      view.deleteSession(sessionId);
    }
    delete window.__aiReadingCompanionSmoke;
    return testSessionIds.length;
  })()
`);

socket.close();
process.stdout.write(
  `${JSON.stringify({ setup, queued, saved, outputBefore, outputAfter }, null, 2)}\n`,
);
