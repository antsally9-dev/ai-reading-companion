# 评测驱动优化：方法论总结（面试讲述稿）

> 核心叙事：**没有 benchmark 的优化是盲改**。本项目的每个架构决策都有前后两轮同口径数据；
> 反过来，好几个缺陷（捏造引用、残句答案、疑问词污染、引文陷阱、虚假缺席声明）**只有对照
> 评测才能发现**——它们在单次人工体验里要么看不见、要么被当成偶发。

---

## 一、评测集怎么构造（gold set design）

### 1.1 自造基准文章（而不是拿真实文章）

真实文章无法精确知道"哪几个块是 gold、哪些只是相关、哪些是专门钓检索器的陷阱"。自造一篇
《Agent Context Engineering》A01–A15，**一个 `##` 节 = 一个 chunk（与插件按标题切块一致）**，
故意埋五类坑：

| 坑型 | 实现 |
|---|---|
| 语义改述靶 | A04 用"压缩/摘要"表述，测试问句用"原封不动塞进去" |
| hard negative | A07/A08 主题相关但答不了题（还把测试问句当例句引用——引文陷阱） |
| 无答案 | S05：A02+A04 都相关但合起来也回答不了（考弃答） |
| 过时内容 | A13 自称 2025 年、含已失效的 API 说法（考时效意识） |
| 多候选块 | A15 引文陷阱块 + 合法引用正例（"本文未覆盖 X"的元信息声明） |

**设计原则：陷阱必须与正例成对出现**——降权规则没有正例约束就会矫枉过正
（把"合法引用了自己原话来讨论问题的块"一起杀掉）。

### 1.2 场景矩阵：四个套件 + insight（约 50 turns）

| 套件 | 句式 | 测什么 | 关键设计 |
|---|---|---|---|
| CORE（10 题） | "帮我查找笔记："强制开闸门 | 检索质量本身 | 与路由解耦——先测"搜得准不准"，再单独测"该不该搜" |
| ROUTING（8 题） | 自然问法 | 路由闸门 | **金标双预期**：current（现策略下应然）+ ideal（产品理想），**分差=放宽闸门的量化依据**（实测 87.5pt） |
| MULTI（6 场景） | T1 指令、追问自然 | 多轮理解 | 递进+误区 / 强指代链 / 分支后返回 / 用户纠正 / **注入错误 assistant 历史**（决定论 seed，不赌模型自然犯错）/ 框架漂移 |
| M08（9 轮） | 混合 | 长对话 | 第 4 轮起旧轮次 digest 化，T9 问"各分支在最初框架的位置"（framework_reconstruction） |
| INSIGHT（3 场景） | 自然 | **潜在困惑/痛点** | 用户连续问表面问题（词义/定义），金标记 `latent_confusion` + `expected_reveal_turn`——直接测"答案没错但没打中痛点" |

### 1.3 金标字段（不只是 expected answer）

```json
{
  "required": {"A05": 3, "A10": 3},        // 必须证据，utility 分级 3/2/1/0（nDCG 用）
  "hard_negative": {"A07": 1},             // 钓饵块（陷阱抵抗率用）
  "expected_action": "INCREMENTAL_RETRIEVAL", // 或 ["REUSE","INCREMENTAL"] 数组
  "resolved_question": "...",              // judge：这轮用户真正在问什么
  "latent_confusion": "...", "expected_reveal_turn": 3,  // insight 套件
  "expected_answer_points": [...],         // 答案要点（非 exact match）
  "abstention": true, "tags": ["quote-trap"]
}
```

**金标本身要随架构演进重标**（v1.1）：确定性初检上线后，追问轮"检索/复用皆可"，
旧的单值动作预期会把正确行为判错（action 严格分一度"下降"，重标后 88.9%）。
**不预设"不检索=更好"**——该测的是"这一轮需不需要检索"（retrieval necessity）。

## 二、Langfuse 埋点怎么做

### 2.1 环境：自托管 v4 的三个坑

1. events_only 模式下旧 ingestion API **只收 score 事件** → trace/generation/span 走 OTLP
   `POST /api/public/otel/v1/traces`（自写零依赖 JSON 客户端，Basic auth）。
2. v2 公开读 API 整体 404 → **读取直连 ClickHouse**（`docker exec clickhouse-client` 查 `events_full`）。
3. 根 span 必须带 `langfuse.internal.is_app_root="true"`；trace input 要双写
   trace 域和 observation 域；metadata 嵌套对象被拍平成点路径键、布尔变字符串——查询端要还原。

### 2.2 数据模型（trace=turn / generation=模型调用 / span=工具）

| 实体 | 承载信息 | 用途 |
|---|---|---|
| trace | input=最新问题；metadata: turnIndex / contextDigest（最近5轮摘要）/ **resolvedQuery / relation / retrievalPlan** / retrievedEvidence（块级 path+heading） | 多轮语境还原、query 理解审查 |
| generation | 每次模型调用：输入摘要（messageCount）、**真实 token usage**、耗时 | 成本/延迟、轮次结构 |
| span (tool) | 工具名 + query 参数 + **证据全文**（`Source: [[路径#标题]]` 格式） | 块级指标的零埋点数据源 |
| score | runner 回写：retrieval_action_accuracy / recall_at_k / ndcg_at_k / citation_verifiability / unsupported_abstention | Langfuse UI 聚合看板 |

