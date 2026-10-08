# P1/P2 重构：Benchmark v1 对比报告

> 日期：2026-10-07（午夜）｜ 前序：`benchmark-v1-baseline.md`（原始）→ `benchmark-v1-p0-refactor-comparison.md`（P0）
> 本轮 run：`runs/benchmark-v1-1791387981613.json`（core+routing+multi，同语料同 gold）
> 三轮对比口径一致：干扰笔记归档、gold v1 原版、kimi-k3 真实调用。

## 1. 本轮落地内容

| 项 | 实现 | 文件 |
|---|---|---|
| **P1 混合检索** | 字符 n-gram 余弦（中文二元组+拉丁词元）加入文件级与块级打分，语义门槛 0.22/0.12 防噪声；零依赖离线可用 | `knowledge-scope.ts`（`ngramSimilarity` + search/scorePassage） |
| **P1 引用锚定** | 确定性初检证据块头部改为"retrieved just now for this question, cite these exact links, do not rename headings" | `knowledge-scope.ts:buildInitialContext` |
| **P1 引用对账后处理** | 新模块：答案返回前把每个 `[[..#..]]` 与本轮真实证据清单对账——文件对标题错→按 Axx 前缀/相似度修复，修复不了降级为文件级引用；文件不存在→剥掉链接语法。`getEvidenceInventory()` 提供每文件全部真实标题 | `citation-sanitizer.ts`（新）+ `knowledge-scope.ts` |
| **P1 LLM resolver** | 追问轮（turnIndex≥2）用主模型解析指代/省略成自含 resolvedQuery + plan（JSON 输出、15s 超时、解析失败静默回退规则版）；首轮仍走规则。实测 14 次 model / 21 次 rules | `query-understanding.ts:resolveQuestionWithModel` + `main.ts` |
| **P2 web verify 分流** | `plan.web === "verify"`（"现在还是这样吗"类）加入联网触发条件（与显式搜索意图并集）；verify 模式系统提示要求"原文当时说 X / 现在是 Y"对比式回答。本地/网络证据槽位本就分离（local_evidence / web_evidence） | `main.ts` |
| 明确不做 | ReadingState 结构化（benchmark 场景≤5 轮全在 6 条原文窗口内，测不出差异）；reader-notes-store（需产品设计：什么算 reader note） | 见设计文档 |

## 2. 三轮指标对比

| 指标 | 基线 | P0 后 | **P1/P2 后** |
|---|---|---|---|
| **citation_verifiability** | 91.2%（3 捏造） | 88.2%（4 改写标题） | **100%（0 失败，34/34）** ✅ |
| ROUTING ideal | 12.5% | 87.5% | 87.5%（保持） |
| Recall@K | 27.5% | 49.2% | 40.0%（回落，见 §3.1） |
| MRR | 0.33 | 0.625 | 0.55 |
| 弃答 S05 | 1/1 | 1/1 | 1/1 |
| 残句答案 | 有 | 无 | 无 |
| action（严格金标） | 84.6% | 64% | 68% |

## 3. 关键发现

### 3.1 citation 问题彻底解决，但暴露"引文陷阱"——语义检索的新失效模式

引用真实性三轮走完：**捏造整段（基线）→ 改写标题（P0）→ 100% 通过（P1）**。sanitizer + 锚定措辞组合拳有效。

但 recall 从 49.2% 回落到 40%，根因是一个此前被词汇匹配"意外避开"的陷阱：**S01 的问句被 A08 当作例句原文引用**（"例如问题是'模型在决定调用工具时能看到工具执行结果吗'"就写在 A08 里）。n-gram 语义相似度对"引用了问题的段落"打最高分——A08 对 S01、A07 对 S02 都属于这类自引用陷阱。语义检索无法区分"讨论该问题"和"引用该问题的字面"。
**解法（下轮）**：rerank 阶段对"块内包含问句原文的连续 ≥10 字子串"降权，或按块的话题主词（标题）与 resolvedQuery 的话题主词匹配度重排。

### 3.2 LLM resolver 生效但收益有限

14 次模型解析全部成功返回合法 JSON（0 次回退）。收益：M03/T1 指代链首尾全对（A06 recall 1.0 + T3 正确 REUSE）；代价：每追问轮 +1 次小调用。M01/T3、M07/T4 的 resolvedQuery 偶有偏航（解析出的查询偏向 A01），说明 resolver prompt 还可以加"优先检索未展示过的新概念"的指引。

### 3.3 多轮行为更接近金标语义

M03/T3、M01/T4、M04/T4 三轮 REUSE 判定全部正确（P0 时这些轮会无脑增量检索）；M04/T2 Memory 追问精确命中 A05。动作分布从"一律检索"变成"该检索检索、该复用复用"。

### 3.4 S07 三连超时确认是稳定 bug

同一问题三个 run 全超时（6 分钟无完成答案），与重构无关——该轮 generation 数量正常但终答未在窗口内出现。待单独排查（怀疑：两次检索+长答案超时窗口，或 submit 后 UI 状态未翻转）。

## 4. 结论与下一步

- **P1/P2 的两个主目标（引用可信、语义召回基础设施）一个满分达成、一个建成但暴露新失效模式**。
- 下一步优先级：①引文陷阱降权（rerank 规则）②resolver prompt 加"新概念优先"指引 ③S07 超时排查 ④金标 v1.1 重标 action 预期 ⑤真 embedding 后端接口化（`KnowledgeSearchBackend`，ngram 权重直接复用）。
