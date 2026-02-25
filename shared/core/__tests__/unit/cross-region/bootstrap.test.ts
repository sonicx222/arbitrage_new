import { parseStandbyConfig } from '../../../src/cross-region/bootstrap';

describe('parseStandbyConfig', () => {
  const envBackup: Record<string, string | undefined> = {};
  const envKeys = [
    'IS_STANDBY', 'REGION_ID', 'SERVICE_NAME',
    'HEALTH_CHECK_INTERVAL_MS', 'FAILOVER_THRESHOLD', 'FAILOVER_TIMEOUT_MS',
    'LEADER_HEARTBEAT_INTERVAL_MS', 'LEADER_LOCK_TTL_MS',
  ];

  beforeEach(() => {
    for (const key of envKeys) {
      envBackup[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envBackup[key] !== undefined) {
        process.env[key] = envBackup[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('should parse isStandby=false by default', () => {
    const config = parseStandbyConfig('test-service');
    expect(config.isStandby).toBe(false);
  });

  it('should parse IS_STANDBY=true', () => {
    process.env.IS_STANDBY = 'true';
    const config = parseStandbyConfig('test-service');
    expect(config.isStandby).toBe(true);
  });

  it('should use service name as default', () => {
    const config = parseStandbyConfig('my-service');
    expect(config.serviceName).toBe('my-service');
  });

  it('should use SERVICE_NAME env override', () => {
    process.env.SERVICE_NAME = 'custom-name';
    const config = parseStandbyConfig('my-service');
    expect(config.serviceName).toBe('custom-name');
  });

  it('should include all cross-region health fields', () => {
    const config = parseStandbyConfig('test-service');
    expect(config).toHaveProperty('regionId');
    expect(config).toHaveProperty('healthCheckIntervalMs');
    expect(config).toHaveProperty('failoverThreshold');
    expect(config).toHaveProperty('failoverTimeoutMs');
    expect(config).toHaveProperty('leaderHeartbeatIntervalMs');
    expect(config).toHaveProperty('leaderLockTtlMs');
  });

  it('should use defaults for numeric fields', () => {
    const config = parseStandbyConfig('test-service');
    expect(config.regionId).toBe('us-east1');
    expect(config.healthCheckIntervalMs).toBe(10000);
    expect(config.failoverThreshold).toBe(3);
    expect(config.failoverTimeoutMs).toBe(60000);
  });
});
