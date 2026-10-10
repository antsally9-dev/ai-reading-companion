# Agent 架构图（AI Reading Companion）

两张图：第一张看**结构**（谁负责什么），第二张看**流程**（一次问答从头到尾怎么走、循环在哪）。

---

## 图 1：整体分层架构

```mermaid
flowchart TD
    subgraph L1["① 用户可见层"]
        VIEW["对话视图<br/>问题树 · 待问清单 · 摘录草稿 · 收据"]
    end

    subgraph L2["② 编排层（askAi：每问跑一遍单向流水线）"]
        RES["问题理解 Resolver<br/>规则先行 → LLM 解析器（15s 超时静默回落）"]
        PLAN["检索计划 RetrievalPlan<br/>本地查不查 / 翻不翻归档 / 联不联网"]
        CB["上下文构造 ContextBuilder<br/>8 槽位 · 36k 字符预算 · 每轮出收据"]
    end

    subgraph L3["③ 检索层（取证据，都进上下文）"]
        KS["笔记检索<br/>停用词剥离 + n-gram + 引文陷阱降权"]
        ARC["对话归档检索<br/>关键词窗口捞原话"]
        RN["阅读摘录注入<br/>resolvedLinks 反查已确认认知"]
        WEB["联网检索（可选）"]
    end

    subgraph L4["④ 执行层（★ 唯一的循环在这里）"]
        RT["AgentRuntime<br/>模型 ⇄ 工具，最多 3 圈"]
        TG["ToolGateway 预算员<br/>授权 / 次数 / 大小上限"]
        RC["RunController 保安<br/>停止按钮 / 超时掐断"]
    end

    subgraph L5["⑤ 质检层（★ 只标记，不重写）"]
        CS["引用对账<br/>链接降级 / 剥离 + 脚注"]
        FC["引文核对 faithfulness<br/>声称原文 vs 真实块，对不上加脚注"]
    end

    LF[("Langfuse 遥测<br/>每轮 = 一条 trace")]

    VIEW --> RES --> PLAN --> CB
    CB --> L3
    KS --> RT
    ARC --> RT
    RN --> RT
    WEB --> RT
    TG -. 约束 .-> RT
    RC -. 掐断 .-> RT
    RT --> CS --> FC --> VIEW
    RES -.-> LF
    RT -.-> LF
    CS -.-> LF
```

---

## 图 2：一次问答的泳道时序（"聊久了以后呢？"）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant V as 对话视图
    participant A as askAi 编排
    participant R as Resolver 问题理解
    participant C as ContextBuilder 备菜
    participant K as 检索层
    participant X as AgentRuntime
    participant M as 模型 API
    participant Q as 质检层
    participant L as Langfuse

    U->>V: 提问「那聊久了以后呢？」
    V->>A: submitQuestion（锁定输入）
    A->>R: 这句话指什么？
    R-->>A: resolvedQuery + RetrievalPlan<br/>（本地=查 / 归档=不翻 / 联网=不用）
    A->>C: 组装上下文
    Note over C: 8 槽位：规则 / 选段 / 最近6条对话<br/>更早摘要 / 本地证据 / 阅读状态<br/>阅读摘录 / 联网证据
    A->>K: 确定性初检（不等模型决定）
    K-->>A: A04 压缩与裁剪 + A05 摘要丢细节

    rect rgb(255, 245, 230)
        Note over X,M: ★ 内层循环（ReAct 骨架），最多 3 圈
        X->>M: 问题 + 上下文 + 证据
        M-->>X: 我要再查一下 A05 细节（tool_call）
        X->>K: 执行检索（ToolGateway 查预算）
        K-->>X: 返回证据块
        X->>M: 补上证据，再答
        M-->>X: 产出最终答案（无 tool_call，循环结束）
    end

    X-->>A: 答案
    A->>Q: 质检
    Note over Q: 引用对账：链接真实存在？<br/>faithfulness：声称原文的内容能对上块原文？<br/>发现问题 = 答案尾部加透明脚注
    Q-->>A: 答案 + 脚注（如有）
    A-->>V: 渲染答案、更新问题树
    A->>L: 一条 trace（决策依据+证据+用量）
    V-->>U: 看到答案 + 收据 + 存疑标注
```

---

## 图 3：循环的边界（哪些"环"有、哪些刻意没有）

```mermaid
flowchart LR
    subgraph YES["✅ 存在的循环"]
        L_IN["模型 ⇄ 工具<br/>≤3 圈，有预算员盯着"]
        L_SUB["复杂问题分解<br/>子问题依次各跑一遍内层循环，最后合成"]
        L_TURN["每问重跑流水线<br/>阅读状态/摘录每轮重新组装"]
    end
    subgraph NO["❌ 刻意不做的循环"]
        N_RE["答案自检→不满意重答<br/>改为：质检+脚注公开，判断权交还用户"]
        N_PLAN["执行中途重新规划<br/>计划一次定，检索次数有硬上限"]
        N_BG["后台常驻循环<br/>无任何后台任务，你不问它不动"]
    end
```

**为什么质检不重写答案**：① 每重答一次用户多等约 20 秒；② 重写版未必更对，且用户看不到"哪版是对的"；③ 脚注把"这里有存疑"公开给用户，与产品哲学一致——**你确认的才算数**。
