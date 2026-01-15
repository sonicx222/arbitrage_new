/**
 * Partition IDs - Standalone file to avoid circular dependencies
 *
 * This file contains only the partition ID constants with no imports,
 * allowing it to be imported by both index.ts and partitions.ts without
 * causing circular dependency issues.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */
/**
 * Partition IDs - Use these constants instead of magic strings
 * to prevent typos and enable IDE autocomplete.
 */
export declare const PARTITION_IDS: {
    readonly ASIA_FAST: "asia-fast";
    readonly L2_TURBO: "l2-turbo";
    readonly HIGH_VALUE: "high-value";
    readonly SOLANA_NATIVE: "solana-native";
};
export type PartitionId = typeof PARTITION_IDS[keyof typeof PARTITION_IDS];
//# sourceMappingURL=partition-ids.d.ts.map