/**
 * Shared ANSI Color Codes for Contract Script Terminal Output
 *
 * Extracted from verify-interface-docs.ts and validate-router-config.ts
 * to eliminate duplication across contracts/scripts.
 */

export const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
};
