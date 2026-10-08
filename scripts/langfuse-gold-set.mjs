// Gold-set 批量测评：针对插件核心业务目标设计的多轮问题集 + 自动断言 + retrieval_hit 打分。
// 场景矩阵（与 docs/langfuse-eval-guide.md 第八节对应）：
//   A 语义改述递进 —— 第二轮与第一轮语义递进但表述完全不同，检验"换说法也能召回" + 前轮内容的影响
//   B 干扰项       —— 语料里有强相关但无用/误导的内容（编程语言的"上下文"），检验模型是否被检索偏差带偏
//   C 块选择       —— 同一文件多个候选块，检验是否把最相关的块召回给模型而不是全塞
//   D 框架锚定     —— 框架题 → 分支追问 → 综合题，检验回答是否锚定大框架、能否"戳中真问题"
//
// 用法（真实模型）：
//   先让 Obsidian 以调试端口打开正式库（mynotes，phase A 从它的 SecretStorage 取 key），然后：
//   node scripts/langfuse-gold-set.mjs --langfuse-host http://localhost:3000 \
//     --public-key pk-... --secret-key sk-... --debug-port 9223
// 结果（含每轮答案全文、检索证据、检查项）写到 runs/gold-set-<ts>.json。

import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
// Node 22+ 内置全局 WebSocket，无需 ws 依赖

// ---- args ----
const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const langfuseHost = (argOf("langfuse-host", "http://localhost:3000") || "").replace(/\/$/, "");
const publicKey = argOf("public-key", "");
const secretKey = argOf("secret-key", "");
const debugPort = Number(argOf("debug-port", "9223"));
const REAL_SECRET_NAME = argOf("secret-name", "key");
const REAL_BASE_URL = argOf("real-base-url", "https://api.kimi.com/coding/v1");
const REAL_MODEL_ID = argOf("real-model-id", "kimi-k3");
const NOTE_ANCHORED = process.argv.includes("--note-anchored");
const SEARCH_IMPERATIVE = process.argv.includes("--search-imperative");
const SKIP_PHASE_A = process.argv.includes("--skip-phase-a");
const ONLY_SET = argOf("only-set", "");
if (!publicKey || !secretKey) throw new Error("需要 --public-key 和 --secret-key");
const PROJECT_ID = "cmudl5ufk0006p0076vs4i8ix";

// ---- 问题集（金标注释：期望命中的路径片段、证据应含/不应含的字符串）----
const QUESTION_SETS = [
  {
    id: "A-语义改述递进",
    turns: [
      { q: "笔记里说的 context window 是什么？为什么会有这个上限？", snippet: "context window",
        expectPath: "Agent Context", evidenceIncludes: ["窗口"] },
      { q: "如果对话聊得太长快装不下了，一般会怎么处理？", snippet: "装不下",
        expectPath: "Agent Context", evidenceIncludes: ["压缩"] },
      { q: "压缩之后，最早聊的内容会不会就丢了？之前问过的东西还能被记住吗？", snippet: "还能被记住",
        expectPath: "Agent Context", evidenceIncludes: ["摘要"] },
    ],
  },
  {
    id: "B-干扰项",
    turns: [
      { q: "agent 的 context 都是由哪几部分组成的？", snippet: "哪几部分组成",
        expectPath: "Agent Context 工程框架", evidenceIncludes: ["构成"] },
      // 陷阱题：没有金标路径，答案由人工评（理想回答：术语巧合，无直接关系；
      // recordedEvidence 记录检索是否捞到了干扰项笔记，供"检索偏差"分析）
      { q: "那上下文无关文法对理解 agent 的 context 有帮助吗？", snippet: "上下文无关文法",
        expectPath: null, evidenceIncludes: [], recordedEvidence: "文法" },
    ],
  },
  {
    id: "C-块选择",
    turns: [
      // 证据不应含 Zettelkasten：检验"只把最相关的块给模型"（康奈尔块 vs 卡片盒块在同一文件）
      { q: "康奈尔笔记法具体怎么用？", snippet: "康奈尔",
        expectPath: "笔记方法对比", evidenceIncludes: ["康奈尔"], evidenceExcludes: ["Zettelkasten"] },
      { q: "卡片盒笔记法和康奈尔笔记法分别适合什么人？", snippet: "分别适合",
        expectPath: "笔记方法对比", evidenceIncludes: ["卡片盒"] },
    ],
  },
  {
    id: "D-框架锚定",
    turns: [
      { q: "帮我梳理一下 agent 的 context 工程的整体框架，各部分之间是什么关系？", snippet: "整体框架",
        expectPath: "Agent Context 工程框架", evidenceIncludes: ["context"] },
      // 递进追问：指代"你刚才提到"，检验前轮回答的影响 + 分支定位
      { q: "你刚才提到检索增强，它具体是怎么给 context 提供内容的？", snippet: "检索增强",
        expectPath: "Agent Context", evidenceIncludes: ["RAG"] },
      // 综合题：理想回答回扣框架（误区在框架中的位置），人工评
      { q: "那 context 是不是塞得越满越好？", snippet: "塞得越满越好",
        expectPath: "Agent Context", evidenceIncludes: ["误区"] },
    ],
  },
];

