/**
 * Configuration Consistency Tests
 *
 * Regression tests to ensure all configuration sources remain consistent.
 * These tests prevent drift between:
 * - shared/constants/service-ports.json (single source of truth)
 * - shared/constants/deprecation-patterns.json (single source of truth)
 * - partition-router.ts (imports from JSON)
 * - services-config.js (imports from JSON)
 * - deprecation-checker.js (imports from JSON)
 *
 * @see Task 1.1: Deprecation Warning System
 * @see ADR-003: Partitioned Chain Detectors
 */

import { describe, it, expect } from '@jest/globals';

// Import from the single source of truth (JSON configs)
import portConfig from '../../service-ports.json';
import deprecationConfig from '../../deprecation-patterns.json';

// Import from TypeScript module that should derive from JSON
import {
  PARTITION_PORTS,
  SERVICE_PORTS,
  PARTITION_SERVICE_NAMES
} from '../../../core/src/partition-router';

describe('Configuration Consistency - Service Ports', () => {
  describe('JSON config structure', () => {
    it('should have required top-level keys', () => {
      expect(portConfig).toHaveProperty('services');
      expect(portConfig).toHaveProperty('partitions');
      expect(portConfig).toHaveProperty('partitionServiceNames');
      expect(portConfig).toHaveProperty('infrastructure');
      expect(portConfig).toHaveProperty('envVarMapping');
    });

    it('should have all expected services', () => {
      const expectedServices = [
        'coordinator',
        'partition-asia-fast',
        'partition-l2-turbo',
        'partition-high-value',
        'partition-solana',
        'execution-engine',
        'cross-chain-detector',
        'unified-detector'
      ] as const;

      const services = portConfig.services as Record<string, number>;
      for (const service of expectedServices) {
        expect(services).toHaveProperty(service);
        expect(typeof services[service]).toBe('number');
      }
    });

    it('should have all expected partitions', () => {
      const expectedPartitions = [
        'asia-fast',
        'l2-turbo',
        'high-value',
        'solana-native'
      ] as const;

      const partitions = portConfig.partitions as Record<string, number>;
      for (const partition of expectedPartitions) {
        expect(partitions).toHaveProperty(partition);
        expect(typeof partitions[partition]).toBe('number');
      }
    });

    it('should have unique port numbers for all services', () => {
      const ports = Object.values(portConfig.services);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });

    it('should have port numbers in valid range (3000-3999)', () => {
      for (const [service, port] of Object.entries(portConfig.services)) {
        expect(port).toBeGreaterThanOrEqual(3000);
        expect(port).toBeLessThan(4000);
      }
    });
  });

  describe('partition-router.ts consistency', () => {
    it('PARTITION_PORTS should match JSON partitions', () => {
      for (const [partition, port] of Object.entries(portConfig.partitions)) {
        expect(PARTITION_PORTS[partition]).toBe(port);
      }
    });

    it('SERVICE_PORTS should match JSON services', () => {
      for (const [service, port] of Object.entries(portConfig.services)) {
        expect(SERVICE_PORTS[service]).toBe(port);
      }
    });

    it('PARTITION_SERVICE_NAMES should match JSON partitionServiceNames', () => {
      for (const [partition, serviceName] of Object.entries(portConfig.partitionServiceNames)) {
        expect(PARTITION_SERVICE_NAMES[partition]).toBe(serviceName);
      }
    });
  });

  describe('port assignment rules (ADR-003)', () => {
    it('coordinator should be on port 3000', () => {
      expect(portConfig.services.coordinator).toBe(3000);
    });

    it('partition services should be on ports 3001-3004', () => {
      expect(portConfig.services['partition-asia-fast']).toBe(3001);
      expect(portConfig.services['partition-l2-turbo']).toBe(3002);
      expect(portConfig.services['partition-high-value']).toBe(3003);
      expect(portConfig.services['partition-solana']).toBe(3004);
    });

    it('execution-engine should be on port 3005', () => {
      expect(portConfig.services['execution-engine']).toBe(3005);
    });

    it('cross-chain-detector should be on port 3006', () => {
      expect(portConfig.services['cross-chain-detector']).toBe(3006);
    });

    it('unified-detector (deprecated) should be on port 3007', () => {
      expect(portConfig.services['unified-detector']).toBe(3007);
    });
  });
});

