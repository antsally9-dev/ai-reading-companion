import { raceWithAbort, throwIfAborted } from "./abort";
import {
  RecoverableToolUnavailableError,
  type AgentRuntimeTool,
  type AgentToolExecutionContext,
  type AgentToolExecutionResult,
} from "./agent-runtime";
/*
 * Tool diagnostics intentionally contain counts and tool names only. Never add
 * arguments, query text, paths, URLs, or result content to this structure.
 */
export interface ToolCallDiagnostic {
  toolName: string;
  attempts: number;
  successes: number;
  budgetDenials: number;
  cacheHits: number;
}

export interface ToolDiagnosticSummary {
  attempts: number;
  successes: number;
  budgetDenials: number;
  cacheHits: number;
  tools: ToolCallDiagnostic[];
}

export interface ToolGrant {
  id: string;
  toolName: string;
  maxCalls: number;
  maxResultCharacters?: number;
  expiresAt?: number;
}

export type PermissionDecision =
  | { kind: "allow"; grantId: string }
  | { kind: "ask"; reason: string }
  | { kind: "deny"; reason: string };

export interface ToolPermissionRequest {
  toolName: string;
  arguments: Record<string, unknown>;
  context: AgentToolExecutionContext;
  grant?: ToolGrant;
}

export interface ToolGatewayOptions {
  tools: AgentRuntimeTool[];
  grants: ToolGrant[];
  signal?: AbortSignal;
  evaluate?: (
    request: ToolPermissionRequest,
  ) => PermissionDecision | Promise<PermissionDecision>;
  requestPermission?: (
    request: ToolPermissionRequest,
  ) => boolean | Promise<boolean>;
  onDiagnostic?: (summary: ToolDiagnosticSummary) => void;
}

export class ToolPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPermissionDeniedError";
  }
}

export class ToolCallBudgetExceededError extends RecoverableToolUnavailableError {
  constructor(toolName: string) {
    super(toolName, `${toolName} exceeded its allowed call budget.`);
    this.name = "ToolCallBudgetExceededError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function invocationKey(name: string, arguments_: Record<string, unknown>) {
  return `${name}:${JSON.stringify(stableValue(arguments_))}`;
}

function toolName(tool: AgentRuntimeTool) {
  return String(tool.definition?.function?.name || "").trim();
}

export class ToolGateway {
  private tools = new Map<string, AgentRuntimeTool>();
  private grants = new Map<string, ToolGrant>();
  private callCounts = new Map<string, number>();
  private resultCache = new Map<string, AgentToolExecutionResult>();
  private diagnostics = new Map<string, ToolCallDiagnostic>();
  private signal?: AbortSignal;
  private evaluate?: ToolGatewayOptions["evaluate"];
  private requestPermission?: ToolGatewayOptions["requestPermission"];
  private onDiagnostic?: ToolGatewayOptions["onDiagnostic"];

  constructor(options: ToolGatewayOptions) {
    this.signal = options.signal;
    this.evaluate = options.evaluate;
    this.requestPermission = options.requestPermission;
    this.onDiagnostic = options.onDiagnostic;

    for (const tool of options.tools) {
      const name = toolName(tool);
      if (!name) {
        throw new Error("Every Tool Gateway tool must have a function name.");
      }
      if (this.tools.has(name)) {
        throw new Error(`Tool Gateway tool names must be unique: ${name}`);
      }
      this.tools.set(name, tool);
    }
    for (const grant of options.grants) {
      if (this.grants.has(grant.toolName)) {
        throw new Error(`Tool grants must be unique per tool: ${grant.toolName}`);
      }
      this.grants.set(grant.toolName, grant);
    }
  }

  getDiagnostics(): ToolDiagnosticSummary {
    const tools = [...this.diagnostics.values()]
      .map((item) => ({ ...item }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName));
    return {
      attempts: tools.reduce((total, item) => total + item.attempts, 0),
      successes: tools.reduce((total, item) => total + item.successes, 0),
      budgetDenials: tools.reduce((total, item) => total + item.budgetDenials, 0),
      cacheHits: tools.reduce((total, item) => total + item.cacheHits, 0),
      tools,
    };
  }

