# 用 Langfuse 测评 AI Reading Companion：步骤、结论与教程

> 日期：2026-09-23 ｜ Langfuse 自托管 v4.41.0 ｜ 插件 v1.2.1+
> 目标：给插件接入 Langfuse 遥测，跑一次真实端到端测试验证管线正确性，并借此学会"怎么用 Langfuse 做测评"。

---

## 一、结论（TL;DR）

端到端测试**全部通过**。在 Obsidian 里对选中文本提问「帮我查找笔记：间隔重复的核心原理是什么？」，插件完整走了一遍"规划 → 检索工具调用 → 回答"的链路，Langfuse 收到了结构正确的遥测数据：

| 检查项 | 结果 |
|---|---|
| trace `ask-question`（含问题文本、session id） | ✅ |
| 2 次模型调用（generation）`model:initial_answer` + `model:tool_followup` | ✅ |
| 每次调用的 token 用量（input/output/total） | ✅ 合计 2426 in / 114 out |
| 1 个工具调用 span `tool:RetrieveKnowledgeEvidence`（含检索词 `间隔重复`） | ✅ |
| 通过 API 打的评分 score `retrieval_used=1` | ✅ |

实测 trace（可在 Langfuse UI 打开）：
`http://localhost:3000/project/cmudl5ufk0006p0076vs4i8ix/traces/f37443d6e7068b10f0171306ab374215`

本次测试最重要的**过程结论**：Langfuse v4 默认 `events_only` 模式，网上大部分教程基于 v3 的写法（旧 `/api/public/ingestion` 批量事件 API + `/api/public/traces` 读取 API）**已经不能直接用了**。v4 的原生写入路径是 OTLP，读取靠 UI 或数据库。踩坑与解法全部记录在第五节，这是本次学习价值最大的部分。

---

## 二、Langfuse 核心概念（测评前必须建立的模型）

Langfuse 是 LLM 可观测性/评测平台，核心数据模型只有四种对象：

| 对象 | 含义 | 在本插件里的对应 |
|---|---|---|
| **Trace** | 一次完整请求的顶层容器（一次提问） | 一轮"问 AI" |
| **Generation** | 一次对模型的调用（带 model、input/output、token 用量） | planning / initial_answer / tool_followup / subquestion / synthesis |
| **Span** | 任意一段工作（工具调用、子步骤） | 每次工具调用 `tool:<名字>` |
| **Score** | 挂在 trace 或 observation 上的评分（数值/布尔/分类） | `retrieval_used=1`、检索命中率、答案质量分 |

层级关系：`Trace ⊃ Generation/Span`，子级用 parent 指针挂到父级上。
测评的本质 = **让每次运行产生一条完整 trace，然后给 trace 打 score，最后聚合 score 看趋势**。

Langfuse 的服务端架构（自托管 docker compose）：

```
langfuse-web (:3000)   ←→ 浏览器 UI + 公开 API
langfuse-worker        ←→ 异步消费上报事件，写入 ClickHouse
postgres               ←→ 项目/用户/配置
clickhouse             ←→ 遥测数据主存储（v4: events_full / scores 表）
redis / minio          ←→ 队列 / 对象存储
```

上报是**异步**的：HTTP 202 受理 → 进 redis 队列 → worker 落库。所以"打完后立刻查"可能查不到，要等几秒到几十秒（本次 score 落库约 30 秒）。

---

## 三、环境清单（本次实测环境）

| 项 | 值 |
|---|---|
| Langfuse 部署 | `D:\zcode工作区\学习agent\langfuse\docker-compose.yml`（v4.41.0，`langfuse:4` / `langfuse-worker:4`） |
| Web UI / API | http://localhost:3000 |
| Org / Project | `personal` / `ai-reading-companion` (cmudl5ufk0006p0076vs4i8ix) |
| API Keys | Langfuse UI → Settings → API Keys（本项目已建一对，sk 只显示一次，遗失就重建） |
| 测评用 vault | `C:\Users\WINDOWS\Documents\arc-demo-vault`（专用测试库，别用真库） |
| 插件遥测代码 | `src/langfuse-telemetry.ts`（零依赖 OTLP 客户端） |
| e2e 脚本 | `scripts/langfuse-e2e-test.mjs` |

插件设置项（设置页 → Langfuse telemetry，默认全关）：
`langfuseEnabled` / `langfuseHost` / `langfusePublicKey` / `langfuseSecretKey`。
密钥明文存在 vault 的 `data.json`，**只来自托管实例或一次性测试项目**（设置页有同样提示）。

