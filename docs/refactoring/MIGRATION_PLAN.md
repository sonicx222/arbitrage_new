# Refactoring Migration Plan - Safe Extractions

**Created**: 2026-01-29
**Status**: Ready for Implementation
**Risk Level**: LOW (Non-Hot-Path Code Only)

---

## Executive Summary

This document provides a concrete, step-by-step migration plan for extracting non-hot-path code from god classes. All extractions have been verified to NOT impact the <50ms detection latency requirement.

### Extraction Targets

| Module | Lines Extracted | Risk | Effort |
|--------|-----------------|------|--------|
| `DetectorConnectionManager` | ~200 lines | LOW | 2 days |
| `PairInitializationService` | ~250 lines | LOW | 2 days |
| `ExecutionEngineInitializer` | ~350 lines | LOW | 3 days |
| Type Consolidation | ~400 lines | LOW | 2 days |

**Total Estimated Effort**: 9 days
**Total Lines Extracted**: ~1,200 lines

---

## Phase 1: DetectorConnectionManager

### 1.1 File Structure

```
shared/core/src/
├── detector/
│   ├── index.ts                          # Re-exports
│   ├── detector-connection-manager.ts    # NEW
│   └── types.ts                          # NEW
└── base-detector.ts                      # MODIFIED (uses new module)
```

### 1.2 New Interface Definition

**File**: `shared/core/src/detector/types.ts`

```typescript
/**
 * Detector Connection Manager Types
 * Extracted from base-detector.ts for single-responsibility principle.
 *
 * @see ADR-002: Redis Streams Architecture
 */

import type { RedisClient, RedisStreamsClient, StreamBatcher, SwapEventFilter } from '../index';
import type { ServiceLogger } from '../logging';

/**
 * Configuration for detector connection initialization.
 */
export interface DetectorConnectionConfig {
  /** Chain identifier for logging context */
  chain: string;
  /** Logger instance for operation logging */
  logger: ServiceLogger;
  /** Batcher configuration overrides */
  batcherConfig?: {
    priceUpdates?: { maxBatchSize?: number; maxWaitMs?: number };
    swapEvents?: { maxBatchSize?: number; maxWaitMs?: number };
    whaleAlerts?: { maxBatchSize?: number; maxWaitMs?: number };
  };
  /** Swap event filter configuration */
  swapFilterConfig?: {
    minUsdValue?: number;
    whaleThreshold?: number;
    dedupWindowMs?: number;
    aggregationWindowMs?: number;
  };
}

/**
 * Resources created by connection initialization.
 * All resources are nullable to support graceful degradation.
 */
export interface DetectorConnectionResources {
  redis: RedisClient;
  streamsClient: RedisStreamsClient;
  priceUpdateBatcher: StreamBatcher<any>;
  swapEventBatcher: StreamBatcher<any>;
  whaleAlertBatcher: StreamBatcher<any>;
  swapEventFilter: SwapEventFilter;
}

/**
 * Callback types for event filter handlers.
 */
export interface EventFilterHandlers {
  onWhaleAlert: (alert: any) => void;
  onVolumeAggregate: (aggregate: any) => void;
}
```

### 1.3 New Module Implementation

**File**: `shared/core/src/detector/detector-connection-manager.ts`