  private recordDiagnostic(
    name: string,
    field: "attempts" | "successes" | "budgetDenials" | "cacheHits",
  ) {
    const diagnostic = this.diagnostics.get(name) || {
      toolName: name,
      attempts: 0,
      successes: 0,
      budgetDenials: 0,
      cacheHits: 0,
    };
    diagnostic[field] += 1;
    this.diagnostics.set(name, diagnostic);
    this.onDiagnostic?.(this.getDiagnostics());
  }

  asRuntimeTools(): AgentRuntimeTool[] {
    return [...this.tools.entries()].map(([name, tool]) => ({
      definition: tool.definition,
      execute: (arguments_, context) =>
        this.execute(name, arguments_, context),
    }));
  }

  asAvailableRuntimeTools(): AgentRuntimeTool[] {
    return [...this.tools.entries()]
      .filter(([name]) => {
        const grant = this.grants.get(name);
        return Boolean(
          grant &&
            (!grant.expiresAt || grant.expiresAt > Date.now()) &&
            (this.callCounts.get(name) || 0) < Math.max(0, grant.maxCalls),
        );
      })
      .map(([name, tool]) => ({
        definition: tool.definition,
        execute: (arguments_, context) => this.execute(name, arguments_, context),
      }));
  }

  async execute(
    name: string,
    arguments_: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionResult> {
    const signal = context.signal || this.signal;
    throwIfAborted(signal, `The ${name} tool call was cancelled.`);
    this.recordDiagnostic(name, "attempts");

    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolPermissionDeniedError(`Tool is not registered: ${name}`);
    }
    const grant = this.grants.get(name);
    if (!grant) {
      throw new ToolPermissionDeniedError(`No permission grant exists for ${name}.`);
    }
    if (grant.expiresAt && grant.expiresAt <= Date.now()) {
      throw new ToolPermissionDeniedError(`The permission grant for ${name} expired.`);
    }

    const cacheKey = invocationKey(name, arguments_);
    const cachedResult = this.resultCache.get(cacheKey);
    if (cachedResult) {
      this.recordDiagnostic(name, "cacheHits");
      return {
        content:
          "This exact tool request was already completed earlier in this run. Reuse the evidence already present in the conversation instead of requesting it again.",
        artifacts: {
          ...(cachedResult.artifacts || {}),
          cacheHit: true,
        },
      };
    }

    const currentCalls = this.callCounts.get(name) || 0;
    if (currentCalls >= Math.max(0, grant.maxCalls)) {
      this.recordDiagnostic(name, "budgetDenials");
      throw new ToolCallBudgetExceededError(name);
    }

    const request: ToolPermissionRequest = {
      toolName: name,
      arguments: arguments_,
      context,
      grant,
    };
    const decision = this.evaluate
      ? await this.evaluate(request)
      : { kind: "allow" as const, grantId: grant.id };
    if (decision.kind === "deny") {
      throw new ToolPermissionDeniedError(decision.reason);
    }
    if (decision.kind === "allow" && decision.grantId !== grant.id) {
      throw new ToolPermissionDeniedError(
        `The permission decision for ${name} referenced an invalid grant.`,
      );
    }
    if (decision.kind === "ask") {
      const allowed = this.requestPermission
        ? await this.requestPermission(request)
        : false;
      if (!allowed) {
        throw new ToolPermissionDeniedError(decision.reason);
      }
    }

    throwIfAborted(signal, `The ${name} tool call was cancelled.`);
    this.callCounts.set(name, currentCalls + 1);
    const result = await raceWithAbort(
      tool.execute(arguments_, { ...context, signal }),
      signal,
      `The ${name} tool call was cancelled.`,
    );
    throwIfAborted(signal, `The ${name} tool call was cancelled.`);

    const content =
      typeof result?.content === "string"
        ? result.content
        : JSON.stringify(result?.content ?? "");
    const maxCharacters = Math.max(0, grant.maxResultCharacters || 0);
    const normalizedResult = {
      ...result,
      content:
        maxCharacters && content.length > maxCharacters
          ? `${content.slice(0, maxCharacters)}\n\n[Tool result truncated by the permission budget.]`
          : content,
    };
    this.resultCache.set(cacheKey, normalizedResult);
    this.recordDiagnostic(name, "successes");
    return normalizedResult;
  }
}
