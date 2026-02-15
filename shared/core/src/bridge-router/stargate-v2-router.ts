/**
 * Stargate V2 Bridge Router
 *
 * Phase 3: Cross-Chain Execution via Stargate V2 (LayerZero V2)
 *
 * Implements cross-chain token transfers using Stargate V2's OFT model.
 * Key differences from V1:
 * - Per-token StargatePool contracts (not a single Router)
 * - quoteSend() / send() ABI (not quoteLayerZeroFee / swap)
 * - V2 LayerZero endpoint IDs (30xxx series)
 * - Bus (batched, cheaper) and Taxi (immediate) transfer modes
 * - Dynamic fees (typically lower than V1's fixed 0.06%)
 * - No pool IDs needed (addressed by per-token contracts)
 *
 * Supported chains: Ethereum, Arbitrum, Optimism, Base, Polygon, BSC, Avalanche
 *
 * @see https://stargateprotocol.gitbook.io/stargate/v2/
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

const logger = createLogger('stargate-v2-router');

/** Timeout for on-chain transaction confirmations (2 minutes) */
const TX_WAIT_TIMEOUT_MS = 120_000;

/** Basis points denominator for slippage calculations */
const BPS_DENOMINATOR = 10000n;
/** Gas estimation buffer: 20% above estimate */
const GAS_BUFFER_NUMERATOR = 120n;
const GAS_BUFFER_DENOMINATOR = 100n;

// =============================================================================
// Stargate V2 Pool ABI (OFT standard)
// =============================================================================

/**
 * Stargate V2 uses per-token pool contracts following the OFT (Omnichain Fungible Token) standard.
 * Each pool supports quoteSend() for fee estimation and send() for execution.
 */
const STARGATE_V2_POOL_ABI = [
  // quoteSend - fee estimation
  'function quoteSend(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, bool _payInLzToken) external view returns (tuple(uint256 nativeFee, uint256 lzTokenFee), tuple(uint256 amountSentLD, uint256 amountReceivedLD))',

  // send - execute bridge transfer
  'function send(tuple(uint32 dstEid, bytes32 to, uint256 amountLD, uint256 minAmountLD, bytes extraOptions, bytes composeMsg, bytes oftCmd) _sendParam, tuple(uint256 nativeFee, uint256 lzTokenFee) _fee, address _refundAddress) external payable returns (tuple(bytes32 guid, uint64 nonce, tuple(uint256 nativeFee, uint256 lzTokenFee) fee), tuple(uint256 amountSentLD, uint256 amountReceivedLD))',

  // Events
  'event OFTSent(bytes32 indexed guid, uint32 dstEid, address indexed fromAddress, uint256 amountSentLD, uint256 amountReceivedLD)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
];

// =============================================================================
// Stargate V2 Constants
// =============================================================================

/**
 * Stargate V2 pool contract addresses per token per chain.
 * V2 uses per-token contracts (OFT model) instead of V1's single Router.
 *
 * Note: Addresses should be verified against Stargate V2 deployment records.
 * Consider moving to config-driven approach for easier updates without code changes.
 *
 * @see https://stargateprotocol.gitbook.io/stargate/v2/deployments
 */
export const STARGATE_V2_POOL_ADDRESSES: Record<string, Record<string, string>> = {
  USDC: {
    ethereum: '0xc026395860Db2d07ee33e05fE50ed7bD583189C7',
    arbitrum: '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3',
    optimism: '0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0',
    base: '0x27a16dc786820B16E5c9028b75B99F6f604b5d26',
    polygon: '0x9Aa02D4Fae7F58b8E8f34c66E756cC734DAc7fe4',
    bsc: '0x962Bd449E630b0d928f308Ce63f1A21F02576057',
    avalanche: '0x5634c4a5FEd09819E3c46D86A965Dd9447d86e47',
  },
  USDT: {
    ethereum: '0x933597a323Eb81cAe705C5bC29985172fd5A3973',
    arbitrum: '0xcE8CcA271Ebc0533920C83d39F417ED6A0abB7D0',
    optimism: '0x19cFCE47eD54a88614648DC3f19A5980097007dD',
    polygon: '0xd47b03ee6d86Cf251ee7860FB2ACf9f91B9fD4d7',
    bsc: '0x138EB30f73BC423c6455C53df6D89CB01898b999',
    avalanche: '0x12dC9256Acc9895B076f6638D628382881e62CeE',
  },
  ETH: {
    ethereum: '0x77b2043768d28E9C9aB44E1aBfC95944bcE57931',
    arbitrum: '0xA45B5130f36CDcA45667738e2a258AB09f4A27d7',
    optimism: '0xe8CDF27AcD73a434D661C84887215F7598e7d0d3',
    base: '0xdc181Bd607330aeeBEF6ea62e03e5e1Fb4B6F7C4',
  },
};

