import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { getItem, setItem, removeItem } from './storage';

// Mock the global localStorage since jsdom's doesn't fully support spying
const mockStorage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage[key] ?? null),
  setItem: vi.fn((key: string, val: string) => { mockStorage[key] = val; }),
  removeItem: vi.fn((key: string) => { delete mockStorage[key]; }),
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, writable: true });
  for (const key of Object.keys(mockStorage)) delete mockStorage[key];
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storage', () => {
  describe('getItem', () => {
    it('returns stored value', () => {
      mockStorage['key'] = 'value';
      expect(getItem('key')).toBe('value');
    });

    it('returns null for missing key', () => {
      expect(getItem('missing')).toBeNull();
    });

    it('returns null when localStorage throws', () => {
      mockLocalStorage.getItem.mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(getItem('key')).toBeNull();
    });
  });

  describe('setItem', () => {
    it('stores value', () => {
      setItem('key', 'val');
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith('key', 'val');
    });

    it('does not throw when localStorage is blocked', () => {
      mockLocalStorage.setItem.mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });
      expect(() => setItem('key', 'value')).not.toThrow();
    });
  });

  describe('removeItem', () => {
    it('removes stored value', () => {
      mockStorage['key'] = 'value';
      removeItem('key');
      expect(mockLocalStorage.removeItem).toHaveBeenCalledWith('key');
    });

    it('does not throw when localStorage is blocked', () => {
      mockLocalStorage.removeItem.mockImplementation(() => {
        throw new Error('SecurityError');
      });
      expect(() => removeItem('key')).not.toThrow();
    });
  });
});
