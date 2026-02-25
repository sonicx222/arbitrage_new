/**
 * Tests for extractManualSections() in generate-addresses.ts
 *
 * Covers 5 code paths:
 * 1. Source file missing (readFileSync throws)
 * 2. File exists but no marker present
 * 3. File exists with marker — content preserved
 * 4. File exists with multiple markers — first marker used
 * 5. File exists with marker but empty manual section
 *
 * @see Finding #6 in docs/reports/DEEP_ANALYSIS_GIT_DIFF_2026-02-25.md
 */

import * as fs from 'fs';
import * as path from 'path';

// Mock fs module before importing the module under test
jest.mock('fs');
const mockedFs = fs as jest.Mocked<typeof fs>;

// Suppress console output during tests
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// Import after mocking fs
import { extractManualSections } from '../../scripts/generate-addresses';

const MANUAL_SECTION_MARKER = '// === MANUAL SECTIONS (preserved by generate-addresses.ts) ===';

describe('extractManualSections', () => {
  describe('Path 1: Source file missing', () => {
    it('should return empty string when file does not exist', () => {
      mockedFs.readFileSync.mockImplementation(() => {
        throw new Error('ENOENT: no such file or directory');
      });

      const result = extractManualSections();

      expect(result).toBe('');
    });
  });

  describe('Path 2: File exists but no marker', () => {
    it('should return empty string when no marker is found', () => {
      mockedFs.readFileSync.mockReturnValue(
        '// Some generated code\nexport const FOO = "bar";\n'
      );

      const result = extractManualSections();

      expect(result).toBe('');
    });
  });

  describe('Path 3: File with marker and manual content', () => {
    it('should extract everything from marker onwards', () => {
      const manualContent = `${MANUAL_SECTION_MARKER}\n// Router addresses\nexport const ROUTERS = {};\n`;
      const fileContent = `// Auto-generated header\nexport const FOO = "bar";\n\n${manualContent}`;

      mockedFs.readFileSync.mockReturnValue(fileContent);

      const result = extractManualSections();

      expect(result).toBe(manualContent);
      expect(result).toContain(MANUAL_SECTION_MARKER);
      expect(result).toContain('ROUTERS');
    });
  });

  describe('Path 4: File with multiple markers', () => {
    it('should extract from the first marker onwards (including second marker)', () => {
      const fileContent = [
        '// Header',
        MANUAL_SECTION_MARKER,
        '// First manual section',
        MANUAL_SECTION_MARKER,
        '// Second manual section',
      ].join('\n');

      mockedFs.readFileSync.mockReturnValue(fileContent);

      const result = extractManualSections();

      // Should start from first marker and include everything after
      expect(result.startsWith(MANUAL_SECTION_MARKER)).toBe(true);
      expect(result).toContain('First manual section');
      expect(result).toContain('Second manual section');
    });
  });

  describe('Path 5: Marker present but empty section after it', () => {
    it('should return just the marker line when no content follows', () => {
      const fileContent = `// Header\n${MANUAL_SECTION_MARKER}`;

      mockedFs.readFileSync.mockReturnValue(fileContent);

      const result = extractManualSections();

      expect(result).toBe(MANUAL_SECTION_MARKER);
    });
  });

  describe('Line count accuracy', () => {
    it('should correctly count lines in extracted content', () => {
      const manualLines = [
        MANUAL_SECTION_MARKER,
        '// Line 2',
        '// Line 3',
        '// Line 4',
        '',
      ];
      const fileContent = `// Header\n${manualLines.join('\n')}`;

      mockedFs.readFileSync.mockReturnValue(fileContent);

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      extractManualSections();

      // Should log "5 lines" (4 content lines + 1 trailing empty)
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('5 lines')
      );
    });
  });
});