/**
 * V2 LayerZero endpoint IDs.
 * V2 uses 30000 + V1 chain ID pattern.
 */
export const STARGATE_V2_ENDPOINT_IDS: Record<string, number> = {
  ethereum: 30101,
  bsc: 30102,
  avalanche: 30106,
  polygon: 30109,
  arbitrum: 30110,
  optimism: 30111,
  base: 30184,
};

/**
 * Token addresses per chain for V2 bridging.
 * Reuses same ERC20 addresses as V1 (token addresses are protocol-independent).
 */
const STARGATE_V2_TOKEN_ADDRESSES: Record<string, Record<string, string>> = {
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
  },
};

/**
 * Average bridge times in seconds for Stargate V2 routes.
 * V2 uses optimized LZ V2 messaging, generally faster than V1.
 *
 * @see shared/config/src/bridge-config.ts for consistent latency data
 */
export const STARGATE_V2_BRIDGE_TIMES: Record<string, number> = {
  'ethereum-arbitrum': 120,    // ~2 minutes (LZ V2 optimized)
  'ethereum-optimism': 120,    // ~2 minutes
  'ethereum-base': 120,        // ~2 minutes
  'ethereum-polygon': 120,     // ~2 minutes
  'ethereum-bsc': 120,         // ~2 minutes
  'ethereum-avalanche': 120,   // ~2 minutes
  'arbitrum-ethereum': 120,    // ~2 minutes
  'arbitrum-optimism': 60,     // ~1 minute (L2-to-L2)
  'arbitrum-base': 60,         // ~1 minute (L2-to-L2)
  'optimism-ethereum': 120,    // ~2 minutes
  'optimism-arbitrum': 60,     // ~1 minute (L2-to-L2)
  'base-ethereum': 120,        // ~2 minutes
  'base-arbitrum': 60,         // ~1 minute (L2-to-L2)
  default: 120,                // 2 minutes default
};

