# AI Reading Benchmark v1 基线报告

> 运行日期：2026-10-07 ｜ 模型：kimi-k3（真实调用）｜ 设计：`reading-benchmark-v1-design.md`
> 运行器：`scripts/langfuse-benchmark.mjs` ｜ gold：`scripts/evaluation/gold/benchmark-v1.json`
> 原始数据：`runs/benchmark-v1-1791360360233.json` ｜ Langfuse：每 turn 已打分
> （retrieval_action_accuracy / recall_at_k / ndcg_at_k / citation_verifiability / unsupported_abstention）

## 1. 运行概况

计划 38 turns（CORE 8 / ROUTING 8 / 多轮 6 场景 21 / STALE 2），**有效作答 35**：

| 丢失 turn | 原因 |
|---|---|
| CORE/S07 | 超时（6 分钟无完成答案，原因待查） |
| MULTI/M05-T1 | 种子注入成功但该轮超时（见 §5） |
| STALE/ST01 | 开启 web 搜索（provider=kimi）后挂起超时 |

基准文章 = demo vault `Reading notes/Agent Context Engineering 基准.md`（A01–A13，`##` 节 = chunk）。
运行期间归档了内容重叠的旧语料《Agent Context 工程框架》避免金标歧义，其余旧笔记留作跨主题干扰。

## 2. 总分卡

| 指标 | 值 | 样本 | 解读 |
|---|---|---|---|
| retrieval_action_accuracy | **84.6%** | 26 | 高分主要来自"追问轮 REUSE"金标与保守行为一致 |
| routing_action（current 策略） | **100%** | 8 | 现工具描述下行为完全可预测 |
| routing_action（ideal 产品预期） | **12.5%** | 8 | 仅 R07（选区自含答案）符合理想；**闸门差距 87.5 个百分点** |
| Recall@K | **26.2%** | 21 | 检索层最大短板 |
| MRR | 0.33 | 21 | 金标块即使被召回也常不在首位 |
| nDCG@K | 0.51 | 12 | |
| Evidence Precision | 0.31 | 12 | |
| Noise Ratio | **0.69** | 12 | 检索槽位约 7 成是低效用/无关块 |
| citation_verifiability | **91.4%** | 35 | 3 次失败全部集中在 M04（见 §4.2） |
| unsupported_abstention | 1/1 | 1 | S05 完美弃答 |
| freshness_trigger | 0/2 | 2 | 过时内容未触发任何外部验证 |

## 3. 分层发现

### 3.1 路由层：闸门差距已量化（87.5pt）

ROUTING 全部 8 题实际动作 = NO_RETRIEVAL，与 current 预期 100% 吻合、与 ideal 预期仅 12.5% 吻合。
"放宽工具描述触发条件"的产品决策现在有了数据：**自然问法下用户永远得不到笔记证据**，
插件退化为普通聊天。建议按设计文档 §10 做一版放宽描述的对照实验。

### 3.2 检索层：词汇陷阱实锤（最弱一环）

- **A07 吸铁石**：A07 正文里恰好引用了 S02/S03 用户问句的原话（"原封不动塞给模型"），
  导致 S02/S03/S08 的检索都被 A07 吸走，金标 A04/A08/A09 全部 miss。当前检索明显偏词汇匹配，
  语义改述能力不足——这是 T1 报告 `proceed_to_embedding` 决策最直接的线上证据。
- **S04 miss**：问 Memory 却召回 A01（未命中 A05/A10）。
- **噪声 0.69**：跨主题干扰笔记（编程语言上下文/笔记方法对比/间隔重复）反复占位。
  模型层每次都正确识别并声明"与问题无关，略去"——**过滤全靠模型自觉，检索层没有阈值**。

### 3.3 模型层：补偿能力与诚实性

- **块金标 miss ≠ 答案错**：S04 用 A01 的原则正确回答了 Memory 问题；S02 诚实声明
  "没直接检索到原文，这两条当线索"并用 A07 的例子作答。评测要同时看两层（本 benchmark 已分开记录）。
- **弃答完美**：S05 明确"笔记没有说 developer instruction，不能推出一定不会被压缩"。
- **Reading Assistance 亮点（待 judge 正式打分）**：
  - M01/T4 误区检测：识别出用户把"信息被保存"和"本轮可见"混为一谈，给出 Memory/Context 对照表；
  - M07/T5 框架重建："memory 不是 context 的默认成员，是上游候选来源"+ 存储层→注入层分层图。

### 3.4 多轮行为：REUSE 主导，INCREMENTAL 全灭

金标要求增量检索的 4 个追问轮（M01-T2/T3、M07-T2/T4）实际全部 REUSE_PREVIOUS（action_ok=false）。
"Use at most once" 的保守执行在结构化金标下再次确认：**追问换主题时不会增量取证**。

## 4. 两个产品级缺陷（本轮最有价值的产出）

### 4.1 追问轮"残句答案"（M01-T2/T3）

T2 答案全文 = "这个问题正好衔接上一条笔记，让我再查一下笔记里关于长对话的部分。"——只有宣告句，
没有下文。推测：模型想再次检索，但工具预算/单次限制使流程终止，宣告句成了最终输出。
waitReal 判据（答案非空）过弱也由此暴露：**答案非空 ≠ 回答完成**。
修复方向：预算耗尽时应让模型基于已有证据作答并说明"基于此前检索"，而不是裸宣告。

