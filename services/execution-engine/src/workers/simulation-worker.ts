/**
 * SimulationWorker
 *
 * Phase 3 (ADR-039): Async Pipeline Split.
 *
 * Pre-validates arbitrage opportunities before they reach the execution engine.
 * Consumes from an exec-request stream (using a separate consumer group so it
 * does NOT compete with the EE), runs a lightweight profitability check via
 * BatchQuoterService (single eth_call), and publishes scored, timestamped
 * opportunities to stream:pre-simulated.
 *
 * The EE consumes from stream:pre-simulated when ASYNC_PIPELINE_SPLIT=true,
 * skipping opportunities that failed the profitability check.
 *
 * Fail-open: when BatchQuoter throws (RPC timeout, etc.) the opportunity is
 * forwarded rather than dropped — transient infra issues should never discard
 * potentially profitable trades.
 *
 * @see ADR-039: Async Pipeline Split with SimulationWorker
 * @see services/execution-engine/src/services/simulation/batch-quoter.service.ts
 */

import { StreamConsumer } from '@arbitrage/core/redis';
import type { RedisStreamsClient } from '@arbitrage/core/redis';
import { getErrorMessage } from '@arbitrage/core/resilience';
import { FLASH_LOAN_PROVIDERS } from '@arbitrage/config';
import type { Logger } from '../types';
import type {
  QuoteRequest,
  ArbitrageSimulationResult,
} from '../services/simulation/batch-quoter.service';

// =============================================================================
// Public Interfaces
// =============================================================================

/**
 * Configuration for SimulationWorker.
 */
export interface SimulationWorkerConfig {
  /** Source stream to consume exec-requests from (e.g. stream:exec-requests-fast) */
  sourceStream: string;
  /** Target stream to publish pre-validated opportunities to */
  targetStream: string;
  /** Consumer group name (separate from EE group to avoid message competition) */
  consumerGroupName: string;
  /** Consumer instance name */
  consumerName: string;
  /** Maximum concurrent message processing (default: 10) */
  maxConcurrent?: number;
}

/**
 * Minimal BatchQuoter interface required by SimulationWorker.
 * Structurally compatible with BatchQuoterService.simulateArbitragePath.
 *
 * @see services/execution-engine/src/services/simulation/batch-quoter.service.ts
 */
export interface SimulationWorkerBatchQuoter {
  simulateArbitragePath(
    requests: QuoteRequest[],
    flashLoanAmount: bigint,
    flashLoanFeeBps: number,
  ): Promise<ArbitrageSimulationResult>;
}

/**
 * Runtime counters for monitoring and health checks.
 */
export interface SimulationWorkerStats {
  /** Total messages consumed from source stream */
  processed: number;
  /** Messages forwarded to pre-simulated stream */
  forwarded: number;
  /** Messages dropped (unprofitable per BatchQuoter) */
  dropped: number;
  /** Messages that caused an error (forwarded via fail-open) */
  errors: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * H-004 FIX: Default flash loan fee (Aave V3: 9 bps) for chains not in FLASH_LOAN_PROVIDERS.
 * Used as fallback when chain is unknown or has no configured flash loan provider.
 */
const DEFAULT_FLASH_LOAN_FEE_BPS = 9;

/**
 * H-004 FIX: Look up flash loan fee in basis points for a given chain.
 * Uses FLASH_LOAN_PROVIDERS (single source of truth) instead of hardcoding Aave V3's 9 bps.
 *
 * Actual fees by chain: Aave V3 (9 bps), Balancer V2 (0 bps), PancakeSwap V3 (25 bps),
 * SyncSwap (30 bps). Previously all chains used 9 bps, causing ~60% of paths to be
 * scored with incorrect fee assumptions.
 */
function getFlashLoanFeeBps(chain: string): number {
  const provider = FLASH_LOAN_PROVIDERS[chain.toLowerCase()];
  return provider?.fee ?? DEFAULT_FLASH_LOAN_FEE_BPS;
}

// =============================================================================
// SimulationWorker
// =============================================================================

/**
 * Phase 3 (ADR-039): Async pipeline simulation worker.
 *
 * Lifecycle:
 * - start() — creates StreamConsumer and begins consuming
 * - stop()  — stops the StreamConsumer gracefully
 * - getStats() — returns current processing counters
 */
export class SimulationWorker {
  private readonly logger: Logger;
  private readonly streamsClient: RedisStreamsClient;
  private readonly batchQuoter: SimulationWorkerBatchQuoter | null;
  private readonly config: SimulationWorkerConfig;

