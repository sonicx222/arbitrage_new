/**
 * Strategy Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles execution strategy setup during service startup:
 * - Flash loan strategy + provider factory
 * - Intra-chain, cross-chain, simulation strategies
 * - Feature-flagged strategies (backrun, UniswapX, Solana, statistical arb)
 * - Strategy factory registration
 * - TX simulation service
 *
 * NOT part of hot path - called once during initialization.
 *
 * @see ADR-022: Hot-Path Performance
 */

import {
  getErrorMessage,
} from '@arbitrage/core';
import { FEATURE_FLAGS, FLASH_LOAN_PROVIDERS, DEXES, BALANCER_V2_VAULTS } from '@arbitrage/config';
import { IntraChainStrategy } from '../strategies/intra-chain.strategy';
import { CrossChainStrategy } from '../strategies/cross-chain.strategy';
import { SimulationStrategy } from '../strategies/simulation.strategy';
import { FlashLoanStrategy } from '../strategies/flash-loan.strategy';
import { createFlashLoanProviderFactory } from '../strategies/flash-loan-providers/provider-factory';
import { ExecutionStrategyFactory, createStrategyFactory } from '../strategies/strategy-factory';
import { BackrunStrategy } from '../strategies/backrun.strategy';
import { UniswapXFillerStrategy } from '../strategies/uniswapx-filler.strategy';
import type { ISimulationService } from '../services/simulation/types';
import { initializeTxSimulationService } from '../services/tx-simulation-initializer';
import type { ProviderServiceImpl } from '../services/provider.service';
import type {
  Logger,
  ResolvedSimulationConfig,
} from '../types';

/**
 * Dependencies required for strategy initialization.
 */
export interface StrategyInitDeps {
  logger: Logger;
  simulationConfig: ResolvedSimulationConfig;
  isSimulationMode: boolean;
  providerService: ProviderServiceImpl | null;
}

/**
 * Result of strategy initialization.
 * All strategy references needed by ExecutionEngineService.
 */
export interface StrategyInitResult {
  strategyFactory: ExecutionStrategyFactory;
  intraChainStrategy: IntraChainStrategy;
  crossChainStrategy: CrossChainStrategy;
  simulationStrategy: SimulationStrategy;
  backrunStrategy: BackrunStrategy | null;
  uniswapxStrategy: UniswapXFillerStrategy | null;
  txSimulationService: ISimulationService | null;
}

/**
 * Parse a numeric environment variable, returning undefined for missing or invalid values.
 * Supports both integers and floats (unlike parseEnvInt which only handles integers).
 *
 * @param key - Environment variable name
 * @param logger - Logger for invalid value warnings
 * @returns Parsed number or undefined
 */
function parseNumericEnv(key: string, logger: Logger): number | undefined {
  const raw = process.env[key];
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (isNaN(parsed)) {
    logger.warn(`Invalid numeric env var ${key}='${raw}', ignoring (using default)`);
    return undefined;
  }
  return parsed;
}

/**
 * Build flash loan contract addresses and provider configuration from environment.
 *
 * Prefers Balancer V2 (0% fee) over default providers when deployed.
 * Falls back to generic flash loan contracts per chain.
 */
function buildFlashLoanConfig(logger: Logger): {
  contractAddresses: Record<string, string>;
  approvedRouters: Record<string, string[]>;
  providerOverrides: Record<string, { address: string; protocol: string; fee: number }>;
} {
  const contractAddresses: Record<string, string> = {};
  const approvedRouters: Record<string, string[]> = {};
  const providerOverrides: Record<string, { address: string; protocol: string; fee: number }> = {};

  for (const chain of Object.keys(FLASH_LOAN_PROVIDERS)) {
    // Phase 5: Prefer Balancer V2 (0% fee) over default provider when deployed
    const balancerEnvKey = `BALANCER_V2_CONTRACT_${chain.toUpperCase()}`;
    const balancerAddress = process.env[balancerEnvKey];
    const vaultAddress = BALANCER_V2_VAULTS[chain as keyof typeof BALANCER_V2_VAULTS];

    if (balancerAddress && vaultAddress) {
      contractAddresses[chain] = balancerAddress;
      providerOverrides[chain] = {
        address: vaultAddress,
        protocol: 'balancer_v2',
        fee: 0,
      };
      logger.info('Preferring Balancer V2 (0% fee) over default provider', {
        chain,
        defaultProtocol: FLASH_LOAN_PROVIDERS[chain].protocol,
        defaultFee: FLASH_LOAN_PROVIDERS[chain].fee,
        contract: balancerAddress,
      });
    } else {
      // Fall back to generic flash loan contract
      const envKey = `FLASH_LOAN_CONTRACT_${chain.toUpperCase()}`;
      const address = process.env[envKey];
      if (address) {
        contractAddresses[chain] = address;
      }
    }

    if (contractAddresses[chain]) {
      // Source approved routers: prefer explicit config, fallback to DEXES router addresses
      const providerConfig = FLASH_LOAN_PROVIDERS[chain];
      if (providerConfig.approvedRouters && providerConfig.approvedRouters.length > 0) {
        approvedRouters[chain] = providerConfig.approvedRouters;
      } else if (DEXES[chain]) {
        approvedRouters[chain] = DEXES[chain]
          .map(dex => dex.routerAddress)
          .filter(Boolean);
      }
    }
  }

  return { contractAddresses, approvedRouters, providerOverrides };
}

