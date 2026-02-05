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

// Clean stale root-level compiled files (from packages that were refactored to src/)
function cleanStaleRootFiles(pkgDir) {
  const fullPkgDir = path.join(rootDir, pkgDir);
  const extensions = ['.js', '.js.map', '.d.ts', '.d.ts.map'];

  try {
    if (!fs.existsSync(fullPkgDir)) return;

    const entries = fs.readdirSync(fullPkgDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = extensions.find(e => entry.name.endsWith(e));
        // Don't delete configuration files like jest.config.js or other specific scripts if they exist at root
        // But for shared/types, we know common.js, etc should be gone.
        // We generally shouldn't have .js files at root of typescript packages unless they are config.
        const isConfig = ['jest.config.js', 'eslint.config.js', 'rollup.config.js'].includes(entry.name);

        if (ext && !isConfig) {
          fs.unlinkSync(path.join(fullPkgDir, entry.name));
          console.log(`Deleted stale: ${path.join(pkgDir, entry.name)}`);
          cleaned++;
        }
      }
    }
  } catch (err) {
    console.error(`Error cleaning stale files in ${pkgDir}:`, err.message);
  }
}

cleanTsBuildInfo(rootDir);
cleanStaleRootFiles('shared/types');

console.log(`\n✓ Cleaned ${cleaned} items`);
