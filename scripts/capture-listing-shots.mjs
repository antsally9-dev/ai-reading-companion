// Capture community-directory listing screenshots by driving an Obsidian
// debug instance over CDP. Run manually:
//   node scripts/capture-listing-shots.mjs [port] [outdir]
// Requires Obsidian launched with --remote-debugging-port on the demo vault
// named "arc-demo-vault" (the script refuses to run against any other vault).

import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";

const debugPort = Number(process.argv[2] || 9223);
const outDir = resolve(process.argv[3] || "listing-shots");
mkdirSync(outDir, { recursive: true });

const QUESTION = "Why does a small set of passages beat a large one?";
const ANSWER_TEXT = [
  "The passage compares the context window to a **budget**: only a fixed amount of text fits, and every retrieved passage spends part of it.",
  "",
  "Two claims are worth separating:",
  "",
  "1. **Source fact** — irrelevant passages are not neutral; they make recall harder and can push the model toward the wrong detail.",
  "2. **Design implication** — a small, well-chosen set of passages usually beats a large, noisy one.",
  "",
  "So context management is really allocation: decide what earns a place in the window, compress what can be summarized, and keep a visible receipt of what was actually read.",
].join("\n");

let serverHits = 0;
const modelServer = createServer((request, response) => {
  let body = "";
  request.setEncoding("utf-8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    serverHits += 1;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: ANSWER_TEXT }, finish_reason: "stop" }],
    }));
  });
});
await new Promise((res, rej) => modelServer.once("error", rej).listen(0, "127.0.0.1", res));
const modelPort = modelServer.address().port;
console.log(`mock model server on ${modelPort}`);

function readJson(url) {
  return new Promise((res, rej) => {
    get(url, (r) => {
      let b = "";
      r.on("data", (c) => { b += c; });
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

let pages;
for (let i = 0; i < 40; i += 1) {
  try {
    pages = await readJson(`http://127.0.0.1:${debugPort}/json`);
    if (pages.some((p) => p.url === "app://obsidian.md/index.html")) break;
  } catch { /* retry */ }
  pages = null;
  await delay(500);
}
if (!pages) throw new Error(`No Obsidian debug page on port ${debugPort}`);
const page = pages.find((p) => p.url === "app://obsidian.md/index.html");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  socket.addEventListener("open", res, { once: true });
  socket.addEventListener("error", rej, { once: true });
});

let requestId = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const m = JSON.parse(String(event.data));
  const r = pending.get(m.id);
  if (!r) return;
  pending.delete(m.id);
  if (m.error) r.reject(new Error(m.error.message));
  else r.resolve(m.result);
});
const send = (method, params = {}) => new Promise((res, rej) => {
  requestId += 1;
  pending.set(requestId, { resolve: res, reject: rej });
  socket.send(JSON.stringify({ id: requestId, method, params }));
});
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed");
  }
  return r.result.value;
}

async function capture(name, clip) {
  const params = { format: "png" };
  if (clip) params.clip = clip;
  const shot = await send("Page.captureScreenshot", params);
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(shot.data, "base64"));
  console.log(`saved ${name}.png`);
}

const SETUP = `
(async () => {
  if (app.vault.getName() !== "arc-demo-vault") {
    throw new Error("wrong vault: " + app.vault.getName() + " — refusing to touch settings");
  }
  const pluginId = "ai-reading-companion";
  let plugin = app.plugins.plugins[pluginId];
  if (!plugin && app.plugins.manifests[pluginId]) {
    if (typeof app.plugins.setEnable === "function") await app.plugins.setEnable(true);
    else if (typeof app.plugins.enablePlugin === "function") await app.plugins.enablePlugin(pluginId);
    if (!app.plugins.plugins[pluginId]) await app.plugins.loadPlugin(pluginId);
    plugin = app.plugins.plugins[pluginId];
  }
  if (!plugin) throw new Error("plugin not loaded");
  plugin.settings.aiProvider = "custom";
  plugin.settings.aiBaseUrl = "http://127.0.0.1:${modelPort}/v1";
  plugin.settings.aiModel = "reading-demo";
  plugin.settings.aiApiProtocol = "chat_completions";
  plugin.settings.aiKeySecret = "";
  plugin.settings.aiWebSearchEnabled = false;
  plugin.settings.webSearchProvider = "disabled";
  plugin.settings.uiLanguage = "en";
  plugin.settings.aiConversationOpenMode = "sidebar";
  plugin.settings.activeAiModelProfileId = "";
  await plugin.saveSettings();
  return "settings-ok";
})()`;

