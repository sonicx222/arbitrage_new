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
  BridgeProtocol,
  BridgeQuoteRequest,
  BridgeQuote,
  BridgeExecuteRequest,
  BridgeExecuteResult,
  BRIDGE_DEFAULTS,
  STARGATE_CHAIN_IDS,
  STARGATE_POOL_IDS,
  STARGATE_ROUTER_ADDRESSES,
  BRIDGE_TIMES,
} from './types';
import type { PoolLiquidityAlert } from './types';
import { createLogger } from '../logger';
import {
  AbstractBridgeRouter,
  TX_WAIT_TIMEOUT_MS,
  BPS_DENOMINATOR,
  GAS_BUFFER_NUMERATOR,
  GAS_BUFFER_DENOMINATOR,
  ERC20_ABI,
} from './abstract-bridge-router';

/** Stargate V1 bridge fee: 0.06% of bridged amount */
const STARGATE_BRIDGE_FEE_BPS = 6n;

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
    fantom: '0x04068DA6C83AFCFA0e13ba15A6696662335D5B75',
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

// =============================================================================
// Stargate Router Implementation
// =============================================================================

/**
 * Stargate bridge router for cross-chain token transfers.
 *
 * Extends AbstractBridgeRouter with Stargate V1-specific:
 * - quoteLayerZeroFee() / swap() ABI
 * - Pool ID-based routing (srcPoolId/dstPoolId)
 * - Pool liquidity monitoring in healthCheck()
 * - onPoolAlert callback for low-liquidity alerts
 */
export class StargateRouter extends AbstractBridgeRouter {
  readonly protocol: BridgeProtocol = 'stargate';

  readonly supportedSourceChains = [
    'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'bsc', 'avalanche', 'fantom'
  ];

  readonly supportedDestChains = this.supportedSourceChains;

  // Optional callback for pool liquidity alerts
  private onPoolAlert?: (alert: PoolLiquidityAlert) => void;

  constructor(
    providers?: Map<string, ethers.Provider>,
    options?: { onPoolAlert?: (alert: PoolLiquidityAlert) => void }
  ) {
    super(createLogger('stargate-router'), providers);
    if (options?.onPoolAlert) {
      this.onPoolAlert = options.onPoolAlert;
    }
  }

  protected override getTimeoutMessage(): string {
    return 'Bridge timeout - transaction may still complete';
  }

  protected override getRouterName(): string {
    return 'Stargate router';
  }

  /**
   * Get quote for Stargate bridge
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
      const bridgeFee = amountBigInt * STARGATE_BRIDGE_FEE_BPS / BPS_DENOMINATOR;
      const gasFee = nativeFee;
      // totalFee represents native gas cost only (bridgeFee is already deducted from amountOut).
      // bridgeFee is denominated in the bridged token (e.g., USDC 6 decimals) while gasFee
      // is in native token wei (18 decimals). Summing them produces a meaningless value.
      const totalFee = gasFee;

      // Calculate output with slippage
      const amountAfterFee = amountBigInt - bridgeFee;
      const minAmountOut = amountAfterFee * BigInt(Math.floor((1 - slippage) * Number(BPS_DENOMINATOR))) / BPS_DENOMINATOR;

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
        recipient: request.recipient || undefined,
      };
    } catch (error) {
      this.logger.error('Failed to get Stargate quote', {
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

      // Pre-flight balance check to fail fast instead of wasting gas
      const provider = request.provider;
      if (quote.token === 'ETH') {
        const balance = await provider.getBalance(wallet.address);
        const required = BigInt(quote.amountIn) + BigInt(quote.gasFee);
        if (balance < required) {
          return { success: false, error: `Insufficient ETH balance: have ${balance}, need ${required}` };
        }
      } else {
        const tokenAddress = STARGATE_TOKEN_ADDRESSES[quote.token]?.[quote.sourceChain];
        if (tokenAddress) {
          const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
          const tokenBalance = await tokenContract.balanceOf(wallet.address);
          if (BigInt(tokenBalance) < BigInt(quote.amountIn)) {
            return { success: false, error: `Insufficient ${quote.token} balance` };
          }
          // Also check native balance for gas fee
          const nativeBalance = await provider.getBalance(wallet.address);
          if (nativeBalance < BigInt(quote.gasFee)) {
            return { success: false, error: 'Insufficient native balance for gas fee' };
          }
        }
      }

      // BUG-FIX: Check and request ERC20 approval if needed
      // (ETH doesn't need approval, only ERC20 tokens)
      if (quote.token !== 'ETH') {
        const tokenAddress = STARGATE_TOKEN_ADDRESSES[quote.token]?.[quote.sourceChain];
        if (!tokenAddress) {
          return {
            success: false,
            error: `Token address not configured for ${quote.token} on ${quote.sourceChain}`,
          };
        }
        // Per-token mutex prevents concurrent approval races on the same token
        const approvalMutex = this.getApprovalMutex(tokenAddress);
        const approved = await approvalMutex.runExclusive(async () => {
          return this.ensureApproval(
            wallet,
            tokenAddress,
            routerAddress,
            BigInt(quote.amountIn)
          );
        });
        if (!approved) {
          return {
            success: false,
            error: `Failed to approve ${quote.token} for Stargate router`,
          };
        }
      }

      const dstChainId = STARGATE_CHAIN_IDS[quote.destChain];
      // Use quote recipient if specified, otherwise sender
      const recipientAddress = quote.recipient || wallet.address;
      const recipient = ethers.solidityPacked(['address'], [recipientAddress]);

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
      // ETH bridging requires msg.value = amountIn + LZ fee (bridge amount + relayer cost)
      // ERC20 bridging requires msg.value = LZ fee only (tokens transferred via approval)
      const tx: ethers.TransactionRequest = {
        to: routerAddress,
        data: txData,
        value: quote.token === 'ETH'
          ? BigInt(quote.amountIn) + BigInt(quote.gasFee)  // ETH: bridge amount + LZ fee
          : BigInt(quote.gasFee),                           // ERC20: LZ fee only
      };

      // Set nonce if provided (from NonceManager)
      if (nonce !== undefined) {
        tx.nonce = nonce;
      }

      // Estimate gas
      const gasEstimate = await wallet.estimateGas(tx);
      tx.gasLimit = gasEstimate * GAS_BUFFER_NUMERATOR / GAS_BUFFER_DENOMINATOR; // 20% buffer

      // Send transaction
      this.logger.info('Executing Stargate bridge', {
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
        return {
          success: false,
          error: 'Transaction receipt not received',
        };
      }

      // Generate bridge ID and store pending bridge
      const bridgeId = `stargate-${receipt.hash}`;

      await this.storePendingBridge(bridgeId, {
        status: 'bridging',
        sourceTxHash: receipt.hash,
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
        startTime: Date.now(),
      });

      this.logger.info('Stargate bridge initiated', {
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
      this.logger.error('Stargate bridge execution failed', {
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
   * Health check for Stargate.
   * Extends base health check with V1 pool liquidity monitoring.
   */
  override async healthCheck(): Promise<{ healthy: boolean; message: string }> {
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
        return { healthy: true, message: 'Stargate router operational (single chain only)' };
      }