  private consumer: { start: () => void; stop: () => Promise<void> } | null = null;
  private readonly stats: SimulationWorkerStats = {
    processed: 0,
    forwarded: 0,
    dropped: 0,
    errors: 0,
  };

  constructor(
    logger: Logger,
    streamsClient: RedisStreamsClient,
    batchQuoter: SimulationWorkerBatchQuoter | null,
    config: SimulationWorkerConfig,
  ) {
    this.logger = logger;
    this.streamsClient = streamsClient;
    this.batchQuoter = batchQuoter;
    this.config = config;
  }

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  async start(): Promise<void> {
    // The handler is typed as (msg: Record<string, unknown>) => Promise<void>.
    // TypeScript accepts this as a StreamConsumerConfig.handler because StreamMessage
    // extends Record<string, unknown> (function parameter contravariance).
    //
    // At runtime, StreamConsumer calls handler(streamMessage) where
    // streamMessage = { id: 'redis-id', data: { id: 'opp-id', ... } }.
    // The processMessage() method detects the StreamMessage wrapper via the
    // presence of a 'data' object field and extracts the flat opportunity data.
    //
    // In unit tests, the mock captures this handler and calls it directly with
    // the flat opportunity data (no wrapper). The same 'data' field detection
    // handles both paths transparently.
    const handler = async (msg: Record<string, unknown>): Promise<void> => {
      this.stats.processed++;
      // Unwrap StreamMessage wrapper if present (production), else use flat data (tests)
      const data: Record<string, unknown> =
        msg['data'] != null && typeof msg['data'] === 'object'
          ? (msg['data'] as Record<string, unknown>)
          : msg;

      await this.processMessage(data);
    };

    this.consumer = new StreamConsumer(this.streamsClient, {
      config: {
        streamName: this.config.sourceStream,
        groupName: this.config.consumerGroupName,
        consumerName: this.config.consumerName,
      },
      // TypeScript requires an explicit double-cast here because StreamMessage<T>
      // lacks an index signature and therefore isn't structurally compatible with
      // Record<string, unknown> at the type level. At runtime the handler correctly
      // handles both StreamMessage (production) and flat data (tests) via the
      // data-field detection in the handler closure above.
      handler: handler as unknown as ConstructorParameters<typeof StreamConsumer>[1]['handler'],
      autoAck: true,
      logger: {
        error: (m: string, ctx?: Record<string, unknown>) => this.logger.error(m, ctx),
        warn: (m: string, ctx?: Record<string, unknown>) => this.logger.warn?.(m, ctx),
      },
    });

    this.consumer.start();
  }

  async stop(): Promise<void> {
    await this.consumer?.stop();
    this.consumer = null;
  }

  getStats(): SimulationWorkerStats {
    return { ...this.stats };
  }

  // ===========================================================================
  // Message Processing
  // ===========================================================================

