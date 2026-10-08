// Query Understanding（P0 规则版）
// 目标（见 docs/evaluation/reading-benchmark-v1-design.md 与重构报告）：
//   1. 把"用户这轮真正在问什么"从追问/指代里还原出来（resolvedQuery），
//      供确定性初检与检索工具使用，而不是拿 raw query 直接搜；
//   2. 输出一个 RetrievalPlan（local/web 两路），替代 question-routing.ts
//      单一 boolean 的信息量；
//   3. 识别 freshness 触发词（"现在还是这样吗"），为 P2 的 web verify 留钩子。
// 本版刻意零模型调用（成本/延迟考虑）；LLM 版 resolver 留给 P1，接口不变。

export interface RetrievalPlan {
  local: "none" | "anchor_only" | "search" | "incremental";
  history: "recent_only" | "search_archive";
  web: "none" | "search" | "verify";
  reason: string;
}

export type QuestionRelation =
  | "NEW_TOPIC"
  | "CONTINUE"
  | "REFINE"
  | "COMPARE"
  | "BRANCH"
  | "RETURN";

export interface ResolvedQuestion {
  rawQuery: string;
  resolvedQuery: string;
  relation: QuestionRelation;
  referents: Record<string, string>;
  activeTopicHint: string;
  retrievalPlan: RetrievalPlan;
  freshnessRequired: boolean;
  resolver: "rules" | "model";
}

const FOLLOW_UP_PRONOUNS = [
  "它",
  "他们",
  "她们",
  "这个",
  "那个",
  "这些",
  "那些",
  "上述",
  "刚才",
  "前面",
  "上面",
  "这段",
  "此",
];

const CONTINUE_PREFIXES = ["那", "所以", "然后", "再", "又", "接着", "后来", "还是"];

const EXPLANATION_ONLY = [
  "什么意思",
  "展开",
  "详细说说",
  "详细讲",
  "举个例子",
  "为什么这么说",
  "能再解释",
  "具体说说",
  "再解释",
];

const COMPARE_CUES = ["区别", "对比", "差异", "一样吗", "同一回事", "等同", "分别是"];

const RETURN_CUES = ["回到", "回到刚才", "说回", "刚才说的", "最初", "最开始"];

// 对话归档线索（修复 C1 假回忆）：用户引用早前轮次时，预取归档而非让模型凭记忆重建
const HISTORY_CUES = [
  "你刚才", "你之前", "之前说", "之前提到", "最开始", "当时", "你举的", "你给的例子",
  "你推荐", "我们聊过", "前面提到", "前面说", "刚才说", "上次说", "你说的那个",
  "达成一致", "对齐过",
];

const FRESHNESS_CUES = [
  "现在还是",
  "现在还",
  "目前还",
  "最新",
  "还适用",
  "还成立",
  "过时",
  "已经变",
  "现在是不是",
  "现在是不是还",
];

function stripImperativePrefix(question: string) {
  return String(question || "")
    .replace(/^(?:请)?(?:再|又)?帮我(?:查找|搜索|检索|找一下)(?:一下)?(?:笔记|知识库|资料)?[:：]?/u, "")
    .replace(/^(?:帮我)?(?:查找|搜索|检索)(?:笔记|知识库)[:：]?/u, "")
    .trim();
}

function classifyRelation(question: string, followUpLike: boolean): QuestionRelation {
  const text = String(question || "");
  if (RETURN_CUES.some((cue) => text.includes(cue))) return "RETURN";
  if (COMPARE_CUES.some((cue) => text.includes(cue))) return followUpLike ? "COMPARE" : "NEW_TOPIC";
  if (!followUpLike) return "NEW_TOPIC";
  if (EXPLANATION_ONLY.some((cue) => text.includes(cue))) return "REFINE";
  return "CONTINUE";
}

function detectReferents(question: string, previousQuestion: string) {
  const referents: Record<string, string> = {};
  const text = String(question || "");
  const subjectHint = stripImperativePrefix(previousQuestion).slice(0, 80);
  for (const pronoun of FOLLOW_UP_PRONOUNS) {
    if (subjectHint && text.includes(pronoun)) {
      referents[pronoun] = `<上一轮问题主语：${subjectHint}>`;
    }
  }
  return referents;
}

