import type { HttpClient } from "./platform-http";

/**
 * Langfuse 遥测：零依赖 OTLP/JSON 上报 + 提问级 trace 上下文。
 *
 * 设计约束：
 * - 零依赖：trace/span/generation 直接以 OTLP/JSON（ExportTraceServiceRequest）
 *   POST {host}/api/public/otel/v1/traces —— Langfuse v4 的原生写入路径
 *   （v4 默认 LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only 拒收旧
 *   /api/public/ingestion 的 trace/span/generation 事件；score 事件仍走旧
 *   ingestion API，v4 继续接受）。HTTP 走项目平台中立的 HttpClient 边界
 *   （Obsidian 侧注入 requestUrl 实现，无浏览器 CORS 限制）。
 * - 绝不影响插件：所有发送 fire-and-forget，失败只 console.debug。
 * - 事件模型：trace（一轮提问，OTLP 根 span）→ generation（每次模型调用）
 *   → span（每次工具调用），层级靠 parentSpanId 表达。
 * - 单例当前 trace：插件同时只有一个活跃提问，用模块级单例代替
 *   AsyncLocalStorage（移动端 WebView 没有 Node ALS；并发提问的串扰风险
 *   可接受并在此声明）。
 *
 * 隐私红线（对齐 README Data and network disclosure）：
 * 发送内容仅限运行遥测（问题文本、回答文本、工具名与参数、token 用量），
 * 不含笔记正文以外的任何本地文件内容；不发送 SecretStorage 中的密钥。
 * 仅在用户显式填写 host + public key + secret key 并启用后才发送。
 */

export interface LangfuseTelemetryConfig {
  enabled: boolean;
  host: string;
  publicKey: string;
  secretKey: string;
}

interface PendingSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startNs: string;
  endNs?: string;
  /** 已按 Langfuse OTel 属性约定（langfuse.observation.* 等）序列化好的值。 */
  attributes: Record<string, string | number | boolean>;
}

interface QueuedScore {
  id: string;
  timestamp: string;
  body: Record<string, unknown>;
}

let activeConfig: LangfuseTelemetryConfig | null = null;
let httpSender: HttpClient | null = null;
const openSpans = new Map<string, PendingSpan>();
let pendingSpans: PendingSpan[] = [];
let pendingScores: QueuedScore[] = [];
let flushScheduled = false;

function randomId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** OTLP span/trace id：32/16 位十六进制（服务端原样使用字符串值）。 */
function randomHex(bytes: number) {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const buf = crypto.getRandomValues(new Uint8Array(bytes));
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  for (let i = 0; i < bytes * 2; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

function nowNs() {
  return String(Date.now() * 1_000_000);
}

function nowIso() {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error) || "Unknown error";
  } catch {
    return "Unknown error";
  }
}

/** Langfuse OTel 属性里放 JSON 对象时使用（input/metadata/usage_details）。 */
function jsonAttr(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable value]";
  }
}

export function configureLangfuseTelemetry(
  config: LangfuseTelemetryConfig,
  sender?: HttpClient,
) {
  const host = String(config.host || "").trim().replace(/\/+$/, "");
  const publicKey = String(config.publicKey || "").trim();
  const secretKey = String(config.secretKey || "").trim();
  activeConfig =
    config.enabled && host && publicKey && secretKey && sender
      ? { enabled: true, host, publicKey, secretKey }
      : null;
  httpSender = sender ?? null;
}

export function langfuseTelemetryActive() {
  return Boolean(activeConfig);
}

function authHeaders(config: LangfuseTelemetryConfig) {
  const credentials = btoa(`${config.publicKey}:${config.secretKey}`);
  return {
    Authorization: `Basic ${credentials}`,
    "X-Langfuse-SDK-Name": "ai-reading-companion-telemetry",
    "X-Langfuse-SDK-Version": "2.0.0-otlp",
  };
}

function toOtelAttribute(key: string, value: string | number | boolean) {
  if (typeof value === "number") {
    return { key, value: { doubleValue: value } };
  }
  if (typeof value === "boolean") {
    return { key, value: { boolValue: value } };
  }
  return { key, value: { stringValue: value } };
}

function buildOtelPayload(spans: PendingSpan[]) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "ai-reading-companion-plugin" },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: "ai-reading-companion" },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: 1,
              startTimeUnixNano: span.startNs,
              endTimeUnixNano: span.endNs ?? span.startNs,
              attributes: Object.entries(span.attributes).map(([key, value]) =>
                toOtelAttribute(key, value),
              ),
            })),
          },
        ],
      },
    ],
  };
}