  /**
   * Process a single opportunity message.
   *
   * Happy path: run profitability check → stamp preSimulatedAt + preSimulationScore
   *             → publish to pre-simulated stream.
   * Drop path: BatchQuoter reports expectedProfit <= 0 → discard (stats.dropped++).
   * Fail-open: BatchQuoter throws → forward with neutral score (stats.errors++).
   * Pass-through: no BatchQuoter configured → forward directly (stats.forwarded++).
   */
  private async processMessage(data: Record<string, unknown>): Promise<void> {
    let forwarded = false;

    try {
      let shouldForward = true;
      let simulationScore = this.computeScore(data);

      // Run profitability check only when:
      //   1. A BatchQuoter is configured (not pass-through mode)
      //   2. Both tokenIn and tokenOut are present (required for path construction)
      if (this.batchQuoter && data['tokenIn'] != null && data['tokenOut'] != null) {
        try {
          const amountIn = this.parseAmountIn(data);
          const requests: QuoteRequest[] = [
            {
              router: '0x0000000000000000000000000000000000000001', // placeholder — real path not reconstructable from stream data alone
              tokenIn: String(data['tokenIn']),
              tokenOut: String(data['tokenOut']),
              amountIn,
            },
          ];

          // H-004 FIX: Use chain-specific flash loan fee instead of hardcoded Aave V3 fee
          const chain = String(data['chain'] ?? '');
          const feeBps = getFlashLoanFeeBps(chain);

          const result = await this.batchQuoter.simulateArbitragePath(
            requests,
            amountIn,
            feeBps,
          );

          if (result.expectedProfit <= 0n) {
            shouldForward = false;
            this.stats.dropped++;
            this.logger.debug('SimulationWorker: dropping unprofitable opportunity', {
              opportunityId: String(data['id'] ?? 'unknown'),
              expectedProfit: String(result.expectedProfit),
            });
          } else {
            // Override score with on-chain simulation result
            simulationScore = this.computeSimulatedScore(result, amountIn);
          }
        } catch (quoterError) {
          // Fail-open: don't drop on transient RPC errors
          this.stats.errors++;
          this.logger.warn('SimulationWorker: BatchQuoter failed, forwarding (fail-open)', {
            opportunityId: String(data['id'] ?? 'unknown'),
            error: getErrorMessage(quoterError),
          });
          // simulationScore stays at the pre-computed value
        }
      }

      if (shouldForward) {
        const published: Record<string, unknown> = {
          ...data,
          preSimulatedAt: Date.now(),
          preSimulationScore: simulationScore,
        };

        await this.streamsClient.xaddWithLimit(this.config.targetStream, published);
        this.stats.forwarded++;
        forwarded = true;
      }
    } catch (publishError) {
      this.stats.errors++;
      this.logger.error('SimulationWorker: failed to process or publish message', {
        opportunityId: String(data['id'] ?? 'unknown'),
        error: getErrorMessage(publishError),
      });
    }

    if (forwarded) {
      this.logger.debug('SimulationWorker: forwarded opportunity to pre-simulated stream', {
        opportunityId: String(data['id'] ?? 'unknown'),
      });
    }
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /**
   * Compute a pre-simulation profitability score from the opportunity's
   * self-reported expectedProfit and confidence fields.
   *
   * Returns a value in [0, 1] — higher = more likely to be profitable.
   * Used when BatchQuoter is unavailable or when skipping quoter due to
   * missing tokenIn/tokenOut.
   */
  private computeScore(data: Record<string, unknown>): number {
    const profit = Number(data['expectedProfit'] ?? 0);
    const confidence = Number(data['confidence'] ?? 0.5);
    // M-003 FIX: Normalize profit to [0,1] before multiplying by confidence.
    // Previously, profit * confidence saturated to 1.0 for any expectedProfit > 2
    // with confidence >= 0.5, making all opportunities score identically.
    // Denominator of 100 maps expectedProfit in USD to a 0-1 range
    // (e.g., $50 profit → 0.5, $100+ profit → 1.0).
    const normalizedProfit = Math.min(1, Math.max(0, profit / 100));
    return Math.min(1, Math.max(0, normalizedProfit * confidence));
  }

  /**
   * Compute score from on-chain BatchQuoter simulation result.
   * Normalizes expectedProfit (in wei) relative to flashLoanAmount.
   */
  private computeSimulatedScore(result: ArbitrageSimulationResult, flashLoanAmount: bigint): number {
    if (flashLoanAmount === 0n) return 0;
    const ratio = Number(result.expectedProfit) / Number(flashLoanAmount);
    return Math.min(1, Math.max(0, ratio));
  }

  private parseAmountIn(data: Record<string, unknown>): bigint {
    try {
      return BigInt(String(data['amountIn'] ?? '0'));
    } catch {
      return 0n;
    }
  }
}
