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
  BridgeProtocol,
  BridgeQuoteRequest,
  BridgeQuote,
  BridgeExecuteRequest,
  BridgeExecuteResult,
  BRIDGE_DEFAULTS,
} from './types';
import { createLogger } from '../logger';
import {
  AbstractBridgeRouter,
  TX_WAIT_TIMEOUT_MS,
  BPS_DENOMINATOR,
  GAS_BUFFER_NUMERATOR,
  GAS_BUFFER_DENOMINATOR,
  ERC20_ABI,
} from './abstract-bridge-router';
import { getErrorMessage } from '../resilience/error-handling';
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
 * Across bridge router for cross-chain token transfers via SpokePool contracts.
 *
 * Extends AbstractBridgeRouter with Across-specific:
 * - SpokePool.depositV3() execution
 * - Per-route fee calculation from config (no on-chain quote)
 * - Standard EVM chain IDs (not LayerZero chain IDs)
 * - WETH bridging via msg.value (SpokePool wraps ETH internally)
 * - zkSync and Linea support
 */
export class AcrossRouter extends AbstractBridgeRouter {
  readonly protocol: BridgeProtocol = 'across';

  readonly supportedSourceChains = [
    'ethereum', 'arbitrum', 'optimism', 'base', 'polygon', 'zksync', 'linea'
  ];

  readonly supportedDestChains = this.supportedSourceChains;

  constructor(providers?: Map<string, ethers.Provider>) {
    super(createLogger('across-router'), providers);
  }

  protected override getTimeoutMessage(): string {
    return 'Bridge timeout - relayer may still fill the deposit';
  }

  protected override getRouterName(): string {
    return 'Across router';
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
      this.logger.error('Failed to get Across quote', {
        sourceChain,
        destChain,
        token,
        error: getErrorMessage(error),
      });

      return this.createInvalidQuote(sourceChain, destChain, token, amount,
        `Quote failed: ${getErrorMessage(error)}`);
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

      this.logger.info('Executing Across bridge', {
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

      await this.storePendingBridge(bridgeId, {
        status: 'bridging',
        sourceTxHash: receipt.hash,
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
        startTime: Date.now(),
      });

      this.logger.info('Across bridge initiated', {
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
      this.logger.error('Across bridge execution failed', {
        sourceChain: quote.sourceChain,
        destChain: quote.destChain,
        error: getErrorMessage(error),
      });

      return {
        success: false,
        error: getErrorMessage(error),
      };
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