// 笔记锚定版：显式指向"我的笔记里"，强制模型走检索路由。
// 第一轮自然问法（上面那版）用于测量"检索路由触发率"——这是第一道闸门。
const QUESTION_SETS_ANCHORED = [
  {
    id: "A-语义改述递进",
    turns: [
      { q: "我的笔记里有没有讲 context window？如果有，它是怎么说的？", snippet: "context window",
        expectPath: "Agent Context", evidenceIncludes: ["窗口"] },
      { q: "笔记里有没有说对话聊得太长快装不下的时候，一般怎么处理？", snippet: "装不下",
        expectPath: "Agent Context", evidenceIncludes: ["压缩"] },
      { q: "那笔记里说压缩之后，最早的内容是不是就丢了？之前问过的东西还能被记住吗？", snippet: "还能被记住",
        expectPath: "Agent Context", evidenceIncludes: ["摘要"] },
    ],
  },
  {
    id: "B-干扰项",
    turns: [
      { q: "我的笔记里有没有讲 agent 的 context 由哪几部分组成？", snippet: "哪几部分组成",
        expectPath: "Agent Context 工程框架", evidenceIncludes: ["构成"] },
      { q: "那笔记里的上下文无关文法，对理解 agent 的 context 有帮助吗？", snippet: "上下文无关文法",
        expectPath: null, evidenceIncludes: [], recordedEvidence: "文法" },
    ],
  },
  {
    id: "C-块选择",
    turns: [
      { q: "笔记里的康奈尔笔记法具体怎么用？", snippet: "康奈尔",
        expectPath: "笔记方法对比", evidenceIncludes: ["康奈尔"], evidenceExcludes: ["Zettelkasten"] },
      { q: "笔记里卡片盒笔记法和康奈尔笔记法，分别适合什么人？", snippet: "分别适合",
        expectPath: "笔记方法对比", evidenceIncludes: ["卡片盒"] },
    ],
  },
  {
    id: "D-框架锚定",
    turns: [
      { q: "帮我根据笔记梳理 agent 的 context 工程整体框架，各部分之间是什么关系？", snippet: "整体框架",
        expectPath: "Agent Context 工程框架", evidenceIncludes: ["context"] },
      { q: "你刚才提到检索增强，笔记里它具体是怎么给 context 提供内容的？", snippet: "检索增强",
        expectPath: "Agent Context", evidenceIncludes: ["RAG"] },
      { q: "那笔记里有没有说 context 是不是塞得越满越好？", snippet: "塞得越满越好",
        expectPath: "Agent Context", evidenceIncludes: ["误区"] },
    ],
  },
];
// ACTIVE_SETS 在三个题库都定义完之后再选择（避免 TDZ）
// 工具描述限定"only when the user explicitly asks to connect, find, or compare"），
// 强制打开检索闸门后才能真正测召回质量。
const QUESTION_SETS_SEARCH = [
  {
    id: "A-语义改述递进",
    turns: [
      { q: "帮我查找笔记：context window 是什么？为什么会有这个上限？", snippet: "context window",
        expectPath: "Agent Context", evidenceIncludes: ["窗口"] },
      { q: "再帮我查找笔记：对话聊得太长快装不下的时候，一般怎么处理？", snippet: "装不下",
        expectPath: "Agent Context", evidenceIncludes: ["压缩"] },
      { q: "再帮我查找笔记：压缩之后最早的内容是不是就丢了？之前问过的东西还能被记住吗？", snippet: "还能被记住",
        expectPath: "Agent Context", evidenceIncludes: ["摘要"] },
    ],
  },
  {
    id: "B-干扰项",
    turns: [
      { q: "帮我查找笔记：agent 的 context 由哪几部分组成？", snippet: "哪几部分组成",
        expectPath: "Agent Context 工程框架", evidenceIncludes: ["构成"] },
      { q: "那笔记里的上下文无关文法，对理解 agent 的 context 有帮助吗？", snippet: "上下文无关文法",
        expectPath: null, evidenceIncludes: [], recordedEvidence: "文法" },
    ],
  },
  {
    id: "C-块选择",
    turns: [
      { q: "帮我查找笔记：康奈尔笔记法具体怎么用？", snippet: "康奈尔",
        expectPath: "笔记方法对比", evidenceIncludes: ["康奈尔"], evidenceExcludes: ["Zettelkasten"] },
      { q: "再帮我查找笔记：卡片盒笔记法和康奈尔笔记法分别适合什么人？", snippet: "分别适合",
        expectPath: "笔记方法对比", evidenceIncludes: ["卡片盒"] },
    ],
  },
  {
    id: "D-框架锚定",
    turns: [
      { q: "帮我查找笔记：agent 的 context 工程整体框架是什么，各部分之间是什么关系？", snippet: "整体框架",
        expectPath: "Agent Context 工程框架", evidenceIncludes: ["context"] },
      { q: "你刚才提到检索增强，它具体是怎么给 context 提供内容的？", snippet: "检索增强",
        expectPath: "Agent Context", evidenceIncludes: ["RAG"] },
      { q: "再帮我查找笔记：context 是不是塞得越满越好？", snippet: "塞得越满越好",
        expectPath: "Agent Context", evidenceIncludes: ["误区"] },
    ],
  },
];
const ACTIVE_SETS_RAW = SEARCH_IMPERATIVE
  ? QUESTION_SETS_SEARCH
  : (NOTE_ANCHORED ? QUESTION_SETS_ANCHORED : QUESTION_SETS);
