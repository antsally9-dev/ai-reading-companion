import {
  AgentRuntime,
  type AgentRuntimeEvent,
  type AgentRuntimeTool,
} from "./agent-runtime";
import { throwIfAborted } from "./abort";
import { ContextBuilder, type ContextReceipt } from "./context-builder";
import { selectConversationBranch } from "./conversation-branch";
import {
  buildComplexQuestionPlanningMessages,
  buildComplexQuestionSynthesisMessages,
  buildSubquestionMessages,
  parseComplexQuestionPlan,
  shouldPlanComplexQuestion,
  type ComplexQuestionMode,
} from "./complex-question";
import {
  createAgentRunPlan,
  type AgentRunPlan,
  type ImageBudgets,
} from "./run-plan";
import {
  ToolGateway,
  type ToolDiagnosticSummary,
  type ToolGrant,
} from "./tool-gateway";
import type {
  HostedWebSearchType,
  ModelApiProtocol,
} from "./responses-api";

export interface AskQuestionModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface AskQuestionModelTransportResponse {
  assistantMessage: any;
  sources: any[];
  usage: AskQuestionModelUsage;
  hostedToolCalls: string[];
  status?: number;
}

/**
 * Platform port for the model request. The Obsidian host currently adapts
 * ModelTransport to this interface; a desktop host can supply fetch/IPC later.
 */
export interface AskQuestionModelTransport {
  send(options: {
    protocol: ModelApiProtocol;
    baseUrl: string;
    model: string;
    headers: Record<string, string>;
    messages: any[];
    toolDefinitions?: Record<string, any>[];
    hostedWebSearchType?: HostedWebSearchType;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<AskQuestionModelTransportResponse>;
}

export interface AskQuestionContextInput {
  systemPrompt: string;
  selectedPassage: string;
  conversationOrQuestion: any[] | string;
  branchEndpointMessageId?: string | number | null;
  questionHistory?: string;
  confirmedMemory?: string;
  localEvidence?: string;
  webEvidence?: string;
}

export interface AskQuestionUseCaseInput {
  mobile: boolean;
  apiProtocol: ModelApiProtocol;
  webSearchRoute: AgentRunPlan["webSearchRoute"];
  knowledgeScopePath?: string;
  timeoutMs?: number;
  maxAgentToolRounds: number;
  maxToolEvidenceCharacters?: number;
  toolGrants: ToolGrant[];
  runtimeTools: AgentRuntimeTool[];
  model: {
    baseUrl: string;
    model: string;
    headers: Record<string, string>;
    hostedWebSearchType?: HostedWebSearchType;
    maxOutputTokens: number;
  };
  context: AskQuestionContextInput;
  imageReferences?: any[];
  prepareImageParts?: (
    imageReferences: any[],
    signal: AbortSignal | undefined,
    budgets: Readonly<ImageBudgets>,
  ) => Promise<any[]>;
  complexQuestionMode: ComplexQuestionMode;
  initialSources?: any[];
  getLocalSources?: () => ContextReceipt["localSources"];
  dedupeSources?: (sources: any[]) => any[];
  shouldAbortSubquestionOnError?: (error: unknown) => boolean;
  signal?: AbortSignal;
  emit?: (
    stage: "assembling_context" | "calling_model" | "executing_tool",
    detail?: Record<string, unknown>,
  ) => void | Promise<void>;
}

export interface ModelCallDiagnostic {
  sequence: number;
  purpose: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  hostedToolCalls: number;
}

export interface AskQuestionUseCaseDependencies {
  modelTransport: AskQuestionModelTransport;
}

export function normalizeQuestionConversation(
  conversationOrQuestion: any[] | string,
  branchEndpointMessageId?: string | number | null,
) {
  const conversationInput =
    Array.isArray(conversationOrQuestion) &&
    branchEndpointMessageId !== null &&
    branchEndpointMessageId !== undefined
      ? selectConversationBranch(
          conversationOrQuestion,
          branchEndpointMessageId,
        )
      : conversationOrQuestion;
  const conversation = Array.isArray(conversationInput)
    ? conversationInput
        .filter(
          (message) =>
            message &&
            message.cancelled !== true &&
            (message.role === "user" || message.role === "assistant") &&
            String(message.content || "").trim(),
        )
        .map((message) => {
          const normalized: Record<string, any> = {
            role: message.role,
            content: String(message.content).trim(),
          };
          for (const key of [
            "reasoning_content",
            "reasoning_details",
            "reasoning",
          ]) {
            if (message[key] !== undefined && message[key] !== null) {
              normalized[key] = message[key];
            }
          }
          return normalized;
        })
    : [
        {
          role: "user",
          content: String(conversationInput || "").trim(),
        },
      ];
  if (!conversation.length || conversation[0].role !== "user") {
    throw new Error("The conversation does not contain a question to send.");
  }
  return conversation;
}

function emptyProviderUsage(): AskQuestionModelUsage & {
  hostedToolCalls: number;
} {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    hostedToolCalls: 0,
  };
}

function attachFailureDiagnostics(
  error: unknown,
  receipt: ContextReceipt,
  runPlan: Readonly<AgentRunPlan>,
  toolDiagnostics: ToolDiagnosticSummary,
  modelCallDiagnostics: ModelCallDiagnostic[],
  providerUsage: ReturnType<typeof emptyProviderUsage>,
) {
  if (!error || typeof error !== "object") {
    return;
  }
  const diagnosticsError = error as Record<string, any>;
  diagnosticsError.contextReceipt = receipt;
  diagnosticsError.runPlan = runPlan;
  diagnosticsError.runtimeMetrics = {
    rounds: modelCallDiagnostics.length,
    toolCalls: toolDiagnostics.successes,
    providerUsage,
    modelCallDiagnostics: [...modelCallDiagnostics],
    toolAttempts: toolDiagnostics.attempts,
    toolSuccesses: toolDiagnostics.successes,
    toolBudgetDenials: toolDiagnostics.budgetDenials,
    toolCacheHits: toolDiagnostics.cacheHits,
    toolResultCharacters: toolDiagnostics.resultCharacters,
    toolResultBudgetCharacters: toolDiagnostics.resultBudgetCharacters,
    toolResultBudgetDenials: toolDiagnostics.resultBudgetDenials,
    toolResultTruncations: toolDiagnostics.resultTruncations,
    toolDiagnostics: toolDiagnostics.tools,
  };
}

export class AskQuestionUseCase {
  private readonly modelTransport: AskQuestionModelTransport;

