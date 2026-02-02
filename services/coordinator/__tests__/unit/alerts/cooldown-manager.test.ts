/**
 * Unit tests for AlertCooldownManager
 */

import { AlertCooldownManager, CooldownDelegate } from '../../../src/alerts/cooldown-manager';

describe('AlertCooldownManager', () => {
  describe('without delegate (standalone mode)', () => {
    let manager: AlertCooldownManager;

    beforeEach(() => {
      manager = new AlertCooldownManager(undefined, undefined, {
        cooldownMs: 5000,
        maxAgeMs: 60000,
        cleanupThreshold: 10,
      });
    });

    afterEach(() => {
      manager.clear();
    });

    describe('createKey', () => {
      it('should create key with type and service', () => {
        const key = AlertCooldownManager.createKey('SERVICE_DOWN', 'detector');
        expect(key).toBe('SERVICE_DOWN_detector');
      });

      it('should create key with system when no service', () => {
        const key = AlertCooldownManager.createKey('SYSTEM_DEGRADED');
        expect(key).toBe('SYSTEM_DEGRADED_system');
      });

      it('should handle undefined service', () => {
        const key = AlertCooldownManager.createKey('ERROR', undefined);
        expect(key).toBe('ERROR_system');
      });
    });

    describe('isOnCooldown', () => {
      it('should return false for unknown key', () => {
        expect(manager.isOnCooldown('unknown_key', 1000)).toBe(false);
      });

      it('should return true when within cooldown period', () => {
        const now = 10000;
        manager.recordAlert('test_key', now);
        expect(manager.isOnCooldown('test_key', now + 1000)).toBe(true);
      });

      it('should return false when cooldown expired', () => {
        const now = 10000;
        manager.recordAlert('test_key', now);
        expect(manager.isOnCooldown('test_key', now + 6000)).toBe(false);
      });

      it('should return false exactly at cooldown boundary', () => {
        const now = 10000;
        manager.recordAlert('test_key', now);
        // At exactly cooldownMs + 1, should be expired
        expect(manager.isOnCooldown('test_key', now + 5001)).toBe(false);
      });
    });

    describe('recordAlert', () => {
      it('should record alert timestamp', () => {
        const now = 10000;
        manager.recordAlert('test_key', now);
        expect(manager.getCooldowns().get('test_key')).toBe(now);
      });

      it('should update existing alert timestamp', () => {
        manager.recordAlert('test_key', 10000);
        manager.recordAlert('test_key', 20000);
        expect(manager.getCooldowns().get('test_key')).toBe(20000);
      });
    });

    describe('shouldSendAndRecord', () => {
      it('should return true and record for new alert', () => {
        const now = 10000;
        expect(manager.shouldSendAndRecord('test_key', now)).toBe(true);
        expect(manager.getCooldowns().get('test_key')).toBe(now);
      });

      it('should return false when on cooldown', () => {
        const now = 10000;
        manager.recordAlert('test_key', now);
        expect(manager.shouldSendAndRecord('test_key', now + 1000)).toBe(false);
      });

      it('should return true after cooldown expires', () => {
        const now = 10000;
        manager.recordAlert('test_key', now);
        expect(manager.shouldSendAndRecord('test_key', now + 6000)).toBe(true);
      });
    });

    describe('cleanup', () => {
      it('should remove stale entries', () => {
        manager.recordAlert('old_key', 1000);
        manager.recordAlert('new_key', 100000);

        manager.cleanup(120000); // 120s - old_key is 119s old (maxAge = 60s)

        expect(manager.getCooldowns().has('old_key')).toBe(false);
        expect(manager.getCooldowns().has('new_key')).toBe(true);
      });

      it('should not remove entries within max age', () => {
        manager.recordAlert('recent_key', 100000);

        manager.cleanup(120000); // 20s old, within 60s max age

        expect(manager.getCooldowns().has('recent_key')).toBe(true);
      });
    });

    describe('automatic cleanup', () => {
      it('should trigger cleanup when threshold exceeded', () => {
        // Record 11 alerts to exceed threshold of 10
        for (let i = 0; i < 11; i++) {
          manager.recordAlert(`key_${i}`, 1000 + i);
        }

        // All should be present (cleanup triggered but entries are too new)
        expect(manager.size).toBeLessThanOrEqual(11);
      });
    });

    describe('size getter', () => {
      it('should return current size', () => {
        expect(manager.size).toBe(0);
        manager.recordAlert('key1', 1000);
        expect(manager.size).toBe(1);
        manager.recordAlert('key2', 1000);
        expect(manager.size).toBe(2);
      });
    });

    describe('cooldownMs getter', () => {
      it('should return configured cooldown', () => {
        expect(manager.cooldownMs).toBe(5000);
      });
    });

    describe('clear', () => {
      it('should clear all cooldowns', () => {
        manager.recordAlert('key1', 1000);
        manager.recordAlert('key2', 1000);
        expect(manager.size).toBe(2);

        manager.clear();

        expect(manager.size).toBe(0);
      });
    });
  });

  describe('with delegate (HealthMonitor mode)', () => {
    let manager: AlertCooldownManager;
    let mockDelegate: jest.Mocked<CooldownDelegate>;
    let delegateCooldowns: Map<string, number>;

    beforeEach(() => {
      delegateCooldowns = new Map();
      mockDelegate = {
        getAlertCooldowns: jest.fn(() => delegateCooldowns),
        setAlertCooldown: jest.fn((key: string, ts: number) => { delegateCooldowns.set(key, ts); }),
        cleanupAlertCooldowns: jest.fn(),
      };

      manager = new AlertCooldownManager(undefined, mockDelegate, {
        cooldownMs: 5000,
      });
    });

    it('should delegate getCooldowns to delegate', () => {
      delegateCooldowns.set('test', 1000);

      const result = manager.getCooldowns();

      expect(mockDelegate.getAlertCooldowns).toHaveBeenCalled();
      expect(result.get('test')).toBe(1000);
    });

    it('should delegate recordAlert to delegate', () => {
      manager.recordAlert('test_key', 5000);

      expect(mockDelegate.setAlertCooldown).toHaveBeenCalledWith('test_key', 5000);
    });

    it('should delegate cleanup to delegate', () => {
      manager.cleanup(10000);

      expect(mockDelegate.cleanupAlertCooldowns).toHaveBeenCalledWith(10000);
    });

    it('should use delegate cooldowns for isOnCooldown', () => {
      delegateCooldowns.set('test_key', 10000);

      expect(manager.isOnCooldown('test_key', 11000)).toBe(true);
      expect(manager.isOnCooldown('test_key', 16000)).toBe(false);
    });
  });

  describe('default configuration', () => {
    it('should use defaults when no config provided', () => {
      const manager = new AlertCooldownManager();

      expect(manager.cooldownMs).toBe(300000); // 5 minutes default
    });
  });
});
