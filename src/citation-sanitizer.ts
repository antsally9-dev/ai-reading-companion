// Citation Sanitizer
// 职责边界（2026-10-08 设计修正）：只做"拦截/降级不可信的引用"，**不做静默修复**。
// 早期版本会把写错的标题自动改写成真实标题（按 Axx 前缀/相似度）——实测证明这是
// "洗白"：模型编造的引文内容（"A04 长期运行的可靠性…"）经修复后挂上了真实标题，
// 引用真实性指标反而显示通过。真实性只能来自模型自己写对，不能由代码代造。
//   - 文件+标题都对            → 保留
//   - 文件对、标题写错          → 降级为文件级引用（不加真标题），计入 downgraded
//   - 文件不在本轮证据清单      → 剥掉链接语法保留可读文本，计入 stripped
// main.ts 依据 report 在答案尾部追加存疑说明（对用户透明，不静默）。
import { ngramSimilarity } from "./knowledge-scope";

export interface CitationSanitizerReport {
  checked: number;
  kept: number;
  downgraded: number;
  stripped: number;
}

interface EvidenceFile {
  path: string;
  title: string;
  heading: string;
  headings: string[];
}

const WIKILINK = /\[\[([^\]#|]+)(?:#([^\]|]+))?(?:\|([^\]]*))?\]\]/g;
const AX_ID = /^(a\d{2})\b/i;

function normalizeHeading(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.md$/i, "");
}

function normalizePathValue(value: string) {
  return String(value || "")
    .trim()
    .replace(/\.md$/i, "")
    .toLowerCase();
}

function resolveEvidenceFile(target: string, inventory: EvidenceFile[]) {
  const normalized = normalizePathValue(target);
  if (!normalized) {
    return null;
  }
  for (const item of inventory) {
    if (normalizePathValue(item.path) === normalized) {
      return item;
    }
  }
  for (const item of inventory) {
    if (normalizePathValue(item.path).endsWith(`/${normalized}`)) {
      return item;
    }
  }
  for (const item of inventory) {
    if (normalizePathValue(item.title) === normalized) {
      return item;
    }
  }
  return null;
}

function headingMatches(heading: string, evidence: EvidenceFile) {
  const target = normalizeHeading(heading);
  if (!target) {
    return true;
  }
  return evidence.headings.some((candidate) => {
    const normalized = normalizeHeading(candidate);
    return (
      normalized === target ||
      normalized.startsWith(target) ||
      target.startsWith(normalized)
    );
  });
}

function repairHeading(heading: string, evidence: EvidenceFile) {
  const targetId = (normalizeHeading(heading).match(AX_ID) || [])[1];
  if (targetId) {
    const byId = evidence.headings.find(
      (candidate) =>
        (normalizeHeading(candidate).match(AX_ID) || [])[1] === targetId,
    );
    if (byId) {
      return byId;
    }
  }
  let best = "";
  let bestScore = 0;
  for (const candidate of evidence.headings) {
    const score = ngramSimilarity(heading, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 0.6 ? best : "";
}

export function sanitizeCitations(
  answer: string,
  inventory: EvidenceFile[],
): { content: string; report: CitationSanitizerReport } {
  const report: CitationSanitizerReport = {
    checked: 0,
    kept: 0,
    downgraded: 0,
    stripped: 0,
  };
  if (!inventory.length) {
    return { content: String(answer || ""), report };
  }
  const content = String(answer || "").replace(
    WIKILINK,
    (whole, rawPath: string, rawHeading: string, rawAlias: string) => {
      report.checked += 1;
      const alias = String(rawAlias || "").trim();
      const evidence = resolveEvidenceFile(rawPath, inventory);
      if (!evidence) {
        // 文件都不在本轮证据里：剥掉链接语法，保留可读文本
        report.stripped += 1;
        return alias || `${rawPath}${rawHeading ? `#${rawHeading}` : ""}`;
      }
      const heading = String(rawHeading || "").trim();
      if (!heading || headingMatches(heading, evidence)) {
        report.kept += 1;
        return whole;
      }
      // 标题写错：降级为文件级引用。不猜测真实标题——模型引用的内容
      // 未必真来自该文件的任何一节，代写标题等于替它背书。
      report.downgraded += 1;
      return alias ? `[[${evidence.path}|${alias}]]` : `[[${evidence.path}]]`;
    },
  );
  return { content, report };
}
