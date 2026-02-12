/**
 * Phase 3: Multi-Region Deployment Configuration Tests
 *
 * Tests for infrastructure configuration validation:
 * - Fly.io deployment configs
 * - Oracle Cloud terraform configuration
 * - GCP standby configuration
 * - Failover script configuration
 *
 * @see ADR-003: Partitioned Chain Detectors
 * @see ADR-006: Free Hosting Provider Selection
 * @see ADR-007: Cross-Region Failover Strategy
 */

import * as fs from 'fs';
import * as path from 'path';
import * as toml from 'toml';
import * as yaml from 'yaml';

// Infrastructure paths
const INFRA_ROOT = path.join(__dirname, '..');
const FLY_DIR = path.join(INFRA_ROOT, 'fly');
const ORACLE_DIR = path.join(INFRA_ROOT, 'oracle', 'terraform');
const GCP_DIR = path.join(INFRA_ROOT, 'gcp');
const SCRIPTS_DIR = path.join(INFRA_ROOT, 'scripts');

// Infrastructure paths for docker compose
const DOCKER_DIR = path.join(INFRA_ROOT, 'docker');

// Partition configuration (should match partitions.ts)
const PARTITIONS = {
  'asia-fast': {
    chains: ['bsc', 'polygon', 'avalanche', 'fantom'],
    region: 'asia-southeast1',
    provider: 'oracle',
    memory: 768,
    port: 3011
  },
  'l2-turbo': {
    chains: ['arbitrum', 'optimism', 'base'],
    region: 'asia-southeast1',
    provider: 'fly',
    memory: 384,
    port: 3012
  },
  'high-value': {
    chains: ['ethereum', 'zksync', 'linea'],
    region: 'us-east1',
    provider: 'oracle',
    memory: 768,
    port: 3013
  },
  'solana-native': {
    chains: ['solana'],
    region: 'us-west1',
    provider: 'fly',
    memory: 512,
    port: 3016
  }
};

// =============================================================================
// Utility Functions
// =============================================================================

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function parseToml(content: string): any {
  return toml.parse(content);
}

function parseYaml(content: string): any {
  return yaml.parse(content);
}

// =============================================================================
// Phase 3: Fly.io Configuration Tests
// =============================================================================