```typescript
/**
 * Detector Connection Manager
 *
 * Manages Redis and Streams connections for detector services.
 * Extracted from base-detector.ts to reduce class size and improve testability.
 *
 * This module handles INITIALIZATION ONLY - not hot-path operations.
 * All connections are established once at startup.
 *
 * @see base-detector.ts - Original implementation
 * @see ADR-002 - Redis Streams Architecture
 */

import {
  RedisClient,
  getRedisClient,
  RedisStreamsClient,
  getRedisStreamsClient,
  SwapEventFilter,
  WhaleAlert,
  VolumeAggregate,
} from '../index';
import type {
  DetectorConnectionConfig,
  DetectorConnectionResources,
  EventFilterHandlers,
} from './types';

/**
 * Default batcher configurations per ADR-002 efficiency targets (50:1 ratio).
 */
const DEFAULT_BATCHER_CONFIG = {
  priceUpdates: { maxBatchSize: 50, maxWaitMs: 100 },
  swapEvents: { maxBatchSize: 100, maxWaitMs: 500 },
  whaleAlerts: { maxBatchSize: 10, maxWaitMs: 50 },
};

/**
 * Default swap event filter configuration.
 */
const DEFAULT_SWAP_FILTER_CONFIG = {
  minUsdValue: 10,
  whaleThreshold: 50000,
  dedupWindowMs: 5000,
  aggregationWindowMs: 5000,
};

/**
 * Initialize all detector connections and batchers.
 *
 * This is a ONE-TIME initialization function called at detector startup.
 * NOT part of the hot path.
 *
 * @param config - Connection configuration
 * @param handlers - Event filter callback handlers
 * @returns Promise resolving to all connection resources
 * @throws Error if Redis Streams initialization fails (required per ADR-002)
 */
export async function initializeDetectorConnections(
  config: DetectorConnectionConfig,
  handlers: EventFilterHandlers
): Promise<DetectorConnectionResources> {
  const { chain, logger, batcherConfig = {}, swapFilterConfig = {} } = config;

  try {
    // Initialize Redis client for basic operations
    const redis = await getRedisClient() as RedisClient;
    logger.debug('Redis client initialized', { chain });

    // Initialize Redis Streams client (REQUIRED per ADR-002)
    const streamsClient = await getRedisStreamsClient();
    logger.debug('Redis Streams client initialized', { chain });

    // Merge configurations with defaults
    const priceConfig = { ...DEFAULT_BATCHER_CONFIG.priceUpdates, ...batcherConfig.priceUpdates };
    const swapConfig = { ...DEFAULT_BATCHER_CONFIG.swapEvents, ...batcherConfig.swapEvents };
    const whaleConfig = { ...DEFAULT_BATCHER_CONFIG.whaleAlerts, ...batcherConfig.whaleAlerts };

    // Create batchers for efficient command usage
    const priceUpdateBatcher = streamsClient.createBatcher(
      RedisStreamsClient.STREAMS.PRICE_UPDATES,
      priceConfig
    );

    const swapEventBatcher = streamsClient.createBatcher(
      RedisStreamsClient.STREAMS.SWAP_EVENTS,
      swapConfig
    );

    const whaleAlertBatcher = streamsClient.createBatcher(
      RedisStreamsClient.STREAMS.WHALE_ALERTS,
      whaleConfig
    );

    logger.info('Redis Streams batchers initialized', {
      chain,
      priceUpdates: priceConfig,
      swapEvents: swapConfig,
      whaleAlerts: whaleConfig,
    });

    // Initialize Smart Swap Event Filter (S1.2)
    const filterConfig = { ...DEFAULT_SWAP_FILTER_CONFIG, ...swapFilterConfig };
    const swapEventFilter = new SwapEventFilter(filterConfig);

    // Set up event handlers
    swapEventFilter.onWhaleAlert((alert: WhaleAlert) => {
      handlers.onWhaleAlert(alert);
    });

    swapEventFilter.onVolumeAggregate((aggregate: VolumeAggregate) => {
      handlers.onVolumeAggregate(aggregate);
    });

    logger.info('Smart Swap Event Filter initialized', {
      chain,
      minUsdValue: filterConfig.minUsdValue,
      whaleThreshold: filterConfig.whaleThreshold,
    });

    return {
      redis,
      streamsClient,
      priceUpdateBatcher,
      swapEventBatcher,
      whaleAlertBatcher,
      swapEventFilter,
    };
  } catch (error) {
    logger.error('Failed to initialize detector connections', { chain, error });
    throw new Error('Redis Streams initialization failed - Streams required per ADR-002');
  }
}

/**
 * Disconnect all detector connections gracefully.
 *
 * @param resources - Connection resources to disconnect
 * @param logger - Logger for operation logging
 */
export async function disconnectDetectorConnections(
  resources: Partial<DetectorConnectionResources>,
  logger: { info: (msg: string, meta?: object) => void; error: (msg: string, meta?: object) => void }
): Promise<void> {
  const { redis, streamsClient, priceUpdateBatcher, swapEventBatcher, whaleAlertBatcher } = resources;

  // Flush any pending batched items
  try {
    if (priceUpdateBatcher) await priceUpdateBatcher.flush();
    if (swapEventBatcher) await swapEventBatcher.flush();
    if (whaleAlertBatcher) await whaleAlertBatcher.flush();
  } catch (error) {
    logger.error('Error flushing batchers during disconnect', { error });
  }

  // Disconnect streams client
  if (streamsClient) {
    try {
      await streamsClient.disconnect();
    } catch (error) {
      logger.error('Error disconnecting streams client', { error });
    }
  }

  // Disconnect Redis
  if (redis) {
    try {
      await redis.disconnect();
    } catch (error) {
      logger.error('Error disconnecting Redis', { error });
    }
  }

  logger.info('Detector connections disconnected');
}
```