export async function flushLangfuseTelemetry() {
  if (
    !activeConfig ||
    !httpSender ||
    (!pendingSpans.length && !pendingScores.length) ||
    flushScheduled
  ) {
    return;
  }
  flushScheduled = true;
  const spans = pendingSpans;
  pendingSpans = [];
  const scores = pendingScores;
  pendingScores = [];
  const config = activeConfig;
  const sender = httpSender;
  try {
    if (spans.length) {
      const response = await sender.request({
        url: `${config.host}/api/public/otel/v1/traces`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(config),
        },
        body: JSON.stringify(buildOtelPayload(spans)),
      });
      if (response.status < 200 || response.status >= 300) {
        console.debug(
          `AI Reading Companion: Langfuse OTLP export returned ${response.status}.`,
        );
      }
    }
    if (scores.length) {
      // score 事件在 v4 events_only 模式下仍由旧 ingestion API 接受。
      const response = await sender.request({
        url: `${config.host}/api/public/ingestion`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders(config),
        },
        body: JSON.stringify({
          batch: scores.map((score) => ({
            type: "score-create",
            id: score.id,
            timestamp: score.timestamp,
            body: score.body,
          })),
        }),
      });
      if (response.status < 200 || response.status >= 300) {
        console.debug(
          `AI Reading Companion: Langfuse score ingestion returned ${response.status}.`,
        );
      }
    }
  } catch (error) {
    console.debug("AI Reading Companion: Langfuse telemetry flush failed.", error);
  } finally {
    flushScheduled = false;
  }
}

// ---- trace 上下文 ----

interface ActiveTrace {
  traceId: string;
  rootSpanId: string;
  metadata: Record<string, unknown>;
}

let activeTrace: ActiveTrace | null = null;

export function startLangfuseTrace(options: {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  sessionId?: string;
}) {
  if (!activeConfig) return null;
  const traceId = randomHex(16);
  const rootSpanId = randomHex(8);
  const attributes: Record<string, string | number | boolean> = {
    "langfuse.observation.type": "SPAN",
    "langfuse.trace.name": options.name,
    // 标记该 span 行承载 trace 级数据（Langfuse SDK 对根 span 同样如此），
    // v4 事件表的 trace 聚合依赖 is_app_root 取 input/output/session。
    "langfuse.internal.is_app_root": "true",
  };
  const input = jsonAttr(options.input);
  if (input !== undefined) {
    // trace 事件与根 span 观测在 v4 事件表中是同一行（is_app_root），
    // 两个域的 input 都写，保证聚合/UI 都能取到。
    attributes["langfuse.trace.input"] = input;
    attributes["langfuse.observation.input"] = input;
  }
  if (options.sessionId) {
    attributes["session.id"] = String(options.sessionId);
  }
  openSpans.set(rootSpanId, {
    traceId,
    spanId: rootSpanId,
    name: options.name,
    startNs: nowNs(),
    attributes,
  });
  activeTrace = {
    traceId,
    rootSpanId,
    metadata: { ...(options.metadata || {}) },
  };
  return traceId;
}

export function endLangfuseTrace(options: {
  traceId?: string | null;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
}) {
  if (!activeTrace || !activeConfig) return;
  if (options.traceId && options.traceId !== activeTrace.traceId) {
    return;
  }
  const trace = activeTrace;
  activeTrace = null;
  // 兜底收尾：trace 结束时仍未关闭的子 observation（异常中断路径）标记后关闭。
  for (const [spanId, child] of openSpans) {
    if (child.traceId !== trace.traceId || spanId === trace.rootSpanId) {
      continue;
    }
    openSpans.delete(spanId);
    child.endNs = nowNs();
    child.attributes["langfuse.observation.level"] = "ERROR";
    child.attributes["langfuse.observation.status_message"] =
      "Trace ended before this observation closed.";
    pendingSpans.push(child);
  }
  const span = openSpans.get(trace.rootSpanId);
  if (span) {
    openSpans.delete(trace.rootSpanId);
    span.endNs = nowNs();
    const output = jsonAttr(options.output);
    if (output !== undefined) {
      span.attributes["langfuse.trace.output"] = output;
      span.attributes["langfuse.observation.output"] = output;
    }
    const mergedMetadata = { ...trace.metadata, ...(options.metadata || {}) };
    const metadata = jsonAttr(mergedMetadata);
    if (metadata !== undefined) {
      span.attributes["langfuse.trace.metadata"] = metadata;
    }
    if (options.error !== undefined) {
      const message = errorMessage(options.error);
      span.attributes["langfuse.observation.level"] = "ERROR";
      span.attributes["langfuse.observation.status_message"] = message;
      span.attributes["langfuse.trace.output"] = message;
      span.attributes["langfuse.observation.output"] = message;
    }
    pendingSpans.push(span);
  }
  void flushLangfuseTelemetry();
}

