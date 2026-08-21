export interface QuestionToolNeeds {
  localKnowledge: boolean;
  webSearch: boolean;
}

function normalizedQuestion(value: unknown) {
  const text =
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : "";
  return text
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const LOCAL_KNOWLEDGE_PATTERNS = [
  /(?:搜索|检索|查找|找出|找一下|翻一下).{0,12}(?:笔记|知识库|目录|文件夹)/,
  /(?:笔记|知识库|目录|文件夹).{0,12}(?:搜索|检索|查找|找出|找一下)/,
  /(?:本地|当前|我的|obsidian).{0,10}(?:文件|文档|资料).{0,12}(?:搜索|检索|查找|找出|找一下)/,
  /(?:之前|以前|历史|已有|保存过).{0,12}(?:问题|讨论|笔记|知识|材料|内容)/,
  /(?:和|与).{0,30}(?:之前|以前|历史).{0,30}(?:关系|联系|关联)/,
  /(?:关联|联系|相关).{0,12}(?:笔记|知识|材料|内容|讨论)/,
  /(?:search|find|look up|retrieve).{0,24}(?:notes?|knowledge|vault|folder|documents?|files?)/i,
  /(?:previous|earlier|historical|saved).{0,24}(?:question|discussion|note|knowledge|material)/i,
];

const WEB_SEARCH_PATTERNS = [
  /(?:联网|上网|网页|网络).{0,10}(?:搜索|检索|查找|查询|来源)/,
  /(?:搜索|检索|查找|查询).{0,10}(?:网页|网络|互联网|官网|官方文档|新闻)/,
  /(?:最新|目前|当前|今天|近期|最近).{0,14}(?:消息|新闻|版本|价格|政策|规定|数据|进展|状态|文档)/,
  /(?:官网|官方文档|链接|网址|新闻|实时信息|来源引用)/,
  /(?:web|online|internet).{0,16}(?:search|source|lookup)/i,
  /(?:search|find|look up).{0,16}(?:web|online|internet|official docs?|news)/i,
  /(?:search|find|look up).{0,16}(?:result|source|citation)/i,
  /(?:official|primary).{0,12}(?:source|link|website|documentation|docs?)/i,
  /(?:latest|current|today|recent|fresh).{0,16}(?:news|version|price|policy|data|status|docs?|fact|information|info)/i,
];

function matchesAny(question: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(question));
}

/**
 * Deterministic routing keeps ordinary passage explanations on a single model
 * call. The user's toggles remain permission switches; tools are attached only
 * when the wording actually asks for local continuity or fresh web evidence.
 */
export function determineQuestionToolNeeds(question: unknown): QuestionToolNeeds {
  const normalized = normalizedQuestion(question);
  const localKnowledge = matchesAny(normalized, LOCAL_KNOWLEDGE_PATTERNS);
  return {
    localKnowledge,
    webSearch:
      matchesAny(normalized, WEB_SEARCH_PATTERNS) ||
      (!localKnowledge && /(?:搜索|检索|查找|查询|\bsearch\b|\blookup\b)/i.test(normalized)),
  };
}
