// AI Reading Benchmark v1 运行器（设计见 docs/evaluation/reading-benchmark-v1-design.md）
//
// 用法（先让 Obsidian 带调试端口打开正式库 mynotes）：
//   node scripts/langfuse-benchmark.mjs --langfuse-host http://localhost:3000 \
//     --public-key pk-... --secret-key sk-... [--debug-port 9223] [--suite core,routing,multi,stale,insight,reader_notes]
// gold：scripts/evaluation/gold/benchmark-v1.json
// 产物：runs/benchmark-v1-<ts>.json（全部答案/证据/指标）+ Langfuse scores
//   （retrieval_action_accuracy / recall_at_k / ndcg_at_k / citation_verifiability / unsupported_abstention）
// judge 类指标（conceptual_positioning 等）只记录答案供人工/离线评审，不在本脚本打分。

import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";

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
const SKIP_PHASE_A = process.argv.includes("--skip-phase-a");
const SUITES = (argOf("suite", "core,routing,multi,stale") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_CASES = (argOf("only-case", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const ONLY_SETS = (argOf("only-set", "") || "").split(",").map((s) => s.trim()).filter(Boolean);
const GOLD_PATH = argOf("gold", "scripts/evaluation/gold/benchmark-v1.json");
if (!publicKey || !secretKey) throw new Error("需要 --public-key 和 --secret-key");
const PROJECT_ID = "cmudl5ufk0006p0076vs4i8ix";

const GOLD = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
const BENCH_TITLE = "Agent Context Engineering 基准";

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
        const rows = [];
        for (const line of String(stdout).split("\n")) {
          const l = line.trim();
          if (!l.startsWith("{")) continue;
          try { rows.push(JSON.parse(l)); } catch { /* UTF-8 边界截断行 */ }
        }
        res(rows);
      },
    );
  });
}