export function currentLangfuseTraceId() {
  return activeTrace?.traceId ?? null;
}

// ---- generation（模型调用）----

export function startLangfuseGeneration(options: {
  name: string;
  model: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}) {
  if (!activeTrace || !activeConfig) return null;
  const span = beginObservation("GENERATION", options.name, {
    "langfuse.observation.model.name": options.model,
  });
  if (!span) return null;
  const input = jsonAttr(options.input);
  if (input !== undefined) span.attributes["langfuse.observation.input"] = input;
  const metadata = jsonAttr(options.metadata);
  if (metadata !== undefined) {
    span.attributes["langfuse.observation.metadata"] = metadata;
  }
  return span.spanId;
}

export function endLangfuseGeneration(
  id: string | null,
  options: {
    output?: unknown;
    usage?: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens?: number;
      reasoningTokens?: number;
    };
    error?: unknown;
    metadata?: Record<string, unknown>;
  },
) {
  const span = takeOpenSpan(id);
  if (!span) return;
  const output = jsonAttr(options.output);
  if (output !== undefined) span.attributes["langfuse.observation.output"] = output;
  if (options.usage) {
    const usage: Record<string, number> = {
      input: options.usage.inputTokens,
      output: options.usage.outputTokens,
      total: options.usage.totalTokens,
    };
    if (options.usage.cachedInputTokens !== undefined) {
      usage.input_cached = options.usage.cachedInputTokens;
    }
    if (options.usage.reasoningTokens !== undefined) {
      usage.output_reasoning = options.usage.reasoningTokens;
    }
    span.attributes["langfuse.observation.usage_details"] = JSON.stringify(usage);
  }
  if (options.error !== undefined) {
    const message = errorMessage(options.error);
    span.attributes["langfuse.observation.level"] = "ERROR";
    span.attributes["langfuse.observation.status_message"] = message;
    span.attributes["langfuse.observation.output"] = message;
  }
  finishObservation(span);
}

// ---- span（工具调用等）----

export function startLangfuseSpan(options: {
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
}) {
  if (!activeTrace || !activeConfig) return null;
  const span = beginObservation("SPAN", options.name, {});
  if (!span) return null;
  const input = jsonAttr(options.input);
  if (input !== undefined) span.attributes["langfuse.observation.input"] = input;
  const metadata = jsonAttr(options.metadata);
  if (metadata !== undefined) {
    span.attributes["langfuse.observation.metadata"] = metadata;
  }
  return span.spanId;
}

export function endLangfuseSpan(
  id: string | null,
  options: {
    output?: unknown;
    error?: unknown;
    level?: "DEFAULT" | "ERROR";
  },
) {
  const span = takeOpenSpan(id);
  if (!span) return;
  const output = jsonAttr(options.output);
  if (output !== undefined) span.attributes["langfuse.observation.output"] = output;
  if (options.error !== undefined) {
    const message = errorMessage(options.error);
    span.attributes["langfuse.observation.level"] = "ERROR";
    span.attributes["langfuse.observation.status_message"] = message;
    span.attributes["langfuse.observation.output"] = message;
  } else if (options.level) {
    span.attributes["langfuse.observation.level"] = options.level;
  }
  finishObservation(span);
}

function beginObservation(
  type: "SPAN" | "GENERATION",
  name: string,
  attributes: Record<string, string | number | boolean>,
): PendingSpan | null {
  if (!activeTrace) return null;
  const spanId = randomHex(8);
  const span: PendingSpan = {
    traceId: activeTrace.traceId,
    spanId,
    parentSpanId: activeTrace.rootSpanId,
    name,
    startNs: nowNs(),
    attributes: { "langfuse.observation.type": type, ...attributes },
  };
  openSpans.set(spanId, span);
  return span;
}

function takeOpenSpan(id: string | null): PendingSpan | null {
  if (!id || !activeConfig) return null;
  const span = openSpans.get(id);
  if (!span) return null;
  openSpans.delete(id);
  return span;
}

function finishObservation(span: PendingSpan) {
  span.endNs = nowNs();
  pendingSpans.push(span);
}

// ---- score（评测用）----

export function addLangfuseScore(options: {
  traceId: string;
  name: string;
  value: number;
  comment?: string;
}) {
  if (!activeConfig) return;
  pendingScores.push({
    id: randomId(),
    timestamp: nowIso(),
    body: {
      id: randomId(),
      traceId: options.traceId,
      name: options.name,
      value: options.value,
      comment: options.comment,
    },
  });
  void flushLangfuseTelemetry();
}
