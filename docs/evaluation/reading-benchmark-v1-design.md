# AI Reading Benchmark v1 设计

> 状态：设计定稿（2026-10-07），待评审后实施。
> 输入：ChatGPT 两轮讨论（产品三层定义 / 5 层评测架构 / 指标公式）+ 本仓库两轮 gold-set 实测发现
> （`docs/langfuse-eval-guide.md` 第八节、`runs/gold-set-*.json`）。
> 运行基建沿用 `scripts/langfuse-gold-set.mjs` 的已验证路径：CDP 驱动 Obsidian + 真实模型 + Langfuse trace + ClickHouse 断言 + ingestion 打分。

---

## 0. 产品定义（评测的北极星）

> AI Reading 不是针对当前问题从文章里搜索答案，而是在持续阅读过程中维护用户的"理解位置"，结合当前选区、全文证据和历史问题，判断用户真正卡住的概念，并把局部问题重新放回文章整体知识结构中解释。

三层目标，评测分层直接对着它来：

| 层 | 目标 | 对应评测层 |
|---|---|---|
| L1 找到答案 | 文章里有没有能回答的内容 | Retrieval / Evidence Selection |
| L2 理解真问题 | 结合选区 + 历史轮次判断用户真正在问什么 | Query Understanding / Conversation Understanding |
| L3 重建知识结构 | 局部问题放回框架，指出用户的概念混淆 | Reading Assistance（**产品差异化所在**） |

---

## 1. 实测发现如何修正优先级（相对 ChatGPT 提案）

ChatGPT 提案假设"检索已发生，问题在召回质量"。我们 09-23 的三轮实测说明**前提本身不成立**，这决定了 v1 的优先级排序：

| # | 实测发现 | 对设计的修正 |
|---|---|---|
| 1 | **路由闸门过窄**：自然问法 19/20 轮根本不触发检索（工具描述限定 "only when explicitly asks to find"，`knowledge-scope.ts:600`） | `retrieval_action_accuracy` 升为第一优先指标；ROUTING 独立成套；gold 同时记"当前策略预期"和"产品理想预期"，**两者的差距就是待决策的产品问题** |
| 2 | **包装性编造**：未检索轮把综合答案标成"📖 笔记原文"并引用不存在的小节 | 新增程序化指标 `citation_verifiability`（答案里每个 `[[笔记#小节]]` 引用必须在 metadataCache 里真实存在）——比 judge 便宜且确定 |
| 3 | 检索器 top-K 常混入无关笔记，靠模型层自觉过滤 | 采纳 HNR@K / Evidence Precision / Noise Ratio，但认识到"噪声过滤在模型层"是现状，指标分开记录"检索层噪声"与"最终答案是否被带偏" |
| 4 | 工具描述 "Use at most once" → 追问轮一律不增量检索（A3/D2/D3） | REUSE_PREVIOUS vs INCREMENTAL_RETRIEVAL 的金标逐 turn 设定；"是否放宽单次限制"列为实验变量 |

---

## 2. 现架构的硬约束（提案没覆盖、我们必须遵守的）

写题前必须知道边界，否则会出现"金标在现架构下不可解"的死题：

1. **K = 3**：一次检索最多返回 3 个块（`MAX_READ_REFS = 3`）。required_evidence ≤ 3。
2. **每问一次查询**：工具描述限定 "Use at most once"，即一个 turn 只有一次 search 机会，多 hop 必须能用**一条 query** 同时召回（如"compaction 时 developer message 怎么处理"一条查询同时命中 A02+A04）。
3. **切块 = `##` 小节**：检索按标题块组织，基准文章每个 `##` 节就是一个 chunk，天然带 ID（标题文本）。
4. **块级遥测零改动可得**：trace 里 tool span 的 output 含 `Source: [[路径#标题|文件 › 标题]]`，runner 解析即得块级命中。（`getUsedSources()` 的 title 只有文件名不含标题——长期可把 heading 加进 usedSources，v1 不必。）
5. **会话内证据可复用**：模型可以引用前轮对话里的证据（跨 turn reuse 是特性，不是 bug）。

---

## 3. 五层评测架构与指标可计算性

