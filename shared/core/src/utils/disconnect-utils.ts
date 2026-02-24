/**
 * Timeout-guarded disconnect utility.
 *
 * Deduplicates the common pattern of disconnecting a client with a timeout
 * guard to prevent indefinite hangs during shutdown.
 *
 * @see services/execution-engine/src/engine.ts (3 instances)
 * @see services/cross-chain-detector/src/detector.ts (2 instances)
 * @see services/coordinator/src/coordinator.ts (2 instances)
 * @see services/unified-detector/src/chain-instance.ts (1 instance)
 */

/** Minimal logger interface for disconnect operations. */
interface DisconnectLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Disconnect or shut down a client with a timeout guard.
 *
 * If the client is null/undefined, this is a no-op.
 * If the disconnect/shutdown call exceeds `timeoutMs`, the timeout error is
 * caught and logged as a warning. The caller is responsible for nullifying
 * the client reference afterward.
 *
 * Supports clients with either `disconnect()` or `shutdown()` methods.
 *
 * @param client - The client to disconnect (may be null)
 * @param name - Human-readable name for log messages (e.g., 'Redis', 'Streams client')
 * @param timeoutMs - Maximum time to wait for disconnect
 * @param logger - Logger for warning on timeout/error
 */
export async function disconnectWithTimeout(
  client: { disconnect(): void | Promise<void> } | { shutdown(): void | Promise<void> } | null | undefined,
  name: string,
  timeoutMs: number,
  logger: DisconnectLogger,
): Promise<void> {
  if (!client) return;

  try {
    const disconnectFn = 'disconnect' in client
      ? client.disconnect.bind(client)
      : (client as { shutdown(): void | Promise<void> }).shutdown.bind(client);

    await Promise.race([
      disconnectFn(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(`${name} disconnect timeout`)), timeoutMs)
      ),
    ]);
  } catch (error) {
    logger.warn(`${name} disconnect timeout or error`, { error: (error as Error).message });
  }
}