const ACTIVE_SETS = ONLY_SET
  ? ACTIVE_SETS_RAW.filter((s) => s.id.startsWith(ONLY_SET))
  : ACTIVE_SETS_RAW;
if (!ACTIVE_SETS.length) throw new Error(`--only-set "${ONLY_SET}" matched nothing`);

// ---- helpers ----
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGetJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

function langfuseHeaders() {
  return { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` };
}

function chQuery(sql) {
  return new Promise((res, rej) => {
    execFile(
      "docker",
      ["exec", "langfuse-clickhouse-1", "clickhouse-client", "-q", sql, "--format", "JSONEachRow"],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return rej(new Error(`clickhouse query failed: ${stderr || err.message}`));
        const text = String(stdout);
        const rows = [];
        for (const line of text.split("\n")) {
          const l = line.trim();
          if (!l.startsWith("{")) continue;
          try { rows.push(JSON.parse(l)); } catch { /* 截断的 UTF-8 边界行，跳过 */ }
        }
        res(rows);
      },
    );
  });
}

// ClickHouse metadata 平行数组 → 对象（点路径还原 + JSON/布尔转换），与 e2e 脚本的 metaOf 一致
function metaOf(row) {
  const out = {};
  (row.metadata_names || []).forEach((name, i) => {
    let value = (row.metadata_values || [])[i];
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try { value = JSON.parse(value); } catch { /* 保留字符串 */ }
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    const keys = String(name).split(".");
    let cursor = out;
    keys.slice(0, -1).forEach((key) => {
      if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key];
    });
    cursor[keys[keys.length - 1]] = value;
  });
  return out;
}

// ---- CDP plumbing（与 langfuse-e2e-test.mjs 相同套路）----
async function connectObsidian(port) {
  let pages = null;
  for (let i = 0; i < 90; i += 1) {
    try {
      pages = await httpGetJson(`http://127.0.0.1:${port}/json`);
      if (pages.some((p) => p.url === "app://obsidian.md/index.html")) break;
    } catch { /* retry */ }
    pages = null;
    await delay(500);
  }
  if (!pages) throw new Error(`No Obsidian debug page on port ${port}`);
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
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed");
    }
    return r.result.value;
  }
  return { evaluate, send, close: () => socket.close() };
}