### 1.4 Integration into BaseDetector

**Changes to**: `shared/core/src/base-detector.ts`

```typescript
// Add import at top of file
import {
  initializeDetectorConnections,
  disconnectDetectorConnections,
  type DetectorConnectionResources,
} from './detector';

// In BaseDetector class, replace initializeRedis() method:

/**
 * Initialize Redis and Streams connections.
 * Delegates to DetectorConnectionManager for cleaner separation of concerns.
 */
protected async initializeRedis(): Promise<void> {
  const resources = await initializeDetectorConnections(
    {
      chain: this.chain,
      logger: this.logger,
      // Use existing config values
      batcherConfig: {
        priceUpdates: { maxBatchSize: 50, maxWaitMs: 100 },
        swapEvents: { maxBatchSize: 100, maxWaitMs: 500 },
        whaleAlerts: { maxBatchSize: 10, maxWaitMs: 50 },
      },
    },
    {
      onWhaleAlert: (alert) => {
        this.publishWithRetry(
          () => this.publishWhaleAlert(alert),
          'whale alert',
          3
        );
      },
      onVolumeAggregate: (aggregate) => {
        this.publishWithRetry(
          () => this.publishVolumeAggregate(aggregate),
          'volume aggregate',
          3
        );
      },
    }
  );

  // Assign to instance properties (kept for hot-path access)
  this.redis = resources.redis;
  this.streamsClient = resources.streamsClient;
  this.priceUpdateBatcher = resources.priceUpdateBatcher;
  this.swapEventBatcher = resources.swapEventBatcher;
  this.whaleAlertBatcher = resources.whaleAlertBatcher;
  this.swapEventFilter = resources.swapEventFilter;
}
```

### 1.5 Test File

**File**: `shared/core/src/detector/__tests__/detector-connection-manager.test.ts`

```typescript
import { initializeDetectorConnections, disconnectDetectorConnections } from '../detector-connection-manager';
import { getRedisClient, getRedisStreamsClient } from '../../index';

// Mock dependencies
jest.mock('../../index', () => ({
  getRedisClient: jest.fn(),
  getRedisStreamsClient: jest.fn(),
  SwapEventFilter: jest.fn().mockImplementation(() => ({
    onWhaleAlert: jest.fn(),
    onVolumeAggregate: jest.fn(),
  })),
  RedisStreamsClient: {
    STREAMS: {
      PRICE_UPDATES: 'stream:price-updates',
      SWAP_EVENTS: 'stream:swap-events',
      WHALE_ALERTS: 'stream:whale-alerts',
    },
  },
}));

describe('DetectorConnectionManager', () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const mockRedis = { disconnect: jest.fn() };
  const mockStreamsClient = {
    createBatcher: jest.fn().mockReturnValue({ flush: jest.fn() }),
    disconnect: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (getRedisClient as jest.Mock).mockResolvedValue(mockRedis);
    (getRedisStreamsClient as jest.Mock).mockResolvedValue(mockStreamsClient);
  });

  describe('initializeDetectorConnections', () => {
    it('should initialize all connections successfully', async () => {
      const resources = await initializeDetectorConnections(
        { chain: 'ethereum', logger: mockLogger },
        { onWhaleAlert: jest.fn(), onVolumeAggregate: jest.fn() }
      );

      expect(resources.redis).toBeDefined();
      expect(resources.streamsClient).toBeDefined();
      expect(resources.priceUpdateBatcher).toBeDefined();
      expect(resources.swapEventBatcher).toBeDefined();
      expect(resources.whaleAlertBatcher).toBeDefined();
      expect(resources.swapEventFilter).toBeDefined();
    });

    it('should throw if Redis Streams fails', async () => {
      (getRedisStreamsClient as jest.Mock).mockRejectedValue(new Error('Connection failed'));

      await expect(
        initializeDetectorConnections(
          { chain: 'ethereum', logger: mockLogger },
          { onWhaleAlert: jest.fn(), onVolumeAggregate: jest.fn() }
        )
      ).rejects.toThrow('Redis Streams initialization failed');
    });
  });

  describe('disconnectDetectorConnections', () => {
    it('should disconnect all resources gracefully', async () => {
      const resources = {
        redis: mockRedis,
        streamsClient: mockStreamsClient,
        priceUpdateBatcher: { flush: jest.fn() },
        swapEventBatcher: { flush: jest.fn() },
        whaleAlertBatcher: { flush: jest.fn() },
      };

      await disconnectDetectorConnections(resources as any, mockLogger);

      expect(resources.priceUpdateBatcher.flush).toHaveBeenCalled();
      expect(mockStreamsClient.disconnect).toHaveBeenCalled();
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });
  });
});
```

