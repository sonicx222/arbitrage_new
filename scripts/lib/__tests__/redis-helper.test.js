/**
 * Unit tests for redis-helper.js
 *
 * Tests Redis service utilities including Docker container checks,
 * memory Redis detection, and config file management.
 *
 * @see scripts/lib/redis-helper.js
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

jest.mock('fs');
jest.mock('child_process');

// Must mock before requiring redis-helper, since it reads constants at require time
const { ROOT_DIR } = require('../constants');
const REDIS_MEMORY_CONFIG_FILE = path.join(ROOT_DIR, '.redis-memory-config.json');

const {
  checkDockerContainer,
  checkDockerRedis,
  checkMemoryRedis,
  checkRedis,
  getRedisMemoryConfig,
  deleteRedisMemoryConfig
} = require('../redis-helper');

describe('redis-helper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('checkDockerContainer', () => {
    it('should return running: true when container is running', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(null, 'Up 2 hours', '');
      });

      const result = await checkDockerContainer('arbitrage-redis');
      expect(result).toEqual({ running: true, status: 'Up 2 hours' });
    });

    it('should return running: false when container is not running', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(null, '', '');
      });

      const result = await checkDockerContainer('arbitrage-redis');
      expect(result).toEqual({ running: false });
    });

    it('should return running: false when docker command errors', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(new Error('docker not found'), '', '');
      });

      const result = await checkDockerContainer('arbitrage-redis');
      expect(result).toEqual({ running: false });
    });

    it('should reject container names with shell injection characters', async () => {
      const result = await checkDockerContainer('redis; rm -rf /');
      expect(result).toEqual({ running: false });
      // exec should never be called for invalid names
      expect(exec).not.toHaveBeenCalled();
    });

    it('should accept valid container names with dots, hyphens, underscores', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(null, 'Up 1 hour', '');
      });

      const result = await checkDockerContainer('my_container-v1.2');
      expect(result).toEqual({ running: true, status: 'Up 1 hour' });
      expect(exec).toHaveBeenCalled();
    });
  });

  describe('checkDockerRedis', () => {
    it('should return true when arbitrage-redis container is Up', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(null, 'Up 5 minutes', '');
      });

      const result = await checkDockerRedis();
      expect(result).toBe(true);
    });

    it('should return false when container status does not include Up', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(null, 'Exited (1) 2 hours ago', '');
      });

      const result = await checkDockerRedis();
      expect(result).toBe(false);
    });

    it('should return false when docker command fails', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(new Error('docker not found'), '', '');
      });

      const result = await checkDockerRedis();
      expect(result).toBe(false);
    });
  });

  describe('checkMemoryRedis', () => {
    it('should return false when config file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);

      const result = await checkMemoryRedis();
      expect(result).toBe(false);
    });

    it('should return false when config file has invalid JSON', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not valid json');

      const result = await checkMemoryRedis();
      expect(result).toBe(false);
    });
  });

  describe('getRedisMemoryConfig', () => {
    it('should return null when config file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      const result = getRedisMemoryConfig();
      expect(result).toBeNull();
    });

    it('should return parsed config when file exists', () => {
      const config = { host: '127.0.0.1', port: 6380, pid: 12345 };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(config));

      const result = getRedisMemoryConfig();
      expect(result).toEqual(config);
    });

    it('should return null when file has invalid JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('bad json');

      const result = getRedisMemoryConfig();
      expect(result).toBeNull();
    });
  });

  describe('deleteRedisMemoryConfig', () => {
    it('should delete the config file', () => {
      fs.unlinkSync.mockImplementation(() => {});

      deleteRedisMemoryConfig();
      expect(fs.unlinkSync).toHaveBeenCalledWith(REDIS_MEMORY_CONFIG_FILE);
    });

    it('should ignore ENOENT errors (file already deleted)', () => {
      const err = new Error('file not found');
      err.code = 'ENOENT';
      fs.unlinkSync.mockImplementation(() => { throw err; });

      expect(() => deleteRedisMemoryConfig()).not.toThrow();
    });

    it('should rethrow non-ENOENT errors', () => {
      const err = new Error('permission denied');
      err.code = 'EACCES';
      fs.unlinkSync.mockImplementation(() => { throw err; });

      expect(() => deleteRedisMemoryConfig()).toThrow('permission denied');
    });
  });

  describe('checkRedis', () => {
    it('should return docker type when Docker Redis is running', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(null, 'Up 10 minutes', '');
      });

      const result = await checkRedis();
      expect(result).toEqual({ running: true, type: 'docker' });
    });

    it('should return running: false when no Redis is available', async () => {
      exec.mockImplementation((cmd, cb) => {
        cb(new Error('no docker'), '', '');
      });
      fs.existsSync.mockReturnValue(false);

      const result = await checkRedis();
      expect(result).toEqual({ running: false });
    });
  });
});