/**
 * Initialize Solana execution strategy via dynamic imports.
 *
 * Feature-flagged behind FEATURE_SOLANA_EXECUTION=true.
 * Uses dynamic imports to avoid loading @solana/web3.js in non-Solana deployments.
 *
 * @returns true if strategy was registered, false otherwise
 */
async function initializeSolanaStrategy(
  strategyFactory: ExecutionStrategyFactory,
  logger: Logger,
): Promise<boolean> {
  if (process.env.FEATURE_SOLANA_EXECUTION !== 'true') {
    logger.info('Solana execution disabled (FEATURE_SOLANA_EXECUTION != true)');
    return false;
  }

  // H7: Validate SOLANA_RPC_URL before proceeding — connection stubs throw at runtime
  if (!process.env.SOLANA_RPC_URL) {
    logger.error('FEATURE_SOLANA_EXECUTION is enabled but SOLANA_RPC_URL is not set — skipping Solana strategy registration');
    return false;
  }

  try {
    const { JupiterSwapClient } = await import('../solana/jupiter-client');
    const { SolanaTransactionBuilder } = await import('../solana/transaction-builder');
    const { SolanaExecutionStrategy } = await import('../strategies/solana-execution.strategy');

    const jupiterClient = new JupiterSwapClient({
      apiUrl: process.env.JUPITER_API_URL ?? undefined,
      timeoutMs: parseNumericEnv('JUPITER_TIMEOUT_MS', logger) ?? undefined,
      maxRetries: parseNumericEnv('JUPITER_MAX_RETRIES', logger) ?? undefined,
      defaultSlippageBps: parseNumericEnv('JUPITER_DEFAULT_SLIPPAGE_BPS', logger) ?? undefined,
    });

    // Jito tip accounts from jito-provider defaults
    const { JITO_TIP_ACCOUNTS } = await import('@arbitrage/core/mev-protection/jito-provider');
    const tipAccountsRaw = process.env.JITO_TIP_ACCOUNTS;
    const tipAccounts = tipAccountsRaw
      ? tipAccountsRaw.split(',').map((s: string) => s.trim())
      : JITO_TIP_ACCOUNTS;

    const txBuilder = new SolanaTransactionBuilder({ tipAccounts });

    // Create Jito provider for strategy use
    const { createJitoProvider } = await import('@arbitrage/core/mev-protection/jito-provider');

    // Build a connection interface for the Jito provider.
    // Stubs throw descriptive errors instead of returning empty values
    // to make misconfiguration visible.
    const notConfigured = (method: string) => async () => {
      throw new Error(`Solana connection not configured: ${method}() requires SOLANA_RPC_URL`);
    };
    const jitoProvider = createJitoProvider({
      chain: 'solana',
      connection: {
        getLatestBlockhash: notConfigured('getLatestBlockhash'),
        getSlot: notConfigured('getSlot'),
        getSignatureStatus: notConfigured('getSignatureStatus'),
        getBalance: notConfigured('getBalance'),
        sendRawTransaction: notConfigured('sendRawTransaction'),
      },
      keypair: {
        publicKey: { toBase58: () => process.env.SOLANA_WALLET_PUBLIC_KEY ?? '', toBuffer: () => Buffer.alloc(32) },
        secretKey: new Uint8Array(64),
      },
      enabled: true,
      jitoEndpoint: process.env.JITO_ENDPOINT ?? undefined,
      tipLamports: parseNumericEnv('JITO_TIP_LAMPORTS', logger) ?? undefined,
      tipAccounts,
    });

    // H1: Build confirmation client from Solana RPC for transaction
    // finality polling. Uses direct JSON-RPC calls to avoid importing
    // @solana/web3.js at the engine level.
    const solanaRpcUrl = process.env.SOLANA_RPC_URL!;
    const confirmationClient = {
      async getSignatureStatus(signature: string) {
        const response = await fetch(solanaRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getSignatureStatuses',
            params: [[signature]],
          }),
        });
        const data = (await response.json()) as {
          result?: { value?: Array<{ confirmationStatus: string; slot?: number } | null> };
        };
        const statuses = data.result?.value;
        return { value: statuses?.[0] ?? null };
      },
      async getBlockHeight() {
        const response = await fetch(solanaRpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBlockHeight',
            params: [],
          }),
        });
        const data = (await response.json()) as { result?: number };
        return data.result ?? 0;
      },
    };

    const solanaStrategy = new SolanaExecutionStrategy(
      jupiterClient,
      txBuilder,
      jitoProvider,
      {
        walletPublicKey: process.env.SOLANA_WALLET_PUBLIC_KEY ?? '',
        tipLamports: parseNumericEnv('JITO_TIP_LAMPORTS', logger) ?? 1_000_000,
        maxSlippageBps: parseNumericEnv('SOLANA_MAX_SLIPPAGE_BPS', logger) ?? 100,
        minProfitLamports: BigInt(process.env.SOLANA_MIN_PROFIT_LAMPORTS ?? '100000'),
        maxPriceDeviationPct: parseNumericEnv('SOLANA_MAX_PRICE_DEVIATION_PCT', logger) ?? 1.0,
        confirmationTimeoutMs: parseNumericEnv('SOLANA_CONFIRMATION_TIMEOUT_MS', logger) ?? undefined,
        confirmationPollIntervalMs: parseNumericEnv('SOLANA_CONFIRMATION_POLL_INTERVAL_MS', logger) ?? undefined,
      },
      logger,
      confirmationClient,
    );

    strategyFactory.registerSolanaStrategy(solanaStrategy);
    logger.info('Solana execution strategy registered');
    return true;
  } catch (error) {
    logger.error('Failed to initialize Solana execution strategy', {
      error: getErrorMessage(error),
    });
    return false;
  }
}