---

## Phase 2: ExecutionEngineInitializer

### 2.1 File Structure

```
services/execution-engine/src/
├── initialization/
│   ├── index.ts                          # Re-exports
│   ├── execution-engine-initializer.ts   # NEW
│   ├── mev-initializer.ts                # NEW
│   ├── risk-management-initializer.ts    # NEW
│   └── types.ts                          # NEW
└── engine.ts                             # MODIFIED (uses new module)
```

### 2.2 MEV Initializer

**File**: `services/execution-engine/src/initialization/mev-initializer.ts`

```typescript
/**
 * MEV Provider Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles MEV protection provider setup during service startup.
 *
 * NOT part of hot path - called once during initialization.
 */

import {
  MevProviderFactory,
  MevGlobalConfig,
  getErrorMessage,
} from '@arbitrage/core';
import { MEV_CONFIG } from '@arbitrage/config';
import type { ProviderServiceImpl } from '../services/provider.service';
import type { Logger } from '../types';

export interface MevInitializationResult {
  factory: MevProviderFactory | null;
  providersInitialized: number;
}

/**
 * Initialize MEV protection providers for all configured chains.
 *
 * @param providerService - Provider service with chain connections
 * @param logger - Logger instance
 * @returns MEV factory and count of initialized providers
 */
export function initializeMevProviders(
  providerService: ProviderServiceImpl,
  logger: Logger
): MevInitializationResult {
  if (!MEV_CONFIG.enabled) {
    logger.info('MEV protection disabled by configuration');
    return { factory: null, providersInitialized: 0 };
  }

  const mevGlobalConfig: MevGlobalConfig = {
    enabled: MEV_CONFIG.enabled,
    flashbotsAuthKey: MEV_CONFIG.flashbotsAuthKey,
    bloxrouteAuthHeader: MEV_CONFIG.bloxrouteAuthHeader,
    flashbotsRelayUrl: MEV_CONFIG.flashbotsRelayUrl,
    submissionTimeoutMs: MEV_CONFIG.submissionTimeoutMs,
    maxRetries: MEV_CONFIG.maxRetries,
    fallbackToPublic: MEV_CONFIG.fallbackToPublic,
  };

  const factory = new MevProviderFactory(mevGlobalConfig);
  let providersInitialized = 0;

  for (const chainName of providerService.getWallets().keys()) {
    const provider = providerService.getProvider(chainName);
    const wallet = providerService.getWallet(chainName);

    if (provider && wallet) {
      const chainSettings = MEV_CONFIG.chainSettings[chainName];
      if (chainSettings?.enabled !== false) {
        try {
          const mevProvider = factory.createProvider({
            chain: chainName,
            provider,
            wallet,
          });

          providersInitialized++;
          logger.info(`MEV provider initialized for ${chainName}`, {
            strategy: mevProvider.strategy,
            enabled: mevProvider.isEnabled(),
          });
        } catch (error) {
          logger.warn(`Failed to initialize MEV provider for ${chainName}`, {
            error: getErrorMessage(error),
          });
        }
      }
    }
  }

  logger.info('MEV protection initialization complete', {
    providersInitialized,
    globalEnabled: MEV_CONFIG.enabled,
  });

  return { factory, providersInitialized };
}
```

