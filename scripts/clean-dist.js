#!/usr/bin/env node
/**
 * Cross-platform script to clean all dist folders
 * Works on Windows, macOS, and Linux
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// Directories to clean
const dirsToClean = [
  'dist',
  'shared/types/dist',
  'shared/core/dist',
  'shared/config/dist',
  'shared/security/dist',
  'shared/test-utils/dist',
  'shared/ml/dist',
  'services/coordinator/dist',
  'services/execution-engine/dist',
  'services/unified-detector/dist',
  'services/partition-asia-fast/dist',
  'services/partition-l2-turbo/dist',
  'services/partition-high-value/dist',
  'services/cross-chain-detector/dist',
  'infrastructure/redis/dist',
];

function rmdir(dir) {
  const fullPath = path.join(rootDir, dir);
  if (fs.existsSync(fullPath)) {
    fs.rmSync(fullPath, { recursive: true, force: true });
    console.log(`Cleaned: ${dir}`);
    return true;
  }
  return false;
}

console.log('Cleaning dist folders...\n');

let cleaned = 0;
for (const dir of dirsToClean) {
  if (rmdir(dir)) {
    cleaned++;
  }
}

// Also clean any .tsbuildinfo files
function cleanTsBuildInfo(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        cleanTsBuildInfo(fullPath);
      } else if (entry.name.endsWith('.tsbuildinfo')) {
        fs.unlinkSync(fullPath);
        console.log(`Deleted: ${path.relative(rootDir, fullPath)}`);
        cleaned++;
      }
    }
  } catch (err) {
    // Ignore errors
  }
}

cleanTsBuildInfo(rootDir);

console.log(`\n✓ Cleaned ${cleaned} items`);
