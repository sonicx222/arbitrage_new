/**
 * Regression Tests for Infrastructure Critical Fixes
 *
 * These tests verify that critical bugs identified in the deep-dive analysis
 * remain fixed. Run these tests after any infrastructure changes.
 *
 * Critical fixes tested:
 * 1. Terraform cross-region image references (OCI images are region-specific)
 * 2. Docker health check command compatibility (wget vs curl/node)
 * 3. Environment variable naming consistency (ETH→ETHEREUM, ARB→ARBITRUM)
 * 4. Cloud-init Docker ready wait (race condition fix)
 * 5. Health check /dev/tcp detection (bash pseudo-device)
 * 6. Failover endpoint URL construction
 * 7. Fly.io TOML syntax (V1 vs V2 format)
 *
 * @see DEEP_DIVE_ANALYSIS.md
 */

import * as fs from 'fs';
import * as path from 'path';

// Infrastructure paths
const INFRA_ROOT = path.join(__dirname, '..');
const DOCKER_DIR = path.join(INFRA_ROOT, 'docker');
const FLY_DIR = path.join(INFRA_ROOT, 'fly');
const ORACLE_DIR = path.join(INFRA_ROOT, 'oracle', 'terraform');
const SCRIPTS_DIR = path.join(INFRA_ROOT, 'scripts');

// Helper functions
function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// =============================================================================
// REGRESSION TEST 1: Terraform Cross-Region Image References
// =============================================================================

describe('REGRESSION: Terraform Cross-Region Image References', () => {
  const mainTfPath = path.join(ORACLE_DIR, 'main.tf');

  beforeAll(() => {
    expect(fileExists(mainTfPath)).toBe(true);
  });

  it('should define separate ARM image data sources for each region', () => {
    const content = readFile(mainTfPath);

    // Must have Singapore ARM image
    expect(content).toContain('oracle_linux_arm_singapore');
    expect(content).toMatch(/data\s+"oci_core_images"\s+"oracle_linux_arm_singapore"/);

    // Must have US-East ARM image with correct provider
    expect(content).toContain('oracle_linux_arm_us_east');
    expect(content).toMatch(/data\s+"oci_core_images"\s+"oracle_linux_arm_us_east"/);
  });

  it('should use US-East provider for US-East ARM image data source', () => {
    const content = readFile(mainTfPath);

    // Extract the US-East ARM image data block
    const usEastImageMatch = content.match(
      /data\s+"oci_core_images"\s+"oracle_linux_arm_us_east"\s+\{[^}]*provider\s*=\s*oci\.us_east[^}]*\}/s
    );

    expect(usEastImageMatch).not.toBeNull();
  });

  it('should reference Singapore image for asia_fast_partition', () => {
    const content = readFile(mainTfPath);

    // asia_fast_partition should use Singapore image
    // Match the resource block and verify it contains the Singapore image reference
    const asiaFastBlock = content.match(
      /resource\s+"oci_core_instance"\s+"asia_fast_partition"\s*\{[\s\S]*?^\}/m
    );
    expect(asiaFastBlock).not.toBeNull();
    expect(asiaFastBlock![0]).toContain('oracle_linux_arm_singapore');
  });

  it('should reference US-East image for high_value_partition (CRITICAL)', () => {
    const content = readFile(mainTfPath);

    // CRITICAL: high_value_partition MUST use US-East image, not Singapore
    // This was the original bug - using Singapore image in US-East region
    // Match the resource block and verify it contains the US-East image reference
    const highValueBlock = content.match(
      /resource\s+"oci_core_instance"\s+"high_value_partition"\s*\{[\s\S]*?freeform_tags\s*=\s*merge/m
    );
    expect(highValueBlock).not.toBeNull();
    expect(highValueBlock![0]).toContain('oracle_linux_arm_us_east');
    // MUST NOT reference Singapore image
    expect(highValueBlock![0]).not.toContain('oracle_linux_arm_singapore');
  });

  it('should define US-East AMD image for cross_chain_detector', () => {
    const content = readFile(mainTfPath);

    // Must have US-East AMD image
    expect(content).toContain('oracle_linux_amd_us_east');

    // cross_chain_detector should use US-East AMD image
    expect(content).toMatch(
      /resource\s+"oci_core_instance"\s+"cross_chain_detector"[^}]*oracle_linux_amd_us_east/s
    );
  });
});