**关键设计：块级信息不额外埋点**——工具 span 的证据输出里天然带 `[[路径#标题]]`，
runner 解析即得 chunk 级命中；确定性初检没有 tool span，靠 metadata 的 retrievedEvidence 补。

## 三、Runner：驱动真实 UI 跑真实模型

- CDP（`--remote-debugging-port`）连 Obsidian，WebSocket `Runtime.evaluate` 驱动：
  打开锚点笔记→选区→触发 ask-ai→填问题→`view.submitQuestion()`。
- **API key 纪律**：从正式库 SecretStorage 取 key→注入 demo vault→跑完 `deleteSecret` 删除，
  全程只在内存。
- 等待判据的血泪史（每条都是实打实的坑）：
  1. 页内 `setTimeout` 轮询在窗口被遮挡时被节流 → 卡死；等待循环必须放 **node 侧**。
  2. 答案非空 ≠ 回答完成（残句答案就是"非空"）。
  3. 按assistant.question 匹配会漏掉**问题分解路径**（其 question 字段=子问题文本）→ 改
     **位置型判据**（含片段的用户消息之后存在非空 assistant 消息）——顺带诊断出插件侧
     "答案 16 秒生成完、UI 6 分钟不出"的真 bug。
  4. 中断恢复：`--only-case QT1,S02` 定向重跑修复验证，不用整套重来。
- 每轮跑完：ClickHouse 断言 + ingestion API 打分回写 + `runs/*.json` 留档全部答案/证据/指标。

## 四、指标怎么算（程序化 ≥60%，judge 只留 8 个关键 turn）

| 层 | 指标 | 计算方式 |
|---|---|---|
| Retrieval Decision | retrieval_action_accuracy | 实际动作推导：无 tool span 且无块级证据→NO_RETRIEVAL/REUSE（按场景内已见块区分）；有且含新块→INCREMENTAL；web sourceCount>0→EXTERNAL_VERIFY。对照金标枚举/数组 |
| Retrieval | Recall@K / MRR / **nDCG@K（utility 3/2/1/0 分级）** / HNR@K | 解析 span 证据的 `[[路径#标题]]` + metadata 块级证据 → chunk 序列；金标分级算 DCG/IDCG |
| Evidence Selection | Precision / NoiseRatio | 检索块中 utility≥2 占比 / ≤1 占比 |
| Answer | **citation_verifiability** | 正则抽答案内 `[[..#..]]` → CDP 查 `app.metadataCache` 核验文件与标题真实存在（**这指标抓到了捏造引用**） |
| | unsupported_abstention | 弃答词表命中 + 引用全真 + 无捏造小节 |
| | trap_resistance | quote-trap 标记案例中硬负例块未进入最终证据的比例 |
| Conversation / Reading Assistance | latent_question_hit(0/1/2) / misconception_detection / framework_reconstruction / conceptual_positioning | judge（人工/离线 LLM），runner 记录答案+金标字段供评审 |

**为什么不只用 retrieval_hit 一个分**：块金标 miss ≠ 答案错（模型层会补偿），答案对 ≠ 引用真
（包装性编造）——指标必须分层，才能定位失败在 检索/rerank/context 组装/生成 哪一层。

## 五、评测驱动迭代的四个回合（同口径数据）

| 指标 | 基线 | +P0（闸门/初检/完整性规则） | +P1/P2（混合检索/引用对账/LLM resolver） | +v1.2（停用词/陷阱降权/金标重标） |
|---|---|---|---|---|
| ROUTING ideal | **12.5%** | **87.5%** | 87.5% | — |
| Recall@K | 27.5% | 49.2% | 40%（陷阱暴露） | insight 套件 76% |
| MRR | 0.33 | 0.63 | 0.55 | 1.0（insight） |
| citation | 91%（捏造整段） | 88%（改写标题） | **100%** | 100% 保持 |
| action | 84.6%（旧金标） | 64%→重标 | 68% | **88.9%** |
| 残句答案 | 复现 | 消失 | — | — |
| trap_resistance | — | — | 0（陷阱未设防） | **100%（2/2，正例不误伤）** |

**迭代模式**：跑基线 → 失效模式聚类（不是看平均分，是逐轮读答案/证据/trace）→ 修复 →
定向重跑（--only-case）→ 新失效模式入册（引文陷阱、虚假缺席、疑问词污染都是这么冒出来的）→
金标随之扩容（A15 陷阱块、QT 正反例、insight 套件）。

## 六、面试 war stories（每个都有数据闭环）

1. **"工具被调用 ≠ 检索命中"**：早期 demo 笔记不在授权范围，工具返回"没找到"而检查只验"调用了"——
   从此断言全部对 retrievedPaths/块级证据打分。
2. **"内容对 ≠ 引用真"**：模型把综合答案包装成"📖 笔记原文"并引用不存在的小节；citation_verifiability
   三轮把它从捏造→改写→清零。教训：**引用必须和真实证据清单对账**。
3. **"答案没错但没打中痛点"**：用户在 ChatGPT 的体验（问词义、真实困惑是机制）→ insight 套件
   用 latent_confusion 金标把"痛点命中率"变成可评维度——本插件实测表现好，但含偶然成分
   （检索 miss 恰好把机制块推进 context），对照评测让"好"变得可解释。
4. **金标也要重构**：架构变了，REUSE 的语义就变了——评测体系是活资产，不是一次性考卷。
5. **回归的隐蔽性**：停用词污染、引文陷阱都是**改动引入/暴露的新失效**，没有同口径复跑就会
   悄悄溜进"体感还行"里。