const CLEAR_AND_CLOSE = `
(async () => {
  const leaves = app.workspace.getLeavesOfType("ai-reading-companion-chat");
  if (!leaves.length) return "no-view";
  const view = leaves[0].view;
  const clearBtn = view.contentEl.querySelector('[aria-label="Clear all conversations"]');
  if (clearBtn) {
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    // a confirm modal may appear
    const confirm = document.querySelector(".modal-container .mod-cta");
    if (confirm) { confirm.click(); await new Promise((r) => setTimeout(r, 400)); }
  }
  await leaves[0].detach();
  return "cleared";
})()`;

const OPEN_AND_ASK = `
(async () => {
  const notePath = "Reading notes/Understanding Context Windows.md";
  await app.workspace.openLinkText(notePath, "", false);
  await new Promise((r) => setTimeout(r, 700));
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  if (!editor) throw new Error("no active editor");
  const line = 4;
  editor.setSelection({ line, ch: 0 }, { line, ch: editor.getLine(line).length });
  editor.focus();
  app.commands.executeCommandById("ai-reading-companion:ask-ai-about-selection");
  await new Promise((r) => setTimeout(r, 900));
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  if (!leaf) throw new Error("chat view did not open");
  const view = leaf.view;
  if (view.isRequesting) throw new Error("view busy (isRequesting)");
  const ta = view.questionEl || view.contentEl.querySelector("textarea");
  if (!ta) throw new Error("no composer textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(QUESTION)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  await view.submitQuestion();
  return "submitted";
})()`;

const WAIT_ANSWER = `
(async () => {
  for (let i = 0; i < 40; i += 1) {
    const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
    const view = leaf && leaf.view;
    const text = view ? view.contentEl.innerText : "";
    if (text.includes("budget") && text.includes("allocation")) return "answer-shown";
    if (view && !view.isRequesting && i > 4 && text.includes("Send")) return "not-requesting:" + text.slice(0, 120);
    await new Promise((r) => setTimeout(r, 500));
  }
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  return "timeout:" + (leaf ? leaf.view.contentEl.innerText.slice(0, 300) : "no-view");
})()`;

const VIEW_RECT = `
(() => {
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  if (!leaf) return null;
  const r = leaf.view.contentEl.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, scale: 2 };
})()`;

try {
  await send("Page.bringToFront");
  console.log(await evaluate(SETUP));

  // ---- desktop shot ----
  await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 2, mobile: false });
  console.log(await evaluate(CLEAR_AND_CLOSE));
  console.log(await evaluate(OPEN_AND_ASK));
  console.log("server hits:", serverHits);
  const waitResult = await evaluate(WAIT_ANSWER);
  console.log("wait:", waitResult.slice(0, 200));
  await delay(900);
  await capture("desktop-1200x800");
  console.log(await evaluate(CLEAR_AND_CLOSE));

  // ---- mobile shot ----
  console.log(await evaluate(`
    (() => {
      const p = app.plugins.plugins["ai-reading-companion"];
      if (!window.__origIsMobileApp) window.__origIsMobileApp = p.isMobileApp;
      p.isMobileApp = () => true;
      return "mobile-mode-on";
    })()`));
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1600, deviceScaleFactor: 2, mobile: true });
  console.log(await evaluate(OPEN_AND_ASK));
  console.log("server hits:", serverHits);
  const mobileWait = await evaluate(WAIT_ANSWER);
  console.log("wait:", mobileWait.slice(0, 200));
  await delay(900);
  await capture("mobile-900x1600-full");
  const rect = await evaluate(VIEW_RECT);
  if (rect) await capture("mobile-900x1600-view", rect);
  console.log(await evaluate(CLEAR_AND_CLOSE));

  // restore
  await evaluate(`
    (() => {
      const p = app.plugins.plugins["ai-reading-companion"];
      if (window.__origIsMobileApp) p.isMobileApp = window.__origIsMobileApp;
      return "mobile-mode-off";
    })()`);
  console.log("done, server hits total:", serverHits);
} finally {
  socket.close();
  modelServer.close();
}
