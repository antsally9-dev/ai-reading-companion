export function createAbortError(message = "The operation was cancelled.") {
  return new DOMException(message, "AbortError");
}

export function isAbortError(error: unknown) {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
}

export function throwIfAborted(
  signal?: AbortSignal,
  message = "The operation was cancelled.",
) {
  if (signal?.aborted) {
    throw createAbortError(message);
  }
}

export function raceWithAbort<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  message = "The operation was cancelled.",
): Promise<T> {
  if (!signal) {
    return operation;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(message));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(createAbortError(message));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
