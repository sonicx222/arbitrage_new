/**
 * CQ-8: Bridge Recovery Service
 *
 * Extracted from CrossChainStrategy to reduce file size.
 * Handles persistence, status updates, and recovery of pending bridge transactions.
 *
 * @see CrossChainStrategy — owner, delegates recovery operations here
 * @see BridgeRecoveryManager — periodic scheduler that calls recoverPendingBridges
 */

import { ethers } from 'ethers';
import { getErrorMessage } from '@arbitrage/core/resilience';
import {
  hmacSign,
  hmacVerify,
  getHmacSigningKey,
  isSignedEnvelope,
} from '@arbitrage/core/utils';
import type { BridgeStatusResult } from '@arbitrage/core/bridge-router';
import type { SignedEnvelope } from '@arbitrage/core/utils';
import type { ArbitrageOpportunity } from '@arbitrage/types';
import type { StrategyContext, BridgeRecoveryState, Logger } from '../types';
import {
  BRIDGE_RECOVERY_KEY_PREFIX,
  getBridgeRecoveryMaxAge,
} from '../types';

/**
 * Delegate interface for strategy methods needed by bridge recovery.
 * Avoids tight coupling to CrossChainStrategy.
 */
export interface BridgeRecoveryDelegate {
  prepareDexSwapTransaction(
    opportunity: ArbitrageOpportunity,
    chain: string,
    ctx: StrategyContext,
  ): Promise<ethers.TransactionRequest>;
  estimateTradeSizeUsd(
    amount: string | undefined,
    token: string | undefined,
    chain: string,
  ): number | undefined;
}

export class BridgeRecoveryService {
  constructor(
    private readonly logger: Logger,
    private readonly delegate: BridgeRecoveryDelegate,
  ) {}

