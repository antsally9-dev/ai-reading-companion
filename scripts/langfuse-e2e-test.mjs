// End-to-end telemetry verification: drive a real Obsidian question through
// the plugin, then assert the Langfuse trace.
//
// Usage:
//   node scripts/langfuse-e2e-test.mjs \
//     --langfuse-host http://localhost:3000 \
//     --public-key pk-lf-... --secret-key sk-lf-... [--debug-port 9223] \
//     [--turns 2] [--real-model]
//
// 默认模式：mock 模型服务器（验证遥测管道，零费用、确定性）。
// --real-model：从当前打开的正式库 SecretStorage 提取 API key（仅内存中转，
//   不落盘不打印），切到 demo vault 后接真实模型（默认 Kimi 正式库同款配置），
//   断言改为"真实行为"（模型是否调检索、检索是否命中、真实用量/耗时），
//   并给每根 trace 打真实的 retrieval_hit 评分。
//
// Requires: demo vault "arc-demo-vault" registered in obsidian.json with the
// plugin's main.js/manifest.json/styles.css installed, and Obsidian running
// with --remote-debugging-port.

import { createServer, get, request } from "node:http";
import { execFile, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join as joinPath } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}
const langfuseHost = arg("langfuse-host", "http://localhost:3000").replace(/\/+$/, "");
const publicKey = arg("public-key");
const secretKey = arg("secret-key");
const debugPort = Number(arg("debug-port", 9223));
const REAL_MODEL = process.argv.includes("--real-model");
const REAL_BASE_URL = arg("real-base-url", "https://api.kimi.com/coding/v1");
const REAL_MODEL_ID = arg("real-model-id", "kimi-k3");
const REAL_SECRET_NAME = arg("real-secret-name", "key");
const EXPECTED_PATH_SNIPPET = "间隔重复";
if (!publicKey || !secretKey) {
  console.error("Missing --public-key / --secret-key");
  process.exit(1);
}

// ---- mock model server: 奇数次命中返 tool_calls（每轮第 1 次调用），偶数次返最终回答 ----
const TURNS = Math.max(1, Math.min(3, Number(arg("turns", "1"))));
const TURN1_QUESTION = "帮我查找笔记：间隔重复的核心原理是什么？";
const TURN2_QUESTION = "再帮我查找笔记：间隔重复和艾宾浩斯遗忘曲线是什么关系？";
const TURN1_ANSWER =
  "根据本地笔记：间隔重复是在记忆即将消退时安排复习，利用遗忘先快后慢的规律拉长复习间隔。";
const TURN2_ANSWER =
  "根据两轮对话的笔记证据：间隔重复与艾宾浩斯遗忘曲线相互印证，遗忘先快后慢，复习间隔随之拉长。";
let modelHits = 0;
const requestBodies = [];
let modelServer = null;
let modelPort = 0;
if (!REAL_MODEL) {
  modelServer = createModelServer();
  await new Promise((res, rej) => modelServer.once("error", rej).listen(0, "127.0.0.1", res));
  modelPort = modelServer.address().port;
  console.log(`mock model server on ${modelPort} (turns=${TURNS})`);
} else {
  console.log(`real model mode: ${REAL_MODEL_ID} @ ${REAL_BASE_URL}`);
}

function createModelServer() {
  return createServer((req, res) => {
    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      modelHits += 1;
      requestBodies.push(JSON.parse(body || "{}"));
      const hasTools = Array.isArray(requestBodies.at(-1).tools) && requestBodies.at(-1).tools.length > 0;
      res.writeHead(200, { "Content-Type": "application/json" });
      if (modelHits % 2 === 1 && hasTools) {
        const query = modelHits === 1 ? "间隔重复" : "间隔重复 艾宾浩斯遗忘曲线";
        res.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{
                id: `call_test_${modelHits}`,
                type: "function",
                function: { name: "RetrieveKnowledgeEvidence", arguments: JSON.stringify({ query }) },
              }],
            },
            finish_reason: "tool_calls",
          }],
          usage: { prompt_tokens: 321, completion_tokens: 18, total_tokens: 339 },
        }));
      } else {
        const answer = modelHits <= 2 ? TURN1_ANSWER : TURN2_ANSWER;
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2105, completion_tokens: 96, total_tokens: 2201 },
        }));
      }
    });
  });
}

