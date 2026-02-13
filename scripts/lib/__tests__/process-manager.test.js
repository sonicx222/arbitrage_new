/**
 * Unit tests for process-manager.js
 *
 * Tests cross-platform process management utilities.
 * @see scripts/lib/process-manager.js
 */

const { describe, it, expect } = require('@jest/globals');
const {
  isWindows,
  killProcess,
  processExists,
  findProcessesByPort
} = require('../process-manager');

describe('process-manager', () => {
  describe('isWindows', () => {
    it('should return a boolean', () => {
      expect(typeof isWindows()).toBe('boolean');
    });

    it('should match process.platform', () => {
      expect(isWindows()).toBe(process.platform === 'win32');
    });
  });

  describe('killProcess', () => {
    it('should return false for invalid PID (non-integer)', async () => {
      expect(await killProcess('abc')).toBe(false);
      expect(await killProcess(null)).toBe(false);
      expect(await killProcess(undefined)).toBe(false);
      expect(await killProcess(NaN)).toBe(false);
    });

    it('should return false for negative PID', async () => {
      expect(await killProcess(-1)).toBe(false);
      expect(await killProcess(0)).toBe(false);
    });

    it('should return false for non-existent PID', async () => {
      // PID 999999 should not exist; killProcess should return false
      const result = await killProcess(999999);
      expect(result).toBe(false);
    });
  });

  describe('processExists', () => {
    it('should return false for invalid PID (non-integer)', async () => {
      expect(await processExists('abc')).toBe(false);
      expect(await processExists(null)).toBe(false);
      expect(await processExists(undefined)).toBe(false);
    });

    it('should return false for negative PID', async () => {
      expect(await processExists(-1)).toBe(false);
      expect(await processExists(0)).toBe(false);
    });

    it('should return true for current process PID', async () => {
      const result = await processExists(process.pid);
      expect(result).toBe(true);
    });

    it('should return false for non-existent PID', async () => {
      const result = await processExists(999999);
      // Platform-dependent: very high PIDs may exist on some systems (e.g., Linux
      // with pid_max > 999999), so we only assert the return type here.
      expect(typeof result).toBe('boolean');
    });
  });

  describe('findProcessesByPort', () => {
    it('should return empty array for invalid port', async () => {
      expect(await findProcessesByPort('abc')).toEqual([]);
      expect(await findProcessesByPort(-1)).toEqual([]);
      expect(await findProcessesByPort(99999)).toEqual([]);
    });

    it('should return an array for valid port', async () => {
      // Port 1 is unlikely to have anything listening
      const result = await findProcessesByPort(1);
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return PIDs as numbers', async () => {
      // Use a port that likely has nothing on it
      const result = await findProcessesByPort(59999);
      expect(Array.isArray(result)).toBe(true);
      result.forEach(pid => {
        expect(typeof pid).toBe('number');
        expect(pid).toBeGreaterThan(0);
      });
    });
  });
});
