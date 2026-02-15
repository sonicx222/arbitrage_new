/**
 * Across Bridge Router
 *
 * Phase 2: Cross-Chain Execution via Across Protocol
 *
 * Implements cross-chain token transfers using Across Protocol (SpokePool).
 * Across provides:
 * - Fast relayer-based bridging (60-120s for L2-to-L2)
 * - Higher reliability (0.97) than Stargate V1 (0.95)
 * - Support for zkSync and Linea (not available via Stargate V1)
 * - Lower fees on L2-to-L2 routes (3 bps vs 4-6 bps)
 *
 * Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, zkSync, Linea
 *
 * @see https://docs.across.to/
 * @see shared/config/src/bridge-config.ts for route cost data
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
} from './types';
import { createLogger } from '../logger';
import { clearIntervalSafe } from '../lifecycle-utils';
import { AsyncMutex } from '../async/async-mutex';

const logger = createLogger('across-router');

/** Timeout for on-chain transaction confirmations (2 minutes) */
const TX_WAIT_TIMEOUT_MS = 120_000;

/** Basis points denominator for fee/slippage calculations */
const BPS_DENOMINATOR = 10000n;
/** Gas estimation buffer: 20% above estimate */
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;

/** Default fill deadline for Across deposits (5 hours from now) */
const FILL_DEADLINE_SECONDS = 18000;

// =============================================================================
// Across SpokePool ABI (minimal required functions)
// =============================================================================

const ACROSS_SPOKEPOOL_ABI = [
  // depositV3 - main bridge function
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) external payable',

  // Events
  'event V3FundsDeposited(address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint32 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, address indexed depositor, address recipient, address exclusiveRelayer, bytes message)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

// =============================================================================
// Across Protocol Constants
// =============================================================================

/**
 * Across SpokePool contract addresses per chain.
 * These are the v3 SpokePool contracts.
 *
 * Note: Addresses should be verified against Across Protocol documentation
 * for the latest deployments. Consider moving to config-driven approach
 * for easier updates without code changes.
 *
 * @see https://docs.across.to/reference/contract-addresses
 */
export const ACROSS_SPOKEPOOL_ADDRESSES: Record<string, string> = {
  ethereum: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
  arbitrum: '0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A',
  optimism: '0x6f26Bf09B1C792e3228e5467807a900A503c0281',
  base: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
  polygon: '0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096',
  zksync: '0xE0B015E54d54fc84a6cB9B666099c46adE3335C5',
  linea: '0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75',
};

/**
 * Standard EVM chain IDs used by Across Protocol.
 * Unlike Stargate which uses LayerZero-specific IDs, Across uses standard chain IDs.
 */
export const ACROSS_CHAIN_IDS: Record<string, number> = {
  ethereum: 1,
  arbitrum: 42161,
  optimism: 10,
  base: 8453,
  polygon: 137,
  zksync: 324,
  linea: 59144,
};

/**
 * Token addresses per chain for Across bridging.
 * Across supports USDC, USDT, and WETH on most chains.
 * WETH is used for native ETH bridging (SpokePool wraps/unwraps automatically).
 */
const ACROSS_TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
  USDC: {
    ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
    optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
    base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    zksync: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
    linea: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  },
  USDT: {
    ethereum: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    arbitrum: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    optimism: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
    polygon: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  },
  WETH: {
    ethereum: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    arbitrum: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    optimism: '0x4200000000000000000000000000000000000006',
    base: '0x4200000000000000000000000000000000000006',
    polygon: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
    zksync: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    linea: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
  },
};

/**
 * Per-route fee in basis points for Across Protocol.
 * Sourced from bridge-config.ts route data.
 *
 * @see shared/config/src/bridge-config.ts BRIDGE_ROUTE_DATA Across section
 */
const ACROSS_FEE_BPS: Record<string, bigint> = {
  'ethereum-arbitrum': 4n,
  'ethereum-optimism': 4n,
  'ethereum-polygon': 4n,
  'ethereum-base': 4n,
  'ethereum-zksync': 5n,
  'ethereum-linea': 4n,
  'arbitrum-ethereum': 4n,
  'arbitrum-optimism': 3n,
  'optimism-arbitrum': 3n,
  'base-arbitrum': 3n,
  'zksync-ethereum': 5n,
  'linea-ethereum': 4n,
  default: 4n,
};