---

## 四、插件是怎么接入的（源码对照表）

遥测模块 `src/langfuse-telemetry.ts` 对插件其余部分暴露 7 个函数；接线点：

| 插件代码 | 发出的 Langfuse 事件 |
|---|---|
| `main.ts` `askAi()` 开头 | `startLangfuseTrace`（trace 输入=问题文本，metadata=模型/协议/知识范围，sessionId=会话 id） |
| `ask-question-use-case.ts` `requestAssistant()` 每次调模型 | `start/endLangfuseGeneration`（name=`model:<用途>`，model，input=最后一条用户消息摘要，output=回答，usage=token 数） |
| 同文件 `onRuntimeEvent` tool_start/tool_result | `start/endLangfuseSpan`（name=`tool:<工具名>`，input=参数，output=结果前 4000 字符） |
| `main.ts` `askAi()` 成功/失败/finally | `endLangfuseTrace`（output=回答或 error）+ `flushLangfuseTelemetry()` |

发送内容仅限：问题/回答文本、工具名与参数、token 用量。**不发送**笔记正文、本地文件内容、SecretStorage 里的密钥。所有发送失败只 `console.debug`，绝不影响插件功能。

架构上两个值得一提的决定：
1. **零依赖手写 OTLP 客户端**，不引官方 JS SDK——移动端 WebView 兼容性、包体积可控、且每个字段怎么映射完全透明（教学价值）。
2. trace 上下文用模块级单例而不是 AsyncLocalStorage——插件同时只有一个活跃提问，代价可接受（代码注释里明确声明了这个 tradeoff）。

---

## 五、Langfuse v4 的关键现实（本次最大的学习点）

v3 时代的标准写法在 v4 默认配置（`LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only`）下有三处会直接撞墙：

### 坑 1：旧 ingestion API 拒收 trace/span/generation

```
POST /api/public/ingestion  {"batch":[{"type":"trace-create",...}]}
→ 400 "Event type trace-create is not accepted ... when LANGFUSE_MIGRATION_V4_WRITE_MODE is events_only.
     This endpoint only accepts score events."
```

**解法**：trace/span/generation 改走 **OTLP**：

```
POST /api/public/otel/v1/traces
Content-Type: application/json          （也支持 application/x-protobuf）
Authorization: Basic base64(pk:sk)
Body: {"resourceSpans":[{"resource":{...},"scopeSpans":[{"scope":{...},"spans":[...]}]}]}
```

score 事件**仍然**走旧 ingestion API（v4 明确继续接受）——所以遥测模块是"双轨"：span 走 OTLP，score 走旧 API。

### 坑 2：v2 读取 API 整体 404

```
GET /api/public/traces?limit=5        → 404 "not available on deployments running in v4 events_only mode"
GET /api/public/traces/{id}           → 同样 404（代码里 rejectInEventsOnlyMode: true）
```

注意 404 的 body 是 `{"message": "..."}` 而不是 `{"data":[]}`——**解析时别把错误当空结果**（第一版验证脚本就因此静默误判）。

**解法（任选）**：
- 人看：Langfuse UI（v4 原生读 events 表，功能完整）——这是日常用法；
- 脚本查：直连 ClickHouse（见附录 B），本项目的验证脚本就是这么做的；
- 或者把部署改成 `LANGFUSE_MIGRATION_V4_WRITE_MODE=dual`（双写旧表+v2 API 恢复可用，但属过渡模式，Langfuse 官方说将来会移除）——**不推荐**，除非你有大量基于 v2 API 的历史工具。

### 坑 3：trace 的 input/output 要写在"对的地方"

v4 把 trace 拍平进了事件表：trace 在 `events_full` 里体现为 `is_app_root=true` 的那行。三个因此必须遵守的客户端约定：

1. 根 span 要带 `langfuse.internal.is_app_root = "true"`（否则 trace 级字段聚合不到）；
2. trace 的 input/output **同时**写 `langfuse.trace.input` 和 `langfuse.observation.input` 两个属性——前者进 trace 事件，后者进根 span 观测行，而事件表里能查到的是后者；
3. 每次调用一个 span，不要在多事件间共享同一 spanId。

OTLP span → Langfuse 对象的完整属性映射（从服务端源码 `packages/shared/src/server/otel/attributes.ts` 核对）：

