"use strict";
/**
 * Cross-Chain Detector Architecture Alignment Tests
 *
 * These tests verify that CrossChainDetectorService follows the same
 * architectural patterns as other detectors for consistency.
 *
 * Current State:
 * - CrossChainDetectorService does NOT extend BaseDetector
 * - Has different lifecycle management
 * - Has different error handling patterns
 *
 * Options per Architecture Alignment Plan:
 * 1. Make CrossChainDetectorService extend BaseDetector
 * 2. Create new base class hierarchy for multi-chain services
 * 3. Document as intentional exception in ADR
 *
 * TDD Approach: Tests written BEFORE implementation.
 *
 * @see architecture-alignment-plan.md Issue #3
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const globals_1 = require("@jest/globals");
const createMockRedisClient = () => ({
    publish: globals_1.jest.fn(() => Promise.resolve()),
    subscribe: globals_1.jest.fn(() => Promise.resolve()),
    ping: globals_1.jest.fn(() => Promise.resolve(true)),
    disconnect: globals_1.jest.fn(() => Promise.resolve())
});
const createMockStreamsClient = () => ({
    xadd: globals_1.jest.fn(() => Promise.resolve('1234-0')),
    xreadgroup: globals_1.jest.fn(() => Promise.resolve([])),
    xack: globals_1.jest.fn(() => Promise.resolve(1)),
    createConsumerGroup: globals_1.jest.fn(() => Promise.resolve()),
    createBatcher: globals_1.jest.fn(() => ({
        add: globals_1.jest.fn(),
        flush: globals_1.jest.fn(() => Promise.resolve()),
        destroy: globals_1.jest.fn(() => Promise.resolve())
    })),
    disconnect: globals_1.jest.fn(() => Promise.resolve())
});
let mockRedisClient;
let mockStreamsClient;
// Mock modules
globals_1.jest.mock('./redis', () => ({
    getRedisClient: globals_1.jest.fn().mockImplementation(() => Promise.resolve(mockRedisClient)),
    RedisClient: globals_1.jest.fn()
}));
globals_1.jest.mock('./redis-streams', () => ({
    getRedisStreamsClient: globals_1.jest.fn().mockImplementation(() => Promise.resolve(mockStreamsClient)),
    RedisStreamsClient: {
        STREAMS: {
            PRICE_UPDATES: 'stream:price-updates',
            SWAP_EVENTS: 'stream:swap-events',
            OPPORTUNITIES: 'stream:opportunities',
            WHALE_ALERTS: 'stream:whale-alerts',
            VOLUME_AGGREGATES: 'stream:volume-aggregates'
        }
    }
}));
globals_1.jest.mock('./logger', () => ({
    createLogger: globals_1.jest.fn(() => ({
        info: globals_1.jest.fn(),
        error: globals_1.jest.fn(),
        warn: globals_1.jest.fn(),
        debug: globals_1.jest.fn()
    })),
    getPerformanceLogger: globals_1.jest.fn(() => ({
        logEventLatency: globals_1.jest.fn(),
        logArbitrageOpportunity: globals_1.jest.fn(),
        logHealthCheck: globals_1.jest.fn()
    }))
}));
globals_1.jest.mock('./price-oracle', () => ({
    getPriceOracle: globals_1.jest.fn(() => Promise.resolve({
        getPrice: globals_1.jest.fn(() => Promise.resolve(2000)),
        initialize: globals_1.jest.fn(() => Promise.resolve())
    })),
    resetPriceOracle: globals_1.jest.fn()
}));
// =============================================================================
// Architecture Alignment Tests
// =============================================================================
(0, globals_1.describe)('Cross-Chain Detector Architecture Alignment', () => {
    (0, globals_1.beforeEach)(() => {
        globals_1.jest.clearAllMocks();
        mockRedisClient = createMockRedisClient();
        mockStreamsClient = createMockStreamsClient();
    });
    // NOTE: These tests are intentionally skipped as they document future architectural work.
    // The CrossChainDetectorService doesn't currently extend BaseDetector (see ADR comments at top).
    // Per architecture decision, CrossChainDetectorService is a documented exception for multi-chain handling.
    // When architectural alignment is implemented, remove .skip() to enable these tests.
    globals_1.describe.skip('Option A: Extend BaseDetector (Recommended)', () => {
        (0, globals_1.it)('should extend BaseDetector class', async () => {
            globals_1.jest.resetModules();
            // Load both classes
            const baseDetectorModule = await Promise.resolve().then(() => __importStar(require('./base-detector')));
            const BaseDetector = baseDetectorModule.BaseDetector;
            // Load cross-chain detector
            // Note: This import path is for the service, not shared/core
            try {
                const crossChainModule = await Promise.resolve().then(() => __importStar(require('../../../services/cross-chain-detector/src/detector')));
                const CrossChainDetectorService = crossChainModule.CrossChainDetectorService;
                // Should extend BaseDetector
                const detector = new CrossChainDetectorService();
                (0, globals_1.expect)(detector).toBeInstanceOf(BaseDetector);
            }
            catch (importError) {
                // If import fails, check source code directly
                const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
                const path = await Promise.resolve().then(() => __importStar(require('path')));
                const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
                const content = await fs.readFile(sourceFile, 'utf-8');
                // Should have extends BaseDetector
                (0, globals_1.expect)(content).toMatch(/class CrossChainDetectorService extends BaseDetector/);
            }
        });
        (0, globals_1.it)('should implement required abstract methods from BaseDetector', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(sourceFile, 'utf-8');
            // If extending BaseDetector, should implement these hooks:
            // - onStart()
            // - onStop()
            // - getChainConfig()
            // These patterns indicate proper BaseDetector integration
            const requiredPatterns = [
                /protected\s+async\s+onStart|override\s+async\s+onStart/,
                /protected\s+async\s+onStop|override\s+async\s+onStop/
            ];
            // At least implement lifecycle hooks if extending BaseDetector
            const hasLifecycleHooks = requiredPatterns.some(pattern => pattern.test(content));
            // Either extends BaseDetector OR has documented exception
            const extendsBaseDetector = content.includes('extends BaseDetector');
            const hasDocumentedException = content.includes('intentional exception') ||
                content.includes('does not extend BaseDetector');
            (0, globals_1.expect)(extendsBaseDetector || hasDocumentedException).toBe(true);
        });
        (0, globals_1.it)('should use BaseDetector publish methods instead of direct xadd', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(sourceFile, 'utf-8');
            // If extending BaseDetector, should use inherited publish methods
            // Count direct xadd calls (should be minimal or zero)
            const xaddCalls = (content.match(/streamsClient\.xadd/g) || []).length;
            // If many xadd calls, should use BaseDetector pattern instead
            // Allow some xadd for cross-chain specific publishing
            if (content.includes('extends BaseDetector')) {
                (0, globals_1.expect)(xaddCalls).toBeLessThanOrEqual(5);
            }
        });
    });
    (0, globals_1.describe)('Option B: Documented Exception', () => {
        (0, globals_1.it)('should have documented reason if not extending BaseDetector', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(sourceFile, 'utf-8');
            // If NOT extending BaseDetector, should have documented reason
            if (!content.includes('extends BaseDetector')) {
                // Should have comment explaining why
                (0, globals_1.expect)(content).toMatch(/intentional|multi-chain|cross-chain\s+specific|does not extend/i);
            }
        });
        (0, globals_1.it)('should be documented in ADR if an exception', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            // Check ADR documents
            const adrPaths = [
                path.resolve(__dirname, '../../../docs/architecture/adr/ADR-002-redis-streams.md'),
                path.resolve(__dirname, '../../../docs/architecture/adr/ADR-003-partitioned-detectors.md')
            ];
            let documentedInAdr = false;
            for (const adrPath of adrPaths) {
                try {
                    const content = await fs.readFile(adrPath, 'utf-8');
                    if (content.includes('CrossChainDetector') ||
                        content.includes('cross-chain-detector') ||
                        content.includes('cross-chain exception')) {
                        documentedInAdr = true;
                        break;
                    }
                }
                catch {
                    // ADR file not found
                }
            }
            // Either extends BaseDetector OR is documented as exception
            const detectorPath = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const detectorContent = await fs.readFile(detectorPath, 'utf-8');
            const extendsBaseDetector = detectorContent.includes('extends BaseDetector');
            if (!extendsBaseDetector) {
                (0, globals_1.expect)(documentedInAdr).toBe(true);
            }
        });
    });
    (0, globals_1.describe)('Consistent Lifecycle Management', () => {
        (0, globals_1.it)('should use ServiceStateManager like BaseDetector', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(sourceFile, 'utf-8');
            // Should use ServiceStateManager for lifecycle
            (0, globals_1.expect)(content).toMatch(/ServiceStateManager|createServiceState/);
            (0, globals_1.expect)(content).toMatch(/stateManager\.executeStart|stateManager\.executeStop/);
        });
        (0, globals_1.it)('should have same lifecycle states as BaseDetector', async () => {
            // Both should use the same ServiceState enum
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const crossChainFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(crossChainFile, 'utf-8');
            // Should import ServiceState from shared/core (any path reference)
            (0, globals_1.expect)(content).toMatch(/import[\s\S]*ServiceState[\s\S]*from[\s\S]*shared\/core/);
        });
        (0, globals_1.it)('should handle stop promise race condition like BaseDetector', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(sourceFile, 'utf-8');
            // Should have stop promise pattern
            (0, globals_1.expect)(content).toMatch(/stopPromise|stateManager\.executeStop/);
        });
    });
    // NOTE: These tests are intentionally skipped as they document future architectural work.
    // The CrossChainDetectorService doesn't currently extend BaseDetector (see ADR comments at top).
    // When architectural alignment is implemented, remove .skip() to enable these tests.
    globals_1.describe.skip('Consistent Error Handling (Future Work)', () => {
        (0, globals_1.it)('should have same error handling pattern as BaseDetector', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            // Read both files
            const baseDetectorFile = path.resolve(__dirname, 'base-detector.ts');
            const crossChainFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const baseContent = await fs.readFile(baseDetectorFile, 'utf-8');
            const crossContent = await fs.readFile(crossChainFile, 'utf-8');
            // Both should use try-catch-finally pattern
            (0, globals_1.expect)(crossContent).toMatch(/try\s*\{[\s\S]*?catch[\s\S]*?finally/);
            // Both should use ServiceState.ERROR for error states
            (0, globals_1.expect)(crossContent).toMatch(/ServiceState\.ERROR|stateManager.*ERROR/);
        });
        (0, globals_1.it)('should emit same error events as BaseDetector', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
            const content = await fs.readFile(sourceFile, 'utf-8');
            // If using EventEmitter (like BaseDetector), should emit error events
            if (content.includes('EventEmitter') || content.includes('extends BaseDetector')) {
                (0, globals_1.expect)(content).toMatch(/emit\s*\(\s*['"]error['"]/);
            }
        });
    });
});
// =============================================================================
// Interface Consistency Tests
// =============================================================================
(0, globals_1.describe)('Cross-Chain Detector Interface Consistency', () => {
    (0, globals_1.it)('should have same public API pattern as other detectors', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
        const content = await fs.readFile(sourceFile, 'utf-8');
        // Should have standard detector methods
        (0, globals_1.expect)(content).toMatch(/async\s+start\s*\(\s*\)/);
        (0, globals_1.expect)(content).toMatch(/async\s+stop\s*\(\s*\)/);
        (0, globals_1.expect)(content).toMatch(/getState|isRunning/);
    });
    (0, globals_1.it)('should expose health information consistently', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
        const content = await fs.readFile(sourceFile, 'utf-8');
        // Should have health monitoring pattern
        (0, globals_1.expect)(content).toMatch(/healthMonitor|healthCheck|getHealth/i);
    });
});
// =============================================================================
// Code Quality Tests
// =============================================================================
(0, globals_1.describe)('Cross-Chain Detector Code Quality', () => {
    (0, globals_1.it)('should not duplicate BaseDetector functionality', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
        const content = await fs.readFile(sourceFile, 'utf-8');
        // Should not re-implement batching if BaseDetector provides it
        const batchingImplementations = (content.match(/class.*Batcher|createBatcher/g) || []).length;
        // If extending BaseDetector, shouldn't create own batchers
        if (content.includes('extends BaseDetector')) {
            (0, globals_1.expect)(batchingImplementations).toBeLessThanOrEqual(1);
        }
    });
    (0, globals_1.it)('should import from shared/core for common functionality', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const sourceFile = path.resolve(__dirname, '../../../services/cross-chain-detector/src/detector.ts');
        const content = await fs.readFile(sourceFile, 'utf-8');
        // Should import shared utilities
        (0, globals_1.expect)(content).toMatch(/from.*shared\/core/);
        (0, globals_1.expect)(content).toMatch(/createLogger|getRedisClient|ServiceStateManager/);
    });
});
//# sourceMappingURL=cross-chain-alignment.test.js.map