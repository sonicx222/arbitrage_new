/**
 * Stargate Bridge Router
 *
 * Phase 3: Cross-Chain Execution via Stargate (LayerZero)
 *
 * Implements cross-chain token transfers using Stargate protocol.
 * Stargate provides:
 * - Instant guaranteed finality
 * - Native asset transfers (not wrapped)
 * - Unified liquidity across chains
 *
 * Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche
 *
 * @see https://stargateprotocol.gitbook.io/stargate/
 */

import { ethers } from 'ethers';
import {
  IBridgeRouter,
  BridgeProtocol,
  BridgeQuoteRequest,
  BridgeQuote,
  BridgeExecuteRequest,
  BridgeExecuteResult,
  BridgeStatusResult,
  BridgeStatus,
  BRIDGE_DEFAULTS,
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_IDS,
  STARGATE_ROUTER_ADDRESSES,
  BRIDGE_TIMES,
} from './types';
import { createLogger } from '../logger';
import { AsyncMutex } from '../async-mutex';

const logger = createLogger('stargate-router');

// =============================================================================
// Token Address Constants (for approval checks)
// =============================================================================

/**
 * Common token addresses per chain for Stargate bridging
 */
const STARGATE_TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  USDC: {
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    polygon: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    bsc: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    avalanche: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  },
  USDT: {
    ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    arbitrum: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    optimism: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    polygon: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
    bsc: '0x55d398326f99059fF775485246999027B3197955',
    avalanche: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
    fantom: '0x049d68029688eAbF473097a2fC38ef61633A3C7A',  // FIX: Added missing Fantom USDT
  },
};

// =============================================================================
// Stargate Router ABI (minimal required functions)
// =============================================================================

