import type { SessionStorageAdapter } from "./session-store";

export type RunOutcome = "completed" | "cancelled" | "failed";

export interface AgentRunMetric {
  id: string;
  startedAt: number;
  durationMs: number;
  outcome: RunOutcome;
  errorKind: string;
  protocol: string;
  device: "desktop" | "mobile";
  webSearchRoute: string;
  estimatedInputTokens: number;
  contextCharacters: number;
  contextBudgetCharacters: number;
  trimmedSections: number;
  imageCount: number;
  localSourceCount: number;
  webSourceCount: number;
  modelRounds: number;
  toolCalls: number;
}

interface MetricsEnvelope {
  version: 1;
  updatedAt: number;
  metrics: AgentRunMetric[];
}

const MAX_METRICS = 200;
const MAX_BYTES = 256 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function percentile(values: number[], percent: number) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percent))];
}

export class RunMetricsStore {
  private adapter: SessionStorageAdapter;
  private path: string;

  constructor(options: { adapter: SessionStorageAdapter; path: string }) {
    this.adapter = options.adapter;
    this.path = options.path;
  }

  async load() {
    if (!(await this.adapter.exists(this.path))) {
      return [] as AgentRunMetric[];
    }
    try {
      const parsed = JSON.parse(await this.adapter.read(this.path)) as MetricsEnvelope;
      if (parsed?.version !== 1 || !Array.isArray(parsed.metrics)) {
        return [] as AgentRunMetric[];
      }
      const cutoff = Date.now() - MAX_AGE_MS;
      return parsed.metrics
        .filter((metric) => metric.startedAt >= cutoff)
        .slice(0, MAX_METRICS);
    } catch {
      return [] as AgentRunMetric[];
    }
  }

  async append(metric: AgentRunMetric) {
    const metrics = [metric, ...(await this.load())]
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, MAX_METRICS);
    while (metrics.length) {
      const serialized = JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        metrics,
      } satisfies MetricsEnvelope);
      if (bytes(serialized) <= MAX_BYTES) {
        await this.adapter.write(this.path, serialized);
        return;
      }
      metrics.pop();
    }
  }

  async clear() {
    if (this.adapter.remove) {
      await this.adapter.remove(this.path);
      return;
    }
    await this.adapter.write(
      this.path,
      JSON.stringify({ version: 1, updatedAt: Date.now(), metrics: [] } satisfies MetricsEnvelope),
    );
  }

  async summarize() {
    const metrics = await this.load();
    const durations = metrics.map((metric) => metric.durationMs);
    const completed = metrics.filter((metric) => metric.outcome === "completed").length;
    const cancelled = metrics.filter((metric) => metric.outcome === "cancelled").length;
    const trimmed = metrics.filter((metric) => metric.trimmedSections > 0).length;
    const errors = new Map<string, number>();
    for (const metric of metrics.filter((item) => item.outcome === "failed")) {
      const kind = metric.errorKind || "unknown";
      errors.set(kind, (errors.get(kind) || 0) + 1);
    }
    return {
      count: metrics.length,
      completed,
      cancelled,
      failed: metrics.length - completed - cancelled,
      durationP50Ms: percentile(durations, 0.5),
      durationP95Ms: percentile(durations, 0.95),
      cancellationRate: metrics.length ? cancelled / metrics.length : 0,
      trimmingRate: metrics.length ? trimmed / metrics.length : 0,
      averageEstimatedInputTokens: metrics.length
        ? Math.round(
            metrics.reduce((total, metric) => total + metric.estimatedInputTokens, 0) /
              metrics.length,
          )
        : 0,
      errors: [...errors.entries()].sort((left, right) => right[1] - left[1]),
    };
  }
}