describe('Phase 3: Fly.io Deployment Configuration', () => {
  describe('partition-l2-fast.toml', () => {
    const configPath = path.join(FLY_DIR, 'partition-l2-fast.toml');
    let config: any;

    beforeAll(() => {
      if (fileExists(configPath)) {
        config = parseToml(readFile(configPath));
      }
    });

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should have correct app name', () => {
      expect(config.app).toBe('arbitrage-l2-fast');
    });

    it('should deploy to Singapore region', () => {
      expect(config.primary_region).toBe('sin');
    });

    it('should set partition environment variables', () => {
      expect(config.env.PARTITION_ID).toBe('l2-turbo');
      expect(config.env.REGION_ID).toBe('asia-southeast1');
      expect(config.env.NODE_ENV).toBe('production');
    });

    it('should configure correct memory limit (384MB for l2-fast)', () => {
      expect(config.vm).toBeDefined();
      expect(config.vm.memory_mb).toBe(384);
      expect(config.vm.cpus).toBe(1);
      expect(config.vm.cpu_kind).toBe('shared');
    });

    it('should enable health checks', () => {
      expect(config.checks).toBeDefined();
      expect(config.checks.health).toBeDefined();
      expect(config.checks.health.path).toBe('/health');
    });

    it('should enable cross-region health reporting', () => {
      expect(config.env.ENABLE_CROSS_REGION_HEALTH).toBe('true');
    });

    it('should configure HTTP service', () => {
      expect(config.http_service).toBeDefined();
      expect(config.http_service.internal_port).toBe(3001);
    });
  });

  describe('coordinator-standby.toml', () => {
    const configPath = path.join(FLY_DIR, 'coordinator-standby.toml');
    let config: any;

    beforeAll(() => {
      if (fileExists(configPath)) {
        config = parseToml(readFile(configPath));
      }
    });

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should have correct app name', () => {
      expect(config.app).toBe('arbitrage-coordinator-standby');
    });

    it('should deploy to US West region (geographic redundancy)', () => {
      expect(config.primary_region).toBe('sjc');
    });

    it('should be configured as standby', () => {
      expect(config.env.IS_STANDBY).toBe('true');
      expect(config.env.CAN_BECOME_LEADER).toBe('true');
    });

    it('should use port 3000 for coordinator', () => {
      expect(config.http_service.internal_port).toBe(3000);
    });
  });

  describe('partition-solana.toml', () => {
    const configPath = path.join(FLY_DIR, 'partition-solana.toml');
    let config: any;

    beforeAll(() => {
      if (fileExists(configPath)) {
        config = parseToml(readFile(configPath));
      }
    });

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should have correct app name', () => {
      expect(config.app).toBe('arbitrage-solana');
    });

    it('should deploy to US West region (close to Solana validators)', () => {
      expect(config.primary_region).toBe('sjc');
    });

    it('should set partition environment variables', () => {
      expect(config.env.PARTITION_ID).toBe('solana-native');
      expect(config.env.PARTITION_CHAINS).toBe('solana');
      expect(config.env.REGION_ID).toBe('us-west1');
      expect(config.env.NODE_ENV).toBe('production');
    });

    it('should configure correct memory limit (512MB for Solana)', () => {
      expect(config.vm).toBeDefined();
      expect(config.vm.memory_mb).toBe(512);
      expect(config.vm.cpus).toBe(1);
      expect(config.vm.cpu_kind).toBe('shared');
    });

    it('should enable health checks', () => {
      expect(config.checks).toBeDefined();
      expect(config.checks.health).toBeDefined();
      expect(config.checks.health.path).toBe('/health');
      expect(config.checks.health.port).toBe(3001);
    });

    it('should enable cross-region health reporting', () => {
      expect(config.env.ENABLE_CROSS_REGION_HEALTH).toBe('true');
    });

    it('should configure HTTP service on port 3001', () => {
      expect(config.http_service).toBeDefined();
      expect(config.http_service.internal_port).toBe(3001);
    });

    it('should use partition-solana Dockerfile', () => {
      expect(config.build.dockerfile).toContain('partition-solana');
    });
  });

  describe('deploy.sh', () => {
    const scriptPath = path.join(FLY_DIR, 'deploy.sh');

    it('should exist', () => {
      expect(fileExists(scriptPath)).toBe(true);
    });

    it('should be executable shell script', () => {
      const content = readFile(scriptPath);
      expect(content.startsWith('#!/bin/bash')).toBe(true);
    });

    it('should define deployment functions', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('deploy_l2_fast');
      expect(content).toContain('deploy_solana');
      expect(content).toContain('deploy_coordinator_standby');
    });

    it('should check for fly CLI', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('fly');
    });
  });
});

// =============================================================================
// Phase 3: Docker Compose Configuration Tests
// =============================================================================