describe('Configuration Consistency - Deprecation Patterns', () => {
  describe('JSON config structure', () => {
    it('should have required top-level keys', () => {
      expect(deprecationConfig).toHaveProperty('services');
      expect(deprecationConfig).toHaveProperty('envVars');
    });

    it('should have schema and comment metadata', () => {
      expect(deprecationConfig).toHaveProperty('$schema');
      expect(deprecationConfig).toHaveProperty('$comment');
    });
  });

  describe('deprecated services (ADR-003)', () => {
    const expectedDeprecatedServices = [
      'ethereum-detector',
      'arbitrum-detector',
      'optimism-detector',
      'base-detector',
      'polygon-detector',
      'bsc-detector',
      'avalanche-detector',
      'fantom-detector',
      'zksync-detector',
      'linea-detector'
    ];

    it('should list all per-chain detectors as deprecated', () => {
      for (const service of expectedDeprecatedServices) {
        expect(deprecationConfig.services).toHaveProperty(service);
      }
    });

    it('should have replacement, since, and reason for each deprecated service', () => {
      for (const [service, info] of Object.entries(deprecationConfig.services)) {
        expect(info).toHaveProperty('replacement');
        expect(info).toHaveProperty('since');
        expect(info).toHaveProperty('reason');
        expect(typeof (info as any).replacement).toBe('string');
        expect(typeof (info as any).since).toBe('string');
        expect(typeof (info as any).reason).toBe('string');
      }
    });

    it('should reference ADR-003 in reason', () => {
      for (const [service, info] of Object.entries(deprecationConfig.services)) {
        expect((info as any).reason).toContain('ADR-003');
      }
    });

    it('should map to correct partition replacements', () => {
      // High-value partition
      expect(deprecationConfig.services['ethereum-detector'].replacement).toBe('partition-high-value');
      expect(deprecationConfig.services['zksync-detector'].replacement).toBe('partition-high-value');
      expect(deprecationConfig.services['linea-detector'].replacement).toBe('partition-high-value');

      // L2-turbo partition
      expect(deprecationConfig.services['arbitrum-detector'].replacement).toBe('partition-l2-turbo');
      expect(deprecationConfig.services['optimism-detector'].replacement).toBe('partition-l2-turbo');
      expect(deprecationConfig.services['base-detector'].replacement).toBe('partition-l2-turbo');

      // Asia-fast partition
      expect(deprecationConfig.services['polygon-detector'].replacement).toBe('partition-asia-fast');
      expect(deprecationConfig.services['bsc-detector'].replacement).toBe('partition-asia-fast');
      expect(deprecationConfig.services['avalanche-detector'].replacement).toBe('partition-asia-fast');
      expect(deprecationConfig.services['fantom-detector'].replacement).toBe('partition-asia-fast');
    });
  });

  describe('deprecated env vars (ADR-002)', () => {
    const expectedDeprecatedEnvVars = [
      'USE_REDIS_STREAMS',
      'USE_PUBSUB',
      'PUBSUB_ENABLED',
      'ENABLE_PUBSUB'
    ];

    it('should list all pub/sub related env vars as deprecated', () => {
      for (const envVar of expectedDeprecatedEnvVars) {
        expect(deprecationConfig.envVars).toHaveProperty(envVar);
      }
    });

    it('should have replacement, since, and reason for each deprecated env var', () => {
      for (const [envVar, info] of Object.entries(deprecationConfig.envVars)) {
        expect(info).toHaveProperty('replacement');
        expect(info).toHaveProperty('since');
        expect(info).toHaveProperty('reason');
        expect(typeof (info as any).replacement).toBe('string');
        expect(typeof (info as any).since).toBe('string');
        expect(typeof (info as any).reason).toBe('string');
      }
    });

    it('should reference ADR-002 in replacement or reason', () => {
      for (const [envVar, info] of Object.entries(deprecationConfig.envVars)) {
        const infoTyped = info as any;
        const mentionsADR002 =
          infoTyped.replacement.includes('ADR-002') ||
          infoTyped.reason.includes('ADR-002');
        expect(mentionsADR002).toBe(true);
      }
    });
  });

  describe('date format validation', () => {
    it('should have valid ISO date format for since fields in services', () => {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      for (const [service, info] of Object.entries(deprecationConfig.services)) {
        expect((info as any).since).toMatch(dateRegex);
      }
    });

    it('should have valid ISO date format for since fields in envVars', () => {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      for (const [envVar, info] of Object.entries(deprecationConfig.envVars)) {
        expect((info as any).since).toMatch(dateRegex);
      }
    });
  });
});

describe('Cross-file consistency validation', () => {
  it('partition ports should match between partitions and services', () => {
    // Ensure partition ports in JSON are consistent with service ports
    expect(portConfig.services['partition-asia-fast']).toBe(portConfig.partitions['asia-fast']);
    expect(portConfig.services['partition-l2-turbo']).toBe(portConfig.partitions['l2-turbo']);
    expect(portConfig.services['partition-high-value']).toBe(portConfig.partitions['high-value']);
    expect(portConfig.services['partition-solana']).toBe(portConfig.partitions['solana-native']);
  });

  it('partition service names should be consistent', () => {
    // Each partition's service name should correspond to a key in services
    for (const [partition, serviceName] of Object.entries(portConfig.partitionServiceNames)) {
      expect(portConfig.services).toHaveProperty(serviceName as string);
    }
  });

  it('env var mappings should reference valid services', () => {
    // Each key in envVarMapping should be a valid service in services or infrastructure
    // Structure: { "coordinator": "COORDINATOR_PORT", ... } (service -> envVarName)
    const allServiceNames = {
      ...portConfig.services,
      ...portConfig.infrastructure
    };
    for (const [serviceName] of Object.entries(portConfig.envVarMapping)) {
      expect(allServiceNames).toHaveProperty(serviceName);
    }
  });

  it('deprecated service replacements should be valid partition names', () => {
    const validPartitionServices = [
      'partition-asia-fast',
      'partition-l2-turbo',
      'partition-high-value',
      'partition-solana'
    ];

    for (const [service, info] of Object.entries(deprecationConfig.services)) {
      expect(validPartitionServices).toContain((info as any).replacement);
    }
  });
});
