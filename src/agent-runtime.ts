export interface AgentToolExecutionContext {
  toolCallId: string;
  round: number;
  signal?: AbortSignal;
}

export interface AgentToolExecutionResult {
  content: string;
  artifacts?: Record<string, any>;
}

export class RecoverableToolUnavailableError extends Error {
  toolName: string;
  reason: "budget_exhausted";

  constructor(toolName: string, message: string) {
    super(message);
    this.name = "RecoverableToolUnavailableError";
    this.toolName = toolName;
    this.reason = "budget_exhausted";
  }
}

export interface AgentRuntimeTool {
  definition: Record<string, any>;
  execute: (
    arguments_: Record<string, any>,
    context: AgentToolExecutionContext,
  ) => Promise<AgentToolExecutionResult>;
}

export interface AgentRuntimeEvent {
  type:
    | "runtime_start"
    | "model_response"
    | "tool_start"
    | "tool_result"
    | "tool_unavailable"
    | "runtime_complete";
  round: number;
  toolName?: string;
  toolCallId?: string;
  arguments?: Record<string, any>;
  result?: AgentToolExecutionResult;
}

export interface AgentRuntimeOptions {
  messages: any[];
  tools?: AgentRuntimeTool[];
  maxToolRounds?: number;
  signal?: AbortSignal;
  requestAssistant: (
    messages: any[],
    toolDefinitions: Record<string, any>[],
    round: number,
  ) => Promise<any>;
  onEvent?: (event: AgentRuntimeEvent) => void | Promise<void>;
}

export interface AgentRuntimeToolRecord {
  toolName: string;
  toolCallId: string;
  arguments: Record<string, any>;
  result: AgentToolExecutionResult;
}

export interface AgentRuntimeResult {
  assistantMessage: any;
  messages: any[];
  toolRecords: AgentRuntimeToolRecord[];
  rounds: number;
}

function functionName(definition: Record<string, any>) {
  return String(definition?.function?.name || "").trim();
}

function parseToolArguments(toolCall: any) {
  const raw = toolCall?.function?.arguments;
  if (raw === undefined || raw === null || raw === "") {
    return {};
  }
  if (typeof raw === "object") {
    return raw;
  }
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("arguments must be a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `Tool arguments are not valid JSON: ${error.message || error}`,
    );
  }
}

function assistantToolMessage(assistantMessage: any, toolCalls: any[]) {
  const message: Record<string, any> = {
    role: "assistant",
    content: assistantMessage?.content || "",
    tool_calls: toolCalls,
  };
  for (const key of [
    "reasoning_content",
    "reasoning_details",
    "reasoning",
  ]) {
    if (assistantMessage?.[key] !== undefined) {
      message[key] = assistantMessage[key];
    }
  }
  return message;
}

export class AgentRuntime {
  async run(options: AgentRuntimeOptions): Promise<AgentRuntimeResult> {
    const messages = [...options.messages];
    const tools = options.tools || [];
    const maxToolRounds = Math.max(0, options.maxToolRounds ?? 6);
    const toolRegistry = new Map<string, AgentRuntimeTool>();
    const unavailableTools = new Set<string>();
    for (const tool of tools) {
      const name = functionName(tool.definition);
      if (!name) {
        throw new Error("Every Agent Runtime tool must have a function name.");
      }
      if (toolRegistry.has(name)) {
        throw new Error(`Agent Runtime tool names must be unique: ${name}`);
      }
      toolRegistry.set(name, tool);
    }
    const toolRecords: AgentRuntimeToolRecord[] = [];
    await options.onEvent?.({ type: "runtime_start", round: 0 });

    for (let round = 0; round <= maxToolRounds; round += 1) {
      throwIfAborted(options.signal);
      const toolDefinitions = [...toolRegistry.entries()]
        .filter(([name]) => !unavailableTools.has(name))
        .map(([, tool]) => tool.definition);
      const assistantMessage = await options.requestAssistant(
        messages,
        toolDefinitions,
        round,
      );
      throwIfAborted(options.signal, "The Agent Runtime was cancelled.");
      await options.onEvent?.({ type: "model_response", round });
      const toolCalls = Array.isArray(assistantMessage?.tool_calls)
        ? assistantMessage.tool_calls
        : [];
      if (!toolCalls.length) {
        await options.onEvent?.({ type: "runtime_complete", round });
        return {
          assistantMessage,
          messages,
          toolRecords,
          rounds: round + 1,
        };
      }
      if (!tools.length) {
        throw new Error(
          "The model requested a tool, but no Agent Runtime tools are enabled.",
        );
      }
      if (round >= maxToolRounds) {
        throw new Error(
          "The Agent Runtime exceeded the allowed number of tool rounds.",
        );
      }

      messages.push(assistantToolMessage(assistantMessage, toolCalls));
      for (const toolCall of toolCalls) {
        throwIfAborted(options.signal);
        const toolName = String(toolCall?.function?.name || "").trim();
        const tool = toolRegistry.get(toolName);
        if (!tool) {
          throw new Error(
            `The model requested an unregistered Agent Runtime tool: ${toolName || "unknown tool"}`,
          );
        }
        const toolCallId = String(toolCall?.id || "").trim();
        if (!toolCallId) {
          throw new Error(`The ${toolName} tool call did not include an ID.`);
        }
        const arguments_ = parseToolArguments(toolCall);
        await options.onEvent?.({
          type: "tool_start",
          round,
          toolName,
          toolCallId,
          arguments: arguments_,
        });
        let result: AgentToolExecutionResult;
        if (unavailableTools.has(toolName)) {
          result = unavailableResult(toolName);
        } else {
          try {
            result = await tool.execute(arguments_, {
              toolCallId,
              round,
              signal: options.signal,
            });
          } catch (error) {
            if (!(error instanceof RecoverableToolUnavailableError)) {
              throw error;
            }
            unavailableTools.add(error.toolName || toolName);
            result = unavailableResult(error.toolName || toolName);
            await options.onEvent?.({
              type: "tool_unavailable",
              round,
              toolName: error.toolName || toolName,
              toolCallId,
              arguments: arguments_,
              result,
            });
          }
        }
        throwIfAborted(options.signal, "The Agent Runtime was cancelled.");
        const normalizedResult = {
          ...result,
          content:
            typeof result?.content === "string"
              ? result.content
              : JSON.stringify(result?.content ?? ""),
        };
        const record = {
          toolName,
          toolCallId,
          arguments: arguments_,
          result: normalizedResult,
        };
        toolRecords.push(record);
        messages.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: normalizedResult.content,
        });
        await options.onEvent?.({
          type: "tool_result",
          round,
          toolName,
          toolCallId,
          arguments: arguments_,
          result: normalizedResult,
        });
      }
    }

    throw new Error("The Agent Runtime did not produce a final response.");
  }
}

function unavailableResult(toolName: string): AgentToolExecutionResult {
  return {
    content: [
      `${toolName} is unavailable for the remainder of this run because its call budget was exhausted.`,
      "Do not request this tool again. Complete the answer using the selected passage, conversation, and evidence already returned by other tools. Clearly state any remaining uncertainty.",
    ].join(" "),
    artifacts: {
      toolUnavailable: true,
      reason: "budget_exhausted",
    },
  };
}
import { throwIfAborted } from "./abort";