// =============================================================================
// Stargate V2 Router Implementation
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
 * Stargate V2 bridge router using OFT (Omnichain Fungible Token) model.
 *
 * Key differences from StargateRouter (V1):
 * - Uses per-token StargatePool contracts instead of a single Router
 * - Calls quoteSend()/send() instead of quoteLayerZeroFee()/swap()
 * - Uses V2 LZ endpoint IDs (30xxx) instead of V1 chain IDs (1xx)
 * - Supports Bus (batched) and Taxi (immediate) transfer modes
 * - Dynamic fees through OFT model (typically 3-4 bps vs V1's fixed 6 bps)
 */
export class StargateV2Router implements IBridgeRouter {
  readonly protocol: BridgeProtocol = 'stargate-v2';

  readonly supportedSourceChains = [
    'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche'
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
   * Encode a recipient address to bytes32 (left-padded with zeros).
   * Required by the OFT SendParam struct.
   */
  private addressToBytes32(address: string): string {
    return ethers.zeroPadValue(address, 32);
  }

  /**
   * Get the OFT command bytes for transfer mode selection.
   * - Taxi (immediate): 0x01 - sends via dedicated LZ message
   * - Bus (batched): 0x - batched for cost efficiency, adds latency
   */
  private getOftCmd(mode: 'bus' | 'taxi'): string {
    return mode === 'taxi' ? '0x01' : '0x';
  }

  /**
   * Get quote for Stargate V2 bridge via quoteSend().
   *
   * Calls the per-token pool contract's quoteSend() to get accurate V2 fees.
   * Uses the OFT model where protocol fees are deducted from the transfer amount.
   */
  async quote(request: BridgeQuoteRequest): Promise<BridgeQuote> {
    const {
      sourceChain, destChain, token, amount,
      slippage = BRIDGE_DEFAULTS.slippage,
      transferMode = 'taxi',
    } = request;

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
      const poolAddress = STARGATE_V2_POOL_ADDRESSES[token]?.[sourceChain];
      const pool = new ethers.Contract(poolAddress, STARGATE_V2_POOL_ABI, provider);

      const dstEid = STARGATE_V2_ENDPOINT_IDS[destChain];
      const recipientAddress = request.recipient || ethers.ZeroAddress;
      const amountBigInt = BigInt(amount);

      // Build SendParam struct
      const sendParam = {
        dstEid,
        to: this.addressToBytes32(recipientAddress),
        amountLD: amountBigInt,
        minAmountLD: 0n, // Will be set after getting quote
        extraOptions: '0x',
        composeMsg: '0x',
        oftCmd: this.getOftCmd(transferMode),
      };

      // Call quoteSend to get fees and expected output
      const [messagingFee, oftReceipt] = await pool.quoteSend(sendParam, false);

      const nativeFee: bigint = messagingFee.nativeFee;
      const amountSentLD: bigint = oftReceipt.amountSentLD;
      const amountReceivedLD: bigint = oftReceipt.amountReceivedLD;

      // bridgeFee = protocol fee deducted by OFT model
      const bridgeFee = amountSentLD - amountReceivedLD;
      // gasFee = LZ V2 messaging fee (paid in native token)
      const gasFee = nativeFee;
      // totalFee = native gas cost only (bridgeFee is already deducted from amountOut)
      const totalFee = gasFee;

      // Apply slippage to received amount
      const minAmountOut = amountReceivedLD * BigInt(Math.floor((1 - slippage) * Number(BPS_DENOMINATOR))) / BPS_DENOMINATOR;

      const estimatedTime = this.getEstimatedTime(sourceChain, destChain);

      return {
        protocol: 'stargate-v2',
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
      logger.error('Failed to get Stargate V2 quote', {
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
   * Execute Stargate V2 bridge transaction via pool.send().
   *
   * For ETH bridging, sends native ETH as msg.value (pool wraps internally).
   * For ERC20 tokens, requires approval to the pool contract first.
   */
  async execute(request: BridgeExecuteRequest): Promise<BridgeExecuteResult> {
    const { quote, wallet, nonce } = request;

    if (!quote.valid) {
      return { success: false, error: 'Invalid quote' };
    }

    if (Date.now() > quote.expiresAt) {
      return { success: false, error: 'Quote expired' };
    }

    const poolAddress = STARGATE_V2_POOL_ADDRESSES[quote.token]?.[quote.sourceChain];
    if (!poolAddress) {
      return { success: false, error: `No V2 pool address for ${quote.token} on ${quote.sourceChain}` };
    }

    try {
      const pool = new ethers.Contract(poolAddress, STARGATE_V2_POOL_ABI, wallet);

      // Pre-flight balance check to fail fast
      const provider = request.provider;
      if (quote.token === 'ETH') {
        const balance = await provider.getBalance(wallet.address);
        const required = BigInt(quote.amountIn) + BigInt(quote.gasFee);
        if (balance < required) {
          return { success: false, error: `Insufficient ETH balance: have ${balance}, need ${required}` };
        }
      } else {
        const tokenAddress = STARGATE_V2_TOKEN_ADDRESSES[quote.token]?.[quote.sourceChain];
        if (tokenAddress) {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
          const tokenBalance = await tokenContract.balanceOf(wallet.address);
          if (BigInt(tokenBalance) < BigInt(quote.amountIn)) {
            return { success: false, error: `Insufficient ${quote.token} balance` };
          }
          // Also check native balance for LZ messaging fee
          const nativeBalance = await provider.getBalance(wallet.address);
          if (nativeBalance < BigInt(quote.gasFee)) {
            return { success: false, error: 'Insufficient native balance for LZ fee' };
          }
        }
      }

      // ERC20 approval to pool contract (skip for ETH)
      if (quote.token !== 'ETH') {
        const tokenAddress = STARGATE_V2_TOKEN_ADDRESSES[quote.token]?.[quote.sourceChain];
        if (!tokenAddress) {
          return {
            success: false,
            error: `Token address not configured for ${quote.token} on ${quote.sourceChain}`,
          };
        }
        const approvalMutex = this.getApprovalMutex(tokenAddress);
        const approved = await approvalMutex.runExclusive(async () => {
          return this.ensureApproval(
            wallet,
            tokenAddress,
            poolAddress,
            BigInt(quote.amountIn)
          );
        });
        if (!approved) {
          return {
            success: false,
            error: `Failed to approve ${quote.token} for Stargate V2 pool`,
          };
        }
      }

      // Build SendParam for send()
      const dstEid = STARGATE_V2_ENDPOINT_IDS[quote.destChain];
      const recipientAddress = quote.recipient || wallet.address;

      const sendParam = {
        dstEid,
        to: this.addressToBytes32(recipientAddress),
        amountLD: BigInt(quote.amountIn),
        minAmountLD: BigInt(quote.amountOut),
        extraOptions: '0x',
        composeMsg: '0x',
        oftCmd: this.getOftCmd('taxi'), // Default to taxi for execution
      };

      const messagingFee = {
        nativeFee: BigInt(quote.gasFee),
        lzTokenFee: 0n,
      };

      // Encode the send() call
      const txData = pool.interface.encodeFunctionData('send', [
        sendParam,
        messagingFee,
        wallet.address, // refund address
      ]);

      // ETH bridging: msg.value = amountIn + LZ fee (pool wraps ETH)
      // ERC20: msg.value = LZ fee only (tokens transferred via approval)
      const tx: ethers.TransactionRequest = {
        to: poolAddress,
        data: txData,
        value: quote.token === 'ETH'
          ? BigInt(quote.amountIn) + BigInt(quote.gasFee)
          : BigInt(quote.gasFee),
      };

      if (nonce !== undefined) {
        tx.nonce = nonce;
      }

      // Estimate gas with buffer
      const gasEstimate = await wallet.estimateGas(tx);
      tx.gasLimit = gasEstimate * GAS_BUFFER_NUMERATOR / GAS_BUFFER_DENOMINATOR;

      logger.info('Executing Stargate V2 bridge', {
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
      const bridgeId = `stargate-v2-${receipt.hash}`;

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

      logger.info('Stargate V2 bridge initiated', {
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
      logger.error('Stargate V2 bridge execution failed', {
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
          error: 'Bridge timeout - LZ V2 message may still be delivered',
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
   * Ensure ERC20 token approval for Stargate V2 pool.
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
      logger.info('Approving token for Stargate V2 pool', {
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
   * Validates chain support and V2 pool availability on both chains.
   */
  isRouteSupported(sourceChain: string, destChain: string, token: string): boolean {
    if (sourceChain === destChain) {
      return false;
    }

    if (!this.supportedSourceChains.includes(sourceChain) ||
        !this.supportedDestChains.includes(destChain)) {
      return false;
    }

    // Check token has V2 pool contracts on both chains
    const tokenPools = STARGATE_V2_POOL_ADDRESSES[token];
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
    return STARGATE_V2_BRIDGE_TIMES[routeKey] ?? STARGATE_V2_BRIDGE_TIMES.default;
  }

  /**
   * Health check for Stargate V2.
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
        return { healthy: true, message: 'Stargate V2 router operational (single chain only)' };
      }

      const provider = this.providers.get(testChain)!;
      await provider.getBlockNumber();

      return {
        healthy: true,
        message: `Stargate V2 router operational. ${this.providers.size} chains connected.`,
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
 * Create a Stargate V2 router instance
 */
export function createStargateV2Router(
  providers?: Map<string, ethers.Provider>
): StargateV2Router {
  return new StargateV2Router(providers);
}