// 杀掉 Obsidian → 等进程树消失 → obsidian.json 只留 demo vault → 带调试端口重启
async function swapToDemoVault() {
  await new Promise((res) => {
    execFile("taskkill", ["/F", "/IM", "Obsidian.exe"], () => res());
  });
  for (let i = 0; i < 30; i += 1) {
    const alive = await new Promise((res) => {
      execFile("tasklist", ["/FI", "IMAGENAME eq Obsidian.exe"], (err, stdout) => {
        res(!err && String(stdout).includes("Obsidian.exe"));
      });
    });
    if (!alive) break;
    await delay(1000);
  }
  await delay(1500);
  const configPath = joinPath(process.env.APPDATA, "obsidian", "obsidian.json");
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  for (const entry of Object.values(config.vaults || {})) {
    if (String(entry.path || "").replace(/\\/g, "/").endsWith("arc-demo-vault")) {
      entry.open = true;
    } else {
      delete entry.open;
    }
  }
  writeFileSync(configPath, JSON.stringify(config, null, 1));
  const verify = JSON.parse(readFileSync(configPath, "utf-8"));
  const opened = Object.values(verify.vaults || {}).filter((e) => e.open).map((e) => e.path);
  console.log("obsidian.json open vaults:", opened);
  if (!opened.some((p) => String(p).replace(/\\/g, "/").endsWith("arc-demo-vault"))) {
    throw new Error("failed to set demo vault as open in obsidian.json");
  }
  const child = spawn(
    "D:\\software\\obsidian\\Obsidian.exe",
    [`--remote-debugging-port=${debugPort}`],
    { cwd: "C:\\Users\\WINDOWS\\Documents", detached: true, stdio: "ignore" },
  );
  child.unref();
  await delay(4000);
}

function makeSetupEval({ baseUrl, model, keySecret }) {
  return `
(async () => {
  if (app.vault.getName() !== "arc-demo-vault") {
    throw new Error("wrong vault: " + app.vault.getName());
  }
  const pluginId = "ai-reading-companion";
  let plugin = app.plugins.plugins[pluginId];
  if (!plugin && app.plugins.manifests[pluginId]) {
    if (typeof app.plugins.setEnable === "function") await app.plugins.setEnable(true);
    if (!app.plugins.plugins[pluginId]) await app.plugins.loadPlugin(pluginId);
    plugin = app.plugins.plugins[pluginId];
  }
  if (!plugin) throw new Error("plugin not loaded");
  plugin.settings.aiProvider = "custom";
  plugin.settings.aiBaseUrl = ${JSON.stringify(baseUrl)};
  plugin.settings.aiModel = ${JSON.stringify(model)};
  plugin.settings.aiApiProtocol = "chat_completions";
  plugin.settings.aiKeySecret = ${JSON.stringify(keySecret)};
  plugin.settings.aiWebSearchEnabled = false;
  plugin.settings.webSearchProvider = "disabled";
  plugin.settings.uiLanguage = "zh-CN";
  plugin.settings.langfuseEnabled = true;
  plugin.settings.langfuseHost = ${JSON.stringify(langfuseHost)};
  plugin.settings.langfusePublicKey = ${JSON.stringify(publicKey)};
  plugin.settings.langfuseSecretKey = ${JSON.stringify(secretKey)};
  await plugin.saveSettings();
  return "settings-ok";
})()`;
}