describe('Phase 3: Docker Compose Configuration', () => {
  describe('docker-compose.yml (base)', () => {
    const configPath = path.join(DOCKER_DIR, 'docker-compose.yml');
    let config: any;

    beforeAll(() => {
      if (fileExists(configPath)) {
        config = parseYaml(readFile(configPath));
      }
    });

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should define all required services', () => {
      const services = Object.keys(config.services);
      expect(services).toContain('redis');
      expect(services).toContain('unified-detector');
      expect(services).toContain('cross-chain-detector');
      expect(services).toContain('execution-engine');
      expect(services).toContain('coordinator');
    });

    it('should configure Redis with authentication', () => {
      const redis = config.services.redis;
      expect(redis.command).toContain('--requirepass');
    });

    it('should configure Redis healthcheck with auth', () => {
      const redis = config.services.redis;
      expect(redis.healthcheck).toBeDefined();
      expect(redis.healthcheck.test).toBeDefined();
      // Redis healthcheck should include auth flag
      const testCmd = Array.isArray(redis.healthcheck.test)
        ? redis.healthcheck.test.join(' ')
        : redis.healthcheck.test;
      expect(testCmd).toContain('-a');
    });

    it('should set HEALTH_CHECK_PORT on all detector services', () => {
      const detectorServices = ['unified-detector', 'cross-chain-detector', 'execution-engine'];
      for (const svc of detectorServices) {
        const envList = config.services[svc].environment;
        const envStr = Array.isArray(envList) ? envList.join(' ') : JSON.stringify(envList);
        expect(envStr).toContain('HEALTH_CHECK_PORT=3001');
      }
    });

    it('should configure healthchecks on all services', () => {
      const allServices = ['unified-detector', 'cross-chain-detector', 'execution-engine', 'coordinator'];
      for (const svc of allServices) {
        expect(config.services[svc].healthcheck).toBeDefined();
        expect(config.services[svc].healthcheck.test).toBeDefined();
      }
    });

    it('should use Redis password in all REDIS_URL references', () => {
      const servicesWithRedis = ['unified-detector', 'cross-chain-detector', 'execution-engine', 'coordinator'];
      for (const svc of servicesWithRedis) {
        const envList = config.services[svc].environment;
        const redisUrlEntry = envList.find((e: string) => e.startsWith('REDIS_URL='));
        expect(redisUrlEntry).toBeDefined();
        expect(redisUrlEntry).toContain('REDIS_PASSWORD');
      }
    });

    it('should have correct dependency chain', () => {
      // unified-detector depends on redis
      expect(config.services['unified-detector'].depends_on).toBeDefined();
      // cross-chain depends on unified-detector
      const crossChainDeps = config.services['cross-chain-detector'].depends_on;
      expect(crossChainDeps).toHaveProperty('unified-detector');
      // coordinator depends on all others
      const coordDeps = config.services.coordinator.depends_on;
      expect(coordDeps).toHaveProperty('redis');
      expect(coordDeps).toHaveProperty('unified-detector');
      expect(coordDeps).toHaveProperty('execution-engine');
    });

    it('should expose coordinator on port 3000', () => {
      const ports = config.services.coordinator.ports;
      expect(ports).toBeDefined();
      expect(ports.some((p: string) => p.includes('3000'))).toBe(true);
    });
  });

  describe('docker-compose.partition.yml (production)', () => {
    const configPath = path.join(DOCKER_DIR, 'docker-compose.partition.yml');
    let config: any;

    beforeAll(() => {
      if (fileExists(configPath)) {
        config = parseYaml(readFile(configPath));
      }
    });

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should define all partition services', () => {
      const services = Object.keys(config.services);
      expect(services).toContain('partition-asia-fast');
      expect(services).toContain('partition-l2-turbo');
      expect(services).toContain('partition-high-value');
      expect(services).toContain('partition-solana');
    });

    it('should map correct external ports per partition', () => {
      expect(config.services['partition-asia-fast'].ports).toContainEqual('3011:3001');
      expect(config.services['partition-l2-turbo'].ports).toContainEqual('3012:3001');
      expect(config.services['partition-high-value'].ports).toContainEqual('3013:3001');
      expect(config.services['partition-solana'].ports).toContainEqual('3016:3001');
    });

    it('should configure healthchecks on all services including coordinator', () => {
      const allServices = [
        'partition-asia-fast', 'partition-l2-turbo', 'partition-high-value',
        'partition-solana', 'cross-chain-detector', 'execution-engine', 'coordinator'
      ];
      for (const svc of allServices) {
        expect(config.services[svc].healthcheck).toBeDefined();
        expect(config.services[svc].healthcheck.interval).toBe('15s');
      }
    });

    it('should configure Redis with authentication', () => {
      const redis = config.services.redis;
      expect(redis.command).toContain('--requirepass');
    });

    it('should set correct PARTITION_ID for each partition', () => {
      const partitionEnvs: Record<string, string> = {
        'partition-asia-fast': 'asia-fast',
        'partition-l2-turbo': 'l2-turbo',
        'partition-high-value': 'high-value',
        'partition-solana': 'solana-native'
      };
      for (const [svc, expectedId] of Object.entries(partitionEnvs)) {
        const envList = config.services[svc].environment;
        const partitionEntry = envList.find((e: string) => e.startsWith('PARTITION_ID='));
        expect(partitionEntry).toBe(`PARTITION_ID=${expectedId}`);
      }
    });
  });
});

// =============================================================================
// Phase 3: Oracle Cloud Terraform Tests
// =============================================================================

