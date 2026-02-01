/**
 * Partition Configuration (DEPRECATED)
 *
 * @deprecated This file is deprecated since v1.0.0. Import from './partitions' instead.
 * This file will be removed in v2.0.0.
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

import { PARTITION_CONFIG as _PARTITION_CONFIG, PHASE_METRICS as _PHASE_METRICS } from './partitions';

/**
 * @deprecated Since v1.0.0. Use getChainsForPartition() from './partitions' instead.
 * Will be removed in v2.0.0.
 */
export const PARTITION_CONFIG = _PARTITION_CONFIG;

/**
 * @deprecated Since v1.0.0. Import PHASE_METRICS from './partitions' instead.
 * Will be removed in v2.0.0.
 */
export const PHASE_METRICS = _PHASE_METRICS;