export function resolveQuestion(input: {
  question: string;
  turnIndex: number;
  previousQuestion?: string;
  lastAnswerExcerpt?: string;
  selectedPassage?: string;
  explicitLocalSearch: boolean;
  explicitWebSearch: boolean;
}): ResolvedQuestion {
  const rawQuery = String(input.question || "").trim();
  const previousQuestion = String(input.previousQuestion || "").trim();
  const text = rawQuery;
  const followUpLike =
    input.turnIndex > 1 &&
    (text.length <= 24 ||
      CONTINUE_PREFIXES.some((prefix) => text.startsWith(prefix)) ||
      FOLLOW_UP_PRONOUNS.some((pronoun) => text.includes(pronoun)));

  const relation = classifyRelation(text, followUpLike);
  const referents = detectReferents(text, previousQuestion);

  // resolvedQuery：追问轮把上一轮问题的主干拼进来，让词汇检索也能借到上文实词。
  // 纯 NEW_TOPIC 或首轮直接用原文（去掉祈使前缀，避免"帮我查找笔记"浪费匹配位）。
  let resolvedQuery = stripImperativePrefix(rawQuery);
  if (
    followUpLike &&
    previousQuestion &&
    relation !== "NEW_TOPIC" &&
    relation !== "RETURN"
  ) {
    const prevCore = stripImperativePrefix(previousQuestion).slice(0, 100);
    resolvedQuery = [prevCore, resolvedQuery].filter(Boolean).join(" ");
  }
  if (resolvedQuery.length > 240) resolvedQuery = resolvedQuery.slice(0, 240);

  const freshnessRequired =
    FRESHNESS_CUES.some((cue) => text.includes(cue)) ||
    /20(2[0-9])/.test(String(input.selectedPassage || "")) && /现在|目前|还/.test(text);

  const localPlan: RetrievalPlan["local"] = (() => {
    if (relation === "NEW_TOPIC") {
      // 首轮/新话题：默认确定性初检；明确只问选区本身时锚定即可
      return /这段话|这个选区|我选中|选中的这段|这段内容/u.test(text)
        ? "anchor_only"
        : "search";
    }
    if (EXPLANATION_ONLY.some((cue) => text.includes(cue)) && relation === "REFINE") {
      return "anchor_only"; // 解释型追问：复用已有证据，不再检索
    }
    return "incremental";
  })();

  const webPlan: RetrievalPlan["web"] = input.explicitWebSearch
    ? "search"
    : freshnessRequired
      ? "verify"
      : "none";

  const historyPlan: RetrievalPlan["history"] =
    input.turnIndex > 1 && HISTORY_CUES.some((cue) => text.includes(cue))
      ? "search_archive"
      : "recent_only";

  const reason = [
    `turn=${input.turnIndex}`,
    `relation=${relation}`,
    followUpLike ? "follow-up" : "new",
    input.explicitLocalSearch ? "explicit-local" : "",
    historyPlan === "search_archive" ? "history-ref" : "",
  ]
    .filter(Boolean)
    .join(",");

  return {
    rawQuery,
    resolvedQuery,
    relation,
    referents,
    activeTopicHint: stripImperativePrefix(
      relation === "NEW_TOPIC" ? rawQuery : previousQuestion || rawQuery,
    ).slice(0, 80),
    retrievalPlan: {
      local: localPlan,
      history: historyPlan,
      web: webPlan,
      reason,
    },
    freshnessRequired,
    resolver: "rules",
  };
}

// ---------------------------------------------------------------------------
// LLM 版 resolver（P1）：规则版接口不变，追问轮用主模型把指代/省略解析成
// 自含的 resolvedQuery + RetrievalPlan。任何失败（超时/解析错误/枚举非法）
// 都静默回退规则版——确定性优先，模型只做增强。
// ---------------------------------------------------------------------------

