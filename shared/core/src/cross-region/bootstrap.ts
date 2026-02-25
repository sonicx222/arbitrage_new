/**
 * Shared standby configuration parsing for services that support cross-region failover.
 *
 * Both the coordinator and execution-engine services parse IS_STANDBY and
 * cross-region health settings at startup. This module consolidates the shared
 * parsing logic (ADR-007).
 *
 * @see ADR-007: Cross-Region Failover Strategy
 */
import { getCrossRegionEnvConfig, type CrossRegionEnvConfig } from '../utils/env-utils';

/**
 * Base standby configuration shared by all failover-capable services.
 * Each service extends this with its own specific fields.
 */
export interface StandbyBaseConfig extends CrossRegionEnvConfig {
  isStandby: boolean;
}

/**
 * Parse the common standby and cross-region config from environment variables.
 *
 * @param serviceName - Service name for cross-region health registration
 * @returns Base standby config including IS_STANDBY flag and all cross-region fields
 */
export function parseStandbyConfig(serviceName: string): StandbyBaseConfig {
  const isStandby = process.env.IS_STANDBY === 'true';
  const crossRegion = getCrossRegionEnvConfig(serviceName);
  return { isStandby, ...crossRegion };
}
