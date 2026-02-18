/**
 * Unit tests for pid-manager.js
 *
 * Tests PID file management including load, save, update, remove,
 * and delete operations with file locking and symlink protection.
 *
 * @see scripts/lib/pid-manager.js
 */

const fs = require('fs');
const path = require('path');

jest.mock('fs');
jest.mock('../process-manager', () => ({
  processExists: jest.fn()
}));

const { processExists } = require('../process-manager');
const { ROOT_DIR } = require('../constants');

const PID_FILE = path.join(ROOT_DIR, '.local-services.pid');
const PID_LOCK_FILE = PID_FILE + '.lock';

const {
  loadPids,
  savePids,
  updatePid,
  removePid,
  deletePidFile
} = require('../pid-manager');

describe('pid-manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: lock file doesn't exist (lock acquisition succeeds on first try)
    let lockExists = false;
    fs.writeFileSync.mockImplementation((filePath, data, options) => {
      if (filePath === PID_LOCK_FILE && options && options.flag === 'wx') {
        if (lockExists) {
          const err = new Error('file exists');
          err.code = 'EEXIST';
          throw err;
        }
        lockExists = true;
        return;
      }
      // Normal writes (temp files, etc.) succeed
    });
    fs.unlinkSync.mockImplementation((filePath) => {
      if (filePath === PID_LOCK_FILE) {
        lockExists = false;
      }
    });
    fs.lstatSync.mockImplementation(() => {
      const err = new Error('no such file');
      err.code = 'ENOENT';
      throw err;
    });
    fs.renameSync.mockImplementation(() => {});
  });

  describe('loadPids', () => {
    it('should return empty object when PID file does not exist', () => {
      fs.existsSync.mockReturnValue(false);

      const result = loadPids();
      expect(result).toEqual({});
    });

    it('should return parsed PIDs when file exists', () => {
      const pids = { coordinator: 1234, 'partition-1': 5678 };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(pids));

      const result = loadPids();
      expect(result).toEqual(pids);
    });

    it('should return empty object when file has invalid JSON', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue('not json');

      const result = loadPids();
      expect(result).toEqual({});
    });

    it('should return empty object when readFileSync throws', () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => {
        throw new Error('permission denied');
      });

      const result = loadPids();
      expect(result).toEqual({});
    });
  });

  describe('savePids', () => {
    it('should write PIDs atomically via temp file and rename', () => {
      const pids = { coordinator: 1234 };

      savePids(pids);

      // Should write to temp file first
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        PID_FILE + '.tmp',
        JSON.stringify(pids, null, 2)
      );
      // Then rename to final location
      expect(fs.renameSync).toHaveBeenCalledWith(PID_FILE + '.tmp', PID_FILE);
    });

    it('should reject symlinks on the PID file path', () => {
      fs.lstatSync.mockReturnValue({
        isSymbolicLink: () => true
      });

      expect(() => savePids({ test: 1 })).toThrow('Security');
      expect(() => savePids({ test: 1 })).toThrow('symlink');
    });

    it('should clean up temp file when rename fails', () => {
      fs.renameSync.mockImplementation(() => {
        throw new Error('rename failed');
      });

      expect(() => savePids({ test: 1 })).toThrow('rename failed');
      // Temp file should be cleaned up
      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_FILE + '.tmp');
    });

    it('should not throw when temp file cleanup also fails', () => {
      fs.renameSync.mockImplementation(() => {
        throw new Error('rename failed');
      });
      // First call is the lock file unlink, override for temp file path
      const origUnlink = fs.unlinkSync.getMockImplementation();
      fs.unlinkSync.mockImplementation((filePath) => {
        if (filePath === PID_FILE + '.tmp') {
          throw new Error('cleanup failed');
        }
        if (origUnlink) origUnlink(filePath);
      });

      // Should still throw the rename error, not the cleanup error
      expect(() => savePids({ test: 1 })).toThrow('rename failed');
    });
  });

  describe('updatePid', () => {
    it('should acquire lock, update PID, save, and release lock', async () => {
      const existingPids = { coordinator: 1000 };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingPids));

      const result = await updatePid('execution', 2000);
      expect(result).toBe(true);

      // Should have written lock file
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        PID_LOCK_FILE,
        expect.any(String),
        { flag: 'wx' }
      );

      // Should have saved the merged PIDs
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        PID_FILE + '.tmp',
        expect.stringContaining('"execution": 2000')
      );

      // Should have released lock (unlinkSync on lock file)
      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_LOCK_FILE);
    });

    it('should throw when lock cannot be acquired within timeout', async () => {
      // Lock file always exists and holder process is alive
      fs.writeFileSync.mockImplementation((filePath, data, options) => {
        if (options && options.flag === 'wx') {
          const err = new Error('file exists');
          err.code = 'EEXIST';
          throw err;
        }
      });
      // Lock holder PID is readable and process exists
      fs.readFileSync.mockReturnValue('99999');
      processExists.mockResolvedValue(true);

      await expect(updatePid('test', 1234)).rejects.toThrow('Could not acquire PID lock');
    }, 15000);
  });

  describe('removePid', () => {
    it('should remove a PID entry and save remaining PIDs', async () => {
      const existingPids = { coordinator: 1000, execution: 2000 };
      fs.existsSync.mockImplementation((filePath) => {
        if (filePath === PID_FILE) return true;
        return false;
      });
      fs.readFileSync.mockReturnValue(JSON.stringify(existingPids));

      const result = await removePid('execution');
      expect(result).toBe(true);

      // Should save only the remaining PID
      const writeCall = fs.writeFileSync.mock.calls.find(
        call => call[0] === PID_FILE + '.tmp'
      );
      expect(writeCall).toBeDefined();
      const savedPids = JSON.parse(writeCall[1]);
      expect(savedPids).toEqual({ coordinator: 1000 });
      expect(savedPids).not.toHaveProperty('execution');
    });

    it('should delete PID file when last PID is removed', async () => {
      const existingPids = { coordinator: 1000 };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingPids));

      await removePid('coordinator');

      // deletePidFile should have been called - it calls existsSync + unlinkSync
      // for both PID_FILE and PID_LOCK_FILE
      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_FILE);
    });
  });

  describe('deletePidFile', () => {
    it('should delete both PID file and lock file', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {});

      deletePidFile();

      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_FILE);
      expect(fs.unlinkSync).toHaveBeenCalledWith(PID_LOCK_FILE);
    });

    it('should handle ENOENT gracefully (files already deleted)', () => {
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {
        const err = new Error('no such file');
        err.code = 'ENOENT';
        throw err;
      });

      expect(() => deletePidFile()).not.toThrow();
    });

    it('should warn on non-ENOENT errors without throwing', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      fs.existsSync.mockReturnValue(true);
      fs.unlinkSync.mockImplementation(() => {
        const err = new Error('permission denied');
        err.code = 'EACCES';
        throw err;
      });

      expect(() => deletePidFile()).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Could not delete')
      );
    });

    it('should skip files that do not exist', () => {
      fs.existsSync.mockReturnValue(false);

      deletePidFile();

      // unlinkSync should not be called since existsSync returned false
      // (except possibly from beforeEach lock cleanup, so check specifically for PID_FILE)
      const pidFileUnlinks = fs.unlinkSync.mock.calls.filter(
        call => call[0] === PID_FILE || call[0] === PID_LOCK_FILE
      );
      expect(pidFileUnlinks).toHaveLength(0);
    });
  });
});