| 层 | 核心问题 | 指标 | v1 计算方式 |
|---|---|---|---|
| Query Understanding | 用户真正问的是什么 | `resolved_query_accuracy` | judge 比对 tool query 参数 vs gold resolved_query（trace 已记录 query，无需新埋点） |
| Retrieval Decision | 这一轮该不该检索 | `retrieval_action_accuracy` | **程序化**：由 tool span 推导实际动作 vs gold 枚举 |
| Retrieval / Evidence Selection | 找到的材料对不对、够不够、净不净 | chunk 级 `Recall@K` `HNR@K` `MRR` `nDCG@K`；`EvidencePrecision` `EvidenceCoverage` `NoiseRatio` `MinimalSufficiency` | **程序化**（解析 tool span output 的块级引用；utility 分级 3/2/1/0 来自 gold） |
| Conversation Understanding | 连续几轮问的是什么关系 | `coreference_accuracy` `ellipsis_resolution` `topic_return_accuracy` `user_correction_following` `assistant_error_propagation` | judge 为主（v1 人工抽查 + 后期 LLM-as-judge） |
| Reading Assistance | 有没有真正帮到阅读 | `conceptual_positioning`(0/1/2) `misconception_detection` `framework_reconstruction`(session 级) `unsupported_abstention` `citation_verifiability` | abstention/citation **程序化**；positioning/misconception/framework judge |

程序化 ≥ 60%，judge 指标集中在 Reading Assistance 层的关键 turn（~8 个），避免 30+ turns 全人工不可持续。

**Retrieval action 枚举与推导**：

```
gold 枚举:  NO_RETRIEVAL / REUSE_PREVIOUS / INCREMENTAL_RETRIEVAL / FULL_RETRIEVAL / EXTERNAL_VERIFY
实际推导:   无 tool span → NO_RETRIEVAL（是否"合理 reuse"由 gold 的 REUSE_PREVIOUS 判对错）
            有 tool span 且 ≥1 新块 → INCREMENTAL/FULL（按 gold 口径）
            有 tool span 且全是已见块 → 重复检索（记 REPEAT）
            web sources > 0 → EXTERNAL_VERIFY
```

---

## 4. 基准文章与切块

采用 ChatGPT 起草的《Agent Context Engineering》A01–A14，落在 demo vault
`Reading notes/Agent Context Engineering 基准.md`，**一个 `##` 节 = 一个 chunk**：

| 块 | 主题 | 在题集中的角色 |
|---|---|---|
| A01 Context 是什么 | 每轮重新构造 ≠ 系统全量信息 | 正证据 |
| A02 Instruction 与 Conversation | 存在 ≠ 进入本轮输入 | 正证据 / S05 hard negative |
| A03 Selected Passage | 选区是 anchor 不是唯一事实 | S06 正证据 |
| A04 History 与 Compaction | 压缩/摘要、保任务所需而非全文 | 正证据（语义改述靶点） |
| A05 Memory | memory ≠ conversation history | 正证据 / Case B hard negative 靶点 |
| A06 Tool Definition vs Result | 决策前定义、执行后结果 | S01 正证据 |
| A07 Semantic Retrieval | 语义而非关键词 | **utility=1 的典型 hard negative** |
| A08 Relevant ≠ Useful | 主题相关 ≠ 能回答 | 正证据 |
| A09 Minimal Sufficient Evidence | 最小充分集合 | 正证据 |
| A10 Multi-hop 与 Chunk Boundary | 跨片段联合推理 | 正证据（双块金标） |
| A11 Reading Position | 层级定位、框架感 | conceptual_positioning 的正证据 |
| A12 Question Reconstruction | 概念混淆推断；assistant 史不是事实源 | M05 正证据 |
| A13 过时信息（自称 2025） | AGENTS.md→developer message（已过时）、Assistants API（已 sunset） | STALE 套件专用 |
| A14 流程图 | tool 链路图 | 图文题（v1.1，先确认插件图片选区支持） |

utility 分级金标（nDCG 用）：3=必须证据，2=强支持，1=主题相关但低效用，0=无关。

---

## 5. 题集 v1

三个套件 + 一个延后项，共 ~37 turns。**CORE 用"帮我查找笔记："句式强制打开路由闸门**（测检索质量本身）；**ROUTING 用自然问法**（测闸门该不该开）。

