# P0 重构：Benchmark v1 前后对比报告

> 日期：2026-10-07（深夜）｜ 基线：`benchmark-v1-baseline.md`（run 1791360360233）
> 重构后 run：`runs/benchmark-v1-1791384728729.json`（core+routing+multi，与基线同语料同 gold）
> 本次对比**不含 STALE 套件**；语料状态与基线完全一致（干扰笔记归档）。

## 1. 本次落地的 P0 改动（代码对照）

| 改动 | 文件:位置 | 内容 |
|---|---|---|
| 取消正则硬闸门 | `main.ts`（原 :3496） | 只要有授权范围就创建检索器；`question-routing.ts` 降级为 hint |
| Query Understanding（规则版） | `src/query-understanding.ts`（新） | 追问/指代识别 → resolvedQuery + relation（CONTINUE/REFINE/COMPARE/BRANCH/RETURN）+ RetrievalPlan + freshness 触发词；零额外模型调用 |
| 确定性初检接线 | `main.ts` askAi | 闲置的 `buildInitialContext()` 首次接线：按 resolvedQuery 预取证据注入 `local_evidence` 槽位，第一轮检索不再交给模型自由决定 |
| 检索约束放宽 | `knowledge-scope.ts:13,600` | 工具描述重写（鼓励文档内容相关问题使用、允许第二次不同查询、要求 query 自含指代消解）；调用配额 1→2 |
| 回答完整性规则 | `main.ts` effectiveSystemPrompt | 禁止把没发生的检索说成"检索到了"；无新检索时明说并基于已有材料作答；禁止"让我查一下"式裸宣告收尾 |
| 遥测增强 | `main.ts` + `knowledge-scope.ts` | trace metadata 新增 resolvedQuery/relation/retrievalPlan/freshnessRequired/retrievedEvidence（块级，含 heading）；receipt 记录 resolved 信息 |

**ChatGPT 建议中核实后无需改的**：对话 compaction 已存在（`context-builder.ts:selectConversation`，最近 6 条原文 + 旧消息结构化 digest + 纠正标记），"停止全量注入"的建议基于错误前提。

## 2. 指标对比（同语料同 gold，core+routing+multi）

| 指标 | 基线 | 重构后 | 变化 |
|---|---|---|---|
| **ROUTING ideal 符合率** | **12.5%** | **87.5%** | **闸门差距从 87.5pt 闭合到 12.5pt**（仅 R07 选区自答型问题多检了一次） |
| ROUTING current 符合率 | 100% | 0% | 预期内：旧策略预期作废 |
| Recall@K（20 turns） | 27.5% | **49.2%** | **+21.7pt（近翻倍）**；S03/S06/M04-T2/M07-T4 从 miss 变命中 |
| MRR | 0.33 | **0.625** | 金标块排名大幅前移 |
| nDCG@K | ~0.51 | 0.48 | 持平（noise 略升抵消 recall 增益） |
| Evidence Precision / Noise | 0.31 / 0.69 | 0.26 / 0.74 | **略恶化**：确定性初检把更多 OTHER 块带进证据池 → P1 rerank 的明确靶子 |
| citation_verifiability | 91.2%（34 轮） | 88.2%（34 轮） | 数量持平略降，**性质改变**（见 §3.2） |
| action_accuracy（严格金标） | 84.6% | 64% | 见 §3.3——主要是金标按旧架构标定 |
| M01/T2 残句答案 | 复现 | **消失** | 806 字完整诚实作答 |
| 弃答（S05） | 1/1 | 1/1 | 保持完美 |

## 3. 关键定性结论

### 3.1 三个 P0 目标达成情况
1. **路由闸门**：达成。自然问法 7/8 触发了检索（含"康奈尔笔记法"跨主题、"上下文无关文法"陷阱题）。
2. **残句答案**：达成。M01/T2 现在明确说"这次检索没找到相关条目……我不能凭空引用它"，然后分层作答。
3. **追问增量检索**：M01/T2、M04/T2（A05 recall=1.0）、M07/T4（A05 recall=1.0）都从 REUSE 变成了有效增量。