const CLEAR_CHAT = `
(async () => {
  const leaves = app.workspace.getLeavesOfType("ai-reading-companion-chat");
  if (!leaves.length) return "no-view";
  const view = leaves[0].view;
  const clearBtn = view.contentEl.querySelector('[aria-label="Clear all conversations"]');
  if (clearBtn) {
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 400));
    const confirm = document.querySelector(".modal-container .mod-cta");
    if (confirm) { confirm.click(); await new Promise((r) => setTimeout(r, 400)); }
  }
  await leaves[0].detach();
  return "cleared";
})()`;

// 首轮：打开笔记、选中文本、触发"问 AI"把聊天视图拉起来；追问轮复用已打开的视图
function makeAskEval(question, openNote = true) {
  const setupNote = openNote
    ? `
  const notePath = "Reading notes/Understanding Context Windows.md";
  await app.workspace.openLinkText(notePath, "", false);
  await new Promise((r) => setTimeout(r, 700));
  const editor = app.workspace.activeEditor && app.workspace.activeEditor.editor;
  if (!editor) throw new Error("no active editor");
  const line = 4;
  editor.setSelection({ line, ch: 0 }, { line, ch: editor.getLine(line).length });
  editor.focus();
  app.commands.executeCommandById("ai-reading-companion:ask-ai-about-selection");
  await new Promise((r) => setTimeout(r, 900));`
    : `
  await new Promise((r) => setTimeout(r, 300));`;
  return `
(async () => {${setupNote}
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  if (!leaf) throw new Error("chat view did not open");
  const view = leaf.view;
  if (view.isRequesting) throw new Error("view busy (isRequesting)");
  const ta = view.questionEl || view.contentEl.querySelector("textarea");
  if (!ta) throw new Error("no composer textarea");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, ${JSON.stringify(question)});
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  await view.submitQuestion();
  return "submitted";
})()`;
}

// 单次读取当前状态（无页内定时器，避免后台标签页定时器节流卡死等待循环）
function makeStateEval(snippet) {
  return `
(() => {
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  const view = leaf && leaf.view;
  if (!view) return "pending";
  const last = [...(view.messages || [])].reverse().find(
    (m) => m.role === "assistant" && String(m.question || "").includes(${JSON.stringify(snippet)}),
  );
  if (!view.isRequesting && last && String(last.content || "").trim().length > 0) {
    return "answer-shown";
  }
  return "pending";
})()`;
}

// node 侧轮询等待（每 1.5s 一次读状态，240 次 = 6 分钟上限），免疫页内定时器节流
async function waitRealNode(evaluate, snippet) {
  for (let i = 0; i < 240; i += 1) {
    const r = await evaluate(makeStateEval(snippet));
    if (r === "answer-shown") return "answer-shown";
    await delay(1500);
  }
  return "timeout";
}

async function bringToFront(send) {
  try { await send("Page.bringToFront"); } catch { /* 尽力即可 */ }
}