  constructor(dependencies: AskQuestionUseCaseDependencies) {
    this.modelTransport = dependencies.modelTransport;
  }

  async execute(input: AskQuestionUseCaseInput) {
    const signal = input.signal;
    const emit = async (
      stage: "assembling_context" | "calling_model" | "executing_tool",
      detail?: Record<string, unknown>,
    ) => input.emit?.(stage, detail);
    throwIfAborted(signal, "The AI request was cancelled.");

    const conversation = normalizeQuestionConversation(
      input.context.conversationOrQuestion,
      input.context.branchEndpointMessageId,
    );
    const firstQuestion = String(conversation[0].content || "");
    const latestQuestion =
      [...conversation]
        .reverse()
        .find((message) => message.role === "user")?.content || firstQuestion;
    const maxToolRounds = input.runtimeTools.length
      ? Math.min(
          Math.max(0, input.maxAgentToolRounds),
          Math.max(
            1,
            input.toolGrants.reduce(
              (total, grant) => total + Math.max(0, grant.maxCalls),
              0,
            ),
          ),
        )
      : 0;
    const runPlan = createAgentRunPlan({
      mobile: input.mobile,
      apiProtocol: input.apiProtocol,
      webSearchRoute: input.webSearchRoute,
      knowledgeScopePath: input.knowledgeScopePath || "",
      timeoutMs: input.timeoutMs,
      maxToolRounds,
      maxToolEvidenceCharacters: input.maxToolEvidenceCharacters,
      toolGrants: input.toolGrants,
    });
    const imageParts = input.prepareImageParts
      ? await input.prepareImageParts(
          input.imageReferences || [],
          signal,
          runPlan.images,
        )
      : [];
    const builtContext = new ContextBuilder().build({
      runId: runPlan.id,
      createdAt: runPlan.createdAt,
      budgets: runPlan.context,
      systemPrompt: input.context.systemPrompt,
      selectedPassage: input.context.selectedPassage,
      conversation,
      imageParts,
      questionHistory: input.context.questionHistory || "",
      confirmedMemory: input.context.confirmedMemory || "",
      localEvidence: input.context.localEvidence || "",
      webEvidence: input.context.webEvidence || "",
      knowledgeScopePath: input.knowledgeScopePath || "",
      webSearchRoute: runPlan.webSearchRoute,
    });
    const messages = builtContext.messages;
    const toolGateway = new ToolGateway({
      tools: input.runtimeTools,
      grants: input.toolGrants,
      signal,
      maxTotalResultCharacters: runPlan.maxToolEvidenceCharacters,
    });
    const collectedSources = [...(input.initialSources || [])];
    const modelCallDiagnostics: ModelCallDiagnostic[] = [];
    const summarizeProviderUsage = () =>
      modelCallDiagnostics.reduce(
        (total, item) => ({
          inputTokens: total.inputTokens + item.inputTokens,
          cachedInputTokens: total.cachedInputTokens + item.cachedInputTokens,
          outputTokens: total.outputTokens + item.outputTokens,
          reasoningTokens: total.reasoningTokens + item.reasoningTokens,
          totalTokens: total.totalTokens + item.totalTokens,
          hostedToolCalls: total.hostedToolCalls + item.hostedToolCalls,
        }),
        emptyProviderUsage(),
      );
    const requestAssistant = async (
      runtimeMessages: any[],
      toolDefinitions: Record<string, any>[],
      allowHostedSearch = true,
      purpose = "answer",
    ) => {
      throwIfAborted(signal, "The AI request was cancelled.");
      await emit("calling_model");
      let response: AskQuestionModelTransportResponse;
      try {
        response = await this.modelTransport.send({
          protocol: runPlan.apiProtocol,
          baseUrl: input.model.baseUrl,
          model: input.model.model,
          headers: input.model.headers,
          messages: runtimeMessages,
          toolDefinitions,
          hostedWebSearchType: allowHostedSearch
            ? input.model.hostedWebSearchType || ""
            : "",
          maxOutputTokens: input.model.maxOutputTokens,
          signal,
        });
      } catch (error) {
        attachFailureDiagnostics(
          error,
          builtContext.receipt,
          runPlan,
          toolGateway.getDiagnostics(),
          modelCallDiagnostics,
          summarizeProviderUsage(),
        );
        throw error;
      }
      const usage = response.usage || emptyProviderUsage();
      modelCallDiagnostics.push({
        sequence: modelCallDiagnostics.length + 1,
        purpose: String(purpose || "answer"),
        inputTokens: Number(usage.inputTokens || 0),
        cachedInputTokens: Number(usage.cachedInputTokens || 0),
        outputTokens: Number(usage.outputTokens || 0),
        reasoningTokens: Number(usage.reasoningTokens || 0),
        totalTokens: Number(usage.totalTokens || 0),
        hostedToolCalls: Array.isArray(response.hostedToolCalls)
          ? response.hostedToolCalls.length
          : 0,
      });
      collectedSources.push(...(response.sources || []));
      return response.assistantMessage;
    };
    const onRuntimeEvent = async (event: AgentRuntimeEvent) => {
      if (event.type === "tool_start") {
        await emit("executing_tool", {
          toolName: event.toolName || "Tool",
          round: event.round,
        });
      } else if (event.type === "tool_result") {
        await emit("calling_model", {
          completedTool: event.toolName || "Tool",
          round: event.round,
        });
      }
    };

    const mayDecompose =
      runPlan.webSearchRoute !== "hosted" &&
      shouldPlanComplexQuestion(latestQuestion, input.complexQuestionMode);
    let complexPlan: ReturnType<typeof parseComplexQuestionPlan> | null = null;
    if (mayDecompose) {
      await emit("calling_model", { phase: "planning" });
      const planningResponse = await requestAssistant(
        buildComplexQuestionPlanningMessages(latestQuestion),
        [],
        false,
        "complex_planning",
      );
      complexPlan = parseComplexQuestionPlan(planningResponse.content || "");
    }

    let runtimeResult: any;
    if (complexPlan?.shouldDecompose) {
      const partialAnswers: Array<{ question: string; answer: string }> = [];
      const toolRecords: any[] = [];
      const sharedEvidence: string[] = [];
      let modelRounds = 1;
      const childMaxToolRounds = Math.max(
        1,
        Math.floor(runPlan.maxToolRounds / complexPlan.subquestions.length),
      );
      for (let index = 0; index < complexPlan.subquestions.length; index += 1) {
        throwIfAborted(signal, "The AI request was cancelled.");
        const subquestion = complexPlan.subquestions[index];
        const childMessages = buildSubquestionMessages(
          messages,
          latestQuestion,
          subquestion,
          index,
          complexPlan.subquestions.length,
        );
        if (sharedEvidence.length) {
          childMessages.splice(childMessages.length - 1, 0, {
            role: "system",
            content: [
              "Evidence already gathered by earlier subquestions in this same run. Reuse it when relevant; do not request the same material again:",
              "",
              sharedEvidence.join("\n\n---\n\n").slice(0, 12_000),
            ].join("\n"),
          });
        }
        try {
          const childResult = await new AgentRuntime().run({
            messages: childMessages,
            tools: toolGateway.asAvailableRuntimeTools(),
            maxToolRounds: childMaxToolRounds,
            signal,
            requestAssistant: (childRuntimeMessages, toolDefinitions, round) =>
              requestAssistant(
                childRuntimeMessages,
                toolDefinitions,
                false,
                round === 0 ? "subquestion" : "subquestion_tool_followup",
              ),
            onEvent: onRuntimeEvent,
          });
          modelRounds += childResult.rounds;
          toolRecords.push(...childResult.toolRecords);
          partialAnswers.push({
            question: subquestion,
            answer: String(childResult.assistantMessage.content || "").slice(
              0,
              8_000,
            ),
          });
          for (const record of childResult.toolRecords) {
            if (
              record.result.artifacts?.toolUnavailable ||
              record.result.artifacts?.cacheHit
            ) {
              continue;
            }
            const content = String(record.result.content || "").trim();
            if (content && !sharedEvidence.includes(content)) {
              sharedEvidence.push(content);
            }
          }
        } catch (error) {
          throwIfAborted(signal, "The AI request was cancelled.");
          if (input.shouldAbortSubquestionOnError?.(error)) {
            throw error;
          }
          partialAnswers.push({
            question: subquestion,
            answer:
              "This subquestion could not be completed during the current run. Preserve this as an explicit gap during synthesis.",
          });
        }
      }
      await emit("calling_model", { phase: "synthesis" });
      const synthesisMessage = await requestAssistant(
        buildComplexQuestionSynthesisMessages(
          input.context.systemPrompt,
          input.context.selectedPassage,
          latestQuestion,
          partialAnswers,
        ),
        [],
        false,
        "complex_synthesis",
      );
      runtimeResult = {
        assistantMessage: synthesisMessage,
        messages,
        toolRecords,
        rounds: modelRounds + 1,
        decomposition: {
          enabled: true,
          subquestionCount: complexPlan.subquestions.length,
        },
      };
    } else {
      runtimeResult = await new AgentRuntime().run({
        messages,
        tools: toolGateway.asRuntimeTools(),
        maxToolRounds: runPlan.maxToolRounds,
        signal,
        requestAssistant: (runtimeMessages, toolDefinitions, round) =>
          requestAssistant(
            runtimeMessages,
            toolDefinitions,
            true,
            round === 0 ? "initial_answer" : "tool_followup",
          ),
        onEvent: onRuntimeEvent,
      });
    }
    throwIfAborted(signal, "The AI request was cancelled.");
    for (const record of runtimeResult.toolRecords) {
      const sources = record.result.artifacts?.sources;
      if (Array.isArray(sources)) {
        collectedSources.push(...sources);
      }
    }
    const assistantMessage = runtimeResult.assistantMessage;
    if (!assistantMessage.content) {
      throw new Error("The API response did not contain assistant text.");
    }
    assistantMessage.sources = input.dedupeSources
      ? input.dedupeSources(collectedSources)
      : collectedSources;
    builtContext.receipt.localSources = input.getLocalSources?.() || [];
    assistantMessage.contextReceipt = builtContext.receipt;
    assistantMessage.runPlan = {
      id: runPlan.id,
      device: runPlan.device,
      apiProtocol: runPlan.apiProtocol,
      webSearchRoute: runPlan.webSearchRoute,
      knowledgeScopePath: runPlan.knowledgeScopePath,
      maxToolRounds: runPlan.maxToolRounds,
      maxToolEvidenceCharacters: runPlan.maxToolEvidenceCharacters,
      complexQuestionMode: input.complexQuestionMode,
      decomposedSubquestions:
        runtimeResult.decomposition?.subquestionCount || 0,
    };
    const toolDiagnostics = toolGateway.getDiagnostics();
    assistantMessage.runtimeMetrics = {
      rounds: runtimeResult.rounds,
      toolCalls: runtimeResult.toolRecords.length,
      toolAttempts: toolDiagnostics.attempts,
      toolSuccesses: toolDiagnostics.successes,
      toolBudgetDenials: toolDiagnostics.budgetDenials,
      toolCacheHits: toolDiagnostics.cacheHits,
      toolResultCharacters: toolDiagnostics.resultCharacters,
      toolResultBudgetCharacters: toolDiagnostics.resultBudgetCharacters,
      toolResultBudgetDenials: toolDiagnostics.resultBudgetDenials,
      toolResultTruncations: toolDiagnostics.resultTruncations,
      toolDiagnostics: toolDiagnostics.tools,
      providerUsage: summarizeProviderUsage(),
      modelCallDiagnostics,
      decomposedSubquestions:
        runtimeResult.decomposition?.subquestionCount || 0,
    };
    return assistantMessage;
  }
}