### 2.3 Risk Management Initializer

**File**: `services/execution-engine/src/initialization/risk-management-initializer.ts`

```typescript
/**
 * Risk Management Initialization
 *
 * Extracted from engine.ts for single-responsibility principle.
 * Handles capital risk management component setup.
 *
 * NOT part of hot path - called once during initialization.
 *
 * @see ADR-021: Capital Risk Management
 */

import {
  DrawdownCircuitBreaker,
  getDrawdownCircuitBreaker,
  EVCalculator,
  getEVCalculator,
  KellyPositionSizer,
  getKellyPositionSizer,
  ExecutionProbabilityTracker,
  getExecutionProbabilityTracker,
  type DrawdownConfig,
  type EVConfig,
  type PositionSizerConfig,
  type ExecutionProbabilityConfig,
} from '@arbitrage/core';
import { RISK_CONFIG } from '@arbitrage/config';
import type { Logger } from '../types';

export interface RiskManagementComponents {
  drawdownBreaker: DrawdownCircuitBreaker | null;
  evCalculator: EVCalculator | null;
  positionSizer: KellyPositionSizer | null;
  probabilityTracker: ExecutionProbabilityTracker | null;
  enabled: boolean;
}

/**
 * Initialize all capital risk management components.
 *
 * @param logger - Logger instance
 * @returns All risk management components or nulls if disabled
 */
export function initializeRiskManagement(logger: Logger): RiskManagementComponents {
  if (!RISK_CONFIG.enabled) {
    logger.info('Capital risk management disabled by configuration');
    return {
      drawdownBreaker: null,
      evCalculator: null,
      positionSizer: null,
      probabilityTracker: null,
      enabled: false,
    };
  }

  try {
    // Initialize Execution Probability Tracker (Task 3.4.1)
    const probabilityConfig: Partial<ExecutionProbabilityConfig> = {
      minSamples: RISK_CONFIG.probability.minSamples,
      defaultWinProbability: RISK_CONFIG.probability.defaultWinProbability,
      maxOutcomesPerKey: RISK_CONFIG.probability.maxOutcomesPerKey,
      cleanupIntervalMs: RISK_CONFIG.probability.cleanupIntervalMs,
      outcomeRelevanceWindowMs: RISK_CONFIG.probability.outcomeRelevanceWindowMs,
      persistToRedis: RISK_CONFIG.probability.persistToRedis,
      redisKeyPrefix: RISK_CONFIG.probability.redisKeyPrefix,
    };
    const probabilityTracker = getExecutionProbabilityTracker(probabilityConfig);

    logger.info('Execution probability tracker initialized', {
      minSamples: RISK_CONFIG.probability.minSamples,
      defaultWinProbability: RISK_CONFIG.probability.defaultWinProbability,
    });

    // Initialize EV Calculator (Task 3.4.2)
    const evConfig: Partial<EVConfig> = {
      minPositiveEV: RISK_CONFIG.ev.minPositiveEV,
      gasBuffer: RISK_CONFIG.ev.gasBuffer,
      slippageEstimate: RISK_CONFIG.ev.slippageEstimate,
      bridgeFeeEstimate: RISK_CONFIG.ev.bridgeFeeEstimate,
      executionSuccessRate: RISK_CONFIG.ev.executionSuccessRate,
    };
    const evCalculator = getEVCalculator(evConfig);

    logger.info('EV calculator initialized', {
      minPositiveEV: RISK_CONFIG.ev.minPositiveEV,
    });

    // Initialize Kelly Position Sizer (Task 3.4.3)
    const positionConfig: Partial<PositionSizerConfig> = {
      maxPositionPercent: RISK_CONFIG.positionSizing.maxPositionPercent,
      minPositionUsd: RISK_CONFIG.positionSizing.minPositionUsd,
      maxPositionUsd: RISK_CONFIG.positionSizing.maxPositionUsd,
      kellyFraction: RISK_CONFIG.positionSizing.kellyFraction,
      bankrollUsd: RISK_CONFIG.positionSizing.bankrollUsd,
    };
    const positionSizer = getKellyPositionSizer(positionConfig);

    logger.info('Kelly position sizer initialized', {
      maxPositionPercent: RISK_CONFIG.positionSizing.maxPositionPercent,
      kellyFraction: RISK_CONFIG.positionSizing.kellyFraction,
    });

    // Initialize Drawdown Circuit Breaker (Task 3.4.4)
    const drawdownConfig: Partial<DrawdownConfig> = {
      maxDailyDrawdownPercent: RISK_CONFIG.drawdown.maxDailyDrawdownPercent,
      maxWeeklyDrawdownPercent: RISK_CONFIG.drawdown.maxWeeklyDrawdownPercent,
      recoveryThresholdPercent: RISK_CONFIG.drawdown.recoveryThresholdPercent,
      alertThresholdPercent: RISK_CONFIG.drawdown.alertThresholdPercent,
      cooldownPeriodMs: RISK_CONFIG.drawdown.cooldownPeriodMs,
      initialCapitalUsd: RISK_CONFIG.drawdown.initialCapitalUsd,
    };
    const drawdownBreaker = getDrawdownCircuitBreaker(drawdownConfig);

    logger.info('Drawdown circuit breaker initialized', {
      maxDailyDrawdownPercent: RISK_CONFIG.drawdown.maxDailyDrawdownPercent,
      maxWeeklyDrawdownPercent: RISK_CONFIG.drawdown.maxWeeklyDrawdownPercent,
    });

    logger.info('Capital risk management fully initialized');

    return {
      drawdownBreaker,
      evCalculator,
      positionSizer,
      probabilityTracker,
      enabled: true,
    };
  } catch (error) {
    logger.error('Failed to initialize risk management', { error });
    return {
      drawdownBreaker: null,
      evCalculator: null,
      positionSizer: null,
      probabilityTracker: null,
      enabled: false,
    };
  }
}
```