| OTLP 属性 | 落到 Langfuse 的字段 |
|---|---|
| `langfuse.trace.name` | trace 名 |
| `langfuse.trace.input` / `langfuse.trace.output` | trace 输入/输出 |
| `langfuse.trace.metadata`（JSON 字符串） | trace metadata |
| `session.id` | session id |
| `langfuse.observation.type` | `GENERATION` / `SPAN` |
| `langfuse.observation.input` / `.output` | 观测的输入/输出 |
| `langfuse.observation.model.name` | generation 的模型名 |
| `langfuse.observation.usage_details`（JSON，如 `{"input":100,"output":50,"total":150}`） | token 用量 |
| `langfuse.observation.level` / `.status_message` | 级别 / 错误信息 |
| `langfuse.internal.is_app_root` | 标记根 span 行承载 trace 数据 |
| span 的 `traceId`/`spanId`/`parentSpanId` | trace / observation id / 父子层级 |

---

## 六、端到端测试步骤（可复现）

整个测试 = **mock 模型服务器**（让每次运行确定性、零 API 费用）+ **CDP 驱动 Obsidian**（真实插件真实 UI）+ **Langfuse 侧断言**。

### 前置条件

1. Langfuse 栈在跑：`cd D:\zcode工作区\学习agent\langfuse && docker compose up -d`
2. 插件已构建并部署到 demo vault 的 `.obsidian/plugins/ai-reading-companion/`（`npm run build` 后拷贝 `main.js`/`manifest.json`/`styles.css`）
3. Obsidian 已注册 demo vault 并关闭其他 vault 的自动打开（`scripts/evaluation/register-demo-vault.py`）

### 步骤

```bash
# 1. 带调试端口启动 Obsidian（CDP 自动化入口）
"D:\software\obsidian\Obsidian.exe" --remote-debugging-port=9223

# 2. 跑 e2e（keys 从 Langfuse UI → Settings → API Keys 取；
#    demo vault 的 .obsidian/plugins/ai-reading-companion/data.json 里也存了一份）
cd D:\codex工作区\其他\ai-reading-companion
node scripts/langfuse-e2e-test.mjs \
  --langfuse-host http://localhost:3000 \
  --public-key pk-lf-... \
  --secret-key sk-lf-... \
  --debug-port 9223
```

### 脚本内部流程

1. 起 mock 模型服务器（本机随机端口）：第 1 次调用返回 `tool_calls`（强制插件走检索工具），后续调用返回固定中文回答 + usage；
2. 通过 CDP 连上 Obsidian：校验 vault 名 → 写入插件设置（custom provider 指向 mock、打开 langfuse 开关）→ 清空聊天记录 → 打开笔记选中一行 → 执行 `ask-ai-about-selection` 命令 → 填入问题 → 提交；
3. 等回答出现后，直接查 ClickHouse `events_full` 断言（见附录 B 的 SQL）；
4. 用旧 ingestion API 给该 trace 打 `retrieval_used=1` 分，轮询 `scores` 表确认落库；
5. 打印 trace URL + 全部检查结果，任一失败 exit 1。

### 本次实测输出

```
trace_found: true            trace_has_question_input: true
trace_has_session_id: true   two_generations: true
generation_names: ["model:initial_answer", "model:tool_followup"]
generation_has_usage: true   one_tool_span: true
tool_span_has_query: true    total_input_tokens: 2426
total_output_tokens: 114     score_recorded: true
ALL CHECKS PASSED
```

数据在 UI 里的样子：Traces 页出现 `ask-question`，点进去是一棵树——根节点 `ask-question`，下面两个 generation（各有 model 名、token 用量）和一个 `tool:RetrieveKnowledgeEvidence` span（input 里能看到检索词），Scores 区有 `retrieval_used`。

---

## 七、从"测试管线"到"做测评"：Langfuse 评测方法论

本次 e2e 验证的是**管线正确性**（数据进对、结构对）。真正的测评是把 gold set（如 T1 的 30 题）批量跑过插件并打分。Langfuse 里 score 有三种典型来源：

1. **程序化打分**（本次演示）：脚本/CI 在运行后调 API 打分，适合确定性指标——检索是否命中（对比 gold 的 expected path/heading）、工具是否被调用、延迟、token 成本。
2. **人工标注**：UI 里打开 trace 直接填分，适合答案质量、风格等主观维度。
3. **LLM-as-judge / Evaluators**：Langfuse 内置评测器，用另一个模型按 rubric 给 trace 打分（自托管 v4 支持；需要配置 judge 模型的连接）。