### 5.1 CORE 单轮（8 题，全程序化断言）

| Case | 问题（口语化表述 → 语义靶点） | required | hard negative | 主要考点 |
|---|---|---|---|---|
| S01 | 模型决定调工具时已经能看到执行结果了吗？ | A06 | — | 基线直检 |
| S02 | 聊得越久，之前每句话都原封不动塞给模型吗？ | A04 | — | 语义改述召回 |
| S03 | 和问题主题相关的 chunk 都该给模型吗？ | A08, A09 | A07(1) | relevant≠useful |
| S04 | 为什么 Memory 存了信息，模型这轮却不一定知道？ | A05, A10 | — | 双块联合（恰好 K=3 内可解） |
| S05 | Developer instruction 在 compaction 时一定不会被压缩吗？ | **[]（无证据）** | A02, A04 | abstention / unsupported_answer_rate |
| S06 | 我已选中段落，是不是就不用再搜全文了？ | A03 | — | 选区 anchor vs 全文 |
| S07 | Top1 只能回答一半，还要坚持只用 Top1 吗？ | A09, A10 | — | sufficiency |
| S08 | 和问题最像的 chunk 一定排第一吗？ | A08, A09 | A07(1) | hard negative 排序 |

### 5.2 ROUTING 套件（8 题，自然问法，零程序化改造可直接跑）

复用 09-23 run1/run2 的问题（"笔记里有没有讲 X""X 是什么"等）。每题 gold 同时记：

```json
"expected_action_current": "NO_RETRIEVAL",   // 现工具描述下的预期（当前策略基线）
"expected_action_ideal":   "RETRIEVAL"        // 产品理想预期
```

`retrieval_action_accuracy(current)` 衡量现状；`accuracy(ideal) − accuracy(current)` 就是"放宽闸门"决策的量化依据。

### 5.3 多轮场景（6 场景 21 turns，session = 场景）

| 场景 | turns | 考点（关键 gold 字段） |
|---|---|---|
| M01 递进+误区 | T1 每轮重建？→T2 "那聊久了以后呢？"（省略继承）→T3 "这个和 memory 区别？"（指代=compaction）→T4 "不都是让模型记得东西吗？"（**misconception**） | ellipsis / coreference / conceptual_positioning / misconception_detection；T2 gold=INCREMENTAL，T3 gold=INCREMENTAL（A05 是新块） |
| M03 强指代 | T1 def/result 时机 →T2 "它什么时候产生？"（它=result）→T3 "没执行就看到它会怎样？" | 指代链保持；允许 soft disambiguation（"如果你指的是…"） |
| M04 分支返回 | Context→Memory 分支两轮→T4 "回到 Context，每次都重建？" | topic_return_accuracy |
| M06 用户纠正 | T1 指代误判 →T2 "不是，我说的是 definition" →T3 沿新指代追问 | user_correction_following / referent_state_update |
| M05 注入错误史 | seed 一条错误 assistant 消息（AGENTS.md→developer role）→ T1 沿错误前提追问 | assistant_error_propagation（0=继承错误，1=纠正/存疑）；**seed 需 runner 能注入历史消息，先做 1 天 spike 验证可行性** |
| M07 框架漂移 | 5 连问从 Context 一路漂到 Memory retrieval→"现在问的这块在最初 Context 里处于什么位置？" | framework_reconstruction（session 级评分） |

M02（检索器元讨论）降为可选——离阅读场景最远，v1 不跑。

### 5.4 STALE 套件（2 题，依赖 A13）

ST01"AGENTS.md 现在还是 developer role 注入吗？"、ST02"该用 Assistants API 吗？"。
**只测 `freshness_trigger_accuracy`（是否触发 EXTERNAL_VERIFY 动作），不测外部内容正确性**——自托管环境外网验证不可控，且 gold 会随官方文档过时（gold 记录"事实截至 2026-10"）。

### 5.5 每条 gold 的字段 schema