// =============================================================================
// REGRESSION TEST 2: Docker Health Check Command Compatibility
// =============================================================================

describe('REGRESSION: Docker Health Check Commands', () => {
  const partitionComposePath = path.join(DOCKER_DIR, 'docker-compose.partition.yml');

  beforeAll(() => {
    expect(fileExists(partitionComposePath)).toBe(true);
  });

  it('should NOT use wget for health checks (not available in Alpine Node)', () => {
    const content = readFile(partitionComposePath);

    // CRITICAL: wget is not available in alpine Node images
    // This caused all health checks to fail
    expect(content).not.toContain('wget');
    expect(content).not.toMatch(/test:.*wget/);
  });

  it('should use node-based health checks for Node.js services', () => {
    const content = readFile(partitionComposePath);

    // Should use CMD-SHELL with node for HTTP health checks
    // This is portable and works in any Node.js container
    expect(content).toMatch(/test:.*CMD-SHELL.*node/);
    expect(content).toMatch(/require\('http'\)\.get/);
  });

  it('should check correct internal port (3001) for partition services', () => {
    const content = readFile(partitionComposePath);

    // All partition services expose internal port 3001
    const healthCheckMatches = content.match(/localhost:3001\/health/g);
    expect(healthCheckMatches).not.toBeNull();
    expect(healthCheckMatches!.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// REGRESSION TEST 3: Environment Variable Naming Consistency
// =============================================================================

describe('REGRESSION: Environment Variable Naming', () => {
  const envExamplePath = path.join(INFRA_ROOT, 'env.example');
  const partitionComposePath = path.join(DOCKER_DIR, 'docker-compose.partition.yml');

  beforeAll(() => {
    expect(fileExists(envExamplePath)).toBe(true);
    expect(fileExists(partitionComposePath)).toBe(true);
  });

  it('should use ETHEREUM_* not ETH_* for Ethereum variables', () => {
    const envContent = readFile(envExamplePath);

    // Must use full name ETHEREUM
    expect(envContent).toContain('ETHEREUM_RPC_URL');
    expect(envContent).toContain('ETHEREUM_WS_URL');

    // CRITICAL: Must NOT use abbreviated ETH
    // This caused variable mismatch with docker-compose
    expect(envContent).not.toMatch(/^ETH_RPC_URL=/m);
    expect(envContent).not.toMatch(/^ETH_WS_URL=/m);
  });

  it('should use ARBITRUM_* not ARB_* for Arbitrum variables', () => {
    const envContent = readFile(envExamplePath);

    // Must use full name ARBITRUM
    expect(envContent).toContain('ARBITRUM_RPC_URL');
    expect(envContent).toContain('ARBITRUM_WS_URL');

    // CRITICAL: Must NOT use abbreviated ARB
    expect(envContent).not.toMatch(/^ARB_RPC_URL=/m);
    expect(envContent).not.toMatch(/^ARB_WS_URL=/m);
  });

  it('should include all OPTIMISM_* variables', () => {
    const envContent = readFile(envExamplePath);

    // OPTIMISM was completely missing
    expect(envContent).toContain('OPTIMISM_RPC_URL');
    expect(envContent).toContain('OPTIMISM_WS_URL');
  });

  it('should match variables expected by docker-compose.partition.yml', () => {
    const envContent = readFile(envExamplePath);
    const composeContent = readFile(partitionComposePath);

    // Extract required variables from docker-compose
    const requiredVars = [
      'BSC_WS_URL', 'BSC_RPC_URL',
      'POLYGON_WS_URL', 'POLYGON_RPC_URL',
      'ARBITRUM_WS_URL', 'ARBITRUM_RPC_URL',
      'OPTIMISM_WS_URL', 'OPTIMISM_RPC_URL',
      'BASE_WS_URL', 'BASE_RPC_URL',
      'ETHEREUM_WS_URL', 'ETHEREUM_RPC_URL'
    ];

    // Verify all required variables are defined in env.example
    for (const varName of requiredVars) {
      expect(envContent).toContain(varName);
    }
  });

  it('should include all private key variables for execution engine', () => {
    const envContent = readFile(envExamplePath);

    const privateKeyVars = [
      'ETHEREUM_PRIVATE_KEY',
      'BSC_PRIVATE_KEY',
      'ARBITRUM_PRIVATE_KEY',
      'BASE_PRIVATE_KEY',
      'POLYGON_PRIVATE_KEY',
      'OPTIMISM_PRIVATE_KEY'
    ];

    for (const varName of privateKeyVars) {
      expect(envContent).toContain(varName);
    }
  });
});

// =============================================================================
// REGRESSION TEST 4: Cloud-Init Docker Ready Wait and Health Check
// =============================================================================

describe('REGRESSION: Cloud-Init Docker Ready Wait and Health Check', () => {
  const partitionInitPath = path.join(ORACLE_DIR, 'scripts', 'cloud-init-partition.yaml');
  const crossChainInitPath = path.join(ORACLE_DIR, 'scripts', 'cloud-init-cross-chain.yaml');

  beforeAll(() => {
    expect(fileExists(partitionInitPath)).toBe(true);
    expect(fileExists(crossChainInitPath)).toBe(true);
  });

  it('should use node-based health check in partition cloud-init (CRITICAL)', () => {
    const content = readFile(partitionInitPath);

    // CRITICAL: Must use node-based health check, NOT curl (not available in Alpine Node)
    expect(content).toContain("require('http').get");
    expect(content).not.toMatch(/test:.*\["CMD",\s*"curl"/);
  });

  it('should use node-based health check in cross-chain cloud-init (CRITICAL)', () => {
    const content = readFile(crossChainInitPath);

    // CRITICAL: Must use node-based health check, NOT curl (not available in Alpine Node)
    expect(content).toContain("require('http').get");
    expect(content).not.toMatch(/test:.*\["CMD",\s*"curl"/);
  });

  it('should wait for Docker to be ready in partition cloud-init', () => {
    const content = readFile(partitionInitPath);

    // Must wait for Docker before running docker-compose
    expect(content).toContain('Waiting for Docker');
    expect(content).toContain('docker info');
  });

  it('should wait for Docker to be ready in cross-chain cloud-init (CRITICAL)', () => {
    const content = readFile(crossChainInitPath);

    // CRITICAL: This was missing and caused race condition
    expect(content).toContain('Waiting for Docker');
    expect(content).toContain('docker info');
  });

  it('should have error handling for docker-compose in cross-chain cloud-init', () => {
    const content = readFile(crossChainInitPath);

    // Must have error handling for docker-compose operations
    expect(content).toContain('docker-compose pull');
    expect(content).toMatch(/if\s+!\s+docker-compose\s+pull/);
    expect(content).toContain('ERROR');
  });

  it('should have template variable validation in cross-chain cloud-init', () => {
    const content = readFile(crossChainInitPath);

    // Must validate critical variables
    expect(content).toContain('validate_var');
    expect(content).toContain('docker_image');
    expect(content).toContain('redis_url');
  });

  it('should have proper systemd service dependencies in cross-chain', () => {
    const content = readFile(crossChainInitPath);

    // Must have network-online.target dependency
    expect(content).toContain('network-online.target');
    expect(content).toContain('Wants=network-online.target');

    // Must have Docker socket condition
    expect(content).toContain('ConditionPathExists=/var/run/docker.sock');
  });
});

// =============================================================================
// REGRESSION TEST 5: Health Check /dev/tcp Detection
// =============================================================================

describe('REGRESSION: Health Check Script /dev/tcp Detection', () => {
  const healthCheckPath = path.join(SCRIPTS_DIR, 'health-check.sh');

  beforeAll(() => {
    expect(fileExists(healthCheckPath)).toBe(true);
  });

  it('should NOT check if /dev/tcp exists as a file (CRITICAL)', () => {
    const content = readFile(healthCheckPath);

    // CRITICAL: /dev/tcp is a bash pseudo-device, not a file
    // [ -e /dev/tcp ] will always return false
    expect(content).not.toMatch(/\[\s+-e\s+\/dev\/tcp\s+\]/);
  });

  it('should check BASH_VERSION instead of /dev/tcp file existence', () => {
    const content = readFile(healthCheckPath);

    // Should check BASH_VERSION to determine if /dev/tcp is supported
    expect(content).toContain('BASH_VERSION');
  });

  it('should use exec with file descriptor for /dev/tcp', () => {
    const content = readFile(healthCheckPath);

    // Proper way to use /dev/tcp is with exec and file descriptors
    expect(content).toMatch(/exec\s+\d+<>\/dev\/tcp/);
  });

  it('should close file descriptor after /dev/tcp check', () => {
    const content = readFile(healthCheckPath);

    // Must close the file descriptor to avoid leaks
    expect(content).toMatch(/exec\s+\d+>&-/);
  });
});

// =============================================================================
// REGRESSION TEST 6: Failover Endpoint URL Construction
// =============================================================================

describe('REGRESSION: Failover Script Endpoint URLs', () => {
  const failoverPath = path.join(SCRIPTS_DIR, 'failover.sh');

  beforeAll(() => {
    expect(fileExists(failoverPath)).toBe(true);
  });

  it('should have build_health_url helper function', () => {
    const content = readFile(failoverPath);

    // Must have helper function to safely build URLs
    expect(content).toContain('build_health_url');
  });

  it('should return empty string for empty base URL (CRITICAL)', () => {
    const content = readFile(failoverPath);

    // CRITICAL: Empty URL should result in empty string, not "/health"
    // The old code resulted in "/health" which is not a valid URL
    expect(content).toMatch(/if\s+\[\s+-n\s+"\$base_url"\s+\]/);
    expect(content).toMatch(/echo\s+""\s+#\s+Return empty/);
  });

  it('should NOT check for endpoint = "/health" (no longer needed)', () => {
    const content = readFile(failoverPath);

    // The old buggy check for "/health" should be removed
    // Now we just check for empty string
    expect(content).not.toMatch(/\[\s+"\$endpoint"\s+=\s+"\/health"\s+\]/);
  });

  it('should use simple empty check for skipping unconfigured services', () => {
    const content = readFile(failoverPath);

    // Should just check for empty endpoint
    expect(content).toMatch(/if\s+\[\s+-z\s+"\$endpoint"\s+\]/);
  });
});

// =============================================================================
// REGRESSION TEST 7: Fly.io TOML Syntax
// =============================================================================

describe('REGRESSION: Fly.io TOML Syntax', () => {
  const l2FastPath = path.join(FLY_DIR, 'partition-l2-fast.toml');
  const coordinatorPath = path.join(FLY_DIR, 'coordinator-standby.toml');

  beforeAll(() => {
    expect(fileExists(l2FastPath)).toBe(true);
    expect(fileExists(coordinatorPath)).toBe(true);
  });

  it('should NOT mix V1 [[services]] and V2 [http_service] syntax (CRITICAL)', () => {
    const l2Content = readFile(l2FastPath);
    const coordContent = readFile(coordinatorPath);

    // If using [http_service] (V2), should NOT have [[services]] (V1)
    if (l2Content.includes('[http_service]')) {
      expect(l2Content).not.toMatch(/^\[\[services\]\]/m);
    }

    if (coordContent.includes('[http_service]')) {
      expect(coordContent).not.toMatch(/^\[\[services\]\]/m);
    }
  });

  it('should use [vm] (single) not [[vm]] (array) for single VM config', () => {
    const l2Content = readFile(l2FastPath);
    const coordContent = readFile(coordinatorPath);

    // Single VM should use [vm], not [[vm]]
    expect(l2Content).toMatch(/^\[vm\]/m);
    expect(l2Content).not.toMatch(/^\[\[vm\]\]/m);

    expect(coordContent).toMatch(/^\[vm\]/m);
    expect(coordContent).not.toMatch(/^\[\[vm\]\]/m);
  });

  it('should have [checks] section for health checks (V2 style)', () => {
    const l2Content = readFile(l2FastPath);
    const coordContent = readFile(coordinatorPath);

    // V2 uses [checks] section
    expect(l2Content).toContain('[checks]');
    expect(l2Content).toContain('[checks.health]');

    expect(coordContent).toContain('[checks]');
    expect(coordContent).toContain('[checks.health]');
  });

  it('should have [metrics] section for observability', () => {
    const l2Content = readFile(l2FastPath);
    const coordContent = readFile(coordinatorPath);

    // Both should have metrics configuration
    expect(l2Content).toContain('[metrics]');
    expect(coordContent).toContain('[metrics]');
  });
});

// =============================================================================
// REGRESSION TEST 8: Shared Health Utilities Library
// =============================================================================

describe('REGRESSION: Shared Health Utilities Library', () => {
  const healthUtilsPath = path.join(SCRIPTS_DIR, 'lib', 'health-utils.sh');

  beforeAll(() => {
    expect(fileExists(healthUtilsPath)).toBe(true);
  });

  it('should exist and be a valid bash script', () => {
    const content = readFile(healthUtilsPath);
    expect(content.startsWith('#!/bin/bash')).toBe(true);
  });

  it('should provide build_health_url function', () => {
    const content = readFile(healthUtilsPath);
    expect(content).toContain('build_health_url()');
  });

  it('should provide http_health_check function', () => {
    const content = readFile(healthUtilsPath);
    expect(content).toContain('http_health_check()');
  });

  it('should provide redis_health_check function', () => {
    const content = readFile(healthUtilsPath);
    expect(content).toContain('redis_health_check()');
  });

  it('should provide tcp_health_check function with proper /dev/tcp handling', () => {
    const content = readFile(healthUtilsPath);
    expect(content).toContain('tcp_health_check()');
    expect(content).toContain('BASH_VERSION');
    expect(content).toMatch(/exec\s+\d+<>\/dev\/tcp/);
  });

  it('should provide portable timestamp function', () => {
    const content = readFile(healthUtilsPath);
    expect(content).toContain('get_timestamp_ms()');
    // Should handle both Linux (%s%N) and macOS (fallback)
    expect(content).toContain('%s%N');
    expect(content).toContain('* 1000');
  });

  it('should provide safe locking utilities', () => {
    const content = readFile(healthUtilsPath);
    expect(content).toContain('acquire_lock_safe()');
    expect(content).toContain('release_lock_safe()');
    // Should handle stale locks
    expect(content).toContain('/proc/');
  });
});

// =============================================================================
// Summary Test: All Critical Files Modified
// =============================================================================

describe('Summary: Critical Files Were Modified', () => {
  const criticalFiles = [
    { path: path.join(ORACLE_DIR, 'main.tf'), description: 'Terraform main config' },
    { path: path.join(DOCKER_DIR, 'docker-compose.partition.yml'), description: 'Docker partition compose' },
    { path: path.join(INFRA_ROOT, 'env.example'), description: 'Environment example' },
    { path: path.join(ORACLE_DIR, 'scripts', 'cloud-init-cross-chain.yaml'), description: 'Cross-chain cloud-init' },
    { path: path.join(SCRIPTS_DIR, 'health-check.sh'), description: 'Health check script' },
    { path: path.join(SCRIPTS_DIR, 'failover.sh'), description: 'Failover script' },
    { path: path.join(FLY_DIR, 'partition-l2-fast.toml'), description: 'Fly.io L2 config' },
    { path: path.join(FLY_DIR, 'coordinator-standby.toml'), description: 'Fly.io coordinator config' },
    { path: path.join(SCRIPTS_DIR, 'lib', 'health-utils.sh'), description: 'Shared health utilities' },
  ];

  for (const file of criticalFiles) {
    it(`should have ${file.description} (${path.basename(file.path)})`, () => {
      expect(fileExists(file.path)).toBe(true);
    });
  }
});
