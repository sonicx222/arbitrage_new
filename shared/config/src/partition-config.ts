/**
 * Partition Configuration (DEPRECATED)
 *
 * @deprecated This file is deprecated. Import from './partitions' instead.
 *
 * This file now re-exports from partitions.ts for backward compatibility.
 * All new code should import directly from partitions.ts.
 *
 * Migration:
 * - PARTITION_CONFIG → Use getChainsForPartition() from partitions.ts
 * - PHASE_METRICS → Import from partitions.ts
 *
 * @see partitions.ts - Single source of truth for partition configuration
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-008: Phase metrics and targets
 */

// Re-export from partitions.ts for backward compatibility
export { PARTITION_CONFIG, PHASE_METRICS } from './partitions';