```json
{
  "case_id": "S03", "suite": "CORE", "scenario_id": null, "turn_index": 1,
  "selected_chunk": "A08",
  "question": "和问题主题相关的内容都应该给模型吗？",
  "resolved_question": "语义相关的检索结果是否都应该进入生成上下文？",
  "required_evidence": {"A08": 3, "A09": 3},
  "hard_negative_evidence": {"A07": 1},
  "expected_retrieval_action": "RETRIEVAL",
  "expected_answer_points": ["相关性不等于回答效用", "应寻找最小充分证据集合"],
  "expected_citations": ["A08", "A09"],
  "tags": ["core", "evidence-selection", "hard-negative"]
}
```

多轮场景外层再包 `scenario_id / turns[] / session_level_scores[]`。

---

## 6. 指标实现清单

**零改动可算**（runner 扩展即可）：
- 块级 Recall@K / HNR@K / MRR / nDCG@K —— 解析 tool span output 的 `[[路径#标题]]`
- retrieval_action_accuracy —— tool span 有无 + 新块集合
- citation_verifiability —— 正则抽答案里的 `[[..#..]]`，CDP 查 `app.metadataCache` 核实
- unsupported_abstention —— 弃答标志词（"没有提到/不足以判断"）+ citation 通过 + 无捏造小节
- Evidence Precision / NoiseRatio（token 近似：按块字符数）

**runner 需新增**：M05 的历史注入（spike）、session 级聚合评分上报。

**judge 类**（v1 人工抽查表，后期 LLM-as-judge 离线脚本打分走 ingestion API）：
resolved_query_accuracy、coreference/ellipsis、topic_return、user_correction_following、assistant_error_propagation、conceptual_positioning、misconception_detection、framework_reconstruction。

---

## 7. Langfuse 组织方式

- **session = 多轮场景**（M01 一个 session），trace = turn，单轮题各自独立 trace。
- **Tag = 这是什么测试**（`eval-v1` / `core` / `routing` / `stale` / `hard-negative`…），**Score = 表现如何**（上表全部指标名）。Score 挂 trace 级；`framework_reconstruction` 等挂该 session 每个 trace（v4 无 session 级 score API 的现实约束）。
- **不用 Datasets/Experiments UI**：v4 events_only 模式公开 API 受限（此前实测），gold 放仓库 JSON 版本化管理，score 走 legacy ingestion（已验证）。Experiment 对比 = 同一 gold 文件不同代码版本各跑一遍 + 报告 diff。
- 基线对比锚点：09-23 gold-set 三轮数据已在库里，v1 首跑后并列呈现。

---

## 8. 分阶段落地

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0（0.5 天） | 基准文章入库；gold 文件 `scripts/evaluation/gold/benchmark-v1.json`；runner 扩展（块级解析、citation check、action 推导） | 可跑的 v1 runner |
| P1 | CORE 8 题 | 首份全程序化 baseline 报告（检索层五指标 + abstention + citation） |
| P2 | 多轮 M01/M03/M04/M06 + ROUTING 8 题 | 闸门差距量化；多轮程序化指标 |
| P3 | M05 注入错误（spike 通过后）+ STALE + judge 指标人工评 | 完整 v1 报告 + Reading Assistance 层基线 |
| v1.1 | A14 图文题（先验证插件图片选区）；LLM-as-judge 接管人工表 | — |

---

## 9. 对 ChatGPT 提案的明确取舍

1. **优先级重排**：他们把 nDCG/检索质量放最前；我们把 `retrieval_action_accuracy` + `citation_verifiability` 放最前——实测证明闸门和引用真实性是当前最大失分/风险点。
2. **K=3/单查询约束显式化**：所有金标 required ≤3 块且必须一条 query 可达；"扩 K / 放开单次限制"作为受控实验变量而不是前提。
3. **judge 指标压缩到 8 个关键 turn**，其余全程序化——30+ turns 全人工不可持续。
4. **STALE 只测触发不测内容**：外部事实正确性不进自动化断言，gold 注明事实日期。
5. **"第二轮不检索≠更好"采纳**：gold 逐 turn 写 expected_retrieval_action，而非统计 tool span 越少越好。
6. **图文题延后**：先验证插件对图片选区的实际支持，避免造出不可解题。

---

## 10. 待用户决策（不阻塞 P0–P2）

