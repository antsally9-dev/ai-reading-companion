import { raceWithAbort, throwIfAborted } from "./abort";
import type {
  AgentRuntimeTool,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
} from "./agent-runtime";

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
}

export class ToolPermissionDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPermissionDeniedError";
  }
}

function toolName(tool: AgentRuntimeTool) {
  return String(tool.definition?.function?.name || "").trim();
}

export class ToolGateway {
  private tools = new Map<string, AgentRuntimeTool>();
  private grants = new Map<string, ToolGrant>();
  private callCounts = new Map<string, number>();
  private signal?: AbortSignal;
  private evaluate?: ToolGatewayOptions["evaluate"];
  private requestPermission?: ToolGatewayOptions["requestPermission"];

  constructor(options: ToolGatewayOptions) {
    this.signal = options.signal;
    this.evaluate = options.evaluate;
    this.requestPermission = options.requestPermission;

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

  asRuntimeTools(): AgentRuntimeTool[] {
    return [...this.tools.entries()].map(([name, tool]) => ({
      definition: tool.definition,
      execute: (arguments_, context) =>
        this.execute(name, arguments_, context),
    }));
  }

  async execute(
    name: string,
    arguments_: Record<string, unknown>,
    context: AgentToolExecutionContext,
  ): Promise<AgentToolExecutionResult> {
    const signal = context.signal || this.signal;
    throwIfAborted(signal, `The ${name} tool call was cancelled.`);

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

    const currentCalls = this.callCounts.get(name) || 0;
    if (currentCalls >= Math.max(0, grant.maxCalls)) {
      throw new ToolPermissionDeniedError(
        `${name} exceeded its allowed call budget.`,
      );
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
    return {
      ...result,
      content:
        maxCharacters && content.length > maxCharacters
          ? `${content.slice(0, maxCharacters)}\n\n[Tool result truncated by the permission budget.]`
          : content,
    };
  }
}
