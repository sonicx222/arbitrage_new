/**
 * Whale Pipeline Integration Test (Phase 3, Task 8)
 *
 * Verifies the full simulation pipeline end-to-end:
 *   ChainSimulator (executeSwap)
 *     → ChainSimulationHandler (bridges events to SimulationCallbacks)
 *       → WhaleAlertPublisher (publishes to Redis Streams)
 *         → stream:swap-events (consumed by swap event processors)
 *         → stream:whale-alerts (consumed by cross-chain detector's consumeWhaleAlerts)
 *
 * Success metrics from the research spec:
 * - stream:swap-events: > 0 messages within 10s of simulation start
 * - stream:whale-alerts: > 0 messages within 10s of simulation start
 * - Whale alert messages pass validateWhaleTransaction field checks
 *   (required for cross-chain detector to process them without errors)
 *
 * @see docs/reports/SIMULATED_WHALE_SWAP_EVENTS_RESEARCH_2026-03-06.md — Task 8
 * @see services/cross-chain-detector/src/stream-consumer.ts — validateWhaleTransaction
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Redis from 'ioredis';
import * as fs from 'fs';
import * as path from 'path';
import { RedisStreamsClient } from '@arbitrage/core/redis';
import {
  ChainSimulationHandler,
  PairForSimulation,
  SimulationCallbacks,
} from '../../src/simulation';
import { WhaleAlertPublisher } from '../../src/publishers/whale-alert.publisher';
import type { SwapEvent } from '@arbitrage/types';
import type { WhaleAlert } from '@arbitrage/core/analytics';

// =============================================================================
// Test Redis Setup
// =============================================================================

function getTestRedisUrl(): string {
  const configFile = path.resolve(__dirname, '../../../../.redis-test-config.json');
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (config.url) return config.url;
    } catch { /* fall through */ }
  }
  return process.env.REDIS_URL ?? 'redis://localhost:6379';
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Poll a stream until at least one message arrives or timeout.
 * Returns the parsed 'data' JSON of the first message found.
 */
async function waitForStreamData(
  redis: Redis,
  stream: string,
  timeoutMs: number = 10_000
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  let pollMs = 50;

  while (Date.now() < deadline) {
    const raw = await redis.xrange(stream, '-', '+', 'COUNT', '1');
    if (raw && raw.length > 0) {
      const [, fields] = raw[0];
      const fieldObj: Record<string, string> = {};
      for (let i = 0; i < fields.length; i += 2) {
        fieldObj[fields[i]] = fields[i + 1];
      }
      if (fieldObj.data) {
        try {
          return JSON.parse(fieldObj.data) as Record<string, unknown>;
        } catch {
          return fieldObj as unknown as Record<string, unknown>;
        }
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
    pollMs = Math.min(pollMs * 1.5, 500);
  }

  return null;
}

const createNoopLogger = () => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
});

// =============================================================================
// Test Pairs
// =============================================================================

/**
 * Two WETH/USDC pairs on syncswap (zksync's primary DEX).
 * Using zksync as chainId: 1s block time, 4 swaps/block — fastest chain profile.
 */
const TEST_PAIRS: PairForSimulation[] = [
  {
    key: 'syncswap_WETH_USDC',
    address: '0x80115c708E12eDd42E504c1cD52Aea96C547c05c',
    dex: 'syncswap',
    token0Symbol: 'WETH',
    token1Symbol: 'USDC',
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 0.003,
    token0Address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    token1Address: '0x3355df6D4c9C3035724Fd0e3914dE96A5a83aaf4',
  },
  {
    key: 'syncswap_WETH_USDT',
    address: '0xd3D91634Cf4C04aD1B76496189a8B3e7Da5B8e71',
    dex: 'syncswap',
    token0Symbol: 'WETH',
    token1Symbol: 'USDT',
    token0Decimals: 18,
    token1Decimals: 6,
    fee: 0.003,
    token0Address: '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91',
    token1Address: '0x493257fD37EDB34451f62EDf8D2a0C418852bA4c',
  },
];

// =============================================================================
// Integration Tests
// =============================================================================