1. **路由闸门**：是否在 v1 期间放宽工具描述（"提到笔记/文章内容即检索"）？决策依据 = ROUTING 套件的 ideal-current 差距数据。
2. **K 与单次限制**：MAX_READ_REFS 3→4？允许同问两次检索？——建议等 P1 基线出来再定。

---

## 11. 增补：insight 套件（潜在困惑/痛点挖掘，2026-10-08）

**动因**（用户定义的核心场景）：用户连续问表面问题（词义/定义级），答案不算错但没有直击真实困惑——
"我问一个单词的意思，真正想知道的是它在当前机制链路中的作用"。这是产品第三层（戳中真问题）的
直接评测，此前只有 M01/T4 一道题擦边。

**三个场景 10 turns**（gold `benchmark-v1.json` 的 `suites.insight`，自然问法）：
- **L1 术语定义→机制困惑**：Compaction 词义 → 词汇辨析 → "压缩后还记得吗" → "为什么感觉它记得我"（真实困惑=连续性错觉的机制）
- **L2 无状态假设**：tool definition 定义 → "每次都要重放吗" → "为什么不能放一次就一直在"（真实困惑=模型是有状态容器的隐含假设）
- **L3 信息存续实用规则**：instruction 定义 → "会不会被压缩掉"（链路内弃答）→ "该写在每轮都看得到的地方吗"（真实困惑=统一原理）

**金标新增字段**：`latent_confusion`（真实困惑）、`surface_symptoms`、`expected_reveal_turn`（理想助手最晚在第几轮点破）、`judge_note`。评分维度 `latent_question_hit`（0=每轮只答表面 / 1=被直接问到深层才能答 / 2=主动重构潜在困惑并放回框架）——judge 类，runner 记录答案与金标供评审。

**首轮实测（修复前）的两个新发现**：
1. **痛点挖掘维度表现意外地好**：L2/T3 原话"你问的'放一次就一直在那儿'，其实隐含假设了模型有个地方能存住东西"——正是理想的误区重构。用户在 ChatGPT 上遇到的"答不到痛点"未在本插件复现（阅读导师提示词 + 机制块锚定的功劳）。⚠️ 但有偶然成分：定义类问题检索 miss 反而把 A01（机制块）推了进来，恰好服务了深层问题。
2. **虚假缺席声明（新 P0 级问题）**：检索 miss 时模型宣称"你的笔记里没有覆盖 X"（A04/A06/A02 明明存在）——把"我没找到"说成"笔记没有"。
3. **疑问词污染检索**：'什么/是/意思' 的命中把标题含"是什么"的 A01 抬到标题含 compaction 的 A04 之上，定义类查询全军覆没。

**两项修复与验证（同日）**：`QUERY_STOPWORDS` 剥离（词法+n-gram 双路径）+ 完整性规则加"区分'我没检索到'与'笔记没有覆盖'"。修复后 insight 套件：recall 26%→**76%**、nDCG 0.35→**0.89**、MRR **1.0**、noise 83%→**35%**、三个定义类问题块命中全部 1.0、虚假缺席声明清零、citation 保持 100%。运行数据：`runs/benchmark-v1-1791389863250.json`（修复前）/ `1791390264636.json`（修复后）。

## 12. Reader Notes 方向定案（2026-10-08 用户确认）

**笔记区内容 = 用户认知**（用户已确认）。写入路径已存在：插件支持选中模型回答保存进笔记。
分层落地：
1. **已落地（提示层）**：`Identity: personal_knowledge` 的证据块在系统提示中被框定为"用户自己的认知——用于校准解释、预判用户已有信念，但与文章主张区分、不单独作为客观事实"。
2. **MVP（下一步）**：检索注入时按 identity 分组标注（"以下来自你自己的笔记（你的认知）/ 以下来自外部文章（客观来源）"），零新存储，`knowledge-identity.ts` 已有数据。
3. **完整版**：ReaderNote store（linkedChunkIds/status=active|superseded/跨会话检索、"用户改口→旧认知降级"生命周期）——等 insight/长对话套件能测出差异后再做。

**长对话测试（ReadingState 的前置尺子）**：金标 v1.2 计划加 8–10 轮场景（漂移→回最初→问整体位置），验证第 4 轮起 compactMessages digest 化后的框架锚定退化，再决定 ReadingState 形态。