### 4.2 捏造检索结果（M04-T2/T3/T4，citation 三连挂）

模型在**没有发生任何检索**的追问轮输出："这次检索返回了几条相关笔记：
[[A08 User profile]]、[[A12 Procedural memory]]、[[A14 Episodic memory]]、[[A16 Semantic memory]]"——
这些小节**全部不存在**（文章只有 A01–A13，且没有这些标题），是模型编造的"记忆分类学"并包装成检索结果。
T2 捏造"A10 Session memory 和 long-term memory"、T4 捏造"A04 Context 的构建方式"同理。
这是上一轮 gold-set 发现的"包装性编造"的结构化复现，且更严重：**捏造的是检索事件本身**。
修复方向：(a) 把本轮真实检索到的证据清单显式注入 prompt，要求"只能引用清单内来源"；
(b) runner 新增检查"答案宣称检索但该 trace 无 tool span"（本次已有数据可回溯验证）。

### 4.3 次级问题

- **ST02 召回 A01 而非 A13**，且未识别"按 2025 年文章做决策"的时效陷阱（freshness 0/2）；
  ST01 开 web 搜索后挂起 → kimi 搜索 provider 需单独排查。
- **S06 立场相左**：文章 A03 主张"选区只是 anchor，仍应检索全文"，模型答"通常不必再搜"——
  citation 通过但 answer-point 层面 miss，说明 answer-point 评分（程序化或 judge）有必要。
- **M05 种子注入 spike**：视图层注入成功（messages count=2）但后续 turn 超时，
  plain object 消息疑似不被 submitQuestion 接受；需探明插件的消息对象形状后重试。

## 5. 修复优先级建议

| 级 | 项 | 依据 |
|---|---|---|
| P0 | 禁止捏造检索结果（证据清单注入 prompt + 宣称检索/无 span 检查） | §4.2，信任层面问题 |
| P0 | 残句答案（预算耗尽时基于已有证据作答） | §4.1，用户直接可见 |
| P1 | 检索语义化（embedding / rerank / 阈值），重跑 CORE 对比 recall/noise | §3.2，recall 26% + noise 69% |
| P1 | 路由闸门放宽对照实验 | §3.1，87.5pt 差距 |
| P2 | STALE provider 挂起排查；M05 消息形状；答案完成度判据；answer-point 评分 | §4.3 |

## 6. 复现

```bash
# 1) Obsidian 带调试端口打开 mynotes（phase A 取 key），Langfuse 容器组在跑
# 2) 全量
node scripts/langfuse-benchmark.mjs --langfuse-host http://localhost:3000 \
  --public-key pk-... --secret-key sk-... --debug-port 9223
#    单套件：--suite core   （demo vault 已就绪时加 --skip-phase-a）
```

已知报告小 bug：summary 里 citation_failures 的多轮 id 显示 `undefined/T2`（应为 `M04/T2`），
不影响分值与逐 turn 记录。

## 7. Reader Notes 读侧注入（2026-10-08 新增，reader_notes 套件）

**功能**：打开同一文档的新对话时，插件把该文档已保存摘录（用户人工选择、编辑并确认的内容）注入系统提示。两路收集：文档自身保存区（`## AI excerpts` 标题之下）+ 反查 `metadataCache.resolvedLinks` 找链接到本文档的笔记（companion/central/历史模式遗留全覆盖），块内须含 `[[本文档]]` 链接。按 DEFAULT_SAVE_TEMPLATE 解析（`### 时间戳` + `[!question]`/`[!quote] Confirmed` callout），自定义模板退化为整块截断。预算 1500 字符：装得下全量；超了取最新几条全文 + 旧条目只留问题清单（`truncated` 标记）。实现：`src/reader-notes.ts`（纯解析/整形）+ `main.ts gatherReaderNotes`（IO 适配，每轮现算不缓存）。

**Prompt 规则**（integrity rules 新增一条）：Reader notes 是用户此前确认的认知（带日期）——引用时要说明"你之前确认过"，与原文区分；与原文冲突时点破冲突并给出摘录日期，不许悄悄站队。

**验收（2026-10-08 实跑 kimi-k3，runs/benchmark-v1-1791446386040.json）**：

| 指标 | 结果 |
|---|---|
| reader_notes_injected_rate | **1.0**（2/2 轮，count=5 / injected=4 / truncated=true） |
| citation_verifiability | 1.0（companion 笔记标题级引用真实存在） |
| RN1 认知延续 | 通过：复述"先锚点提纲再压缩"原则，标注为用户 09-28 确认的认知，并显式声明"你自己定的操作原则，不是文章通用结论"，还串联了 09-15 的 allocation 视角 |
| RN2 纠正持久化 | 通过：完整重建纠正（最小充分证据集合、补定向检索、动因），并明示"这是对原文 quality over volume 的限定，不是原文表述" |

**已知边界**：companion 笔记位于知识域内，检索工具也能命中它——RN 场景里内容实际经"注入 + 检索"双通道到达答案；通道隔离靠程序化检查（trace metadata `readerNotes.injected>=1`）。夹具由 runner 场景前创建/场景后连目录删除（`makeFixtureNoteEval`/`makeFixtureDeleteEval`），不污染其他套件语料。

复现：`--suite reader_notes`（夹具内容在 gold set `fixture_note` 字段内维护）。