// ---- minimal http helpers (no deps) ----
function httpGetJson(url, headers = {}) {
  return new Promise((res, rej) => {
    get(url, { headers }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on("error", rej);
  });
}

function langfuseHeaders() {
  return { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` };
}

// ---- CDP plumbing ----
async function connectObsidian(port) {
  let pages;
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
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval failed");
    }
    return r.result.value;
  };
  return { evaluate, send, close: () => socket.close() };
}

// 杀掉 Obsidian → 等进程树完全消失 → obsidian.json 只留 demo vault 的 open
// 标记 → 带调试端口重启（Obsidian 退出时会回写 obsidian.json，必须等它死透再改）
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

// 首轮：打开笔记、选中文本、触发"问 AI"；追问轮：复用已打开的聊天视图直接提交
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

function makeWaitEval(snippet) {
  return `
(async () => {
  for (let i = 0; i < 40; i += 1) {
    const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
    const view = leaf && leaf.view;
    if (view && !view.isRequesting && view.contentEl.innerText.includes(${JSON.stringify(snippet)})) {
      return "answer-shown";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "timeout";
})()`;
}

try {
  // ---- 连接 Obsidian（real-model 模式先从正式库提取 key，再切 demo vault）----
  let obsidian;
  if (REAL_MODEL) {
    obsidian = await connectObsidian(debugPort);
    const vaultName = await obsidian.evaluate("app.vault.getName()");
    console.log("phase A vault:", vaultName);
    const apiKey = await obsidian.evaluate(
      `(app.secretStorage.getSecret(${JSON.stringify(REAL_SECRET_NAME)}) || "")`,
    );
    if (!apiKey) {
      throw new Error(`secret ${REAL_SECRET_NAME} not found in vault "${vaultName}" — open the real vault first`);
    }
    console.log(`api key extracted from "${vaultName}" (len=${apiKey.length}, stays in memory only)`);
    obsidian.close();
    await swapToDemoVault();
    obsidian = await connectObsidian(debugPort);
    const keyLen = await obsidian.evaluate(
      `(async () => { await app.secretStorage.setSecret(${JSON.stringify(REAL_SECRET_NAME)}, ${JSON.stringify(apiKey)}); return String(app.secretStorage.getSecret(${JSON.stringify(REAL_SECRET_NAME)}) || "").length; })()`,
    );
    console.log("secret injected into demo vault, readback length:", keyLen);
    console.log(await obsidian.evaluate(makeSetupEval({
      baseUrl: REAL_BASE_URL,
      model: REAL_MODEL_ID,
      keySecret: REAL_SECRET_NAME,
    })));
  } else {
    obsidian = await connectObsidian(debugPort);
    console.log(await obsidian.evaluate(makeSetupEval({
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      model: "telemetry-test",
      keySecret: "",
    })));
  }
  const evaluate = (expression) => obsidian.evaluate(expression);

  // 真实模型没有预定文案，等到"本轮问题的 assistant 消息有内容且不在请求中"
  const waitReal = async (questionSnippet) => {
    const result = await evaluate(`(async () => {
      for (let i = 0; i < 200; i += 1) {
        const leaf = app.workspace.getLeavesOfType("ai-reading-companion-chat")[0];
        const view = leaf && leaf.view;
        if (!view) { await new Promise((r) => setTimeout(r, 500)); continue; }
        const last = [...(view.messages || [])].reverse().find(
          (m) => m.role === "assistant" && String(m.question || "").includes(${JSON.stringify(questionSnippet)}),
        );
        if (!view.isRequesting && last && String(last.content || "").trim().length > 0) {
          return "answer-shown";
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return "timeout";
    })()`);
    return result;
  };

  console.log(await evaluate(CLEAR_CHAT));
  console.log(await evaluate(makeAskEval(TURN1_QUESTION, true)));
  const wait1 = REAL_MODEL
    ? await waitReal("核心原理")
    : await evaluate(makeWaitEval(TURN1_ANSWER));
  console.log("turn1 wait:", wait1);
  if (wait1 !== "answer-shown") throw new Error("turn1 answer did not arrive");
  if (TURNS >= 2) {
    console.log(await evaluate(makeAskEval(TURN2_QUESTION, false)));
    const wait2 = REAL_MODEL
      ? await waitReal("艾宾浩斯")
      : await evaluate(makeWaitEval(TURN2_ANSWER));
    console.log("turn2 wait:", wait2);
    if (wait2 !== "answer-shown") throw new Error("turn2 answer did not arrive");
  }
  await delay(4000); // let the telemetry flush finish

  // ---- verify in Langfuse ----
  // v4 events_only 部署禁用了 v2 公开读取 API（/api/public/traces 返回 404），
  // 因此直接查询 ClickHouse 事件表 events_full（等价于 UI  reads 的数据源）。
  const PROJECT_ID = "cmudl5ufk0006p0076vs4i8ix";
  function chQuery(sql) {
    return new Promise((res, rej) => {
      execFile(
        "docker",
        ["exec", "langfuse-clickhouse-1", "clickhouse-client", "-q", sql, "--format", "JSONEachRow"],
        { maxBuffer: 16 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return rej(new Error(`clickhouse query failed: ${stderr || err.message}`));
          res(stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)));
        },
      );
    });
  }

  const rootRows = await chQuery(
    `select trace_id, session_id, start_time, metadata_names, metadata_values ` +
    `from events_full where project_id='${PROJECT_ID}' and trace_name='ask-question' and is_app_root=1 ` +
    `and start_time > now() - interval 10 minute order by start_time desc limit ${TURNS + 1}`,
  );
  const latestRoot = rootRows[0];
  if (!latestRoot) throw new Error("no ask-question trace found in Langfuse events table");
  const traceId = latestRoot.trace_id;
  // ClickHouse 把 metadata 存成两个平行数组，zip 回来；嵌套 key 以点路径拍平
  // （contextDigest.turnIndex），按路径还原成对象；JSON / 布尔字符串自动转换
  const metaOf = (row) => {
    const out = {};
    (row.metadata_names || []).forEach((name, i) => {
      let value = (row.metadata_values || [])[i];
      if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
        try { value = JSON.parse(value); } catch { /* 保留字符串 */ }
      } else if (value === "true") {
        value = true;
      } else if (value === "false") {
        value = false;
      }
      const keys = name.split(".");
      let cursor = out;
      keys.slice(0, -1).forEach((key) => {
        if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
        cursor = cursor[key];
      });
      cursor[keys[keys.length - 1]] = value;
    });
    return out;
  };
  const latestMeta = metaOf(latestRoot);
  const latestDigest = latestMeta.contextDigest || {};

  const observations = await chQuery(
    `select name, type, is_app_root, usage_details, input, output, session_id, status_message, start_time, end_time ` +
    `from events_full where project_id='${PROJECT_ID}' and trace_id='${traceId}'`,
  );
  const rootRow = observations.find((o) => Number(o.is_app_root) === 1) || observations[0];
  const generations = observations.filter((o) => o.type === "GENERATION");
  const toolSpans = observations.filter(
    (o) => o.type === "SPAN" && o.name.startsWith("tool:"),
  );
  const usageOf = (row) => {
    if (!row.usage_details) return {};
    if (typeof row.usage_details === "string") {
      try { return JSON.parse(row.usage_details); } catch { return {}; }
    }
    return row.usage_details;
  };
  const durationMs = rootRow.start_time && rootRow.end_time
    ? new Date(String(rootRow.end_time).replace(" ", "T")) - new Date(String(rootRow.start_time).replace(" ", "T"))
    : 0;
  const retrievalEvidence = toolSpans.length
    ? String(toolSpans[0].output || "")
    : "";
  const retrievalPathHit = Array.isArray(latestMeta.retrievedPaths) &&
    latestMeta.retrievedPaths.some((p) => String(p).includes(EXPECTED_PATH_SNIPPET));

  const checks = {
    trace_found: true,
    trace_has_question_input: String(rootRow.input || "").includes("间隔重复"),
    trace_has_session_id: String(rootRow.session_id || "").length > 0,
    generation_names: generations.map((g) => g.name),
    total_input_tokens: generations.reduce((s, g) => s + Number(usageOf(g).input || 0), 0),
    total_output_tokens: generations.reduce((s, g) => s + Number(usageOf(g).output || 0), 0),
    duration_ms: durationMs,
    // contextDigest / turnIndex 埋点（方案 B）
    turn_index_recorded: Number(latestMeta.turnIndex) === TURNS,
    context_digest_present: Array.isArray(latestDigest.historyTurns),
    selected_passage_recorded: Boolean(latestDigest.selectedPassage?.present),
    retrieved_paths: Array.isArray(latestMeta.retrievedPaths) ? latestMeta.retrievedPaths : [],
  };
  if (REAL_MODEL) {
    // 真实行为断言：不预设模型会怎么做，只记录并验证底线
    checks.generations_present = generations.length >= 1;
    checks.generation_has_usage = generations.length >= 1 &&
      generations.every((g) => {
        const u = usageOf(g);
        return Number(u.input) > 0 && Number(u.output) > 0;
      });
    checks.retrieval_called = toolSpans.length >= 1;
    checks.retrieval_evidence_nonempty = !toolSpans.length ||
      !retrievalEvidence.includes("No directly relevant passages");
    checks.retrieval_path_hit = retrievalPathHit;
  } else {
    checks.two_generations = generations.length === 2;
    checks.generation_has_usage = generations.length === 2 &&
      generations.every((g) => {
        const u = usageOf(g);
        return Number(u.input) > 0 && Number(u.output) > 0;
      });
    checks.one_tool_span = toolSpans.length === 1 && toolSpans[0].name === "tool:RetrieveKnowledgeEvidence";
    checks.tool_span_has_query = toolSpans.length === 1 && String(toolSpans[0].input || "").includes("间隔重复");
    checks.retrieved_paths_recorded = Array.isArray(latestMeta.retrievedPaths) && latestMeta.retrievedPaths.length > 0;
  }

  // 多轮专属检查：两根 trace 同 session、turn2 携带 turn1 摘要
  let prevRoot = null;
  if (TURNS >= 2) {
    prevRoot = rootRows.find((row) => row.trace_id !== traceId);
    const prevMeta = prevRoot ? metaOf(prevRoot) : {};
    const prevDigest = prevMeta.contextDigest || {};
    const history = Array.isArray(latestDigest.historyTurns) ? latestDigest.historyTurns : [];
    checks.same_session_across_turns = Boolean(
      latestRoot.session_id && prevRoot && latestRoot.session_id === prevRoot.session_id,
    );
    checks.turn1_has_index_1 = Number(prevMeta.turnIndex) === 1;
    checks.turn1_empty_history = Array.isArray(prevDigest.historyTurns) && prevDigest.historyTurns.length === 0;
    checks.turn2_carries_turn1_digest = history.length === 1 &&
      String(history[0].question || "").includes("间隔重复的核心原理") &&
      (REAL_MODEL
        ? String(history[0].answer || "").trim().length > 0
        : String(history[0].answer || "").includes("遗忘先快后慢"));
    checks.turn1_retrieved_paths = Array.isArray(prevMeta.retrievedPaths) &&
      prevMeta.retrievedPaths.some((p) => String(p).includes(EXPECTED_PATH_SNIPPET));
  }

  // score the traces via the legacy ingestion score event (v4 events_only 仍接受)
  // mock 模式打流程分 retrieval_used；真实模式打评测分 retrieval_hit（检索是否命中期望笔记）
  const SCORE_NAME = REAL_MODEL ? "retrieval_hit" : "retrieval_used";
  const prevMetaForScore = prevRoot ? metaOf(prevRoot) : {};
  const scoreValueFor = (meta) => (REAL_MODEL
    ? (Array.isArray(meta.retrievedPaths) && meta.retrievedPaths.some((p) => String(p).includes(EXPECTED_PATH_SNIPPET)) ? 1 : 0)
    : 1);
  const scoredPairs = [
    [latestRoot, latestMeta],
    ...(prevRoot ? [[prevRoot, prevMetaForScore]] : []),
  ];
  const now = Date.now();
  const scoreBody = JSON.stringify({
    batch: scoredPairs.map(([row, meta], i) => ({
      type: "score-create",
      id: `score-${now}-${i}`,
      timestamp: new Date().toISOString(),
      body: {
        id: `score-body-${now}-${i}`,
        traceId: row.trace_id,
        name: SCORE_NAME,
        value: scoreValueFor(meta),
        comment: REAL_MODEL
          ? "real eval: retrievedPaths contains expected note"
          : "e2e: model called RetrieveKnowledgeEvidence and answered from it",
      },
    })),
  });
  await new Promise((res, rej) => {
    const req = request(`${langfuseHost}/api/public/ingestion`, {
      method: "POST",
      headers: { ...langfuseHeaders(), "Content-Type": "application/json" },
    }, (r) => { r.resume(); r.on("end", res); });
    req.on("error", rej);
    req.end(scoreBody);
  });
  // score 经 worker 异步落库，轮询最多 30 秒
  let scoreCount = 0;
  for (let i = 0; i < 10; i += 1) {
    await delay(3000);
    const scoreRows = await chQuery(
      `select count() as c from scores where project_id='${PROJECT_ID}' and trace_id='${traceId}' and name='${SCORE_NAME}'`,
    );
    scoreCount = Number(scoreRows[0]?.c || 0);
    if (scoreCount >= 1) break;
  }
  checks.score_recorded = scoreCount >= 1;

  console.log("\n=== LANGFUSE E2E CHECKS ===");
  console.log(JSON.stringify(checks, null, 2));
  for (const row of [latestRoot, prevRoot].filter(Boolean)) {
    console.log(`trace url: ${langfuseHost}/project/${PROJECT_ID}/traces/${row.trace_id}`);
  }
  const failed = Object.entries(checks).filter(([k, v]) => v === false).map(([k]) => k);
  if (failed.length) {
    console.error("FAILED CHECKS:", failed.join(", "));
    process.exitCode = 1;
  } else {
    console.log("ALL CHECKS PASSED");
  }
} finally {
  if (typeof obsidian !== "undefined" && obsidian) obsidian.close();
  if (modelServer) modelServer.close();
  // CDP WebSocket 会挂住 node 事件循环导致进程不退出；清理完后强制退出
  setTimeout(() => process.exit(process.exitCode || 0), 500);
}