结合本项目的落地路线（与 `docs/evaluation/T1-retrieval-eval-report.md` 衔接）：

- **短期（不用 Langfuse 也能做）**：T1 的离线评测脚本已经能量化检索命中率（current 76% direct / 54% synonym）。
- **中期（Langfuse 的价值所在）**：把 gold set 的问题逐条通过插件真实提问（复用本次 e2e 的 CDP 驱动），每题一条 trace；用程序化 score 记录"检索是否命中 gold"，用人工/judge score 记录"答案质量"；在 Langfuse 的 Scores 面板按 score 名聚合，直接看到"embedding 改造前后"的对比曲线——这就是 T1 报告里 `proceed_to_embedding` 决策的线上验证手段。
- **长期**：Langfuse v4 的 Datasets + Experiments（把 gold set 建成 dataset，批量跑实验）适合做回归测试，留作下一步探索。

一句话总结 Langfuse 测评范式：**trace 是你的原始证据，score 是你的度量，聚合 score 是你的结论。**

---

## 八、Gold Set 场景测评（2026-09-23 实测）

针对"检索是插件核心"这一目标，按四个疑难场景造了语料 + 多轮问题集，用
`scripts/langfuse-gold-set.mjs`（真实 kimi-k3）跑了三轮对比测评。完整答案与证据在
`runs/gold-set-*.json`。

### 8.1 测试语料（demo vault 的 Reading notes/ 下新增三篇）

| 笔记 | 设计目的 |
|---|---|
| `Agent Context 工程框架.md` | 框架笔记：6 个分区（定义/构成/压缩裁剪/子agent隔离/检索增强/误区），支持框架题→分支追问→综合题 |
| `编程语言中的上下文.md` | 干扰项："上下文"关键词密度高（CFG/作用域/执行上下文），内容与 agent 无关 |
| `笔记方法对比.md` | 多候选块：康奈尔/卡片盒/大纲三个方法块同文件，考"块级选择" |

### 8.2 场景矩阵与三轮设计

| 场景 | 考点 |
|---|---|
| A 语义改述递进 | T2 与 T1 表述完全不同（"装不下"vs"压缩与裁剪"），考换说法也能召回；T3 考前轮内容影响 |
| B 干扰项 | 陷阱题："上下文无关文法对理解 agent context 有帮助吗"，考模型是否被检索偏差带偏 |
| C 块选择 | 同一文件多个候选块，考是否只把最相关的块给模型 |
| D 框架锚定 | 框架题→分支追问→综合题，考回答是否锚定大框架、戳中真问题 |

三轮的区别是**问题句式**：run 1 自然问法、run 2 "我的笔记里有没有讲…"、run 3 "帮我查找笔记：…"。

### 8.3 核心发现

1. **检索路由是第一道闸门，且比想象中窄**（run 1+2：19/20 轮没有触发检索）。
   根因在 `src/knowledge-scope.ts:600` 的工具描述："Use at most once, **only when the user
   explicitly asks to connect, find, or compare existing notes**"。模型把"笔记里有没有讲 X"
   判断为自己能答，只有"帮我查找笔记"这类显式指令才路由到检索。用户不会总用指令句式——
   这是产品决策点：放宽触发条件 vs 保持保守防噪声。
2. **语义改述召回：通过**。run 3 A2"对话太长快装不下"→ 精确召回"压缩与裁剪"块，
   且答案主动回扣 T1（"这就接上了：context window 是硬限制…"）——递进链路工作正常。
3. **干扰项抵抗：模型层通过，检索层未过滤**。A1 检索同时捞回干扰项笔记，模型明确标注
   "那是形式语言理论的 context，属于检索噪音"并弃用；C2 三路径含干扰项，模型逐条说明
   "已忽略"。但检索器本身会把 top-2 里的弱相关/无关块一起返回（C1/A2/D1 都带回了
   无关笔记），"少量精准片段"的过滤依赖模型自觉——与笔记原文自己的主张形成反差，
   是最值得优化的工程点（检索阈值/rerank）。
4. **发现一次"包装性编造"（run 3 A3）**：该轮模型未再检索（沿用对话历史），却把
   基于前轮检索内容的综合**包装成"📖 笔记原文（来源事实）"并引用了一个不存在的
   笔记小节**（`Understanding Context Windows.md#压缩会丢失什么`）。内容实质正确，
   但引用是虚构的。启示：测评时"内容对"不等于"引用真"，trace 级检查要覆盖
   citation faithfulness（可以把每轮引用的小节头与 gold 语料比对）。
