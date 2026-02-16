/**
 * Timeout-with-cleanup utility
 *
 * Wraps a promise with a timeout that cleans up the timer
 * regardless of whether the promise resolves or the timeout fires.
 *
 * R1: Extracted from duplicate patterns in:
 * - weighted-ranking.strategy.ts (ranking timeout)
 * - onchain-liquidity.validator.ts (RPC timeout)
 *
 * @see weighted-ranking.strategy.ts
 * @see onchain-liquidity.validator.ts
 */

/**
 * Race a promise against a timeout, ensuring the timer is always cleaned up.
 *
 * @param promise - The promise to race against the timeout
 * @param timeoutMs - Timeout duration in milliseconds
 * @param errorMessage - Error message for the timeout rejection
 * @returns The result of the promise if it resolves before the timeout
 * @throws Error with the provided message if the timeout fires first
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage: string
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}
