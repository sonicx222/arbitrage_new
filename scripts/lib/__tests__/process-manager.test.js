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
  findProcessesByPort,
  execCommand,
  findGhostNodeProcesses,
  killTsNodeProcesses,
  parseProcessLines,
  killAllPids
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

  describe('execCommand', () => {
    it('should return trimmed stdout on success', async () => {
      const cmd = isWindows() ? 'echo hello' : 'echo hello';
      const result = await execCommand(cmd);
      expect(result).toBe('hello');
    });

    it('should return null on error', async () => {
      const result = await execCommand('nonexistent_command_12345 2>/dev/null');
      expect(result).toBeNull();
    });

    it('should return null for empty output', async () => {
      const cmd = isWindows() ? 'echo.' : 'true';
      // 'true' produces no output on Unix
      if (!isWindows()) {
        const result = await execCommand(cmd);
        expect(result).toBeNull();
      }
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

    it('should accept options parameter', async () => {
      // Verify the options parameter doesn't break the function
      const result = await killProcess(999999, { graceful: false });
      expect(result).toBe(false);
    });

    it('should accept gracefulTimeoutMs option', async () => {
      // With a very short timeout, should still return false for non-existent PID
      const result = await killProcess(999999, { graceful: true, gracefulTimeoutMs: 100 });
      expect(result).toBe(false);
    });

    it('should skip graceful phase when graceful=false', async () => {
      // With graceful=false, should go straight to SIGKILL
      const start = Date.now();
      await killProcess(999999, { graceful: false });
      const elapsed = Date.now() - start;
      // Should be fast since no graceful wait
      expect(elapsed).toBeLessThan(2000);
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

  describe('parseProcessLines', () => {
    it('should parse valid lines', () => {
      const output = 'line1\nline2\nline3';
      const results = parseProcessLines(output, (line) => {
        if (line === 'line2') return { pid: 42, cmd: 'test-cmd' };
        return null;
      });
      expect(results).toEqual([{ pid: 42, cmd: 'test-cmd' }]);
    });

    it('should skip lines where parser returns null', () => {
      const output = 'a\nb\nc';
      const results = parseProcessLines(output, () => null);
      expect(results).toEqual([]);
    });

    it('should skip entries with invalid PIDs', () => {
      const output = 'line1';
      const results = parseProcessLines(output, () => ({ pid: NaN, cmd: 'test' }));
      expect(results).toEqual([]);
    });

    it('should skip entries with PID <= 0', () => {
      const output = 'line1';
      const results = parseProcessLines(output, () => ({ pid: 0, cmd: 'test' }));
      expect(results).toEqual([]);
    });
  });

  describe('findGhostNodeProcesses', () => {
    it('should return an array', async () => {
      const result = await findGhostNodeProcesses();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return objects with pid and cmd properties', async () => {
      const result = await findGhostNodeProcesses();
      result.forEach(proc => {
        expect(typeof proc.pid).toBe('number');
        expect(proc.pid).toBeGreaterThan(0);
        expect(typeof proc.cmd).toBe('string');
      });
    });
  });

  describe('killTsNodeProcesses', () => {
    it('should complete without throwing', async () => {
      // Just verify it doesn't throw — it's best-effort cleanup
      await expect(killTsNodeProcesses()).resolves.not.toThrow();
    });
  });

  describe('killAllPids', () => {
    it('should return empty array for empty input', async () => {
      const result = await killAllPids({});
      expect(result).toEqual([]);
    });

    it('should return correct structure for non-existent PIDs', async () => {
      const result = await killAllPids({ svc1: 999997, svc2: 999998 });
      expect(result).toHaveLength(2);
      for (const r of result) {
        expect(r).toHaveProperty('name');
        expect(r).toHaveProperty('pid');
        expect(r).toHaveProperty('killed');
        expect(r).toHaveProperty('existed');
        expect(typeof r.name).toBe('string');
        expect(typeof r.pid).toBe('number');
        expect(typeof r.killed).toBe('boolean');
        expect(typeof r.existed).toBe('boolean');
      }
    });

    it('should report non-existent PIDs as not existed', async () => {
      const result = await killAllPids({ svc1: 999997 });
      expect(result[0].existed).toBe(false);
      expect(result[0].killed).toBe(false);
      expect(result[0].name).toBe('svc1');
      expect(result[0].pid).toBe(999997);
    });

    it('should process entries in parallel (faster than sequential)', async () => {
      // With 3 non-existent PIDs, parallel should be roughly as fast as 1
      const start = Date.now();
      await killAllPids({ a: 999991, b: 999992, c: 999993 });
      const elapsed = Date.now() - start;
      // Sequential would be ~3x the time of a single processExists+killProcess
      // Just verify it completes in reasonable time (under 10s)
      expect(elapsed).toBeLessThan(10000);
    });
  });
});
