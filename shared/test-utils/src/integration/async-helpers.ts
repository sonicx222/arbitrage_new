/**
 * Async Test Helpers
 */

/**
 * Wait for a condition to be true with exponential backoff
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: { timeout?: number; initialInterval?: number; maxInterval?: number } = {}
): Promise<void> {
  const { timeout = 5000, initialInterval = 10, maxInterval = 100 } = options;
  const startTime = Date.now();
  let interval = initialInterval;

  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, maxInterval);
  }

  throw new Error(`waitFor timeout after ${timeout}ms`);
}

/**
 * Wrap a promise with a timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = 'Operation timed out'
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

/**
 * Retry an async operation with exponential backoff
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; initialDelayMs?: number; maxDelayMs?: number } = {}
): Promise<T> {
  const { maxRetries = 3, initialDelayMs = 100, maxDelayMs = 1000 } = options;
  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, maxDelayMs);
      }
    }
  }

  throw lastError;
}