/**
 * Average bridge times in seconds for Across Protocol routes.
 * Across uses a relayer model which is faster than messaging-based bridges.
 *
 * @see shared/config/src/bridge-config.ts for consistent latency data
 */
export const ACROSS_BRIDGE_TIMES: Record<string, number> = {
  'ethereum-arbitrum': 120,    // ~2 minutes (relayer fill)
  'ethereum-optimism': 120,    // ~2 minutes
  'ethereum-polygon': 120,     // ~2 minutes
  'ethereum-base': 120,        // ~2 minutes
  'ethereum-zksync': 180,      // ~3 minutes (zkSync verification)
  'ethereum-linea': 120,       // ~2 minutes
  'arbitrum-ethereum': 120,    // ~2 minutes (relayer, not 7-day withdrawal)
  'arbitrum-optimism': 60,     // ~1 minute (L2-to-L2 fast)
  'optimism-arbitrum': 60,     // ~1 minute (L2-to-L2 fast)
  'base-arbitrum': 60,         // ~1 minute (L2-to-L2 fast)
  'zksync-ethereum': 180,      // ~3 minutes
  'linea-ethereum': 120,       // ~2 minutes
  default: 120,                // 2 minutes default
};

// =============================================================================
// Across Router Implementation
// =============================================================================

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
  /** Reason for failure - enables recovery from timeout-failed bridges */
  failReason?: 'timeout' | 'execution_error' | 'unknown';
}

/**
 * Maximum pending bridges to track (prevents memory leak)
 */
const MAX_PENDING_BRIDGES = 1000;

/**
 * Auto-cleanup interval for old bridges (1 hour)
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Across bridge router for cross-chain token transfers via SpokePool contracts.
 *
 * Key differences from StargateRouter:
 * - Uses SpokePool.depositV3() instead of Router.swap()
 * - No on-chain quote function; fees calculated from route config
 * - Uses standard EVM chain IDs, not LayerZero chain IDs
 * - Supports zkSync and Linea
 * - WETH bridging uses msg.value (SpokePool wraps ETH internally)
 */
export class AcrossRouter implements IBridgeRouter {
  readonly protocol: BridgeProtocol = 'across';

  readonly supportedSourceChains = [
    'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'zksync', 'linea'
  ];

  readonly supportedDestChains = this.supportedSourceChains;

  private providers: Map<string, ethers.Provider> = new Map();
  private pendingBridges: Map<string, PendingBridge> = new Map();
  private approvalMutexes: Map<string, AsyncMutex> = new Map();