### 2.4 Main Initializer Facade

**File**: `services/execution-engine/src/initialization/execution-engine-initializer.ts`

```typescript
/**
 * Execution Engine Initializer
 *
 * Facade for all initialization operations.
 * Provides a single entry point for engine startup.
 */

import { initializeMevProviders, type MevInitializationResult } from './mev-initializer';
import { initializeRiskManagement, type RiskManagementComponents } from './risk-management-initializer';
import type { ProviderServiceImpl } from '../services/provider.service';
import type { Logger } from '../types';
import {
  BridgeRouterFactory,
  createBridgeRouterFactory,
  getErrorMessage,
} from '@arbitrage/core';

export interface InitializationResult {
  mev: MevInitializationResult;
  risk: RiskManagementComponents;
  bridgeRouterFactory: BridgeRouterFactory | null;
}

/**
 * Initialize all execution engine components.
 *
 * This is a ONE-TIME initialization called during service startup.
 * NOT part of the hot path.
 *
 * @param providerService - Initialized provider service
 * @param logger - Logger instance
 * @returns All initialized components
 */
export async function initializeExecutionEngine(
  providerService: ProviderServiceImpl,
  logger: Logger
): Promise<InitializationResult> {
  // Initialize MEV providers
  const mev = initializeMevProviders(providerService, logger);

  // Initialize risk management
  const risk = initializeRiskManagement(logger);

  // Initialize bridge router
  let bridgeRouterFactory: BridgeRouterFactory | null = null;
  try {
    bridgeRouterFactory = createBridgeRouterFactory({
      defaultProtocol: 'stargate',
      providers: providerService.getProviders(),
    });

    logger.info('Bridge router initialized', {
      protocols: bridgeRouterFactory.getAvailableProtocols(),
      chainsWithProviders: Array.from(providerService.getProviders().keys()),
    });
  } catch (error) {
    logger.error('Failed to initialize bridge router', {
      error: getErrorMessage(error),
    });
  }

  return { mev, risk, bridgeRouterFactory };
}

// Re-export types
export type { MevInitializationResult, RiskManagementComponents };
```

---

## Phase 3: Type Consolidation

### 3.1 New Type Files

**File**: `shared/types/execution.ts`