      const provider = this.providers.get(testChain)!;
      await provider.getBlockNumber();

      // Non-critical: Check V1 pool liquidity on one chain
      const liquidityInfo = await this.checkPoolLiquidity(testChain);

      const message = liquidityInfo
        ? `Stargate router operational. ${this.providers.size} chains connected. ${liquidityInfo}`
        : `Stargate router operational. ${this.providers.size} chains connected.`;

      return { healthy: true, message };
    } catch (error) {
      return {
        healthy: false,
        message: `Health check failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Check V1 pool liquidity by querying USDC balance held by the router contract.
   * Non-critical: returns info string on success, null on failure.
   * Used as a degradation signal -- declining balance indicates LP migration to V2.
   */
  private async checkPoolLiquidity(chain: string): Promise<string | null> {
    try {
      const provider = this.providers.get(chain);
      const routerAddress = STARGATE_ROUTER_ADDRESSES[chain];
      const usdcAddress = STARGATE_TOKEN_ADDRESSES.USDC?.[chain];

      if (!provider || !routerAddress || !usdcAddress) {
        return null;
      }

      const tokenContract = new ethers.Contract(usdcAddress, ERC20_ABI, provider);
      const balance: bigint = await tokenContract.balanceOf(routerAddress);

      // USDC has 6 decimals
      const balanceUsd = Number(balance) / 1e6;

      const WARNING_THRESHOLD = 10_000;
      const CRITICAL_THRESHOLD = 1_000;

      if (balanceUsd < WARNING_THRESHOLD) {
        const severity = balanceUsd < CRITICAL_THRESHOLD ? 'critical' : 'warning';

        this.logger.warn('Low V1 pool liquidity detected', {
          chain,
          token: 'USDC',
          balanceUsd: Math.floor(balanceUsd),
          severity,
        });

        // Invoke alert callback if configured (fire-and-forget, non-blocking)
        if (this.onPoolAlert) {
          try {
            this.onPoolAlert({
              protocol: 'stargate',
              chain,
              token: 'USDC',
              balanceUsd: Math.floor(balanceUsd),
              threshold: severity === 'critical' ? CRITICAL_THRESHOLD : WARNING_THRESHOLD,
              severity,
              timestamp: Date.now(),
            });
          } catch (callbackError) {
            this.logger.debug('Pool alert callback error (non-critical)', {
              error: callbackError instanceof Error ? callbackError.message : String(callbackError),
            });
          }
        }

        const label = severity === 'critical' ? 'CRITICAL' : 'LOW';
        return `V1 USDC pool on ${chain}: $${Math.floor(balanceUsd).toLocaleString()} (${label})`;
      }

      return `V1 USDC pool on ${chain}: $${Math.floor(balanceUsd).toLocaleString()}`;
    } catch (error) {
      // Non-critical -- don't fail health check if liquidity query fails
      this.logger.debug('Pool liquidity check failed (non-critical)', {
        chain,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a Stargate router instance
 */
export function createStargateRouter(
  providers?: Map<string, ethers.Provider>,
  options?: { onPoolAlert?: (alert: PoolLiquidityAlert) => void }
): StargateRouter {
  return new StargateRouter(providers, options);
}
