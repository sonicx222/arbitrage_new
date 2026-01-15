"use strict";
/**
 * Partition IDs - Standalone file to avoid circular dependencies
 *
 * This file contains only the partition ID constants with no imports,
 * allowing it to be imported by both index.ts and partitions.ts without
 * causing circular dependency issues.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PARTITION_IDS = void 0;
/**
 * Partition IDs - Use these constants instead of magic strings
 * to prevent typos and enable IDE autocomplete.
 */
exports.PARTITION_IDS = {
    ASIA_FAST: 'asia-fast',
    L2_TURBO: 'l2-turbo',
    HIGH_VALUE: 'high-value',
    SOLANA_NATIVE: 'solana-native'
};
//# sourceMappingURL=partition-ids.js.map