describe('Phase 3: Oracle Cloud Terraform Configuration', () => {
  describe('variables.tf', () => {
    const configPath = path.join(ORACLE_DIR, 'variables.tf');

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should define region variables', () => {
      const content = readFile(configPath);
      expect(content).toContain('region_singapore');
      expect(content).toContain('region_us_east');
    });

    it('should define partition configurations', () => {
      const content = readFile(configPath);
      expect(content).toContain('partition_asia_fast');
      expect(content).toContain('partition_high_value');
    });

    it('should define sensitive variables for RPC URLs', () => {
      const content = readFile(configPath);
      expect(content).toContain('bsc_ws_url');
      expect(content).toContain('ethereum_ws_url');
      expect(content).toContain('sensitive   = true');
    });

    it('should use ARM instances for free tier', () => {
      const content = readFile(configPath);
      expect(content).toContain('VM.Standard.A1.Flex');
    });
  });

  describe('main.tf', () => {
    const configPath = path.join(ORACLE_DIR, 'main.tf');

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should define OCI provider', () => {
      const content = readFile(configPath);
      expect(content).toContain('provider "oci"');
    });

    it('should create VCN for Singapore region', () => {
      const content = readFile(configPath);
      expect(content).toContain('singapore_vcn');
    });

    it('should create VCN for US-East region', () => {
      const content = readFile(configPath);
      expect(content).toContain('us_east_vcn');
    });

    it('should create Asia-Fast partition instance', () => {
      const content = readFile(configPath);
      expect(content).toContain('asia_fast_partition');
    });

    it('should create High-Value partition instance', () => {
      const content = readFile(configPath);
      expect(content).toContain('high_value_partition');
    });

    it('should create Cross-Chain detector instance', () => {
      const content = readFile(configPath);
      expect(content).toContain('cross_chain_detector');
    });

    it('should configure security lists for health check ports', () => {
      const content = readFile(configPath);
      expect(content).toContain('3011');
      expect(content).toContain('3013');
    });
  });

  describe('outputs.tf', () => {
    const configPath = path.join(ORACLE_DIR, 'outputs.tf');

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should output public IPs', () => {
      const content = readFile(configPath);
      expect(content).toContain('public_ip');
    });

    it('should output health URLs', () => {
      const content = readFile(configPath);
      expect(content).toContain('health_url');
    });

    it('should output SSH commands', () => {
      const content = readFile(configPath);
      expect(content).toContain('ssh_commands');
    });
  });

  describe('cloud-init scripts', () => {
    const partitionScript = path.join(ORACLE_DIR, 'scripts', 'cloud-init-partition.yaml');
    const crossChainScript = path.join(ORACLE_DIR, 'scripts', 'cloud-init-cross-chain.yaml');

    it('should have partition cloud-init script', () => {
      expect(fileExists(partitionScript)).toBe(true);
    });

    it('should have cross-chain cloud-init script', () => {
      expect(fileExists(crossChainScript)).toBe(true);
    });

    it('should install Docker in partition script', () => {
      const content = readFile(partitionScript);
      expect(content).toContain('docker');
    });

    it('should configure health check cron job', () => {
      const content = readFile(partitionScript);
      expect(content).toContain('cron');
      expect(content).toContain('health-check');
    });
  });
});

// =============================================================================
// Phase 3: GCP Configuration Tests
// =============================================================================

describe('Phase 3: GCP Standby Configuration', () => {
  describe('coordinator-standby.yaml', () => {
    const configPath = path.join(GCP_DIR, 'coordinator-standby.yaml');
    let config: any;

    beforeAll(() => {
      if (fileExists(configPath)) {
        config = parseYaml(readFile(configPath));
      }
    });

    it('should exist', () => {
      expect(fileExists(configPath)).toBe(true);
    });

    it('should be a Knative service', () => {
      expect(config.apiVersion).toContain('serving.knative.dev');
      expect(config.kind).toBe('Service');
    });

    it('should have correct service name', () => {
      expect(config.metadata.name).toBe('arbitrage-coordinator-standby');
    });

    it('should configure resource limits', () => {
      const container = config.spec.template.spec.containers[0];
      expect(container.resources.limits.memory).toBeDefined();
    });

    it('should configure standby environment', () => {
      const container = config.spec.template.spec.containers[0];
      const envVars = container.env;
      const isStandby = envVars.find((e: any) => e.name === 'IS_STANDBY');
      expect(isStandby.value).toBe('true');
    });

    it('should configure health probes', () => {
      const container = config.spec.template.spec.containers[0];
      expect(container.livenessProbe).toBeDefined();
      expect(container.readinessProbe).toBeDefined();
    });
  });

  describe('deploy.sh', () => {
    const scriptPath = path.join(GCP_DIR, 'deploy.sh');

    it('should exist', () => {
      expect(fileExists(scriptPath)).toBe(true);
    });

    it('should use gcloud CLI', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('gcloud');
    });

    it('should deploy to Cloud Run', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('gcloud run deploy');
    });
  });
});