function metaOf(row) {
  const out = {};
  (row.metadata_names || []).forEach((name, i) => {
    let value = (row.metadata_values || [])[i];
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try { value = JSON.parse(value); } catch { /* 保留 */ }
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

// ---- CDP ----
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

async function swapToDemoVault() {
  await new Promise((res) => {
    execFile("taskkill", ["/F", "/IM", "Obsidian.exe"], () => res());
  });
  for (let i = 0; i < 30; i += 1) {
    const alive = await new Promise((res) => {
      execFile("tasklist", ["/FI", "IMAGENAME eq Obsidian.exe", ], (err, stdout) => {
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

// ---- 插件设置（webSearch 参数供 STALE 套件开启外部验证）----
function makeSetupEval({ baseUrl, model, keySecret, webSearch = false }) {
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
  plugin.settings.aiWebSearchEnabled = ${webSearch};
  plugin.settings.webSearchProvider = ${webSearch ? '"kimi"' : '"disabled"'};
  plugin.settings.uiLanguage = "zh-CN";
  plugin.settings.langfuseEnabled = true;
  plugin.settings.langfuseHost = ${JSON.stringify(langfuseHost)};
  plugin.settings.langfusePublicKey = ${JSON.stringify(publicKey)};
  plugin.settings.langfuseSecretKey = ${JSON.stringify(secretKey)};
  await plugin.saveSettings();
  return "settings-ok" + (${webSearch ? '"-websearch"' : '""'});
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

// 首轮先打开锚点笔记并触发 ask-ai（拉起聊天视图）；种子注入发生在这之后、提交之前
function makeOpenNoteEval() {
  return `
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
  return "view-opened";
})()`;
}

function makeSubmitEval(question) {
  return `
(async () => {
  await new Promise((r) => setTimeout(r, 300));
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

// 位置型等待判据：定位含 snippet 的用户消息，其后的 assistant 消息有内容即完成。
// 不能按 assistant.question 匹配——复杂问题分解时 assistant 消息的 question 字段是
// 子问题文本（ask-question-use-case.ts:490），S07 三连超时的根因即此。
function makeStateEval(snippet) {
  return `
(() => {
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  const view = leaf && leaf.view;
  if (!view) return "pending";
  const messages = [...(view.messages || [])];
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && String(messages[i].content || "").includes(${JSON.stringify(snippet)})) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return "pending";
  const answered = messages.slice(userIdx + 1).some(
    (m) => m.role === "assistant" && String(m.content || "").trim().length > 0,
  );
  if (!view.isRequesting && answered) return "answer-shown";
  return "pending";
})()`;
}

function makeAnswerEval(snippet) {
  return `
(() => {
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  const view = leaf && leaf.view;
  if (!view) return "";
  const messages = [...(view.messages || [])];
  let userIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user" && String(messages[i].content || "").includes(${JSON.stringify(snippet)})) {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return "";
  for (let i = messages.length - 1; i > userIdx; i -= 1) {
    if (messages[i].role === "assistant") return String(messages[i].content || "");
  }
  return "";
})()`;
}

async function waitRealNode(evaluate, snippet) {
  for (let i = 0; i < 240; i += 1) {
    const r = await evaluate(makeStateEval(snippet));
    if (r === "answer-shown") return "answer-shown";
    await delay(1500);
  }
  return "timeout";
}

async function bringToFront(send) {
  try { await send("Page.bringToFront"); } catch { /* 尽力 */ }
}

// READER NOTES 夹具：场景前创建 companion 摘录笔记，等 metadataCache 建 links；
// 场景后连空目录一起删除，保证其他套件语料不受污染
function makeFixtureNoteEval(path, content) {
  return `
(async () => {
  const path = ${JSON.stringify(path)};
  const folder = path.split("/").slice(0, -1).join("/");
  const existed = app.vault.getAbstractFileByPath(path);
  if (existed) await app.vault.delete(existed, true);
  if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
  await app.vault.create(path, ${JSON.stringify(content)});
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const links = app.metadataCache.resolvedLinks[path];
    if (links && Object.keys(links).length) return "fixture-ready links=" + Object.keys(links).length;
  }
  return "fixture-timeout-no-links";
})()`;
}

function makeFixtureDeleteEval(path) {
  return `
(async () => {
  const path = ${JSON.stringify(path)};
  const file = app.vault.getAbstractFileByPath(path);
  if (file) await app.vault.delete(file, true);
  const folder = path.split("/").slice(0, -1).join("/");
  const folderFile = folder ? app.vault.getAbstractFileByPath(folder) : null;
  if (folderFile && folderFile.children && folderFile.children.length === 0) await app.vault.delete(folderFile, true);
  return app.vault.getAbstractFileByPath(path) ? "delete-failed" : "deleted";
})()`;
}

// M05：向聊天视图注入一条错误的 assistant 历史（决定论 seed，不依赖模型自然犯错）
function makeSeedEval(seed) {
  return `
(async () => {
  const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
  if (!leaf) throw new Error("no chat view for seeding");
  const view = leaf.view;
  const mkId = () => "seed-" + Math.random().toString(36).slice(2, 10);
  for (const m of ${JSON.stringify(seed)}) {
    view.messages.push(Object.assign({ id: mkId() }, m));
  }
  if (typeof view.renderMessages === "function") view.renderMessages();
  else if (typeof view.update === "function") view.update();
  return { count: view.messages.length, seeded: view.messages.slice(-2).map((m) => ({ role: m.role, len: (m.content || "").length })) };
})()`;
}

// ---- Langfuse 读取与解析 ----
async function fetchTurnFromLangfuse() {
  const rootRows = await chQuery(
    `select trace_id, session_id, start_time, end_time, metadata_names, metadata_values, output ` +
    `from events_full where project_id='${PROJECT_ID}' and trace_name='ask-question' and is_app_root=1 ` +
    `order by start_time desc limit 1`,
  );
  const root = rootRows[0];
  if (!root) return { root: null };
  const toolRows = await chQuery(
    `select name, input, output from events_full where project_id='${PROJECT_ID}' ` +
    `and trace_id='${root.trace_id}' and type='SPAN' and name like 'tool:%' order by start_time`,
  );
  // 归档检索工具的输出是对话摘录（内嵌旧回答的 [[引用]]），不是笔记证据——
  // 单列 archive_used，不进块级解析
  const archiveRows = toolRows.filter((r) => String(r.name || "").includes("SearchConversationHistory"));
  const evidenceRows = toolRows.filter((r) => !String(r.name || "").includes("SearchConversationHistory"));
  const genRows = await chQuery(
    `select name, usage_details, input from events_full where project_id='${PROJECT_ID}' ` +
    `and trace_id='${root.trace_id}' and type='GENERATION'`,
  );
  const usage = genRows.reduce((acc, r) => {
    const u = r.usage_details || {};
    acc.input += Number(u.input || 0);
    acc.output += Number(u.output || 0);
    return acc;
  }, { input: 0, output: 0 });
  const messageCount = Math.max(0, ...genRows.map((r) => {
    try { return Number(JSON.parse(String(r.input || "{}")).messageCount || 0); } catch { return 0; }
  }));
  const durationMs = root.end_time && root.start_time
    ? new Date(root.end_time.replace(" ", "T") + "Z") - new Date(root.start_time.replace(" ", "T") + "Z")
    : null;
  const evidence = toolRows.map((r) => String(r.output || "")).join("\n---\n");
  return { root, meta: metaOf(root), toolRows, usage, messageCount, durationMs, evidence };
}

// 从工具证据文本解析块级引用：基准文章块 → Axx id；其他笔记 → OTHER:标题
// 注意链接里带 .md 后缀，比对前先去掉
function parseEvidenceChunks(evidence) {
  const bench = [];
  const other = [];
  const re = /\[\[Reading notes\/([^\]#|]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(evidence)) !== null) {
    const title = m[1].trim().replace(/\.md$/i, "");
    const heading = (m[2] || "").trim();
    if (title === BENCH_TITLE) {
      const id = (heading.match(/^A\d{2}/) || [])[0];
      if (id) bench.push(id);
    } else {
      other.push(title);
    }
  }
  return { bench, other, retrieved: [...bench, ...other.map((t) => `OTHER:${t}`)] };
}

// 块级元数据（P0 重构后确定性初检无 tool span，靠 trace 的 retrievedEvidence）：
// [{path, heading}] → 与工具证据同一结构
function parseMetaEvidence(list) {
  const bench = [];
  const other = [];
  for (const item of Array.isArray(list) ? list : []) {
    const path = String(item?.path || "");
    const heading = String(item?.heading || "");
    const title = path.replace(/^Reading notes\//, "").replace(/\.md$/i, "").trim();
    if (title === BENCH_TITLE) {
      const id = (heading.match(/^A\d{2}/) || [])[0];
      if (id) bench.push(id);
    } else if (title) {
      other.push(title);
    }
  }
  return { bench, other, retrieved: [...bench, ...other.map((t) => `OTHER:${t}`)] };
}

function mergeParsed(primary, secondary) {
  const bench = [...primary.bench];
  const other = [...primary.other];
  for (const id of secondary.bench) if (!bench.includes(id)) bench.push(id);
  for (const t of secondary.other) if (!other.includes(t)) other.push(t);
  return { bench, other, retrieved: [...bench, ...other.map((t) => `OTHER:${t}`)] };
}

// ---- 指标 ----
function computeMetrics(goldTurn, parsed) {
  const required = goldTurn.required || {};
  const hardNeg = goldTurn.hard_negative || {};
  const grades = { ...required, ...hardNeg }; // 同 id 时 required 优先级低不了——gold 不重叠
  for (const [id, g] of Object.entries(required)) grades[id] = g;
  const K = parsed.retrieved.length;
  const m = {
    k: K,
    retrieved_chunks: parsed.retrieved,
    bench_chunks: parsed.bench,
    other_notes: parsed.other,
    recall: null, hnr: null, mrr: null, ndcg: null, precision: null, noise_ratio: null,
  };
  if (Object.keys(required).length > 0) {
    const hit = Object.keys(required).filter((id) => parsed.bench.includes(id));
    m.recall = hit.length / Object.keys(required).length;
    const firstIdx = parsed.bench.findIndex((id) => required[id] !== undefined);
    m.mrr = firstIdx >= 0 ? 1 / (firstIdx + 1) : 0;
  }
  if (Object.keys(hardNeg).length > 0 && K > 0) {
    const hn = parsed.bench.filter((id) => hardNeg[id] !== undefined);
    m.hnr = hn.length / K;
  }
  if (K > 0) {
    const dcg = parsed.retrieved.reduce((s, id, i) => {
      const g = Number(grades[id] || 0);
      return g > 0 ? s + (2 ** g - 1) / Math.log2(i + 2) : s;
    }, 0);
    const ideal = Object.entries(grades).filter(([, g]) => Number(g) >= 2)
      .map(([id, g]) => [id, Number(g)]).sort((a, b) => b[1] - a[1]).slice(0, K);
    const idcg = ideal.reduce((s, [, g], i) => s + (2 ** g - 1) / Math.log2(i + 2), 0);
    m.ndcg = idcg > 0 ? dcg / idcg : null;
    m.precision = parsed.retrieved.filter((id) => Number(grades[id] || 0) >= 2).length / K;
    m.noise_ratio = parsed.retrieved.filter((id) => Number(grades[id] || 0) <= 1).length / K;
  }
  return m;
}

// 实际检索动作推导（对照 gold 枚举打分）。
// P0 重构后"检索发生过"= 有 tool span 或块级证据非空（确定性初检不产生 tool span）
function deriveAction(retrievalHappened, parsed, priorChunks, webSources) {
  if (webSources > 0) return "EXTERNAL_VERIFY";
  if (!retrievalHappened) return priorChunks.length ? "REUSE_PREVIOUS" : "NO_RETRIEVAL";
  const newChunks = parsed.retrieved.filter((id) => !priorChunks.includes(id));
  return newChunks.length ? "INCREMENTAL_RETRIEVAL" : "REPEAT_RETRIEVAL";
}

function actionMatches(expected, actual) {
  if (!expected) return null;
  // v1.1：支持数组（多种可接受动作）；REUSE 预期同时接受 REPEAT（重复检索无新证据，无害）
  if (Array.isArray(expected)) {
    return expected.some((item) => actionMatches(item, actual));
  }
  if (expected === "RETRIEVAL") {
    return ["INCREMENTAL_RETRIEVAL", "REPEAT_RETRIEVAL", "EXTERNAL_VERIFY"].includes(actual);
  }
  if (expected === "REUSE_PREVIOUS") {
    return actual === "REUSE_PREVIOUS" || actual === "REPEAT_RETRIEVAL";
  }
  return expected === actual;
}

// citation 核验：答案里每个 [[路径#标题]] 引用必须在 metadataCache 中真实存在
function makeCitationEval(answer) {
  return `
(() => {
  const answer = ${JSON.stringify(answer || "")};
  const cites = [...answer.matchAll(/\\[\\[([^\\]|#]+)(?:#([^\\]|]+))?(?:\\|[^\\]]*)?\\]\\]/g)];
  return cites.map(([_, path, heading]) => {
    const file = app.metadataCache.getFirstLinkpathDest(path, "");
    if (!file) return { path, heading: heading || null, ok: false, reason: "file" };
    if (!heading) return { path, heading: null, ok: true, reason: "" };
    const cache = app.metadataCache.getFileCache(file);
    const headings = ((cache && cache.headings) || []).map((h) => h.heading);
    const norm = (s) => String(s).trim().toLowerCase().replace(/\\s+/g, " ");
    const hit = headings.some((h) => {
      const nh = norm(h), nt = norm(heading);
      return nh === nt || nh.startsWith(nt) || nt.startsWith(nh);
    });
    return { path, heading, ok: hit, reason: hit ? "" : "heading" };
  });
})()`;
}

const ABSTAIN_MARKERS = ["没有提到", "未提到", "没有说明", "没有明确", "没有直接", "不足以", "无法判断", "不能据此", "没有给出", "未覆盖", "没有覆盖", "超出本文", "超出范围"];

function postScore(traceId, name, value, comment) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({
      batch: [{
        type: "score-create",
        id: `score-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        body: { id: `score-body-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, traceId, name, value, comment },
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

// ---- 单 turn 执行（种子注入发生在视图拉起之后、问题提交之前）----
async function runTurn(obsidian, evaluate, goldTurn, label, firstOfConversation, seed = null) {
  await bringToFront(obsidian.send);
  const rec = {};
  if (firstOfConversation) {
    try {
      await evaluate(makeOpenNoteEval());
    } catch (e) {
      rec.error = `open-note-error: ${e.message}`;
      return rec;
    }
  }
  if (seed) {
    try {
      rec.seed = await evaluate(makeSeedEval(seed));
    } catch (e) {
      rec.seed_error = e.message;
      return rec; // 决定论注入失败 → 场景不可信
    }
  }
  let submit = await evaluate(makeSubmitEval(goldTurn.question)).catch((e) => `submit-error: ${e.message}`);
  let msgCount = await evaluate(
    `(() => { const l = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0]; return l ? (l.view.messages || []).length : -1; })()`,
  ).catch(() => -1);
  if (String(submit).startsWith("submit-error") || msgCount === 0) {
    console.log(`  [${label}] submit retry (${submit}, msgs=${msgCount})`);
    await delay(2000);
    submit = await evaluate(makeSubmitEval(goldTurn.question)).catch((e) => `submit-error: ${e.message}`);
    msgCount = await evaluate(
      `(() => { const l = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0]; return l ? (l.view.messages || []).length : -1; })()`,
    ).catch(() => -1);
  }
  const wait = await waitRealNode(evaluate, goldTurn.snippet);
  const answer = wait === "answer-shown" ? await evaluate(makeAnswerEval(goldTurn.snippet)) : "";
  rec.submit = submit;
  rec.msgCount = msgCount;
  rec.wait = wait;
  rec.answer = answer;
  return rec;
}

// ---- main ----
const report = { startedAt: new Date().toISOString(), model: REAL_MODEL_ID, suites: {}, summary: {} };
let obsidian;
try {
  console.log(`benchmark v1: ${REAL_MODEL_ID} @ ${REAL_BASE_URL}, suites=[${SUITES.join(",")}]`);
  if (SKIP_PHASE_A) {
    obsidian = await connectObsidian(debugPort);
    console.log("phase A skipped, vault:", await obsidian.evaluate("app.vault.getName()"));
  } else {
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
    console.log("secret injected, readback length:", keyLen);
  }
  const evaluate = (expression) => obsidian.evaluate(expression);
  console.log(await evaluate(makeSetupEval({
    baseUrl: REAL_BASE_URL, model: REAL_MODEL_ID, keySecret: REAL_SECRET_NAME,
  })));

  const allTurns = []; // 汇总打分统计

  // ===== CORE =====
  if (SUITES.includes("core")) {
    console.log("\n##### SUITE core #####");
    const cases = GOLD.suites.core.cases.filter(
      (c) => !ONLY_CASES.length || ONLY_CASES.includes(c.case_id),
    );
    const out = [];
    report.suites.core = out;
    for (const c of cases) {
      console.log(`\n-- ${c.case_id}: ${c.question}`);
      console.log("  clear:", await evaluate(CLEAR_CHAT));
      const t = await runTurn(obsidian, evaluate, c, c.case_id, true);
      console.log(`  wait: ${t.wait}`);
      const rec = { case_id: c.case_id, question: c.question, tags: c.tags || [], ...t };
      out.push(rec);
      if (t.wait !== "answer-shown") { rec.error = "timeout"; continue; }
      await delay(3000);
      Object.assign(rec, await analyzeTurn(evaluate, c, rec, `core/${c.case_id}`));
      allTurns.push(rec);
    }
  }

  // ===== ROUTING =====
  if (SUITES.includes("routing")) {
    console.log("\n##### SUITE routing #####");
    const cases = GOLD.suites.routing.cases;
    const out = [];
    report.suites.routing = out;
    for (const c of cases) {
      console.log(`\n-- ${c.case_id}: ${c.question}`);
      console.log("  clear:", await evaluate(CLEAR_CHAT));
      const t = await runTurn(obsidian, evaluate, c, c.case_id, true);
      console.log(`  wait: ${t.wait}`);
      const rec = { case_id: c.case_id, question: c.question, ...t };
      out.push(rec);
      if (t.wait !== "answer-shown") { rec.error = "timeout"; continue; }
      await delay(3000);
      Object.assign(rec, await analyzeTurn(evaluate, { ...c, required: {}, hard_negative: {}, expected_action: null }, rec, `routing/${c.case_id}`));
      // routing 专属：current/ideal 双预期
      const lf = rec._lf;
      if (lf) {
        const parsed = mergeParsed(parseEvidenceChunks(lf.evidence || ""), parseMetaEvidence(lf.meta.retrievedEvidence));
        const retrievalHappened = (lf.toolRows.length - (lf.archiveUsed ? 1 : 0)) > 0 || parsed.retrieved.length > 0;
        const actual = deriveAction(retrievalHappened, parsed, [], Number(lf.meta.sourceCount || 0));
        rec.actual_action = actual;
        rec.action_current_ok = actionMatches(c.expected_action_current, actual);
        rec.action_ideal_ok = actionMatches(c.expected_action_ideal, actual);
        if (lf.root) {
          await postScore(lf.root.trace_id, "retrieval_action_accuracy", rec.action_current_ok ? 1 : 0,
            `bench-v1 routing/${c.case_id} current-policy expectation`);
        }
        console.log(`  action: ${actual} (current_ok=${rec.action_current_ok}, ideal_ok=${rec.action_ideal_ok})`);
      }
      allTurns.push(rec);
    }
  }

  // ===== MULTI / INSIGHT（insight=潜在困惑套件，流程同 multi，金标多 latent 字段）=====
  if (SUITES.includes("multi") || SUITES.includes("insight")) {
    console.log("\n##### SUITE multi/insight #####");
    const scenarios = [
      ...(SUITES.includes("multi") ? GOLD.suites.multi.scenarios : []),
      ...(SUITES.includes("insight") ? (GOLD.suites.insight?.scenarios || []) : []),
    ].filter((sc) => !ONLY_SETS.length || ONLY_SETS.some((prefix) => sc.scenario_id.startsWith(prefix)));
    const out = [];
    report.suites.multi = out;
    for (const sc of scenarios) {
      console.log(`\n=== ${sc.scenario_id} (${sc.topic}) ===`);
      console.log("  clear:", await evaluate(CLEAR_CHAT));
      const rec = { scenario_id: sc.scenario_id, topic: sc.topic, turns: [] };
      out.push(rec);
      const priorChunks = [];
      for (const turn of sc.turns) {
        console.log(`  -- T${turn.turn}: ${turn.question}`);
        const t = await runTurn(obsidian, evaluate, turn, `${sc.scenario_id}/T${turn.turn}`, turn.turn === 1, turn.turn === 1 ? sc.seed : null);
        if (t.seed) console.log("     seeded:", JSON.stringify(t.seed));
        if (t.seed_error) { console.log(`     seed FAILED: ${t.seed_error}`); break; }
        console.log(`     wait: ${t.wait}`);
        const tr = { turn: turn.turn, question: turn.question, ...t };
        if (turn.latent_confusion || turn.judge) {
          tr.gold_latent = {
            scenario: sc.latent_confusion || "",
            expected_reveal_turn: sc.expected_reveal_turn || null,
            judge: turn.judge || [],
            judge_note: turn.judge_note || "",
          };
        }
        rec.turns.push(tr);
        if (t.wait !== "answer-shown") { tr.error = tr.error || "timeout"; break; }
        await delay(3000);
        Object.assign(tr, await analyzeTurn(evaluate, turn, tr, `multi/${sc.scenario_id}/T${turn.turn}`, priorChunks));
        if (sc.seed && turn.turn === 1 && Number(tr.message_count || 0) < 6) {
          tr.seed_unverified = `message_count=${tr.message_count}，种子历史疑似未进入对话`;
          console.log(`     ${tr.seed_unverified}`);
        }
        // 更新场景内累计块
        if (tr._lf) {
          const parsedTurn = mergeParsed(
            parseEvidenceChunks(tr._lf.evidence || ""),
            parseMetaEvidence(tr._lf.meta.retrievedEvidence),
          );
          for (const id of parsedTurn.retrieved) {
            if (!priorChunks.includes(id)) priorChunks.push(id);
          }
          tr.prior_chunks = [...priorChunks];
        }
        allTurns.push(tr);
      }
    }
  }

  // ===== READER NOTES（阅读摘录注入，读侧验收）=====
  if (SUITES.includes("reader_notes")) {
    console.log("\n##### SUITE reader_notes（阅读摘录注入：新对话带上已确认认知）#####");
    const scenarios = (GOLD.suites.reader_notes?.scenarios || []).filter(
      (sc) => !ONLY_SETS.length || ONLY_SETS.some((prefix) => sc.scenario_id.startsWith(prefix)),
    );
    const out = [];
    report.suites.reader_notes = out;
    for (const sc of scenarios) {
      console.log(`\n=== ${sc.scenario_id} (${sc.topic}) ===`);
      console.log("  clear:", await evaluate(CLEAR_CHAT));
      const fx = await evaluate(makeFixtureNoteEval(sc.fixture_note_path, sc.fixture_note));
      console.log("  fixture:", fx);
      if (String(fx).startsWith("fixture-timeout")) {
        out.push({ scenario_id: sc.scenario_id, error: "fixture-not-indexed" });
        continue;
      }
      const rec = { scenario_id: sc.scenario_id, topic: sc.topic, turns: [] };
      out.push(rec);
      const priorChunks = [];
      try {
        for (const turn of sc.turns) {
          console.log(`  -- T${turn.turn}: ${turn.question}`);
          const t = await runTurn(obsidian, evaluate, turn, `${sc.scenario_id}/T${turn.turn}`, turn.turn === 1);
          console.log(`     wait: ${t.wait}`);
          const tr = { turn: turn.turn, question: turn.question, ...t };
          if (turn.judge) {
            tr.gold_latent = {
              scenario: sc.latent_confusion || "",
              judge: turn.judge || [],
              judge_note: turn.judge_note || "",
            };
          }
          rec.turns.push(tr);
          if (t.wait !== "answer-shown") { tr.error = tr.error || "timeout"; break; }
          await delay(3000);
          Object.assign(tr, await analyzeTurn(evaluate, turn, tr, `reader_notes/${sc.scenario_id}/T${turn.turn}`, priorChunks));
          // 程序化验收：注入确实发生（trace metadata readerNotes.injected>=1）
          const rn = tr._lf?.meta?.readerNotes || null;
          tr.reader_notes = rn;
          tr.reader_notes_injected = Boolean(rn && Number(rn.injected || 0) > 0);
          if (tr._lf?.root) {
            await postScore(tr._lf.root.trace_id, "reader_notes_injected", tr.reader_notes_injected ? 1 : 0,
              `bench-v1 reader_notes/${sc.scenario_id} meta=${JSON.stringify(rn)}`);
          }
          console.log(`     readerNotes: ${JSON.stringify(rn)} injected=${tr.reader_notes_injected}`);
          allTurns.push(tr);
        }
      } finally {
        console.log("  fixture cleanup:", await evaluate(makeFixtureDeleteEval(sc.fixture_note_path)));
      }
    }
  }

  // ===== STALE =====
  if (SUITES.includes("stale")) {
    console.log("\n##### SUITE stale（开启 web 搜索 provider=kimi）#####");
    console.log(await evaluate(makeSetupEval({
      baseUrl: REAL_BASE_URL, model: REAL_MODEL_ID, keySecret: REAL_SECRET_NAME, webSearch: true,
    })));
    const cases = GOLD.suites.stale.cases;
    const out = [];
    report.suites.stale = out;
    for (const c of cases) {
      console.log(`\n-- ${c.case_id}: ${c.question}`);
      console.log("  clear:", await evaluate(CLEAR_CHAT));
      const t = await runTurn(obsidian, evaluate, c, c.case_id, true);
      console.log(`  wait: ${t.wait}`);
      const rec = { case_id: c.case_id, question: c.question, ...t };
      out.push(rec);
      if (t.wait !== "answer-shown") { rec.error = "timeout"; continue; }
      await delay(3000);
      Object.assign(rec, await analyzeTurn(evaluate, c, rec, `stale/${c.case_id}`));
      // freshness trigger：web sources>0 或答案明示"过时/已变更"
      const trigger = (Number(rec._lf?.meta?.sourceCount || 0) > 0)
        || /过时|已经.{0,4}(变|停|废弃|更新)|截至|现在.{0,6}不再|sunset/i.test(rec.answer || "");
      rec.freshness_trigger = trigger;
      console.log(`  freshness_trigger: ${trigger}`);
      allTurns.push(rec);
    }
    // 恢复关闭 web 搜索
    console.log(await evaluate(makeSetupEval({
      baseUrl: REAL_BASE_URL, model: REAL_MODEL_ID, keySecret: REAL_SECRET_NAME,
    })));
  }

  // ---- 汇总 ----
  const scored = allTurns.filter((t) => t.metrics);
  const actionScored = scored.filter((t) => t.action_ok === true || t.action_ok === false);
  const recallScored = scored.filter((t) => typeof t.metrics?.recall === "number");
  const ndcgScored = scored.filter((t) => typeof t.metrics?.ndcg === "number");
  const citeScored = scored.filter((t) => typeof t.citation_ok === "boolean");
  const abstainScored = scored.filter((t) => typeof t.abstain_ok === "boolean");
  const routingCases = (report.suites.routing || []).filter((t) => typeof t.action_current_ok === "boolean");
  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
  report.summary = {
    turns_total: allTurns.length,
    turns_answered: allTurns.filter((t) => t.wait === "answer-shown").length,
    action_accuracy: avg(actionScored.map((t) => (t.action_ok ? 1 : 0))),
    action_scored_n: actionScored.length,    routing_action_current: avg(routingCases.map((t) => (t.action_current_ok ? 1 : 0))),
    routing_action_ideal: avg(routingCases.map((t) => (t.action_ideal_ok ? 1 : 0))),
    recall: avg(recallScored.map((t) => t.metrics.recall)),
    recall_n: recallScored.length,
    ndcg: avg(ndcgScored.map((t) => t.metrics.ndcg)),
    ndcg_n: ndcgScored.length,
    mrr: avg(recallScored.map((t) => t.metrics.mrr)),
    precision: avg(ndcgScored.map((t) => t.metrics.precision)),
    noise_ratio: avg(ndcgScored.map((t) => t.metrics.noise_ratio)),
    citation_verifiability: avg(citeScored.map((t) => (t.citation_ok ? 1 : 0))),
    citation_n: citeScored.length,
    citation_failures: citeScored.filter((t) => !t.citation_ok).map((t) => ({ id: t.case_id || `${t.scenario}/T${t.turn}`, bad: (t.citations || []).filter((x) => !x.ok) })),
    abstention: abstainScored.length ? avg(abstainScored.map((t) => (t.abstain_ok ? 1 : 0))) : null,
    abstention_n: abstainScored.length,
    freshness_trigger: (report.suites.stale || []).filter((t) => t.freshness_trigger).length,
    freshness_n: (report.suites.stale || []).length,
    reader_notes_n: allTurns.filter((t) => typeof t.reader_notes_injected === "boolean").length,
    reader_notes_injected_rate: avg(
      allTurns.filter((t) => typeof t.reader_notes_injected === "boolean").map((t) => (t.reader_notes_injected ? 1 : 0)),
    ),
  };
  // 引文陷阱抵抗率：quote-trap 标记的 case 中，硬负例块（A15 等）未进入最终证据的比例
  const trapCases = allTurns.filter(
    (t) => (t.tags || []).includes("quote-trap") && t.metrics && Array.isArray(t.hard_negative_keys),
  );
  report.summary.trap_resistance = avg(
    trapCases.map((t) =>
      t.hard_negative_keys.some((key) => (t.metrics.bench_chunks || []).includes(key)) ? 0 : 1,
    ),
  );
  report.summary.trap_n = trapCases.length;
  for (const t of allTurns) delete t._lf; // 内部对象不进报告

  const outDir = joinPath(process.cwd(), "runs");
  mkdirSync(outDir, { recursive: true });
  const outPath = joinPath(outDir, `benchmark-v1-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nresults written: ${outPath}`);
  console.log("\n===== BENCHMARK v1 SUMMARY =====");
  console.log(JSON.stringify(report.summary, null, 2));
} finally {
  if (obsidian) obsidian.close();
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}

// 单轮/多轮共用的取证+打分（priorChunks 用于动作推导；单轮传 undefined）
async function analyzeTurn(evaluate, goldTurn, rec, label, priorChunks = []) {
  const lf = await fetchTurnFromLangfuse();
  rec._lf = lf;
  if (!lf.root) { rec.error = "trace not found"; return rec; }
  const evidence = lf.evidence;
  const parsed = mergeParsed(
    parseEvidenceChunks(evidence),
    parseMetaEvidence(lf.meta.retrievedEvidence),
  );
  const retrievalHappened = (lf.toolRows.length - (lf.archiveUsed ? 1 : 0)) > 0 || parsed.retrieved.length > 0;
  rec.trace_url = `${langfuseHost}/project/${PROJECT_ID}/traces/${lf.root.trace_id}`;
  rec.session_id = lf.root.session_id;
  rec.turn_index = lf.meta.turnIndex;
  rec.resolved_query = lf.meta.resolvedQuery || "";
  rec.relation = lf.meta.relation || "";
  rec.retrieved_paths = lf.meta.retrievedPaths || [];
  rec.web_source_count = Number(lf.meta.sourceCount || 0);
  rec.tokens = lf.usage;
  rec.duration_ms = lf.durationMs;
  rec.message_count = lf.messageCount;
  rec.archive_used = Boolean(lf.archiveUsed);
  rec.metrics = computeMetrics(goldTurn, parsed);
  rec.evidence = evidence; // 留档：便于离线复核块级解析
  if (goldTurn.hard_negative && Object.keys(goldTurn.hard_negative).length) {
    rec.hard_negative_keys = Object.keys(goldTurn.hard_negative);
  }
  const actual = deriveAction(retrievalHappened, parsed, priorChunks, rec.web_source_count);
  rec.actual_action = actual;
  rec.action_ok = actionMatches(goldTurn.expected_action, actual);
  // citation 核验
  try {
    rec.citations = await evaluate(makeCitationEval(rec.answer));
    rec.citation_ok = (rec.citations || []).every((x) => x.ok);
  } catch (e) {
    rec.citation_error = e.message;
  }
  // abstention（heuristic）
  if (goldTurn.abstention) {
    const marker = ABSTAIN_MARKERS.some((mk) => (rec.answer || "").includes(mk));
    rec.abstain_ok = marker && (rec.citation_ok !== false);
  }
  // Langfuse 打分
  const tid = lf.root.trace_id;
  if (rec.action_ok !== null && rec.action_ok !== undefined) {
    await postScore(tid, "retrieval_action_accuracy", rec.action_ok ? 1 : 0, `bench-v1 ${label} actual=${actual}`);
  }
  if (typeof rec.metrics.recall === "number") {
    await postScore(tid, "recall_at_k", Number(rec.metrics.recall.toFixed(3)), `bench-v1 ${label} chunks=[${parsed.bench.join(",")}]`);
    await postScore(tid, "ndcg_at_k", rec.metrics.ndcg === null ? 0 : Number(rec.metrics.ndcg.toFixed(3)), `bench-v1 ${label}`);
  }
  if (typeof rec.citation_ok === "boolean") {
    await postScore(tid, "citation_verifiability", rec.citation_ok ? 1 : 0, `bench-v1 ${label}`);
  }
  if (typeof rec.abstain_ok === "boolean") {
    await postScore(tid, "unsupported_abstention", rec.abstain_ok ? 1 : 0, `bench-v1 ${label}`);
  }
  console.log(`  [${label}] action=${actual}(ok=${rec.action_ok}) recall=${rec.metrics.recall} ndcg=${rec.metrics.ndcg?.toFixed(2)} cite=${rec.citation_ok} chunks=[${parsed.bench.join(",")}] other=[${parsed.other.join(";")}]`);
  return rec;
}
