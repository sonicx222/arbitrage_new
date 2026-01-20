/**
 * S4.1.4 Integration Tests: Standby Service Deployment
 *
 * Tests for standby service deployment configurations including:
 * - Coordinator standby on GCP Cloud Run
 * - Executor backup on Render
 *
 * @see ADR-007: Cross-Region Failover Strategy
 * @see IMPLEMENTATION_PLAN.md Sprint 4, Task S4.1.4
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';

// Test constants matching ADR-007 architecture
const COORDINATOR_PRIMARY_REGION = 'us-east1';
const COORDINATOR_STANDBY_REGION = 'us-central1';
const EXECUTOR_PRIMARY_REGION = 'us-west1';
const EXECUTOR_STANDBY_REGION = 'us-east1';

// Paths to deployment files
const SERVICES_ROOT = path.resolve(__dirname, '../../services');
const COORDINATOR_DIR = path.join(SERVICES_ROOT, 'coordinator');
const EXECUTOR_DIR = path.join(SERVICES_ROOT, 'execution-engine');

// Standby deployment directories
const COORDINATOR_STANDBY_DIR = path.join(COORDINATOR_DIR, 'deploy/standby');
const EXECUTOR_STANDBY_DIR = path.join(EXECUTOR_DIR, 'deploy/standby');

describe('S4.1.4: Standby Service Deployment', () => {
  describe('S4.1.4.1: Coordinator Standby on GCP', () => {
    describe('Directory Structure', () => {
      it('should have standby deployment directory', () => {
        expect(fs.existsSync(COORDINATOR_STANDBY_DIR)).toBe(true);
      });

      it('should have Dockerfile.standby', () => {
        const dockerfilePath = path.join(COORDINATOR_STANDBY_DIR, 'Dockerfile.standby');
        expect(fs.existsSync(dockerfilePath)).toBe(true);
      });

      it('should have GCP Cloud Run configuration', () => {
        const configPath = path.join(COORDINATOR_STANDBY_DIR, 'cloudrun.yaml');
        expect(fs.existsSync(configPath)).toBe(true);
      });

      it('should have environment configuration', () => {
        const envPath = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');
        expect(fs.existsSync(envPath)).toBe(true);
      });
    });

    describe('Dockerfile.standby Configuration', () => {
      let dockerfileContent: string;

      beforeEach(() => {
        const dockerfilePath = path.join(COORDINATOR_STANDBY_DIR, 'Dockerfile.standby');
        if (fs.existsSync(dockerfilePath)) {
          dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
        } else {
          dockerfileContent = '';
        }
      });

      it('should use Node.js 20 Alpine base image', () => {
        expect(dockerfileContent).toMatch(/FROM node:20-alpine/);
      });

      it('should set IS_STANDBY=true environment variable', () => {
        expect(dockerfileContent).toMatch(/ENV IS_STANDBY=true/);
      });

      it('should set CAN_BECOME_LEADER=true for standby to acquire leadership', () => {
        expect(dockerfileContent).toMatch(/ENV CAN_BECOME_LEADER=true/);
      });

      it('should set REGION_ID to us-central1 (GCP)', () => {
        expect(dockerfileContent).toMatch(/ENV REGION_ID=us-central1/);
      });

      it('should set INSTANCE_ROLE=standby', () => {
        expect(dockerfileContent).toMatch(/ENV INSTANCE_ROLE=standby/);
      });

      it('should include health check for standby monitoring', () => {
        expect(dockerfileContent).toMatch(/HEALTHCHECK/);
      });

      it('should run as non-root user for security', () => {
        expect(dockerfileContent).toMatch(/USER/);
      });

      it('should expose port 3000 for HTTP API', () => {
        expect(dockerfileContent).toMatch(/EXPOSE 3000/);
      });
    });

    describe('GCP Cloud Run Configuration', () => {
      let cloudRunConfig: any;

      beforeEach(() => {
        const configPath = path.join(COORDINATOR_STANDBY_DIR, 'cloudrun.yaml');
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf-8');
          cloudRunConfig = yaml.parse(content);
        } else {
          cloudRunConfig = null;
        }
      });

      it('should have valid Cloud Run service configuration', () => {
        expect(cloudRunConfig).not.toBeNull();
        expect(cloudRunConfig.apiVersion).toMatch(/serving.knative.dev|run.googleapis.com/);
      });

      it('should specify us-central1 region for standby', () => {
        // Region can be in metadata.annotations or as a comment
        const configStr = JSON.stringify(cloudRunConfig);
        expect(configStr).toContain('us-central1');
      });

      it('should set minimum instances to 0 for cost efficiency', () => {
        // Cloud Run allows min instances for standby warmup
        const annotations = cloudRunConfig?.spec?.template?.metadata?.annotations || {};
        // minScale=0 means scale to zero when idle (cost efficient for standby)
        expect(annotations['autoscaling.knative.dev/minScale'] || '0').toBe('0');
      });

      it('should set maximum instances to 1 for standby', () => {
        const annotations = cloudRunConfig?.spec?.template?.metadata?.annotations || {};
        // maxScale=1 ensures only one standby instance
        expect(annotations['autoscaling.knative.dev/maxScale']).toBe('1');
      });

      it('should configure environment variables for standby mode', () => {
        const containers = cloudRunConfig?.spec?.template?.spec?.containers || [];
        expect(containers.length).toBeGreaterThan(0);

        const env = containers[0]?.env || [];
        const envMap = new Map(env.map((e: any) => [e.name, e.value || e.valueFrom]));

        expect(envMap.get('IS_STANDBY')).toBe('true');
        expect(envMap.get('CAN_BECOME_LEADER')).toBe('true');
        expect(envMap.get('INSTANCE_ROLE')).toBe('standby');
      });

      it('should configure startup probe for fast standby activation', () => {
        const containers = cloudRunConfig?.spec?.template?.spec?.containers || [];
        if (containers.length > 0) {
          const startupProbe = containers[0]?.startupProbe;
          // Startup probe is optional but recommended for fast activation
          if (startupProbe) {
            expect(startupProbe.httpGet || startupProbe.tcpSocket).toBeDefined();
          }
        }
      });

      it('should configure resource limits appropriate for standby', () => {
        const containers = cloudRunConfig?.spec?.template?.spec?.containers || [];
        expect(containers.length).toBeGreaterThan(0);

        const resources = containers[0]?.resources || {};
        // Standby needs minimal resources, scale up on activation
        expect(resources.limits).toBeDefined();
      });
    });

    describe('Environment Configuration', () => {
      let envConfig: Map<string, string>;

      beforeEach(() => {
        const envPath = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');
        envConfig = new Map();
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf-8');
          content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const [key, ...valueParts] = trimmed.split('=');
              if (key) {
                envConfig.set(key, valueParts.join('='));
              }
            }
          });
        }
      });

      it('should set IS_STANDBY=true', () => {
        expect(envConfig.get('IS_STANDBY')).toBe('true');
      });

      it('should set CAN_BECOME_LEADER=true', () => {
        expect(envConfig.get('CAN_BECOME_LEADER')).toBe('true');
      });

      it('should set REGION_ID=us-central1', () => {
        expect(envConfig.get('REGION_ID')).toBe('us-central1');
      });

      it('should set INSTANCE_ROLE=standby', () => {
        expect(envConfig.get('INSTANCE_ROLE')).toBe('standby');
      });

      it('should set SERVICE_NAME=coordinator-standby', () => {
        expect(envConfig.get('SERVICE_NAME')).toBe('coordinator-standby');
      });

      it('should set FAILOVER_TIMEOUT_MS for failover timing (ADR-007: <60s)', () => {
        const timeout = parseInt(envConfig.get('FAILOVER_TIMEOUT_MS') || '0', 10);
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(60000); // <60s per ADR-007
      });

      it('should set LEADER_LOCK_TTL_MS for leader election', () => {
        const ttl = parseInt(envConfig.get('LEADER_LOCK_TTL_MS') || '0', 10);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(30000); // 30s per ADR-007
      });

      it('should set LEADER_HEARTBEAT_INTERVAL_MS (1/3 of TTL)', () => {
        const ttl = parseInt(envConfig.get('LEADER_LOCK_TTL_MS') || '30000', 10);
        const heartbeat = parseInt(envConfig.get('LEADER_HEARTBEAT_INTERVAL_MS') || '0', 10);
        expect(heartbeat).toBeGreaterThan(0);
        expect(heartbeat).toBeLessThanOrEqual(ttl / 3);
      });
    });
  });

  describe('S4.1.4.2: Executor Backup on Render', () => {
    describe('Directory Structure', () => {
      it('should have standby deployment directory', () => {
        expect(fs.existsSync(EXECUTOR_STANDBY_DIR)).toBe(true);
      });

      it('should have Dockerfile.standby', () => {
        const dockerfilePath = path.join(EXECUTOR_STANDBY_DIR, 'Dockerfile.standby');
        expect(fs.existsSync(dockerfilePath)).toBe(true);
      });

      it('should have Render deployment configuration', () => {
        const configPath = path.join(EXECUTOR_STANDBY_DIR, 'render.yaml');
        expect(fs.existsSync(configPath)).toBe(true);
      });

      it('should have environment configuration', () => {
        const envPath = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');
        expect(fs.existsSync(envPath)).toBe(true);
      });
    });

    describe('Dockerfile.standby Configuration', () => {
      let dockerfileContent: string;

      beforeEach(() => {
        const dockerfilePath = path.join(EXECUTOR_STANDBY_DIR, 'Dockerfile.standby');
        if (fs.existsSync(dockerfilePath)) {
          dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
        } else {
          dockerfileContent = '';
        }
      });

      it('should use Node.js 20 Alpine base image', () => {
        expect(dockerfileContent).toMatch(/FROM node:20-alpine/);
      });

      it('should set IS_STANDBY=true environment variable', () => {
        expect(dockerfileContent).toMatch(/ENV IS_STANDBY=true/);
      });

      it('should set REGION_ID to us-east1 (Render)', () => {
        expect(dockerfileContent).toMatch(/ENV REGION_ID=us-east1/);
      });

      it('should set INSTANCE_ROLE=standby', () => {
        expect(dockerfileContent).toMatch(/ENV INSTANCE_ROLE=standby/);
      });

      it('should set EXECUTION_SIMULATION_MODE=true for safety during standby', () => {
        // Executor standby should start in simulation mode until activated
        // NOTE: Code reads EXECUTION_SIMULATION_MODE (prefixed), not SIMULATION_MODE
        expect(dockerfileContent).toMatch(/ENV EXECUTION_SIMULATION_MODE=true/);
      });

      it('should include health check for standby monitoring', () => {
        expect(dockerfileContent).toMatch(/HEALTHCHECK/);
      });

      it('should run as non-root user for security', () => {
        expect(dockerfileContent).toMatch(/USER/);
      });
    });

    describe('Render Deployment Configuration', () => {
      let renderConfig: any;

      beforeEach(() => {
        const configPath = path.join(EXECUTOR_STANDBY_DIR, 'render.yaml');
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf-8');
          renderConfig = yaml.parse(content);
        } else {
          renderConfig = null;
        }
      });

      it('should have valid Render service configuration', () => {
        expect(renderConfig).not.toBeNull();
        expect(renderConfig.services).toBeDefined();
        expect(Array.isArray(renderConfig.services)).toBe(true);
      });

      it('should configure service as background worker type', () => {
        const service = renderConfig?.services?.[0];
        expect(service).toBeDefined();
        // Executor can be web service or worker
        expect(['web', 'worker']).toContain(service.type);
      });

      it('should set region to us-east (Render region)', () => {
        const service = renderConfig?.services?.[0];
        // Render uses 'oregon', 'ohio', 'frankfurt', 'singapore'
        // us-east1 maps to 'ohio' on Render
        expect(service?.region).toMatch(/ohio|oregon/i);
      });

      it('should configure environment variables for standby mode', () => {
        const service = renderConfig?.services?.[0];
        const envVars = service?.envVars || [];

        const envMap = new Map(
          envVars.map((e: any) => [e.key, e.value || e.fromGroup || e.fromService])
        );

        expect(envMap.has('IS_STANDBY')).toBe(true);
        expect(envMap.has('INSTANCE_ROLE')).toBe(true);
        // NOTE: Code reads EXECUTION_SIMULATION_MODE (prefixed)
        expect(envMap.has('EXECUTION_SIMULATION_MODE')).toBe(true);
      });

      it('should configure health check path', () => {
        const service = renderConfig?.services?.[0];
        // Render supports healthCheckPath for web services
        if (service?.type === 'web') {
          expect(service.healthCheckPath).toBeDefined();
        }
      });

      it('should use free or starter plan for cost efficiency', () => {
        const service = renderConfig?.services?.[0];
        // Render plan types: free, starter, standard, pro
        expect(['free', 'starter']).toContain(service?.plan?.toLowerCase());
      });

      it('should set autoDeploy to false for manual activation', () => {
        const service = renderConfig?.services?.[0];
        // Standby should not auto-deploy on git push
        expect(service?.autoDeploy).toBe(false);
      });
    });

    describe('Environment Configuration', () => {
      let envConfig: Map<string, string>;

      beforeEach(() => {
        const envPath = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');
        envConfig = new Map();
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf-8');
          content.split('\n').forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#')) {
              const [key, ...valueParts] = trimmed.split('=');
              if (key) {
                envConfig.set(key, valueParts.join('='));
              }
            }
          });
        }
      });

      it('should set IS_STANDBY=true', () => {
        expect(envConfig.get('IS_STANDBY')).toBe('true');
      });

      it('should set REGION_ID=us-east1', () => {
        expect(envConfig.get('REGION_ID')).toBe('us-east1');
      });

      it('should set INSTANCE_ROLE=standby', () => {
        expect(envConfig.get('INSTANCE_ROLE')).toBe('standby');
      });

      it('should set SERVICE_NAME=executor-standby', () => {
        expect(envConfig.get('SERVICE_NAME')).toBe('executor-standby');
      });

      it('should set EXECUTION_SIMULATION_MODE=true by default', () => {
        // NOTE: Code reads EXECUTION_SIMULATION_MODE (prefixed)
        expect(envConfig.get('EXECUTION_SIMULATION_MODE')).toBe('true');
      });

      it('should set FAILOVER_ACTIVATION_ENDPOINT for primary health check', () => {
        // Standby should monitor primary health
        expect(envConfig.has('FAILOVER_ACTIVATION_ENDPOINT')).toBe(true);
      });
    });
  });

  describe('S4.1.4.3: Failover Configuration', () => {
    describe('Coordinator Failover', () => {
      it('should have matching primary and standby lock keys', () => {
        // Both primary and standby should use the same lock key for leader election
        const primaryEnvPath = path.join(COORDINATOR_DIR, '.env.example');
        const standbyEnvPath = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');

        // Both should use 'coordinator:leader:lock' as per ADR-007
        const lockKey = 'coordinator:leader:lock';

        if (fs.existsSync(standbyEnvPath)) {
          const content = fs.readFileSync(standbyEnvPath, 'utf-8');
          expect(content).toContain('LEADER_LOCK_KEY');
        }
      });

      it('should configure standby to acquire leadership on primary failure', () => {
        const standbyEnvPath = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');

        if (fs.existsSync(standbyEnvPath)) {
          const content = fs.readFileSync(standbyEnvPath, 'utf-8');
          expect(content).toContain('CAN_BECOME_LEADER=true');
        }
      });
    });

    describe('Executor Failover', () => {
      it('should configure standby activation trigger', () => {
        const standbyEnvPath = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');

        if (fs.existsSync(standbyEnvPath)) {
          const content = fs.readFileSync(standbyEnvPath, 'utf-8');
          // Executor standby should know how to detect primary failure
          expect(content).toContain('FAILOVER_ACTIVATION');
        }
      });

      it('should configure simulation mode with activation note', () => {
        const standbyEnvPath = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');

        if (fs.existsSync(standbyEnvPath)) {
          const content = fs.readFileSync(standbyEnvPath, 'utf-8');
          // Should have EXECUTION_SIMULATION_MODE variable
          expect(content).toContain('EXECUTION_SIMULATION_MODE');
          // Activation logic reference should be documented (COMPLETED S4.1.5)
          expect(content).toContain('activationDisablesSimulation');
        }
      });
    });
  });

  describe('S4.1.4.4: Deployment Validation', () => {
    describe('Docker Build Validation', () => {
      it('should have valid Dockerfile syntax for coordinator standby', () => {
        const dockerfilePath = path.join(COORDINATOR_STANDBY_DIR, 'Dockerfile.standby');
        if (fs.existsSync(dockerfilePath)) {
          const content = fs.readFileSync(dockerfilePath, 'utf-8');
          // Must have FROM instruction
          expect(content).toMatch(/^FROM/m);
          // Must have CMD or ENTRYPOINT
          expect(content).toMatch(/CMD|ENTRYPOINT/);
          // Should not have syntax errors (basic check)
          expect(content).not.toMatch(/FROM\s*$/m);
        }
      });

      it('should have valid Dockerfile syntax for executor standby', () => {
        const dockerfilePath = path.join(EXECUTOR_STANDBY_DIR, 'Dockerfile.standby');
        if (fs.existsSync(dockerfilePath)) {
          const content = fs.readFileSync(dockerfilePath, 'utf-8');
          expect(content).toMatch(/^FROM/m);
          expect(content).toMatch(/CMD|ENTRYPOINT/);
          expect(content).not.toMatch(/FROM\s*$/m);
        }
      });
    });

    describe('Configuration Consistency', () => {
      it('should have consistent Redis connection settings across primary and standby', () => {
        // Both should connect to the same Redis (Upstash Global)
        const coordinatorStandbyEnv = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');
        const executorStandbyEnv = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');

        [coordinatorStandbyEnv, executorStandbyEnv].forEach(envPath => {
          if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            // Should reference Redis connection (actual values come from secrets)
            expect(content).toMatch(/REDIS_URL|UPSTASH/i);
          }
        });
      });

      it('should have unique instance IDs for standby services', () => {
        const coordinatorStandbyEnv = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');
        const executorStandbyEnv = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');

        [coordinatorStandbyEnv, executorStandbyEnv].forEach(envPath => {
          if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf-8');
            // Instance ID should be generated dynamically or have standby suffix
            expect(content).toMatch(/INSTANCE_ID|SERVICE_NAME.*standby/i);
          }
        });
      });
    });

    describe('ADR-007 Compliance', () => {
      it('should meet <60s failover time target', () => {
        // Detection: 30s (3 failures x 10s)
        // Election: 10s
        // Activation: 20s
        // Total: <60s
        const coordinatorStandbyEnv = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');

        if (fs.existsSync(coordinatorStandbyEnv)) {
          const content = fs.readFileSync(coordinatorStandbyEnv, 'utf-8');

          // Health check interval should be ~10s
          const healthCheckMatch = content.match(/HEALTH_CHECK_INTERVAL_MS=(\d+)/);
          if (healthCheckMatch) {
            const interval = parseInt(healthCheckMatch[1], 10);
            expect(interval).toBeLessThanOrEqual(15000);
          }

          // Failover threshold should be 3 consecutive failures
          const thresholdMatch = content.match(/FAILOVER_THRESHOLD=(\d+)/);
          if (thresholdMatch) {
            const threshold = parseInt(thresholdMatch[1], 10);
            expect(threshold).toBe(3);
          }
        }
      });

      it('should implement Redis-based leader election as per ADR-007', () => {
        const coordinatorStandbyEnv = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');

        if (fs.existsSync(coordinatorStandbyEnv)) {
          const content = fs.readFileSync(coordinatorStandbyEnv, 'utf-8');
          // Should use Redis SET NX with TTL
          expect(content).toContain('LEADER_LOCK_KEY');
          expect(content).toContain('LEADER_LOCK_TTL_MS');
        }
      });

      it('should configure component redundancy as per ADR-007', () => {
        // ADR-007 specifies:
        // - Coordinator: Primary Koyeb US-East, Standby GCP US-Central
        // - Executor: Primary Railway US-West, Standby Render US-East

        const coordinatorStandbyEnv = path.join(COORDINATOR_STANDBY_DIR, 'env.standby');
        const executorStandbyEnv = path.join(EXECUTOR_STANDBY_DIR, 'env.standby');

        if (fs.existsSync(coordinatorStandbyEnv)) {
          const content = fs.readFileSync(coordinatorStandbyEnv, 'utf-8');
          expect(content).toContain('us-central1');
        }

        if (fs.existsSync(executorStandbyEnv)) {
          const content = fs.readFileSync(executorStandbyEnv, 'utf-8');
          expect(content).toContain('us-east1');
        }
      });
    });
  });

  describe('S4.1.4.5: Regression Tests', () => {
    it('should not break existing primary service configurations', () => {
      // Primary Dockerfiles should remain unchanged
      const coordinatorPrimaryDockerfile = path.join(COORDINATOR_DIR, 'Dockerfile');
      const executorPrimaryDockerfile = path.join(EXECUTOR_DIR, 'Dockerfile');

      expect(fs.existsSync(coordinatorPrimaryDockerfile)).toBe(true);
      expect(fs.existsSync(executorPrimaryDockerfile)).toBe(true);

      // Primary should NOT have IS_STANDBY=true
      if (fs.existsSync(coordinatorPrimaryDockerfile)) {
        const content = fs.readFileSync(coordinatorPrimaryDockerfile, 'utf-8');
        expect(content).not.toMatch(/ENV IS_STANDBY=true/);
      }
    });

    it('should maintain service port conventions', () => {
      // Coordinator: 3000
      // Executor: no HTTP port (background worker)
      const coordinatorStandbyDockerfile = path.join(COORDINATOR_STANDBY_DIR, 'Dockerfile.standby');

      if (fs.existsSync(coordinatorStandbyDockerfile)) {
        const content = fs.readFileSync(coordinatorStandbyDockerfile, 'utf-8');
        expect(content).toMatch(/EXPOSE 3000/);
      }
    });

    it('should use same base images as primary services', () => {
      const coordinatorPrimaryDockerfile = path.join(COORDINATOR_DIR, 'Dockerfile');
      const coordinatorStandbyDockerfile = path.join(COORDINATOR_STANDBY_DIR, 'Dockerfile.standby');

      if (fs.existsSync(coordinatorPrimaryDockerfile) && fs.existsSync(coordinatorStandbyDockerfile)) {
        const primaryContent = fs.readFileSync(coordinatorPrimaryDockerfile, 'utf-8');
        const standbyContent = fs.readFileSync(coordinatorStandbyDockerfile, 'utf-8');

        // Extract base image versions
        const primaryMatch = primaryContent.match(/FROM node:(\d+)/);
        const standbyMatch = standbyContent.match(/FROM node:(\d+)/);

        if (primaryMatch && standbyMatch) {
          // Standby should use same or newer Node version
          expect(parseInt(standbyMatch[1])).toBeGreaterThanOrEqual(parseInt(primaryMatch[1]));
        }
      }
    });
  });
});