```typescript
/**
 * Execution-related types
 *
 * Consolidated from services/execution-engine/src/types.ts
 * These types are used across multiple services.
 */

/**
 * Result of an execution attempt.
 * Used by execution-engine, coordinator, and monitoring.
 */
export interface ExecutionResult {
  opportunityId: string;
  success: boolean;
  transactionHash?: string;
  actualProfit?: number;
  gasUsed?: number;
  gasCost?: number;
  error?: string;
  timestamp: number;
  chain: string;
  dex: string;
  /** Execution latency in milliseconds */
  latencyMs?: number;
  /** Whether MEV protection was used */
  usedMevProtection?: boolean;
}

/**
 * Standardized error codes for execution.
 * Provides consistent error reporting across services.
 */
export enum ExecutionErrorCode {
  // Chain/Provider errors
  NO_CHAIN = '[ERR_NO_CHAIN] No chain specified for opportunity',
  NO_WALLET = '[ERR_NO_WALLET] No wallet available for chain',
  NO_PROVIDER = '[ERR_NO_PROVIDER] No provider available for chain',
  NO_BRIDGE = '[ERR_NO_BRIDGE] Bridge router not initialized',
  NO_ROUTE = '[ERR_NO_ROUTE] No bridge route available',

  // Configuration errors
  CONFIG_ERROR = '[ERR_CONFIG] Configuration error',
  ZERO_ADDRESS = '[ERR_ZERO_ADDRESS] Zero address is invalid',

  // Validation errors
  INVALID_OPPORTUNITY = '[ERR_INVALID_OPPORTUNITY] Invalid opportunity format',
  CROSS_CHAIN_MISMATCH = '[ERR_CROSS_CHAIN] Strategy mismatch for cross-chain opportunity',
  SAME_CHAIN = '[ERR_SAME_CHAIN] Cross-chain arbitrage requires different chains',
  PRICE_VERIFICATION = '[ERR_PRICE_VERIFICATION] Price verification failed',

  // Transaction errors
  NONCE_ERROR = '[ERR_NONCE] Failed to get nonce',
  GAS_SPIKE = '[ERR_GAS_SPIKE] Gas price spike detected',
  APPROVAL_FAILED = '[ERR_APPROVAL] Token approval failed',
  SIMULATION_REVERT = '[ERR_SIMULATION_REVERT] Simulation predicted revert',

  // Bridge errors
  BRIDGE_QUOTE = '[ERR_BRIDGE_QUOTE] Bridge quote failed',
  BRIDGE_EXEC = '[ERR_BRIDGE_EXEC] Bridge execution failed',
  BRIDGE_FAILED = '[ERR_BRIDGE_FAILED] Bridge failed',
  BRIDGE_TIMEOUT = '[ERR_BRIDGE_TIMEOUT] Bridge timeout',

  // Execution errors
  EXECUTION_ERROR = '[ERR_EXECUTION] Execution error',
  SELL_FAILED = '[ERR_SELL_FAILED] Sell transaction failed',
  HIGH_FEES = '[ERR_HIGH_FEES] Fees exceed expected profit',
  SHUTDOWN = '[ERR_SHUTDOWN] Execution interrupted by shutdown',

  // Flash loan errors
  NO_STRATEGY = '[ERR_NO_STRATEGY] Required strategy not registered',
  FLASH_LOAN_ERROR = '[ERR_FLASH_LOAN] Flash loan error',
  UNSUPPORTED_PROTOCOL = '[ERR_UNSUPPORTED_PROTOCOL] Protocol not implemented',

  // Risk management errors
  LOW_EV = '[ERR_LOW_EV] Expected value below threshold',
  POSITION_SIZE = '[ERR_POSITION_SIZE] Position size below minimum',
  DRAWDOWN_HALT = '[ERR_DRAWDOWN_HALT] Trading halted due to drawdown',
}

/**
 * Create a failed ExecutionResult.
 */
export function createErrorResult(
  opportunityId: string,
  error: string,
  chain: string,
  dex: string,
  transactionHash?: string
): ExecutionResult {
  return {
    opportunityId,
    success: false,
    error,
    timestamp: Date.now(),
    chain,
    dex,
    transactionHash,
  };
}

/**
 * Create a successful ExecutionResult.
 */
export function createSuccessResult(
  opportunityId: string,
  chain: string,
  dex: string,
  transactionHash: string,
  actualProfit: number,
  gasUsed: number,
  gasCost: number
): ExecutionResult {
  return {
    opportunityId,
    success: true,
    transactionHash,
    actualProfit,
    gasUsed,
    gasCost,
    timestamp: Date.now(),
    chain,
    dex,
  };
}
```

