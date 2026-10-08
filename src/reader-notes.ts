// Reader Notes（阅读摘录，读侧注入）
// 产品语义：摘录是用户在对话中人工选择、编辑并确认保存的内容（用户认知），
// 不存在模型自动写入。本模块不写库——只负责"读侧"：打开同一文档的新对话时，
// 把该文档已保存的摘录按预算整理成注入块，让"上周确认过的结论"不依赖关键词
// 检索的运气就能被带上。
// 来源两路：
//   1. 文档自身的保存区（target section 标题之下，source 模式写入的位置）
//   2. 反查 resolvedLinks 找到链接到本文档的笔记（companion/central/历史模式遗留），
//      其中块内含 [[本文档]] 链接的 ### 块才算摘录块
// 块结构按 DEFAULT_SAVE_TEMPLATE 解析（### 时间戳 + [!question] / [!quote] Confirmed
// callout）；用户自定义模板解析失败时退化为"整块截断"，不丢内容。

export interface ReaderNoteSource {
  path: string;
  content: string;
  /** true = 链接笔记：只有块内含 [[source]] 链接的块才算摘录块 */
  requiresLink?: boolean;
  /** 提供时只取该二级标题之下的内容（文档自身的保存区） */
  sectionHeading?: string;
}

export interface ReaderNoteEntry {
  timestamp: string;
  question: string;
  answer: string;
  fromPath: string;
}

export interface ReaderNotesDigest {
  /** 实际注入的条目（新→旧），字段已按预算截断 */
  entries: ReaderNoteEntry[];
  /** 装不下的旧条目，只保留问题列表 */
  omittedQuestions: string[];
  totalEntries: number;
  truncated: boolean;
  characters: number;
}

export const READER_NOTES_BUDGET = 1500;
const ANSWER_LIMIT = 320;
const QUESTION_LIMIT = 120;
const OMITTED_LIMIT = 8;

/** wikilink 目标归一化比较键：小写、去 .md、正斜杠 */
export function readerNoteKey(path: string): string {
  return String(path || "")
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/\\/g, "/");
}

function blockLinksToSource(block: string, sourceKey: string): boolean {
  const re = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (readerNoteKey(m[1]) === sourceKey) {
      return true;
    }
  }
  return false;
}

/** 取二级标题之下的内容（摘录保存区），到下一个二级标题为止 */
function sectionUnder(content: string, sectionHeading: string): string {
  const idx = content.indexOf(sectionHeading);
  if (idx < 0) {
    return "";
  }
  const after = content.slice(idx + sectionHeading.length);
  const next = after.search(/\n##\s/);
  return next >= 0 ? after.slice(0, next) : after;
}

/** 取指定 callout 标记行（如 [!question] / [!quote] … Confirmed）之后的引用体 */
function calloutAfter(body: string, marker: RegExp): string {
  const lines = body.split(/\r?\n/);
  const collected: string[] = [];
  let active = false;
  for (const line of lines) {
    if (!active) {
      if (marker.test(line)) {
        active = true;
      }
      continue;
    }
    if (/^>/.test(line)) {
      collected.push(line.replace(/^>\s?/, ""));
    } else {
      break;
    }
  }
  return collected.join("\n").trim();
}

/** 自定义模板兜底：去掉 Source 行后的整块文本，视作确认内容 */
function fallbackAnswer(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => !/^source\s*:/i.test(line.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseBlocks(content: string): Array<{ heading: string; body: string }> {
  const out: Array<{ heading: string; body: string }> = [];
  const parts = content.split(/^###\s+/m);
  for (let i = 1; i < parts.length; i += 1) {
    const sep = parts[i].indexOf("\n");
    const heading = sep >= 0 ? parts[i].slice(0, sep) : parts[i];
    const body = sep >= 0 ? parts[i].slice(sep + 1) : "";
    out.push({ heading: heading.trim(), body });
  }
  return out;
}

export function collectReaderNotes(input: {
  sourcePath: string;
  sources: ReaderNoteSource[];
  budget?: number;
}): ReaderNotesDigest {
  const budget = Math.max(300, Number(input.budget) || READER_NOTES_BUDGET);
  const sourceKey = readerNoteKey(input.sourcePath);
  const all: ReaderNoteEntry[] = [];
  for (const source of input.sources) {
    if (!source.content) {
      continue;
    }
    const scoped = source.sectionHeading
      ? sectionUnder(source.content, source.sectionHeading)
      : source.content;
    for (const block of parseBlocks(scoped)) {
      if (source.requiresLink && !blockLinksToSource(`${block.heading}\n${block.body}`, sourceKey)) {
        continue;
      }
      const ts = block.heading.match(/(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
      const question = calloutAfter(block.body, /\[!question\]/i);
      const answer =
        calloutAfter(block.body, /\[!quote\][^\n]*confirmed/i) ||
        fallbackAnswer(block.body);
      if (!question && !answer) {
        continue;
      }
      all.push({
        timestamp: ts ? `${ts[1]}${ts[2] ? ` ${ts[2]}` : ""}` : "",
        question,
        answer,
        fromPath: source.path,
      });
    }
  }
  // 新→旧；无时间戳的排最后且顺序稳定
  all.sort((left, right) => {
    if (!left.timestamp && !right.timestamp) return 0;
    if (!left.timestamp) return 1;
    if (!right.timestamp) return -1;
    return left.timestamp < right.timestamp ? 1 : left.timestamp > right.timestamp ? -1 : 0;
  });

  const renderEntry = (entry: ReaderNoteEntry) => {
    const q = entry.question.slice(0, QUESTION_LIMIT);
    const a = entry.answer.slice(0, ANSWER_LIMIT);
    return `- [${entry.timestamp || "undated"}] Q: ${q}\n  Confirmed: ${a}`;
  };
  const costOf = (entry: ReaderNoteEntry) =>
    entry.timestamp.length + Math.min(entry.question.length, QUESTION_LIMIT) +
    Math.min(entry.answer.length, ANSWER_LIMIT) + 40;

  const entries: ReaderNoteEntry[] = [];
  const omittedQuestions: string[] = [];
  let used = 0;
  for (const entry of all) {
    const cost = costOf(entry);
    if (entries.length === 0 || used + cost <= budget) {
      entries.push(entry);
      used += cost;
    } else if (omittedQuestions.length < OMITTED_LIMIT) {
      const label = entry.question.slice(0, 60) || entry.timestamp || "undated";
      omittedQuestions.push(label);
    }
  }
  const characters = entries.reduce((sum, entry) => sum + costOf(entry), 0);
  return {
    entries,
    omittedQuestions,
    totalEntries: all.length,
    truncated: omittedQuestions.length > 0,
    characters,
  };
}

export function renderReaderNotesBlock(digest: ReaderNotesDigest): string {
  if (!digest.entries.length) {
    return "";
  }
  return [
    "Reader notes on this document (excerpts the user explicitly selected and confirmed on the dates shown — the user's own cognition, not the current article text):",
    ...digest.entries.map((entry) => {
      const q = entry.question.slice(0, QUESTION_LIMIT);
      const a = entry.answer.slice(0, ANSWER_LIMIT);
      return `- [${entry.timestamp || "undated"}] Q: ${q}\n  Confirmed: ${a}`;
    }),
    digest.omittedQuestions.length
      ? `Older confirmed questions on this document (excerpts omitted): ${digest.omittedQuestions.join(" ; ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
