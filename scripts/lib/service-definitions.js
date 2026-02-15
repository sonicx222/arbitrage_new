#!/usr/bin/env node
/**
 * Service Definitions
 *
 * Defines all service configurations for the arbitrage system.
 * Pure data + simple accessor functions — no side effects.
 *
 * FIX M3: Extracted from services-config.js God Module.
 *
 * @see ADR-003: Partitioned Chain Detectors
 */

// Service Startup Constants (Task P2-2)
const {
  COORDINATOR_STARTUP_DELAY_MS,
  P1_STARTUP_DELAY_MS,
  P2_STARTUP_DELAY_MS,
  P3_STARTUP_DELAY_MS,
  CROSS_CHAIN_STARTUP_DELAY_MS,
  EXECUTION_ENGINE_STARTUP_DELAY_MS,
  UNIFIED_DETECTOR_STARTUP_DELAY_MS,
  P4_STARTUP_DELAY_MS
} = require('./constants');

// =============================================================================
// Service Definition Builder
// =============================================================================

/**
 * @typedef {Object} ServiceDef
 * @property {string} name - Display name
 * @property {string} script - Path to entry point (relative to ROOT_DIR)
 * @property {number} port - Port number
 * @property {string} healthEndpoint - Health check endpoint
 * @property {number} delay - Startup delay in ms
 * @property {Object<string, string|number>} [env] - Additional environment variables
 * @property {string} [type] - Service type ('node', 'docker', 'redis')
 * @property {string} [container] - Docker container name (for docker type)
 * @property {boolean} [optional] - Whether service is optional
 * @property {boolean} [enabled] - Whether service is enabled for local dev
 */

/**
 * Build all service definitions from a PORTS object.
 * This is a pure function: given ports, it returns service arrays.
 *
 * @param {Object} PORTS - Port mappings (from port-config.js)
 * @returns {{CORE_SERVICES: ServiceDef[], OPTIONAL_SERVICES: ServiceDef[], INFRASTRUCTURE_SERVICES: ServiceDef[], ALL_SERVICES: ServiceDef[], LOCAL_DEV_SERVICES: ServiceDef[], ALL_PORTS: Array<{name: string, port: number}>}}
 */
