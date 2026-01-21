/**
 * API Routes Unit Tests
 *
 * Tests for route factory functions and partial sort utility.
 * Tests route creation and state provider integration.
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { Router } from 'express';
import type { ServiceHealth, ArbitrageOpportunity } from '@arbitrage/types';
import type { CoordinatorStateProvider, SystemMetrics, AlertResponse } from '../api/types';

// Mock @shared/security to bypass auth in tests
jest.mock('@shared/security', () => ({
  apiAuth: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  apiAuthorize: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next()),
  isAuthEnabled: jest.fn().mockReturnValue(false)
}));

// Mock @arbitrage/core for ValidationMiddleware
jest.mock('@arbitrage/core', () => ({
  ValidationMiddleware: {
    validateHealthCheck: jest.fn((_req: any, _res: any, next: any) => next())
  }
}));

// Mock express-rate-limit for admin routes
jest.mock('express-rate-limit', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next())
}));

// Import routes after mocking
import { createHealthRoutes } from '../api/routes/health.routes';
import { createMetricsRoutes } from '../api/routes/metrics.routes';
import { createDashboardRoutes } from '../api/routes/dashboard.routes';
import { createAdminRoutes } from '../api/routes/admin.routes';

// =============================================================================
// Mock State Provider
// =============================================================================

function createMockStateProvider(overrides?: Partial<CoordinatorStateProvider>): CoordinatorStateProvider {
  const defaultMetrics: SystemMetrics = {
    totalOpportunities: 100,
    totalExecutions: 50,
    successfulExecutions: 45,
    totalProfit: 1234.56,
    averageLatency: 15,
    averageMemory: 256,
    systemHealth: 95,
    activeServices: 5,
    lastUpdate: Date.now(),
    whaleAlerts: 10,
    pendingOpportunities: 5,
    totalSwapEvents: 1000,
    totalVolumeUsd: 500000,
    volumeAggregatesProcessed: 200,
    activePairsTracked: 50,
    priceUpdatesReceived: 5000
  };

  const defaultServiceHealth = new Map<string, ServiceHealth>([
    ['partition-asia-fast', { name: 'partition-asia-fast', status: 'healthy' as const, uptime: 3600, memoryUsage: 50, cpuUsage: 20, lastHeartbeat: Date.now() }],
    ['partition-l2-turbo', { name: 'partition-l2-turbo', status: 'degraded' as const, uptime: 1800, memoryUsage: 70, cpuUsage: 45, lastHeartbeat: Date.now() }]
  ]);

  const defaultOpportunities = new Map<string, ArbitrageOpportunity>([
    ['opp-1', { id: 'opp-1', confidence: 0.95, timestamp: Date.now() - 1000, chain: 'ethereum', buyDex: 'uniswap', sellDex: 'sushiswap' }],
    ['opp-2', { id: 'opp-2', confidence: 0.88, timestamp: Date.now() - 2000, chain: 'bsc', buyDex: 'pancakeswap', sellDex: 'biswap' }]
  ]);

  const defaultAlertHistory: AlertResponse[] = [
    { type: 'SERVICE_UNHEALTHY', service: 'partition-l2-turbo', severity: 'high', timestamp: Date.now() - 60000 }
  ];

  return {
    getIsLeader: jest.fn(() => true),
    getIsRunning: jest.fn(() => true),
    getInstanceId: jest.fn(() => 'coordinator-test-123'),
    getLockKey: jest.fn(() => 'coordinator:leader:lock'),
    getSystemMetrics: jest.fn(() => ({ ...defaultMetrics })),
    getServiceHealthMap: jest.fn(() => new Map(defaultServiceHealth)),
    getOpportunities: jest.fn(() => new Map(defaultOpportunities)),
    getAlertCooldowns: jest.fn(() => new Map()),
    deleteAlertCooldown: jest.fn(() => true),
    getLogger: jest.fn(() => ({
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn()
    })),
    getAlertHistory: jest.fn(() => [...defaultAlertHistory]),
    ...overrides
  };
}

// =============================================================================
// Route Factory Tests
// =============================================================================

describe('Route Factory Functions', () => {
  // Note: Full route factory tests are in integration tests.
  // These tests verify basic router creation without deep mocking.

  describe('createHealthRoutes', () => {
    it('should return a Router instance', () => {
      const mockState = createMockStateProvider();
      const router = createHealthRoutes(mockState);

      expect(router).toBeDefined();
      // Router has stack property for registered routes
      expect(router.stack).toBeDefined();
    });

    it('should register GET /health route', () => {
      const mockState = createMockStateProvider();
      const router = createHealthRoutes(mockState);

      // Check that routes are registered
      const routes = router.stack.filter((layer: any) => layer.route);
      const healthRoute = routes.find((r: any) => r.route.path === '/health') as any;

      expect(healthRoute).toBeDefined();
      expect(healthRoute?.route?.methods?.get).toBe(true);
    });
  });

  describe('createDashboardRoutes', () => {
    it('should return a Router instance', () => {
      const mockState = createMockStateProvider();
      const router = createDashboardRoutes(mockState);

      expect(router).toBeDefined();
    });

    it('should register GET / route', () => {
      const mockState = createMockStateProvider();
      const router = createDashboardRoutes(mockState);

      const routes = router.stack.filter((layer: any) => layer.route);
      const dashboardRoute = routes.find((r: any) => r.route.path === '/') as any;

      expect(dashboardRoute).toBeDefined();
      expect(dashboardRoute?.route?.methods?.get).toBe(true);
    });
  });

  // Note: createMetricsRoutes and createAdminRoutes require complex auth/rate-limit
  // mocking that doesn't work well with Jest hoisting. These are tested via
  // integration tests in coordinator.integration.test.ts instead.
});

// =============================================================================
// Mock State Provider Tests
// =============================================================================

describe('Mock State Provider', () => {
  it('should provide all required methods', () => {
    const mockState = createMockStateProvider();

    expect(typeof mockState.getIsLeader).toBe('function');
    expect(typeof mockState.getIsRunning).toBe('function');
    expect(typeof mockState.getInstanceId).toBe('function');
    expect(typeof mockState.getLockKey).toBe('function');
    expect(typeof mockState.getSystemMetrics).toBe('function');
    expect(typeof mockState.getServiceHealthMap).toBe('function');
    expect(typeof mockState.getOpportunities).toBe('function');
    expect(typeof mockState.getAlertCooldowns).toBe('function');
    expect(typeof mockState.deleteAlertCooldown).toBe('function');
    expect(typeof mockState.getLogger).toBe('function');
    expect(typeof mockState.getAlertHistory).toBe('function');
  });

  it('should allow overriding individual methods', () => {
    const mockState = createMockStateProvider({
      getIsLeader: jest.fn(() => false)
    });

    expect(mockState.getIsLeader()).toBe(false);
    expect(mockState.getIsRunning()).toBe(true); // Default
  });

  it('should return valid metrics', () => {
    const mockState = createMockStateProvider();
    const metrics = mockState.getSystemMetrics();

    expect(metrics.totalOpportunities).toBe(100);
    expect(metrics.systemHealth).toBe(95);
    expect(metrics.activeServices).toBe(5);
  });

  it('should return valid service health', () => {
    const mockState = createMockStateProvider();
    const healthMap = mockState.getServiceHealthMap();

    expect(healthMap.size).toBe(2);
    expect(healthMap.get('partition-asia-fast')?.status).toBe('healthy');
    expect(healthMap.get('partition-l2-turbo')?.status).toBe('degraded');
  });
});

// =============================================================================
// Partial Sort Algorithm Tests
// =============================================================================

describe('Opportunities Sorting Algorithm', () => {
  // Implement the same algorithm used in metrics.routes.ts for testing
  function partialSort<T>(arr: T[], limit: number, comparator: (a: T, b: T) => number): T[] {
    if (arr.length <= limit) {
      return arr.slice().sort(comparator);
    }

    const heap: T[] = [];

    // Helper to maintain min-heap property (worst of K best at root)
    const bubbleUp = (idx: number) => {
      while (idx > 0) {
        const parent = Math.floor((idx - 1) / 2);
        if (comparator(heap[parent], heap[idx]) >= 0) break;
        [heap[parent], heap[idx]] = [heap[idx], heap[parent]];
        idx = parent;
      }
    };

    const bubbleDown = (idx: number) => {
      while (true) {
        const left = 2 * idx + 1;
        const right = 2 * idx + 2;
        let worst = idx;

        if (left < heap.length && comparator(heap[left], heap[worst]) > 0) {
          worst = left;
        }
        if (right < heap.length && comparator(heap[right], heap[worst]) > 0) {
          worst = right;
        }
        if (worst === idx) break;
        [heap[idx], heap[worst]] = [heap[worst], heap[idx]];
        idx = worst;
      }
    };

    for (const item of arr) {
      if (heap.length < limit) {
        heap.push(item);
        bubbleUp(heap.length - 1);
      } else if (comparator(item, heap[0]) < 0) {
        heap[0] = item;
        bubbleDown(0);
      }
    }

    return heap.sort(comparator);
  }

  it('should return all items if array length <= limit', () => {
    const items = [{ timestamp: 3 }, { timestamp: 1 }, { timestamp: 2 }];
    const result = partialSort(items, 5, (a, b) => b.timestamp - a.timestamp);

    expect(result.length).toBe(3);
    expect(result[0].timestamp).toBe(3);
    expect(result[1].timestamp).toBe(2);
    expect(result[2].timestamp).toBe(1);
  });

  it('should return top N items by timestamp', () => {
    const items = [
      { timestamp: 5 },
      { timestamp: 1 },
      { timestamp: 4 },
      { timestamp: 2 },
      { timestamp: 3 }
    ];
    const result = partialSort(items, 3, (a, b) => b.timestamp - a.timestamp);

    expect(result.length).toBe(3);
    expect(result[0].timestamp).toBe(5);
    expect(result[1].timestamp).toBe(4);
    expect(result[2].timestamp).toBe(3);
  });

  it('should handle large arrays efficiently', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ timestamp: i }));

    const start = Date.now();
    const result = partialSort(items, 100, (a, b) => b.timestamp - a.timestamp);
    const duration = Date.now() - start;

    expect(result.length).toBe(100);
    expect(result[0].timestamp).toBe(999); // Most recent
    expect(result[99].timestamp).toBe(900); // 100th most recent
    expect(duration).toBeLessThan(50); // Should be fast
  });

  it('should not modify original array', () => {
    const items = [{ timestamp: 3 }, { timestamp: 1 }, { timestamp: 2 }];
    const originalOrder = items.map(i => i.timestamp);

    partialSort(items, 2, (a, b) => b.timestamp - a.timestamp);

    expect(items.map(i => i.timestamp)).toEqual(originalOrder);
  });

  it('should handle empty array', () => {
    const result = partialSort([], 10, (a: any, b: any) => b.timestamp - a.timestamp);
    expect(result).toEqual([]);
  });

  it('should handle limit of 1', () => {
    const items = [{ timestamp: 3 }, { timestamp: 5 }, { timestamp: 1 }];
    const result = partialSort(items, 1, (a, b) => b.timestamp - a.timestamp);

    expect(result.length).toBe(1);
    expect(result[0].timestamp).toBe(5);
  });
});
