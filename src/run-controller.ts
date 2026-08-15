import {
  createAbortError,
  isAbortError,
  raceWithAbort,
  throwIfAborted,
} from "./abort";

export type RunCancelReason =
  | "user"
  | "timeout"
  | "view_closed"
  | "plugin_unloaded";

export type RunStage =
  | "created"
  | "assembling_context"
  | "calling_model"
  | "executing_tool"
  | "awaiting_permission"
  | "persisting_result"
  | "cancel_requested"
  | "cancelled"
  | "failed"
  | "completed";

export interface RunEvent {
  runId: string;
  stage: RunStage;
  at: number;
  elapsedMs: number;
  detail?: Record<string, unknown>;
}

export interface RunObserver {
  onEvent(event: Readonly<RunEvent>): void | Promise<void>;
}

export interface RunExecutionContext {
  runId: string;
  signal: AbortSignal;
  emit(
    stage: RunStage,
    detail?: Record<string, unknown>,
  ): Promise<void>;
}

export interface RunStartOptions {
  runId?: string;
  timeoutMs?: number;
  observers?: RunObserver[];
}

export interface RunHandle<T> {
  runId: string;
  signal: AbortSignal;
  result: Promise<T>;
  cancel(reason?: RunCancelReason): void;
}

interface ActiveRun {
  controller: AbortController;
  cancelReason: RunCancelReason | null;
  emit(
    stage: RunStage,
    detail?: Record<string, unknown>,
  ): Promise<void>;
}

export class RunCancelledError extends Error {
  reason: RunCancelReason;

  constructor(reason: RunCancelReason) {
    super(
      reason === "timeout"
        ? "The AI request timed out."
        : "The AI request was cancelled.",
    );
    this.name = "RunCancelledError";
    this.reason = reason;
  }
}

function makeRunId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class RunController {
  private activeRuns = new Map<string, ActiveRun>();

  start<T>(
    execute: (context: RunExecutionContext) => Promise<T>,
    options: RunStartOptions = {},
  ): RunHandle<T> {
    const runId = options.runId || makeRunId();
    if (this.activeRuns.has(runId)) {
      throw new Error(`A run with ID ${runId} is already active.`);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const observers = [...(options.observers || [])];
    let observerQueue = Promise.resolve();
    let terminal = false;

    const emit = (
      stage: RunStage,
      detail?: Record<string, unknown>,
    ) => {
      if (
        terminal &&
        stage !== "completed" &&
        stage !== "cancelled" &&
        stage !== "failed"
      ) {
        return observerQueue;
      }
      const event: RunEvent = {
        runId,
        stage,
        at: Date.now(),
        elapsedMs: Date.now() - startedAt,
        detail,
      };
      observerQueue = observerQueue.then(async () => {
        for (const observer of observers) {
          try {
            await observer.onEvent(Object.freeze(event));
          } catch {
            // Observers are intentionally non-blocking and cannot fail a run.
          }
        }
      });
      return observerQueue;
    };

    const active: ActiveRun = {
      controller,
      cancelReason: null,
      emit,
    };
    this.activeRuns.set(runId, active);

    const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0);
    const timeoutId = timeoutMs
      ? window.setTimeout(() => this.cancel(runId, "timeout"), timeoutMs)
      : null;

    const execution = (async () => {
      await emit("created");
      throwIfAborted(controller.signal);
      return execute({ runId, signal: controller.signal, emit });
    })();

    const result = (async () => {
      try {
        const value = await raceWithAbort(
          execution,
          controller.signal,
          "The AI run was cancelled.",
        );
        throwIfAborted(controller.signal);
        terminal = true;
        await emit("completed");
        return value;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          terminal = true;
          const reason = active.cancelReason || "user";
          await emit("cancelled", { reason });
          throw new RunCancelledError(reason);
        }
        terminal = true;
        await emit("failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        this.activeRuns.delete(runId);
      }
    })();

    return {
      runId,
      signal: controller.signal,
      result,
      cancel: (reason = "user") => this.cancel(runId, reason),
    };
  }

  cancel(runId: string, reason: RunCancelReason = "user") {
    const active = this.activeRuns.get(runId);
    if (!active || active.controller.signal.aborted) {
      return;
    }
    active.cancelReason = reason;
    void active.emit("cancel_requested", { reason });
    active.controller.abort(createAbortError());
  }

  cancelAll(reason: RunCancelReason = "plugin_unloaded") {
    for (const runId of [...this.activeRuns.keys()]) {
      this.cancel(runId, reason);
    }
  }

  isActive(runId: string) {
    return this.activeRuns.has(runId);
  }
}