function buildServiceDefinitions(PORTS) {
  /**
   * Core services that should always be started for local development.
   * Order matters - services are started in this order.
   */
  const CORE_SERVICES = [
    {
      name: 'Coordinator',
      script: 'services/coordinator/src/index.ts',
      port: PORTS.COORDINATOR,
      healthEndpoint: '/api/health',
      delay: COORDINATOR_STARTUP_DELAY_MS,
      type: 'node',
      enabled: true
    },
    {
      name: 'P1 Asia-Fast Detector',
      script: 'services/partition-asia-fast/src/index.ts',
      port: PORTS.P1_ASIA_FAST,
      healthEndpoint: '/health',
      delay: P1_STARTUP_DELAY_MS,
      env: {
        PARTITION_ID: 'asia-fast',
        HEALTH_CHECK_PORT: PORTS.P1_ASIA_FAST
      },
      type: 'node',
      enabled: true
    },
    {
      name: 'P2 L2-Turbo Detector',
      script: 'services/partition-l2-turbo/src/index.ts',
      port: PORTS.P2_L2_TURBO,
      healthEndpoint: '/health',
      delay: P2_STARTUP_DELAY_MS,
      env: {
        PARTITION_ID: 'l2-turbo',
        HEALTH_CHECK_PORT: PORTS.P2_L2_TURBO
      },
      type: 'node',
      enabled: true
    },
    {
      name: 'P3 High-Value Detector',
      script: 'services/partition-high-value/src/index.ts',
      port: PORTS.P3_HIGH_VALUE,
      healthEndpoint: '/health',
      delay: P3_STARTUP_DELAY_MS,
      env: {
        PARTITION_ID: 'high-value',
        HEALTH_CHECK_PORT: PORTS.P3_HIGH_VALUE
      },
      type: 'node',
      enabled: true
    },
    {
      name: 'P4 Solana Detector',
      script: 'services/partition-solana/src/index.ts',
      port: PORTS.P4_SOLANA,
      healthEndpoint: '/health',
      delay: P4_STARTUP_DELAY_MS,
      env: { HEALTH_CHECK_PORT: PORTS.P4_SOLANA },
      type: 'node',
      enabled: true
    },
    {
      name: 'Cross-Chain Detector',
      script: 'services/cross-chain-detector/src/index.ts',
      port: PORTS.CROSS_CHAIN,
      healthEndpoint: '/health',
      delay: CROSS_CHAIN_STARTUP_DELAY_MS,
      env: { HEALTH_CHECK_PORT: PORTS.CROSS_CHAIN },
      type: 'node',
      enabled: true
    },
    {
      name: 'Execution Engine',
      script: 'services/execution-engine/src/index.ts',
      port: PORTS.EXECUTION_ENGINE,
      healthEndpoint: '/health',
      delay: EXECUTION_ENGINE_STARTUP_DELAY_MS,
      env: { HEALTH_CHECK_PORT: PORTS.EXECUTION_ENGINE },
      type: 'node',
      enabled: true
    }
  ];

  /** Optional services that can be started separately. */
  const OPTIONAL_SERVICES = [
    {
      name: 'Unified Detector',
      script: 'services/unified-detector/src/index.ts',
      port: PORTS.UNIFIED_DETECTOR,
      healthEndpoint: '/health',
      delay: UNIFIED_DETECTOR_STARTUP_DELAY_MS,
      env: { HEALTH_CHECK_PORT: PORTS.UNIFIED_DETECTOR },
      type: 'node',
      enabled: false,
      optional: true
    }
  ];

  /** Infrastructure services (Redis, monitoring). */
  const INFRASTRUCTURE_SERVICES = [
    {
      name: 'Redis',
      type: 'redis',
      container: 'arbitrage-redis',
      port: PORTS.REDIS,
      healthEndpoint: '',
      delay: 0,
      script: '',
      enabled: true
    },
    {
      name: 'Redis Commander',
      type: 'docker',
      container: 'arbitrage-redis-ui',
      port: PORTS.REDIS_UI,
      healthEndpoint: '',
      delay: 0,
      script: '',
      optional: true,
      enabled: false
    }
  ];

  /** All services combined (for status checking). */
  const ALL_SERVICES = [
    ...INFRASTRUCTURE_SERVICES,
    ...CORE_SERVICES,
    ...OPTIONAL_SERVICES
  ];

  /** Services to start in local development mode. */
  const LOCAL_DEV_SERVICES = CORE_SERVICES.filter(s => s.enabled);

  /** All ports used by services (for cleanup). */
  const ALL_PORTS = ALL_SERVICES.map(s => ({
    name: s.name,
    port: s.port
  }));

  return {
    CORE_SERVICES,
    OPTIONAL_SERVICES,
    INFRASTRUCTURE_SERVICES,
    ALL_SERVICES,
    LOCAL_DEV_SERVICES,
    ALL_PORTS
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get a service by name.
 * @param {ServiceDef[]} allServices - All services array
 * @param {string} name - Service name
 * @returns {ServiceDef | undefined}
 */
function getServiceByName(allServices, name) {
  return allServices.find(s => s.name === name);
}

/**
 * Get a service by port.
 * @param {ServiceDef[]} allServices - All services array
 * @param {number} port - Port number
 * @returns {ServiceDef | undefined}
 */
function getServiceByPort(allServices, port) {
  return allServices.find(s => s.port === port);
}

/**
 * Get services for startup (node services only).
 * @param {ServiceDef[]} coreServices - Core services
 * @param {ServiceDef[]} optionalServices - Optional services
 * @param {boolean} [includeOptional=false] - Include optional services
 * @returns {ServiceDef[]}
 */
function getStartupServices(coreServices, optionalServices, includeOptional = false) {
  if (includeOptional) {
    return [...coreServices, ...optionalServices];
  }
  return coreServices.filter(s => s.enabled);
}

module.exports = {
  buildServiceDefinitions,
  getServiceByName,
  getServiceByPort,
  getStartupServices
};
