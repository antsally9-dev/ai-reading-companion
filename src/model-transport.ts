import { raceWithAbort, throwIfAborted } from "./abort";
import type { HttpClient } from "./platform-http";
import {
  buildResponsesRequestBody,
  extractResponsesAssistantMessage,
  makeResponsesUrl,
  type HostedWebSearchType,
  type ModelApiProtocol,
  type ResponsesApiSource,
} from "./responses-api";

export type ModelTransportErrorKind =
  | "authentication"
  | "permission"
  | "quota"
  | "rate_limit"
  | "timeout"
  | "network"
  | "invalid_request"
  | "server"
  | "cancelled"
  | "unknown";

export class ModelTransportError extends Error {
  kind: ModelTransportErrorKind;
  status: number | null;
  retryable: boolean;

  constructor(
    message: string,
    options: {
      kind: ModelTransportErrorKind;
      status?: number | null;
      retryable?: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = "ModelTransportError";
    this.kind = options.kind;
    this.status = options.status ?? null;
    this.retryable = options.retryable === true;
    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface ModelTransportRequest {
  protocol: ModelApiProtocol;
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
  messages: any[];
  toolDefinitions?: Record<string, any>[];
  hostedWebSearchType?: HostedWebSearchType;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface ModelTransportResponse {
  assistantMessage: any;
  sources: ResponsesApiSource[];
  usage: ModelUsage;
  hostedToolCalls: string[];
  status: number;
}

export interface ModelTransportOptions {
  httpClient: HttpClient;
}

function chatCompletionsUrl(baseUrl: string) {
  const normalized = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(normalized)) {
    return normalized;
  }
  return `${normalized}/chat/completions`;
}

function assistantText(responseBody: any) {
  const content = responseBody?.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : String(part?.text || part?.content || ""),
      )
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  return "";
}

function extractChatAssistantMessage(responseBody: any) {
  const rawMessage = responseBody?.choices?.[0]?.message;
  const message: any = {
    role: "assistant",
    content: assistantText(responseBody),
  };
  if (!rawMessage) {
    return message;
  }
  for (const key of ["reasoning_content", "reasoning_details", "reasoning"]) {
    if (rawMessage[key] !== undefined && rawMessage[key] !== null) {
      message[key] = rawMessage[key];
    }
  }
  if (Array.isArray(rawMessage.tool_calls)) {
    message.tool_calls = rawMessage.tool_calls;
  }
  return message;
}

function apiErrorMessage(responseBody: any) {
  const error = responseBody?.error;
  if (typeof error === "string") {
    return error;
  }
  return String(error?.message || error?.code || "").trim();
}

function tokenCount(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

export function extractModelUsage(responseBody: any): ModelUsage {
  const usage = responseBody?.usage || {};
  const inputTokens = tokenCount(usage.input_tokens ?? usage.prompt_tokens);
  const outputTokens = tokenCount(usage.output_tokens ?? usage.completion_tokens);
  const cachedInputTokens = tokenCount(
    usage.input_tokens_details?.cached_tokens ??
      usage.prompt_tokens_details?.cached_tokens,
  );
  const reasoningTokens = tokenCount(
    usage.output_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details?.reasoning_tokens,
  );
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens: tokenCount(usage.total_tokens) || inputTokens + outputTokens,
  };
}

function collectHostedToolCalls(responseBody: any) {
  return (Array.isArray(responseBody?.output) ? responseBody.output : [])
    .map((item: any) => String(item?.type || "").trim())
    .filter(
      (type: string) =>
        type &&
        type !== "message" &&
        type !== "function_call" &&
        type !== "reasoning",
    );
}

export function classifyModelTransportError(
  status: number | null,
  message: string,
): { kind: ModelTransportErrorKind; retryable: boolean } {
  const normalized = String(message || "").toLowerCase();
  if (/cancel|aborted/.test(normalized)) {
    return { kind: "cancelled", retryable: false };
  }
  if (status === 401 || /invalid api key|unauthori[sz]ed/.test(normalized)) {
    return { kind: "authentication", retryable: false };
  }
  if (status === 403 || /forbidden|permission denied/.test(normalized)) {
    return { kind: "permission", retryable: false };
  }
  if (status === 402 || /insufficient.*(?:balance|credit)|quota exhausted/.test(normalized)) {
    return { kind: "quota", retryable: false };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(normalized)) {
    return { kind: "rate_limit", retryable: true };
  }
  if (status === 408 || status === 504 || /timed? out|timeout/.test(normalized)) {
    return { kind: "timeout", retryable: true };
  }
  if (status !== null && status >= 500) {
    return { kind: "server", retryable: true };
  }
  if (status !== null && status >= 400) {
    return { kind: "invalid_request", retryable: false };
  }
  if (/network|fetch failed|connection|socket|dns/.test(normalized)) {
    return { kind: "network", retryable: true };
  }
  return { kind: "unknown", retryable: false };
}

export class ModelTransport {
  private httpClient: HttpClient;

  constructor(options: ModelTransportOptions) {
    this.httpClient = options.httpClient;
  }

  async send(options: ModelTransportRequest): Promise<ModelTransportResponse> {
    throwIfAborted(options.signal, "The model request was cancelled.");
    const toolDefinitions = options.toolDefinitions || [];
    const body: any =
      options.protocol === "responses"
        ? buildResponsesRequestBody({
            model: options.model,
            messages: options.messages,
            toolDefinitions,
            hostedWebSearchType: options.hostedWebSearchType || "",
            maxOutputTokens: options.maxOutputTokens,
          })
        : { model: options.model, messages: options.messages };
    if (
      options.protocol === "chat_completions" &&
      Number.isFinite(options.maxOutputTokens) &&
      Number(options.maxOutputTokens) > 0
    ) {
      body.max_tokens = Math.floor(Number(options.maxOutputTokens));
    }
    if (options.protocol === "chat_completions" && toolDefinitions.length) {
      body.tools = toolDefinitions;
      body.tool_choice = "auto";
    }
    try {
      const response = await raceWithAbort(
        this.httpClient.request({
          url:
            options.protocol === "responses"
              ? makeResponsesUrl(options.baseUrl)
              : chatCompletionsUrl(options.baseUrl),
          method: "POST",
          headers: options.headers,
          body: JSON.stringify(body),
          signal: options.signal,
        }),
        options.signal,
        "The model request was cancelled.",
      );
      throwIfAborted(options.signal, "The model request was cancelled.");
      const responseBody = response.json;
      if (response.status < 200 || response.status >= 300) {
        const apiMessage = apiErrorMessage(responseBody);
        const message = `API returned ${response.status}${apiMessage ? `: ${apiMessage}` : ""}`;
        const classification = classifyModelTransportError(response.status, message);
        throw new ModelTransportError(message, {
          ...classification,
          status: response.status,
        });
      }
      const assistantMessage =
        options.protocol === "responses"
          ? extractResponsesAssistantMessage(responseBody)
          : extractChatAssistantMessage(responseBody);
      return {
        assistantMessage,
        sources: Array.isArray(assistantMessage.sources)
          ? assistantMessage.sources
          : [],
        usage: extractModelUsage(responseBody),
        hostedToolCalls:
          options.protocol === "responses"
            ? collectHostedToolCalls(responseBody)
            : [],
        status: response.status,
      };
    } catch (error) {
      if (error instanceof ModelTransportError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error || "Model request failed.");
      const classification = classifyModelTransportError(null, message);
      throw new ModelTransportError(message, {
        ...classification,
        cause: error,
      });
    }
  }
}