const STARGATE_ROUTER_ABI = [
  // Quote functions
  'function quoteLayerZeroFee(uint16 _dstChainId, uint8 _functionType, bytes calldata _toAddress, bytes calldata _transferAndCallPayload, tuple(uint256 dstGasForCall, uint256 dstNativeAmount, bytes dstNativeAddr) _lzTxParams) external view returns (uint256, uint256)',

  // Swap function
  'function swap(uint16 _dstChainId, uint256 _srcPoolId, uint256 _dstPoolId, address payable _refundAddress, uint256 _amountLD, uint256 _minAmountLD, tuple(uint256 dstGasForCall, uint256 dstNativeAmount, bytes dstNativeAddr) _lzTxParams, bytes calldata _to, bytes calldata _payload) external payable',

  // Events
  'event Swap(uint16 chainId, uint256 dstPoolId, address from, uint256 amountSD, uint256 eqReward, uint256 eqFee, uint256 protocolFee, uint256 lpFee)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

// =============================================================================
// Stargate Router Implementation
// =============================================================================

/**
 * Stargate bridge router for cross-chain token transfers
 */
/**
 * Pending bridge tracking entry
 */
interface PendingBridge {
  status: BridgeStatus;
  sourceTxHash: string;
  sourceChain: string;
  destChain: string;
  startTime: number;
  destTxHash?: string;
  amountReceived?: string;
  error?: string;
}

/**
 * Maximum pending bridges to track (prevents memory leak)
 */
const MAX_PENDING_BRIDGES = 1000;

/**
 * Auto-cleanup interval for old bridges (1 hour)
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export class StargateRouter implements IBridgeRouter {
  readonly protocol: BridgeProtocol = 'stargate';

  readonly supportedSourceChains = [
    'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche', 'fantom'
  ];

  readonly supportedDestChains = this.supportedSourceChains;

  private providers: Map<string, ethers.Provider> = new Map();
  private pendingBridges: Map<string, PendingBridge> = new Map();

  // RACE-CONDITION-FIX: Mutex for thread-safe pendingBridges access
  private readonly bridgesMutex = new AsyncMutex();

  // Auto-cleanup timer
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(providers?: Map<string, ethers.Provider>) {
    if (providers) {
      this.providers = providers;
    }

    // Start periodic cleanup to prevent memory leaks
    this.startAutoCleanup();
  }

  /**
   * Start automatic cleanup of old pending bridges
   */
  private startAutoCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup(24 * 60 * 60 * 1000).catch(err => {
        logger.error('Auto-cleanup failed', { error: err instanceof Error ? err.message : String(err) });
      });
    }, CLEANUP_INTERVAL_MS);

    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Stop the router and cleanup resources
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Register a provider for a chain
   */
  registerProvider(chain: string, provider: ethers.Provider): void {
    this.providers.set(chain, provider);
  }

  /**
   * Get quote for Stargate bridge
   */
  async quote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const { sourceChain, destChain, token, amount, slippage = BRIDGE_DEFAULTS.slippage } = request;

    // Validate route
    if (!this.isRouteSupported(sourceChain, destChain, token)) {
      return {
        protocol: 'stargate',
        sourceChain,
        destChain,
        token,
        amountIn: amount,
        amountOut: '0',
        bridgeFee: '0',
        gasFee: '0',
        totalFee: '0',
        estimatedTimeSeconds: 0,
        expiresAt: Date.now(),
        valid: false,
        error: `Route not supported: ${sourceChain} -> ${destChain} for ${token}`,
      };
    }

    const provider = this.providers.get(sourceChain);
    if (!provider) {
      return {
        protocol: 'stargate',
        sourceChain,
        destChain,
        token,
        amountIn: amount,
        amountOut: '0',
        bridgeFee: '0',
        gasFee: '0',
        totalFee: '0',
        estimatedTimeSeconds: 0,
        expiresAt: Date.now(),
        valid: false,
        error: `No provider registered for chain: ${sourceChain}`,
      };
    }

    try {
      const routerAddress = STARGATE_ROUTER_ADDRESSES[sourceChain];
      const router = new ethers.Contract(routerAddress, STARGATE_ROUTER_ABI, provider);

      const dstChainId = STARGATE_CHAIN_IDS[destChain];
      const recipient = request.recipient || ethers.ZeroAddress;

      // Quote LayerZero fee
      const lzTxParams = {
        dstGasForCall: 0n,
        dstNativeAmount: 0n,
        dstNativeAddr: '0x',
      };

      const [nativeFee] = await router.quoteLayerZeroFee(
        dstChainId,
        1, // TYPE_SWAP_REMOTE
        ethers.solidityPacked(['address'], [recipient]),
        '0x',
        lzTxParams
      );

      // Calculate fees (Stargate typically charges 0.06% + gas)
      const amountBigInt = BigInt(amount);
      const bridgeFee = amountBigInt * 6n / 10000n; // 0.06%
      const gasFee = nativeFee;
      const totalFee = bridgeFee + gasFee;

      // Calculate output with slippage
      const amountAfterFee = amountBigInt - bridgeFee;
      const minAmountOut = amountAfterFee * BigInt(Math.floor((1 - slippage) * 10000)) / 10000n;

      const estimatedTime = this.getEstimatedTime(sourceChain, destChain);

      return {
        protocol: 'stargate',
        sourceChain,
        destChain,
        token,
        amountIn: amount,
        amountOut: minAmountOut.toString(),
        bridgeFee: bridgeFee.toString(),
        gasFee: gasFee.toString(),
        totalFee: totalFee.toString(),
        estimatedTimeSeconds: estimatedTime,
        expiresAt: Date.now() + BRIDGE_DEFAULTS.quoteValidityMs,
        valid: true,
      };
    } catch (error) {
      logger.error('Failed to get Stargate quote', {
        sourceChain,
        destChain,
        token,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        protocol: 'stargate',
        sourceChain,
        destChain,
        token,
        amountIn: amount,
        amountOut: '0',
        bridgeFee: '0',
        gasFee: '0',
        totalFee: '0',
        estimatedTimeSeconds: 0,
        expiresAt: Date.now(),
        valid: false,
        error: `Quote failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Execute Stargate bridge transaction
   *
   * BUG-FIX: Added ERC20 approval check before swap
   * RACE-CONDITION-FIX: Added mutex-protected pendingBridges storage
   */
  async execute(request: BridgeExecuteRequest): Promise<BridgeExecuteResult> {
    const { quote, wallet, nonce } = request;

    if (!quote.valid) {
      return {
        success: false,
        error: 'Invalid quote',
      };
    }

    // Check quote expiry
    if (Date.now() > quote.expiresAt) {
      return {
        success: false,
        error: 'Quote expired',
      };
    }

    const routerAddress = STARGATE_ROUTER_ADDRESSES[quote.sourceChain];
    if (!routerAddress) {
      return {
        success: false,
        error: `No router address for chain: ${quote.sourceChain}`,
      };
    }

    try {
      const router = new ethers.Contract(routerAddress, STARGATE_ROUTER_ABI, wallet);

      // Get pool IDs
      const srcPoolId = STARGATE_POOL_IDS[quote.token]?.[quote.sourceChain];
      const dstPoolId = STARGATE_POOL_IDS[quote.token]?.[quote.destChain];

      if (!srcPoolId || !dstPoolId) {
        return {
          success: false,
          error: `Pool ID not found for ${quote.token} on ${quote.sourceChain} or ${quote.destChain}`,
        };
      }

      // BUG-FIX: Check and request ERC20 approval if needed
      // (ETH doesn't need approval, only ERC20 tokens)
      if (quote.token !== 'ETH') {
        const tokenAddress = STARGATE_TOKEN_ADDRESSES[quote.token]?.[quote.sourceChain];
        if (tokenAddress) {
          const approved = await this.ensureApproval(
            wallet,
            tokenAddress,
            routerAddress,
            BigInt(quote.amountIn)
          );
          if (!approved) {
            return {
              success: false,
              error: `Failed to approve ${quote.token} for Stargate router`,
            };
          }
        }
      }

      const dstChainId = STARGATE_CHAIN_IDS[quote.destChain];
      const recipient = ethers.solidityPacked(['address'], [wallet.address]);

      // LZ transaction params
      const lzTxParams = {
        dstGasForCall: 0n,
        dstNativeAmount: 0n,
        dstNativeAddr: '0x',
      };

      // Calculate minimum amount with slippage
      const minAmountLD = BigInt(quote.amountOut);

      // Build transaction
      const txData = router.interface.encodeFunctionData('swap', [
        dstChainId,
        srcPoolId,
        dstPoolId,
        wallet.address, // refund address
        BigInt(quote.amountIn),
        minAmountLD,
        lzTxParams,
        recipient,
        '0x', // no payload
      ]);

      // Prepare transaction with proper gas
      const tx: ethers.TransactionRequest = {
        to: routerAddress,
        data: txData,
        value: BigInt(quote.gasFee), // LayerZero fee
      };

      // Set nonce if provided (from NonceManager)
      if (nonce !== undefined) {
        tx.nonce = nonce;
      }

      // Estimate gas
      const gasEstimate = await wallet.estimateGas(tx);
      tx.gasLimit = gasEstimate * 120n / 100n; // 20% buffer

      // Send transaction
      logger.info('Executing Stargate bridge', {
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
        token: quote.token,
        amountIn: quote.amountIn,
      });

      const txResponse = await wallet.sendTransaction(tx);
      const receipt = await txResponse.wait();

      if (!receipt) {
        return {
          success: false,
          error: 'Transaction receipt not received',
        };
      }

      // Generate bridge ID for tracking
      const bridgeId = `stargate-${receipt.hash}`;

      // RACE-CONDITION-FIX: Store pending bridge with mutex protection
      await this.bridgesMutex.runExclusive(async () => {
        // Enforce max pending bridges to prevent memory leak
        if (this.pendingBridges.size >= MAX_PENDING_BRIDGES) {
          // Remove oldest entry
          const oldestKey = this.pendingBridges.keys().next().value;
          if (oldestKey) {
            this.pendingBridges.delete(oldestKey);
          }
        }

        this.pendingBridges.set(bridgeId, {
          status: 'bridging',
          sourceTxHash: receipt.hash,
          sourceChain: quote.sourceChain,
          destChain: quote.destChain,
          startTime: Date.now(),
        });
      });

      logger.info('Stargate bridge initiated', {
        bridgeId,
        sourceTxHash: receipt.hash,
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
      });

      return {
        success: true,
        sourceTxHash: receipt.hash,
        bridgeId,
        gasUsed: receipt.gasUsed,
      };
    } catch (error) {
      logger.error('Stargate bridge execution failed', {
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get status of a bridge operation
   *
   * Note: Full status tracking would require LayerZero message tracking API.
   * This implementation uses heuristics based on time and destination chain monitoring.
   *
   * RACE-CONDITION-FIX: Uses mutex for thread-safe access
   */
  async getStatus(bridgeId: string): Promise<BridgeStatusResult> {
    return this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);

      if (!pending) {
        return {
          status: 'failed' as BridgeStatus,
          sourceTxHash: '',
          lastUpdated: Date.now(),
          error: 'Bridge not found',
        };
      }

      // Check if enough time has passed for completion
      const elapsedMs = Date.now() - pending.startTime;
      const estimatedTimeMs = this.getEstimatedTime(pending.sourceChain, pending.destChain) * 1000;

      if (pending.status === 'completed' || pending.status === 'failed') {
        return {
          status: pending.status,
          sourceTxHash: pending.sourceTxHash,
          destTxHash: pending.destTxHash,
          amountReceived: pending.amountReceived,
          lastUpdated: Date.now(),
          error: pending.error,
        };
      }

      // Still bridging - check if timeout
      if (elapsedMs > BRIDGE_DEFAULTS.maxBridgeWaitMs) {
        pending.status = 'failed';
        pending.error = 'Bridge timeout';

        return {
          status: 'failed' as BridgeStatus,
          sourceTxHash: pending.sourceTxHash,
          lastUpdated: Date.now(),
          error: 'Bridge timeout - transaction may still complete',
        };
      }

      // Estimate completion
      const estimatedCompletion = pending.startTime + estimatedTimeMs;

      return {
        status: 'bridging' as BridgeStatus,
        sourceTxHash: pending.sourceTxHash,
        lastUpdated: Date.now(),
        estimatedCompletion,
      };
    });
  }

  /**
   * Mark a bridge as completed (called externally when destination tx is detected)
   *
   * RACE-CONDITION-FIX: Uses mutex for thread-safe access
   */
  async markCompleted(bridgeId: string, destTxHash: string, amountReceived: string): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);
      if (pending) {
        pending.status = 'completed';
        pending.destTxHash = destTxHash;
        pending.amountReceived = amountReceived;

        logger.info('Bridge completed', {
          bridgeId,
          destTxHash,
          amountReceived,
        });
      }
    });
  }

  /**
   * Mark a bridge as failed
   *
   * RACE-CONDITION-FIX: Uses mutex for thread-safe access
   */
  async markFailed(bridgeId: string, error: string): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);
      if (pending) {
        pending.status = 'failed';
        pending.error = error;

        logger.warn('Bridge failed', {
          bridgeId,
          error,
        });
      }
    });
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Ensure ERC20 token approval for Stargate router
   *
   * BUG-FIX: Checks current allowance and only approves if needed
   */
  private async ensureApproval(
    wallet: ethers.Wallet,
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint
  ): Promise<boolean> {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

      // Check current allowance
      const currentAllowance = await token.allowance(wallet.address, spenderAddress);

      if (currentAllowance >= amount) {
        logger.debug('Sufficient allowance already exists', {
          token: tokenAddress,
          spender: spenderAddress,
          allowance: currentAllowance.toString(),
          required: amount.toString(),
        });
        return true;
      }

      // Approve max uint256 to avoid repeated approvals
      logger.info('Approving token for Stargate router', {
        token: tokenAddress,
        spender: spenderAddress,
      });

      const approveTx = await token.approve(spenderAddress, ethers.MaxUint256);
      const receipt = await approveTx.wait();

      if (!receipt || receipt.status !== 1) {
        logger.error('Token approval failed', { token: tokenAddress });
        return false;
      }

      logger.info('Token approval successful', {
        token: tokenAddress,
        txHash: receipt.hash,
      });

      return true;
    } catch (error) {
      logger.error('Token approval error', {
        token: tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if a route is supported
   */
  isRouteSupported(sourceChain: string, destChain: string, token: string): boolean {
    // Same chain not supported
    if (sourceChain === destChain) {
      return false;
    }

    // Check chains are supported
    if (!this.supportedSourceChains.includes(sourceChain) ||
        !this.supportedDestChains.includes(destChain)) {
      return false;
    }

    // Check token has pool IDs on both chains
    const tokenPools = STARGATE_POOL_IDS[token];
    if (!tokenPools) {
      return false;
    }

    return !!tokenPools[sourceChain] && !!tokenPools[destChain];
  }

  /**
   * Get estimated bridge time for a route
   */
  getEstimatedTime(sourceChain: string, destChain: string): number {
    const routeKey = `${sourceChain}-${destChain}`;
    return BRIDGE_TIMES[routeKey] ?? BRIDGE_TIMES.default;
  }

  /**
   * Health check for Stargate
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    // Check if we have at least one provider
    if (this.providers.size === 0) {
      return {
        healthy: false,
        message: 'No providers registered',
      };
    }

    // Try to get a quote as health check
    try {
      const testChain = this.supportedSourceChains.find(c => this.providers.has(c));
      if (!testChain) {
        return {
          healthy: false,
          message: 'No providers available for supported chains',
        };
      }

      // Find another chain to test with
      const destChain = this.supportedDestChains.find(c => c !== testChain);
      if (!destChain) {
        return {
          healthy: true,
          message: 'Stargate router operational (single chain only)',
        };
      }

      const provider = this.providers.get(testChain)!;
      await provider.getBlockNumber();

      return {
        healthy: true,
        message: `Stargate router operational. ${this.providers.size} chains connected.`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Cleanup old pending bridges
   *
   * RACE-CONDITION-FIX: Now async with mutex protection
   */
  async cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const cutoff = Date.now() - maxAgeMs;
      let cleanedCount = 0;

      for (const [bridgeId, bridge] of this.pendingBridges.entries()) {
        if (bridge.startTime < cutoff) {
          this.pendingBridges.delete(bridgeId);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.debug('Cleaned up old bridge entries', {
          cleanedCount,
          remaining: this.pendingBridges.size,
        });
      }
    });
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Stargate router instance
 */
export function createStargateRouter(
  providers?: Map<string, ethers.Provider>
): StargateRouter {
  return new StargateRouter(providers);
}