/**
 * Initialize statistical arbitrage strategy via dynamic import.
 *
 * Feature-flagged behind FEATURE_STATISTICAL_ARB=true.
 */
async function initializeStatisticalArbStrategy(
  strategyFactory: ExecutionStrategyFactory,
  logger: Logger,
  flashLoanStrategy: FlashLoanStrategy | undefined,
): Promise<boolean> {
  if (process.env.FEATURE_STATISTICAL_ARB !== 'true') {
    return false;
  }

  try {
    const { StatisticalArbitrageStrategy } = await import('../strategies/statistical-arbitrage.strategy');
    const statArbStrategy = new StatisticalArbitrageStrategy(
      logger,
      {
        minConfidence: parseNumericEnv('STAT_ARB_MIN_CONFIDENCE', logger) ?? 0.5,
        maxOpportunityAgeMs: parseNumericEnv('STAT_ARB_MAX_AGE_MS', logger) ?? 30_000,
        minExpectedProfitUsd: parseNumericEnv('STAT_ARB_MIN_PROFIT_USD', logger) ?? 5,
      },
      flashLoanStrategy ?? undefined,
    );
    strategyFactory.registerStatisticalStrategy(statArbStrategy);
    logger.info('Statistical arbitrage strategy registered');
    return true;
  } catch (error) {
    logger.error('Failed to initialize statistical arbitrage strategy', {
      error: getErrorMessage(error),
    });
    return false;
  }
}

/**
 * Initialize all execution strategies.
 *
 * Called once during ExecutionEngineService.start().
 * Creates strategy instances, registers them with the factory,
 * and optionally initializes the TX simulation service.
 *
 * @param deps - Strategy initialization dependencies
 * @returns All initialized strategy references
 */