  /**
   * Persist bridge recovery state to Redis before bridge execution.
   *
   * This enables recovery if shutdown occurs during bridge polling.
   * The state is stored in Redis with a protocol-aware TTL.
   * Native rollup bridges get 8 days (7-day challenge + buffer).
   *
   * @param state - Bridge recovery state to persist
   * @param redis - Redis client for persistence
   * @see docs/reports/EXTENDED_DEEP_ANALYSIS_2026-02-23.md P0-3
   */
  async persistState(
    state: BridgeRecoveryState,
    redis: import('@arbitrage/core').RedisClient,
  ): Promise<void> {
    const key = `${BRIDGE_RECOVERY_KEY_PREFIX}${state.bridgeId}`;
    // P0-3: Use protocol-aware TTL instead of global constant
    const ttlSeconds = Math.floor(getBridgeRecoveryMaxAge(state.bridgeProtocol) / 1000);

    try {
      // Fix #4: HMAC-sign recovery state to prevent tampering
      // P3-27: Include Redis key as HMAC context to prevent cross-key replay
      const signedEnvelope = hmacSign(state, getHmacSigningKey(), key);
      await redis.set(key, signedEnvelope, ttlSeconds);
      this.logger.debug('Persisted bridge recovery state', {
        bridgeId: state.bridgeId,
        opportunityId: state.opportunityId,
        sourceChain: state.sourceChain,
        destChain: state.destChain,
        signed: !!signedEnvelope.sig,
      });
    } catch (error) {
      // Log but don't fail - recovery is best-effort
      this.logger.warn('Failed to persist bridge recovery state', {
        bridgeId: state.bridgeId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Update bridge recovery status in Redis.
   *
   * Called when bridge completes (to mark as recovered) or fails (to mark as failed).
   *
   * @param bridgeId - Bridge transaction ID
   * @param status - New status
   * @param redis - Redis client
   * @param errorMessage - Optional error message for failed status
   */
  async updateStatus(
    bridgeId: string,
    status: BridgeRecoveryState['status'],
    redis: import('@arbitrage/core').RedisClient,
    errorMessage?: string,
  ): Promise<void> {
    const key = `${BRIDGE_RECOVERY_KEY_PREFIX}${bridgeId}`;

    try {
      // Fix #4: Read and verify HMAC-signed envelope
      const signingKey = getHmacSigningKey();
      const raw = await redis.get(key);

      if (!raw || typeof raw !== 'object') {
        this.logger.warn('Cannot update bridge recovery status - state not found or corrupt', {
          bridgeId,
          status,
        });
        return;
      }

      // Verify HMAC if present
      let state: BridgeRecoveryState;
      if (isSignedEnvelope(raw)) {
        // P3-27: Include Redis key as HMAC context
        let verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey, key);
        if (!verified) {
          // Migration: try without context for pre-P3-27 signed data
          verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey);
        }
        if (!verified) {
          this.logger.error('Bridge recovery state HMAC verification failed', {
            bridgeId,
            requestedStatus: status,
          });
          return;
        }
        state = verified;
      } else if (signingKey) {
        this.logger.warn('Unsigned bridge recovery state rejected — HMAC signing enabled', { bridgeId });
        return;
      } else {
        state = raw as BridgeRecoveryState;
      }

      // Update state
      state.status = status;
      state.lastCheckAt = Date.now();
      if (errorMessage) {
        state.errorMessage = errorMessage;
      }

      // Re-sign and persist
      const signedEnvelope = hmacSign(state, getHmacSigningKey(), key);
      const ttlSeconds = Math.floor(getBridgeRecoveryMaxAge(state.bridgeProtocol) / 1000);
      await redis.set(key, signedEnvelope, ttlSeconds);
    } catch (error) {
      this.logger.warn('Failed to update bridge recovery status', {
        bridgeId,
        status,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Scan for pending bridge recovery states and attempt to recover them.
   *
   * Called by BridgeRecoveryManager on a periodic interval, and on engine startup.
   *
   * @param ctx - Strategy context with bridge router factory and other deps
   * @param redis - Redis client for state retrieval
   * @returns Number of bridges recovered
   */
  async recoverPendingBridges(
    ctx: StrategyContext,
    redis: import('@arbitrage/core').RedisClient,
  ): Promise<number> {
    let recoveredCount = 0;

    try {
      // Scan for pending bridge recovery keys using iterative scan
      // Cap at 10,000 keys to prevent unbounded memory growth in degraded states
      const MAX_RECOVERY_KEYS = 10_000;
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, foundKeys] = await redis.scan(
          cursor,
          'MATCH',
          `${BRIDGE_RECOVERY_KEY_PREFIX}*`,
          'COUNT',
          100,
        );
        cursor = nextCursor;
        // SA-107 FIX: Exclude corrupt dead-letter keys (bridge:recovery:corrupt:*)
        // that match the bridge:recovery:* SCAN pattern
        const validKeys = foundKeys.filter((k: string) => !k.includes(':corrupt:'));
        keys.push(...validKeys);
        if (keys.length >= MAX_RECOVERY_KEYS) {
          this.logger.warn('Bridge recovery key scan hit limit, processing partial set', {
            limit: MAX_RECOVERY_KEYS,
            keysFound: keys.length,
          });
          break;
        }
      } while (cursor !== '0');

      if (keys.length === 0) {
        this.logger.debug('No pending bridges to recover');
        return 0;
      }

      this.logger.info('Found pending bridges for recovery', { count: keys.length });

      // M4 gap: Get HMAC signing key before the loop — consistent with updateStatus
      const signingKey = getHmacSigningKey();

      for (const key of keys) {
        try {
          // FIX P0-1: redis.get() already returns parsed object — no JSON.parse needed
          // @see FIX P0-1 in docs/reports/EXECUTION_ENGINE_DEEP_ANALYSIS_2026-02-20.md
          const raw = await redis.get(key);
          if (!raw) continue;

          if (typeof raw !== 'object') {
            // Corrupt data in Redis - clean up and continue
            this.logger.warn('Corrupt bridge recovery state during scan, deleting key', {
              key,
            });
            await redis.del(key);
            continue;
          }

          // HMAC verification — consistent with updateStatus and BridgeRecoveryManager
          let state: BridgeRecoveryState;
          if (isSignedEnvelope(raw)) {
            // P3-27: Include Redis key as HMAC context to prevent cross-key replay
            let verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey, key);
            if (!verified) {
              // Migration: try without context for pre-P3-27 signed data
              verified = hmacVerify<BridgeRecoveryState>(raw as SignedEnvelope<BridgeRecoveryState>, signingKey);
            }
            if (!verified) {
              this.logger.error('Bridge recovery state HMAC verification failed during recovery scan', { key });
              continue;
            }
            state = verified;
          } else if (signingKey) {
            this.logger.warn('Unsigned bridge recovery state rejected during recovery scan — HMAC signing enabled', { key });
            continue;
          } else {
            state = raw as BridgeRecoveryState;
          }

          // Skip already recovered/failed bridges
          if (state.status === 'recovered' || state.status === 'failed') {
            continue;
          }

          // P0-3: Check if bridge is too old using protocol-aware max age
          const protocolMaxAge = getBridgeRecoveryMaxAge(state.bridgeProtocol);
          if (Date.now() - state.initiatedAt > protocolMaxAge) {
            this.logger.warn('Bridge recovery state expired', {
              bridgeId: state.bridgeId,
              bridgeProtocol: state.bridgeProtocol,
              initiatedAt: state.initiatedAt,
              ageMs: Date.now() - state.initiatedAt,
              maxAgeMs: protocolMaxAge,
            });
            await this.updateStatus(state.bridgeId, 'failed', redis, 'Recovery state expired');
            continue;
          }

          // Attempt recovery
          const recovered = await this.recoverSingleBridge(state, ctx, redis);
          if (recovered) {
            recoveredCount++;
          }
        } catch (error) {
          this.logger.error('Error recovering bridge', {
            key,
            error: getErrorMessage(error),
          });
        }
      }

      this.logger.info('Bridge recovery completed', {
        total: keys.length,
        recovered: recoveredCount,
      });

      return recoveredCount;
    } catch (error) {
      this.logger.error('Bridge recovery scan failed', {
        error: getErrorMessage(error),
      });
      return recoveredCount;
    }
  }

  /**
   * Recover a single pending bridge.
   *
   * Checks bridge status and completes the sell if needed.
   */
  private async recoverSingleBridge(
    state: BridgeRecoveryState,
    ctx: StrategyContext,
    redis: import('@arbitrage/core').RedisClient,
  ): Promise<boolean> {
    this.logger.info('Attempting bridge recovery', {
      bridgeId: state.bridgeId,
      opportunityId: state.opportunityId,
      sourceChain: state.sourceChain,
      destChain: state.destChain,
      initiatedAt: state.initiatedAt,
    });

    // Get bridge router
    if (!ctx.bridgeRouterFactory) {
      this.logger.warn('Cannot recover bridge - no bridge router factory');
      await this.updateStatus(state.bridgeId, 'failed', redis, 'No bridge router factory');
      return false;
    }

    // Estimate trade size from bridge amount (bridgeAmount is in bridgeToken units)
    const recoveryTradeSizeUsd = this.delegate.estimateTradeSizeUsd(
      state.bridgeAmount, state.bridgeToken, state.sourceChain,
    );
    const bridgeRouter = ctx.bridgeRouterFactory.findSupportedRouter(
      state.sourceChain,
      state.destChain,
      state.bridgeToken,
      recoveryTradeSizeUsd,
    );

    if (!bridgeRouter) {
      this.logger.warn('Cannot recover bridge - no suitable router', {
        bridgeId: state.bridgeId,
      });
      await this.updateStatus(state.bridgeId, 'failed', redis, 'No suitable bridge router');
      return false;
    }

    try {
      // Check current bridge status
      const bridgeStatus: BridgeStatusResult = await bridgeRouter.getStatus(state.bridgeId);

      if (bridgeStatus.status === 'completed') {
        // Bridge completed - execute sell
        this.logger.info('Recovered bridge is completed, executing sell', {
          bridgeId: state.bridgeId,
          amountReceived: bridgeStatus.amountReceived,
        });

        // Reconstruct opportunity for sell execution
        const sellOpportunity: ArbitrageOpportunity = {
          id: `${state.opportunityId}-recovery`,
          type: 'cross-chain',
          tokenIn: state.bridgeToken,
          tokenOut: state.tokenIn, // Reverse for sell
          amountIn: bridgeStatus.amountReceived || state.bridgeAmount,
          expectedProfit: state.expectedProfit,
          confidence: 0.5, // Lower confidence for recovery
          timestamp: Date.now(),
          buyChain: state.destChain,
          sellChain: state.destChain,
          buyDex: state.sellDex,
          sellDex: state.sellDex,
          expiresAt: Date.now() + 60000, // 1 minute to execute
        };

        // Execute sell on destination chain
        const destWallet = ctx.wallets.get(state.destChain);
        const destProvider = ctx.providers.get(state.destChain);

        if (!destWallet || !destProvider) {
          this.logger.warn('Cannot execute recovered sell - no wallet/provider', {
            bridgeId: state.bridgeId,
            destChain: state.destChain,
          });
          await this.updateStatus(state.bridgeId, 'failed', redis, 'No wallet/provider for destination');
          return false;
        }

        // Prepare and execute sell transaction
        const sellTx = await this.delegate.prepareDexSwapTransaction(sellOpportunity, state.destChain, ctx);

        const feeData = await destProvider.getFeeData();
        const gasOverrides: Record<string, bigint> = {};
        if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
          gasOverrides.maxFeePerGas = feeData.maxFeePerGas;
          gasOverrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
        } else if (feeData.gasPrice != null) {
          gasOverrides.gasPrice = feeData.gasPrice;
        }

        const signedTx = await destWallet.sendTransaction({
          ...sellTx,
          ...gasOverrides,
        });

        const receipt = await signedTx.wait();

        if (receipt && receipt.status === 1) {
          this.logger.info('Recovery sell succeeded', {
            bridgeId: state.bridgeId,
            sellTxHash: receipt.hash,
          });
          await this.updateStatus(state.bridgeId, 'recovered', redis);
          return true;
        } else {
          this.logger.error('Recovery sell failed', {
            bridgeId: state.bridgeId,
            sellTxHash: receipt?.hash,
          });
          await this.updateStatus(state.bridgeId, 'failed', redis, 'Sell transaction reverted');
          return false;
        }
      } else if (bridgeStatus.status === 'failed' || bridgeStatus.status === 'refunded') {
        this.logger.info('Recovered bridge failed/refunded', {
          bridgeId: state.bridgeId,
          status: bridgeStatus.status,
          error: bridgeStatus.error,
        });
        await this.updateStatus(state.bridgeId, 'failed', redis, bridgeStatus.error || bridgeStatus.status);
        return false;
      } else {
        // Still pending/bridging - update status and leave for next recovery attempt
        this.logger.info('Recovered bridge still in progress', {
          bridgeId: state.bridgeId,
          status: bridgeStatus.status,
        });
        await this.updateStatus(
          state.bridgeId,
          bridgeStatus.status === 'bridging' ? 'bridging' : 'pending',
          redis,
        );
        return false; // Will be retried on next recovery cycle
      }
    } catch (error) {
      this.logger.error('Bridge recovery failed', {
        bridgeId: state.bridgeId,
        error: getErrorMessage(error),
      });
      await this.updateStatus(state.bridgeId, 'failed', redis, getErrorMessage(error));
      return false;
    }
  }
}