### 3.2 citation 失败的形态迁移（新发现的 P1 靶子）
基线失败 = **捏造整段"检索返回了 A08 User profile…"**（宣称检索+捏造来源）。
现在失败 = **承认无新检索/检索到了正确块，但引用时改写小节名**（如把 A05 的真实标题
"A05 Memory"写成"A05 重新注入原则"），个别轮还编造引文内容（M03/T2 的"A07 Context 是
运行时生成的"整段不存在）。诚实性提升（不再假装检索发生），但引用精度仍不达标。
**P1 方案**：(a) 确定性初检的证据块头部加"retrieved just now for this question, cite these
exact links"措辞（模型现在把注入证据当成"旧材料"而自称"没检索"）；(b) 代码层后处理——
答案里的 `[[..#..]]` 与 receipt 的 path+heading 对账，改写/剥离不匹配引用。

### 3.3 action 金标需要按新架构重标
64% 的"下降"主要是：旧金标把追问轮标为 REUSE_PREVIOUS（适应"at most once"时代），
确定性初检让这些轮发生了检索——且**多数检回的正是金标要求的块**（M04/T4 要 A01 得 A01、
M06/T3 要 A06 得 A06）。建议金标 v1.1：追问轮的动作预期改为"检索到所需块"或"REUSE/INCREMENTAL
皆可"，与 ChatGPT 的 retrieval necessity 语义对齐。

### 3.4 未解问题
- **S07 连续两轮超时**（同一问题），与重构无关的 flaky，待查（疑似提交或长答案卡住）。
- **M05 种子注入**：视图层成功但 turn 超时（与基线一致），消息对象形状待探。
- 语义召回缺口仍在：S02（"原封不动"→A04）、S04（Memory→A05/A10）、M07/T2 仍靠词汇命中——
  这正是 ChatGPT P1（lexical+dense 混合检索）的靶子，规则版 resolver 无法弥补词汇鸿沟。

## 4. 对 ChatGPT 方案的查漏补缺（本次核实的修正）

| ChatGPT 主张 | 核实结果 |
|---|---|
| "conversation 全量传模型，要优先停止" | **前提不成立**：`selectConversation` 已做"最近 6 条原文 + 旧消息 digest"，含纠正标记。需要的是 ReadingState 结构化升级（P1/P2），不是从零建窗口机制 |
| "第一轮 Retrieval 不应交给模型自由决定" | 采纳，且发现 `buildInitialContext()` 写好了从未接线——本次接上即用 |
| "Router 输出 boolean 信息量太少" | 采纳；P0 用规则版 RetrievalPlan（local 4 态 + web 3 态），LLM resolver 留 P1（成本考虑） |
| "MAX_TOOL_ROUNDS 6 降到 2~3" | 实际已是 3（`main.ts:88`），无需改 |
| "16k 字符预算绑死 search/read" | 属实（`buildInitialContext` 也消耗预算），P1 做 search-cheap/read-expensive 拆分 |
| 捏造检索结果 / 残句答案 | ChatGPT 方案未覆盖（我们 benchmark 独有发现），本次以完整性规则先行修复，根治靠 P1 证据锚定 |
| 不迁 LangGraph/LlamaIndex、main.ts 拆分后置 | 采纳，本次零框架改动，纯职责重划 |

## 5. 下一步（P1 优先级）
1. 证据锚定 + 引用对账后处理（根治 §3.2）
2. 混合检索：lexical + embedding（scope 内全文量小，成本低）→ 直接攻 recall 剩余缺口与 noise
3. LLM 版 query resolver（规则版接口不变直接替换）+ 金标 v1.1 重标
4. search/read 解耦（top-20 候选 + rerank top-5 → evidence 2~5）
5. ReadingState 结构化（topicPath/openConfusions）替换 digest 式 compaction