// =============================================================================
// Phase 3: Failover Scripts Tests
// =============================================================================

describe('Phase 3: Failover Automation Scripts', () => {
  describe('failover.sh', () => {
    const scriptPath = path.join(SCRIPTS_DIR, 'failover.sh');

    it('should exist', () => {
      expect(fileExists(scriptPath)).toBe(true);
    });

    it('should be executable shell script', () => {
      const content = readFile(scriptPath);
      expect(content.startsWith('#!/bin/bash')).toBe(true);
    });

    it('should define service endpoints', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('SERVICE_ENDPOINTS');
      expect(content).toContain('coordinator-primary');
      expect(content).toContain('partition-asia-fast');
    });

    it('should define standby service mappings', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('STANDBY_SERVICES');
    });

    it('should implement health checking', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('check_service_health');
      expect(content).toContain('check_all_health');
    });

    it('should implement failover triggering', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('trigger_failover');
      expect(content).toContain('activate_standby');
    });

    it('should support monitoring mode', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('monitor');
      expect(content).toContain('HEALTH_CHECK_INTERVAL');
    });

    it('should support configurable failover threshold', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('FAILOVER_THRESHOLD');
    });
  });

  describe('health-check.sh', () => {
    const scriptPath = path.join(SCRIPTS_DIR, 'health-check.sh');

    it('should exist', () => {
      expect(fileExists(scriptPath)).toBe(true);
    });

    it('should define all service endpoints', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('coordinator');
      expect(content).toContain('partition-asia-fast');
      expect(content).toContain('partition-l2-fast');
      expect(content).toContain('partition-high-value');
    });

    it('should support JSON output', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('--json');
      expect(content).toContain('output_json');
    });

    it('should support quiet mode', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('--quiet');
    });

    it('should check Redis health', () => {
      const content = readFile(scriptPath);
      expect(content).toContain('check_redis_health');
    });
  });
});

// =============================================================================
// Phase 3: Configuration Consistency Tests
// =============================================================================

describe('Phase 3: Configuration Consistency', () => {
  describe('port allocation consistency', () => {
    const portMappings = {
      'coordinator': 3000,
      'partition-asia-fast': 3011,
      'partition-l2-fast': 3012,
      'partition-high-value': 3013,
      'cross-chain-detector': 3014,
      'execution-engine': 3015,
      'partition-solana': 3016
    };

    it('should have unique ports across all services', () => {
      const ports = Object.values(portMappings);
      const uniquePorts = new Set(ports);
      expect(uniquePorts.size).toBe(ports.length);
    });

    it('should use consistent ports in failover script', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'failover.sh');
      expect(fileExists(scriptPath)).toBe(true);  // Fail fast if file missing
      const content = readFile(scriptPath);
      expect(content).toContain(':3011');
      expect(content).toContain(':3012');
      expect(content).toContain(':3013');
    });

    it('should use consistent ports in health-check script', () => {
      const scriptPath = path.join(SCRIPTS_DIR, 'health-check.sh');
      expect(fileExists(scriptPath)).toBe(true);  // Fail fast if file missing
      const content = readFile(scriptPath);
      expect(content).toContain(':3011');
      expect(content).toContain(':3012');
      expect(content).toContain(':3013');
    });
  });

  describe('region assignment consistency', () => {
    it('should assign asia-fast to Singapore/Asia-Southeast', () => {
      // Fly.io uses 'sin' for Singapore
      const flyConfig = path.join(FLY_DIR, 'partition-l2-fast.toml');
      expect(fileExists(flyConfig)).toBe(true);  // Fail fast if file missing
      const content = readFile(flyConfig);
      expect(content).toContain('sin');
    });

    it('should assign high-value to US-East', () => {
      const tfConfig = path.join(ORACLE_DIR, 'variables.tf');
      expect(fileExists(tfConfig)).toBe(true);  // Fail fast if file missing
      const content = readFile(tfConfig);
      expect(content).toContain('us-ashburn-1');
    });
  });

  describe('standby configuration consistency', () => {
    it('should configure coordinator standby as IS_STANDBY=true', () => {
      const flyStandby = path.join(FLY_DIR, 'coordinator-standby.toml');
      const gcpStandby = path.join(GCP_DIR, 'coordinator-standby.yaml');

      expect(fileExists(flyStandby)).toBe(true);  // Fail fast if file missing
      const flyContent = readFile(flyStandby);
      expect(flyContent).toContain('IS_STANDBY');
      expect(flyContent).toContain('"true"');

      expect(fileExists(gcpStandby)).toBe(true);  // Fail fast if file missing
      const gcpContent = readFile(gcpStandby);
      expect(gcpContent).toContain('IS_STANDBY');
      expect(gcpContent).toContain('true');
    });

    it('should enable leader election on standby', () => {
      const flyStandby = path.join(FLY_DIR, 'coordinator-standby.toml');
      expect(fileExists(flyStandby)).toBe(true);  // Fail fast if file missing
      const content = readFile(flyStandby);
      expect(content).toContain('CAN_BECOME_LEADER');
      expect(content).toContain('"true"');
    });
  });
});