function postScore(traceId, value, comment) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({
      batch: [{
        type: "score-create",
        id: `score-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        body: { id: `score-body-${Date.now()}`, traceId, name: "retrieval_hit", value, comment },
      }],
    });
    const req = http.request(`${langfuseHost}/api/public/ingestion`, {
      method: "POST",
      headers: { ...langfuseHeaders(), "Content-Type": "application/json" },
    }, (r) => { r.resume(); r.on("end", res); });
    req.on("error", rej);
    req.end(body);
  });
}

// ---- main ----
const results = { startedAt: new Date().toISOString(), sets: [] };
try {
  console.log(`gold-set eval: ${REAL_MODEL_ID} @ ${REAL_BASE_URL}${NOTE_ANCHORED ? " (note-anchored)" : ""}`);
  let obsidian;
  if (SKIP_PHASE_A) {
    // demo vault 已开着、key 已注入、设置已配好（紧接着上一轮跑），直接复用
    obsidian = await connectObsidian(debugPort);
    console.log("phase A skipped, vault:", await obsidian.evaluate("app.vault.getName()"));
  } else {
    // phase A：当前打开的正式库里取 key（只在内存）
    obsidian = await connectObsidian(debugPort);
    const vaultName = await obsidian.evaluate("app.vault.getName()");
    console.log("phase A vault:", vaultName);
    const apiKey = await obsidian.evaluate(
      `(app.secretStorage.getSecret(${JSON.stringify(REAL_SECRET_NAME)}) || "")`,
    );
    if (!apiKey) throw new Error(`secret ${REAL_SECRET_NAME} not found in vault "${vaultName}"`);
    console.log(`api key extracted (len=${apiKey.length}, memory only)`);
    obsidian.close();
    await swapToDemoVault();
    obsidian = await connectObsidian(debugPort);
    const keyLen = await obsidian.evaluate(
      `(async () => { await app.secretStorage.setSecret(${JSON.stringify(REAL_SECRET_NAME)}, ${JSON.stringify(apiKey)}); return String(app.secretStorage.getSecret(${JSON.stringify(REAL_SECRET_NAME)}) || "").length; })()`,
    );
    console.log("secret injected into demo vault, readback length:", keyLen);
    console.log(await obsidian.evaluate(makeSetupEval({
      baseUrl: REAL_BASE_URL, model: REAL_MODEL_ID, keySecret: REAL_SECRET_NAME,
    })));
  }
  const evaluate = (expression) => obsidian.evaluate(expression);

  for (const set of ACTIVE_SETS) {
    console.log(`\n### 场景 ${set.id}`);
    const setResult = { id: set.id, turns: [] };
    results.sets.push(setResult);
    console.log("clear:", await evaluate(CLEAR_CHAT));
    for (let t = 0; t < set.turns.length; t += 1) {
      const turn = set.turns[t];
      const turnResult = { turn: t + 1, question: turn.q };
      setResult.turns.push(turnResult);
      console.log(`-- turn${t + 1}: ${turn.q}`);
      await bringToFront(obsidian.send);
      console.log("  submit:", await evaluate(makeAskEval(turn.q, t === 0)));
      let msgCount = await evaluate(
        `(() => { const l = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0]; return l ? (l.view.messages || []).length : -1; })()`,
      );
      if (msgCount === 0) {
        // 首轮 ask-ai 命令刚拉起视图时 submit 可能被吞（消息数组为空），重试一次
        console.log("  view empty after submit, retrying...");
        await delay(2000);
        console.log("  submit:", await evaluate(makeAskEval(turn.q, false)));
        msgCount = await evaluate(
          `(() => { const l = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0]; return l ? (l.view.messages || []).length : -1; })()`,
        );
      }
      console.log("  msgs after submit:", msgCount);
      const wait = await waitRealNode(evaluate, turn.snippet);
      turnResult.wait = wait;
      console.log("  wait:", wait);
      if (wait !== "answer-shown") {
        turnResult.error = "answer timeout";
        break;
      }
      await delay(3000); // 等遥测 flush

      // 从 ClickHouse 取本轮 trace（顺序执行，最新的 ask-question 根事件即本轮）
      const rootRows = await chQuery(
        `select trace_id, session_id, start_time, end_time, metadata_names, metadata_values, output ` +
        `from events_full where project_id='${PROJECT_ID}' and trace_name='ask-question' and is_app_root=1 ` +
        `order by start_time desc limit 1`,
      );
      const root = rootRows[0];
      if (!root) { turnResult.error = "trace not found"; break; }
      const meta = metaOf(root);
      const toolRows = await chQuery(
        `select name, input, output from events_full where project_id='${PROJECT_ID}' ` +
        `and trace_id='${root.trace_id}' and type='SPAN' and name like 'tool:%' order by start_time`,
      );
      const evidence = toolRows.map((r) => String(r.output || "")).join("\n---\n");
      const genRows = await chQuery(
        `select usage_details from events_full where project_id='${PROJECT_ID}' ` +
        `and trace_id='${root.trace_id}' and type='GENERATION'`,
      );
      const usage = genRows.reduce((acc, r) => {
        const u = r.usage_details || {};
        acc.input += Number(u.input || 0);
        acc.output += Number(u.output || 0);
        return acc;
      }, { input: 0, output: 0 });
      const durationMs = root.end_time && root.start_time
        ? new Date(root.end_time.replace(" ", "T") + "Z") - new Date(root.start_time.replace(" ", "T") + "Z")
        : null;

      const checks = { trace_found: true };
      checks.turn_index_ok = String(meta.turnIndex) === String(t + 1);
      checks.retrieval_called = toolRows.length >= 1;
      checks.evidence_nonempty = evidence.trim().length > 0;
      const paths = Array.isArray(meta.retrievedPaths) ? meta.retrievedPaths : [];
      checks.retrieved_paths = paths;
      if (turn.expectPath) {
        checks.path_hit = paths.some((p) => String(p).includes(turn.expectPath));
      }
      checks.evidence_includes = (turn.evidenceIncludes || []).map((s) => ({
        needle: s, ok: evidence.includes(s),
      }));
      checks.evidence_excludes = (turn.evidenceExcludes || []).map((s) => ({
        needle: s, ok: !evidence.includes(s),
      }));
      if (turn.recordedEvidence) {
        checks.recorded_evidence_present = evidence.includes(turn.recordedEvidence);
      }
      checks.tokens = usage;
      checks.duration_ms = durationMs;
      checks.session_id = root.session_id;
      checks.trace_url = `${langfuseHost}/project/${PROJECT_ID}/traces/${root.trace_id}`;
      turnResult.checks = checks;
      turnResult.answer = String(root.output || "");
      turnResult.evidence = evidence;
      console.log("  checks:", JSON.stringify(checks));

      // 有金标路径的轮次打 retrieval_hit 分（陷阱题不打，留人工评）
      if (turn.expectPath) {
        const hit = checks.path_hit ? 1 : 0;
        await postScore(root.trace_id, hit,
          `gold-set ${set.id} turn${t + 1}: path contains "${turn.expectPath}"`);
      }
    }
  }

  const outDir = joinPath(process.cwd(), "runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = joinPath(outDir, `gold-set-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nresults written: ${outPath}`);

  const allChecks = [];
  for (const s of results.sets) {
    for (const t of s.turns) {
      if (!t.checks) continue;
      const c = t.checks;
      allChecks.push([`${s.id}#t${t.turn}`, c.path_hit, c.turn_index_ok, c.retrieval_called]);
      for (const e of [...(c.evidence_includes || []), ...(c.evidence_excludes || [])]) {
        if (!e.ok) allChecks.push([`${s.id}#t${t.turn} evidence "${e.needle}"`, false]);
      }
    }
  }
  const failed = allChecks.filter(([, ...oks]) => oks.some((v) => v === false));
  console.log(`\n=== GOLD SET SUMMARY: ${allChecks.length - failed.length}/${allChecks.length} passed ===`);
  if (failed.length) console.log("failed:", JSON.stringify(failed));
} finally {
  if (typeof obsidian !== "undefined" && obsidian) obsidian.close();
  // CDP WebSocket 会挂住 node 事件循环，清理完强制退出
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