const RESOLVER_SYSTEM_PROMPT = [
  "You resolve follow-up questions for a reading assistant into self-contained retrieval queries.",
  'Return JSON only: {"resolvedQuery": string, "relation": "NEW_TOPIC"|"CONTINUE"|"REFINE"|"COMPARE"|"BRANCH"|"RETURN", "referents": object, "activeTopic": string, "local": "none"|"anchor_only"|"search"|"incremental", "history": "recent_only"|"search_archive", "web": "none"|"search"|"verify", "freshnessRequired": boolean}.',
  "resolvedQuery must fully replace pronouns/ellipsis using the previous turns, be searchable standalone, and keep the user's language.",
  "local=anchor_only when the question only asks to explain already-shown material; incremental when it needs evidence not yet shown; search for a new topic; none only when notes are clearly irrelevant.",
  "web=verify when the question asks whether something still holds / is up to date.",
].join("\n");

function parseResolverJson(raw: string) {
  const text = String(raw || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const RELATIONS = ["NEW_TOPIC", "CONTINUE", "REFINE", "COMPARE", "BRANCH", "RETURN"];
const LOCAL_PLANS = ["none", "anchor_only", "search", "incremental"];
const HISTORY_PLANS = ["recent_only", "search_archive"];
const WEB_PLANS = ["none", "search", "verify"];

export async function resolveQuestionWithModel(
  input: Parameters<typeof resolveQuestion>[0] & {
    callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
  },
): Promise<ResolvedQuestion> {
  const fallback = resolveQuestion(input);
  // 首轮没有上文可解析，规则版足够（也省一次模型调用的成本/延迟）
  if (input.turnIndex < 2) {
    return fallback;
  }
  try {
    const userPrompt = [
      `Current question: ${input.question}`,
      `Previous user question: ${input.previousQuestion || "(none)"}`,
      `Previous AI answer (excerpt): ${String(input.lastAnswerExcerpt || "").slice(0, 400)}`,
      `Selected passage (excerpt): ${String(input.selectedPassage || "").slice(0, 300)}`,
      `Rule-based preliminary plan (may be wrong): local=${fallback.retrievalPlan.local}, relation=${fallback.relation}`,
      "Resolve the current question now. JSON only.",
    ].join("\n\n");
    const raw = await input.callModel(RESOLVER_SYSTEM_PROMPT, userPrompt);
    const parsed = parseResolverJson(raw);
    if (!parsed || typeof parsed.resolvedQuery !== "string" || !parsed.resolvedQuery.trim()) {
      return fallback;
    }
    const local = LOCAL_PLANS.includes(parsed.local) ? parsed.local : fallback.retrievalPlan.local;
    const history = HISTORY_PLANS.includes(parsed.history) ? parsed.history : fallback.retrievalPlan.history;
    const web = WEB_PLANS.includes(parsed.web) ? parsed.web : fallback.retrievalPlan.web;
    const relation = RELATIONS.includes(parsed.relation)
      ? parsed.relation as QuestionRelation
      : fallback.relation;
    return {
      rawQuery: fallback.rawQuery,
      resolvedQuery: parsed.resolvedQuery.trim().slice(0, 400),
      relation,
      referents:
        parsed.referents && typeof parsed.referents === "object" && !Array.isArray(parsed.referents)
          ? Object.fromEntries(
              Object.entries(parsed.referents)
                .slice(0, 8)
                .map(([key, value]) => [String(key), String(value).slice(0, 80)]),
            )
          : fallback.referents,
      activeTopicHint:
        typeof parsed.activeTopic === "string" && parsed.activeTopic.trim()
          ? parsed.activeTopic.trim().slice(0, 80)
          : fallback.activeTopicHint,
      retrievalPlan: {
        local,
        history,
        web,
        reason: `model;rules=${fallback.retrievalPlan.reason}`,
      },
      freshnessRequired:
        typeof parsed.freshnessRequired === "boolean"
          ? parsed.freshnessRequired
          : fallback.freshnessRequired,
      resolver: "model",
    };
  } catch {
    return fallback;
  }
}
