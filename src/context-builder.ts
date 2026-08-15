import type { ContextBudgets } from "./run-plan";

export type ContextSectionKind =
  | "system"
  | "selected_passage"
  | "conversation"
  | "conversation_compaction"
  | "question_history"
  | "confirmed_memory"
  | "local_evidence"
  | "web_evidence";

export interface ContextReceiptSection {
  kind: ContextSectionKind;
  included: boolean;
  originalCharacters: number;
  includedCharacters: number;
  truncated: boolean;
  reason: string;
}

export interface ContextReceipt {
  version: 1;
  runId: string;
  createdAt: number;
  estimatedInputTokens: number;
  totalCharacters: number;
  totalCharacterBudget: number;
  imageCount: number;
  knowledgeScopePath: string;
  webSearchRoute: "hosted" | "independent" | "disabled";
  localSources?: Array<{
    path: string;
    title: string;
    identity: string;
    epistemicStatus: string;
  }>;
  sections: ContextReceiptSection[];
}

export interface BuildContextOptions {
  runId: string;
  createdAt?: number;
  budgets: ContextBudgets;
  systemPrompt: string;
  selectedPassage: string;
  conversation: any[];
  imageParts?: any[];
  localEvidence?: string;
  webEvidence?: string;
  questionHistory?: string;
  confirmedMemory?: string;
  localEvidenceInstructions?: string;
  webEvidenceInstructions?: string;
  knowledgeScopePath?: string;
  webSearchRoute: ContextReceipt["webSearchRoute"];
}

export interface BuiltContext {
  messages: any[];
  receipt: ContextReceipt;
}

function textContent(content: any) {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return String(content || "");
  }
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : String(part?.text || part?.content || ""),
    )
    .filter(Boolean)
    .join("\n");
}

function countMessageCharacters(messages: any[]) {
  return messages.reduce(
    (total, message) => total + textContent(message?.content).length,
    0,
  );
}

function estimateTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    if (character.charCodeAt(0) <= 127) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 4 + nonAscii / 1.5);
}

function truncateText(text: string, limit: number) {
  const normalized = String(text || "").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  if (limit <= 80) {
    return normalized.slice(0, Math.max(0, limit));
  }
  const marker = "\n\n[…context trimmed…]\n\n";
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.75);
  return `${normalized.slice(0, head)}${marker}${normalized.slice(-(available - head))}`;
}

function receiptSection(
  kind: ContextSectionKind,
  original: string,
  included: string,
  reason = "",
): ContextReceiptSection {
  return {
    kind,
    included: Boolean(included),
    originalCharacters: original.length,
    includedCharacters: included.length,
    truncated: included.length < original.length,
    reason:
      reason ||
      (included.length < original.length
        ? "Reduced to the section budget."
        : included
          ? "Included within budget."
          : "No relevant content was supplied."),
  };
}

function compactMessages(messages: any[], limit: number) {
  const lines: string[] = [];
  for (const message of messages) {
    const content = textContent(message?.content).replace(/\s+/g, " ").trim();
    if (!content) {
      continue;
    }
    const role = message?.role === "assistant" ? "AI answer" : "User question";
    const correction =
      message?.role === "user" &&
      /(?:不对|纠正|更正|不是这个意思|actually|correction)/i.test(content)
        ? " [explicit correction]"
        : "";
    lines.push(`- ${role}${correction}: ${truncateText(content, role === "AI answer" ? 420 : 280)}`);
  }
  return truncateText(lines.join("\n"), limit);
}

function selectConversation(messages: any[], budget: number, compactionBudget: number) {
  const normalized = (messages || [])
    .filter(
      (message) =>
        message &&
        message.cancelled !== true &&
        (message.role === "user" || message.role === "assistant") &&
        textContent(message.content).trim(),
    )
    .map((message) => ({
      ...message,
      content: textContent(message.content).trim(),
    }));
  const recent: any[] = [];
  let used = 0;
  const reservedForCompaction = Math.min(
    compactionBudget,
    Math.max(0, budget - Math.min(512, budget)),
  );
  const recentBudget = Math.max(0, budget - reservedForCompaction);
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const message = normalized[index];
    const length = message.content.length;
    if (recent.length && used + length > recentBudget) {
      break;
    }
    const remaining = Math.max(0, recentBudget - used);
    if (!remaining) {
      break;
    }
    recent.unshift({ ...message, content: truncateText(message.content, remaining) });
    used += Math.min(length, remaining);
    if (used >= recentBudget) {
      break;
    }
  }
  const omittedCount = Math.max(0, normalized.length - recent.length);
  const omitted = normalized.slice(0, omittedCount);
  const compaction = omitted.length
    ? compactMessages(omitted, Math.min(compactionBudget, Math.max(0, budget - used)))
    : "";
  return { normalized, recent, omitted, compaction };
}