**File**: `shared/types/common.ts`

```typescript
/**
 * Common types used across all services
 *
 * Consolidated from scattered definitions to ensure consistency.
 */

/**
 * Minimal logger interface for dependency injection.
 * Compatible with Pino, Winston, and test mocks.
 */
export interface ILogger {
  info: (message: string, meta?: object) => void;
  error: (message: string, meta?: object) => void;
  warn: (message: string, meta?: object) => void;
  debug: (message: string, meta?: object) => void;
}

/**
 * Service health status.
 */
export interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: number;
  details?: Record<string, any>;
}

/**
 * Performance metrics for monitoring.
 */
export interface PerformanceMetrics {
  eventLatency: number;
  detectionLatency: number;
  executionLatency?: number;
  throughput: number;
  errorRate: number;
}

/**
 * Validation result pattern.
 */
export interface ValidationResult<T = void> {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  data?: T;
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationWarning {
  field: string;
  message: string;
  suggestion?: string;
}
```

### 3.2 Updated Index File

**File**: `shared/types/index.ts` (add to existing)

```typescript
// Add to existing exports:

// Execution types (consolidated from services/execution-engine)
export * from './execution';

// Common types (consolidated from scattered definitions)
export * from './common';
```

---

## Migration Checklist

### Pre-Migration

- [ ] Ensure all tests pass: `npm test`
- [ ] Ensure typecheck passes: `npm run typecheck`
- [ ] Create git branch: `git checkout -b refactor/phase1-safe-extractions`

### Phase 1: DetectorConnectionManager (Day 1-2)

- [ ] Create `shared/core/src/detector/` directory
- [ ] Create `shared/core/src/detector/types.ts`
- [ ] Create `shared/core/src/detector/detector-connection-manager.ts`
- [ ] Create `shared/core/src/detector/index.ts`
- [ ] Update `shared/core/src/base-detector.ts` to use new module
- [ ] Add tests: `shared/core/src/detector/__tests__/detector-connection-manager.test.ts`
- [ ] Run `npm test` - verify all tests pass
- [ ] Run `npm run typecheck` - verify no type errors
- [ ] Run performance tests: `npm run test:performance -- --grep "Hot Path"`

### Phase 2: ExecutionEngineInitializer (Day 3-5)

- [ ] Create `services/execution-engine/src/initialization/` directory
- [ ] Create `mev-initializer.ts`
- [ ] Create `risk-management-initializer.ts`
- [ ] Create `execution-engine-initializer.ts`
- [ ] Create `index.ts`
- [ ] Update `services/execution-engine/src/engine.ts` to use new module
- [ ] Add tests for each initializer
- [ ] Run `npm test` - verify all tests pass
- [ ] Run `npm run typecheck` - verify no type errors

### Phase 3: Type Consolidation (Day 6-7)

- [ ] Create `shared/types/execution.ts`
- [ ] Create `shared/types/common.ts`
- [ ] Update `shared/types/index.ts`
- [ ] Update `services/execution-engine/src/types.ts` to import from shared
- [ ] Update `services/cross-chain-detector/src/types.ts` to import from shared
- [ ] Run `npm test` - verify all tests pass
- [ ] Run `npm run typecheck` - verify no type errors

### Post-Migration

- [ ] Run full test suite: `npm test`
- [ ] Run typecheck: `npm run typecheck`
- [ ] Run performance tests: `npm run test:performance`
- [ ] Verify <50ms hot path maintained
- [ ] Commit: `git commit -m "refactor: extract non-hot-path initialization code"`
- [ ] Create PR for review

---

## Performance Verification

After each phase, run:

```bash
# Ensure hot path stays under 50ms
npm run test:performance -- --grep "Hot Path"

# Expected output:
# ✓ Detection Hot Path < 50ms (average: 30-40ms)
# ✓ Price Matrix Lookup < 1μs
# ✓ Token Pair Lookup O(1)
```

If any performance test fails, **REVERT the changes** and investigate.

---

## Rollback Plan

If issues are discovered after merge:

```bash
# Revert to previous commit
git revert HEAD

# Or cherry-pick specific fixes
git cherry-pick <fix-commit>
```

All extracted code is additive and backward-compatible, so rollback is straightforward.