// =============================================================================
// Phase 3: ADR Compliance Tests
// =============================================================================

describe('Phase 3: ADR Compliance', () => {
  describe('ADR-003: Partitioned Chain Detectors', () => {
    it('should have configurations for all three partitions', () => {
      // l2-fast on Fly.io
      expect(fileExists(path.join(FLY_DIR, 'partition-l2-fast.toml'))).toBe(true);

      // asia-fast and high-value on Oracle Cloud
      const tfMain = path.join(ORACLE_DIR, 'main.tf');
      expect(fileExists(tfMain)).toBe(true);  // Fail fast if file missing
      const content = readFile(tfMain);
      expect(content).toContain('asia_fast_partition');
      expect(content).toContain('high_value_partition');
    });
  });

  describe('ADR-006: Free Hosting Provider Selection', () => {
    it('should use Fly.io for L2-Fast partition', () => {
      expect(fileExists(path.join(FLY_DIR, 'partition-l2-fast.toml'))).toBe(true);
    });

    it('should use Oracle Cloud for heavy compute partitions', () => {
      const tfMain = path.join(ORACLE_DIR, 'main.tf');
      expect(fileExists(tfMain)).toBe(true);
    });

    it('should use GCP for coordinator standby', () => {
      expect(fileExists(path.join(GCP_DIR, 'coordinator-standby.yaml'))).toBe(true);
    });
  });

  describe('ADR-007: Cross-Region Failover Strategy', () => {
    it('should have standby coordinator configuration', () => {
      expect(fileExists(path.join(FLY_DIR, 'coordinator-standby.toml'))).toBe(true);
      expect(fileExists(path.join(GCP_DIR, 'coordinator-standby.yaml'))).toBe(true);
    });

    it('should have failover automation scripts', () => {
      expect(fileExists(path.join(SCRIPTS_DIR, 'failover.sh'))).toBe(true);
      expect(fileExists(path.join(SCRIPTS_DIR, 'health-check.sh'))).toBe(true);
    });

    it('should configure health checks in all deployment configs', () => {
      const flyL2Fast = path.join(FLY_DIR, 'partition-l2-fast.toml');
      expect(fileExists(flyL2Fast)).toBe(true);  // Fail fast if file missing
      const flyContent = readFile(flyL2Fast);
      expect(flyContent).toContain('health');

      const gcpStandby = path.join(GCP_DIR, 'coordinator-standby.yaml');
      expect(fileExists(gcpStandby)).toBe(true);  // Fail fast if file missing
      const gcpContent = readFile(gcpStandby);
      expect(gcpContent).toContain('livenessProbe');
      expect(gcpContent).toContain('readinessProbe');
    });
  });
});