export class ContextBuilder {
  build(options: BuildContextOptions): BuiltContext {
    const sections: ContextReceiptSection[] = [];
    let remaining = Math.max(1_000, options.budgets.totalCharacters);
    const take = (kind: ContextSectionKind, raw: string, sectionLimit: number) => {
      const original = String(raw || "").trim();
      const limit = Math.max(0, Math.min(sectionLimit, remaining));
      const included = truncateText(original, limit);
      remaining = Math.max(0, remaining - included.length);
      sections.push(
        receiptSection(
          kind,
          original,
          included,
          remaining === 0 && included.length < original.length
            ? "Reduced because the total context budget was exhausted."
            : "",
        ),
      );
      return included;
    };

    const system = take(
      "system",
      options.systemPrompt,
      options.budgets.systemCharacters,
    );
    const passage = take(
      "selected_passage",
      options.selectedPassage,
      options.budgets.passageCharacters,
    );
    const confirmedMemory = take(
      "confirmed_memory",
      options.confirmedMemory || "",
      options.budgets.confirmedMemoryCharacters || 0,
    );
    const conversationBudget = Math.min(
      options.budgets.conversationCharacters,
      remaining,
    );
    const selectedConversation = selectConversation(
      options.conversation,
      conversationBudget,
      options.budgets.compactionCharacters,
    );
    const compaction = selectedConversation.compaction;
    const recentMessages = selectedConversation.recent;
    const recentCharacters = countMessageCharacters(recentMessages);
    remaining = Math.max(0, remaining - compaction.length - recentCharacters);
    sections.push(
      receiptSection(
        "conversation_compaction",
        selectedConversation.omitted.map((message) => message.content).join("\n"),
        compaction,
        compaction
          ? "Older turns were reduced to one deterministic role-labelled summary."
          : "No older turns required compaction.",
      ),
    );
    const localEvidence = take(
      "local_evidence",
      options.localEvidence || "",
      options.budgets.localEvidenceCharacters,
    );
    const webEvidence = take(
      "web_evidence",
      options.webEvidence || "",
      options.budgets.webEvidenceCharacters,
    );
    const questionHistory = take(
      "question_history",
      options.questionHistory || "",
      options.budgets.questionHistoryCharacters || 0,
    );
    sections.push(
      receiptSection(
        "conversation",
        selectedConversation.normalized.map((message) => message.content).join("\n"),
        recentMessages.map((message) => message.content).join("\n"),
        selectedConversation.omitted.length
          ? "Only the most recent full turns were retained."
          : "All conversation turns fit within budget.",
      ),
    );

    const messages: any[] = [];
    if (system) {
      messages.push({ role: "system", content: system });
    }
    if (passage) {
      messages.push({
        role: "system",
        content: [
          "The user explicitly selected the following source passage. Treat it as the primary reading context:",
          "",
          passage,
        ].join("\n"),
      });
    }
    if (confirmedMemory) {
      messages.push({
        role: "system",
        content: [
          "The user explicitly confirmed these explanation preferences. Apply them only to presentation style, not as factual evidence:",
          "",
          confirmedMemory,
        ].join("\n"),
      });
    }
    if (questionHistory) {
      messages.push({
        role: "system",
        content: [
          "Related historical user questions are supplied only to preserve learning continuity. They are not evidence and no old AI answers are included:",
          "",
          questionHistory,
        ].join("\n"),
      });
    }
    if (localEvidence) {
      messages.push({
        role: "system",
        content: [options.localEvidenceInstructions || "Local evidence:", "", localEvidence].join("\n"),
      });
    }
    if (webEvidence) {
      messages.push({
        role: "system",
        content: [options.webEvidenceInstructions || "Web evidence:", "", webEvidence].join("\n"),
      });
    }
    if (compaction) {
      messages.push({
        role: "system",
        content: [
          "Earlier turns were compacted deterministically. Use this only for continuity; prefer the full recent turns when they conflict:",
          "",
          compaction,
        ].join("\n"),
      });
    }
    messages.push(...recentMessages);
    const imageParts = options.imageParts || [];
    if (imageParts.length) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role !== "user") {
          continue;
        }
        messages[index] = {
          ...messages[index],
          content: [
            { type: "text", text: textContent(messages[index].content) },
            ...imageParts,
          ],
        };
        break;
      }
    }
    const totalCharacters = sections.reduce(
      (total, section) => total + section.includedCharacters,
      0,
    );
    const estimatedText = messages.map((message) => textContent(message.content)).join("\n");
    return {
      messages,
      receipt: {
        version: 1,
        runId: options.runId,
        createdAt: options.createdAt || Date.now(),
        estimatedInputTokens: estimateTokens(estimatedText),
        totalCharacters,
        totalCharacterBudget: options.budgets.totalCharacters,
        imageCount: imageParts.length,
        knowledgeScopePath: String(options.knowledgeScopePath || ""),
        webSearchRoute: options.webSearchRoute,
        sections,
      },
    };
  }
}