describe('[Integration] Whale Pipeline: Simulation → Redis Streams', () => {
  let redis: Redis;
  let streamsClient: RedisStreamsClient;
  let handler: ChainSimulationHandler;
  let publisher: WhaleAlertPublisher;

  const CHAIN_ID = 'zksync'; // 1s block time — fastest profile for fast test completion

  beforeAll(async () => {
    const testUrl = getTestRedisUrl();
    process.env.REDIS_URL = testUrl;

    redis = new Redis(testUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
  }, 15_000);

  afterAll(async () => {
    if (redis) await redis.quit();
  });

  beforeEach(async () => {
    // Flush Redis for test isolation
    await redis.flushall();

    // Set simulation env vars:
    // - block-driven mode (default) → simulateBlock() called → executeSwap() → swapEvent + whaleAlert
    // - whale rate = 1.0 → every swap is whale-sized
    // - threshold = $1 → all whale swaps emit whaleAlert (guaranteed)
    process.env.SIMULATION_WHALE_RATE = '1';
    process.env.SIMULATION_WHALE_THRESHOLD_USD = '1';
    // Do NOT set SIMULATION_UPDATE_INTERVAL_MS — would force legacy mode (no executeSwap)

    // Create fresh RedisStreamsClient for each test
    streamsClient = new RedisStreamsClient(getTestRedisUrl());

    // WhaleAlertPublisher wired to the streams client
    publisher = new WhaleAlertPublisher({
      chainId: CHAIN_ID,
      logger: createNoopLogger(),
      streamsClient,
      tokens: [], // No token config needed — publisher falls back to address slices
      simulationMode: true,
    });

    // ChainSimulationHandler bridges ChainSimulator events to SimulationCallbacks
    handler = new ChainSimulationHandler(CHAIN_ID, createNoopLogger());
  });

  afterEach(async () => {
    // Stop simulation first
    if (handler) {
      try { await handler.stop(); } catch { /* ignore */ }
    }

    // Disconnect streams client
    if (streamsClient) {
      try { await streamsClient.disconnect(); } catch { /* ignore */ }
    }

    // Clean up env vars
    delete process.env.SIMULATION_WHALE_RATE;
    delete process.env.SIMULATION_WHALE_THRESHOLD_USD;
  });

  // ===========================================================================
  // Success Metric 1: stream:swap-events receives messages
  // ===========================================================================

  it('should publish swap events to stream:swap-events within 10s', async () => {
    const swapEvents: SwapEvent[] = [];

    const callbacks: SimulationCallbacks = {
      onPriceUpdate: () => {},
      onOpportunity: () => {},
      onBlockUpdate: () => {},
      onEventProcessed: () => {},
      onSyncEvent: () => {},
      onSwapEvent: (event: SwapEvent) => {
        swapEvents.push(event);
        publisher.publishSwapEvent(event);
      },
      onWhaleAlert: () => {},
    };

    await handler.initializeEvmSimulation(TEST_PAIRS, callbacks);

    // Wait for at least one swap event to appear on the Redis stream
    const message = await waitForStreamData(
      redis,
      RedisStreamsClient.STREAMS.SWAP_EVENTS,
      10_000
    );

    expect(message).not.toBeNull();
    expect(swapEvents.length).toBeGreaterThan(0);
  }, 15_000);

  // ===========================================================================
  // Success Metric 2: stream:whale-alerts receives messages
  // ===========================================================================

  it('should publish whale alerts to stream:whale-alerts within 10s', async () => {
    const whaleAlerts: WhaleAlert[] = [];

    const callbacks: SimulationCallbacks = {
      onPriceUpdate: () => {},
      onOpportunity: () => {},
      onBlockUpdate: () => {},
      onEventProcessed: () => {},
      onSyncEvent: () => {},
      onSwapEvent: () => {},
      onWhaleAlert: (alert: WhaleAlert) => {
        whaleAlerts.push(alert);
        publisher.publishWhaleAlert(alert);
      },
    };

    await handler.initializeEvmSimulation(TEST_PAIRS, callbacks);

    const message = await waitForStreamData(
      redis,
      RedisStreamsClient.STREAMS.WHALE_ALERTS,
      10_000
    );

    expect(message).not.toBeNull();
    expect(whaleAlerts.length).toBeGreaterThan(0);
  }, 15_000);

  // ===========================================================================
  // Success Metric 3: whale alert format compatible with cross-chain detector
  // ===========================================================================

  it('should publish whale alerts with fields required by validateWhaleTransaction', async () => {
    const callbacks: SimulationCallbacks = {
      onPriceUpdate: () => {},
      onOpportunity: () => {},
      onBlockUpdate: () => {},
      onEventProcessed: () => {},
      onSyncEvent: () => {},
      onSwapEvent: () => {},
      onWhaleAlert: (alert: WhaleAlert) => {
        publisher.publishWhaleAlert(alert);
      },
    };

    await handler.initializeEvmSimulation(TEST_PAIRS, callbacks);

    const message = await waitForStreamData(
      redis,
      RedisStreamsClient.STREAMS.WHALE_ALERTS,
      10_000
    );

    expect(message).not.toBeNull();
    if (!message) return;

    // Validate all fields that validateWhaleTransaction (cross-chain detector) checks:
    // chain: non-empty string
    expect(typeof message.chain).toBe('string');
    expect(message.chain).toBeTruthy();

    // usdValue: finite number, 0–100B
    expect(typeof message.usdValue).toBe('number');
    expect(Number.isFinite(message.usdValue as number)).toBe(true);
    expect(message.usdValue as number).toBeGreaterThanOrEqual(0);
    expect(message.usdValue as number).toBeLessThanOrEqual(100_000_000_000);

    // direction: 'buy' | 'sell'
    expect(['buy', 'sell']).toContain(message.direction);

    // token: non-empty string
    expect(typeof message.token).toBe('string');
    expect(message.token).toBeTruthy();

    // transactionHash: non-empty string
    expect(typeof message.transactionHash).toBe('string');
    expect(message.transactionHash).toBeTruthy();

    // amount: positive finite number
    expect(typeof message.amount).toBe('number');
    expect(Number.isFinite(message.amount as number)).toBe(true);
    expect(message.amount as number).toBeGreaterThan(0);

    // timestamp: positive number
    expect(typeof message.timestamp).toBe('number');
    expect(message.timestamp as number).toBeGreaterThan(0);
  }, 15_000);

  // ===========================================================================
  // Both streams: simultaneous publishing
  // ===========================================================================

  it('should publish to both streams simultaneously when both callbacks are wired', async () => {
    const callbacks: SimulationCallbacks = {
      onPriceUpdate: () => {},
      onOpportunity: () => {},
      onBlockUpdate: () => {},
      onEventProcessed: () => {},
      onSyncEvent: () => {},
      onSwapEvent: (event: SwapEvent) => {
        publisher.publishSwapEvent(event);
      },
      onWhaleAlert: (alert: WhaleAlert) => {
        publisher.publishWhaleAlert(alert);
      },
    };

    await handler.initializeEvmSimulation(TEST_PAIRS, callbacks);

    // Wait for both streams to have messages
    const [swapMessage, whaleMessage] = await Promise.all([
      waitForStreamData(redis, RedisStreamsClient.STREAMS.SWAP_EVENTS, 10_000),
      waitForStreamData(redis, RedisStreamsClient.STREAMS.WHALE_ALERTS, 10_000),
    ]);

    expect(swapMessage).not.toBeNull();
    expect(whaleMessage).not.toBeNull();

    // Verify stream lengths both > 0
    const swapLen = await redis.xlen(RedisStreamsClient.STREAMS.SWAP_EVENTS);
    const whaleLen = await redis.xlen(RedisStreamsClient.STREAMS.WHALE_ALERTS);

    expect(swapLen).toBeGreaterThan(0);
    expect(whaleLen).toBeGreaterThan(0);
  }, 15_000);

  // ===========================================================================
  // Source field: simulation mode tagging
  // ===========================================================================

  it('should tag whale alerts with source=simulation for audit trail', async () => {
    const callbacks: SimulationCallbacks = {
      onPriceUpdate: () => {},
      onOpportunity: () => {},
      onBlockUpdate: () => {},
      onEventProcessed: () => {},
      onSyncEvent: () => {},
      onSwapEvent: () => {},
      onWhaleAlert: (alert: WhaleAlert) => {
        publisher.publishWhaleAlert(alert);
      },
    };

    await handler.initializeEvmSimulation(TEST_PAIRS, callbacks);

    const message = await waitForStreamData(
      redis,
      RedisStreamsClient.STREAMS.WHALE_ALERTS,
      10_000
    );

    expect(message).not.toBeNull();
    expect(message?.source).toBe('simulation');
  }, 15_000);

  // ===========================================================================
  // Swap event: transactionHash links to whale alert transactionHash
  // ===========================================================================

  it('should use same transactionHash in both swapEvent and corresponding whaleAlert', async () => {
    const swapHashes = new Set<string>();
    const whaleHashes = new Set<string>();

    const callbacks: SimulationCallbacks = {
      onPriceUpdate: () => {},
      onOpportunity: () => {},
      onBlockUpdate: () => {},
      onEventProcessed: () => {},
      onSyncEvent: () => {},
      onSwapEvent: (event: SwapEvent) => {
        if (event.transactionHash) swapHashes.add(event.transactionHash);
        publisher.publishSwapEvent(event);
      },
      onWhaleAlert: (alert: WhaleAlert) => {
        if (alert.event.transactionHash) whaleHashes.add(alert.event.transactionHash);
        publisher.publishWhaleAlert(alert);
      },
    };

    await handler.initializeEvmSimulation(TEST_PAIRS, callbacks);

    // Wait for whale alerts (implies swap events also arrived)
    await waitForStreamData(redis, RedisStreamsClient.STREAMS.WHALE_ALERTS, 10_000);

    // Every whale hash must correspond to a swap hash
    expect(whaleHashes.size).toBeGreaterThan(0);
    for (const hash of whaleHashes) {
      expect(swapHashes.has(hash)).toBe(true);
    }
  }, 15_000);
});
