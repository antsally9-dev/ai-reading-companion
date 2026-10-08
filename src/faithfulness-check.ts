// Claim-scoped Faithfulness Check（修复 D2/T4 类"假引文内容"）
// 边界（用户定调）：只核对"声称来自原文"的内容；明确标注为推断/一般知识/主观看法
// 的内容不检查、不算错。真实性只标记、不改写。
//
// 声称信号（三选一即视为 claim）：
//   a. 归因句式："笔记里说/原文写道/文中提到/A04 指出…"后接引号内容
//   b. 归因句式后接冒号段落（120 字内）
//   c. 紧邻 [[..]] 引用（前后 120 字内）的块引用（> 开头）
// 核对：claimed 文本与"本轮真实证据原文 + 选区"的最大 n-gram 余弦 < 阈值 → 未核实。
import { ngramSimilarity } from "./knowledge-scope";

const ATTRIBUTION =
  /(?:笔记|原文|文中|文章|材料|来源|选段|选中的?(?:这段|段落)?|a\d{2}|A\d{2})[^。\n]{0,16}?(?:说|写道|提到|指出|强调|给出|说得很明确|的原话)/;

const QUOTE_PATTERNS = [
  /[「"“]([^」"”\n]{6,160})[」"”]/g,
];

export interface ClaimedQuoteCheck {
  claimed: string;
  verified: boolean;
  bestScore: number;
}

export interface FaithfulnessReport {
  checked: number;
  unverified: number;
  claims: ClaimedQuoteCheck[];
}

const VERIFICATION_THRESHOLD = 0.32;

function bestCorpusScore(claimed: string, corpus: string[]) {
  let best = 0;
  for (const text of corpus) {
    const score = ngramSimilarity(claimed, text);
    if (score > best) {
      best = score;
    }
  }
  return best;
}

export function checkClaimedQuotes(
  answer: string,
  corpus: string[],
): FaithfulnessReport {
  const report: FaithfulnessReport = { checked: 0, unverified: 0, claims: [] };
  const content = String(answer || "");
  if (!corpus.length || !content.trim()) {
    return report;
  }

  const lines = content.split("\n");
  let contextBefore = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const preceding = contextBefore.slice(-160);
    // b. 归因句式 + 块引用/引号（允许归因在上一行末尾）
    const attributionNearby =
      ATTRIBUTION.test(preceding) || ATTRIBUTION.test(line);
    const hasCitationNearby =
      /\[\[[^\]]+\]\]/.test(line) || /\[\[[^\]]+\]\]/.test(preceding);
    const isBlockquote = /^\s*>\s+/.test(line);

    if (isBlockquote || attributionNearby) {
      const text = line.replace(/^\s*>\s+/, "").trim();
      if (text.length < 8) {
        contextBefore += "\n" + line;
        continue;
      }
      // 块引用要求归因或引用链接邻近；引号内容只要求归因邻近（claim-scoped）
      const quoted = [...text.matchAll(QUOTE_PATTERNS[0])].map((m) => m[1]);
      const candidates =
        quoted.length > 0
          ? quoted
          : isBlockquote && (attributionNearby || hasCitationNearby)
            ? [text.slice(0, 160)]
            : attributionNearby && quoted.length === 0 && text.includes("：")
              ? [text.split("：").slice(1).join("：").slice(0, 160)]
              : [];
      for (const claimed of candidates) {
        if (claimed.trim().length < 6) {
          continue;
        }
        const bestScore = bestCorpusScore(claimed, corpus);
        const verified = bestScore >= VERIFICATION_THRESHOLD;
        report.checked += 1;
        if (!verified) {
          report.unverified += 1;
        }
        report.claims.push({ claimed: claimed.slice(0, 120), verified, bestScore });
      }
    }
    contextBefore += "\n" + line;
  }
  return report;
}
