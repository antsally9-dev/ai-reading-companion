# AI Reading Companion：Agent 架构总结（面试讲述稿）

> 定位：一个 Obsidian 阅读助手插件，从"选中文本问 AI"演进为 **situated reading assistant**——
> 在持续阅读中维护用户的"理解位置"，判断用户真正卡住的概念，把局部问题放回文章整体知识结构。
> 本文按"能对面试官讲清楚"的标准组织：每个设计决策都有动机和数据。

---

## 一、一句话架构

> 系统先理解用户正在读什么、真正在问什么，再决定这一轮找什么证据、从哪里找，把一个干净的
> Working Context 交给模型；Agent 工具循环只做补充检索——而不是把一堆 context 扔给模型让它自己决定用不用工具。

```
用户提问（含选区 anchor）
   ↓
① Query Understanding（规则 resolver + 追问轮 LLM resolver）
   → resolvedQuery / relation / RetrievalPlan / freshness
   ↓
② 确定性初检：按 resolvedQuery 预取证据 → local_evidence 槽位
   ↓
③ 混合检索器（授权文件夹内）：词法 + n-gram 余弦 + 陷阱降权
   ↓
④ Context Builder（8 槽位 + 分段预算 + receipt）
   ↓
⑤ AgentRuntime 工具循环（≤3 轮，只做补充检索/联网验证）
   ↓
⑥ 回答完整性层：证据锚定 + 引用对账后处理（citation sanitizer）
   ↓
答案 + 全链路遥测（Langfuse）
```

## 二、逐层设计决策（每条都对应一次实测数据）

### 1. 路由：从布尔闸门到 Retrieval Planner

- **最初**：正则判断"用户是否显式要求查笔记"，不命中则检索器根本不创建。
- **实测打脸**：自然问法 8 题里 7 题需要笔记证据却全部没触发检索（闸门差距 87.5 个百分点）。
  追问（"那它呢？"）往往比指令句更需要检索，却恰恰是最不可能命中正则的。
- **终态**：正则降级为 hint；新增 `RetrievalPlan`（local: none/anchor_only/search/incremental，
  web: none/search/verify）。闸门拆除后 ideal 符合率 12.5%→87.5%。
- **面试点**：路由的输出不该是 boolean，而是"从哪些源、以什么方式、取多少"的规划；
  且"是否检索"的第一决定权在系统（确定性初检），不在模型。

### 2. Query Understanding：指代与省略的还原

- 追问轮（"那它是在什么时候产生的？"）必须还原成自含查询才能检索。
- **双层实现**：规则版（零成本：代词表/关系分类/freshness 触发词）兜底 + LLM 版（追问轮才触发，
  15s 超时静默回退）。实测 LLM resolver 14 次调用 0 回退。
- 进检索的是 `resolvedQuery`，不是 raw query。

### 3. 检索：小语料上的混合方案（不引外部服务）

- 场景约束：授权范围 = 当前文件所在文件夹（隐私边界），通常几十篇笔记——**不需要 ES/向量库**。
- **词法层**：文件名/标题/别名/标签/链接/正文的 term 命中计分（沿用原有实现）。
- **语义层**：字符 n-gram 余弦（中文二元组+拉丁词元），补"表述不同"的召回；带阈值防噪声。
- **三个实测驱动的补丁**（都是评测发现的回归，值得细讲）：
  1. **疑问词污染**："Compaction 是什么意思"里"什么/是/意思"把标题含"是什么"的泛化块抬到
     定义块之上 → 查询停用词剥离（词法+语义双路径），定义类问题块命中 0→全部 1.0。
  2. **引文陷阱**：语料里有块把测试问句**当例句逐字引用**，任何浅层相似度都会给它最高分。
     终版方案：原文窗口匹配（≥10 字连续原文）+ 同时检查检索查询与用户原始问题
     （模型会改写查询绕开检测）+ **相对降权**（引用块上限=最佳非引用块×0.5；
     全库只有引用块则保留——"本文未覆盖 X"的元信息块就该被选出）。
  3. **分数天花板**：陷阱挡住后金标块仍可能输给泛化块——规则层到顶，下一步是 embedding+rerank。