5. **"Use at most once"被模型跨轮保守执行**（run 3 的 A3、D2、D3 在追问轮都不再检索），
   靠对话历史里的前轮证据作答。行为合理（省钱省延迟）但把"证据新鲜度"让渡给了
   对话记忆——与发现 4 是同一枚硬币的两面。
6. **诚实性基线良好**：不检索时模型稳定声明"以下是一般知识补充，不是笔记原文"，
   没有假装查过笔记；框架题回答能区分"笔记事实/解释/推断"三层（D-rerun 全通过）。
7. **CDP 驱动踩坑**：Obsidian 窗口被遮挡时页内 `setTimeout` 节流会让等待循环卡死——
   等待循环必须放 node 侧轮询（`waitRealNode`）；首轮 `ask-ai-about-selection` 拉起
   视图时 submit 可能被吞，需检测消息数为空后重试。均已固化在脚本里。

### 8.4 复现命令

```bash
# 第一轮（先让 Obsidian 带调试端口打开正式库 mynotes 取 key，自动切 demo vault）
node scripts/langfuse-gold-set.mjs --langfuse-host http://localhost:3000 \
  --public-key pk-... --secret-key sk-... --debug-port 9223 --search-imperative
# 换句式重跑（demo vault 还开着、key 已注入时）
node scripts/langfuse-gold-set.mjs ... --note-anchored --skip-phase-a
node scripts/langfuse-gold-set.mjs ... --search-imperative --skip-phase-a
# 只重跑某场景
node scripts/langfuse-gold-set.mjs ... --search-imperative --skip-phase-a --only-set D
```

**下一步演进**：结合产品三层定义（找到答案 / 理解真问题 / 重建知识结构）与两轮实测发现，
完整评测体系见 `docs/evaluation/reading-benchmark-v1-design.md`（五层指标架构、基准文章 A01–A14、
CORE/ROUTING/多轮/STALE 四套件、程序化 vs judge 指标清单、分阶段落地计划）。

---

## 附录 A：手工验证用的 curl

```bash
# 发一个 OTLP span（smoke test）
curl -u "pk-lf-...:sk-lf-..." -X POST http://localhost:3000/api/public/otel/v1/traces \
  -H "Content-Type: application/json" \
  -d '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"smoke"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"smoke-root","kind":1,"startTimeUnixNano":"<纳秒时间戳>","attributes":[{"key":"langfuse.trace.name","value":{"stringValue":"otlp-smoke-test"}}]}]}]}]}'

# 打分（v4 仍走旧 ingestion API）
curl -u "pk-lf-...:sk-lf-..." -X POST http://localhost:3000/api/public/ingestion \
  -H "Content-Type: application/json" \
  -d '{"batch":[{"type":"score-create","id":"s1","timestamp":"<ISO8601>","body":{"id":"s1-body","traceId":"<traceId>","name":"my_score","value":1}}]}'
```

## 附录 B：脚本用的 ClickHouse 查询

```bash
docker exec langfuse-clickhouse-1 clickhouse-client -q \
  "select name,type,is_app_root,substring(input,1,60),usage_details,session_id \
   from events_full where project_id='<projectId>' and trace_id='<traceId>'" --format PrettyCompact

docker exec langfuse-clickhouse-1 clickhouse-client -q \
  "select name,value,timestamp from scores where project_id='<projectId>' and trace_id='<traceId>'"
```

## 附录 C：排障速查

| 症状 | 原因 | 解法 |
|---|---|---|
| ingestion 400 "only accepts score events" | v4 events_only 拒收旧事件类型 | span 走 OTLP（第五节坑 1） |
| `/api/public/traces` 404 | v4 禁用 v2 读取 API | UI 或 ClickHouse（坑 2） |
| trace 在 UI 里没有 input/output | 根 span 缺 `is_app_root` / 只写了 `langfuse.trace.input` | 两个属性都写（坑 3） |
| 打完分查不到 | worker 异步落库有延迟 | 轮询等 30 秒 |
| 脚本连不上 Obsidian | 9223 端口没起 / vault 名不对 | 启动参数带 `--remote-debugging-port=9223`；脚本只认 `arc-demo-vault` |
