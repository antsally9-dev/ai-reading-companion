import type { ModelApiProtocol } from "./responses-api";
import type { ToolGrant } from "./tool-gateway";

export interface ContextBudgets {
  totalCharacters: number;
  systemCharacters: number;
  passageCharacters: number;
  conversationCharacters: number;
  questionHistoryCharacters: number;
  confirmedMemoryCharacters: number;
  localEvidenceCharacters: number;
  webEvidenceCharacters: number;
  compactionCharacters: number;
}

export interface ImageBudgets {
  maxCount: number;
  maxSourceBytes: number;
  maxTotalSourceBytes: number;
  maxEdge: number;
  outputQuality: number;
}

export interface AgentRunPlan {
  id: string;
  createdAt: number;
  device: "desktop" | "mobile";
  apiProtocol: ModelApiProtocol;
  webSearchRoute: "hosted" | "independent" | "disabled";
  knowledgeScopePath: string;
  timeoutMs: number;
  maxToolRounds: number;
  maxToolEvidenceCharacters: number;
  context: Readonly<ContextBudgets>;
  images: Readonly<ImageBudgets>;
  toolGrants: readonly Readonly<ToolGrant>[];
}

export interface CreateAgentRunPlanOptions {
  mobile: boolean;
  apiProtocol: ModelApiProtocol;
  webSearchRoute: AgentRunPlan["webSearchRoute"];
  knowledgeScopePath?: string;
  timeoutMs?: number;
  maxToolRounds?: number;
  maxToolEvidenceCharacters?: number;
  toolGrants?: ToolGrant[];
}

function createRunId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createAgentRunPlan(
  options: CreateAgentRunPlanOptions,
): Readonly<AgentRunPlan> {
  const context: ContextBudgets = options.mobile
    ? {
        totalCharacters: 28_000,
        systemCharacters: 5_000,
        passageCharacters: 8_000,
        conversationCharacters: 9_000,
        questionHistoryCharacters: 1_500,
        confirmedMemoryCharacters: 1_000,
        localEvidenceCharacters: 4_000,
        webEvidenceCharacters: 5_000,
        compactionCharacters: 2_000,
      }
    : {
        totalCharacters: 36_000,
        systemCharacters: 6_000,
        passageCharacters: 10_000,
        conversationCharacters: 12_000,
        questionHistoryCharacters: 2_000,
        confirmedMemoryCharacters: 1_500,
        localEvidenceCharacters: 6_000,
        webEvidenceCharacters: 8_000,
        compactionCharacters: 2_500,
      };
  const images: ImageBudgets = options.mobile
    ? {
        maxCount: 4,
        maxSourceBytes: 6 * 1024 * 1024,
        maxTotalSourceBytes: 18 * 1024 * 1024,
        maxEdge: 1280,
        outputQuality: 0.76,
      }
    : {
        maxCount: 9,
        maxSourceBytes: 10 * 1024 * 1024,
        maxTotalSourceBytes: 80 * 1024 * 1024,
        maxEdge: 1600,
        outputQuality: 0.82,
      };
  const grants = (options.toolGrants || []).map((grant) =>
    Object.freeze({ ...grant }),
  );
  return Object.freeze({
    id: createRunId(),
    createdAt: Date.now(),
    device: options.mobile ? "mobile" : "desktop",
    apiProtocol: options.apiProtocol,
    webSearchRoute: options.webSearchRoute,
    knowledgeScopePath: String(options.knowledgeScopePath || ""),
    timeoutMs: Math.max(1_000, options.timeoutMs || 120_000),
    maxToolRounds: Math.max(0, options.maxToolRounds ?? 6),
    maxToolEvidenceCharacters: Math.max(
      1_000,
      options.maxToolEvidenceCharacters || (options.mobile ? 16_000 : 28_000),
    ),
    context: Object.freeze(context),
    images: Object.freeze(images),
    toolGrants: Object.freeze(grants),
  });
}