- 证据块自带 **Identity**（personal_knowledge=用户手写认知 / external_material=外部材料）和
  **认知状态**（unverified 等），随块注入，模型回答里因此稳定出现"unverified，请核对"。

### 4. Context 构造：8 槽位 + 预算 + 回执

- 槽位：system / **selected_passage（选区=阅读位置 anchor）** / conversation / question_history
  （历史会话问题检索）/ confirmed_memory（用户偏好）/ **local_evidence** / **web_evidence**（分槽，本地=文章说什么，web=世界是什么）。
- **conversation 内部自带两级窗口**：最近 6 条消息原文 + 更早消息 digest 化（每条 280/420 字符，
  显式标记 `[explicit correction]`）。第 4 轮起 digest 生效——这是结构化 ReadingState
  （topicPath/openConfusions）的演进起点，9 轮实测 digest 仍够用（M08 场景 T9 框架重建满分），
  10 轮以上才是 ReadingState 的收益窗口。
- **contextReceipt**：每段是否纳入/截断/原因全部留痕，随答案返回并进遥测——评测与排障的锚点。

### 5. Agent 工具循环：职责收窄为"补充"

- ≤3 轮循环；初检证据已注入 context，模型只在"明显不足"时调工具（配额 2 次/问，top-3 块/次）。
- **预算耗尽的降级话术**是设计出来的：工具返回"预算已耗尽，不要再调，用已有证据完成并说明
  不确定性"——但评测抓到过降级失败形态（模型只输出"让我再查一下"就停的残句答案），
  用系统提示规则修复（禁止裸宣告收尾）。
- 每问独立 trace，多轮靠 sessionId 关联，contextDigest（turnIndex+最近5轮摘要）进 metadata。

### 6. 回答完整性：两层防线（评测最亮的成果线）

- **提示层**：只能引用真实返回的来源；没检索就明说；区分"我没检索到"和"笔记没有覆盖"
  （后者是实测发现的"虚假缺席声明"缺陷）；`Identity: personal_knowledge` 的块=用户认知，
  影响解释但不自动当事实。
- **代码层（citation sanitizer）**：答案返回前逐个核验 `[[路径#标题]]`——文件对标题错→按块 ID
  前缀/相似度修复成真实标题；修不了降级为文件级引用；文件不在本轮证据清单→剥掉链接语法。
- **演进数据**：捏造整段"检索到了 A08 User profile…"（91%）→ 改写小节名（88%）→ **100% 清零**。

### 7. 遥测：自写零依赖 OTLP 客户端

- 自托管 Langfuse v4（events_only 模式）：官方 ingestion 只收 score、v2 读 API 全 404——
  写走 OTLP `/api/public/otel/v1/traces`，读直连 ClickHouse `events_full`。
- 数据模型：trace=turn（input=最新问题；metadata=turnIndex/contextDigest/resolvedQuery/plan/
  retrievedEvidence 块级）、generation=每次模型调用（真实 usage）、span=每次工具调用
  （query 参数+证据全文）。**块级信息从工具 span 的 `[[路径#标题]]` 输出零埋点解析**。

## 三、可能的追问与回答要点

- **"为什么不用 LangGraph/LlamaIndex？"** 已有 RunPlan/RunController/AgentRuntime/ToolGateway/
  ContextBuilder，等于自持了一个轻量框架；产品的差异化恰恰来自对检索/context/状态的精确控制，
  套框架会失去可观测性。等出现多循环/checkpoint/并行节点需求再迁。
- **"RAG 难点你踩过哪些？"** 三大类：语义改述召回（n-gram/embedding）、相关≠有用
  （utility 分级金标+噪声率）、多块拼接（最小充分证据集）。加一个别人少讲的：**引文陷阱**。
- **"Context 膨胀怎么处理？"** 分槽预算+两级窗口+digest；下一步结构化 ReadingState。
- **"多轮怎么测？"** session=场景、trace=turn、contextDigest 还原每轮语境；金标按轮标
  expected_retrieval_action，且**金标本身随架构演进重标**（REUSE/INCREMENTAL 语义变化）。
