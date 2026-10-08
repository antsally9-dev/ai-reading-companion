# T1 检索评测报告：词法检索 gold set 验证

> 日期：2026-09-20
> 执行：T1【P0·先测量】建立检索 gold set，验证词法检索
> 产物：`docs/evaluation/gold-set.json`（30 题带标注）、`docs/evaluation/vault/`（14 篇评测语料）、`scripts/evaluation/`（评测脚本）、`docs/evaluation/retrieval-eval-result.json`（逐题原始数据）
> 复现：`node scripts/evaluation/run-retrieval-eval.mjs`

---

## 一句话结论

**词法检索的文件级召回能力达标（Top-3 命中 90%，直问 100%），但同义改写子集的最终段落命中率 54%（7/13），低于 60% 阈值——按预定决策规则应启动增量 embedding；同时评测抓出并修复了一个独立于 embedding 的段落选择缺陷（H1 标题块吸分），修复后整体段落命中从 33% 提升到 67%。**

## 评测口径

- **主口径（final_hit）**：完整模拟 `RetrieveKnowledgeEvidence` 工具行为——`search(query, limit=3)`（真实运行时 `MAX_READ_REFS=3`）→ `read(全部 refs)` → 判定 read 对 gold 文件选出的 Top 段落 heading 是否等于 gold heading。文件进了 Top-3 但段落选错记 miss。
- **参照口径**：`search(query, limit=6)`（`MAX_SCOPE_RESULTS` 上限）下 gold 文件的排名，用于观察 lane 配额放宽后的文件级召回。
- **同义改写**：问题不点破 gold 段落核心术语，用日常措辞描述同一概念（标注于 gold-set.json）。

## 总体结果（修复后）

| 分桶 | 题数 | 文件级 Top-3 | 文件级 Top-6 | 最终段落命中 |
|---|---|---|---|---|
| 全部 | 30 | 27（90%） | 28（93%） | 20（67%） |
| 直问 | 17 | 17（100%） | 17（100%） | 13（76%） |
| 同义改写 | 13 | 10（77%） | 11（85%） | **7（54%）** |

按问题类型：concept 6/11、howto 7/9、comparison 3/5、lookup 4/5。

## 过程发现：H1 标题块吸分缺陷（已修复）

**症状**：首跑时文件级 Top-3 命中 27/30，但最终段落命中只有 10/30。几乎所有 miss 的 `read_heading` 都是文件名本身（"间隔重复"而非"核心原理"）。

**根因**（`src/knowledge-scope.ts` 的 `splitMarkdownPassages`）：
1. frontmatter（`---` 块）被当成第一个段落（heading=""）；
2. H1 标题行单独成段，而 H1 文本与文件名完全相同，叠加 `scorePassage` 的 heading 命中 +6/term 规则后，H1 块分数恒高于内容段落，导致 read 返回一个只有标题行的"空证据"。

**修复**：切分段落时剥掉 frontmatter；过滤"去掉标题行后无实质文本"的纯标题块。修复前后对比：最终段落命中 10/30（33%）→ 20/30（67%），直问子集 7/17 → 13/17。`tsc` 与 `eslint` 通过。

该缺陷与 embedding 无关——不修它，即使上了向量检索，read 阶段照样返回空标题段。评测把它拦在了 embedding 决策之前，这正是"先测量"的价值。

## 剩余 miss 分解（10 题）

| 类别 | 题数 | 占比 | 题号 | 性质 |
|---|---|---|---|---|
| A. 文件对、段落近似错 | 7 | 54% | q03 q05 q15 q20 q21 q22 q29 | 宽泛问题下同文件内另一段得分更高（如"刻意练习是什么"选中"与机械重复的区别"）。回答质量受损中等——证据段仍含答案素材 |
| B1. 词面零召回 | 2 | 15% | q06 q27 | 问题用词与 gold 段落无任何共同 2-gram（"背过的东西过两天就忘" vs "记忆痕迹消退"） |
| B2. 弱召回被 lane 挤出 | 1 | 8% | q28 | 记忆宫殿（external_material）排第 5，limit=3 时 external 配额仅 1 席，被挤出 |

（剩余 0 题为修复前已解决的 H1 类。）

## 决策结论

**按任务书预定规则执行：同义改写子集最终命中率 54% < 60% → 对授权 Scope 启动增量 embedding。**

落地建议（按优先级）：
1. **embedding 只做文件级召回增强**：对授权 scope 的段落建立向量索引，与词法分数融合排序（不改 read 的段落选择流程）。预期直接解决 B1/B2 类（3/13）；A 类（7 题）主要靠"召回到正确文件"后由模型在工具循环里追问消化。
2. **lane 配额暂不调整**：external 配额挤出问题（q28）在 embedding 融合后可复测；当前 30 题样本下只有 1 例，证据不足。
3. **回归护栏**：本 gold set + 评测脚本纳入后续任何检索改动的回归验证（含 embedding 落地后的对照实验）。

## 限制声明

- gold set 为构造语料（backlog 中无现成真实问题），问题分布代表本人对使用场景的模拟；30 题中同义改写 13 题，与真实使用比例未知。
- 语料规模 14 篇，真实 vault 的 300 文件索引上限、2MB 总字符预算下的行为未覆盖。
- 评测未覆盖 Prior discussion lane（session-store）与 Learning state lane（memory-store）——它们不在 `KnowledgeScopeRetriever` 内，需在 T5/T6 时单独评测。
