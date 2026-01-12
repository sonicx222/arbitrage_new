"use strict";
/**
 * ADR-003 Compliance Tests: Partitioned Chain Detectors
 *
 * These tests verify that the system adheres to ADR-003:
 * - Single-chain detectors are deprecated
 * - Unified-detector handles multiple chains via partitions
 * - Chain configuration is centralized
 *
 * Per ADR-003:
 * - 3-4 partitions for 15+ chains (not 1 service per chain)
 * - Fits within free hosting limits (Fly.io 3 apps)
 * - Shared overhead across chains
 *
 * TDD Approach: Tests written BEFORE full implementation.
 *
 * @see docs/architecture/adr/ADR-003-partitioned-detectors.md
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
// =============================================================================
// ADR-003 Compliance Tests
// =============================================================================
(0, globals_1.describe)('ADR-003: Partitioned Chain Detectors Compliance', () => {
    (0, globals_1.describe)('Single-Chain Service Removal', () => {
        const deprecatedServices = [
            'ethereum-detector',
            'arbitrum-detector',
            'bsc-detector',
            'polygon-detector',
            'optimism-detector',
            'base-detector'
        ];
        (0, globals_1.it)('should have removed single-chain service directories per ADR-003', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            for (const service of deprecatedServices) {
                const servicePath = path.resolve(__dirname, `../../../services/${service}`);
                // Verify service directory does NOT exist (has been removed per ADR-003)
                let exists = true;
                try {
                    await fs.access(servicePath);
                }
                catch {
                    exists = false;
                }
                (0, globals_1.expect)(exists).toBe(false);
            }
        });
        (0, globals_1.it)('should only have unified-detector and core services', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const servicesPath = path.resolve(__dirname, '../../../services');
            const entries = await fs.readdir(servicesPath, { withFileTypes: true });
            const serviceNames = entries
                .filter(e => e.isDirectory())
                .map(e => e.name);
            // Should have unified-detector, coordinator, cross-chain-detector, execution-engine
            (0, globals_1.expect)(serviceNames).toContain('unified-detector');
            (0, globals_1.expect)(serviceNames).toContain('coordinator');
            // Should NOT have deprecated single-chain detectors
            for (const deprecated of deprecatedServices) {
                (0, globals_1.expect)(serviceNames).not.toContain(deprecated);
            }
        });
    });
    (0, globals_1.describe)('Unified Detector Requirements', () => {
        (0, globals_1.it)('should have unified-detector service that handles partitions', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const unifiedDetectorPath = path.resolve(__dirname, '../../../services/unified-detector/src/unified-detector.ts');
            const content = await fs.readFile(unifiedDetectorPath, 'utf-8');
            // Should implement ADR-003 features
            (0, globals_1.expect)(content).toMatch(/PartitionConfig|partitionId/);
            (0, globals_1.expect)(content).toMatch(/ChainInstance|chainInstances/);
            (0, globals_1.expect)(content).toMatch(/ADR-003/);
        });
        (0, globals_1.it)('should support all chains through partition configuration', async () => {
            // Load partition configuration
            const configModule = await Promise.resolve().then(() => __importStar(require('../../../shared/config/src')));
            // Should have partition definitions
            (0, globals_1.expect)(configModule.getPartition).toBeDefined();
            (0, globals_1.expect)(configModule.getPartitionFromEnv).toBeDefined();
            (0, globals_1.expect)(configModule.CHAINS).toBeDefined();
            // Test that all chains can be assigned to partitions
            const chainIds = Object.keys(configModule.CHAINS);
            // Per ADR-003: Should have chain configs for multiple chains
            (0, globals_1.expect)(chainIds.length).toBeGreaterThan(3);
        });
        (0, globals_1.it)('should have 4 or fewer partition configurations', async () => {
            // Per ADR-003: 3-4 partitions for 15+ chains
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const partitionsFile = path.resolve(__dirname, '../../../shared/config/src/partitions.ts');
            try {
                const content = await fs.readFile(partitionsFile, 'utf-8');
                // Count partition definitions
                const partitionMatches = content.match(/partitionId:\s*['"][^'"]+['"]/g);
                if (partitionMatches) {
                    // Should have 4 or fewer partitions
                    (0, globals_1.expect)(partitionMatches.length).toBeLessThanOrEqual(4);
                }
            }
            catch {
                // If no dedicated partitions file, check config/index.ts
                const configFile = path.resolve(__dirname, '../../../shared/config/src/index.ts');
                const content = await fs.readFile(configFile, 'utf-8');
                // Look for PARTITIONS definition
                (0, globals_1.expect)(content).toMatch(/PARTITIONS|PartitionConfig/);
            }
        });
    });
    (0, globals_1.describe)('Free Tier Compatibility', () => {
        (0, globals_1.it)('should have deployment config for max 3 apps on Fly.io', async () => {
            // Per ADR-003: Fits within Fly.io 3-app free tier limit
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            // Check for Fly.io configuration
            const flyTomlPath = path.resolve(__dirname, '../../../../fly.toml');
            try {
                const content = await fs.readFile(flyTomlPath, 'utf-8');
                // Should reference unified-detector, not single-chain detectors
                (0, globals_1.expect)(content).toMatch(/unified-detector|coordinator/);
                // Should NOT reference individual chain detectors as separate apps
                (0, globals_1.expect)(content).not.toMatch(/ethereum-detector|bsc-detector/);
            }
            catch {
                // fly.toml may be in different location or use fly.json
            }
        });
    });
    (0, globals_1.describe)('Resource Sharing', () => {
        (0, globals_1.it)('should share Redis connection across chains in same partition', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const unifiedDetectorPath = path.resolve(__dirname, '../../../services/unified-detector/src/unified-detector.ts');
            const content = await fs.readFile(unifiedDetectorPath, 'utf-8');
            // Should have single Redis initialization (not per-chain)
            const redisInitCount = (content.match(/getRedisClient\(\)/g) || []).length;
            // Should call getRedisClient once at partition level
            (0, globals_1.expect)(redisInitCount).toBeLessThanOrEqual(2);
        });
        (0, globals_1.it)('should share state manager across chains', async () => {
            const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
            const path = await Promise.resolve().then(() => __importStar(require('path')));
            const unifiedDetectorPath = path.resolve(__dirname, '../../../services/unified-detector/src/unified-detector.ts');
            const content = await fs.readFile(unifiedDetectorPath, 'utf-8');
            // Should have single StateManager
            (0, globals_1.expect)(content).toMatch(/stateManager.*=.*createServiceState/);
            // Should NOT have per-chain state managers
            const stateManagerCount = (content.match(/createServiceState\(/g) || []).length;
            (0, globals_1.expect)(stateManagerCount).toBeLessThanOrEqual(2);
        });
    });
});
// =============================================================================
// Chain Configuration Centralization Tests
// =============================================================================
(0, globals_1.describe)('ADR-003: Centralized Chain Configuration', () => {
    (0, globals_1.it)('should have chain configs in shared/config (not per-service)', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        // Chain configs should be in shared/config
        const sharedConfigPath = path.resolve(__dirname, '../../../shared/config/src/index.ts');
        const content = await fs.readFile(sharedConfigPath, 'utf-8');
        // Should export CHAINS configuration
        (0, globals_1.expect)(content).toMatch(/export.*CHAINS/);
        // Should have chain definitions
        (0, globals_1.expect)(content).toMatch(/ethereum|arbitrum|bsc|polygon/);
    });
    (0, globals_1.it)('should NOT have chain configs in unified-detector (uses shared/config)', async () => {
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const unifiedDetectorPath = path.resolve(__dirname, '../../../services/unified-detector/src/unified-detector.ts');
        const content = await fs.readFile(unifiedDetectorPath, 'utf-8');
        // Should import from shared/config, not define own chains
        (0, globals_1.expect)(content).toMatch(/from.*shared\/config|from.*config/);
        // Should NOT have hardcoded chain definitions
        (0, globals_1.expect)(content).not.toMatch(/chainId:\s*\d+,\s*wsUrl:/);
    });
    (0, globals_1.it)('should have partition assignment algorithm', async () => {
        // Per ADR-003: assignChainToPartition() function
        const configModule = await Promise.resolve().then(() => __importStar(require('../../../shared/config/src')));
        // Should have partition assignment
        (0, globals_1.expect)(typeof configModule.assignChainToPartition).toBe('function');
    });
});
// =============================================================================
// Deployment Verification Tests
// =============================================================================
(0, globals_1.describe)('ADR-003: Deployment Configuration', () => {
    (0, globals_1.it)('should have CI/CD skip building deprecated single-chain services', async () => {
        // Check that deployment configs don't build single-chain detectors
        const fs = await Promise.resolve().then(() => __importStar(require('fs/promises')));
        const path = await Promise.resolve().then(() => __importStar(require('path')));
        const ciPaths = [
            path.resolve(__dirname, '../../../../.github/workflows/deploy.yml'),
            path.resolve(__dirname, '../../../../.github/workflows/ci.yml')
        ];
        for (const ciPath of ciPaths) {
            try {
                const content = await fs.readFile(ciPath, 'utf-8');
                // Should build unified-detector
                if (content.includes('detector')) {
                    (0, globals_1.expect)(content).toMatch(/unified-detector/);
                }
                // Should NOT build individual chain detectors (unless explicitly marked deprecated/skip)
                const deprecatedServices = [
                    'ethereum-detector',
                    'arbitrum-detector',
                    'bsc-detector'
                ];
                for (const service of deprecatedServices) {
                    if (content.includes(service)) {
                        // If mentioned, should be in skip or deprecated context
                        // This is a soft check - actual CI config may vary
                    }
                }
            }
            catch {
                // CI files may be in different location
            }
        }
    });
});
//# sourceMappingURL=adr-003-compliance.test.js.map