export async function initializeAllStrategies(deps: StrategyInitDeps): Promise<StrategyInitResult> {
  const { logger, simulationConfig, isSimulationMode, providerService } = deps;

  // Build flash loan configuration from environment
  const { contractAddresses, approvedRouters, providerOverrides } = buildFlashLoanConfig(logger);

  // Create FlashLoanStrategy and FlashLoanProviderFactory if contract addresses are configured
  let flashLoanStrategy: FlashLoanStrategy | undefined;
  let flashLoanProviderFactory: ReturnType<typeof createFlashLoanProviderFactory> | undefined;

  if (Object.keys(contractAddresses).length > 0) {
    try {
      // Build fee overrides from provider overrides (e.g., Balancer V2 at 0%)
      const feeOverrides: Record<string, number> = {};
      for (const [chain, override] of Object.entries(providerOverrides)) {
        feeOverrides[chain] = override.fee;
      }

      flashLoanStrategy = new FlashLoanStrategy(logger, {
        contractAddresses,
        approvedRouters,
        feeOverrides: Object.keys(feeOverrides).length > 0 ? feeOverrides : undefined,
        enableAggregator: FEATURE_FLAGS.useFlashLoanAggregator,
      });

      flashLoanProviderFactory = createFlashLoanProviderFactory(logger, {
        contractAddresses,
        approvedRouters,
        providerOverrides: Object.keys(providerOverrides).length > 0 ? providerOverrides : undefined,
      });

      logger.info('FlashLoanStrategy initialized', {
        chains: Object.keys(contractAddresses),
        aggregatorEnabled: FEATURE_FLAGS.useFlashLoanAggregator,
      });
    } catch (error) {
      logger.warn('Failed to initialize FlashLoanStrategy', {
        error: getErrorMessage(error),
      });
    }
  } else {
    logger.debug('FlashLoanStrategy not registered - no contract addresses configured');
  }

  // Create core strategy instances
  const intraChainStrategy = new IntraChainStrategy(logger);
  const simulationStrategy = new SimulationStrategy(logger, simulationConfig);

  // FE-001: Wire flash loan dependencies into CrossChainStrategy when feature flag enabled
  let crossChainStrategy: CrossChainStrategy;
  if (FEATURE_FLAGS.useDestChainFlashLoan && flashLoanProviderFactory && flashLoanStrategy) {
    crossChainStrategy = new CrossChainStrategy(
      logger,
      flashLoanProviderFactory,
      flashLoanStrategy,
    );
    logger.info('CrossChainStrategy initialized with destination flash loan support', {
      supportedChains: Object.keys(contractAddresses),
    });
  } else {
    crossChainStrategy = new CrossChainStrategy(logger);
    if (FEATURE_FLAGS.useDestChainFlashLoan) {
      logger.warn('Destination flash loan feature enabled but no flash loan contracts configured');
    }
  }

  // Create strategy factory and register strategies
  const strategyFactory = createStrategyFactory({
    logger,
    isSimulationMode,
  });

  strategyFactory.registerStrategies({
    simulation: simulationStrategy,
    crossChain: crossChainStrategy,
    intraChain: intraChainStrategy,
  });

  // Register FlashLoanStrategy with factory for direct flash loan opportunities
  if (flashLoanStrategy) {
    strategyFactory.registerFlashLoanStrategy(flashLoanStrategy);
  }

  // Feature-flagged strategy registration
  let backrunStrategy: BackrunStrategy | null = null;
  let uniswapxStrategy: UniswapXFillerStrategy | null = null;

  if (FEATURE_FLAGS.useBackrunStrategy) {
    backrunStrategy = new BackrunStrategy(logger, {
      minProfitUsd: parseNumericEnv('BACKRUN_MIN_PROFIT_USD', logger),
      maxGasPriceGwei: parseNumericEnv('BACKRUN_MAX_GAS_PRICE_GWEI', logger),
    });
    strategyFactory.registerBackrunStrategy(backrunStrategy);
  }
  if (FEATURE_FLAGS.useUniswapxFiller) {
    uniswapxStrategy = new UniswapXFillerStrategy(logger, {
      minProfitUsd: parseNumericEnv('UNISWAPX_MIN_PROFIT_USD', logger),
      maxGasPriceGwei: parseNumericEnv('UNISWAPX_MAX_GAS_PRICE_GWEI', logger),
    });
    strategyFactory.registerUniswapXStrategy(uniswapxStrategy);
  }

  // Dynamic import strategies (Solana, Statistical Arb)
  await initializeSolanaStrategy(strategyFactory, logger);
  await initializeStatisticalArbStrategy(strategyFactory, logger, flashLoanStrategy);

  logger.info('Strategy factory initialized', {
    registeredTypes: strategyFactory.getRegisteredTypes(),
    simulationMode: isSimulationMode,
    destChainFlashLoan: FEATURE_FLAGS.useDestChainFlashLoan,
  });

  // Initialize tx simulation service
  let txSimulationService: ISimulationService | null = null;
  if (!isSimulationMode && providerService) {
    txSimulationService = initializeTxSimulationService(providerService, logger);
  }

  return {
    strategyFactory,
    intraChainStrategy,
    crossChainStrategy,
    simulationStrategy,
    backrunStrategy,
    uniswapxStrategy,
    txSimulationService,
  };
}