  // Mutex for thread-safe pendingBridges access
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
    this.cleanupTimer = clearIntervalSafe(this.cleanupTimer);
    this.approvalMutexes.clear();
  }

  /**
   * Race a promise against a timeout, ensuring the timer is always cleaned up
   */
  private async waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Get or create a per-token approval mutex to prevent concurrent approval races
   */
  private getApprovalMutex(tokenAddress: string): AsyncMutex {
    let mutex = this.approvalMutexes.get(tokenAddress);
    if (!mutex) {
      mutex = new AsyncMutex();
      this.approvalMutexes.set(tokenAddress, mutex);
    }
    return mutex;
  }

  /**
   * Register a provider for a chain
   */
  registerProvider(chain: string, provider: ethers.Provider): void {
    this.providers.set(chain, provider);
  }

  /**
   * Get quote for Across bridge.
   *
   * Unlike Stargate, Across doesn't have an on-chain quote function.
   * Fees are calculated from per-route configuration data.
   * In production, the Across Suggested Fee API should be used for dynamic fees.
   */
  async quote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const { sourceChain, destChain, token, amount, slippage = BRIDGE_DEFAULTS.slippage } = request;

    // Validate route
    if (!this.isRouteSupported(sourceChain, destChain, token)) {
      return this.createInvalidQuote(sourceChain, destChain, token, amount,
        `Route not supported: ${sourceChain} -> ${destChain} for ${token}`);
    }

    const provider = this.providers.get(sourceChain);
    if (!provider) {
      return this.createInvalidQuote(sourceChain, destChain, token, amount,
        `No provider registered for chain: ${sourceChain}`);
    }

    try {
      // Calculate fees from route config
      const routeKey = `${sourceChain}-${destChain}`;
      const feeBps = ACROSS_FEE_BPS[routeKey] ?? ACROSS_FEE_BPS.default;

      const amountBigInt = BigInt(amount);
      const bridgeFee = amountBigInt * feeBps / BPS_DENOMINATOR;

      // Across has no separate protocol gas fee (relayer fee is included in bridgeFee)
      const gasFee = 0n;
      const totalFee = gasFee;

      // Calculate output with slippage
      const amountAfterFee = amountBigInt - bridgeFee;
      const minAmountOut = amountAfterFee * BigInt(Math.floor((1 - slippage) * Number(BPS_DENOMINATOR))) / BPS_DENOMINATOR;

      const estimatedTime = this.getEstimatedTime(sourceChain, destChain);

      return {
        protocol: 'across',
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
        recipient: request.recipient || undefined,
      };
    } catch (error) {
      logger.error('Failed to get Across quote', {
        sourceChain,
        destChain,
        token,
        error: error instanceof Error ? error.message : String(error),
      });

      return this.createInvalidQuote(sourceChain, destChain, token, amount,
        `Quote failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Execute Across bridge transaction via SpokePool.depositV3().
   *
   * For WETH bridging, sends native ETH as msg.value (SpokePool wraps internally).
   * For ERC20 tokens, requires approval to SpokePool first.
   */
  async execute(request: BridgeExecuteRequest): Promise<BridgeExecuteResult> {
    const { quote, wallet, nonce } = request;

    if (!quote.valid) {
      return { success: false, error: 'Invalid quote' };
    }

    if (Date.now() > quote.expiresAt) {
      return { success: false, error: 'Quote expired' };
    }

    const spokePoolAddress = ACROSS_SPOKEPOOL_ADDRESSES[quote.sourceChain];
    if (!spokePoolAddress) {
      return { success: false, error: `No SpokePool address for chain: ${quote.sourceChain}` };
    }

    try {
      const spokePool = new ethers.Contract(spokePoolAddress, ACROSS_SPOKEPOOL_ABI, wallet);

      // Get token addresses
      const inputTokenAddress = ACROSS_TOKEN_ADDRESSES[quote.token]?.[quote.sourceChain];
      const outputTokenAddress = ACROSS_TOKEN_ADDRESSES[quote.token]?.[quote.destChain];

      if (!inputTokenAddress || !outputTokenAddress) {
        return {
          success: false,
          error: `Token address not configured for ${quote.token} on ${quote.sourceChain} or ${quote.destChain}`,
        };
      }

      // Pre-flight balance check
      const provider = request.provider;
      if (quote.token === 'WETH') {
        const balance = await provider.getBalance(wallet.address);
        if (balance < BigInt(quote.amountIn)) {
          return { success: false, error: `Insufficient ETH balance: have ${balance}, need ${quote.amountIn}` };
        }
      } else {
        const tokenContract = new ethers.Contract(inputTokenAddress, ERC20_ABI, provider);
        const tokenBalance = await tokenContract.balanceOf(wallet.address);
        if (BigInt(tokenBalance) < BigInt(quote.amountIn)) {
          return { success: false, error: `Insufficient ${quote.token} balance` };
        }
      }

      // ERC20 approval (skip for WETH which uses native ETH via msg.value)
      if (quote.token !== 'WETH') {
        const approvalMutex = this.getApprovalMutex(inputTokenAddress);
        const approved = await approvalMutex.runExclusive(async () => {
          return this.ensureApproval(
            wallet,
            inputTokenAddress,
            spokePoolAddress,
            BigInt(quote.amountIn)
          );
        });
        if (!approved) {
          return {
            success: false,
            error: `Failed to approve ${quote.token} for Across SpokePool`,
          };
        }
      }

      // Build depositV3 parameters
      const destChainId = ACROSS_CHAIN_IDS[quote.destChain];
      const recipientAddress = quote.recipient || wallet.address;
      const quoteTimestamp = Math.floor(Date.now() / 1000);
      const fillDeadline = quoteTimestamp + FILL_DEADLINE_SECONDS;

      const txData = spokePool.interface.encodeFunctionData('depositV3', [
        wallet.address,           // depositor
        recipientAddress,         // recipient
        inputTokenAddress,        // inputToken
        outputTokenAddress,       // outputToken
        BigInt(quote.amountIn),   // inputAmount
        BigInt(quote.amountOut),  // outputAmount (inputAmount - relayerFee)
        destChainId,              // destinationChainId
        ethers.ZeroAddress,       // exclusiveRelayer (0x0 = open to all relayers)
        quoteTimestamp,           // quoteTimestamp
        fillDeadline,             // fillDeadline
        0,                        // exclusivityDeadline (no exclusivity)
        '0x',                     // message (empty for simple transfers)
      ]);

      // For WETH bridging: msg.value = inputAmount (SpokePool wraps ETH internally)
      // For ERC20: msg.value = 0
      const tx: ethers.TransactionRequest = {
        to: spokePoolAddress,
        data: txData,
        value: quote.token === 'WETH' ? BigInt(quote.amountIn) : 0n,
      };

      if (nonce !== undefined) {
        tx.nonce = nonce;
      }

      // Estimate gas with buffer
      const gasEstimate = await wallet.estimateGas(tx);
      tx.gasLimit = gasEstimate * GAS_BUFFER_NUMERATOR / GAS_BUFFER_DENOMINATOR;

      logger.info('Executing Across bridge', {
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
        token: quote.token,
        amountIn: quote.amountIn,
      });

      const txResponse = await wallet.sendTransaction(tx);
      const receipt = await this.waitWithTimeout(
        txResponse.wait(),
        TX_WAIT_TIMEOUT_MS,
        'Bridge transaction confirmation'
      );

      if (!receipt) {
        return { success: false, error: 'Transaction receipt not received' };
      }

      // Generate bridge ID for tracking
      const bridgeId = `across-${receipt.hash}`;

      // Store pending bridge with mutex protection
      await this.bridgesMutex.runExclusive(async () => {
        // Enforce max pending bridges to prevent memory leak
        if (this.pendingBridges.size >= MAX_PENDING_BRIDGES) {
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

      logger.info('Across bridge initiated', {
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
      logger.error('Across bridge execution failed', {
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
   * Get status of a bridge operation.
   *
   * Uses mutex for thread-safe access.
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

      // Check if timeout
      if (elapsedMs > BRIDGE_DEFAULTS.maxBridgeWaitMs) {
        pending.status = 'failed';
        pending.error = 'Bridge timeout';
        pending.failReason = 'timeout';

        return {
          status: 'failed' as BridgeStatus,
          sourceTxHash: pending.sourceTxHash,
          lastUpdated: Date.now(),
          error: 'Bridge timeout - relayer may still fill the deposit',
        };
      }

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
   * Mark a bridge as completed.
   *
   * Only transitions from 'bridging' to 'completed', with timeout recovery.
   */
  async markCompleted(bridgeId: string, destTxHash: string, amountReceived: string): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);
      if (!pending) {
        logger.warn('Cannot mark completed: bridge not found', { bridgeId });
        return;
      }

      if (pending.status !== 'bridging') {
        if (pending.status === 'failed' && pending.failReason === 'timeout') {
          logger.info('Recovering timeout-failed bridge', { bridgeId });
          // Fall through to complete
        } else {
          logger.warn('Cannot mark completed: invalid state transition', {
            bridgeId,
            currentStatus: pending.status,
            attemptedStatus: 'completed',
          });
          return;
        }
      }

      pending.status = 'completed';
      pending.destTxHash = destTxHash;
      pending.amountReceived = amountReceived;

      logger.info('Bridge completed', { bridgeId, destTxHash, amountReceived });
    });
  }

  /**
   * Mark a bridge as failed.
   *
   * Only transitions from 'bridging' to 'failed'.
   */
  async markFailed(bridgeId: string, error: string): Promise<void> {
    await this.bridgesMutex.runExclusive(async () => {
      const pending = this.pendingBridges.get(bridgeId);
      if (!pending) {
        logger.warn('Cannot mark failed: bridge not found', { bridgeId });
        return;
      }

      if (pending.status !== 'bridging') {
        logger.warn('Cannot mark failed: invalid state transition', {
          bridgeId,
          currentStatus: pending.status,
          attemptedStatus: 'failed',
        });
        return;
      }

      pending.status = 'failed';
      pending.error = error;
      pending.failReason = 'execution_error';

      logger.warn('Bridge failed', { bridgeId, error });
    });
  }

  // ===========================================================================
  // Private Helpers
  // ===========================================================================

  /**
   * Create an invalid quote response for error cases.
   */
  private createInvalidQuote(
    sourceChain: string, destChain: string, token: string, amount: string, error: string
  ): BridgeQuote {
    return {
      protocol: this.protocol,
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
      error,
    };
  }

  /**
   * Ensure ERC20 token approval for Across SpokePool.
   * Uses forceApprove pattern for USDT compatibility.
   */
  private async ensureApproval(
    wallet: ethers.Wallet,
    tokenAddress: string,
    spenderAddress: string,
    amount: bigint
  ): Promise<boolean> {
    try {
      const token = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
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

      // USDT forceApprove pattern: reset to 0 first if non-zero
      logger.info('Approving token for Across SpokePool', {
        token: tokenAddress,
        spender: spenderAddress,
        currentAllowance: currentAllowance.toString(),
        requiredAmount: amount.toString(),
      });

      if (currentAllowance > 0n) {
        const resetTx = await token.approve(spenderAddress, 0n);
        await this.waitWithTimeout<ethers.TransactionReceipt | null>(
          resetTx.wait(), TX_WAIT_TIMEOUT_MS, 'Approval reset confirmation'
        );
      }

      const approveTx = await token.approve(spenderAddress, amount);
      const receipt = await this.waitWithTimeout(
        approveTx.wait(), TX_WAIT_TIMEOUT_MS, 'Approval confirmation'
      ) as ethers.TransactionReceipt | null;

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
   * Check if a route is supported.
   * Validates chain support and token availability on both chains.
   */
  isRouteSupported(sourceChain: string, destChain: string, token: string): boolean {
    if (sourceChain === destChain) {
      return false;
    }

    if (!this.supportedSourceChains.includes(sourceChain) ||
        !this.supportedDestChains.includes(destChain)) {
      return false;
    }

    // Check token has addresses on both chains
    const tokenAddresses = ACROSS_TOKEN_ADDRESSES[token];
    if (!tokenAddresses) {
      return false;
    }

    return !!tokenAddresses[sourceChain] && !!tokenAddresses[destChain];
  }

  /**
   * Get estimated bridge time for a route
   */
  getEstimatedTime(sourceChain: string, destChain: string): number {
    const routeKey = `${sourceChain}-${destChain}`;
    return ACROSS_BRIDGE_TIMES[routeKey] ?? ACROSS_BRIDGE_TIMES.default;
  }

  /**
   * Health check for Across Protocol.
   * Validates provider connectivity.
   */
  async healthCheck(): Promise<{ healthy: boolean; message: string }> {
    if (this.providers.size === 0) {
      return { healthy: false, message: 'No providers registered' };
    }

    try {
      const testChain = this.supportedSourceChains.find(c => this.providers.has(c));
      if (!testChain) {
        return { healthy: false, message: 'No providers available for supported chains' };
      }

      const destChain = this.supportedDestChains.find(c => c !== testChain);
      if (!destChain) {
        return { healthy: true, message: 'Across router operational (single chain only)' };
      }

      const provider = this.providers.get(testChain)!;
      await provider.getBlockNumber();

      return {
        healthy: true,
        message: `Across router operational. ${this.providers.size} chains connected.`,
      };
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Cleanup old pending bridges.
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
 * Create an Across router instance
 */
export function createAcrossRouter(
  providers?: Map<string, ethers.Provider>
): AcrossRouter {
  return new AcrossRouter(providers);
}
